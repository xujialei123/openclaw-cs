#Requires -Version 5.1
<#
.SYNOPSIS
  启动 OpenClaw 客服白名单巡检（cs-watch）。

.DESCRIPTION
  读本仓 .env（OPENCLAW_PORTABLE_ROOT / RAG_BASE_URL 等），再启动浏览器与 cs-watch。
  白名单与知识库开关读取 config/cs-runtime.json（路径支持相对根目录与 ${ENV}）。

.PARAMETER Once
  只执行一轮检测后退出。

.PARAMETER Config
  可选：自定义 cs-runtime.json 路径。

.PARAMETER SkipOpenSites
  不自动打开美团/抖音页面。
#>
param(
  [switch]$Once,
  [string]$Config = "",
  [switch]$SkipOpenSites
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

Import-DotEnv (Join-Path $Root ".env")

$Cfg = if ($Config) { $Config } elseif ($env:CS_RUNTIME_CONFIG) { $env:CS_RUNTIME_CONFIG } else { Join-Path $Root "config\cs-runtime.json" }
$PortableRoot = if ($env:OPENCLAW_PORTABLE_ROOT) { $env:OPENCLAW_PORTABLE_ROOT } else { "F:\OpenClaw-USB-Portable" }
$Node = Join-Path $PortableRoot "app\runtime\node-win-x64\node.exe"
$OpenClawMjs = Join-Path $PortableRoot "app\core\node_modules\openclaw\openclaw.mjs"
$Script = Join-Path $Root "apps\edge-worker\cs-watch.js"
if (-not (Test-Path $Script)) { throw "cs-watch.js missing: $Script" }
if (-not (Test-Path $Cfg)) { throw "config missing: $Cfg" }

$tokenFile = Join-Path $PortableRoot "data\.openclaw\gateway-token.txt"
if (-not (Test-Path $tokenFile)) { throw "gateway token missing: $tokenFile" }
$env:OPENCLAW_GATEWAY_TOKEN = (Get-Content $tokenFile -Raw).Trim()
$env:OPENCLAW_HOME = Join-Path $PortableRoot "data"
$env:OPENCLAW_STATE_DIR = Join-Path $PortableRoot "data\.openclaw"
$env:OPENCLAW_CONFIG_PATH = Join-Path $PortableRoot "data\.openclaw\openclaw.json"
$env:PATH = "$(Join-Path $PortableRoot 'app\runtime\node-win-x64');$env:PATH"
$env:OPENCLAW_PORTABLE_ROOT = $PortableRoot

function Test-TcpPortLocal([int]$Port, [int]$TimeoutMs = 1500) {
  $client = $null
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if (-not $iar.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
    if (-not $client.Connected) { return $false }
    $client.EndConnect($iar)
    return $true
  } catch { return $false }
  finally { if ($client) { try { $client.Close() } catch {} } }
}

$gatewayPort = 18789
if ($env:OPENCLAW_GATEWAY_URL -match ":(\d+)") { $gatewayPort = [int]$Matches[1] }
Set-Location $PortableRoot
if (-not (Test-TcpPortLocal $gatewayPort)) {
  $startOc = Join-Path $PortableRoot "Start-OpenClaw.ps1"
  if (Test-Path $startOc) {
    Write-Host "Gateway down; starting Start-OpenClaw.ps1 (minimized)..."
    Start-Process -FilePath "powershell.exe" `
      -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $startOc, "-NoBrowser", "-GatewayPort", "$gatewayPort") `
      -WorkingDirectory $PortableRoot -WindowStyle Minimized | Out-Null
    for ($i = 0; $i -lt 50; $i++) {
      if (Test-TcpPortLocal $gatewayPort) { break }
      Start-Sleep -Seconds 1
    }
  }
  if (-not (Test-TcpPortLocal $gatewayPort)) {
    throw "OpenClaw gateway not listening on :$gatewayPort. Run Start-OpenClaw.bat first."
  }
}

Write-Host "Starting OpenClaw browser..."
Write-Host ("RAG_BASE_URL={0}" -f $(if ($env:RAG_BASE_URL) { $env:RAG_BASE_URL } else { "(from cs-runtime.json)" }))
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
try {
  & $Node $OpenClawMjs browser start 2>&1 | Out-Null
} catch {
  Write-Warning ("browser start: {0}" -f $_.Exception.Message)
}
$ErrorActionPreference = $prevEap
Start-Sleep -Seconds 2

function Test-CdpReady {
  try {
    $cdp = if ($env:OPENCLAW_CDP_URL) { $env:OPENCLAW_CDP_URL } else { "http://127.0.0.1:18800" }
    $null = Invoke-RestMethod -Uri ($cdp.TrimEnd('/') + "/json/version") -TimeoutSec 3
    return $true
  } catch {
    return $false
  }
}

if (-not (Test-CdpReady)) {
  Write-Warning "CDP not ready yet; cs-watch will retry."
}

if (-not $SkipOpenSites) {
  $runtime = Get-Content $Cfg -Raw -Encoding UTF8 | ConvertFrom-Json
  $mt = $runtime.platforms.meituan.openUrl
  $dy = $runtime.platforms.douyin.openUrl
  if ($mt) { & $Node $OpenClawMjs browser open $mt 2>$null | Out-Null }
  if ($dy) { & $Node $OpenClawMjs browser open $dy 2>$null | Out-Null }
  Start-Sleep -Seconds 2
}

Write-Host "Whitelist/Knowledge: edit config\cs-runtime.json or .env (RAG_BASE_URL). Paths are not F:-hardcoded."
$argList = @($Script, "--config", $Cfg)
if ($Once) { $argList += "--once" }

$outLog = Join-Path $Root "memory\cs-watch-stdout.log"
$errLog = Join-Path $Root "memory\cs-watch-stderr.log"
New-Item -ItemType Directory -Force -Path (Join-Path $Root "memory") | Out-Null

if ($Once) {
  & $Node @argList
} else {
  $p = Start-Process -FilePath $Node -ArgumentList $argList -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
  Write-Host "cs-watch started pid=$($p.Id)"
  Write-Host "log: $(Join-Path $Root 'memory\cs-watch.log')"
}
