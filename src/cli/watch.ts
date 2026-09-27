/**
 * Watch mode (Aider pattern): stay idle while you code. When you drop an
 * AI trigger comment into a file — e.g. `// AI: add input validation` —
 * ZCode Ultra picks it up, runs the agent with the file in context, and
 * strips the trigger comment afterwards.
 *
 *   zcode-ultra watch
 *   zcode-ultra watch --triggers "AI:,TODO(ai)" --no-strip
 *
 * Triggers match a line like: <indent><comment-prefix> <trigger> <instruction>
 * with comment prefixes //, #, --, /*, <!--, ;, %.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import { Agent } from "../core/agent.js";
import { Session } from "../core/session.js";
import { colors as C, truncate, VERSION } from "../util.js";

const COMMENT_PREFIXES = ["//", "#", "--", "/*", "<!--", ";", "%"];
const DEFAULT_TRIGGERS = ["AI:", "AI?", "ai:"];

interface WatchHit {
  file: string;
  instruction: string;
  question: boolean;
}

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", ".next", ".cache",
  "coverage", "__pycache__", ".venv", "venv", ".zcode-ultra",
]);

export interface WatchOptions {
  workspace: string;
  noStrip: boolean;
  triggers?: string[];
}

function findTriggerLine(text: string, triggers: string[]): WatchHit | null {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    const prefix = COMMENT_PREFIXES.find((p) => line.startsWith(p));
    if (!prefix) continue;
    line = line.slice(prefix.length).trim();
    for (const t of triggers) {
      if (line.startsWith(t)) {
        return {
          file: "",
          instruction: line.slice(t.length).trim(),
          question: t.includes("?") || line.slice(t.length).trim().endsWith("?"),
        };
      }
    }
  }
  return null;
}

function stripTrigger(file: string): void {
  try {
    const text = fs.readFileSync(file, "utf8");
    const filtered = text
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        return !COMMENT_PREFIXES.some((p) => t.startsWith(p) && /^\s*(\/\/|#|--|\/\*|<!--|;|%)/.test(t) && /(^|\s)(AI:|AI\?|ai:)/.test(t));
      })
      .join("\n");
    if (filtered !== text) fs.writeFileSync(file, filtered, "utf8");
  } catch {
    /* best-effort */
  }
}

export async function runWatch(opts: WatchOptions): Promise<void> {
  const { config: cfg } = loadConfig(opts.workspace);
  const triggers = opts.triggers ?? cfg.watch?.triggers ?? DEFAULT_TRIGGERS;
  const pollMs = cfg.watch?.pollMs ?? 400;
  const workspace = opts.workspace;

  console.log(`${C.cyan("ZCode Ultra watch")} ${C.dim(`v${VERSION}`)}`);
  console.log(`${C.dim("workspace")} ${workspace}`);
  console.log(`${C.dim("triggers")}  ${triggers.map((t) => `"${t}"`).join(", ")}  ${C.dim("(e.g. add '  // AI: refactor this loop' inside a file)")}`);
  console.log(C.dim("watching for changes… Ctrl+C to exit"));
  console.log();

  const session = new Session(workspace, cfg.model);
  const agent = new Agent({
    cfg,
    workspace,
    session,
    approvalHandler: null, // non-interactive; use --accept-edits style config
    quiet: false,
    onEvent: () => {},
  });
  try {
    await agent.boot();
  } catch {
    /* provider errors surface on first turn */
  }

  const mtimes = new Map<string, number>();
  const running = new Set<string>();
  let busy = false;

  const scan = (): void => {
    let files: string[] = [];
    try {
      files = fs.readdirSync(workspace, { recursive: true, withFileTypes: false }) as unknown as string[];
    } catch {
      return;
    }
    for (const rel of files) {
      if (typeof rel !== "string") continue;
      const parts = rel.split(path.sep);
      if (parts.some((p) => IGNORE_DIRS.has(p))) continue;
      if (parts.some((p) => p.startsWith(".") && p !== ".github")) continue;
      const full = path.join(workspace, rel);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const prev = mtimes.get(rel);
      if (prev !== undefined && prev === st.mtimeMs) continue;
      mtimes.set(rel, st.mtimeMs);
      if (prev === undefined) continue; // first scan: record only
      if (busy || running.has(rel)) continue;
      void handle(rel, full);
    }
  };

  const handle = async (rel: string, full: string): Promise<void> => {
    let text: string;
    try {
      text = fs.readFileSync(full, "utf8");
    } catch {
      return;
    }
    const hit = findTriggerLine(text, triggers);
    if (!hit) return;
    running.add(rel);
    busy = true;
    const instruction = hit.instruction || "review and improve this file";
    console.log(`${C.yellow(`⚡ trigger in ${rel}`)} ${C.dim(`→ "${truncate(instruction, 80)}"`)}`);
    try {
      const prompt =
        `The user left an AI trigger comment in ${rel} of the current workspace:\n\n` +
        `  Instruction: ${instruction}\n\n` +
        `Read ${rel} first, then ${hit.question ? "answer the question in your reply" : "apply the requested change with the file tools"}. ` +
        `Do not modify unrelated files.`;
      const result = await agent.run(prompt, { maxTurns: Math.min(30, cfg.maxTurns) });
      console.log(C.green(`✔ done: ${truncate(result.finalText.replace(/\s+/g, " "), 140)}`));
      if (!opts.noStrip && !hit.question) stripTrigger(full);
    } catch (e) {
      console.log(C.red(`✗ watch run failed: ${(e as Error).message}`));
    } finally {
      running.delete(rel);
      busy = false;
      // refresh mtime after agent edits so the loop doesn't re-trigger
      try {
        mtimes.set(rel, fs.statSync(full).mtimeMs);
      } catch {
        /* ignore */
      }
    }
  };

  scan();
  const timer = setInterval(scan, Math.max(150, pollMs));
  const cleanup = (): void => {
    clearInterval(timer);
    agent.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", cleanup);
  await new Promise(() => {}); // watch forever
}
