#Requires -Version 5.1
<#
.SYNOPSIS
  Start mid-platform only: apply DATABASE_URL schema + rag-service (+ optional admin).
  Other PCs connect with DEPLOY_ROLE=edge and RAG_BASE_URL=http://<this-LAN-IP>:8787.
.EXAMPLE
  .\scripts\Start-Mid.ps1
  .\scripts\Start-Mid.ps1 -SkipAdmin -NoFirewallHint
#>
param(
  [switch]$SkipAdmin,
  [switch]$SkipDocker,
  [switch]$NoOpenBrowser,
  [switch]$NoFirewallHint,
  [string]$BrainRoot = ""
)

$ErrorActionPreference = "Stop"
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

function Test-UrlOk([string]$Url, [int]$TimeoutSec = 3) {
  try {
    $null = Invoke-RestMethod -Uri $Url -TimeoutSec $TimeoutSec
    return $true
  } catch {
    return $false
  }
}

function Get-LanIPv4 {
  $list = @()
  try {
    Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
      Where-Object {
        $_.IPAddress -notmatch '^127\.' -and
        $_.IPAddress -notmatch '^169\.254\.' -and
        $_.PrefixOrigin -ne "WellKnown"
      } |
      ForEach-Object { $list += $_.IPAddress }
  } catch {}
  if (-not $list.Count) {
    try {
      $cfg = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
        Where-Object { $_.IPv4Address -and $_.NetAdapter.Status -eq "Up" }
      foreach ($c in @($cfg)) {
        $ip = $c.IPv4Address.IPAddress
        if ($ip -and $ip -notmatch '^127\.' -and $ip -notmatch '^169\.254\.') { $list += $ip }
      }
    } catch {}
  }
  $uniq = @($list | Select-Object -Unique)
  # Prefer home/office LAN over WSL/Hyper-V/Docker bridges (172.1x/172.2x)
  $prefer = @($uniq | Where-Object { $_ -match '^(192\.168\.|10\.)' })
  if ($prefer.Count) { return $prefer + @($uniq | Where-Object { $prefer -notcontains $_ }) }
  return $uniq
}

$EdgeEnv = Join-Path $Root ".env"
if (-not (Test-Path $EdgeEnv)) {
  $ex = Join-Path $Root ".env.example"
  if (Test-Path $ex) {
    Copy-Item $ex $EdgeEnv -Force
    Write-Warning "Created .env from .env.example"
  }
}
Import-DotEnv $EdgeEnv

$PortableRoot = if ($env:OPENCLAW_PORTABLE_ROOT) { $env:OPENCLAW_PORTABLE_ROOT } else { "F:\OpenClaw-USB-Portable" }
if (-not $BrainRoot) {
  if ($env:BRAIN_ROOT) { $BrainRoot = $env:BRAIN_ROOT }
  else { $BrainRoot = Join-Path $Root "brain" }
}

$RagDir = Join-Path $BrainRoot "rag-service"
if (-not (Test-Path (Join-Path $RagDir "dist\main.js")) -and $env:SKELETON_ROOT) {
  Write-Warning "brain/rag-service missing; fallback SKELETON_ROOT (legacy)"
  $BrainRoot = $env:SKELETON_ROOT
  $RagDir = Join-Path $BrainRoot "services\rag-service"
  if (-not (Test-Path (Join-Path $RagDir "dist\main.js"))) {
    $RagDir = Join-Path $BrainRoot "rag-service"
  }
}

Import-DotEnv (Join-Path $BrainRoot ".env")
$env:CUSTOMER_AI_ROOT = $BrainRoot
if ($SkipDocker) {
  Write-Host "SkipDocker is obsolete (no Docker) — ignored"
}

$Node = Join-Path $PortableRoot "app\runtime\node-win-x64\node.exe"
if (-not (Test-Path $Node)) {
  $sysNode = Get-Command node -ErrorAction SilentlyContinue
  if ($sysNode) { $Node = $sysNode.Source }
  else { throw "Node not found. Set OPENCLAW_PORTABLE_ROOT or install Node." }
}

$Cfg = if ($env:CS_RUNTIME_CONFIG) { $env:CS_RUNTIME_CONFIG } else { Join-Path $Root "config\cs-runtime.json" }
$AdminJs = Join-Path $Root "scripts\kb-admin-server.js"
$LogDir = Join-Path $Root "memory"
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$adminPort = 18790
if ($env:ADMIN_PORT) { $adminPort = [int]$env:ADMIN_PORT }
$ragListen = "http://127.0.0.1:8787"
if ($env:RAG_SERVICE_PORT) { $ragListen = "http://127.0.0.1:$($env:RAG_SERVICE_PORT)" }

Write-Host "=== OpenClaw CS Mid-Platform ==="
Write-Host "Root:   $Root"
Write-Host "Brain:  $BrainRoot"
Write-Host "RagDir: $RagDir"
Write-Host "Node:   $Node"
Write-Host ""
Write-Host "Starts: schema (DATABASE_URL) + rag-service (+ optional admin). Does NOT start OpenClaw / cs-watch."
Write-Host ""

