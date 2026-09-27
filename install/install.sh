#!/usr/bin/env bash
# ============================================================================
# ZCode Ultra installer — macOS & Linux
# Usage: curl -fsSL https://raw.githubusercontent.com/romangalaxys10-spec/ZCode-Ultra/main/install/install.sh | bash
# Or:    bash install.sh [--version v1.0.0] [--bin-dir ~/.local/bin]
# ============================================================================
set -euo pipefail

REPO="romangalaxys10-spec/ZCode-Ultra"
VERSION="${ZCODE_ULTRA_VERSION:-latest}"
BIN_DIR="${ZCODE_ULTRA_BIN_DIR:-$HOME/.local/bin}"

# ---- flags -----------------------------------------------------------------
while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

say()  { printf '\033[36m[zcode-ultra]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# ---- detect platform -------------------------------------------------------
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH="x64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) err "Unsupported architecture: $ARCH" ;;
esac
case "$OS" in
  linux|darwin) ;;
  *) err "Unsupported OS: $OS (use install.ps1 on Windows)" ;;
esac

say "Installing ZCode Ultra for $OS/$ARCH"

# ---- strategy 1: standalone binary from GitHub Releases (fastest) ----------
download_binary() {
  local tag="latest"
  [[ "$VERSION" != "latest" ]] && tag="$VERSION"
  local url_base="https://github.com/$REPO/releases/$tag"
  say "Trying standalone binary from GitHub Releases…"
  local asset="zcode-ultra-$OS-$ARCH"
  local url="https://github.com/$REPO/releases/download/$tag/$asset"
  command -v curl >/dev/null 2>&1 || return 1
  mkdir -p "$BIN_DIR"
  if curl -fSL --progress-bar -o "$BIN_DIR/zcode-ultra.tmp" "$url" 2>/dev/null; then
    chmod +x "$BIN_DIR/zcode-ultra.tmp"
    mv "$BIN_DIR/zcode-ultra.tmp" "$BIN_DIR/zcode-ultra"
    return 0
  fi
  return 1
}

# ---- strategy 2: npm global package ----------------------------------------
install_via_npm() {
  say "Falling back to npm install…"
  if ! command -v node >/dev/null 2>&1; then
    say "Node.js not found — installing Node.js 22…"
    if command -v brew >/dev/null 2>&1 && [[ "$OS" == "darwin" ]]; then
      brew install node@22
    elif command -v apt-get >/dev/null 2>&1; then
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v dnf >/dev/null 2>&1; then
      sudo dnf install -y nodejs npm
    elif command -v pacman >/dev/null 2>&1; then
      sudo pacman -S --noconfirm nodejs npm
    elif command -v apk >/dev/null 2>&1; then
      sudo apk add --no-cache nodejs npm
    else
      err "No supported package manager found. Install Node.js 20+ manually: https://nodejs.org"
    fi
  fi
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
  [[ "$NODE_MAJOR" -ge 20 ]] || err "Node.js >= 20 required (found $(node --version))"
  npm install -g zcode-ultra
}

if ! download_binary; then
  say "No prebuilt binary for this platform — using npm."
  install_via_npm
fi

# ---- PATH hint --------------------------------------------------------------
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    say "Note: $BIN_DIR is not in your PATH."
    SHELL_RC="$HOME/.bashrc"
    [[ "$(basename "${SHELL:-bash}")" == "zsh" ]] && SHELL_RC="$HOME/.zshrc"
    echo "export PATH=\"$BIN_DIR:\$PATH\"" >> "$SHELL_RC"
    say "Added to $SHELL_RC — restart your shell or run: source $SHELL_RC"
    ;;
esac

say "Done! Start with:"
say "  zcode-ultra setup     # configure providers (Z.ai / DeepSeek / OpenAI / Anthropic / Ollama)"
say "  zcode-ultra doctor    # verify environment"
say "  zcode-ultra           # start the interactive agent"
