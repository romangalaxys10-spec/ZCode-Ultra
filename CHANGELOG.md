# Changelog

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
