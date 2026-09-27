/**
 * Context builder: system prompt + environment block + repo map.
 * Prompt stability discipline (Hermes pattern): the static identity section
 * never changes mid-session, keeping provider prompt caches warm; only the
 * volatile tail (repo map, todo state) varies.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { VERSION } from "../util.js";
import type { Config, PermissionMode } from "../config/config.js";
import { MODE_INFO } from "../safety/safety.js";
import type { ToolRegistry } from "../tools/registry.js";
import { loadContextFiles } from "./context-files.js";

const SYMBOL_RE: Record<string, RegExp> = {
  ".ts": /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z0-9_$]+)/,
  ".tsx": /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|enum)\s+([A-Za-z0-9_$]+)/,
  ".js": /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/,
  ".mjs": /^\s*(?:export\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/,
  ".py": /^\s*(?:def|class)\s+([A-Za-z0-9_]+)/,
  ".go": /^\s*func\s+(?:\([^)]+\)\s*)?([A-Za-z0-9_]+)/,
  ".rs": /^\s*(?:pub\s+)?(?:fn|struct|enum|trait)\s+([A-Za-z0-9_]+)/,
  ".java": /^\s*(?:public|private|protected)?\s*(?:class|interface|void|static)\s+([A-Za-z0-9_]+)/,
};

/** Aider-lite repo map: file tree + top-level symbols, size-adaptive. */
export function buildRepoMap(workspace: string, maxChars = 3500): string {
  const files: string[] = [];
  const skip = new Set(["node_modules", ".git", "dist", "build", "out", "target", ".next", "coverage", "__pycache__", ".venv", "venv", ".turbo", ".cache"]);

  const walk = (dir: string, depth: number): void => {
    if (depth > 6 || files.length > 400) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length > 400) return;
      if (e.name.startsWith(".") && e.name !== ".github") continue;
      if (skip.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile()) files.push(path.relative(workspace, full));
    }
  };
  walk(workspace, 0);
  files.sort();

  const lines: string[] = [];
  let budget = maxChars;
  for (const rel of files.slice(0, 150)) {
    if (budget <= 0) break;
    const ext = path.extname(rel).toLowerCase();
    const re = SYMBOL_RE[ext];
    if (!re) {
      const line = `  ${rel}`;
      lines.push(line);
      budget -= line.length + 1;
      continue;
    }
    try {
      const content = fs.readFileSync(path.join(workspace, rel), "utf8");
      const syms: string[] = [];
      for (const lineText of content.split("\n")) {
        const m = re.exec(lineText);
        if (m) syms.push(m[1]);
        if (syms.length >= 12) break;
      }
      const line = `  ${rel}${syms.length ? `  (${syms.join(", ")})` : ""}`;
      lines.push(line);
      budget -= line.length + 1;
    } catch {
      continue;
    }
  }
  return lines.join("\n");
}

export function buildSystemPrompt(opts: {
  cfg: Config;
  workspace: string;
  registry: ToolRegistry;
  planMode: boolean;
  skills: string[];
  memoryContext: string;
  mcpTools: number;
}): string {
  const { cfg, workspace, registry, planMode, skills, memoryContext, mcpTools } = opts;
  const platform = `${os.platform()} ${os.arch()}`;
  const repoMap = buildRepoMap(workspace);
  const toolNames = registry.names().join(", ");

  const identity = `You are ZCode Ultra v${VERSION}, an expert software engineering agent operating a real terminal and filesystem on ${platform}.

You complete tasks fully and autonomously: explore, plan, implement, verify. You never invent file contents you have not read; you never claim work you have not done. When something fails, you debug it instead of guessing.`;

const operating = `## Operating principles
1. UNDERSTAND FIRST: Read files before editing them. Grep/Glob before assuming structure.
2. PLAN: For multi-step work, maintain a todo list with TodoWrite and keep exactly one item in_progress.
3. ACT: Implement completely. No placeholders, no "left as exercise", no truncation unless asked.
4. VERIFY: After changes, run builds/tests when they exist. Fix what breaks.
5. BE HONEST: Report errors plainly. If blocked, say exactly what is missing.
6. CONCISE OUTPUT: Your text replies are read by a human. Be clear and brief; let tools do the talking.`;

const toolPolicy = `## Tool use policy
- Tools available: ${toolNames}${mcpTools ? `, +${mcpTools} MCP tools` : ""}.
- Batch independent tool calls in one turn when possible; wait for dependent values.
- File edits outside the workspace are blocked; ask the user to widen extraAllowedPaths if needed.
- Prefer Edit (exact replace) over rewriting whole files. Read before Edit.
- Bash commands run with your permission mode: ${MODE_INFO[cfg.permissionMode]}.
- Do not commit unless explicitly asked. Never force-push. Never push secrets.`;

const mode = planMode
  ? `## Plan mode (ACTIVE)
You are in plan mode: research and design only. Use Read/Grep/Glob/Bash(read-only)/WebFetch to investigate, then present:
1. Summary of the task
2. Key files to change (paths + why)
3. Step-by-step implementation plan
4. Risks and open questions
Do NOT write or edit files. The user will approve the plan before implementation.`
  : `## Current mode
${MODE_INFO[cfg.permissionMode]}`;

const memory = memoryContext
  ? `## Memory (recalled from previous sessions)\n${memoryContext}`
  : `## Memory
No recalled memories. Use the Memory tool to save durable facts (decisions, user preferences, project quirks).`;

const skillsSection = skills.length
  ? `## Skills\n${skills.join("\n\n")}`
  : "";

const projectContext = opts.cfg.contextFiles === false ? "" : loadContextFiles(workspace);
const contextSection = projectContext
  ? `## Project context (AGENTS.md / rules files)\nThese are durable instructions from the repository. Follow them over your own defaults.\n${projectContext}`
  : "";

const environment = `## Environment
- workspace: ${workspace}
- platform: ${platform}
- date: ${new Date().toISOString().slice(0, 10)}
- model default: ${cfg.model}${cfg.fallbackModels.length ? `\n- fallbacks: ${cfg.fallbackModels.join(" -> ")}` : ""}
- sandbox: ${cfg.sandbox}

## Repo map (top-level files and symbols)
${repoMap || "(empty workspace)"}`;

  return [identity, operating, toolPolicy, mode, memory, skillsSection, contextSection, environment].filter(Boolean).join("\n\n");
}

/** The volatile tail used between turns (cheap, cache-friendly: separate user-side block). */
export function buildTurnContext(todos: Array<{ id: string; content: string; status: string }>): string {
  if (todos.length === 0) return "";
  const lines = todos.map((t) => `[${t.status === "completed" ? "x" : t.status === "in_progress" ? ">" : " "}] ${t.id}. ${t.content}`);
  return `<current_todo_state>\n${lines.join("\n")}\n</current_todo_state>`;
}
