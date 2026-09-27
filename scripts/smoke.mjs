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
const { estimateHistoryTokens, pruneToolResults, compilePreserve } = await import("../dist/core/compaction.js");
const { createCheckpoint, listCheckpoints, restoreCheckpoint } = await import("../dist/core/checkpoints.js");
const { lintFile, balancedDelimiters } = await import("../dist/core/edit-guard.js");
const { loadCustomCommands, matchCommand, expandCommand } = await import("../dist/core/custom-commands.js");
const { loadContextFiles } = await import("../dist/core/context-files.js");
const { addUsage, estimateCost, formatUsageLine } = await import("../dist/core/cost.js");
const { gitInfo } = await import("../dist/core/git.js");
const { startTask, getTask, stopAllTasks } = await import("../dist/tools/bg-tools.js");

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
let checkpointCalls = 0;
let lintCalls = 0;
let dirtyMarks = [];
const tools = { cfg, workspace: WS, safety: makeSafety(cfg, WS, null), services: {
  spawnSubagent: async () => "subagent-ok",
  todoState: () => todos,
  setTodoState: (t) => { todos = t; },
  memoryAppend: async (n) => { memories.push(n); },
  memorySearch: async () => memories.join("\n"),
  beforeFileWrite: () => { checkpointCalls++; },
  afterFileWrite: (f) => { lintCalls++; return lintFile(f); },
  markDirty: (f) => { dirtyMarks.push(f); },
} };

const w = await reg.execute("Write", { file_path: "src/hello.ts", content: "export function hello(name: string): string {\n  return `hello ${name}`;\n}\n" }, tools);
check("Write tool", !w.isError, w.output);
check("Write tool emits hooks (checkpoint/lint/dirty)", checkpointCalls === 1 && lintCalls === 1 && dirtyMarks.length === 1, `cp=${checkpointCalls} lint=${lintCalls} dirty=${dirtyMarks.length}`);
check("edit guard: valid TS passes", w.output.includes("syntax OK"), w.output);

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

const b = await reg.execute("Bash", { command: "node -e \"console.log('smoke-' + (20 + 3))\"" }, tools);
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

// --- edit guard (SWE-agent ACI) ---
const badFile = path.join(WS, "broken.js");
fs.writeFileSync(badFile, "function f( { return 1;\n");
check("edit guard catches broken js", lintFile(badFile) !== null);
const okFile = path.join(WS, "ok.js");
fs.writeFileSync(okFile, "const x = 1; console.log(x);\n");
check("edit guard passes valid js", lintFile(okFile) === null);
check("balancedDelimiters unclosed", balancedDelimiters("function a() {\n  const b = [1, 2;\n") !== null);
check("balancedDelimiters ok with strings", balancedDelimiters('const s = ")}{([<//>]" ; // )} ignore\nlet t = `template ${x}`;\n') === null);
const badWrite = await reg.execute("Write", { file_path: "broken2.js", content: "if (x { \n" }, tools);
check("Write reports edit-guard failure as tool error", badWrite.isError === true && badWrite.output.includes("edit guard"), badWrite.output.slice(0, 80));

// --- checkpoints (Cline/Gemini pattern) ---
fs.writeFileSync(path.join(WS, "cp-target.txt"), "version-1\n");
const cpId = createCheckpoint(WS, "before edit test");
check("checkpoint created", typeof cpId === "string" && cpId.startsWith("cp_"), String(cpId));
fs.writeFileSync(path.join(WS, "cp-target.txt"), "version-2\n");
fs.writeFileSync(path.join(WS, "cp-new.txt"), "created after\n");
const cps = listCheckpoints(WS);
check("checkpoint list", cps.length >= 1 && cps[0].id === cpId);
const restoreReport = restoreCheckpoint(WS, cpId, { deleteNewFiles: false });
check("checkpoint restore content", fs.readFileSync(path.join(WS, "cp-target.txt"), "utf8") === "version-1\n", restoreReport);
check("checkpoint keeps new files by default", fs.existsSync(path.join(WS, "cp-new.txt")) && restoreReport.includes("created after"));

