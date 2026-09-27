# Changelog

## v1.1.0 — best-of-breed release

Feature release informed by a fresh survey of the top-rated open harnesses on GitHub (opencode ~210k★, Claude Code ~148k★, Codex CLI ~127k★, Gemini CLI ~107k★, OpenHands ~89k★, Cline ~69k★, Goose ~55k★, Aider ~49k★, Crush ~28k★, Roo ~24k★, SWE-agent ~20k★ — star counts as of 2026-09-28). Full study: `docs/HARNESS-RESEARCH.md`; upstream comparison: `docs/COMPARISON.md`.

### New features
- **Git auto-commit + `/undo`** (Aider): opt-in `git.autoCommit` — every agent turn that touches files ends in one attributed `zcu: …` commit listing the files; `/undo` (REPL) and `zcode-ultra undo` (CLI) revert the last agent commit only, refusing human commits or dirty trees (`src/core/git.ts`).
- **Checkpoints** (Cline/Gemini CLI): content-addressed workspace snapshot (sha256-deduped blobs, pruned to 30) before the first file mutation of every turn; `/checkpoint list|restore <id>` (`src/core/checkpoints.ts`).
- **Edit lint guard** (SWE-agent ACI): every Write/Edit is syntax-checked — `node --check` for JS, `ast.parse` for Python, `JSON.parse` for JSON, strings/comments-aware delimiter scanner for TS/JSX — failures return as tool errors so the model self-repairs immediately (`src/core/edit-guard.ts`).
- **Custom slash commands** (Gemini CLI/Claude Code): `.zcode-ultra/commands/*.md` (workspace) and `~/.zcode-ultra/commands/` (global) become `/name` prompts with `$ARGUMENTS`; work in the REPL, Discord and WhatsApp (`src/core/custom-commands.ts`).
- **Hierarchical context files** (CLAUDE.md/agents.md convention): AGENTS.md → CLAUDE.md → GEMINI.md (workspace + 2 parent levels), `.zcode-ultra/rules/*.md` and global `MEMORY.md` injected into the system prompt; `contextFiles` toggle (`src/core/context-files.ts`).
- **Cost & token accounting** (Aider): per-model usage ledger persisted in session meta; `/cost` breakdown in the REPL, `cost`/`usageLine` in `exec --json`, `~$` in run summaries (`src/core/cost.ts`).
- **Background tasks** (Claude Code/OpenHands): `Bash(run_in_background=true)` returns a task id; new `TaskOutput` and `TaskStop` tools; tasks die with the process (`src/tools/bg-tools.ts`).
- **Role-based model routing** (Goose lead-worker/Roo modes): `roles.planner` / `roles.worker` / `roles.summarizer` model refs — plan mode, subagents and compaction can each use a different provider/model.
- **Watch mode** (Aider): `zcode-ultra watch` — `// AI: instruction` comment lines in any file trigger an agent run scoped to that file; trigger lines stripped after success (`--no-strip` keeps them) (`src/cli/watch.ts`).
- **Compaction preserve-lists** (OpenHands condenser): `compactPreserve: [regex…]` keeps matching tool results verbatim during compaction.
- **`resume` command** (Codex/Crush): `zcode-ultra resume [id]` reopens the latest or given session in the REPL.
- Provider router now reports the `modelRef` that served each completion (usage attribution).

### Tools
- New: `TaskOutput`, `TaskStop` (tool count now 15 built-ins).

### Docs
- `docs/COMPARISON.md` — original zai-org/ZCode vs ZCode Ultra, including an honest "where upstream is ahead" section.
- `docs/HARNESS-RESEARCH.md` — survey of 12 top harnesses with live star counts, convergent-design synthesis, feature→provenance map, and "what we did not port and why".
- README feature matrix + git-native editing section; CONFIG.md v1.1 keys + state layout; new REPL command reference.

### Tests
- Smoke suite 24 → 48 checks (checkpoints, edit guard, custom commands, context files, cost math, background tasks, git degradation, preserve-lists).
- E2E 7 → 10 checks (filesTouched, cost field, per-model usage ledger persistence).

## v1.0.2 — initial release

- Fixed: native package build (dpkg-deb + alien), explicit npm publish guard

### Core
- Agent loop with parallel tool execution (bounded pool), max-turns runaway protection
- Multi-provider router: OpenAI-compatible (GLM/Z.ai, Zhipu, DeepSeek, OpenAI, Moonshot, Qwen, Ollama, vLLM, LM Studio, OpenRouter, custom) + native Anthropic; fallback chains with 429/5xx/network retries; SSE streaming
- 13 built-in tools: Read, Write, Edit, LS, Glob, Grep, Bash, NotebookEdit, WebFetch, WebSearch, TodoWrite, Task, Memory
- Event-sourced JSONL sessions: persist, resume, list, inspect
- Auto-compaction: pressure-triggered, tool-result pruning before summarization
- Subagents: explore / plan / general presets, isolated contexts, recursion capped
- Memory: MEMORY.md + scored keyword recall injected per turn
- Skills: SKILL.md auto-loading by trigger match
- MCP: stdio JSON-RPC client, tools bridged as first-class `mcp__server__tool`
- Plan mode, permission modes (default/plan/acceptEdits/yolo), argv-bound approvals, command blocklists, path allowlists, secret scrubbing, Docker sandbox mode, config hooks (exit 2 veto)
- Repo map: tree + symbols, size-adaptive (Aider-lite)

### Surfaces
- Interactive TUI: streaming output, slash commands, Ctrl+C abort, todo rendering
- Headless exec: --json output, exit codes 0/1/2, timeout
- Discord bot: /zcode slash command, plan flag, block streaming, button approvals, mention guard, per-channel sessions
- WhatsApp bot: Baileys QR adapter + Meta Cloud API adapter, trigger prefix, number allowlist, typing indicators, chunked delivery

### Distribution
- npm package (`zcode-ultra`, alias `zu`), Node ≥ 20
- One-line installers: install.sh (macOS/Linux), install.ps1 (Windows)
- Standalone binaries via Bun compile on tags: darwin arm64/x64, linux x64/arm64, windows x64
- Native packages: deb/rpm (nfpm), Homebrew formula, winget + scoop manifests
- CI: typecheck + build + 24 smoke tests + 7-check e2e mock on 3 OS × 3 Node matrix
