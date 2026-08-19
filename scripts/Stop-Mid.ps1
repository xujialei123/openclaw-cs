#Requires -Version 5.1
<#
.SYNOPSIS
  Stop mid-platform only: rag-service + kb-admin.
  Does not stop cs-watch / OpenClaw.
#>

$ErrorActionPreference = "Continue"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "=== Stop Mid-Platform ==="
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
}

Write-Host "[1] rag-service"
Stop-ByCommandLine "*rag-service*dist*main.js*" "rag-service"
Stop-ByCommandLine "*services\rag-service\dist*main.js*" "rag-service"
Stop-ByCommandLine "*services/rag-service/dist/main.js*" "rag-service"

Write-Host "[2] kb-admin / console"
Stop-ByCommandLine "*kb-admin-server.js*" "kb-admin"
Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.CommandLine -and
    ($_.CommandLine -like "*next*dev*" -or $_.CommandLine -like "*next*start*") -and
    $_.CommandLine -like "*18790*"
  } |
  ForEach-Object {
    try {
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Host ("  stop next pid={0}" -f $_.ProcessId)
    } catch {}
  }

Write-Host ""
Write-Host "Done. Edge (cs-watch / OpenClaw) was not stopped."