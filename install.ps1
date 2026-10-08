# Installs opencode-indexing into the global OpenCode config directory.
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1 [-SkipDeps] [-NoRestart]
param(
  [switch]$SkipDeps,
  [switch]$NoRestart
)

$ErrorActionPreference = "Stop"
$source = $PSScriptRoot
$dest = Join-Path $env:USERPROFILE ".config\opencode\plugins\opencode-indexing"
$configDir = Join-Path $env:USERPROFILE ".config\opencode"
$configFile = Join-Path $configDir "opencode.json"

Write-Host "Installing opencode-indexing"
Write-Host "  from: $source"
Write-Host "  to:   $dest"

# 1. Copy plugin files (exclude dev artifacts).
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$exclude = @("node_modules", "test", ".git", ".gitignore", "install.ps1")
Get-ChildItem -Path $source -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
  Copy-Item -Path $_.FullName -Destination $dest -Recurse -Force
}

# 2. Install runtime deps (only `ignore`; used for .gitignore fidelity, optional).
if (-not $SkipDeps) {
  $pkg = Join-Path $dest "package.json"
  $json = Get-Content $pkg -Raw | ConvertFrom-Json
  # Keep only runtime deps to minimize the install.
  $minimal = [ordered]@{
    name    = $json.name
    version = $json.version
    type    = "module"
    exports = @{
      "."      = "./index.ts"
      "./rpc"  = "./src/rpc.ts"
      "./tui"  = "./tui.ts"
    }
    dependencies = @{ ignore = ">=7.0.0" }
    optionalDependencies = @{
      "@lancedb/lancedb" = "0.26.2"
      "web-tree-sitter"  = "0.25.10"
      "tree-sitter-wasms" = "0.1.13"
    }
  }
  $minimal | ConvertTo-Json -Depth 8 | Set-Content -Path $pkg -Encoding UTF8

  Write-Host "  installing runtime deps (ignore + optional lancedb/tree-sitter)..."
  Push-Location $dest
  try {
    npm install --omit=dev --no-audit --no-fund --loglevel=error
  } finally {
    Pop-Location
  }
}

# 3. Permissions: allow the tools without prompting (merge, preserve existing config).
try {
  if (Test-Path $configFile) {
    $raw = Get-Content $configFile -Raw
    $cfg = $raw | ConvertFrom-Json
  } else {
    $cfg = [pscustomobject]@{}
  }
  if (-not $cfg.PSObject.Properties["permission"]) {
    $cfg | Add-Member -NotePropertyName permission -NotePropertyValue ([pscustomobject]@{})
  }
  $perm = $cfg.permission
  foreach ($tool in @("indexing_search", "indexing_status", "indexing_refresh", "indexing_build")) {
    if ($perm.PSObject.Properties[$tool]) {
      $perm.$tool = "allow"
    } else {
      $perm | Add-Member -NotePropertyName $tool -NotePropertyValue "allow"
    }
  }
  $cfg | ConvertTo-Json -Depth 20 | Set-Content -Path $configFile -Encoding UTF8
  Write-Host "  permissions added to $configFile"
} catch {
  Write-Warning "Could not update $configFile : $_"
}

# 4. Restart the OpenCode service so the plugin loads.
if (-not $NoRestart) {
  Write-Host "  restarting OpenCode service..."
  try {
    & opencode service restart 2>&1 | Write-Host
  } catch {
    Write-Warning "Could not restart automatically. Run: opencode service restart"
  }
}

Write-Host "Done. Verify with: opencode api get /api/info"
Write-Host "Then run in a session: indexing_status"
