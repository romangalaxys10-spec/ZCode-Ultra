# ZCode (original) vs ZCode Ultra

A factual comparison between **zai-org/ZCode** (the upstream this project studies, v3.14.x, TypeScript, ~6.9k stars as of 2026-09) and **ZCode Ultra** (this repository). Upstream deserves credit as the reference implementation of a clean hexagonal agent core; Ultra's goal is not to replace it feature-for-feature, but to rebuild its best ideas in a lean, provider-neutral, bot-native package — and to fold in what the rest of the harness ecosystem proved works.

> Also see [HARNESS-RESEARCH.md](HARNESS-RESEARCH.md) for the survey of top harnesses (Claude Code, Codex CLI, Gemini CLI, opencode, Cline, Aider, Goose, OpenHands, SWE-agent, Crush) and which of their features landed in Ultra.

## At a glance

| Dimension | zai-org/ZCode (original) | ZCode Ultra (this repo) |
|---|---|---|
| **License & repo** | Open, z.ai maintained, ~6.9k stars | MIT, community, independent |
| **Language / runtime** | TypeScript, requires Node 24 + pnpm | TypeScript, Node 20.10+, zero-build-run (`npm i -g`), no pnpm needed |
| **Providers** | Z.ai GLM family (vendor-tied) | **Multi-provider**: GLM, Zhipu, DeepSeek, OpenAI, Anthropic (native SSE), Moonshot, Qwen, Ollama, vLLM, LM Studio + any OpenAI-compatible endpoint |
| **Fallback chains** | — | ✅ ordered fallback with per-model retries on 429/5xx/network |
| **Role-based model routing** | — | ✅ planner / worker / summarizer can each use a different model (Goose lead/worker pattern) |
| **Frontends** | TUI, Web UI, Electron desktop | Terminal REPL, headless `exec`, **Discord bot**, **WhatsApp bot** (Baileys + Cloud API) |
| **Install footprint** | Node 24 + pnpm toolchain; desktop app adds Electron weight | one command, ~10 MB; standalone binaries (mac arm/x64, linux x64/arm64, windows x64) need **no Node at all** |
| **Package formats** | source build | npm, curl\|bash, PowerShell, Homebrew, deb, rpm, winget, scoop, CI binaries |
| **Session store** | Session protocol v4, rich UI-facing | Event-sourced JSONL ("model-visible means logged"), resumable, forkable |
| **Context compaction** | `compact` package | ✅ pressure-triggered, prunes tool results first, **user-definable preserve-lists** (OpenHands condenser pattern) |
| **Repo map** | — | ✅ Aider-lite: file tree + symbol extraction in the system prompt |
| **Git integration** | — | ✅ agent changes auto-commit attributed (`zcu: …`), `/undo` reverts only agent commits |
| **Checkpoints / rollback** | — | ✅ content-addressed snapshots before every mutating turn, `/checkpoint restore` (Cline/Gemini pattern) |
| **Edit lint guard (ACI)** | — | ✅ `node --check` / `ast.parse` / JSON / delimiter-scanner after every Write+Edit (SWE-agent pattern) |
| **Background tasks** | — | ✅ `Bash(run_in_background)` + `TaskOutput` / `TaskStop` |
| **Custom slash commands** | — | ✅ `.zcode-ultra/commands/*.md` work in REPL *and* on Discord/WhatsApp |
| **Context files** | — | ✅ AGENTS.md / CLAUDE.md / GEMINI.md hierarchy + `.zcode-ultra/rules/*.md` auto-injected |
| **Cost tracking** | — | ✅ per-model usage ledger + estimated USD `/cost`, surfaced in `exec --json` |
| **Watch mode** | — | ✅ `zcode-ultra watch` — `// AI: …` comments invoke the agent (Aider pattern) |
| **Safety model** | Permission prompts | 4 permission modes, argv-bound approvals, blocklists, path allowlists, secret scrubbing, **Docker sandbox** mode |
| **Hooks** | ✅ hook system | ✅ beforeTool / afterTool / beforeStep with exit-code gating |
| **MCP** | ✅ | ✅ zero-dependency stdio client (`mcp__server__tool`) |
| **Memory / skills / plan mode / subagents** | ✅ | ✅ all four, plus skill auto-selection by trigger words |
| **CI** | — | 3 OS × 3 Node matrix, all green; tagged releases ship binaries + packages |

## Where the original is ahead (honest assessment)

ZCode Ultra stays deliberately small; the upstream project has real advantages that a lean fork does not chase:

1. **Product surface.** A polished TUI, a Web UI and an Electron desktop app represent person-years of interface work Ultra does not duplicate.
2. **Vendor-validated agent tuning.** z.ai tunes the GLM prompt/tool-loop integration against their own models; Ultra's prompts are provider-neutral by design and may be less tuned for any single model.
3. **Session protocol maturity.** Session protocol v4 with UI-facing state sync is battle-tested at larger scale than Ultra's JSONL store.
4. **Community and support.** An official org, issue triage and roadmap beat a community fork's GitHub Issues.
5. **Ecosystem integrations.** IDE extensions and vendor console tie-ins exist upstream; Ultra's integrations are chat platforms and CI by design.

## Where Ultra is the better fit

1. **You use more than one provider.** Route GLM → DeepSeek → OpenAI in one config; per-role models let a cheap summarizer feed a strong planner. Upstream is tied to the Z.ai family.
2. **You want the agent in chat, not just the terminal.** Discord slash commands with button approvals and WhatsApp (QR or official Cloud API) share the exact same brain, session store and safety stack as the REPL.
3. **You ship to machines you do not control.** Standalone binaries and 8 package formats mean no Node, no pnpm, no build step — the original assumes a developer toolchain.
4. **You need auditable autonomy.** Every agent edit can auto-commit as an attributed git commit, every mutating turn has a checkpoint you can restore, and broken syntax is rejected at edit time instead of build time.
5. **You want a readable core.** The whole harness is ~5k lines of dependency-free TypeScript (one regular dep: discord.js). Every subsystem — provider router, agent loop, checkpoints, MCP — fits in one file you can read over coffee.

## Migration notes

- Coming from ZCode: `zcode-ultra setup` writes `~/.zcode-ultra/config.json`; model refs move from `glm-4.6` to `zai/glm-4.6` form. Sessions are not migrated (different store format); export transcripts from ZCode first if you need them.
- The REPL slash commands you know from other harnesses mostly exist: `/model`, `/mode`, `/plan`, `/compact`, `/cost`, `/undo`, `/checkpoint`, `/sessions`, `/resume`. Custom commands: drop `.md` files into `.zcode-ultra/commands/`.
- CI usage: `zcode-ultra exec "..." --json --yolo --max-turns 40` returns structured output with usage, cost and the files touched.
