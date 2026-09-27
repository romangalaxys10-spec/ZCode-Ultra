/**
 * Bash tool — with approval gating, timeout, output limits and the optional
 * Docker sandbox world (Codex/OpenHands pattern). Persistent shell state is
 * intentionally avoided: every call is a fresh invocation (safer, replayable).
 */
import path from "node:path";
import { execFile } from "node:child_process";
import type { ToolDef, ToolContext, ToolResult } from "./types.js";
import { str, num } from "./types.js";
import { bashRisk, checkApproval, sandboxedExec, scrubSecrets } from "../safety/safety.js";
import { truncate } from "../util.js";

/**
 * Shell selection: POSIX uses /bin/bash. Windows prefers Git Bash (ships
 * with GitHub runners and Git for Windows), falling back to cmd.exe.
 */
async function shellForWindows(): Promise<{ file: string; args: string[] }> {
  try {
    const { execFileSync } = await import("node:child_process");
    const bashPath = execFileSync("where.exe", ["bash.exe"], { encoding: "utf8", timeout: 5000 }).split(/\r?\n/)[0]?.trim();
    if (bashPath && !bashPath.toLowerCase().includes("system32")) {
      return { file: bashPath, args: ["-c"] };
    }
  } catch {
    /* bash not found */
  }
  return { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"] };
}

export const BashTool: ToolDef = {
  name: "Bash",
  description:
    "Execute a shell command in the workspace directory and return stdout/stderr. " +
    "Use for git, builds, tests, package managers and other CLI work. Commands run in a fresh " +
    "shell each call; use && to chain. Dangerous commands require approval according to the " +
    "permission mode. Output is capped.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to run" },
      timeout_ms: { type: "number", description: "Timeout in milliseconds (default 120000, max 600000)" },
      description: { type: "string", description: "Short description of what this command does" },
    },
    required: ["command"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const command = str(input, "command").trim();
    if (!command) return { output: "Error: empty command", isError: true };
    const timeoutMs = Math.min(600_000, Math.max(1_000, num(input, "timeout_ms", 120_000)));

    const risk = bashRisk([command]);
    const decision = await checkApproval(ctx.safety, {
      tool: "Bash",
      summary: `${command}${str(input, "description") ? `  (${str(input, "description")})` : ""}`,
      argv: [command],
      cwd: ctx.workspace,
      risk,
    });
    if (!decision.approved) {
      return { output: `Error: command not approved — ${decision.reason}`, isError: true };
    }

    ctx.onProgress?.(`$ ${truncate(command, 120)}`);

    if (ctx.cfg.sandbox === "docker") {
      const r = await sandboxedExec(ctx.safety, [command], ctx.workspace, timeoutMs);
      return finish(r.code, r.stdout, r.stderr, command);
    }

    const shell = process.platform === "win32" ? await shellForWindows() : { file: "/bin/bash", args: ["-c"] };

    return new Promise<ToolResult>((resolve) => {
      execFile(
        shell.file,
        [...shell.args, command],
        {
          cwd: ctx.workspace,
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, ZCODE_ULTRA: "1", TERM: "dumb" },
          signal: ctx.signal,
        },
        (err, stdout, stderr) => {
          const code = err
            ? ((err as NodeJS.ErrnoException & { code?: number | string }).code ?? 1)
            : 0;
          const numeric = typeof code === "number" ? code : 1;
          if (err && String((err as Error).message).includes("timed out")) {
            resolve({
              output: `Error: command timed out after ${timeoutMs}ms\n${finish(numeric, stdout?.toString() ?? "", stderr?.toString() ?? "", command).output}`,
              isError: true,
            });
            return;
          }
          resolve(finish(numeric, stdout?.toString() ?? "", stderr?.toString() ?? "", command));
        }
      );
    });
  },
};

function finish(code: number, stdout: string, stderr: string, command: string): ToolResult {
  const parts: string[] = [];
  const out = stdout?.toString() ?? "";
  const err = stderr?.toString() ?? "";
  if (out.trim()) parts.push(truncate(out, 16_000, "\n… (stdout truncated)"));
  if (err.trim()) parts.push(truncate(err, 8_000, "\n… (stderr truncated)"));
  const body = parts.join("\n---\n") || "(no output)";
  const meta = { command, exitCode: code };
  if (code !== 0) {
    return { output: scrubSecrets(`Exit code: ${code}\n${body}`), isError: true, meta };
  }
  return { output: scrubSecrets(body), meta };
}

export const NotebookEditTool: ToolDef = {
  name: "NotebookEdit",
  description: "Edit a Jupyter notebook (.ipynb): replace, insert or delete a cell by index.",
  parameters: {
    type: "object",
    properties: {
      notebook_path: { type: "string", description: "Path to .ipynb file" },
      cell_index: { type: "number", description: "0-based cell index" },
      new_source: { type: "string", description: "New cell source (empty string deletes)" },
      cell_type: { type: "string", enum: ["code", "markdown"], description: "Cell type for insert mode" },
      edit_mode: { type: "string", enum: ["replace", "insert", "delete"], description: "Default: replace" },
    },
    required: ["notebook_path", "cell_index", "new_source"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const fs = await import("node:fs");
    const file = path.resolve(ctx.workspace, str(input, "notebook_path"));
    if (!fs.existsSync(file)) return { output: `Error: notebook not found: ${file}`, isError: true };
    const nb = JSON.parse(fs.readFileSync(file, "utf8"));
    const cells = Array.isArray(nb.cells) ? nb.cells : [];
    const idx = num(input, "cell_index", 0);
    const mode = str(input, "edit_mode", "replace");
    const source = str(input, "new_source");
    const decision = await checkApproval(ctx.safety, { tool: "NotebookEdit", summary: `${mode} cell ${idx} in ${file}`, filePath: file, risk: "medium" });
    if (!decision.approved) return { output: `Error: ${decision.reason}`, isError: true };

    if (mode === "insert") {
      cells.splice(idx, 0, { cell_type: str(input, "cell_type", "code"), metadata: {}, source });
    } else if (mode === "delete") {
      cells.splice(idx, 1);
    } else {
      if (!cells[idx]) return { output: `Error: cell ${idx} out of range (${cells.length} cells)`, isError: true };
      cells[idx].source = source;
    }
    nb.cells = cells;
    fs.writeFileSync(file, JSON.stringify(nb, null, 1) + "\n", "utf8");
    return { output: `Notebook updated: ${mode} at cell ${idx}.` };
  },
};
