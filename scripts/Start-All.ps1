#Requires -Version 5.1
param(
  [switch]$SkipWatch,
  [switch]$SkipAdmin,
  [switch]$SkipOpenSites,
  [switch]$SkipRag,
  [switch]$SkipDocker,
  [switch]$Once,
  [switch]$NoOpenBrowser,
  [string]$Config = "",
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

$EdgeEnv = Join-Path $Root ".env"
if (-not (Test-Path $EdgeEnv)) {
  $ex = Join-Path $Root ".env.example"
  if (Test-Path $ex) {
    Copy-Item $ex $EdgeEnv -Force
    Write-Warning "Created .env from .env.example"
  }
}
Import-DotEnv $EdgeEnv

$DeployRole = if ($env:DEPLOY_ROLE) { $env:DEPLOY_ROLE.Trim().ToLowerInvariant() } else { "all" }
if ($DeployRole -eq "edge") {
  if (-not $PSBoundParameters.ContainsKey("SkipRag")) { $SkipRag = $true }
  Write-Host "DEPLOY_ROLE=edge -> skip local rag-service (use RAG_BASE_URL)"
}
if ($SkipDocker) {
  Write-Host "SkipDocker is obsolete (no Docker) — ignored"
}

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

$Node = Join-Path $PortableRoot "app\runtime\node-win-x64\node.exe"
$Cfg = if ($Config) { $Config } elseif ($env:CS_RUNTIME_CONFIG) { $env:CS_RUNTIME_CONFIG } else { Join-Path $Root "config\cs-runtime.json" }
$LogDir = Join-Path $Root "memory"

if (-not (Test-Path $Node)) { throw "OpenClaw node not found: $Node" }
if (-not (Test-Path $Cfg)) { throw "config missing: $Cfg" }

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

$runtime = Get-Content $Cfg -Raw -Encoding UTF8 | ConvertFrom-Json
$adminPort = 18790
if ($env:ADMIN_PORT) { $adminPort = [int]$env:ADMIN_PORT }
elseif ($runtime.knowledge.adminPort) { $adminPort = [int]$runtime.knowledge.adminPort }
$ragBase = "http://127.0.0.1:8787"
if ($env:RAG_BASE_URL) { $ragBase = [string]$env:RAG_BASE_URL }
elseif ($runtime.knowledge.rag.baseUrl) { $ragBase = [string]$runtime.knowledge.rag.baseUrl }
$ragBase = $ragBase.TrimEnd("/")

Write-Host "=== OpenClaw CS All-in-One ==="
Write-Host "Root: $Root"
Write-Host "Brain: $BrainRoot"
Write-Host "RAG: $ragBase"
Write-Host ""

function Test-TcpPort([int]$Port, [int]$TimeoutMs = 1500) {
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
    if (-not $client.Connected) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch {
    return $false
  } finally {
    if ($client) { try { $client.Close() } catch {} }
  }
}

function Ensure-OpenClawGateway([string]$Portable, [int]$Port = 18789) {
  if (Test-TcpPort $Port) {
    Write-Host "  OK gateway :$Port"
    return $true
  }
  $startOc = Join-Path $Portable "Start-OpenClaw.ps1"
  if (-not (Test-Path $startOc)) {
    Write-Warning "  Start-OpenClaw.ps1 missing: $startOc"
    return $false
  }
  Write-Host "  Starting OpenClaw gateway..."
  Start-Process -FilePath "powershell.exe" -ArgumentList @(
    "-NoProfile", "-ExecutionPolicy", "Bypass",
    "-File", $startOc, "-NoBrowser", "-GatewayPort", "$Port"
  ) -WorkingDirectory $Portable -WindowStyle Minimized | Out-Null
  for ($i = 0; $i -lt 30; $i++) {
    if (Test-TcpPort $Port) {
      Write-Host "  OK gateway :$Port"
      return $true
    }
    Start-Sleep -Seconds 1
  }
  Write-Warning "  Gateway not ready on :$Port"
  return $false
}

$EnsureInfra = Join-Path $Root "scripts\Ensure-Infra.ps1"
if (-not $SkipRag) {
  Write-Host "[0/5] DB schema..."
  if (Test-Path $EnsureInfra) {
    try { & $EnsureInfra -BrainRoot $BrainRoot }
    catch {
      Write-Warning "  Ensure-Infra failed: $($_.Exception.Message)"
    }
  }
}

Write-Host "[1/5] Starting rag-service..."
$ragOk = $false
try {
  $ragOk = Test-TcpPort 8787
} catch { }
if (-not $ragOk -and -not $SkipRag) {
  $ragMain = Join-Path $BrainRoot "rag-service\dist\main.js"
  if (-not (Test-Path $ragMain)) {
    Write-Warning "  rag-service not built: $ragMain"
  } else {
    $env:CUSTOMER_AI_ROOT = $BrainRoot
    $ragOut = Join-Path $LogDir "rag-service-stdout.log"
    $ragErr = Join-Path $LogDir "rag-service-stderr.log"
    Write-Host "  Starting rag-service from $ragMain ..."
    Start-Process -FilePath $Node -ArgumentList @($ragMain) -WorkingDirectory (Join-Path $BrainRoot "rag-service") -WindowStyle Hidden -RedirectStandardOutput $ragOut -RedirectStandardError $ragErr | Out-Null
    for ($i = 0; $i -lt 30; $i++) {
      try {
        $test = Invoke-RestMethod -Uri "http://127.0.0.1:8787/health" -TimeoutSec 2
        if ($test.ok) {
          $ragOk = $true
          break
        }
      } catch { }
      Start-Sleep -Seconds 1
    }
  }
}
if ($ragOk) {
  Write-Host "  OK rag-service:8787"
} else {
  Write-Host "  WARNING: RAG not ready (will use local fallback)"
}

if (-not $SkipAdmin) {
  Write-Host "[2/5] Starting console on :$adminPort ..."
  $adminJs = Join-Path $Root "scripts\kb-admin-server.js"
  if (Test-Path $adminJs) {
    Start-Process -FilePath $Node -ArgumentList @($adminJs, "--config", $Cfg, "--port", "$adminPort") `
      -WorkingDirectory $Root -WindowStyle Hidden | Out-Null
    Start-Sleep -Seconds 2
    if (Test-TcpPort $adminPort) {
      Write-Host "  OK http://127.0.0.1:$adminPort"
    }
  }
}

Write-Host "[3/5] OpenClaw gateway + browser..."
$gatewayPort = 18789
if ($env:OPENCLAW_GATEWAY_URL -match ":(\d+)") { $gatewayPort = [int]$Matches[1] }
$cdpPort = 18800
$tokenFile = Join-Path $PortableRoot "data\.openclaw\gateway-token.txt"
if (Test-Path $tokenFile) { $env:OPENCLAW_GATEWAY_TOKEN = (Get-Content $tokenFile -Raw).Trim() }
$env:OPENCLAW_HOME = Join-Path $PortableRoot "data"
$env:OPENCLAW_STATE_DIR = Join-Path $PortableRoot "data\.openclaw"
$env:OPENCLAW_CONFIG_PATH = Join-Path $PortableRoot "data\.openclaw\openclaw.json"
$env:PATH = "$(Join-Path $PortableRoot 'app\runtime\node-win-x64');$env:PATH"
$env:OPENCLAW_PORTABLE_ROOT = $PortableRoot
Import-DotEnv (Join-Path $PortableRoot "data\.openclaw\.env")
Set-Location $PortableRoot

$gwOk = Ensure-OpenClawGateway -Portable $PortableRoot -Port $gatewayPort
$browserOk = $false
if ($gwOk) {
  try {
    & $Node $OpenClawMjs browser start 2>&1 | Out-Null
  } catch {
    Write-Warning ("  browser start: {0}" -f $_.Exception.Message)
  }
  Start-Sleep -Seconds 2
  $cdpUrl = if ($env:OPENCLAW_CDP_URL) { $env:OPENCLAW_CDP_URL.TrimEnd("/") } else { "http://127.0.0.1:18800" }
  if (Test-TcpPort $cdpPort) {
    Write-Host "  OK  browser CDP $cdpUrl"
    $browserOk = $true
  } else {
    Write-Warning "  CDP not ready yet ($cdpUrl); cs-watch will retry"
  }
} else {
  Write-Warning "  Skip browser start (gateway down)"
}

if (-not $SkipWatch) {
  Write-Host "[4/5] Starting cs-watch..."
  $watchArgs = @()
  if ($Once) { $watchArgs += "-Once" }
  if ($Config) { $watchArgs += @("-Config", $Config) }
  $StartWatch = Join-Path $Root "scripts\Start-CsWatch.ps1"
  if (Test-Path $StartWatch) {
    & $StartWatch @watchArgs
  }
} else {
  Write-Host "[4/5] Skip cs-watch"
  Write-Host "Done. Admin: http://127.0.0.1:$adminPort/"
}

# Enterprise WeChat smart robot
try {
  $rtWecom = Get-Content $Cfg -Raw -Encoding UTF8 | ConvertFrom-Json
  $wecomOn = $false
  if ($rtWecom.platforms -and $rtWecom.platforms.wecom) {
    $wecomOn = [bool]$rtWecom.platforms.wecom.enabled
  }
  $hasBot = -not [string]::IsNullOrWhiteSpace($env:WECOM_AIBOT_ID)
  $hasSec = -not [string]::IsNullOrWhiteSpace($env:WECOM_AIBOT_SECRET)
  if (-not $hasBot -and $rtWecom.platforms.wecom -and $rtWecom.platforms.wecom.botId) { $hasBot = $true }
  if (-not $hasSec -and $rtWecom.platforms.wecom -and $rtWecom.platforms.wecom.secret) { $hasSec = $true }
  if ($wecomOn -and $hasBot -and $hasSec) {
    Write-Host "[5/5] Starting wecom-bridge..."
    $StartWecom = Join-Path $Root "scripts\Start-WecomBridge.ps1"
    if (Test-Path $StartWecom) {
      if ($Config) { & $StartWecom -Config $Config } else { & $StartWecom }
    } else {
      Write-Warning "  Start-WecomBridge.ps1 missing"
    }
  } else {
    Write-Host "[5/5] Skip wecom-bridge"
  }
} catch {
  Write-Warning "  wecom-bridge skip: $($_.Exception.Message)"
}
