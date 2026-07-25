#Requires -Version 5.1
param(
  [switch]$StopDocker,
  [switch]$StopBrowser,
  [switch]$KeepRag
)

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

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

Import-DotEnv (Join-Path $Root ".env")

Write-Host "=== OpenClaw CS Stop-All ==="
Write-Host "Root: $Root"
Write-Host ""

function Stop-ByCommandLine([string]$Pattern, [string]$Label) {
  $procs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like $Pattern) }
  $n = 0
  foreach ($p in @($procs)) {
    try {
      Write-Host ("  stop {0} pid={1}" -f $Label, $p.ProcessId)
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      $n++
    } catch {}
  }
  if ($n -eq 0) { Write-Host ("  {0}: (not running)" -f $Label) }
  return $n
}

Write-Host "[1] cs-watch"
[void](Stop-ByCommandLine "*cs-watch.js*" "cs-watch")
$lock = Join-Path $Root "memory\cs-watch.lock"
if (Test-Path $lock) {
  Remove-Item $lock -Force -ErrorAction SilentlyContinue
  Write-Host "  removed memory\cs-watch.lock"
}

Write-Host "[2] console / kb-admin"
[void](Stop-ByCommandLine "*kb-admin-server.js*" "kb-admin")
[void](Stop-ByCommandLine "*next*18790*" "next-console")
[void](Stop-ByCommandLine "*apps\\console*" "console")
# next often appears as node .../next/dist/bin/next
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and ($_.CommandLine -like "*next*dev*" -or $_.CommandLine -like "*next*start*") -and $_.CommandLine -like "*18790*" } |
  ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Write-Host ("  stop next pid={0}" -f $_.ProcessId) } catch {} }

if (-not $KeepRag) {
  Write-Host "[3] rag-service"
  [void](Stop-ByCommandLine "*rag-service*dist*main.js*" "rag-service")
  [void](Stop-ByCommandLine "*services\rag-service\dist\main.js*" "rag-service")
  [void](Stop-ByCommandLine "*services/rag-service/dist/main.js*" "rag-service")
} else {
  Write-Host "[3] rag-service: kept (-KeepRag)"
}

if ($StopDocker) {
  Write-Host "[4] Docker containers"
  $docker = Get-Command docker -ErrorAction SilentlyContinue
  if ($docker) {
    foreach ($name in @("customer-ai-postgres", "customer-ai-redis")) {
      $old = $ErrorActionPreference
      $ErrorActionPreference = "SilentlyContinue"
      & docker stop $name 2>&1 | Out-Null
      $ErrorActionPreference = $old
      Write-Host "  docker stop $name"
    }
  } else {
    Write-Warning "  docker not found; skip"
  }
} else {
  Write-Host "[4] Docker: kept (use -StopDocker to stop postgres/redis)"
}

Write-Host "[5] OpenClaw gateway (best-effort)"
[void](Stop-ByCommandLine "*openclaw.mjs*gateway*" "openclaw-gateway")
[void](Stop-ByCommandLine "*Start-OpenClaw.ps1*" "Start-OpenClaw")

if ($StopBrowser) {
  Write-Host "[6] OpenClaw browser (best-effort)"
  [void](Stop-ByCommandLine "*openclaw.mjs*browser*" "openclaw-browser")
  Write-Warning "  Browser may still be open; close the orange window manually if needed."
} else {
  Write-Host "[6] OpenClaw browser: kept (use -StopBrowser to try closing)"
}

Write-Host ""
Write-Host "Done. Start again with Start-All.bat"
