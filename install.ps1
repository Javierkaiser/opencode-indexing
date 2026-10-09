# Installs opencode-indexing into the global OpenCode config directory.
# Thin wrapper: the cross-platform logic lives in install.mjs, so Windows, Linux
# and macOS all run the same code instead of drifting copies.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-SkipDeps] [-NoRestart]
param(
  [switch]$SkipDeps,
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "install.mjs"
$forward = @()
if ($SkipDeps) { $forward += "--skip-deps" }
if ($NoRestart) { $forward += "--no-restart" }

if (Get-Command node -ErrorAction SilentlyContinue) {
  & node $script @forward
  exit $LASTEXITCODE
}

Write-Error "Node.js >= 22.6 is required. Install it from https://nodejs.org and re-run."
exit 1
