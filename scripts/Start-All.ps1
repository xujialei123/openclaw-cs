#Requires -Version 5.1
<#
.SYNOPSIS
  One-click start from THIS repo: infra + brain(rag) + console + OpenClaw + cs-watch
.NOTES
  Console: prefers Next (apps/console) when .next exists or USE_NEXT_CONSOLE=1; else legacy kb-admin-server.
#>
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
  if (-not $PSBoundParameters.ContainsKey("SkipDocker")) { $SkipDocker = $true }
  if (-not $PSBoundParameters.ContainsKey("SkipRag")) { $SkipRag = $true }
  Write-Host "DEPLOY_ROLE=edge -> SkipDocker + SkipRag"
}

$PortableRoot = if ($env:OPENCLAW_PORTABLE_ROOT) { $env:OPENCLAW_PORTABLE_ROOT } else { "F:\OpenClaw-USB-Portable" }
if (-not $BrainRoot) {
  if ($env:BRAIN_ROOT) { $BrainRoot = $env:BRAIN_ROOT }
  else { $BrainRoot = Join-Path $Root "brain" }
}
# legacy SKELETON_ROOT only if brain/rag-service missing
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
$OpenClawMjs = Join-Path $PortableRoot "app\core\node_modules\openclaw\openclaw.mjs"
$Cfg = if ($Config) { $Config } elseif ($env:CS_RUNTIME_CONFIG) { $env:CS_RUNTIME_CONFIG } else { Join-Path $Root "config\cs-runtime.json" }
$AdminJs = Join-Path $Root "scripts\kb-admin-server.js"
$ConsolePkg = Join-Path $Root "apps\console\package.json"
$StartWatch = Join-Path $Root "scripts\Start-CsWatch.ps1"
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
$mode = "local"
if ($runtime.knowledge.mode) { $mode = [string]$runtime.knowledge.mode }

Write-Host "=== OpenClaw CS All-in-One (this repo) ==="
Write-Host "Root:     $Root"
Write-Host "Brain:    $BrainRoot"
Write-Host "RagDir:   $RagDir"
Write-Host "Config:   $Cfg"
Write-Host "Mode:     $mode"
Write-Host "Role:     $DeployRole"
Write-Host "RAG:      $ragBase"
Write-Host ""

if ($DeployRole -eq "edge" -and ($ragBase -match "127\.0\.0\.1|localhost")) {
  Write-Warning "DEPLOY_ROLE=edge but RAG_BASE_URL is localhost"
}

