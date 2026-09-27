/**
 * The ZCode Ultra agent loop.
 *
 * Convergent patterns from the top harnesses, unified:
 * - Event-sourced turn log (DeepSeek harness): every step is recorded.
 * - Interceptable loop (DeepSeek waterfalls): beforeStep/beforeTool/afterTool hooks.
 * - Parallel tool execution with a bounded pool (DeepSeek) — independent
 *   calls in one turn run concurrently, results re-associated in order.
 * - Plan mode (Claude Code): read-only research + plan presentation.
 * - Auto-compaction at the pressure threshold with tool-result pruning.
 * - Subagent spawning with isolated contexts (Claude Code / OpenHands).
 */
import type { ChatMessage, ToolCall } from "../providers/types.js";
import { routeCompletion } from "../providers/registry.js";
import type { ToolRegistry, ToolContext } from "../tools/registry.js";
import { createDefaultRegistry } from "../tools/registry.js";
import { McpHub, mcpToolDefs } from "../mcp/client.js";
import { buildSystemPrompt, buildTurnContext } from "./context.js";
import { shouldCompact, compactionPrompt } from "./compaction.js";
import { Session } from "./session.js";
import { loadSkills, selectSkills, renderSkills } from "../skills/skills.js";
import { memoryRecall, memoryAppend } from "../memory/memory.js";
import { makeSafety, scrubSecrets } from "../safety/safety.js";
import type { ApprovalHandler } from "../safety/safety.js";
import type { Config } from "../config/config.js";
import { estimateTokens, truncate } from "../util.js";

export interface AgentEvent {
  type:
    | "turnStart"
    | "text"
    | "toolStart"
    | "toolEnd"
    | "turnEnd"
    | "compaction"
    | "plan"
    | "error"
    | "done";
  turn?: number;
  text?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  output?: string;
  isError?: boolean;
  message?: string;
}

export interface RunResult {
  finalText: string;
  turns: number;
  stopped: "end_turn" | "max_turns" | "aborted" | "error";
  totalTokens: number;
}

export interface AgentOptions {
  cfg: Config;
  workspace: string;
  session: Session;
  planMode?: boolean;
  approvalHandler?: ApprovalHandler | null;
  onEvent?: (ev: AgentEvent) => void;
  signal?: AbortSignal;
  /** plain text answer only — used by subagents and exec mode */
  quiet?: boolean;
}

export class Agent {
  readonly registry: ToolRegistry;
  private mcpHub: McpHub | null = null;
  private todos: Array<{ id: string; content: string; status: string }> = [];
  private systemPrompt: string;
  private streamedAnyText = false;

  constructor(public opts: AgentOptions) {
    this.registry = createDefaultRegistry();
    this.systemPrompt = "";
  }

  private emit(ev: AgentEvent): void {
    if (ev.type === "text" && ev.text) this.streamedAnyText = true;
    this.opts.onEvent?.(ev);
  }

  /** True when any text delta was streamed during the last run. */
  hadStreamedText(): boolean {
    return this.streamedAnyText;
  }

  /** One-time boot: MCP connect, tool registration, system prompt build. */
  async boot(): Promise<{ mcpConnected: string[]; mcpFailed: Array<{ name: string; error: string }> }> {
    const cfg = this.opts.cfg;
    let mcpConnected: string[] = [];
    let mcpFailed: Array<{ name: string; error: string }> = [];

    if (Object.keys(cfg.mcpServers).length > 0) {
      this.mcpHub = new McpHub();
      const res = await this.mcpHub.connectAll(cfg.mcpServers);
      mcpConnected = res.connected;
      mcpFailed = res.failed;
      const tools = await this.mcpHub.allTools();
      for (const def of mcpToolDefs(this.mcpHub, tools)) this.registry.register(def);
    }

    this.systemPrompt = buildSystemPrompt({
      cfg,
      workspace: this.opts.workspace,
      registry: this.registry,
      planMode: Boolean(this.opts.planMode),
      skills: this.skillsFor(""),
      memoryContext: "",
      mcpTools: mcpConnected.length,
    });
    return { mcpConnected, mcpFailed };
  }

  private skillsFor(userMessage: string): string[] {
    const skills = loadSkills(this.opts.workspace);
    return renderSkills(selectSkills(skills, userMessage));
  }

  private makeToolContext(signal?: AbortSignal): ToolContext {
    const cfg = this.opts.cfg;
    return {
      workspace: this.opts.workspace,
      cfg,
      safety: makeSafety(cfg, this.opts.workspace, this.opts.approvalHandler ?? null),
      signal,
      onProgress: (line) => this.emit({ type: "toolStart", toolName: undefined, message: line }),
      services: {
        spawnSubagent: (type, prompt, description) => this.spawnSubagent(type, prompt, description, signal),
        todoState: () => this.todos,
        setTodoState: (todos) => {
          this.todos = todos.map((t) => ({ id: t.id ?? "?", content: t.content, status: t.status }));
        },
        memoryAppend: async (note) => memoryAppend(note),
        memorySearch: async (query) => memoryRecall(query),
      },
    };
  }

