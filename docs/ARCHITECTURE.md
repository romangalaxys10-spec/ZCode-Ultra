# Architecture

## Design goals

1. **One brain, many surfaces** — the agent loop is a library; TUI, Discord and WhatsApp are thin adapters (OpenClaw's thin-channel pattern).
2. **Zero lock-in** — any OpenAI-compatible endpoint works; native Anthropic supported; fallback chains are first-class.
3. **Small & auditable** — ~3.5k lines of TypeScript, one runtime dependency (discord.js), everything else hand-rolled (MCP client, glob/grep, HTML-to-text, SSE parsing, config parsing).
4. **Event-sourced** — "model-visible means logged" (DeepSeek-harness invariant): append-only JSONL sessions, resume/replay/derive.

## Module map

```
src/
├── index.ts               CLI dispatcher (no framework)
├── util.ts                ids, atomic writes, chunking, ANSI, spinner
├── config/config.ts       layered config, JSON5-lite, provider presets
├── providers/
│   ├── types.ts           normalized message/tool/stream contract
│   ├── openai-compat.ts   SSE client for all OpenAI-compatible providers
│   ├── anthropic.ts       native /v1/messages SSE client
│   └── registry.ts        router: fallback chains, retries, accumulation
├── core/
│   ├── session.ts         JSONL event store + resume + listing
│   ├── context.ts         stable→volatile prompt tiers, repo map (Aider-lite)
│   ├── compaction.ts      pressure-triggered, tool-result pruning first
│   └── agent.ts           THE LOOP
├── tools/                 registry + 13 built-in tools
├── subagents/             (in core/agent.ts: presets, isolation, 1-level cap)
├── mcp/client.ts          JSON-RPC 2.0 stdio MCP client (zero-dep)
├── memory/memory.ts       MEMORY.md + scored keyword recall
├── skills/skills.ts       SKILL.md frontmatter + trigger selection
├── safety/safety.ts       modes, approvals, allowlists, scrubbing, sandbox
├── ui/repl.ts             readline TUI, streaming, in-chat commands
├── cli/exec.ts            headless mode (CI: exit codes 0/1/2)
├── cli/setup.ts           interactive wizard
└── bots/
    ├── shared.ts          BotBrain: per-chat queues, block streaming,
    │                      session binding, approvals delegation
    ├── discord.ts         discord.js: /zcode slash, buttons, mention guard
    └── whatsapp.ts        Baileys + Cloud API adapters
```

## The agent loop

```
run(prompt):
  1. skill select + memory recall → decorate prompt (log keeps full text)
  2. while turns < max:
       a. compaction pressure check → compact if needed (prune tools, summarize)
       b. messages = [stable system prompt] + history + [volatile todo state]
       c. routeCompletion(chain) — stream, accumulate tool calls, retries
       d. no tool calls? → return final text
       e. execute tools (parallel pool ≤4, order preserved)
          - beforeTool hooks (exit 2 vetoes)
          - checkApproval: mode + argv + path rules → handler or deny
          - afterTool hooks
       f. append tool_use + tool_result events (scrubbed, budgeted)
```

Prompt-stability discipline (Hermes pattern): identity/policy blocks never change mid-session → provider prompt caches stay warm; only the volatile tail (todo state) varies between turns.

## Streaming to chat platforms

Token deltas don't belong on chat platforms (rate limits, message edits). Bots use **block streaming**: an interval flushes the last completed block (`\n\n` boundary) into an editable message; final answers are chunked to platform limits. Discord supports real edits; Baileys sends limited previews; Cloud API stays silent until final.

## Safety layers (defense in depth)

1. Permission mode gates (`plan` denies mutators outright)
2. blockedCommands prefix/wildcard rules (always win)
3. argv-bound approval prompts (terminal y/n/a · Discord buttons)
4. path allowlist for file tools
5. secret scrubbing on all model-visible tool output and all bot egress
6. optional Docker sandbox world (memory/CPU capped, HOME=tmp)
7. hooks as a policy escape hatch (exit 2 veto)

## Build & release

- `tsc` → `dist/` (npm package, Node ≥ 20)
- Bun `--compile` → standalone binaries (mac arm/x, linux x64/arm, win x64) via GitHub Actions on tags
- nfpm → deb/rpm; formula/manifests for brew, winget, scoop in `install/`
- CI: typecheck + build + smoke + e2e-mock on 3 OSes × Node 20/22/24

## Trade-offs & roadmap

- MCP: stdio only for now (HTTP/SSE planned) — covers the majority of servers.
- The web UI (`serve`) is deliberately deferred until the core is battle-tested.
- PTC (programmatic tool calling) is on the roadmap for multi-step tool compositions.
