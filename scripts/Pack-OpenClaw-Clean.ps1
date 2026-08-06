#Requires -Version 5.1
<#
.SYNOPSIS
  Build a clean OpenClaw USB portable zip (no browser profile / chat / logs).

.DESCRIPTION
  Keeps: app\ (node + openclaw), config-server, launcher scripts, openclaw.json template.
  Strips: browser user-data, agents sessions, logs, media, tokens, caches.

  Target machine: extract -> Start-OpenClaw.bat (auto-creates gateway-token).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Pack-OpenClaw-Clean.ps1
#>
param(
  [string]$PortableRoot = "",
  [string]$OutDir = "",
  [string]$DestDir = "",
  [switch]$SkipZip
)

$ErrorActionPreference = "Stop"

# Load edge .env for OPENCLAW_PORTABLE_ROOT if present
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EdgeEnv = Join-Path $ProjectRoot ".env"
if (Test-Path $EdgeEnv) {
  Get-Content $EdgeEnv -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { return }
    $k = $line.Substring(0, $eq).Trim()
    $v = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
    if ($k -eq "OPENCLAW_PORTABLE_ROOT" -and $v) {
      [Environment]::SetEnvironmentVariable($k, $v, "Process")
    }
  }
}

if (-not $PortableRoot) {
  $PortableRoot = if ($env:OPENCLAW_PORTABLE_ROOT) { $env:OPENCLAW_PORTABLE_ROOT } else { "F:\OpenClaw-USB-Portable" }
}
if (-not (Test-Path $PortableRoot)) { throw "Portable root not found: $PortableRoot" }

