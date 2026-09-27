/**
 * Interactive terminal REPL for ZCode Ultra.
 * Hand-rolled readline UI (zero-dep): streaming output, compact tool trace,
 * Ctrl+C abort, in-chat slash commands.
 */
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { Agent, type AgentEvent, type RunResult } from "../core/agent.js";
import { Session } from "../core/session.js";
import { loadCustomCommands, matchCommand } from "../core/custom-commands.js";
import { formatUsageBreakdown, formatUsageLine } from "../core/cost.js";
import { undoLastAgentCommit } from "../core/git.js";
import type { Config, PermissionMode } from "../config/config.js";
import { MODE_INFO, type ApprovalRequest, type ApprovalDecision } from "../safety/safety.js";
import { colors as C, Spinner, truncate, VERSION, errMessage } from "../util.js";

interface ReplOptions {
  cfg: Config;
  workspace: string;
  planMode: boolean;
  session: Session;
  resumeQuiet?: boolean;
}

function printBanner(cfg: Config, workspace: string, planMode: boolean): void {
  console.log(`${C.cyan("ZCode Ultra")} ${C.dim(`v${VERSION}`)} ${C.dim("— multi-provider coding agent")}`);
  console.log(`${C.dim("workspace")} ${workspace}`);
  console.log(`${C.dim("model")}     ${cfg.model}${cfg.fallbackModels.length ? C.dim(`  (fallback: ${cfg.fallbackModels.join(" -> ")})`) : ""}`);
  console.log(`${C.dim("mode")}      ${planMode ? C.magenta("plan") : cfg.permissionMode}${C.dim(` — ${MODE_INFO[planMode ? "plan" : cfg.permissionMode]}`)}`);
  console.log(C.dim("type a request, /help for commands, Ctrl+C to abort/exit"));
  console.log();
}

function listCustomCommands(workspace: string): string[] {
  return loadCustomCommands(workspace).map((c) => `/${c.name}`);
}

function renderTodos(runResult: RunResult, agent: Agent): void {
  const todos = agent.getTodoState();
  if (todos.length === 0) return;
  console.log();
  console.log(C.bold("Todos"));
  for (const t of todos) {
    const mark = t.status === "completed" ? C.green("x") : t.status === "in_progress" ? C.yellow(">") : " ";
    console.log(`  [${mark}] ${t.id}. ${t.content}`);
  }
}

