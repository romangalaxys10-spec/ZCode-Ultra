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
  }
}
```

## CLI commands

```
zcode-ultra                     interactive REPL
zcode-ultra exec "..."          headless one-shot (exit 0 ok / 1 error / 2 max-turns)
zcode-ultra bot discord         Discord bot
zcode-ultra bot whatsapp        WhatsApp bot (add --cloud for the official API)
zcode-ultra setup               guided wizard
zcode-ultra doctor              environment checks
zcode-ultra config list|get|set manage global config
zcode-ultra sessions [id]       list / inspect JSONL sessions
zcode-ultra memory "note"       append a memory note
```

Key REPL commands: `/model` `/mode` `/plan` `/compact` `/tokens` `/sessions` `/resume` `/tools` `/help`.

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
├── skills/              SKILL.md files (auto-loaded by trigger match)
└── sessions/<id>.jsonl  event-sourced session log (resume/replay)
```
