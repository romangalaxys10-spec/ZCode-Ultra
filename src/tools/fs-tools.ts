/**
 * Filesystem tools: Read, Write, Edit, LS, Glob, Grep.
 * - Read: line-numbered (cat -n style), offset/limit, image detection
 * - Edit: exact-match replace with occurrence control + uniqueness guard
 * - Glob/Grep: hand-rolled, zero-dependency, gitignore-aware ignores
 */
import fs from "node:fs";
import path from "node:path";
import type { ToolDef, ToolContext, ToolResult } from "./types.js";
import { str, num, bool } from "./types.js";
import { pathAllowed, checkApproval, scrubSecrets } from "../safety/safety.js";
import { truncate } from "../util.js";

const DEFAULT_IGNORES = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", ".next", ".cache",
  "coverage", "__pycache__", ".venv", "venv", ".turbo", ".pytest_cache",
  "vendor", ".svelte-kit", "bin/Debug", "obj", ".gradle", ".idea", ".vscode-server",
]);

const MAX_OUTPUT = 24_000;

function isIgnored(name: string): boolean {
  return DEFAULT_IGNORES.has(name) || name.endsWith(".pyc") || name.endsWith(".lock") === false && name.endsWith(".min.js");
}

function walk(root: string, opts: { maxFiles: number; maxDepth: number }): string[] {
  const files: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && files.length < opts.maxFiles) {
    const { dir, depth } = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (files.length >= opts.maxFiles) break;
      if (e.name.startsWith(".") && e.name !== ".github" && e.name !== ".zcode-ultra") continue;
      if (isIgnored(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < opts.maxDepth) queue.push({ dir: full, depth: depth + 1 });
      } else if (e.isFile()) {
        files.push(full);
      }
    }
  }
  return files;
}

/** Glob-to-regex supporting **, *, ?, {a,b}, character classes. */
export function globToRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        re += "(?:.*)";
        i++;
        if (pattern[i + 1] === "/") i++; // **/ matches zero dirs too
      } else {
        re += "(?:[^/]*)";
      }
    } else if (ch === "?") re += "[^/]";
    else if (ch === "{") {
      const end = pattern.indexOf("}", i);
      const alts = pattern.slice(i + 1, end).split(",");
      re += "(?:" + alts.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")";
      i = end;
    } else if ("\\^$.|+()[]".includes(ch)) {
      re += "\\" + ch;
    } else {
      re += ch;
    }
  }
  return new RegExp("^" + re + "$");
}

export const ReadTool: ToolDef = {
  name: "Read",
  description:
    "Read a file from the local filesystem. Returns content with line numbers (cat -n format). " +
    "Supports offset/limit for long files. Images (png/jpg/gif/webp) are reported as image metadata.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file (absolute or workspace-relative)" },
      offset: { type: "number", description: "1-based line number to start from" },
      limit: { type: "number", description: "Max lines to read (default 2000)" },
    },
    required: ["file_path"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const raw = str(input, "file_path");
    const file = path.resolve(ctx.workspace, raw);
    if (!pathAllowed(ctx.safety, file)) {
      return { output: `Error: path "${file}" is outside the allowed roots.`, isError: true };
    }
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return { output: `Error: file not found: ${file}`, isError: true };
    }
    if (st.isDirectory()) return { output: `Error: ${file} is a directory. Use LS or Glob instead.`, isError: true };
    const ext = path.extname(file).toLowerCase();
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext)) {
      return { output: `Image file: ${file} (${st.size} bytes, ${ext}). Attach it to the conversation to view it.`, meta: { image: file } };
    }
    const offset = Math.max(1, num(input, "offset", 1));
    const limit = num(input, "limit", 2000);
    const content = fs.readFileSync(file, "utf8");
    const lines = content.split("\n");
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((line, i) => `${String(offset + i).padStart(6)}\t${line}`).join("\n");
    const clipped = truncate(numbered, MAX_OUTPUT, "\n… (output truncated — use offset/limit to read more)");
    return { output: scrubSecrets(clipped) };
  },
};

export const WriteTool: ToolDef = {
  name: "Write",
  description:
    "Write a file to the filesystem, overwriting if it exists. Creates parent directories. " +
    "Prefer Edit for modifying existing files.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to write (absolute or workspace-relative)" },
      content: { type: "string", description: "Full file content" },
    },
    required: ["file_path", "content"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const file = path.resolve(ctx.workspace, str(input, "file_path"));
    const content = str(input, "content");
    if (!pathAllowed(ctx.safety, file)) {
      return { output: `Error: path "${file}" is outside the allowed roots.`, isError: true };
    }
    const decision = await checkApproval(ctx.safety, {
      tool: "Write", summary: `Write ${content.length} bytes to ${path.relative(ctx.workspace, file) || file}`,
      filePath: file, risk: "medium",
    });
    if (!decision.approved) return { output: `Error: ${decision.reason}`, isError: true };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, "utf8");
    ctx.onProgress?.(`wrote ${file} (${content.length} bytes)`);
    return { output: `Wrote ${content.length} bytes to ${file}` };
  },
};