export async function runRepl(opts: ReplOptions): Promise<void> {
  const { cfg, workspace } = opts;
  let planMode = opts.planMode;
  printBanner(cfg, workspace, planMode);

  const agent = new Agent({
    cfg,
    workspace,
    session: opts.session,
    planMode,
    approvalHandler: terminalApproval,
    onEvent: () => {},
  });

  process.stderr.write(C.dim("booting (provider check, MCP servers, skills)…\n"));
  try {
    const boot = await agent.boot();
    if (boot.mcpConnected.length) console.log(C.green(`MCP connected: ${boot.mcpConnected.join(", ")}`));
    for (const f of boot.mcpFailed) console.log(C.yellow(`MCP failed: ${f.name} — ${f.error}`));
  } catch (e) {
    console.log(C.red(`boot warning: ${errMessage(e)}`));
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: C.cyan("zu> "),
    historySize: 500,
  });

  let currentAbort: AbortController | null = null;
  let ctrlCAborted = false;

  rl.prompt();
  rl.on("line", (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    void handleInput(input).finally(() => rl.prompt());
  });
  rl.on("close", () => process.exit(0));
  (rl as unknown as { on(ev: string, fn: () => void): void }).on("SIGINT", () => {
    if (currentAbort) {
      currentAbort.abort();
      console.log(C.yellow("\n(aborting current run — press Ctrl+C again to exit)"));
    } else if (ctrlCAborted) {
      process.exit(0);
    } else {
      ctrlCAborted = true;
      setTimeout(() => (ctrlCAborted = false), 1500);
      console.log(C.dim("\n(Ctrl+C again to exit)"));
      rl.prompt();
    }
  });

  async function handleInput(input: string): Promise<void> {
    if (input.startsWith("/")) {
      await slashCommand(input);
      return;
    }
    await runTurn(input);
  }

  async function slashCommand(input: string): Promise<void> {
    const [cmd, ...rest] = input.split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd) {
      case "/help":
        console.log(`Commands:
  /model <provider/model>   switch primary model (e.g. zai/glm-4.6, deepseek/deepseek-chat)
  /mode <mode>              permission mode: default | plan | acceptEdits | yolo
  /plan [request]           toggle plan mode (with request = one-shot plan)
  /compact                  force context compaction
  /tokens                   show context usage estimate
  /cost                     show session token usage + estimated cost
  /undo                     revert the last agent git commit (aider-style)
  /checkpoint [list|restore <id>]   manage file checkpoints (pre-edit snapshots)
  /sessions                 list saved sessions
  /resume <id>              resume a saved session
  /save                     save session (already auto-saved) + show id
  /clear                    start a fresh session
  /tools                    list tools (including MCP)
  /quit                     exit
${listCustomCommands(workspace).length ? `Custom: ${listCustomCommands(workspace).join(" ")}` : "Custom: none yet — add .zcode-ultra/commands/<name>.md"}`);
        break;
      case "/model":
        if (arg) {
          cfg.model = arg;
          console.log(C.green(`model -> ${cfg.model}`));
        } else console.log(`current: ${cfg.model}`);
        break;
      case "/mode": {
        const mode = arg as PermissionMode;
        if (["default", "plan", "acceptEdits", "yolo"].includes(mode)) {
          cfg.permissionMode = mode;
          planMode = mode === "plan";
          console.log(C.green(`mode -> ${mode}`));
        } else console.log(C.red("modes: default | plan | acceptEdits | yolo"));
        break;
      }
      case "/plan":
        planMode = arg ? planMode : !planMode;
        console.log(C.magenta(`plan mode ${planMode ? "ON" : "OFF"}`));
        if (arg) await runTurn(arg);
        break;
      case "/compact":
        console.log(C.dim("compacting…"));
        await agent.compact();
        break;
      case "/tokens":
        console.log(`context usage: ~${agent.contextUsage().toLocaleString()} tokens`);
        break;
      case "/cost":
        console.log(formatUsageBreakdown(opts.session.meta.usage ?? {}, agent.costTable()));
        break;
      case "/undo": {
        const r = await undoLastAgentCommit(workspace, cfg.git.commitPrefix || "zcu");
        console.log(r.ok ? C.green(r.detail) : C.yellow(r.detail));
        break;
      }
      case "/checkpoint": {
        const sub = (arg || "list").split(/\s+/);
        if (sub[0] === "restore" && sub[1]) {
          const report = agent.restoreCheckpointById(sub[1], true);
          console.log(report.startsWith("Error") ? C.red(report) : C.green(report));
        } else if (sub[0] === "list") {
          const cps = agent.checkpoints();
          if (cps.length === 0) console.log(C.dim("(no checkpoints yet — created automatically before the first file edit of each turn)"));
          for (const cp of cps.slice(0, 10)) {
            console.log(`  ${C.cyan(cp.id)}  ${cp.ts.slice(11, 19)}  ${cp.files} files  ${C.dim(truncate(cp.label, 50))}`);
          }
        } else {
          console.log("usage: /checkpoint [list | restore <id>]");
        }
        break;
      }
      case "/sessions": {
        const list = Session.list().slice(0, 10);
        for (const s of list) console.log(`  ${C.cyan(s.id)}  ${s.updatedAt.slice(0, 16).replace("T", " ")}  ${truncate(s.title, 60)}  ${C.dim(`${s.totalTokens} tok`)}`);
        if (list.length === 0) console.log(C.dim("(no sessions yet)"));
        break;
      }
      case "/resume": {
        const target = arg.trim();
        const s = Session.load(target);
        if (!s) {
          console.log(C.red(`session not found: ${target}`));
          break;
        }
        opts.session = s;
        console.log(C.green(`resumed ${target} (${s.history.length} messages)`));
        break;
      }
      case "/save":
        console.log(`session id: ${opts.session.id}`);
        break;
      case "/clear":
        opts.session = new Session(workspace, cfg.model);
        console.log(C.green("fresh session started"));
        break;
      case "/tools":
        console.log(agent.registry.names().join("\n"));
        break;
      case "/quit":
      case "/exit":
        agent.shutdown();
        process.exit(0);
        break;
      default: {
        // custom commands (Gemini CLI / Claude Code pattern)
        const match = matchCommand(loadCustomCommands(workspace), input);
        if (match) {
          await runTurn(match.expanded);
          break;
        }
        console.log(C.red(`unknown command ${cmd} — /help`));
      }
    }
  }

  async function runTurn(prompt: string): Promise<void> {
    currentAbort = new AbortController();
    const spinner = new Spinner(agent.registry.names().length ? "thinking" : "thinking");
    let spinnerOn = false;
    let printedText = "";

    const onEvent = (ev: AgentEvent): void => {
      switch (ev.type) {
        case "text":
          if (!spinnerOn) {
            spinnerOn = true;
          }
          process.stdout.write(ev.text ?? "");
          printedText += ev.text ?? "";
          break;
        case "toolStart":
          if (ev.toolName) {
            if (spinnerOn) {
              spinnerOn = false;
              process.stdout.write("\n");
            }
            const inputStr = ev.toolInput ? summarizeToolInput(ev.toolInput) : "";
            console.log(`${C.yellow(`⏺ ${ev.toolName}`)} ${C.dim(truncate(inputStr, 140))}`);
            spinner.update("working");
          } else if (ev.message) {
            console.log(C.dim(`  · ${truncate(ev.message, 160)}`));
          }
          break;
        case "toolEnd":
          if (spinnerOn) {
            spinnerOn = false;
            process.stdout.write("\n");
          }
          if (ev.isError) console.log(C.red(`  ⚠ ${truncate((ev.output ?? "").replace(/\n/g, " "), 200)}`));
          break;
        case "compaction":
          console.log(C.magenta(`⌁ ${ev.message}`));
          break;
        case "note":
          if (spinnerOn) {
            spinnerOn = false;
            process.stdout.write("\n");
          }
          console.log(C.dim(`  ♪ ${ev.message}`));
          break;
        case "error":
          if (spinnerOn) {
            spinnerOn = false;
            process.stdout.write("\n");
          }
          console.log(C.red(`✗ ${ev.message}`));
          break;
      }
    };

    spinner.start();
    try {
      const result = await agent.run(prompt, { maxTurns: cfg.maxTurns });
      spinner.stop();
      if (printedText && !printedText.endsWith("\n")) console.log();
      if (!printedText && result.finalText) console.log(result.finalText);
      if (result.stopped === "max_turns") console.log(C.yellow(`(stopped: max turns ${result.turns})`));
      if (result.stopped === "aborted") console.log(C.yellow("(aborted)"));
      console.log(C.dim(`\n[${result.turns} turn(s), ~${result.totalTokens.toLocaleString()} tok, ~$${result.cost.toFixed(4)}, session ${opts.session.id}]`));
      if (result.filesTouched.length > 0) console.log(C.dim(`files: ${result.filesTouched.slice(0, 8).join(", ")}${result.filesTouched.length > 8 ? "+more" : ""}`));
      renderTodos(result, agent);
      opts.session.meta.title = truncate(prompt.replace(/\s+/g, " "), 80);
      opts.session.persistMeta();
    } catch (e) {
      spinner.stop();
      console.log(C.red(`✗ ${errMessage(e)}`));
    } finally {
      currentAbort = null;
    }
  }
}

