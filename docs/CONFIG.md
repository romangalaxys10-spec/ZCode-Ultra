# Configuration Reference

Layered config (later wins):

1. defaults (built-in)
2. `~/.zcode-ultra/config.json` (global)
3. `<workspace>/.zcode-ultra.json` (project)
4. environment: `ZCODE_ULTRA_MODEL`, `ZCODE_ULTRA_PERMISSION_MODE`, `ZCODE_ULTRA_SANDBOX`, provider `*_API_KEY` vars

JSON5-lite is accepted: `//` comments and trailing commas. Writes are atomic (tmp + rename).

## Complete example

```jsonc
{
  // primary model: "provider/model"
  "model": "zai/glm-4.6",
  // tried in order on retryable failures (429/5xx/network)
  "fallbackModels": ["deepseek/deepseek-chat", "openai/gpt-4.1"],
  "maxOutputTokens": 8192,
  "permissionMode": "default",        // default | plan | acceptEdits | yolo
  "maxTurns": 60,                     // runaway protection per run
  "parallelTools": true,              // parallel tool execution (bounded pool)

  // command rules (prefix match, "*" = wildcard)
  "allowedCommands": ["ls", "cat", "grep", "git status", "npm test"],
  "blockedCommands": ["sudo", "rm -rf /", "curl * | bash"],

  // run Bash inside Docker
  "sandbox": "off",                   // off | docker
  "sandboxImage": "node:22-slim",

  // extra roots file tools may touch (workspace is always allowed)
  "extraAllowedPaths": ["~/shared-lib"],

  // override or add providers (OpenAI-compatible unless protocol: anthropic)
  "providers": {
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY",
      "model": "anthropic/claude-sonnet-4.5"
    },
    "zai": { "baseUrl": "https://api.z.ai/api/paas/v4", "apiKeyEnv": "ZAI_API_KEY", "model": "glm-4.6" }
  },

  // MCP stdio servers
  "mcpServers": {
    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_TOKEN": "ghp_..." } }
  },

  // interceptable loop hooks (DeepSeek-waterfall style; exit code 2 blocks)
  "hooks": [
    { "event": "beforeTool", "match": "^Bash$", "run": "deny-aws-cli.sh" },
    { "event": "afterTool", "match": "^Write$|^Edit$", "run": "echo 'file changed'" }
  ],

  "memoryEnabled": true,
  "autoCompact": true,
  "compactThreshold": 90000,          // estimated tokens
  "compactKeepRecent": 12,            // recent messages kept verbatim

  "discord": { "enabled": false, "tokenEnv": "ZCODE_ULTRA_DISCORD_TOKEN" },
  "whatsapp": {
    "enabled": false,
    "mode": "off",                    // baileys | cloud | off
    "triggerPrefix": "!z ",
    "cloud": { "tokenEnv": "ZCODE_ULTRA_WA_TOKEN", "phoneNumberId": "", "verifyToken": "", "port": 8788 }
  },
  "botGuard": {
    "discordAllowUsers": [],          // empty => first user becomes owner
    "whatsappAllowNumbers": [],       // empty => open mode
    "requireMentionInGuilds": true
  },

  // ── v1.1 additions ──────────────────────────────────────────────

  // role-based model routing (Goose lead/worker pattern; empty = use "model")
  "roles": {
    "planner": "openai/gpt-4.1",          // used while plan mode is active
    "worker": "deepseek/deepseek-chat",   // used by Task-tool subagents
    "summarizer": "deepseek/deepseek-chat" // used for compaction summaries
  },

  // Aider-style git integration
  "git": {
    "autoCommit": false,             // commit the files an agent turn touched
    "commitPrefix": "zcu"            // /undo only ever reverts "zcu:*" commits
  },

  "checkpoints": true,                 // snapshot before each mutating turn (/checkpoint restore)
  "editGuard": true,                   // syntax-check files after Write/Edit (SWE-agent ACI)
  "contextFiles": true,                // load AGENTS.md / rules/*.md into the prompt

  // OpenHands condenser preserve-list: tool results matching these regexes
  // are kept verbatim during compaction
  "compactPreserve": ["schema", "file_path", "Exit code: 0"],

  // Aider-style watch mode
  "watch": {
    "triggers": ["AI:", "AI?", "ai:"],  // "// AI: do X" lines invoke the agent
    "pollMs": 400
  }
}
```

