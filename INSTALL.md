# Installing ZCode Ultra

Requirements: **Node.js ≥ 20.10** (standalone binaries need none), any of macOS 13+, Windows 10+, Ubuntu 20.04+/Debian 11+/Fedora 38+/Arch.

## 1. npm (recommended, all platforms)

```bash
npm install -g zcode-ultra
zcode-ultra version
```

Bin names: `zcode-ultra` and the short alias `zu`.

## 2. One-line scripts

**macOS / Linux:**

```bash
curl -fsSL https://raw.githubusercontent.com/romangalaxys10-spec/ZCode-Ultra/main/install/install.sh | bash
```

The script: downloads the standalone binary from Releases when available for your platform, otherwise installs Node.js 22 (via brew / NodeSource / dnf / pacman / apk) and runs `npm i -g`. Adds `~/.local/bin` to PATH via your shell rc.

Flags: `--version v1.0.0`, `--bin-dir ~/.local/bin`.

**Windows (PowerShell):**

```powershell
irm https://raw.githubusercontent.com/romangalaxys10-spec/ZCode-Ultra/main/install/install.ps1 | iex
```

Installs the standalone binary (falls back to winget/choco/scoop → Node → npm). Adds to your user PATH.

## 3. Standalone binaries (no Node.js needed)

From [Releases](https://github.com/romangalaxys10-spec/ZCode-Ultra/releases):

| File | Platform |
|---|---|
| `zcode-ultra-darwin-arm64` | Apple Silicon |
| `zcode-ultra-darwin-x64` | Intel Mac |
| `zcode-ultra-linux-x64` | Linux amd64 |
| `zcode-ultra-linux-arm64` | Linux arm64 (RPi, Graviton) |
| `zcode-ultra-windows-x64.exe` | Windows x64 |

```bash
curl -fLO https://github.com/romangalaxys10-spec/ZCode-Ultra/releases/latest/download/zcode-ultra-linux-x64
chmod +x zcode-ultra-linux-x64 && sudo mv zcode-ultra-linux-x64 /usr/local/bin/zcode-ultra
```

## 4. Native packages (Linux)

`.deb` and `.rpm` are attached to Releases (built with nfpm):

```bash
# Debian / Ubuntu
sudo dpkg -i zcode-ultra_1.0.0_amd64.deb   # depends on nodejs >= 20

# Fedora / RHEL
sudo rpm -i zcode-ultra-1.0.0.x86_64.rpm
```

## 5. Homebrew (macOS / Linux)

```bash
brew tap romangalaxys10-spec/tap
brew install zcode-ultra
```

## 6. winget / scoop (Windows)

```powershell
# winget (after the manifest PR is merged to microsoft/winget-pkgs)
winget install ZCodeUltra.ZCodeUltra

# scoop — add the bucket from install/scoop/
scoop bucket add zcu https://github.com/romangalaxys10-spec/scoop-zcode-ultra
scoop install zcode-ultra
```

## Post-install

```bash
zcode-ultra setup     # guided provider + bot configuration
zcode-ultra doctor    # environment checks
zcode-ultra           # start the agent
```

### Provider keys

| Provider | Env var | Default model |
|---|---|---|
| Z.ai (GLM) | `ZAI_API_KEY` | `zai/glm-4.6` |
| Zhipu (CN) | `ZHIPU_API_KEY` | `zhipu/glm-4.6` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek/deepseek-chat` |
| OpenAI | `OPENAI_API_KEY` | `openai/gpt-4.1` |
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic/claude-sonnet-4-5` |
| Moonshot | `MOONSHOT_API_KEY` | `moonshot/kimi-k2-0905-preview` |
| Qwen | `QWEN_API_KEY` | `qwen/qwen3-coder-plus` |
| Ollama / LM Studio / vLLM | none (localhost) | see config |

## Uninstall

```bash
npm uninstall -g zcode-ultra       # npm
rm -rf ~/.zcode-ultra              # state (sessions, memory, config)
```

## Troubleshooting

- **`zcode-ultra: command not found`** — run `command -v zcode-ultra`; if the npm global bin dir is missing from PATH: `npm config get prefix` and add `<prefix>/bin` (or `<prefix>` on Windows) to PATH.
- **401 from provider** — the env var name must match `config.providers.<id>.apiKeyEnv` (see `zcode-ultra config list`).
- **Windows script execution blocked** — run `Set-ExecutionPolicy -Scope Process Bypass` first.
- **Behind a proxy** — `export HTTPS_PROXY=...` (Node fetch respects it via undici EnvHttpProxyAgent in Node 24; on Node 20-22 set `ZCODE_ULTRA_` provider baseUrl to a reachable gateway).
