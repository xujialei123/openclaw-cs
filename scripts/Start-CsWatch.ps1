#Requires -Version 5.1
param(
  [switch]$Once,
  [switch]$SkipOpenSites,
  [string]$Config = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Root = Split-Path -Parent $Root

$EdgeEnv = Join-Path $Root ".env"
if (Test-Path $EdgeEnv) {
  Get-Content $EdgeEnv -Encoding UTF8 | ForEach-Object {
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

$Cfg = if ($Config) { $Config } elseif ($env:CS_RUNTIME_CONFIG) { $env:CS_RUNTIME_CONFIG } else { Join-Path $Root "config\cs-runtime.json" }

Write-Host "Starting cs-watch..."
Write-Host "config=$Cfg once=$Once SkipOpenSites=$SkipOpenSites"

# 检查中台是否可达
$ragBase = "http://127.0.0.1:8787"
if ($env:RAG_BASE_URL) { $ragBase = $env:RAG_BASE_URL }
try {
  $health = Invoke-RestMethod -Uri "$ragBase/health" -TimeoutSec 3
  Write-Host "RAG OK: $ragBase/health"
} catch {
  Write-Warning "RAG not reachable at $ragBase/health - will use local fallback"
}

$args = @()
if ($Once) { $args += "-Once" }
if ($SkipOpenSites) { $args += "-SkipOpenSites" }
if ($Cfg) { $args += "-Config"; $args += $Cfg }

& "F:\openclawProject\apps\edge-worker\cs-watch.js" @args