$Stamp = Get-Date -Format "yyyyMMdd-HHmm"
if (-not $OutDir) { $OutDir = Join-Path $ProjectRoot "dist-pack" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

if ($DestDir) {
  $Dest = $DestDir
  $Stage = Split-Path -Parent $Dest
  if (-not $Stage) { $Stage = $OutDir }
  $SkipZip = $true
  $ZipPath = ""
} else {
  $Stage = Join-Path $OutDir ("openclaw-clean-" + $Stamp)
  $Dest = Join-Path $Stage "OpenClaw-USB-Portable"
  $ZipPath = Join-Path $OutDir ("OpenClaw-USB-Portable-clean-" + $Stamp + ".zip")
}

if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
if (-not $DestDir -and (Test-Path $Stage) -eq $false) {
  New-Item -ItemType Directory -Force -Path $Stage | Out-Null
}

Write-Host "Source: $PortableRoot"
Write-Host "Stage:  $Dest"

# 1) Runtime + core (required)
Write-Host "[1/4] Copy app\ ..."
# 注意：不要 /XD Cache —— 会误删 undici/lib/cache，导致 openclaw CLI 无法启动
& robocopy (Join-Path $PortableRoot "app") (Join-Path $Dest "app") /E `
  /XD "Crashpad" "ShaderCache" "Code Cache" "GPUCache" "GrShaderCache" "DawnGraphiteCache" "DawnWebGPUCache" `
  /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy app failed: $LASTEXITCODE" }

# Drop optional SDK trees with MAX_PATH-breaking filenames (NSIS CopyFiles 会误报「无法关闭」)
$pruneDirs = @(
  "app\core\node_modules\openclaw\node_modules\@mistralai"
)
foreach ($rel in $pruneDirs) {
  $p = Join-Path $Dest $rel
  if (Test-Path $p) {
    Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  pruned long-path package: $rel"
  }
}

# 2) Config server + root launchers
Write-Host "[2/4] Copy launchers + config-server ..."
if (Test-Path (Join-Path $PortableRoot "config-server")) {
  & robocopy (Join-Path $PortableRoot "config-server") (Join-Path $Dest "config-server") /E `
    /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
}
Get-ChildItem $PortableRoot -File | ForEach-Object {
  Copy-Item $_.FullName (Join-Path $Dest $_.Name) -Force
}

# 3) Minimal data skeleton (no browser / agents / secrets)
Write-Host "[3/4] Build clean data\ skeleton ..."
$data = Join-Path $Dest "data"
$state = Join-Path $data ".openclaw"
foreach ($d in @(
  $data,
  $state,
  (Join-Path $data "logs"),
  (Join-Path $data "memory"),
  (Join-Path $data "backups"),
  (Join-Path $data ".pids"),
  (Join-Path $data "npm-cache"),
  (Join-Path $state "browser"),
  (Join-Path $state "agents"),
  (Join-Path $state "workspace")
)) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
}

# Keep a SAFE openclaw.json: gateway-only, no ${ENV} secret refs.
# （带 secret 引用的模板会在缺 API Key 时导致 gateway 直接启动失败）
$cfgDst = Join-Path $state "openclaw.json"
Set-Content -Path $cfgDst -Encoding utf8 -Value @'
{
  "gateway": {
    "mode": "local",
    "port": 18789,
    "bind": "loopback",
    "auth": { "mode": "token" },
    "http": {
      "endpoints": {
        "chatCompletions": { "enabled": true },
        "responses": { "enabled": true }
      }
    }
  },
  "agents": {
    "defaults": {
      "skipBootstrap": true
    }
  },
  "browser": {
    "ssrfPolicy": {
      "dangerouslyAllowPrivateNetwork": true,
      "allowedHostnames": [
        "g.dianping.com",
        "www.dianping.com",
        "life.douyin.com",
        "www.douyin.com",
        "yl-saas.xiyihangye.com",
        "127.0.0.1",
        "localhost"
      ]
    }
  }
}
'@

# 让 Start-OpenClaw 启动前加载 data\.openclaw\.env（用 Node 修补，避免 PS 字符串展开破坏脚本）
$startPs1 = Join-Path $Dest "Start-OpenClaw.ps1"
$patchJs = Join-Path $PSScriptRoot "patch-start-openclaw-dotenv.js"
if ((Test-Path $startPs1) -and (Test-Path $patchJs)) {
  & node $patchJs $startPs1
  if ($LASTEXITCODE -ne 0) { throw "Failed to patch Start-OpenClaw.ps1 for .env loading" }
}

# Do NOT copy: gateway-token.txt, .env, browser profile, agents, logs, media, state dumps
# First Start-OpenClaw.bat will generate a fresh gateway-token.txt
# API keys: write to data\.openclaw\.env after install (OPENCLAW_USB_DEEPSEEK_API_KEY=...)

$note = @"
OpenClaw USB Portable - CLEAN pack
==================================
This package has NO browser login/cookies, NO chat history, NO gateway token.

First run on target PC:
1. Extract this folder to a writable path (e.g. D:\OpenClaw-USB-Portable)
2. Double-click Start-OpenClaw.bat
3. Open config page, fill API keys, save, restart Start-OpenClaw.bat
4. Point openclawProject .env:
   OPENCLAW_PORTABLE_ROOT=<this folder path>

Stripped from dirty portable:
- data\.openclaw\browser (Chrome profile)
- data\.openclaw\agents / media / logs / state dumps
- gateway-token.txt (regenerated on first start)
- data\.openclaw\.env (if any)

Kept:
- app\runtime (Node)
- app\core (OpenClaw)
- config-server, Start/Stop scripts
- data\.openclaw\openclaw.json (template)
"@
Set-Content -Path (Join-Path $Dest "CLEAN-PACK.txt") -Value $note -Encoding utf8
Set-Content -Path (Join-Path $OutDir "OpenClaw-CLEAN-README.txt") -Value $note -Encoding utf8

# 4) Zip (tar handles long paths better than Compress-Archive on Windows)
if (-not $SkipZip) {
  Write-Host "[4/4] Zipping -> $ZipPath"
  if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
  $tar = Get-Command tar.exe -ErrorAction SilentlyContinue
  if ($tar) {
    # -a: auto format from .zip; -C parent so archive root is OpenClaw-USB-Portable\
    & tar.exe -a -c -f $ZipPath -C $Stage "OpenClaw-USB-Portable"
    if ($LASTEXITCODE -ne 0) { throw "tar zip failed: $LASTEXITCODE" }
  } else {
    Compress-Archive -Path $Dest -DestinationPath $ZipPath -CompressionLevel Optimal
  }
  $mb = (Get-Item $ZipPath).Length / 1MB
  Write-Host ("OK zip {0:N1} MB" -f $mb)
} else {
  Write-Host "[4/4] SkipZip - stage left at $Dest"
}

Write-Host ""
Write-Host "Done."
Write-Host "  Folder: $Dest"
if (-not $SkipZip -and $ZipPath) { Write-Host "  Zip:    $ZipPath" }
