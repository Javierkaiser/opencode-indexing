# Installs opencode-indexing into the global OpenCode config directory.
# Thin wrapper: the cross-platform logic lives in install.mjs, so Windows, Linux
# and macOS all run the same code instead of drifting copies.
#
# The preferred form from npm is:
#   npx @javierkaiser/opencode-indexing --with-codegraph
# This wrapper forwards to the same install.mjs, so it accepts the same flags.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Local|-Package] [-Spec <spec>] [-SkipDeps] [-NoRestart] [-WithCodegraph]
param(
  [switch]$Local,
  [switch]$Package,
  [string]$Spec,
  [switch]$SkipDeps,
  [switch]$NoRestart,
  [switch]$WithCodegraph
)

$ErrorActionPreference = "Stop"
$script = Join-Path $PSScriptRoot "install.mjs"
$forward = @()
if ($Local) { $forward += "--local" }
if ($Package) { $forward += "--package" }
if ($Spec) { $forward += $Spec }
if ($SkipDeps) { $forward += "--skip-deps" }
if ($NoRestart) { $forward += "--no-restart" }
if ($WithCodegraph) { $forward += "--with-codegraph" }

if (Get-Command node -ErrorAction SilentlyContinue) {
  & node $script @forward
  exit $LASTEXITCODE
}

Write-Error "Node.js >= 22.6 is required. Install it from https://nodejs.org and re-run."
exit 1
