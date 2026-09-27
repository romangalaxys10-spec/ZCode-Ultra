import http from "node:http";
const script = [
  {
    choices: [{
      delta: {
        tool_calls: [
          { index: 0, id: "call_1", type: "function", function: { name: "Write", arguments: '{"file_path": "e2e-' } },
          { index: 1, id: "call_2", type: "function", function: { name: "Bash", arguments: '{"command": "echo ' } },
        ],
      },
    }],
  },
  {
    choices: [{
      delta: {
        tool_calls: [
          { index: 0, function: { arguments: 'proof.txt", "content": "e2e works\\n" }' } },
          { index: 1, function: { arguments: 'parallel-$((6*7))"' } },
        ],
      },
    }],
  },
  {
    choices: [{ delta: {}, finish_reason: "tool_calls" }],
    usage: { prompt_tokens: 100, completion_tokens: 40 },
  },
  {
    choices: [{ delta: { content: "Both tools ran. Task complete." }, finish_reason: "stop" }],
    usage: { prompt_tokens: 220, completion_tokens: 12 },
  },
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
      const payload = script[Math.min(scriptIdx, script.length - 1)];
      scriptIdx++;
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      // stream payload in two SSE chunks to test accumulation
      const half = Math.max(1, Math.ceil(JSON.stringify(payload).length / 2));
      // split per-choice events instead: emit events sequentially
      const events = [];
      if (payload.usage) events.push({ ...payload, choices: [] });
      for (const choice of payload.choices ?? []) {
        events.push({ choices: [choice] });
      }
      events.push("data: [DONE]");
      let i = 0;
      const writeNext = () => {
        if (i >= events.length) { res.end(); return; }
        const ev = events[i++];
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
