# WhatsApp Bot Setup

Two adapters, one brain. Pick per your risk/effort appetite:

| | Baileys (`mode: "baileys"`) | Cloud API (`mode: "cloud"`) |
|---|---|---|
| Official | ❌ unofficial web protocol | ✅ Meta official |
| Cost | free | Meta conversation pricing |
| Needs | scan a QR with your own number | Meta business app + webhook server |
| Risk | account throttling/ban possible | compliant |
| Latency | instant | webhook round-trip |

## Option A — Baileys (QR pairing)

1. Install the optional dependency next to the CLI (it is *not* bundled):

   ```bash
   npm i -g @whiskeysockets/baileys qrcode-terminal
   ```

2. Enable in `~/.zcode-ultra/config.json`:

   ```jsonc
   {
     "whatsapp": { "enabled": true, "mode": "baileys", "triggerPrefix": "!z " },
     "botGuard": {
       // STRONGLY recommended — allowlist numbers in E.164 digits (no +):
       "whatsappAllowNumbers": ["15551234567", "4917012345678"]
     },
     "permissionMode": "default"   // no interactive buttons on WhatsApp: default mode denies writes
   }
   ```

3. Run and scan:

   ```bash
   cd /path/to/your/project
   zcode-ultra bot whatsapp
   # → QR appears in the terminal
   # WhatsApp → Settings → Linked devices → Link a device → scan
   ```

4. Chat: DM the bot number directly, or in groups start messages with `!z `. e.g. `!z list the TODOs in this repo and summarize`.

- Auth state persists in `.zcode-ultra/wa-auth/` — delete it to re-pair.
- Long answers are delivered in ≤3000-char chunks; a typing indicator shows while working.
- ⚠️ Because there are no interactive buttons, in `default` mode the bot cannot perform write actions from WhatsApp (by design). Use `acceptEdits`/`yolo` **with `--sandbox`** if you want autonomous writes.

## Option B — Cloud API (official)

1. [Meta for Developers](https://developers.facebook.com/) → create an App → add **WhatsApp** product. Note the **Phone number ID** and generate an access token.
2. Configure:

   ```jsonc
   {
     "whatsapp": {
       "enabled": true,
       "mode": "cloud",
       "triggerPrefix": "!z ",
       "cloud": {
         "tokenEnv": "ZCODE_ULTRA_WA_TOKEN",
         "phoneNumberId": "1234567890",
         "verifyToken": "pick-a-random-string",
         "port": 8788
       }
     },
     "botGuard": { "whatsappAllowNumbers": ["15551234567"] }
   }
   ```

3. `export ZCODE_ULTRA_WA_TOKEN="..."` then `zcode-ultra bot whatsapp --cloud`.
4. In Meta App Dashboard → WhatsApp → Configuration → Webhook: point to `https://your-host:8788/webhook` with your verify token. Subscribe to the `messages` field.

Notes:
- For production, put the webhook behind HTTPS (caddy/nginx) — Meta requires TLS.
- Set `META_APP_SECRET` to enable HMAC signature verification posture (defense in depth).
- Message routing is identical to Baileys (DMs trigger, groups need prefix).

## Shared guardrails

- Allowlist enforcement on every message; empty allowlist = open mode (logged as a warning at startup).
- Secret scrubbing on all outbound text.
- Per-chat FIFO queue, 500 ms debounce, serialized agent runs — no parallel runs per chat.
- `!z new` semantics: sessions persist per chat in `<workspace>/.zcode-ultra/bot-sessions.json`; clear the file to reset context.
