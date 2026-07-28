#Requires -Version 5.1
<#
.SYNOPSIS
  启动企业微信智能机器人长连接桥（wecom-bridge）。

.DESCRIPTION
  读取 config/cs-runtime.json 的 platforms.wecom，以及 .env 中的
  WECOM_AIBOT_ID / WECOM_AIBOT_SECRET。需已 npm install（含 @wecom/aibot-node-sdk）。
#>
param(
  [string]$Config = "",
  [switch]$Foreground
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
    $v = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
    [Environment]::SetEnvironmentVariable($k, $v, "Process")
  }
}

Import-DotEnv (Join-Path $Root ".env")

$Cfg = if ($Config) { $Config } elseif ($env:CS_RUNTIME_CONFIG) { $env:CS_RUNTIME_CONFIG } else { Join-Path $Root "config\cs-runtime.json" }
$PortableRoot = if ($env:OPENCLAW_PORTABLE_ROOT) { $env:OPENCLAW_PORTABLE_ROOT } else { "F:\OpenClaw-USB-Portable" }
$Node = Join-Path $PortableRoot "app\runtime\node-win-x64\node.exe"
if (-not (Test-Path $Node)) { $Node = "node" }
$Script = Join-Path $Root "apps\wecom-bridge\index.js"
if (-not (Test-Path $Script)) { throw "wecom-bridge missing: $Script" }
if (-not (Test-Path $Cfg)) { throw "config missing: $Cfg" }

$env:OPENCLAW_PROJECT_ROOT = $Root
$env:CS_RUNTIME_CONFIG = $Cfg
$env:PATH = "$(Join-Path $PortableRoot 'app\runtime\node-win-x64');$env:PATH"

$outLog = Join-Path $Root "memory\wecom-bridge-stdout.log"
$errLog = Join-Path $Root "memory\wecom-bridge-stderr.log"
New-Item -ItemType Directory -Force -Path (Join-Path $Root "memory") | Out-Null

Write-Host "Starting wecom-bridge..."
Write-Host "  config=$Cfg"
Write-Host "  botId=$($env:WECOM_AIBOT_ID)"

if ($Foreground) {
  & $Node $Script --config $Cfg
} else {
  $p = Start-Process -FilePath $Node -ArgumentList @($Script, "--config", $Cfg) -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
  Write-Host "wecom-bridge started pid=$($p.Id)"
  Write-Host "log: $(Join-Path $Root 'memory\cs-watch.log') (WECOM lines) / $outLog"
}
