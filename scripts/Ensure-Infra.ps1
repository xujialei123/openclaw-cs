#Requires -Version 5.1
<#
.SYNOPSIS
  Apply RAG schema to DATABASE_URL (Supabase / any Postgres). No Docker.
#>
param(
  [string]$BrainRoot = ""
)

$ErrorActionPreference = "Stop"
$EdgeRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Import-DotEnv([string]$EnvFile) {
  if (-not (Test-Path $EnvFile)) { return }
  Get-Content $EnvFile -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { return }
    $k = $line.Substring(0, $eq).Trim()
    $v = $line.Substring($eq + 1).Trim()
    if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
      $v = $v.Substring(1, $v.Length - 2)
    }
    [Environment]::SetEnvironmentVariable($k, $v, "Process")
  }
}

Import-DotEnv (Join-Path $EdgeRoot ".env")
if (-not $BrainRoot) {
  if ($env:BRAIN_ROOT) { $BrainRoot = $env:BRAIN_ROOT }
  else { $BrainRoot = Join-Path $EdgeRoot "brain" }
}
Import-DotEnv (Join-Path $BrainRoot ".env")

if (-not $env:DATABASE_URL) {
  throw "DATABASE_URL is empty. Set Supabase URI in brain\.env then run npm run db:init"
}

$InitRemote = Join-Path $EdgeRoot "scripts\init-remote-db.js"
if (-not (Test-Path $InitRemote)) { throw "missing $InitRemote" }

$nodeExe = $null
if ($env:OPENCLAW_PORTABLE_ROOT) {
  $candidate = Join-Path $env:OPENCLAW_PORTABLE_ROOT "app\runtime\node-win-x64\node.exe"
  if (Test-Path $candidate) { $nodeExe = $candidate }
}
if (-not $nodeExe) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $nodeExe = $cmd.Source }
}
if (-not $nodeExe) { throw "Node not found; cannot apply schema." }

Write-Host "=== Infra (schema only, no Docker) ==="
& $nodeExe $InitRemote
if ($LASTEXITCODE -ne 0) { throw "schema init failed" }
Write-Host "=== Infra ready ==="
