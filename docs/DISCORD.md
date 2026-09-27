# Discord Bot Setup

The Discord bot runs the same agent brain as the CLI — full tool access against your workspace, with approvals surfaced as buttons.

## 1. Create the Discord application (2 minutes)

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. **Bot** tab → *Reset Token* → copy the token.
3. Bot tab → enable **Message Content Intent** (needed for plain messages).
4. **OAuth2 → URL Generator**: check `bot` + `applications.commands`; permissions: *Send Messages*, *Read Message History*, *Attach Files*. Open the generated URL to invite the bot to your server.

## 2. Configure

```bash
export ZCODE_ULTRA_DISCORD_TOKEN="your-bot-token"
```

`~/.zcode-ultra/config.json`:

```jsonc
{
  "discord": { "enabled": true, "tokenEnv": "ZCODE_ULTRA_DISCORD_TOKEN" },
  "botGuard": {
    // STRONGLY recommended: restrict who can use the bot.
    // If empty, the FIRST user to invoke /zcode becomes the owner.
    "discordAllowUsers": ["123456789012345678"],
    "requireMentionInGuilds": true
  },
  // what the agent may do when triggered from Discord:
  "permissionMode": "default"   // "default" => writes ask via buttons
}
```

## 3. Run

```bash
cd /path/to/your/project
zcode-ultra bot discord
```

## 4. Use

| Command | Effect |
|---|---|
| `/zcode prompt:"add dark mode to the settings page"` | Full agent run against the CWD |
| `/zcode prompt:"analyze the DB schema" plan:true` | Plan-only (no writes) |
| Mention the bot in a message (`@ZCode Ultra refactor auth`) | Full run (if `requireMentionInGuilds`) |
| DM the bot | Always responds |

Behavior details:

- **Block streaming** — the bot edits its message with each completed block (~1.5 s cadence), never token-by-token (rate-limit friendly). Final answer is delivered in ≤2000-char chunks.
- **Approvals** — when a risky tool fires in `default` mode, an embed with **Approve / Deny** buttons appears; allowlisted users can click. Timeout = deny (120 s).
- **Sessions** — one agent session per channel, persisted; the bot keeps context between messages. Rate limits and max-turns from the shared config apply.
- **Safety** — command blocklists, path allowlists and secret scrubbing apply exactly as in the terminal. In `default` mode (recommended for servers), writes and non-allowlisted commands require a button click.

## Hardening checklist

- [ ] Set `discordAllowUsers` to real user IDs (right-click → Copy ID with developer mode).
- [ ] Keep `permissionMode: "default"` (or run the agent with `--sandbox` for Docker-isolated Bash).
- [ ] Run the bot under a dedicated OS user with a workspace-scoped directory.
- [ ] Never commit tokens; use the env var.