  private async spawnSubagent(type: string, prompt: string, description: string, signal?: AbortSignal): Promise<string> {
    const presets: Record<string, { system: string; tools?: string[]; maxTurns: number }> = {
      explore: {
        system:
          "You are a fast read-only codebase exploration agent. Search and read aggressively, " +
          "report facts with file paths and line numbers. Do NOT modify anything. Keep the final report under 400 words.",
        maxTurns: 18,
      },
      plan: {
        system:
          "You are a software architecture planning agent. Investigate the codebase read-only, then produce " +
          "a step-by-step implementation plan with exact file paths, trade-offs and risks. Keep it under 600 words.",
        maxTurns: 24,
      },
      general: {
        system:
          "You are a capable general-purpose agent. Complete the task fully and autonomously. " +
          "You have the same tools as the main agent. Return a concise final report.",
        maxTurns: 40,
      },
    };
    const preset = presets[type] ?? presets.general!;

    const subSession = new Session(this.opts.workspace, this.opts.cfg.model);
    const sub = new Agent({
      cfg: this.opts.cfg,
      workspace: this.opts.workspace,
      session: subSession,
      approvalHandler: this.opts.approvalHandler,
      signal,
      quiet: true,
      onEvent: (ev) => {
        if (ev.type === "toolStart" && ev.message) this.emit({ type: "toolStart", message: `  [${type}] ${ev.message}` });
      },
    });
    // Restrict the subagent's Task tool (no recursive spawning deeper than 1 level).
    sub.registry.register({
      name: "Task",
      description: "Not available to subagents.",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { output: "Error: subagents cannot spawn further subagents.", isError: true };
      },
    });
    await sub.boot();
    sub.systemPrompt = `${preset.system}\n\n${sub.systemPrompt}`;
    const result = await sub.run(prompt, { maxTurns: preset.maxTurns });
    return result.finalText || "(subagent returned empty result)";
  }

  getTodoState() {
    return this.todos;
  }

  /** Execute the full agent loop for one user prompt. */
  async run(userPrompt: string, runOpts?: { maxTurns?: number }): Promise<RunResult> {
    const cfg = this.opts.cfg;
    const signal = this.opts.signal;
    const maxTurns = runOpts?.maxTurns ?? cfg.maxTurns;
    let turns = 0;
    let finalText = "";
    let stopped: RunResult["stopped"] = "end_turn";

    // Skill injection for this request
    const skills = this.skillsFor(userPrompt);
    const skillBlock = skills.length ? `\n<relevant_skills>\n${skills.join("\n")}\n</relevant_skills>\n` : "";

    // Memory recall for this request
    const memoryHits = cfg.memoryEnabled ? memoryRecall(userPrompt) : "";
    const memoryBlock = memoryHits ? `\n<recalled_memory>\n${memoryHits}\n</recalled_memory>\n` : "";

    const augmented = `${skillBlock}${memoryBlock}${userPrompt}`;
    this.opts.session.append({ kind: "user", message: { role: "user", content: augmented } });

    // Keep the model-visible user prompt clean in history when it had no injections
    if (!skillBlock && !memoryBlock) {
      // already exact; nothing to do
    } else {
      this.opts.session.history[this.opts.session.history.length - 1] = { role: "user", content: userPrompt };
    }

    this.emit({ type: "turnStart", turn: 0 });

    try {
      while (turns < maxTurns) {
        if (signal?.aborted) {
          stopped = "aborted";
          break;
        }
        turns++;

        // --- compaction pressure check (before the request, never mid-tool) ---
        const compact = shouldCompact(this.opts.session.history, cfg);
        if (compact.needed && turns > 1) {
          this.emit({ type: "compaction", message: `compacting: ${compact.reason}` });
          await this.compact();
        }

        const messages: ChatMessage[] = [
          { role: "system", content: this.systemPrompt },
          ...this.opts.session.history,
        ];
        const todoCtx = buildTurnContext(this.todos);
        if (todoCtx) messages.push({ role: "user", content: todoCtx });

        const chain = [cfg.model, ...cfg.fallbackModels];
        const planMode = Boolean(this.opts.planMode);
        const result = await routeCompletion(
          {
            cfg,
            chain,
            signal,
            onText: (delta) => this.emit({ type: "text", text: delta }),
          },
          {
            messages,
            tools: this.registry.specs(planMode),
            model: cfg.model,
            maxTokens: cfg.maxOutputTokens,
            signal,
          }
        );

        this.opts.session.addTokens(result.usage.inputTokens + result.usage.outputTokens);

        if (result.text) {
          finalText += (finalText && result.text ? "\n" : "") + result.text;
          this.opts.session.append({
            kind: "assistant",
            message: { role: "assistant", content: result.text, toolCalls: result.toolCalls },
          });
        } else if (result.toolCalls.length > 0) {
          this.opts.session.append({
            kind: "assistant",
            message: { role: "assistant", content: null, toolCalls: result.toolCalls },
          });
        }

        if (result.toolCalls.length === 0) {
          this.emit({ type: "turnEnd", turn: turns });
          break;
        }

        // --- tool execution (parallel pool for independent calls) ---
        const toolCtx = this.makeToolContext(signal);
        const calls = result.toolCalls;
        const results = await this.executeTools(calls, toolCtx);

        for (let i = 0; i < calls.length; i++) {
          const call = calls[i]!;
          const out = results[i]!;
          this.opts.session.append({
            kind: "tool_use",
            toolCall: call,
          });
          this.opts.session.append({
            kind: "tool_result",
            message: { role: "tool", content: scrubSecrets(truncate(out.output, 30_000)), toolCallId: call.id, name: call.name },
            isError: out.isError,
          });
          this.emit({ type: "toolEnd", toolName: call.name, output: truncate(out.output, 500), isError: out.isError });
        }
      }

      if (turns >= maxTurns) stopped = "max_turns";
    } catch (e) {
      stopped = "error";
      finalText = finalText || `Error: ${(e as Error).message}`;
      this.emit({ type: "error", message: (e as Error).message });
    }

    this.emit({ type: "done", message: finalText });
    return { finalText, turns, stopped, totalTokens: this.opts.session.meta.totalTokens };
  }

  /** Bounded parallel pool: independent calls run concurrently, order preserved. */
  private async executeTools(calls: ToolCall[], ctx: ToolContext): Promise<Array<{ output: string; isError?: boolean }>> {
    const parallel = this.opts.cfg.parallelTools && calls.length > 1;
    const run = async (call: ToolCall) => {
      this.emit({ type: "toolStart", toolName: call.name, toolInput: call.arguments });
      // hooks: beforeTool
      for (const hook of this.opts.cfg.hooks.filter((h) => h.event === "beforeTool")) {
        if (hook.match && !new RegExp(hook.match).test(call.name)) continue;
        const verdict = await this.runHook(hook.run, { tool: call.name, input: call.arguments });
        if (verdict === 2) return { output: `Blocked by hook: ${hook.run}`, isError: true };
      }
      const out = await this.registry.execute(call.name, call.arguments, ctx);
      // hooks: afterTool (observe only)
      for (const hook of this.opts.cfg.hooks.filter((h) => h.event === "afterTool")) {
        if (hook.match && !new RegExp(hook.match).test(call.name)) continue;
        await this.runHook(hook.run, { tool: call.name, output: truncate(out.output, 200) });
      }
      return out;
    };

    if (!parallel) {
      const out: Array<{ output: string; isError?: boolean }> = [];
      for (const call of calls) out.push(await run(call));
      return out;
    }

    const MAX_PARALLEL = 4;
    const results: Array<{ output: string; isError?: boolean }> = new Array(calls.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(MAX_PARALLEL, calls.length) }, async () => {
      while (next < calls.length) {
        const idx = next++;
        results[idx] = await run(calls[idx]!);
      }
    });
    await Promise.all(workers);
    return results;
  }

  private async runHook(command: string, payload: Record<string, unknown>): Promise<number> {
    try {
      const { execFile } = await import("node:child_process");
      return await new Promise((resolve) => {
        execFile(
          "/bin/bash",
          ["-c", command],
          {
            timeout: 10_000,
            env: { ...process.env, ZCODE_ULTRA_HOOK: JSON.stringify(payload).slice(0, 4000) },
          },
          (err, _so, _se) => {
            const code = (err as (NodeJS.ErrnoException & { code?: number }) | null)?.code;
            resolve(typeof code === "number" ? code : err ? 1 : 0);
          }
        );
      });
    } catch {
      return 0;
    }
  }

  /** Compact: prune tool results, summarize older turns, replace history. */
  async compact(): Promise<void> {
    const history = this.opts.session.history;
    if (history.length < 6) return;
    const { summaryRequest, keep } = compactionPrompt(history, this.opts.cfg.compactKeepRecent);
    try {
      const result = await routeCompletion(
        { cfg: this.opts.cfg, chain: [this.opts.cfg.model, ...this.opts.cfg.fallbackModels], retriesPerModel: 1 },
        {
          messages: [
            { role: "system", content: "You summarize agent transcripts. Be dense and factual. Preserve file paths and exact next steps." },
            { role: "user", content: summaryRequest },
          ],
          tools: [],
          model: this.opts.cfg.model,
          maxTokens: 1500,
        }
      );
      const summary = `<conversation_summary>\n${result.text}\n</conversation_summary>\nContinue the task from "Next steps" in the summary.`;
      this.opts.session.replaceHistory(summary, keep);
      this.emit({ type: "compaction", message: `compacted: ${history.length} -> ${keep.length + 1} messages` });
    } catch (e) {
      this.emit({ type: "compaction", message: `compaction failed: ${(e as Error).message}` });
    }
  }

  /** Estimated current context usage in tokens. */
  contextUsage(): number {
    return estimateTokens(JSON.stringify(this.opts.session.history)) + estimateTokens(this.systemPrompt);
  }

  shutdown(): void {
    this.mcpHub?.shutdown();
    this.opts.session.persistMeta();
  }
}
