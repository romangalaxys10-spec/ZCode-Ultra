# ============================================================================
# ZCode Ultra installer — Windows
# Usage (PowerShell):
#   irm https://raw.githubusercontent.com/romangalaxys10-spec/ZCode-Ultra/main/install/install.ps1 | iex
# Or: .\install.ps1 [-Version v1.0.0] [-Scope User]
# ============================================================================
param(
  [string]$Version = "latest",
  [ValidateSet("User", "Machine")]
  [string]$Scope = "User"
)

$ErrorActionPreference = "Stop"
$Repo = "romangalaxys10-spec/ZCode-Ultra"

function Say($msg) { Write-Host "[zcode-ultra] $msg" -ForegroundColor Cyan }
function Err($msg) { Write-Host "[error] $msg" -ForegroundColor Red; exit 1 }

$arch = if ([Environment]::Is64BitOperatingSystem) { "x64" } else { Err "Only 64-bit Windows is supported" }

Say "Installing ZCode Ultra for windows/$arch (scope: $Scope)"

# --- strategy 1: standalone binary from GitHub Releases ----------------------
$binDir = if ($Scope -eq "User") { Join-Path $env:LOCALAPPDATA "ZCodeUltra\bin" } else { Join-Path $env:ProgramFiles "ZCodeUltra\bin" }
$tag = if ($Version -eq "latest") { "latest" } else { $Version }
$asset = "zcode-ultra-windows-$arch.exe"
$url = "https://github.com/$Repo/releases/download/$tag/$asset"
$tmp = Join-Path $env:TEMP $asset

$installed = $false
try {
  Say "Downloading standalone binary from GitHub Releases…"
  Invoke-WebRequest -Uri $url -OutFile $tmp -UseBasicParsing -ErrorAction Stop
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $dest = Join-Path $binDir "zcode-ultra.exe"
  Move-Item -Force $tmp $dest
  $installed = $true
  Say "Binary installed: $dest"
} catch {
  Say "Binary download unavailable — falling back to npm."
}

# --- strategy 2: npm ----------------------------------------------------------
if (-not $installed) {
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Say "Node.js not found — installing via winget…"
    if (Get-Command winget -ErrorAction SilentlyContinue) {
      winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    } elseif (Get-Command choco -ErrorAction SilentlyContinue) {
      choco install nodejs-lts -y
    } elseif (Get-Command scoop -ErrorAction SilentlyContinue) {
      scoop install nodejs-lts
    } else {
      Err "No package manager found. Install Node.js 20+ from https://nodejs.org"
    }
    # refresh PATH
    $env:PATH = [System.Environment]::GetEnvironmentVariable("PATH", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH", "User")
  }
  $nodeMajor = [int](node -p "process.versions.node.split('.')[0]")
  if ($nodeMajor -lt 20) { Err "Node.js >= 20 required (found $(node --version))" }
  npm install -g zcode-ultra
  $installed = $true
}

# --- PATH ---------------------------------------------------------------------
if ($binDir) {
  $userPath = [System.Environment]::GetEnvironmentVariable("PATH", $Scope)
  if ($userPath -notlike "*$binDir*") {
    [System.Environment]::SetEnvironmentVariable("PATH", "$userPath;$binDir", $Scope)
    Say "Added $binDir to PATH"
  }
}

Say "Done! Start with:"
Say "  zcode-ultra setup     # configure providers"
Say "  zcode-ultra doctor    # verify environment"
Say "  zcode-ultra           # start the interactive agent"
Say "(restart your terminal to refresh PATH)"
