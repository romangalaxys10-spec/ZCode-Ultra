/**
 * End-to-end agent loop test against a scripted OpenAI-compatible mock
 * provider. Verifies: SSE streaming parse, multi-event tool-call argument
 * accumulation, parallel tool execution, loop termination, session
 * persistence, exec JSON output.
 *
 * Response 1 (one request): Write + Bash tool calls, args split across
 *   multiple SSE chunks (tests accumulation). Response 2: final text.
 */
import http from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "zcu-e2e-"));
process.env.ZCODE_ULTRA_HOME = path.join(HOME, "data");
const WS = path.join(HOME, "ws");
fs.mkdirSync(WS, { recursive: true });
const PORT = 11435;

const RESP1 = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "Write", arguments: '{"file_path": "e2e-proof.txt", "cont' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ent": "e2e works\\n" }' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 1, id: "call_2", type: "function", function: { name: "Bash", arguments: '{"command": "echo parallel-$((6*7))", "timeout_ms": 10000' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 40 } },
];

const RESP2 = [
  { choices: [{ delta: { content: "Both tools ran. Task complete." } }] },
  { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 220, completion_tokens: 12 } },
];

let requestCount = 0;
let sawToolResultFeedback = false;

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url?.includes("/chat/completions")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      if (parsed.messages.some((m) => m.role === "tool")) sawToolResultFeedback = true;
      const events = requestCount === 0 ? RESP1 : RESP2;
      requestCount++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      let i = 0;
      const writeNext = () => {
        if (i >= events.length) {
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify(events[i++])}\n\n`);
        setTimeout(writeNext, 5);
      };
      writeNext();
    });
    return;
  }
  res.writeHead(404).end();
});

server.listen(PORT, "127.0.0.1", () => {
  void run();
});

async function run() {
  try {
    fs.mkdirSync(process.env.ZCODE_ULTRA_HOME, { recursive: true });
    fs.writeFileSync(path.join(process.env.ZCODE_ULTRA_HOME, "config.json"), JSON.stringify({
      model: "ollama/mock-e2e",
      permissionMode: "yolo",
      parallelTools: true,
      providers: { ollama: { baseUrl: `http://127.0.0.1:${PORT}/v1`, apiKeyEnv: "", model: "mock-e2e" } },
    }, null, 2));

    const out = await new Promise((resolve, reject) => {
      execFile("node", [path.join(process.cwd(), "dist", "index.js"), "exec", "--json", "write the proof file and run the echo"], { cwd: WS, timeout: 30000, encoding: "utf8" }, (err, stdout) => {
        if (err && !stdout) reject(err);
        else resolve(stdout);
      });
    });
    const json = JSON.parse(out);
    if (process.env.E2E_DEBUG) console.log("RAW:", JSON.stringify(json, null, 2));
    const okText = json.result?.includes("Task complete");
    const proofFile = fs.existsSync(path.join(WS, "e2e-proof.txt")) && fs.readFileSync(path.join(WS, "e2e-proof.txt"), "utf8").includes("e2e works");
    const checks = [
      [okText, `final text returned (${json.turns} turns)`],
      [proofFile, "Write tool executed with streamed/accumulated args"],
      [(() => {
        try {
          const sFile = sessions[0];
          return sFile ? fs.readFileSync(path.join(process.env.ZCODE_ULTRA_HOME, "sessions", sFile), "utf8").includes("parallel-42") : false;
        } catch { return false; }
      })(), "Bash tool executed (parallel-$((6*7)) = parallel-42 in session log)"],
      [sawToolResultFeedback, "tool results fed back for second turn"],
      [json.ok === true, "exec ok flag"],
      [json.tokens > 0, `usage accounting (${json.tokens} tok)`],
    ];
    const sessions = fs.readdirSync(path.join(process.env.ZCODE_ULTRA_HOME, "sessions")).filter((f) => f.endsWith(".jsonl"));
    checks.forEach((c) => { if (c[1].startsWith("Bash tool executed")) c[0] = (() => {
      try {
        const sFile = sessions[0];
        return sFile ? fs.readFileSync(path.join(process.env.ZCODE_ULTRA_HOME, "sessions", sFile), "utf8").includes("parallel-42") : false;
      } catch { return false; }
    })(); });
    checks.push([sessions.length === 1, `session JSONL persisted (${sessions.length})`]);

    for (const [ok, name] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
    const okAll = checks.every(([ok]) => ok);
    console.log(`\nE2E: ${okAll ? "PASSED" : "FAILED"}`);
    process.exitCode = okAll ? 0 : 1;
  } catch (e) {
    console.error("E2E error:", e.stdout?.toString?.() ?? e.message);
    process.exitCode = 1;
  } finally {
    server.close();
  }
}