export const EditTool: ToolDef = {
  name: "Edit",
  description:
    "Perform exact string replacement in a file. old_string must match the current file content exactly " +
    "(including whitespace). Set replace_all=true to replace every occurrence, otherwise the match must be unique.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to edit" },
      old_string: { type: "string", description: "Text to replace" },
      new_string: { type: "string", description: "Replacement text" },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const file = path.resolve(ctx.workspace, str(input, "file_path"));
    const oldStr = str(input, "old_string");
    const newStr = str(input, "new_string");
    const replaceAll = bool(input, "replace_all", false);
    if (!pathAllowed(ctx.safety, file)) {
      return { output: `Error: path "${file}" is outside the allowed roots.`, isError: true };
    }
    if (!fs.existsSync(file)) return { output: `Error: file not found: ${file}`, isError: true };
    const content = fs.readFileSync(file, "utf8");
    const occurrences = content.split(oldStr).length - 1;
    if (occurrences === 0) {
      return { output: `Error: old_string not found in ${file}. Read the file again — content may have changed.`, isError: true };
    }
    if (occurrences > 1 && !replaceAll) {
      return { output: `Error: old_string appears ${occurrences} times in ${file}. Provide more surrounding context to make it unique, or set replace_all=true.`, isError: true };
    }
    const decision = await checkApproval(ctx.safety, {
      tool: "Edit", summary: `Edit ${path.relative(ctx.workspace, file) || file} (${occurrences} replacement${occurrences > 1 ? "s" : ""})`,
      filePath: file, risk: "medium",
    });
    if (!decision.approved) return { output: `Error: ${decision.reason}`, isError: true };
    const updated = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
    fs.writeFileSync(file, updated, "utf8");
    ctx.onProgress?.(`edited ${file}`);
    return { output: `Edited ${file}: ${replaceAll ? occurrences : 1} replacement(s) applied.` };
  },
};

export const LSTool: ToolDef = {
  name: "LS",
  description: "List directory contents (one path per line). Directories have a trailing slash.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: { path: { type: "string", description: "Directory to list (default: workspace)" } },
  },
  async execute(input, ctx): Promise<ToolResult> {
    const dir = path.resolve(ctx.workspace, str(input, "path") || ".");
    if (!pathAllowed(ctx.safety, dir)) return { output: `Error: path outside allowed roots.`, isError: true };
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return { output: `Error: ${(e as Error).message}`, isError: true };
    }
    const lines = entries
      .filter((e) => !e.name.startsWith("."))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return { output: lines.join("\n") || "(empty directory)" };
  },
};

export const GlobTool: ToolDef = {
  name: "Glob",
  description:
    "Fast file pattern matching, e.g. '**/*.ts', 'src/**/*.py', '*.{json,md}'. " +
    "Respects standard ignores (node_modules, .git, dist…). Returns paths sorted by modification time.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern" },
      path: { type: "string", description: "Root directory (default: workspace)" },
    },
    required: ["pattern"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const root = path.resolve(ctx.workspace, str(input, "path") || ".");
    const re = globToRegex(str(input, "pattern"));
    const files = walk(root, { maxFiles: 8000, maxDepth: 12 });
    const matches = files
      .filter((f) => {
        const rel = path.relative(root, f).split(path.sep).join("/");
        return re.test(rel) || re.test(path.basename(f));
      })
      .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 300)
      .map((x) => path.relative(ctx.workspace, x.f) || x.f);
    return { output: matches.join("\n") || "No files matched." };
  },
};

export const GrepTool: ToolDef = {
  name: "Grep",
  description:
    "Search file contents with a regular expression (ripgrep syntax). Returns matching lines with file paths " +
    "and line numbers. Supports output modes: content (default), files_with_matches, count.",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression" },
      path: { type: "string", description: "Directory or file to search (default: workspace)" },
      include: { type: "string", description: "Glob filter, e.g. '*.ts'" },
      output_mode: { type: "string", enum: ["content", "files_with_matches", "count"], description: "Output mode" },
      max_results: { type: "number", description: "Max results (default 100)" },
    },
    required: ["pattern"],
  },
  async execute(input, ctx): Promise<ToolResult> {
    const target = path.resolve(ctx.workspace, str(input, "path") || ".");
    const pattern = str(input, "pattern");
    const includeGlob = str(input, "include");
    const mode = str(input, "output_mode", "content");
    const max = num(input, "max_results", 100);
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch (e) {
      return { output: `Error: invalid regex: ${(e as Error).message}`, isError: true };
    }
    const includeRe = includeGlob ? globToRegex(includeGlob) : null;
    const files = fs.statSync(target).isFile() ? [target] : walk(target, { maxFiles: 6000, maxDepth: 12 });
    const results: string[] = [];
    const counts: string[] = [];
    let scanned = 0;
    for (const f of files) {
      if (results.length >= max && mode !== "count") break;
      if (includeRe && !includeRe.test(path.basename(f))) continue;
      scanned++;
      let content: string;
      try {
        const st = fs.statSync(f);
        if (st.size > 2 * 1024 * 1024) continue;
        content = fs.readFileSync(f, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      let fileCount = 0;
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          fileCount++;
          if (mode === "content" && results.length < max) {
            const rel = path.relative(ctx.workspace, f);
            results.push(`${rel}:${i + 1}: ${truncate(lines[i].trim(), 240)}`);
          }
        }
      }
      if (fileCount > 0) {
        if (mode === "files_with_matches") results.push(path.relative(ctx.workspace, f));
        if (mode === "count") counts.push(`${path.relative(ctx.workspace, f)}: ${fileCount}`);
      }
    }
    const out = mode === "count" ? counts.join("\n") : results.join("\n");
    return { output: scrubSecrets(out || "No matches found.") + (out ? `\n\n(${scanned} files scanned)` : "") };
  },
};
