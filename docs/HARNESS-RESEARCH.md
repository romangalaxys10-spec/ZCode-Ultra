# Harness research: what the top agents do, and what ZCode Ultra adopted

*Survey date: 2026-09-28. Star counts pulled live from the GitHub API on that date. This document pairs each major open harness with the specific features ZCode Ultra ported, so every design decision stays auditable.*

## The field, ranked by GitHub stars (2026-09)

| Harness | Stars | Language | Signature contribution |
|---|---:|---|---|
| [opencode](https://github.com/anomalyco/opencode) | ~210k | TypeScript | client/server split: one session protocol feeds TUI, desktop, SDK, Slack |
| [Claude Code](https://github.com/anthropics/claude-code) | ~148k | TypeScript (issues/docs) | the pattern library: subagents, hooks, plan mode, CLAUDE.md, skills, auto-compact |
| [Codex CLI](https://github.com/openai/codex) | ~127k | Rust | defense-in-depth sandboxing (Seatbelt/Landlock/proxy), `codex exec`, JSONL rollout traces |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | ~107k | TypeScript | free-tier economics, 1M-token window, checkpointing, custom slash commands |
| [OpenHands](https://github.com/OpenHands/OpenHands) | ~89k | TypeScript | event-sourced agent (state = f(event log)), Docker runtime per session, condenser framework |
| [Cline](https://github.com/cline/cline) | ~69k | TypeScript | shadow-git checkpoints, human-in-the-loop approvals, browser tool |
| [Goose](https://github.com/aaif-goose/goose) | ~55k | Rust | MCP-first extensions, lead/worker agent split, declarative recipes |
| [Aider](https://github.com/Aider-AI/aider) | ~49k | Python | repo-map with graph ranking, edit formats with lint-repair loop, git auto-commit, watch mode, /cost |
| [Crush](https://github.com/charmbracelet/crush) | ~28k | Go | multi-session TUI, LSP diagnostics, provider catalog (Catwalk) |
| [Roo Code](https://github.com/RooCodeInc/Roo-Code) | ~24k | TypeScript | modes (architect/code/ask/debug) with per-mode models |
| [SWE-agent](https://github.com/SWE-agent/SWE-agent) | ~20k | Python | Agent-Computer Interface (ACI): tools shaped for LM ergonomics, lint-guarded edits |
| [ZCode (upstream)](https://github.com/zai-org/ZCode) | ~6.9k | TypeScript | hexagonal core, session protocol v4, TUI/Web/Electron |

## Convergent design (what the ecosystem agrees on)

1. **One brain, many frontends** — client/server or protocol split so CLI/bots/UI share a session store (opencode, OpenHands, Codex app-server).
2. **Compaction as a first-class subsystem**, not ad-hoc truncation (OpenHands condenser, Claude auto-compact, Codex rollout traces).
3. **Subagent context isolation** keeps main-loop context lean (Claude Code, Goose lead/worker, OpenHands delegate).
4. **MCP as the extension substrate** (Goose, opencode, Gemini, Codex).
5. **Interface quality is measurable** — Aider's repo-map and SWE-agent's lint-guarded edits both move benchmark scores materially.
6. **Autonomy requires OS-level safety** — sandboxes and allowlists are table stakes once agents can touch real systems (Codex, OpenHands).

## Feature → provenance map (what landed in ZCode Ultra v1.1.0)

| Feature in Ultra | Ported from | Where it lives |
|---|---|---|
| Event-sourced JSONL sessions | DeepSeek harness / OpenHands | `src/core/session.ts` |
| Interceptable loop + parallel tool pool | DeepSeek harness | `src/core/agent.ts` |
| Plan mode, subagents (explore/plan/general), hooks | Claude Code | `src/core/agent.ts`, `src/tools/coord-tools.ts` |
| Block streaming + per-chat queues (bots) | OpenClaw | `src/bots/shared.ts` |
| Approval buttons in Discord, reply-approve in WhatsApp | OpenCode question API / Cline | `src/bots/discord.ts`, `src/bots/whatsapp.ts` |
| Docker sandbox mode | Codex CLI / OpenHands | `src/safety/safety.ts` |
| Secret scrubbing on every tool result | Codex credential brokering (lite) | `src/safety/safety.ts` |
| Repo map in system prompt | Aider | `src/core/context.ts` |
| Compaction preserve-lists | OpenHands condenser | `src/core/compaction.ts` (`compactPreserve`) |
| **Git auto-commit + /undo (agent-attributed)** | Aider | `src/core/git.ts` |
| **Checkpoints before every mutating turn + restore** | Cline / Gemini CLI | `src/core/checkpoints.ts` |
| **Edit lint guard after Write/Edit** | SWE-agent ACI | `src/core/edit-guard.ts` |
| **Custom slash commands from .md files (REPL + bots)** | Gemini CLI / Claude Code | `src/core/custom-commands.ts` |
| **AGENTS.md / rules/*.md context hierarchy** | Claude Code CLAUDE.md / agents.md convention | `src/core/context-files.ts` |
| **Per-model usage ledger + /cost + exec JSON cost** | Aider | `src/core/cost.ts` |
| **Background Bash + TaskOutput/TaskStop** | Claude Code / OpenHands | `src/tools/bg-tools.ts` |
| **Role-based routing (planner/worker/summarizer models)** | Goose lead-worker / Roo modes | `src/core/agent.ts` + `roles` config |
| **Watch mode (`// AI:` triggers)** | Aider | `src/cli/watch.ts` |
| **`resume` / structured session listing** | Codex / Crush | `src/index.ts` |
| Headless exec with JSON output + exit codes | Codex `exec` | `src/cli/exec.ts` |
| Memory (MEMORY.md + keyword recall) | Hermes / Claude memory files | `src/memory/memory.ts` |
| Skills (SKILL.md trigger matching) | Claude Code skills | `src/skills/skills.ts` |
| MCP stdio client (zero-dep) | Anthropic MCP spec | `src/mcp/client.ts` |

Bold rows are the v1.1.0 additions; the rest shipped in v1.0.x.

## What we deliberately did *not* port (and why)

- **Tree-sitter + PageRank repo map (Aider).** The full implementation needs native tree-sitter grammars and a graph library; Ultra ships a zero-dep regex-symbol map that covers ~80% of the navigational value at a fraction of the complexity. Revisit if repo navigation becomes a bottleneck.
- **OS-native sandboxing (Codex Seatbelt/Landlock).** Requires per-OS compiled helpers; Ultra's Docker sandbox covers the same threat model where Docker exists, and permission modes + blocklists cover the rest.
- **LSP diagnostics loop (opencode/Crush).** Valuable but ties the core to language servers; planned as an optional plugin seam.
- **Browser automation tool (Cline/OpenHands).** Needs a bundled Chromium; out of scope for a ~10 MB harness.
- **Client/server split (opencode).** Ultra achieves "one brain, many frontends" with in-process sharing; a `serve` mode remains on the roadmap for web UI.
- **MITM network proxy with domain allowlists (Codex).** Correct design for untrusted-agent fleets; heavy for a single-user harness.

## Reading the ecosystem's direction

Three bets worth watching, in our order of conviction:

1. **Bots are the next primary surface.** Claude Code's hooks + permission events map perfectly onto chat approvals; OpenClaw proved chat-lane queues matter at scale. Ultra is positioned here from day one.
2. **Cost governance becomes a feature.** Per-role models and /cost (Aider, Goose) will become standard once teams run agents continuously.
3. **Checkpoint/undo UX is still immature everywhere.** Cline's shadow git and Aider's /undo both work but differ; a converged standard would help every harness.