// --- custom commands (Gemini/Claude Code pattern) ---
const cmdsDir = path.join(WS, ".zcode-ultra", "commands");
fs.mkdirSync(cmdsDir, { recursive: true });
fs.writeFileSync(path.join(cmdsDir, "review.md"), "Review $ARGUMENTS for bugs. Be thorough.");
const cmds = loadCustomCommands(WS);
check("custom command discovered", cmds.some((c) => c.name === "review" && c.source === "workspace"));
const matched = matchCommand(cmds, "/review src/auth.ts");
check("custom command matched + expanded", matched !== null && matched.expanded.includes("src/auth.ts"), JSON.stringify(matched));
check("non-command stays null", matchCommand(cmds, "/definitely-not-a-command") === null);
check("expandCommand", expandCommand({ name: "x", prompt: "go $ARGUMENTS go", source: "global", file: "" }, "fast") === "go fast go");

// --- context files (AGENTS.md pattern) ---
fs.writeFileSync(path.join(WS, "AGENTS.md"), "# Project rules\n- Use pnpm, never npm");
const ctx = loadContextFiles(WS);
check("context files: AGENTS.md loaded", ctx.includes("Use pnpm, never npm"), ctx.slice(0, 120));
fs.mkdirSync(path.join(WS, ".zcode-ultra", "rules"), { recursive: true });
fs.writeFileSync(path.join(WS, ".zcode-ultra", "rules", "style.md"), "- Always use TypeScript strict");
const ctx2 = loadContextFiles(WS);
check("context files: rules dir loaded", ctx2.includes("TypeScript strict"));

// --- cost tracking (Aider /cost pattern) ---
const usageMap = {};
addUsage(usageMap, "zai/glm-4.6", 1_000_000, 100_000);
const cost = estimateCost(usageMap, { zai: { in: 0.6, out: 2.2 } });
check("cost estimate", Math.abs(cost - (0.6 + 0.22)) < 1e-9, String(cost));
check("formatUsageLine", formatUsageLine(usageMap, { zai: { in: 0.6, out: 2.2 } }).includes("1 request"));

// --- background tasks (Claude Code pattern) ---
const bgShell = process.platform === "win32"
  ? { file: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"] }
  : { file: "/bin/bash", args: ["-c"] };
const bgCmd = "node -e \"console.log('bg-smoke-77')\"";
const bgTask = startTask(WS, bgCmd, bgShell.file, bgShell.args, 30_000);
await new Promise((r) => setTimeout(r, 2500));
const bgDone = getTask(bgTask.id);
check("background task runs", bgDone && bgDone.status === "completed" && bgDone.stdout.includes("bg-smoke-77"), JSON.stringify({ status: bgDone?.status, out: bgDone?.stdout, err: bgDone?.stderr }));
const bgLong = startTask(WS, "node -e \"setTimeout(()=>{},60000)\"", bgShell.file, bgShell.args, 30_000);
check("background task registered", getTask(bgLong.id)?.status === "running");
stopAllTasks();
check("stopAllTasks kills", getTask(bgLong.id)?.status !== "running");

// --- git integration (Aider pattern, graceful without repo) ---
const gi = await gitInfo(WS);
check("git integration degrades gracefully", gi.available === true && gi.isRepo === false, JSON.stringify(gi));

// --- preserve lists (OpenHands condenser) ---
const presRegexes = compilePreserve(["KEEP-ME-\\d+"]);
const mixed = [
  { role: "tool", content: "random noise result", toolCallId: "a" },
  { role: "tool", content: "KEEP-ME-42 schema output", toolCallId: "b" },
];
const prunedPres = pruneToolResults(mixed, 0, presRegexes);
check("preserve-list keeps matching", prunedPres[0].content.includes("[pruned") && prunedPres[1].content.includes("KEEP-ME-42"));

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