$EnsureInfra = Join-Path $Root "scripts\Ensure-Infra.ps1"
Write-Host "[1/3] DB schema (DATABASE_URL / Supabase)..."
if (Test-Path $EnsureInfra) {
  try { & $EnsureInfra -BrainRoot $BrainRoot }
  catch { Write-Warning ("  Ensure-Infra failed: {0}" -f $_.Exception.Message) }
} else {
  Write-Warning "  Ensure-Infra.ps1 missing"
}

function Start-RagService {
  $ragMain = Join-Path $RagDir "dist\main.js"
  if (-not (Test-Path $ragMain)) {
    Write-Warning ("rag-service not built: {0}" -f $ragMain)
    Write-Warning "Build rag-service first (see brain\README.md)"
    return $false
  }
  Import-DotEnv (Join-Path $BrainRoot ".env")
  $env:CUSTOMER_AI_ROOT = $BrainRoot
  $env:OPENCLAW_PROJECT_ROOT = $Root
  if (Test-Path $Cfg) { $env:CS_RUNTIME_CONFIG = $Cfg }
  $ragOut = Join-Path $LogDir "rag-service-stdout.log"
  $ragErr = Join-Path $LogDir "rag-service-stderr.log"
  Write-Host "  Starting rag-service..."
  Start-Process -FilePath $Node `
    -ArgumentList @($ragMain) `
    -WorkingDirectory $RagDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $ragOut `
    -RedirectStandardError $ragErr | Out-Null
  for ($i = 0; $i -lt 60; $i++) {
    if (Test-UrlOk "$ragListen/health" 2) { return $true }
    Start-Sleep -Seconds 1
  }
  Write-Warning "  RAG health timeout. Check memory\rag-service-stderr.log"
  return $false
}

Write-Host "[2/3] rag-service :8787 ..."
$ragOk = Test-UrlOk "$ragListen/health"
if (-not $ragOk) { $ragOk = Start-RagService }
if ($ragOk) {
  Write-Host "  OK  $ragListen/health"
} else {
  Write-Warning "  RAG not ready. Check memory\rag-service-stderr.log and brain\.env DATABASE_URL"
}

if (-not $SkipAdmin) {
  Write-Host "[3/3] Admin console :$adminPort (localhost only)..."
  if (-not (Test-UrlOk "http://127.0.0.1:$adminPort/api/status")) {
    if (-not (Test-Path $AdminJs)) {
      Write-Warning "  kb-admin-server.js missing"
    } elseif (-not (Test-Path $Cfg)) {
      Write-Warning ("  config missing: {0} (copy from cs-runtime.example.json)" -f $Cfg)
    } else {
      $adminOut = Join-Path $LogDir "console-stdout.log"
      $adminErr = Join-Path $LogDir "console-stderr.log"
      Start-Process -FilePath $Node `
        -ArgumentList @($AdminJs, "--config", $Cfg, "--port", "$adminPort", "--host", "127.0.0.1") `
        -WorkingDirectory $Root `
        -RedirectStandardOutput $adminOut `
        -RedirectStandardError $adminErr `
        -WindowStyle Hidden | Out-Null
      Start-Sleep -Seconds 2
    }
  }
  if (Test-UrlOk "http://127.0.0.1:$adminPort/api/status") {
    Write-Host "  OK  http://127.0.0.1:$adminPort/"
    if (-not $NoOpenBrowser) {
      try { Start-Process "http://127.0.0.1:$adminPort/" } catch {}
    }
  } else {
    Write-Warning "  Admin console not up (optional). Edge clients only need :8787."
  }
} else {
  Write-Host "[3/3] Skip admin"
}

$ips = Get-LanIPv4
Write-Host ""
Write-Host "======== Edge client config (other PCs) ========"
if ($ips.Count -gt 0) {
  $primary = $ips[0]
  Write-Host ("LAN IP (prefer this): {0}" -f $primary)
  if ($ips.Count -gt 1) {
    Write-Host ("Other NICs: {0}" -f ($ips -join ", "))
  }
  Write-Host ""
  Write-Host "Set on edge .env / desktop onboarding:"
  Write-Host "  DEPLOY_ROLE=edge"
  Write-Host ("  RAG_BASE_URL=http://{0}:8787" -f $primary)
  $keyHint = if ($env:RAG_API_KEY) { $env:RAG_API_KEY } else { "(same as brain\.env RAG_API_KEY)" }
  Write-Host ("  RAG_API_KEY={0}" -f $keyHint)
  Write-Host ""
  Write-Host ("Check from other PC: http://{0}:8787/health" -f $primary)
} else {
  Write-Warning "No LAN IPv4 found. Run ipconfig and set RAG_BASE_URL=http://YOUR_IP:8787"
}

if (-not $NoFirewallHint) {
  Write-Host ""
  Write-Host "Firewall: allow inbound TCP 8787. Admin PowerShell example:"
  Write-Host '  netsh advfirewall firewall add rule name="OpenClaw RAG 8787" dir=in action=allow protocol=TCP localport=8787'
}

Write-Host ""
Write-Host "Stop mid:  npm run stop:mid   or  .\scripts\Stop-Mid.ps1"
Write-Host ""