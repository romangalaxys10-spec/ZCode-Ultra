/**
 * Hierarchical context files (Claude Code CLAUDE.md / Gemini GEMINI.md /
 * OpenHands microagents pattern): durable project knowledge injected into
 * the system prompt so the agent knows conventions without re-reading docs
 * every session.
 *
 * Load order (later sections win attention):
 *   1. ~/.zcode-ultra/MEMORY.md                       (global user memory)
 *   2. parent AGENTS.md (up to 2 levels above ws)     (monorepo root rules)
 *   3. <workspace>/AGENTS.md                          (project rules; the
 *      emerging cross-tool convention — also checks CLAUDE.md, GEMINI.md)
 *   4. <workspace>/.zcode-ultra/rules/*.md            (fine-grained modules)
 *
 * Total budget: ~6000 chars, largest files win.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const MAX_CHARS = 6000;
const RULE_FILES = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"];

function readIfExists(file: string): string | null {
  try {
    if (!fs.existsSync(file)) return null;
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 200_000) return null;
    const text = fs.readFileSync(file, "utf8").trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}

export function loadContextFiles(workspace: string): string {
  const sections: Array<{ source: string; text: string }> = [];
  let budget = MAX_CHARS;

  const add = (source: string, file: string): void => {
    if (budget <= 0) return;
    const text = readIfExists(file);
    if (!text) return;
    const clipped = text.slice(0, budget);
    sections.push({ source, text: clipped });
    budget -= clipped.length;
  };

  // 1. global memory file
  add("global memory", path.join(os.homedir(), ".zcode-ultra", "MEMORY.md"));

  // 2. parent rules (monorepo roots), nearest-first
  const ws = path.resolve(workspace);
  const parent = path.dirname(ws);
  const grand = path.dirname(parent);
  if (grand !== parent && grand.length > 2) {
    for (const name of RULE_FILES) add("parent", path.join(grand, name));
  }
  if (parent !== ws && parent.length > 2) {
    for (const name of RULE_FILES) add("parent", path.join(parent, name));
  }

  // 3. workspace rule files (first match wins — AGENTS.md > CLAUDE.md > GEMINI.md)
  for (const name of RULE_FILES) {
    const f = path.join(ws, name);
    if (readIfExists(f)) {
      add("project", f);
      break;
    }
  }

  // 4. .zcode-ultra/rules/*.md
  const rulesDir = path.join(ws, ".zcode-ultra", "rules");
  try {
    if (fs.existsSync(rulesDir)) {
      const files = fs
        .readdirSync(rulesDir)
        .filter((f) => f.toLowerCase().endsWith(".md"))
        .sort();
      for (const f of files) add("rules", path.join(rulesDir, f));
    }
  } catch {
    /* best-effort */
  }

  if (sections.length === 0) return "";
  return sections.map((s) => `### ${s.source}\n${s.text}`).join("\n\n");
}
