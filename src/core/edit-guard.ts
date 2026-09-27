/**
 * Edit guard (SWE-agent ACI pattern): the fastest possible syntax check
 * after every Write/Edit. A broken file is reported back to the model as a
 * tool error so the agent fixes it immediately instead of discovering the
 * breakage minutes later at build time.
 *
 * - .js/.mjs/.cjs  -> node --check (authoritative, fast)
 * - .py            -> ast.parse via python3 (no .pyc writes)
 * - .json          -> JSON.parse
 * - .ts/.tsx/.jsx  -> balanced-delimiter scanner (strings/comments aware);
 *                     full type checking stays the user's build step.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";

export function lintFile(file: string): string | null {
  const ext = path.extname(file).toLowerCase();
  try {
    if (!fs.existsSync(file)) return null;

    if ([".js", ".mjs", ".cjs"].includes(ext)) {
      const r = spawnSync(process.execPath, ["--check", file], { timeout: 10_000, encoding: "utf8" });
      if (r.status !== 0) return firstErr(r.stderr || r.stdout || "") || "syntax error (node --check)";
      return null;
    }

    if (ext === ".py") {
      const py = process.platform === "win32" ? "python" : "python3";
      const code = `import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())`;
      const r = spawnSync(py, ["-c", code, file], { timeout: 10_000, encoding: "utf8" });
      if (r.error && (r.error as NodeJS.ErrnoException).code === "ENOENT") return null; // python not installed
      if (r.status !== 0) return firstErr(r.stderr || r.stdout || "") || "syntax error (ast.parse)";
      return null;
    }

    if (ext === ".json") {
      try {
        JSON.parse(fs.readFileSync(file, "utf8"));
        return null;
      } catch (e) {
        return `invalid JSON: ${(e as Error).message}`;
      }
    }

    if ([".ts", ".tsx", ".jsx"].includes(ext)) {
      const text = fs.readFileSync(file, "utf8");
      const err = balancedDelimiters(text);
      return err ? err : null;
    }

    return null; // unknown extension: no guard
  } catch {
    return null; // guard must never crash the tool
  }
}

function firstErr(stderr: string): string | null {
  const line = (stderr ?? "").split("\n").find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 300) : null;
}

/**
 * Balanced-delimiter scanner for brace languages. Tracks (), [], {} while
 * skipping line comments, block comments, strings and template literals.
 * Returns null when balanced, or a short description of the first offense.
 */
export function balancedDelimiters(text: string): string | null {
  const stack: Array<{ ch: string; line: number }> = [];
  let line = 1;
  let i = 0;
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  const openers = new Set(["(", "[", "{"]);

  while (i < text.length) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    // line comment
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    // block comment
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    // string / template literal
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === "\n") {
          if (quote !== "`") return `unterminated string at line ${line}`;
          line++;
        }
        if (text[i] === quote) break;
        i++;
      }
      if (i >= text.length) return `unterminated ${quote === "`" ? "template literal" : "string"} starting near line ${line}`;
      i++;
      continue;
    }
    // regex literal heuristic: /.../ when previous significant char suggests division-free spot
    if (ch === "/" && regexAllowed(text, i)) {
      i++;
      let closed = false;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === "\n") break; // not a regex after all — bail
        if (text[i] === "/") {
          closed = true;
          i++;
          break;
        }
        i++;
      }
      if (closed) {
        // skip flags
        while (i < text.length && /[a-z]/i.test(text[i]!)) i++;
        continue;
      }
      continue;
    }
    if (openers.has(ch)) {
      stack.push({ ch, line });
      i++;
      continue;
    }
    if (pairs[ch]) {
      const top = stack.pop();
      if (!top || top.ch !== pairs[ch]) {
        return `unmatched '${ch}' at line ${line}`;
      }
      i++;
      continue;
    }
    i++;
  }
  if (stack.length > 0) {
    const top = stack[stack.length - 1]!;
    return `unclosed '${top.ch}' opened at line ${top.line}`;
  }
  return null;
}

function regexAllowed(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j]!)) j--;
  if (j < 0) return true;
  const prev = text[j]!;
  return "(,=:[!&|?{};+*-%<>~^".includes(prev);
}

function truncateMsg(s: string): string {
  return s.trim().split("\n")[0]?.slice(0, 300) ?? "syntax error";
}
