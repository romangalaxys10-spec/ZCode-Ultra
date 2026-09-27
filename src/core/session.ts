/**
 * Event-sourced sessions (the DeepSeek-harness invariant: "model-visible
 * means logged"). Every message, tool call and result is appended to a JSONL
 * file; resume/replay/fork all derive from the same log.
 */
import fs from "node:fs";
import path from "node:path";
import { sessionsDir, ensureDir, nowIso, shortId } from "../util.js";
import type { ChatMessage, ToolCall } from "../providers/types.js";

export type SessionEventKind =
  | "user"
  | "assistant"
  | "tool_use"
  | "tool_result"
  | "system_note"
  | "summary"
  | "meta";

export interface SessionEvent {
  ts: string;
  kind: SessionEventKind;
  /** normalized chat message (role/content/toolCalls) */
  message?: ChatMessage;
  toolCall?: ToolCall;
  output?: string;
  isError?: boolean;
  meta?: Record<string, unknown>;
}

export interface SessionMeta {
  id: string;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  title: string;
  model: string;
  totalTokens: number;
}

export class Session {
  id: string;
  file: string;
  meta: SessionMeta;
  /** live conversation used by the agent loop */
  history: ChatMessage[] = [];
  private events: SessionEvent[] = [];

  constructor(workspace: string, model: string, id?: string) {
    this.id = id ?? `s_${Date.now().toString(36)}_${shortId(6)}`;
    const dir = sessionsDir();
    ensureDir(dir);
    this.file = path.join(dir, `${this.id}.jsonl`);
    const now = nowIso();
    this.meta = {
      id: this.id,
      createdAt: now,
      updatedAt: now,
      workspace,
      title: "New session",
      model,
      totalTokens: 0,
    };
  }

  /** Load (resume) a session from its JSONL log, replaying model-visible events. */
  static load(id: string): Session | null {
    const file = path.join(sessionsDir(), `${id}.jsonl`);
    if (!fs.existsSync(file)) return null;
    const s = new Session("", "");
    s.id = id;
    s.file = file;
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        if (rec.type === "meta") {
          s.meta = { ...s.meta, ...rec.meta };
        } else {
          s.events.push(rec as SessionEvent);
        }
      } catch {
        // skip corrupt line
      }
    }
    s.rebuildHistory();
    return s;
  }

  static list(): Array<SessionMeta & { events: number }> {
    const dir = sessionsDir();
    if (!fs.existsSync(dir)) return [];
    const out: Array<SessionMeta & { events: number }> = [];
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
      try {
        const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean);
        let meta: SessionMeta | null = null;
        let count = 0;
        for (const line of lines) {
          const rec: any = JSON.parse(line);
          if (rec.type === "meta") meta = { ...(meta as any), ...(rec.meta ?? {}) };
        }
        if (meta) out.push({ ...meta, events: count });
      } catch {
        // ignore
      }
    }
    return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  private rebuildHistory(): void {
    this.history = [];
    for (const ev of this.events) {
      if (ev.message) this.history.push(ev.message);
    }
  }

  append(event: Omit<SessionEvent, "ts">): void {
    const full: SessionEvent & { type: string } = { ...event, ts: nowIso(), type: event.kind };
    this.events.push(full);
    if (event.message) this.history.push(event.message);
    this.meta.updatedAt = nowIso();
    this.persistEvent(full);
  }

  private persistEvent(rec: unknown): void {
    ensureDir(path.dirname(this.file));
    fs.appendFileSync(this.file, JSON.stringify(rec) + "\n", "utf8");
    fs.writeFileSync(path.join(sessionsDir(), `${this.id}.meta.json`), JSON.stringify(this.meta, null, 2), "utf8");
  }

  persistMeta(): void {
    ensureDir(path.dirname(this.file));
    fs.writeFileSync(path.join(sessionsDir(), `${this.id}.meta.json`), JSON.stringify(this.meta, null, 2), "utf8");
  }

  /** Replace history (post-compaction): summary becomes the opener, recent turns kept verbatim. */
  replaceHistory(summary: string, keep: ChatMessage[]): void {
    this.history = [{ role: "user", content: summary }, ...keep];
    this.persistFull();
  }

  /** Rewrite the whole JSONL (used after compaction). */
  persistFull(): void {
    ensureDir(path.dirname(this.file));
    const lines = [JSON.stringify({ type: "meta", meta: this.meta })];
    for (const m of this.history) {
      lines.push(JSON.stringify({ type: "message", ts: nowIso(), message: m }));
    }
    fs.writeFileSync(this.file, lines.join("\n") + "\n", "utf8");
  }

  addTokens(n: number): void {
    this.meta.totalTokens += n;
  }
}