function Test-UrlOk([string]$Url, [int]$TimeoutSec = 3) {
  try {
    $null = Invoke-RestMethod -Uri $Url -TimeoutSec $TimeoutSec
    return $true
  } catch {
    return $false
  }
}

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
    Write-Host "  OK  gateway already listening :$Port"
    return $true
  }
  $startOc = Join-Path $Portable "Start-OpenClaw.ps1"
  if (-not (Test-Path $startOc)) {
    Write-Warning "  Start-OpenClaw.ps1 missing: $startOc"
    return $false
  }
  Write-Host "  Starting OpenClaw gateway (minimized window)..."
  Start-Process -FilePath "powershell.exe" `
    -ArgumentList @(
      "-NoProfile", "-ExecutionPolicy", "Bypass",
      "-File", $startOc, "-NoBrowser", "-GatewayPort", "$Port"
    ) `
    -WorkingDirectory $Portable `
    -WindowStyle Minimized | Out-Null
  for ($i = 0; $i -lt 50; $i++) {
    if (Test-TcpPort $Port) {
      Write-Host "  OK  gateway :$Port"
      return $true
    }
    Start-Sleep -Seconds 1
  }
  Write-Warning "  Gateway not ready on :$Port within 50s"
  Write-Warning "  Manual: run $Portable\Start-OpenClaw.bat then re-run Start-All"
  return $false
}

function Start-RagService {
  $ragMain = Join-Path $RagDir "dist\main.js"
  if (-not (Test-Path $ragMain)) {
    Write-Warning ("rag-service not built: {0}" -f $ragMain)
    Write-Warning "Put/build rag-service under brain\rag-service (see brain\README.md)"
    return $false
  }
  Import-DotEnv (Join-Path $BrainRoot ".env")
  $env:CUSTOMER_AI_ROOT = $BrainRoot
  # 供 rag-service 上传/编译后自动把 kbId 写回边端 cs-runtime.json
  $env:OPENCLAW_PROJECT_ROOT = $Root
  $env:CS_RUNTIME_CONFIG = $Cfg
  $ragOut = Join-Path $LogDir "rag-service-stdout.log"
  $ragErr = Join-Path $LogDir "rag-service-stderr.log"
  Write-Host "  Starting rag-service from brain\rag-service ..."
  Start-Process -FilePath $Node `
    -ArgumentList @($ragMain) `
    -WorkingDirectory $RagDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput $ragOut `
    -RedirectStandardError $ragErr | Out-Null
  for ($i = 0; $i -lt 30; $i++) {
    if (Test-UrlOk "$ragBase/health" 2) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

$EnsureInfra = Join-Path $Root "scripts\Ensure-Infra.ps1"
if (-not $SkipDocker) {
  Write-Host "[0/5] Docker + DB schema (infra/)..."
  if (Test-Path $EnsureInfra) {
    try { & $EnsureInfra -BrainRoot $BrainRoot }
    catch {
      Write-Warning ("  Ensure-Infra failed: {0}" -f $_.Exception.Message)
    }
  } else {
    Write-Warning "  Ensure-Infra.ps1 missing"
  }
} else {
  Write-Host "[0/5] Skip Docker / schema"
}

Write-Host "[1/5] Checking rag-service..."
$ragOk = Test-UrlOk "$ragBase/health"
if (-not $ragOk -and -not $SkipRag) { $ragOk = Start-RagService }
if ($ragOk) {
  Write-Host "  OK  $ragBase/health"
} else {
  Write-Warning ("RAG not ready: {0}/health" -f $ragBase)
}

if (-not $SkipAdmin) {
  Write-Host "[2/5] Starting console on :$adminPort ..."
  $adminUp = Test-UrlOk "http://127.0.0.1:$adminPort/api/status"
  if (-not $adminUp) {
    $adminOut = Join-Path $LogDir "console-stdout.log"
    $adminErr = Join-Path $LogDir "console-stderr.log"
    $consoleNext = Join-Path $Root "apps\console\.next"
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    # 默认用 legacy kb-admin（含上传/环境变量/分步引导）。显式 USE_NEXT_CONSOLE=1 才用 Next。
    $useNext = ($env:USE_NEXT_CONSOLE -eq "1") -and (Test-Path $consoleNext)
    $startedConsole = $false
    if ($useNext -and (Test-Path $ConsolePkg) -and (Test-Path (Join-Path $Root "node_modules\next"))) {
      Write-Host "  Using Next console (apps/console) ..."
      $nextBin = Join-Path $Root "node_modules\next\dist\bin\next"
      $consoleDir = Join-Path $Root "apps\console"
      $nextArgs = if (Test-Path $consoleNext) {
        @($nextBin, "start", "-p", "$adminPort", "-H", "127.0.0.1")
      } else {
        @($nextBin, "dev", "-p", "$adminPort", "-H", "127.0.0.1")
      }
      $env:PATH = "$(Join-Path $PortableRoot 'app\runtime\node-win-x64');$env:PATH"
      $env:OPENCLAW_PROJECT_ROOT = $Root
      Start-Process -FilePath $Node `
        -ArgumentList $nextArgs `
        -WorkingDirectory $consoleDir `
        -WindowStyle Hidden `
        -RedirectStandardOutput $adminOut `
        -RedirectStandardError $adminErr | Out-Null
      $startedConsole = $true
      Start-Sleep -Seconds 4
    }
    if (-not (Test-UrlOk "http://127.0.0.1:$adminPort/api/status")) {
      Write-Host "  Using legacy kb-admin-server (full KB upload + docs) ..."
      Start-Process -FilePath $Node `
        -ArgumentList @($AdminJs, "--config", $Cfg, "--port", "$adminPort") `
        -WorkingDirectory $Root `
        -RedirectStandardOutput $adminOut `
        -RedirectStandardError $adminErr `
        -WindowStyle Hidden | Out-Null
      Start-Sleep -Seconds 1
    } elseif ($startedConsole) {
      Write-Host "  Next console ready"
    }
  }
  if (Test-UrlOk "http://127.0.0.1:$adminPort/api/status") {
    Write-Host "  OK  http://127.0.0.1:$adminPort"
    Write-Host "  Guide: http://127.0.0.1:$adminPort/guide"
    if (-not $NoOpenBrowser) {
      try { Start-Process "http://127.0.0.1:$adminPort/guide" } catch { }
      try { Start-Process "http://127.0.0.1:$adminPort/" } catch { }
    }
  } else {
    Write-Warning "  console failed — npm install && npm run console:build  或 npm run admin:legacy"
  }
} else {
  Write-Host "[2/5] Skip admin/console"
}

Write-Host "[3/5] OpenClaw gateway + browser..."
$gatewayPort = 18789
if ($env:OPENCLAW_GATEWAY_URL -match ":(\d+)") { $gatewayPort = [int]$Matches[1] }
$tokenFile = Join-Path $PortableRoot "data\.openclaw\gateway-token.txt"
if (Test-Path $tokenFile) { $env:OPENCLAW_GATEWAY_TOKEN = (Get-Content $tokenFile -Raw).Trim() }
$env:OPENCLAW_HOME = Join-Path $PortableRoot "data"
$env:OPENCLAW_STATE_DIR = Join-Path $PortableRoot "data\.openclaw"
$env:OPENCLAW_CONFIG_PATH = Join-Path $PortableRoot "data\.openclaw\openclaw.json"
$env:PATH = "$(Join-Path $PortableRoot 'app\runtime\node-win-x64');$env:PATH"
$env:OPENCLAW_PORTABLE_ROOT = $PortableRoot
Set-Location $PortableRoot

$gwOk = Ensure-OpenClawGateway -Portable $PortableRoot -Port $gatewayPort
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
if ($gwOk) {
  try {
    & $Node $OpenClawMjs browser start 2>&1 | Out-Null
  } catch {
    Write-Warning ("  browser start: {0}" -f $_.Exception.Message)
  }
  Start-Sleep -Seconds 2
  $cdpUrl = if ($env:OPENCLAW_CDP_URL) { $env:OPENCLAW_CDP_URL.TrimEnd("/") } else { "http://127.0.0.1:18800" }
  if (Test-UrlOk "$cdpUrl/json/version" 3) {
    Write-Host "  OK  browser CDP $cdpUrl"
  } else {
    Write-Warning "  CDP not ready yet ($cdpUrl); cs-watch will retry"
  }
} else {
  Write-Warning "  Skip browser start (gateway down)"
}
$ErrorActionPreference = $prevEap

if (-not $SkipWatch) {
  Write-Host "[4/5] Starting cs-watch..."
  $watchArgs = @()
  if ($Once) { $watchArgs += "-Once" }
  if ($SkipOpenSites) { $watchArgs += "-SkipOpenSites" }
  if ($Config) { $watchArgs += @("-Config", $Config) }
  & $StartWatch @watchArgs
} else {
  Write-Host "[4/5] Skip cs-watch"
  Write-Host "Done. Admin: http://127.0.0.1:$adminPort/"
}

# 企微智能机器人长连接（platforms.wecom.enabled + BotId/Secret）
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
    Write-Host "[5/5] Skip wecom-bridge (set platforms.wecom.enabled + WECOM_AIBOT_ID/SECRET)"
  }
} catch {
  Write-Warning "  wecom-bridge skip: $($_.Exception.Message)"
}

