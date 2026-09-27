/**
 * Shared bot infrastructure:
 * - Per-chat message queue with 500ms debounce + serialized drain (OpenClaw
 *   lane pattern, simplified to per-chat lanes).
 * - Block streaming: chat platforms receive completed blocks via an edit
 *   timer — NOT token deltas (rate-limit friendly, OpenClaw finding).
 * - Session binding: chatKey -> session id, persisted next to the workspace.
 * - Interactive approvals delegated to the channel adapter.
 */
import fs from "node:fs";
import path from "node:path";
import { Agent } from "../core/agent.js";
import { Session } from "../core/session.js";
import { loadCustomCommands, matchCommand } from "../core/custom-commands.js";
import type { ApprovalRequest, ApprovalDecision } from "../safety/safety.js";
import { chunkText, errMessage, truncate } from "../util.js";
import { scrubSecrets } from "../safety/safety.js";
import type { Config } from "../config/config.js";

export interface BotTurnRequest {
  chatKey: string;
  user: string;
  text: string;
  onThinking: () => void | Promise<void>;
  /** partial preview with the latest completed blocks */
  onPreview: (currentText: string) => void | Promise<void>;
  /** final answer delivery */
  onFinal: (text: string) => void | Promise<void>;
  /** interactive approval support; null => writes denied in default mode */
  approve?: ((req: ApprovalRequest) => Promise<ApprovalDecision>) | null;
  /** max agent turns for this chat (admins can override) */
  maxTurns?: number;
  /** plan-only run for this request */
  planMode?: boolean;
}

interface SessionMap {
  [chatKey: string]: string;
}

export class BotBrain {
  private queues = new Map<string, BotTurnRequest[]>();
  private draining = new Set<string>();
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private aborts = new Map<string, AbortController>();
  private sessionMap: SessionMap = {};
  private sessionMapFile: string;

  constructor(
    private cfg: Config,
    private workspace: string
  ) {
    this.sessionMapFile = path.join(workspace, ".zcode-ultra", "bot-sessions.json");
    try {
      this.sessionMap = JSON.parse(fs.readFileSync(this.sessionMapFile, "utf8")) as SessionMap;
    } catch {
      this.sessionMap = {};
    }
  }

  /** Reset the session bound to a chat (the /new command). */
  resetSession(chatKey: string): void {
    delete this.sessionMap[chatKey];
    this.persistSessions();
  }

  sessionIdFor(chatKey: string): string | undefined {
    return this.sessionMap[chatKey];
  }

  /** Enqueue a turn; debounce merges rapid messages into one prompt. */
  enqueue(req: BotTurnRequest): void {
    const q = this.queues.get(req.chatKey) ?? [];
    q.push(req);
    this.queues.set(req.chatKey, q);
    void req.onThinking();
    const existing = this.debounceTimers.get(req.chatKey);
    if (existing) clearTimeout(existing);
    this.debounceTimers.set(
      req.chatKey,
      setTimeout(() => {
        this.debounceTimers.delete(req.chatKey);
        void this.drain(req.chatKey);
      }, 500)
    );
  }

  abort(chatKey: string): boolean {
    const ac = this.aborts.get(chatKey);
    if (ac) {
      ac.abort();
      return true;
    }
    return false;
  }

  private async drain(chatKey: string): Promise<void> {
    if (this.draining.has(chatKey)) return; // re-schedule; drain loop picks it up
    this.draining.add(chatKey);
    try {
      for (;;) {
        const q = this.queues.get(chatKey) ?? [];
        const req = q.shift();
        if (!req) break;
        this.queues.set(chatKey, q);
        try {
          await this.process(req);
        } catch (e) {
          await req.onFinal(`Error: ${errMessage(e)}`);
        }
      }
    } finally {
      this.draining.delete(chatKey);
    }
  }

  private async process(req: BotTurnRequest): Promise<void> {
    const session = this.loadSession(req.chatKey);
    const abortController = new AbortController();
    this.aborts.set(req.chatKey, abortController);

    // Custom slash commands work on chat platforms too (Gemini CLI pattern):
    // "/review src/auth.ts" expands from .zcode-ultra/commands/review.md
    let text = req.text;
    const match = matchCommand(loadCustomCommands(this.workspace), text);
    if (match) text = match.expanded;

    const agent = new Agent({
      cfg: this.cfg,
      workspace: this.workspace,
      session,
      approvalHandler: req.approve ?? null,
      planMode: req.planMode === true,
      onEvent: () => {},
    });

    // Block streaming: flush completed blocks every 1.5s
    let streamed = "";
    let flushedTo = 0;
    const flushTimer = setInterval(() => {
      const lastBreak = streamed.lastIndexOf("\n\n");
      if (lastBreak > flushedTo) {
        void req.onPreview(streamed.slice(0, lastBreak));
        flushedTo = lastBreak;
      }
    }, 1500);

    try {
      await agent.boot();
      const result = await agent.run(text, {
        maxTurns: req.maxTurns ?? this.cfg.maxTurns,
      });
      clearInterval(flushTimer);
      await req.onFinal(result.finalText || "(no output)");
      this.sessionMap[req.chatKey] = session.id;
      this.persistSessions();
    } catch (e) {
      clearInterval(flushTimer);
      await req.onFinal(`Error: ${errMessage(e)}`);
    } finally {
      this.aborts.delete(req.chatKey);
      agent.shutdown();
    }
  }

  private loadSession(chatKey: string): Session {
    const existing = this.sessionMap[chatKey];
    if (existing) {
      const s = Session.load(existing);
      if (s) return s;
    }
    return new Session(this.workspace, this.cfg.model);
  }

  private persistSessions(): void {
    try {
      fs.mkdirSync(path.dirname(this.sessionMapFile), { recursive: true });
      const tmp = `${this.sessionMapFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.sessionMap, null, 2), "utf8");
      fs.renameSync(tmp, this.sessionMapFile);
    } catch {
      /* best-effort */
    }
  }
}

/** Standard guards for outbound bot text (secrets never leave the box). */
export function outbound(text: string): string {
  return scrubSecrets(text);
}

export function chunkForPlatform(text: string, limit: number): string[] {
  return chunkText(text, limit);
}

export function describeRequest(req: BotTurnRequest): string {
  return `${req.user}: ${truncate(req.text, 100)}`;
}
