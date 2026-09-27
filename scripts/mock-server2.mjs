import http from "node:http";
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
let scriptIdx = 0;
let sawSecondRequest = false;
const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url?.includes("/chat/completions")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      if (parsed.messages.some((m) => m.role === "tool")) sawSecondRequest = true;
      const events = scriptIdx === 0 ? RESP1 : RESP2;
      scriptIdx++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const eventsList = [...events, "data: [DONE]"];
      let i = 0;
      const writeNext = () => {
        if (i >= eventsList.length) { res.end(); return; }
        const ev = eventsList[i++];
        res.write(typeof ev === "string" ? ev + "\n\n" : `data: ${JSON.stringify(ev)}\n\n`);
        setTimeout(writeNext, 10);
      };
      writeNext();
    });
    return;
  }
  res.writeHead(404).end();
});


server.listen(11435, "127.0.0.1", () => console.log("mock up"));
