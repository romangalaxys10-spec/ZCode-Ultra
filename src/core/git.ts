/**
 * Git integration (Aider pattern): every agent edit becomes an attributed
 * git commit, and /undo reverts the last agent commit. Zero-dep — spawns
 * the git CLI, degrades gracefully when git is absent or the workspace is
 * not a repository.
 *
 * Safety rules:
 * - Only commits files the agent actually touched (path-scoped `git add`).
 * - Never stages anything the model did not change.
 * - /undo only resets when HEAD is an agent commit (prefix match) — it can
 *   never undo human work.
 */
import { execFile } from "node:child_process";

export interface GitInfo {
  available: boolean;
  isRepo: boolean;
  detail: string;
}

function run(cwd: string, args: string[], timeoutMs = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err, stdout, stderr) => {
        const code = err ? ((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
        resolve({
          code: typeof code === "number" ? code : 1,
          stdout: stdout?.toString() ?? "",
          stderr: err && !stdout ? String((err as Error).message) : stderr?.toString() ?? "",
        });
      }
    );
  });
}

export async function gitInfo(workspace: string): Promise<GitInfo> {
  const v = await run(workspace, ["--version"]);
  if (v.code !== 0) return { available: false, isRepo: false, detail: "git CLI not found" };
  const repo = await run(workspace, ["rev-parse", "--is-inside-work-tree"]);
  if (repo.code !== 0 || !repo.stdout.includes("true")) {
    return { available: true, isRepo: false, detail: "not a git repository" };
  }
  return { available: true, isRepo: true, detail: "git repository detected" };
}

export async function hasDirtyFiles(workspace: string, files: string[]): Promise<boolean> {
  if (files.length === 0) return false;
  // `git diff --quiet HEAD -- <paths>` fails (non-zero) when there are changes;
  // untracked files are not covered by diff, so also check status for them.
  const diff = await run(workspace, ["diff", "--quiet", "HEAD", "--", ...files]);
  if (diff.code !== 0) return true;
  const status = await run(workspace, ["status", "--porcelain", "--", ...files]);
  return status.stdout.trim().length > 0;
}

/**
 * Commit the given files with an attributed message.
 * Returns the commit subject, or null when there was nothing to commit.
 */
export async function autoCommit(
  workspace: string,
  files: string[],
  message: string,
  prefix: string
): Promise<{ ok: boolean; detail: string }> {
  const info = await gitInfo(workspace);
  if (!info.available || !info.isRepo) return { ok: false, detail: info.detail };

  const uniq = [...new Set(files.map((f) => f.replace(/\\/g, "/")))].slice(0, 100);
  if (uniq.length === 0) return { ok: false, detail: "no files changed" };
  if (!(await hasDirtyFiles(workspace, uniq))) return { ok: false, detail: "no dirty files to commit" };

  const add = await run(workspace, ["add", "--", ...uniq]);
  if (add.code !== 0) return { ok: false, detail: `git add failed: ${truncateErr(add.stderr || add.stdout)}` };

  const subject = `${prefix}: ${message.replace(/\s+/g, " ").slice(0, 60) || "agent edits"}`;
  const body = [
    "Automated commit by ZCode Ultra.",
    "Files changed by the agent in the last turn:",
    ...uniq.map((f) => `  - ${f}`),
    "",
    "Undo with: zcode-ultra undo  (or /undo in the REPL)",
  ].join("\n");

  const commit = await run(workspace, ["commit", "-m", subject, "-m", body, "--", ...uniq], 30_000);
  if (commit.code !== 0) {
    const err = truncateErr(commit.stderr || commit.stdout);
    // Nothing to commit after add (e.g. whitespace-only) is fine.
    if (/nothing to commit/i.test(err)) return { ok: false, detail: "nothing to commit" };
    return { ok: false, detail: `git commit failed: ${err}` };
  }
  return { ok: true, detail: subject };
}

export function isAgentCommitSubject(subject: string, prefix: string): boolean {
  return subject.trim().startsWith(`${prefix}:`) || subject.includes("Automated commit by ZCode Ultra");
}

/**
 * Undo the last agent commit (aider /undo semantics): only when HEAD is an
 * agent-attributed commit. Returns a human-readable result.
 */
export async function undoLastAgentCommit(workspace: string, prefix: string): Promise<{ ok: boolean; detail: string }> {
  const info = await gitInfo(workspace);
  if (!info.available || !info.isRepo) return { ok: false, detail: info.detail };

  const log = await run(workspace, ["log", "-1", "--pretty=%H%n%s%n%b"]);
  if (log.code !== 0) return { ok: false, detail: `git log failed: ${truncateErr(log.stderr)}` };
  const [sha, subject, body] = log.stdout.split("\n");
  if (!sha) return { ok: false, detail: "no commits found" };
  if (!isAgentCommitSubject(`${subject ?? ""}\n${body ?? ""}`, prefix)) {
    return { ok: false, detail: `HEAD is not an agent commit ("${subject?.trim()}") — refusing to undo human work` };
  }

  const status = await run(workspace, ["status", "--porcelain"]);
  if (status.stdout.trim().length > 0) {
    return { ok: false, detail: "working tree has uncommitted changes — commit or stash them before /undo" };
  }

  const reset = await run(workspace, ["reset", "--hard", "HEAD~1"], 30_000);
  if (reset.code !== 0) return { ok: false, detail: `git reset failed: ${truncateErr(reset.stderr)}` };
  return { ok: true, detail: `undid ${sha.slice(0, 8)} (${subject?.trim()})` };
}

function truncateErr(s: string): string {
  return (s ?? "").trim().split("\n")[0]?.slice(0, 200) ?? "unknown git error";
}
