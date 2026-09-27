import { randomUUID, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export const VERSION = "1.1.0";

export function newId(prefix = ""): string {
  const id = randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function shortId(len = 8): string {
  return randomBytes(16).toString("hex").slice(0, len);
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** True when running inside a TTY-capable interactive terminal. */
export function isInteractive(): boolean {
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

/** Home data dir for ZCode Ultra state: ~/.zcode-ultra */
export function dataHome(): string {
  const envDir = process.env.ZCODE_ULTRA_HOME;
  if (envDir && envDir.trim()) return path.resolve(envDir);
  return path.join(os.homedir(), ".zcode-ultra");
}

export function sessionsDir(): string {
  return path.join(dataHome(), "sessions");
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Atomic write: write to tmp then rename, avoiding torn files (OpenClaw pattern). */
export function atomicWrite(file: string, data: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${shortId(4)}.tmp`;
  fs.writeFileSync(tmp, data, "utf8");
  fs.renameSync(tmp, file);
}

/** Convert error -> readable single-line message. */
export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Naive but serviceable token estimator (~3.6 chars/token for code-heavy text). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}

export function truncate(text: string, max: number, suffix = "…"): string {
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - suffix.length)) + suffix;
}

/** Split text into chunks that fit platform message limits, preferring paragraph breaks. */
export function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n\n", maxLen);
    if (cut < maxLen * 0.5) cut = rest.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** True when stdout supports ANSI colors. */
export function useColor(): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY === true;
}

const c = (code: string, s: string): string =>
  useColor() ? `\x1b[${code}m${s}\x1b[0m` : s;

export const colors = {
  bold: (s: string) => c("1", s),
  dim: (s: string) => c("2", s),
  red: (s: string) => c("31", s),
  green: (s: string) => c("32", s),
  yellow: (s: string) => c("33", s),
  blue: (s: string) => c("34", s),
  magenta: (s: string) => c("35", s),
  cyan: (s: string) => c("36", s),
};

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Simple debounce-free spinner for the CLI. */
export class Spinner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private i = 0;
  constructor(private label: string) {}
  start(): void {
    if (!process.stderr.isTTY) return;
    this.timer = setInterval(() => {
      const f = this.frames[this.i++ % this.frames.length];
      process.stderr.write(`\r${f} ${this.label}   `);
    }, 80);
  }
  update(label: string): void {
    this.label = label;
  }
  stop(final = ""): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      process.stderr.write(`\r${final ? final + "\n" : "\x1b[2K"}`);
    } else if (final) {
      process.stderr.write(final + "\n");
    }
  }
}
