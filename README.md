<div align="center">

# ZCode Ultra

**A lean, multi-provider, bot-native coding agent harness.**

Terminal agent + Discord bot + WhatsApp bot — one brain, everywhere.

`TypeScript` · `Node 20+` · `MIT` · macOS · Windows · Linux

[Quickstart](#-quickstart) · [Install](#-install) · [Discord](docs/DISCORD.md) · [WhatsApp](docs/WHATSAPP.md) · [Config](docs/CONFIG.md) · [Architecture](docs/ARCHITECTURE.md)

</div>

---

## Why ZCode Ultra?

ZCode Ultra takes the best ideas from the current generation of agent harnesses — **ZCode** (hexagonal agent core, session protocol), **DeepSeek's harness** (event-sourced sessions, interceptable loop, compaction as a seam, parallel tool execution), **OpenClaw** (channel adapters, block streaming, exec approvals), **Codex CLI** (sandbox-first safety), **Aider** (repo maps), **OpenCode** (multi-provider, headless exec) and **Hermes** (memory + skills) — and rebuilds them into one small, fast, zero-lock-in harness.

| | ZCode Ultra | Typical desktop harnesses | Chat-bot agents |
|---|---|---|---|
| Multi-provider routing | ✅ GLM / DeepSeek / OpenAI / Anthropic / Ollama + any OpenAI-compatible, with fallback chains | Usually vendor-tied | Often single-model |
| Discord + WhatsApp bots | ✅ built-in, same agent brain | ❌ | ✅ but weak coding tools |
| Install footprint | ✅ one command, ~10 MB, no Electron | ❌ 500 MB+ desktop apps | varies |
| Standalone binaries | ✅ mac (arm/x), linux (x64/arm), windows (x64) | ❌ | ❌ |
| Plan mode · Subagents · Memory · Skills · MCP · Docker sandbox | ✅ all built in | partial | ❌ |
| Headless `exec` for CI | ✅ | partial | ❌ |

## ✨ Highlights

- **🧠 Multi-provider agent brain** — unified streaming layer for OpenAI-compatible APIs (Z.ai GLM, Zhipu, DeepSeek, Moonshot, Qwen, Ollama, vLLM, LM Studio, OpenRouter…) plus native Anthropic. Define a **fallback chain** and the router retries across models on 429/5xx/network failures automatically.
- **🛠 Full tool belt** — Read / Write / Edit (exact-match, occurrence-guarded) / Bash / Grep / Glob / LS / WebFetch / WebSearch / TodoWrite / NotebookEdit — plus hand-rolled **MCP client** so any MCP server plugs in as tools.
- **🤖 Subagents with isolated context** — `explore`, `plan`, `general` presets spawn in parallel-safe isolation; the main loop stays lean.
- **📝 Event-sourced sessions** — every turn is append-only JSONL. Resume any session, replay transcripts, survive crashes.
- **🗜 Compaction as a seam** — pressure-triggered auto-compaction prunes tool results *before* model summarization (cheap tokens first).
- **🛡 Defense-in-depth safety** — 4 permission modes, argv-bound exec approvals, command blocklists, path allowlists, **secret scrubbing on every tool result**, and optional **Docker sandbox** execution.
- **💬 Bot-native** — the *same* brain drives the terminal, a Discord bot (slash commands, block streaming, button approvals) and a WhatsApp bot (Baileys QR pairing or official Cloud API).
- **⚡ Zero-friction distribution** — npm package, `curl | bash` one-liner, PowerShell installer, Homebrew formula, deb/rpm, winget/scoop manifests, and CI-built standalone binaries via GitHub Actions.

## 🚀 Quickstart

```bash
# 1. Install (pick one)
npm i -g zcode-ultra                          # npm
curl -fsSL https://raw.githubusercontent.com/romangalaxys10-spec/ZCode-Ultra/main/install/install.sh | bash   # mac/linux
irm https://raw.githubusercontent.com/romangalaxys10-spec/ZCode-Ultra/main/install/install.ps1 | iex         # windows

# 2. Configure a provider (30 seconds)
export ZAI_API_KEY=...          # or DEEPSEEK_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY
zcode-ultra setup               # guided wizard (writes ~/.zcode-ultra/config.json)

# 3. Go
zcode-ultra                     # interactive agent
zcode-ultra exec "fix the failing tests in src/" --yolo   # headless (CI-friendly)
zcode-ultra bot discord         # same brain in Discord
zcode-ultra bot whatsapp        # same brain in WhatsApp (QR pairing)
```

> Default model is `zai/glm-4.6`. Switch anytime: `zcode-ultra -m deepseek/deepseek-chat` or `/model openai/gpt-4.1` in the REPL.

### What it looks like

```
zu> refactor the retry logic in src/providers/registry.ts to use exponential backoff
⏺ Read file_path=src/providers/registry.ts
⏺ Edit file_path=src/providers/registry.ts (1 replacement)
⏺ Bash command=npm test -- --grep registry

Refactored to exponential backoff (700ms × attempt). All 14 registry tests pass.
[3 turn(s), ~4.2k tok, session s_lx2ab1_9c3d]
```

## 📦 Install

| Method | Command | Platform |
|---|---|---|
| npm | `npm i -g zcode-ultra` | all |
| One-line script | `curl -fsSL …/install.sh \| bash` | macOS, Linux |
| PowerShell | `irm …/install.ps1 \| iex` | Windows |
| Homebrew | `brew install romangalaxys10-spec/tap/zcode-ultra` | macOS, Linux |
| .deb / .rpm | from [Releases](https://github.com/romangalaxys10-spec/ZCode-Ultra/releases) | Linux |
| Standalone binaries | `zcode-ultra-darwin-arm64`, `…-linux-x64`, `…-windows-x64.exe`, … | all |
| winget / scoop | manifests in [`install/`](install/) | Windows |

Standalone binaries need **no Node.js at all** (compiled with Bun). Full details: [INSTALL.md](INSTALL.md).

## 🤖 Bots

Run the same agent brain from chat platforms:

```bash
zcode-ultra bot discord          # /zcode slash command, block streaming, button approvals
zcode-ultra bot whatsapp         # Baileys QR pairing (free, unofficial)
zcode-ultra bot whatsapp --cloud # Meta Cloud API (official, webhooks)
```

- **Discord**: `/zcode prompt="…" plan=true` — streams completed blocks into the channel, asks for approval with buttons when a risky tool fires. [Setup guide →](docs/DISCORD.md)
- **WhatsApp**: DMs respond directly, groups require the trigger prefix (`!z ` by default), number allowlist supported. [Setup guide →](docs/WHATSAPP.md)

All outbound bot text passes through secret scrubbing. Both bots use per-chat message queues with 500 ms debounce and serialized execution.

## 🧰 Core capabilities

### Permission modes

| Mode | Behavior |
|---|---|
| `plan` | Read-only research, then a plan. No writes. |
| `default` | Safe ops run; writes/commands ask (y/n/always in terminal, buttons in Discord) |
| `acceptEdits` | File edits auto-approved; commands still ask |
| `yolo` | Everything auto-approved — use with `--sandbox` |

### Provider presets (built-in)

`zai` · `zhipu` · `deepseek` · `openai` · `anthropic` · `moonshot` · `qwen` · `ollama` · `lmstudio` · `vllm` — plus any custom OpenAI-compatible endpoint via config.

```bash
export ZCODE_ULTRA_MODEL=deepseek/deepseek-chat
export ZCODE_ULTRA_FALLBACK="zai/glm-4.6,openai/gpt-4.1"
```

### MCP (Model Context Protocol)

```jsonc
// ~/.zcode-ultra/config.json
{
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "..." } }
  }
}
```

MCP tools appear to the agent as `mcp__github__<tool>` — indistinguishable from built-ins.

### Memory & skills

- `Memory` tool + `zcode-ultra memory "note"` — durable markdown memory with keyword recall injected into future sessions.
- `SKILL.md` files in `~/.zcode-ultra/skills/` or `.zcode-ultra/skills/` auto-load when their trigger words match the request.

## 🏗 Architecture in 20 seconds

```
┌─────────────┐   ┌──────────────┐   ┌─────────────┐
│  TUI (zu)   │   │ Discord bot  │   │ WhatsApp bot│
└──────┬──────┘   └──────┬───────┘   └──────┬──────┘
       └────────────┬────┴──────────────────┘
                    ▼
        ┌───────────────────────┐     tools: Bash/Read/Write/Edit/Grep/…
        │      Agent loop       │◄──► subagents (explore/plan/general)
        │  plan-mode · hooks ·  │     MCP: mcp__server__tool
        │  parallel tool pool   │     memory: MEMORY.md + recall
        └──────────┬────────────┘     skills: SKILL.md
                   ▼
        ┌───────────────────────┐
        │  Provider router      │  fallback chains · 429/5xx retry
        │  openai-compat │ anthropic
        └──────────┬────────────┘
                   ▼
          GLM · DeepSeek · OpenAI · Anthropic · Ollama · …
```

Deep dive: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · Safety model: [docs/CONFIG.md](docs/CONFIG.md)

## 🧪 Quality

- **24 smoke tests** (tools, safety, sessions, compaction) + **7-check e2e** against a scripted mock provider — no API keys needed: `npm test && npm run e2e`
- CI matrix: 3 OSes × 3 Node versions on every push.

```bash
git clone https://github.com/romangalaxys10-spec/ZCode-Ultra && cd ZCode-Ultra
npm install && npm run build && npm test
```

## 🗺 Roadmap

- [ ] HTTP/SSE MCP transport (currently stdio)
- [ ] `zcode-ultra serve` — web UI (client/server split)
- [ ] Programmatic tool calling (PTC) — one-turn tool programs
- [ ] Voice transcription for Discord
- [ ] Team mode — multi-agent task boards

## 📜 License & attribution

[MIT](LICENSE) — with gratitude to the harness builders whose ideas this project consolidates: ZCode (z.ai), DeepSeek, OpenClaw, Codex CLI, OpenCode, Aider, Goose, OpenHands, Hermes. See [NOTICE.md](NOTICE.md).

⚠️ **Safety note**: this agent executes real commands. The `yolo` mode plus sandbox is the recommended combination for autonomous work. The WhatsApp Baileys adapter is unofficial — heavy use can risk account throttling by WhatsApp; the Cloud API adapter is the compliant path.
