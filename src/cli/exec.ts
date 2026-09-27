/**
 * Headless exec mode: one prompt, full autonomy, JSONL or plain output.
 * Designed for CI, scripts and bot backends (Codex `exec` pattern).
 * Exit codes: 0 success, 1 run error, 2 max-turns cutoff.
 */
import { Agent } from "../core/agent.js";
import { Session } from "../core/session.js";
import { makeSafety } from "../safety/safety.js";
import { VERSION, errMessage } from "../util.js";
import type { Config } from "../config/config.js";

export interface ExecOptions {
  cfg: Config;
  workspace: string;
  prompt: string;
  planMode: boolean;
  json: boolean;
  sessionId?: string;
  maxTurns?: number;
  timeoutMs?: number;
}

export async function runExec(opts: ExecOptions): Promise<number> {
  const session = opts.sessionId ? (Session.load(opts.sessionId) ?? new Session(opts.workspace, opts.cfg.model)) : new Session(opts.workspace, opts.cfg.model);

  // Non-interactive: no approval handler. Users should pass --yolo / --accept-edits
  // for write workflows, or allowlist the commands they need.
  const agent = new Agent({
    cfg: opts.cfg,
    workspace: opts.workspace,
    session,
    planMode: opts.planMode,
    approvalHandler: null,
    quiet: true,
  });

  if (!opts.json) {
    process.stderr.write(`zcode-ultra exec v${VERSION}\nmodel: ${opts.cfg.model}  mode: ${opts.planMode ? "plan" : opts.cfg.permissionMode}\n---\n`);
    agent.opts.onEvent = (ev) => {
      if (ev.type === "text" && ev.text) process.stdout.write(ev.text);
      else if (ev.type === "toolStart" && ev.toolName) process.stderr.write(`\n[tool] ${ev.toolName}\n`);
      else if (ev.type === "compaction" && ev.message) process.stderr.write(`\n[compact] ${ev.message}\n`);
    };
  }

  const timer = opts.timeoutMs
    ? setTimeout(() => {
        process.stderr.write("\n[exec timeout reached]\n");
        process.exit(3);
      }, opts.timeoutMs)
    : null;

  try {
    const result = await agent.run(opts.prompt, { maxTurns: opts.maxTurns });
    if (timer) clearTimeout(timer);
    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            ok: result.stopped === "end_turn",
            stopped: result.stopped,
            turns: result.turns,
            tokens: result.totalTokens,
            sessionId: session.id,
            result: result.finalText,
          },
          null,
          2
        )
      );
    } else {
      if (result.finalText && !agent.hadStreamedText()) console.log(result.finalText);
      process.stderr.write(`\n---\n[${result.turns} turn(s), ~${result.totalTokens.toLocaleString()} tok, stopped: ${result.stopped}, session ${session.id}]\n`);
    }
    agent.shutdown();
    if (result.stopped === "error") return 1;
    if (result.stopped === "max_turns") return 2;
    return 0;
  } catch (e) {
    if (timer) clearTimeout(timer);
    if (opts.json) console.log(JSON.stringify({ ok: false, error: errMessage(e) }, null, 2));
    else process.stderr.write(`\n✗ ${errMessage(e)}\n`);
    return 1;
  }
}