## CLI commands

```
zcode-ultra                     interactive REPL
zcode-ultra exec "..."          headless one-shot (exit 0 ok / 1 error / 2 max-turns)
zcode-ultra watch               watch mode: "// AI:" comments invoke the agent
zcode-ultra resume [id]         resume the latest (or given) session
zcode-ultra undo                git-revert the last agent commit
zcode-ultra bot discord         Discord bot
zcode-ultra bot whatsapp        WhatsApp bot (add --cloud for the official API)
zcode-ultra setup               guided wizard
zcode-ultra doctor              environment checks
zcode-ultra config list|get|set manage global config
zcode-ultra sessions [id]       list / inspect JSONL sessions (with cost lines)
zcode-ultra memory "note"       append a memory note
```

Key REPL commands: `/model` `/mode` `/plan` `/compact` `/tokens` `/cost` `/undo` `/checkpoint [list|restore <id>]` `/sessions` `/resume` `/tools` `/help` — plus any custom command defined in `.zcode-ultra/commands/*.md`.

## v1.1 feature notes

- **Git auto-commit**: with `git.autoCommit`, each turn that modified files produces one commit `zcu: <prompt excerpt>` listing the files. `undo`/`/undo` performs `git reset --hard HEAD~1` only when HEAD is an agent commit and the tree is clean — human work is never undone.
- **Checkpoints**: the first file mutation of a turn snapshots the workspace (text files ≤ 2 MB, ignores `node_modules`/`.git`/etc.) into `~/.zcode-ultra/checkpoints/<ws-hash>/`, deduplicated by sha256 and pruned to 30. `/checkpoint restore <id>` rewrites files to the snapshot; files created after the snapshot are removed with your confirmation by default.
- **Edit guard**: `.js/.mjs/.cjs` → `node --check`; `.py` → `ast.parse`; `.json` → `JSON.parse`; `.ts/.tsx/.jsx` → a strings/comments-aware delimiter scanner. A failure returns a tool error with the diagnostic, so the model fixes it immediately.
- **Cost table**: per-provider `cost: { in, out }` (USD per 1M tokens) drives `/cost` estimates; local providers default to $0.
- **Background tasks**: `Bash(run_in_background=true)` returns a task id; `TaskOutput` polls, `TaskStop` kills; all tasks die with the process.

## Safety model

- **Modes**: `plan` (read-only) → `default` (approve writes/commands) → `acceptEdits` → `yolo`.
- **Exec approvals** bind to the exact command + cwd; blockedCommands always wins.
- **Path allowlist**: file tools cannot escape the workspace (+ `extraAllowedPaths`).
- **Secret scrubbing**: ghp_/sk-/AKIA/JWT/etc. patterns redacted on every tool result and bot message.
- **Sandbox**: `"sandbox": "docker"` runs every Bash call in a throwaway container (mounts workspace, 2 GB RAM / 2 CPU caps, HOME=tmp).
- **Hooks** can veto any tool call (exit code 2).

## Session & state layout

```
~/.zcode-ultra/
├── config.json          global config
├── MEMORY.md            agent memory (one bullet per fact)
├── commands/            global custom slash commands (*.md)
├── skills/              SKILL.md files (auto-loaded by trigger match)
├── checkpoints/<ws>/    content-addressed pre-edit snapshots (sha256 blobs)
└── sessions/<id>.jsonl  event-sourced session log (resume/replay)
```

Workspace-level (project):

```
<workspace>/
├── AGENTS.md            project rules (CLAUDE.md / GEMINI.md also honored)
├── .zcode-ultra.json    project config overrides
└── .zcode-ultra/
    ├── rules/*.md       fine-grained rule modules
    ├── commands/*.md    project custom slash commands
    ├── skills/          project skills
    └── bot-sessions.json chat -> session bindings
```

