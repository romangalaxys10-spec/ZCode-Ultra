/**
 * Smoke test: exercises config, session persistence, tools, safety and
 * compaction helpers without any API key. Run: node scripts/smoke.mjs
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "zcu-smoke-"));
process.env.ZCODE_ULTRA_HOME = path.join(HOME, "data");
const WS = path.join(HOME, "ws");
fs.mkdirSync(WS, { recursive: true });

const { loadConfig, BUILTIN_PROVIDERS } = await import("../dist/config/config.js");
const { Session } = await import("../dist/core/session.js");
const { createDefaultRegistry } = await import("../dist/tools/registry.js");
const { makeSafety, scrubSecrets, pathAllowed, bashRisk, checkApproval } = await import("../dist/safety/safety.js");
const { estimateHistoryTokens, pruneToolResults } = await import("../dist/core/compaction.js");

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}

const { config: cfg } = loadConfig(WS);
cfg.permissionMode = "yolo"; // smoke test: auto-approve
cfg.sandbox = "off";

// --- config ---
check("config defaults", cfg.model === "zai/glm-4.6" && cfg.maxTurns === 60);
check("builtin providers present", "zai" in BUILTIN_PROVIDERS);

// --- session roundtrip ---
const s1 = new Session(WS, cfg.model);
s1.append({ kind: "user", message: { role: "user", content: "hello world" } });
s1.append({ kind: "assistant", message: { role: "assistant", content: "hi there" } });
const loaded = Session.load(s1.id);
check("session persist + resume", loaded !== null && loaded.history.length === 2);

// --- tools ---
const reg = createDefaultRegistry();
let todos = [];
let memories = [];
const tools = { cfg, workspace: WS, safety: makeSafety(cfg, WS, null), services: {
  spawnSubagent: async () => "subagent-ok",
  todoState: () => todos,
  setTodoState: (t) => { todos = t; },
  memoryAppend: async (n) => { memories.push(n); },
  memorySearch: async () => memories.join("\n"),
} };

const w = await reg.execute("Write", { file_path: "src/hello.ts", content: "export function hello(name: string): string {\n  return `hello ${name}`;\n}\n" }, tools);
check("Write tool", !w.isError, w.output);

const r = await reg.execute("Read", { file_path: "src/hello.ts" }, tools);
check("Read tool (line numbers)", !r.isError && r.output.includes("1\texport function hello"), r.output.slice(0, 80));

const e1 = await reg.execute("Edit", { file_path: "src/hello.ts", old_string: "hello ${name}", new_string: "HELLO ${name.toUpperCase()}" }, tools);
const e2 = await reg.execute("Read", { file_path: "src/hello.ts" }, tools);
check("Edit tool", !e1.isError && e2.output.includes("HELLO ${name.toUpperCase()}"), e1.output);

const dup = await reg.execute("Edit", { file_path: "src/hello.ts", old_string: "not-in-file", new_string: "x" }, tools);
check("Edit uniqueness guard", dup.isError === true);

const g = await reg.execute("Glob", { pattern: "**/*.ts" }, tools);
check("Glob tool", g.output.includes("src/hello.ts"), g.output);

const gr = await reg.execute("Grep", { pattern: "HELLO", output_mode: "content" }, tools);
check("Grep tool", gr.output.includes("src/hello.ts:2"), gr.output.slice(0, 80));

const b = await reg.execute("Bash", { command: "echo smoke-$((20+3))" }, tools);
check("Bash tool", b.output.includes("smoke-23"), b.output);

const ls = await reg.execute("LS", { path: "." }, tools);
check("LS tool", ls.output.includes("src/"));

const t = await reg.execute("TodoWrite", { todos: [{ content: "a", status: "pending" }, { content: "b", status: "in_progress" }] }, tools);
check("TodoWrite tool", !t.isError && todos.length === 2);

const m = await reg.execute("Memory", { mode: "save", note: "smoke memory entry" }, tools);
const m2 = await reg.execute("Memory", { mode: "search", query: "smoke memory" }, tools);
check("Memory save+recall", !m.isError && m2.output.includes("smoke memory entry"));

const task = await reg.execute("Task", { description: "test", prompt: "do nothing", subagent_type: "explore" }, tools);
check("Task (subagent stub)", task.output === "subagent-ok", task.output);

// --- safety ---
check("scrubSecrets", scrubSecrets("key ghp_abcdefghijklmnopqrstuvwxyz0123456789 done").includes("***REDACTED***"));
check("pathAllowed inside", pathAllowed(makeSafety(cfg, WS, null), path.join(WS, "a/b.txt")));
check("pathAllowed outside", !pathAllowed(makeSafety(cfg, WS, null), "/etc/passwd"));
check("bashRisk high", bashRisk(["rm -rf /"]) === "high");
check("bashRisk low", bashRisk(["ls -la"]) === "low");

// plan mode denies writes
const planSafety = makeSafety({ ...cfg, permissionMode: "plan" }, WS, null);
const planDeny = await checkApproval(planSafety, { tool: "Write", summary: "x", filePath: path.join(WS, "f.txt"), risk: "medium" });
check("plan mode denies writes", planDeny.approved === false);

// default mode denies writes without handler
const defSafety = makeSafety({ ...cfg, permissionMode: "default" }, WS, null);
const defDeny = await checkApproval(defSafety, { tool: "Write", summary: "x", filePath: path.join(WS, "f.txt"), risk: "medium" });
check("default mode denies without handler", defDeny.approved === false);

// --- compaction ---
const long = Array.from({ length: 40 }, (_, i) => ({ role: "tool", content: `result ${i} `.repeat(50), toolCallId: `c${i}` }));
check("estimateHistoryTokens", estimateHistoryTokens(long) > 1000);
const pruned = pruneToolResults(long, 5);
check("pruneToolResults", pruned[0].content.includes("[pruned tool result") && pruned[39].content.startsWith("result 39"));

// --- exec headless (no API key => graceful error) ---
let exitCode = -1;
let execOutput = "";
try {
  execFileSync("node", [path.join(process.cwd(), "dist", "index.js"), "exec", "--json", "say hi"], { cwd: WS, env: process.env, timeout: 30000 });
} catch (err) {
  exitCode = err.status ?? -1;
  execOutput = (err.stdout ?? "").toString();
}
check("exec graceful without API key", exitCode === 1 && execOutput.includes("All models failed"), `exit=${exitCode} out=${execOutput.slice(0, 80)}`);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