function summarizeToolInput(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    parts.push(`${k}=${truncate(s.replace(/\n/g, " "), 60)}`);
  }
  return parts.join(" ");
}

/** Terminal approval prompt (argv-bound, risk-labeled). */
export async function terminalApproval(req: ApprovalRequest): Promise<ApprovalDecision> {
  if (!process.stdin.isTTY) return { approved: false, reason: "non-interactive terminal" };
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const riskTag = req.risk === "high" ? C.red("HIGH") : req.risk === "medium" ? C.yellow("MED") : C.dim("LOW");
    console.log(`\n${C.bold("Approval needed")} ${riskTag} ${C.dim(req.tool)}`);
    console.log(`  ${req.summary}`);
    if (req.argv?.length) console.log(C.dim(`  argv: ${req.argv.join(" ")}`));
    if (req.cwd) console.log(C.dim(`  cwd:  ${req.cwd}`));
    rl.question("Allow? [y/N/a (always this session)] ", (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      if (a === "a") {
        // allow this tool for the rest of the session
        terminalApproval.allowAll.add(req.tool);
        resolve({ approved: true, reason: "approved for session" });
      } else resolve({ approved: a === "y" || a === "yes", reason: a === "y" ? "user approved" : "user denied" });
    });
  });
}
terminalApproval.allowAll = new Set<string>();

/** Resolve workspace argument: explicit > $PWD. Validates existence. */
export function resolveWorkspace(dir: string | undefined): string {
  const ws = path.resolve(dir ?? process.cwd());
  if (!fs.existsSync(ws)) throw new Error(`Workspace does not exist: ${ws}`);
  if (!fs.statSync(ws).isDirectory()) throw new Error(`Workspace is not a directory: ${ws}`);
  return ws;
}
