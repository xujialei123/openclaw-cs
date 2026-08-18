#Requires -Version 5.1
<#
.SYNOPSIS
  Build Windows installer for OpenClaw CS desktop (electron-builder NSIS).

.DESCRIPTION
  Two locked-role installers (no edge/fullstack choice at first-run):
  - edge      -> DEPLOY_ROLE=edge, OpenClawDesktop-Setup-Edge-*.exe
  - fullstack -> DEPLOY_ROLE=all,  OpenClawDesktop-Setup-Full-*.exe

  Flow:
  1) Stage business tree -> dist-pack/desktop-stage/openclaw-cs
  2) Stage clean OpenClaw portable -> dist-pack/desktop-stage/openclaw-portable
  3) npm install --omit=dev in stage
  4) electron-builder -> dist-pack/desktop/*.exe

  Login cookies are NOT packed; scan-login once after install.

  NOTE: Keep this .ps1 ASCII-only. Chinese UI strings live in
  apps/desktop/product-profile.edge.json / product-profile.fullstack.json
  (UTF-8). Windows PowerShell 5.1 often breaks UTF-8-without-BOM Chinese.
#>
param(
  [ValidateSet("edge", "fullstack", "both")]
  [string]$Mode = "edge",
  [switch]$SkipInstall,
  [switch]$SkipBuilder,
  [switch]$SkipPortable,
  [string]$PortableRoot = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$StageRoot = Join-Path $Root "dist-pack\desktop-stage"
$Stage = Join-Path $StageRoot "openclaw-cs"
$PortableStage = Join-Path $StageRoot "openclaw-portable"
$DesktopApp = Join-Path $Root "apps\desktop"
$OutDir = Join-Path $Root "dist-pack\desktop"
$CleanScript = Join-Path $Root "scripts\Pack-OpenClaw-Clean.ps1"
$ProfileFile = Join-Path $DesktopApp "product-profile.json"
$ProfileBackup = Join-Path $DesktopApp "product-profile.dev.json.bak"
$ProfileEdge = Join-Path $DesktopApp "product-profile.edge.json"
$ProfileFull = Join-Path $DesktopApp "product-profile.fullstack.json"
$ProfileDevTemplate = Join-Path $DesktopApp "product-profile.dev.json"

# load .env for portable root
$EdgeEnv = Join-Path $Root ".env"
if (Test-Path $EdgeEnv) {
  Get-Content $EdgeEnv -Encoding UTF8 | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { return }
    $k = $line.Substring(0, $eq).Trim()
    $v = $line.Substring($eq + 1).Trim().Trim('"').Trim("'")
    if ($k -and -not [Environment]::GetEnvironmentVariable($k, "Process")) {
      [Environment]::SetEnvironmentVariable($k, $v, "Process")
    }
  }
}

function Remove-DirForce([string]$Path, [switch]$AllowPartial) {
  if (-not (Test-Path $Path)) { return }
  Get-ChildItem -LiteralPath $Path -Force -ErrorAction SilentlyContinue | ForEach-Object {
    try {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop
    } catch {
      Write-Warning ("skip locked: " + $_.FullName)
    }
  }
  cmd.exe /c "rmdir /s /q `"$Path`"" | Out-Null
  Start-Sleep -Milliseconds 400
  if (Test-Path $Path) {
    $empty = Join-Path $env:TEMP ("oc-empty-" + [guid]::NewGuid().ToString("n"))
    New-Item -ItemType Directory -Force -Path $empty | Out-Null
    & robocopy $empty $Path /MIR /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
    Remove-Item $empty -Force -ErrorAction SilentlyContinue
    Remove-Item $Path -Recurse -Force -ErrorAction SilentlyContinue
  }
  if (Test-Path $Path) {
    if ($AllowPartial) {
      Write-Warning "cannot fully remove: $Path (close any open Setup window, then delete leftover Setup-*.exe manually)"
      return
    }
    throw "cannot remove stage dir: $Path"
  }
}

function Set-EnvFileValue([string]$File, [string]$Key, [string]$Value) {
  $text = ""
  if (Test-Path $File) {
    $text = Get-Content $File -Raw -ErrorAction SilentlyContinue
    if ($null -eq $text) { $text = "" }
  }
  $line = "$Key=$Value"
  if ($text -match "(?m)^$([regex]::Escape($Key))=") {
    $text = [regex]::Replace($text, "(?m)^$([regex]::Escape($Key))=.*$", $line)
  } else {
    $text = $text.TrimEnd() + "`n" + $line + "`n"
  }
  [System.IO.File]::WriteAllText($File, $text.TrimEnd() + "`n")
}

function Write-ProductProfile([string]$Kind) {
  $src = if ($Kind -eq "edge") { $ProfileEdge } else { $ProfileFull }
  if (-not (Test-Path $src)) { throw "missing profile template: $src" }
  Copy-Item $src $ProfileFile -Force
  $helper = Join-Path $Root "scripts\pack-desktop-profile.js"
  if (-not (Test-Path $helper)) { throw "missing $helper" }
  $shortcut = & node $helper stamp $ProfileFile
  if ($LASTEXITCODE -ne 0) { throw "stamp product-profile failed" }
  Write-Host "  product-profile: $Kind (locked)"
  return [string]$shortcut
}

function Restore-ProductProfileDev {
  if (Test-Path $ProfileBackup) {
    Copy-Item $ProfileBackup $ProfileFile -Force
    Remove-Item $ProfileBackup -Force -ErrorAction SilentlyContinue
    Write-Host "  restored product-profile.json for local dev"
    return
  }
  $devSrc = if (Test-Path $ProfileDevTemplate) { $ProfileDevTemplate } else { $ProfileFull }
  if (Test-Path $devSrc) {
    Copy-Item $devSrc $ProfileFile -Force
    $helper = Join-Path $Root "scripts\pack-desktop-profile.js"
    if (Test-Path $helper) {
      & node $helper unlock $ProfileFile | Out-Null
    }
  }
}

function Copy-Tree([string]$Rel) {
  $src = Join-Path $Root $Rel
  if (-not (Test-Path $src)) {
    Write-Warning "skip missing: $Rel"
    return
  }
  $dst = Join-Path $Stage $Rel
  $parent = Split-Path $dst -Parent
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  if ((Get-Item $src).PSIsContainer) {
    Copy-Item -Path $src -Destination $dst -Recurse -Force
  } else {
    Copy-Item -Path $src -Destination $dst -Force
  }
  Write-Host "  + $Rel"
}

function Invoke-PackOne([string]$Kind) {
  $isEdge = $Kind -eq "edge"
  $packModeToken = if ($isEdge) { "Edge" } else { "Full" }
  $deployRole = if ($isEdge) { "edge" } else { "all" }

  Write-Host ""
  Write-Host "=== Pack Desktop Installer ($Kind) ==="
  Write-Host "Root:  $Root"
  Write-Host "Stage: $Stage"
  Write-Host "Portable bundled: $(-not $SkipPortable)"

  Remove-DirForce $StageRoot
  New-Item -ItemType Directory -Force -Path $Stage | Out-Null

  Write-Host "[1/5] Staging business files..."
  $paths = @(
    "package.json",
    "package-lock.json",
    ".env.example",
    "AGENTS.md",
    "TOOLS.md",
    "apps\edge-worker",
    "apps\wecom-bridge",
    "apps\console\package.json",
    "packages",
    "scripts",
    "admin",
    "config\cs-runtime.example.json",
    "config\cs-runtime.prod.example.json",
    "config\scenarios.example.json",
    "docs",
    "infra",
    "knowledge\raw",
    "knowledge\cards",
    "knowledge\index\meta.json",
    "knowledge\index\wiki.json",
    "brain\README.md",
    "brain\rag-service\package.json",
    "brain\rag-service\package-lock.json",
    "brain\rag-service\dist",
    "brain\.env.example"
  )
  foreach ($p in $paths) { Copy-Tree $p }

  Get-ChildItem -Path $Stage -Recurse -Directory -Filter "node_modules" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
  Get-ChildItem -Path $Stage -Recurse -Directory -Filter ".next" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }

  New-Item -ItemType Directory -Force -Path (Join-Path $Stage "memory") | Out-Null
  Set-Content -Path (Join-Path $Stage "memory\.gitkeep") -Value "" -Encoding ascii
  New-Item -ItemType Directory -Force -Path (Join-Path $Stage "config") | Out-Null
  Copy-Item (Join-Path $Root "config\cs-runtime.example.json") (Join-Path $Stage "config\cs-runtime.json") -Force
  Copy-Item (Join-Path $Root "config\scenarios.example.json") (Join-Path $Stage "config\scenarios.json") -Force
  Copy-Item (Join-Path $Root ".env.example") (Join-Path $Stage ".env") -Force

  $envFile = Join-Path $Stage ".env"
  Set-EnvFileValue $envFile "OPENCLAW_PORTABLE_ROOT" ""
  Set-EnvFileValue $envFile "DEPLOY_ROLE" $deployRole
  if ($isEdge) {
    Set-EnvFileValue $envFile "RAG_BASE_URL" ""
  } else {
    Set-EnvFileValue $envFile "RAG_BASE_URL" "http://127.0.0.1:8787"
  }

  Write-Host "[2/5] Staging clean OpenClaw portable..."
  if (-not $SkipPortable) {
    if (-not (Test-Path $CleanScript)) { throw "missing $CleanScript" }
    $pr = if ($PortableRoot) { $PortableRoot } elseif ($env:OPENCLAW_PORTABLE_ROOT) { $env:OPENCLAW_PORTABLE_ROOT } else { "F:\OpenClaw-USB-Portable" }
    Write-Host "  source: $pr"
    & $CleanScript -PortableRoot $pr -DestDir $PortableStage -SkipZip
    if (-not (Test-Path (Join-Path $PortableStage "app\runtime\node-win-x64\node.exe"))) {
      throw "portable stage missing node.exe: $PortableStage"
    }
    $psz = (Get-ChildItem $PortableStage -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
    Write-Host ("  OK portable stage {0:N1} MB (no login profile)" -f ($psz / 1MB))
  } else {
    Write-Warning "SkipPortable - installer will require manual OpenClaw path"
    New-Item -ItemType Directory -Force -Path $PortableStage | Out-Null
    Set-Content (Join-Path $PortableStage "PLACEHOLDER.txt") "Portable skipped at build time." -Encoding utf8
  }

  Write-Host "[3/5] npm install --omit=dev in business stage..."
  if (-not $SkipInstall) {
    Push-Location $Stage
    try {
      npm install --omit=dev --no-audit --no-fund
      if ($LASTEXITCODE -ne 0) { throw "npm install failed in stage" }
    } finally {
      Pop-Location
    }
  } else {
    Write-Warning "SkipInstall"
  }

  $ragMain = Join-Path $Stage "brain\rag-service\dist\main.js"
  if (-not (Test-Path $ragMain)) {
    Write-Warning "rag-service dist missing in stage; Start-All may skip RAG unless built beforehand"
  }

  Write-Host "[4/5] Ensure electron + electron-builder..."
  Remove-Item Env:ELECTRON_CUSTOM_DIR -ErrorAction SilentlyContinue
  Remove-Item Env:npm_config_electron_mirror -ErrorAction SilentlyContinue
  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
  $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
  $env:OC_PACK_MODE = $packModeToken

  if (-not (Test-Path $ProfileBackup) -and (Test-Path $ProfileFile)) {
    Copy-Item $ProfileFile $ProfileBackup -Force
  }
  $shortcutName = Write-ProductProfile $Kind
  $env:OC_SHORTCUT_NAME = $shortcutName

  Push-Location $DesktopApp
  try {
    npm install --no-audit --no-fund
    npm install --save-dev electron-builder@25.1.8 --no-audit --no-fund
    if (-not $SkipBuilder) {
      Write-Host "[5/5] electron-builder ($packModeToken)..."
      $env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
      # Separate output dirs so -Mode both does not wipe the first exe
      $modeOutRel = "../../dist-pack/desktop/$packModeToken"
      $modeOutAbs = Join-Path $OutDir $packModeToken
      New-Item -ItemType Directory -Force -Path $modeOutAbs | Out-Null
      npx electron-builder --win --x64 --config electron-builder.yml "-c.directories.output=$modeOutRel"
      if ($LASTEXITCODE -ne 0) { throw "electron-builder failed ($Kind)" }
      Get-ChildItem $modeOutAbs -Filter "*.exe" -ErrorAction SilentlyContinue | ForEach-Object {
        Copy-Item $_.FullName (Join-Path $OutDir $_.Name) -Force
        Write-Host ("  copied {0}" -f $_.Name)
      }
    } else {
      Write-Warning "SkipBuilder"
    }
  } finally {
    Pop-Location
  }
}

# --- main ---
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
if (-not $SkipBuilder -and $Mode -ne "both") {
  Get-ChildItem $OutDir -Filter "OpenClawDesktop-Setup-*.exe" -ErrorAction SilentlyContinue |
    Where-Object {
      if ($Mode -eq "edge") { $_.Name -match "-Edge-" } else { $_.Name -match "-Full-" }
    } |
    ForEach-Object {
      try { Remove-Item $_.FullName -Force } catch { Write-Warning "locked: $($_.FullName)" }
    }
} elseif (-not $SkipBuilder) {
  Write-Host "Cleaning old installer output: $OutDir"
  Remove-DirForce $OutDir -AllowPartial
  New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
}

try {
  if ($Mode -eq "both") {
    Invoke-PackOne "edge"
    Invoke-PackOne "fullstack"
  } else {
    Invoke-PackOne $Mode
  }
} finally {
  Restore-ProductProfileDev
}

Write-Host ""
Write-Host "Done. Installers under: $OutDir"
Get-ChildItem $OutDir -Filter *.exe -ErrorAction SilentlyContinue | ForEach-Object {
  Write-Host ("  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB))
}
Write-Host ""
Write-Host "Edge = shop PC (fill company RAG URL). Full = local Docker mid + edge."
Write-Host "Role is baked into the package; first-run wizard no longer asks edge vs fullstack."
