#Requires -Version 5.1
<#
.SYNOPSIS
  Pack openclawProject for another Windows PC (local all-in-one test).

.DESCRIPTION
  Output under dist-pack\:
    openclawProject-local-YYYYMMDD-HHmm.zip
    README-target.txt  (from docs/local-pack-target.md)

  OpenClaw portable (~1GB+) is NOT in the zip by default.
  Copy F:\OpenClaw-USB-Portable separately, or pass -IncludePortable.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Pack-LocalDeploy.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Pack-LocalDeploy.ps1 -IncludeEnv
#>
param(
  [switch]$IncludeEnv,
  [switch]$IncludePortable,
  [switch]$SkipZip,
  [string]$OutDir = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Stamp = Get-Date -Format "yyyyMMdd-HHmm"
if (-not $OutDir) { $OutDir = Join-Path $Root "dist-pack" }
$Stage = Join-Path $OutDir ("stage-" + $Stamp)
$ProjStage = Join-Path $Stage "openclawProject"
$ZipPath = Join-Path $OutDir ("openclawProject-local-" + $Stamp + ".zip")
$ReadmeSrc = Join-Path $Root "docs\local-pack-target.md"

New-Item -ItemType Directory -Force -Path $ProjStage | Out-Null

# rag-service needs brain\scripts\init-db.sql at runtime
$InfraSql = Join-Path $Root "infra\init-db.sql"
$BrainSqlDir = Join-Path $Root "brain\scripts"
if (Test-Path $InfraSql) {
  New-Item -ItemType Directory -Force -Path $BrainSqlDir | Out-Null
  Copy-Item $InfraSql (Join-Path $BrainSqlDir "init-db.sql") -Force
}

Write-Host "Staging project -> $ProjStage"
$rcArgs = @(
  $Root, $ProjStage, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1",
  "/XD", ".git", ".cursor", "dist-pack", ".next", "node_modules\.cache"
)
& robocopy @rcArgs | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed code=$LASTEXITCODE" }

# wipe runtime logs; keep empty memory/
$mem = Join-Path $ProjStage "memory"
New-Item -ItemType Directory -Force -Path $mem | Out-Null
Get-ChildItem $mem -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Set-Content -Path (Join-Path $mem ".gitkeep") -Value "" -Encoding ascii

if (-not $IncludeEnv) {
  foreach ($f in @(".env", "brain\.env")) {
    $p = Join-Path $ProjStage $f
    if (Test-Path $p) {
      Remove-Item $p -Force
      Write-Host "  stripped $f (pass -IncludeEnv to keep secrets)"
    }
  }
} else {
  Write-Warning "Included .env / brain\.env - do not share this zip publicly"
}

if (Test-Path $ReadmeSrc) {
  Copy-Item $ReadmeSrc (Join-Path $Stage "README-target.md") -Force
  Copy-Item $ReadmeSrc (Join-Path $OutDir "README-target.md") -Force
}

if ($IncludePortable) {
  $Portable = if ($env:OPENCLAW_PORTABLE_ROOT) { $env:OPENCLAW_PORTABLE_ROOT } else { "F:\OpenClaw-USB-Portable" }
  if (-not (Test-Path $Portable)) { throw "Portable missing: $Portable" }
  Write-Warning "Packing portable from $Portable (large, slow)"
  $PortStage = Join-Path $Stage "OpenClaw-USB-Portable"
  & robocopy $Portable $PortStage /E /XD "Crashpad" "ShaderCache" /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy portable failed code=$LASTEXITCODE" }
}

if (-not $SkipZip) {
  if (Test-Path $ZipPath) { Remove-Item $ZipPath -Force }
  Write-Host "Zipping -> $ZipPath"
  Compress-Archive -Path (Join-Path $Stage "*") -DestinationPath $ZipPath -CompressionLevel Optimal
  $len = (Get-Item $ZipPath).Length
  Write-Host ("OK zip {0:N1} MB" -f ($len / 1MB))
}

Write-Host ""
Write-Host "Done."
Write-Host "  Stage: $Stage"
if (-not $SkipZip) { Write-Host "  Zip:   $ZipPath" }
Write-Host "  Doc:   $OutDir\README-target.md"
Write-Host ""
Write-Host "Also copy portable folder to target PC (if not -IncludePortable):"
Write-Host "  Source: F:\OpenClaw-USB-Portable"
Write-Host "  Then set OPENCLAW_PORTABLE_ROOT in target .env"
