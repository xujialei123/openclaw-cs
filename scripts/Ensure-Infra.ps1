#Requires -Version 5.1
param(
  [string]$BrainRoot = "",
  [switch]$SkipPull
)

$ErrorActionPreference = "Stop"
$EdgeRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

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

Import-DotEnv (Join-Path $EdgeRoot ".env")
if (-not $BrainRoot) {
  if ($env:BRAIN_ROOT) { $BrainRoot = $env:BRAIN_ROOT }
  else { $BrainRoot = Join-Path $EdgeRoot "brain" }
}
# Legacy alias
if (-not (Test-Path $BrainRoot) -and $env:SKELETON_ROOT) { $BrainRoot = $env:SKELETON_ROOT }
Import-DotEnv (Join-Path $BrainRoot ".env")

$ComposeFile = Join-Path $EdgeRoot "infra\docker-compose.yml"
$InitSql = Join-Path $EdgeRoot "infra\init-db.sql"
if (-not (Test-Path $ComposeFile)) {
  # legacy fallback
  $ComposeFile = Join-Path $BrainRoot "docker-compose.yml"
  if (-not (Test-Path $ComposeFile) -and $env:SKELETON_ROOT) {
    $ComposeFile = Join-Path $env:SKELETON_ROOT "docker-compose.yml"
  }
}
if (-not (Test-Path $InitSql)) {
  $InitSql = Join-Path $BrainRoot "scripts\init-db.sql"
}

# rag-service 启动时读 CUSTOMER_AI_ROOT/scripts/init-db.sql（即 brain\scripts\）
$BrainInitSql = Join-Path $BrainRoot "scripts\init-db.sql"
if ((Test-Path $InitSql) -and ($InitSql -ne $BrainInitSql)) {
  New-Item -ItemType Directory -Force -Path (Split-Path $BrainInitSql -Parent) | Out-Null
  Copy-Item $InitSql $BrainInitSql -Force
}

$PostgresContainer = "customer-ai-postgres"
$RedisContainer = "customer-ai-redis"
$Images = @("pgvector/pgvector:pg16", "redis:7-alpine")

if (-not (Test-Path $ComposeFile)) {
  throw "docker-compose.yml missing under infra\ (or BRAIN_ROOT). Expected: $EdgeRoot\infra\docker-compose.yml"
}

function Find-DockerExe {
  $cmd = Get-Command docker -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $pf = [Environment]::GetEnvironmentVariable("ProgramFiles")
  $pf86 = [Environment]::GetEnvironmentVariable("ProgramFiles(x86)")
  $la = [Environment]::GetEnvironmentVariable("LOCALAPPDATA")
  foreach ($c in @(
    (Join-Path $pf "Docker\Docker\resources\bin\docker.exe"),
    (Join-Path $pf86 "Docker\Docker\resources\bin\docker.exe"),
    (Join-Path $la "Docker\resources\bin\docker.exe")
  )) {
    if ($c -and (Test-Path -LiteralPath $c)) { return $c }
  }
  return $null
}

function Invoke-Docker([string]$DockerExe, [string[]]$DockerArgs) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  & $DockerExe @DockerArgs 2>&1 | Out-Null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $old
  return $code
}

function Test-DockerReady([string]$DockerExe) { return (Invoke-Docker $DockerExe @("info")) -eq 0 }

function Start-DockerDesktopIfNeeded([string]$DockerExe) {
  if (Test-DockerReady $DockerExe) { return $true }
  $pf = [Environment]::GetEnvironmentVariable("ProgramFiles")
  $la = [Environment]::GetEnvironmentVariable("LOCALAPPDATA")
  $desktop = @(
    (Join-Path $pf "Docker\Docker\Docker Desktop.exe"),
    (Join-Path $la "Docker\Docker Desktop.exe")
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
  if ($desktop) {
    Write-Host "  Starting Docker Desktop..."
    Start-Process -FilePath $desktop | Out-Null
  } else {
    Write-Warning "  Docker Desktop not found."
  }
  for ($i = 0; $i -lt 90; $i++) {
    if (Test-DockerReady $DockerExe) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Test-ContainerRunning([string]$DockerExe, [string]$Name) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  $state = & $DockerExe inspect -f "{{.State.Running}}" $Name 2>$null
  $ErrorActionPreference = $old
  return $state -eq "true"
}

function Test-ImagePresent([string]$DockerExe, [string]$Ref) {
  return (Invoke-Docker $DockerExe @("image", "inspect", $Ref)) -eq 0
}

function Wait-PostgresReady([string]$DockerExe, [int]$Seconds = 90) {
  for ($i = 0; $i -lt $Seconds; $i += 2) {
    if ((Invoke-Docker $DockerExe @("exec", $PostgresContainer, "pg_isready", "-U", "postgres")) -eq 0) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Get-DatabaseName {
  $url = $env:DATABASE_URL
  if ([string]::IsNullOrWhiteSpace($url)) { return "customer_ai" }
  if ($url -match "/([^/?]+)(\?|$)") { return $Matches[1] }
  return "customer_ai"
}

Write-Host "=== Ensure Infra (this repo) ==="
Write-Host "Project: $EdgeRoot"
Write-Host "Brain:   $BrainRoot"
Write-Host "Compose: $ComposeFile"

$DockerExe = Find-DockerExe
if (-not $DockerExe) { throw "docker not found. Install Docker Desktop." }
Write-Host "  Docker: $DockerExe"
if (-not (Start-DockerDesktopIfNeeded $DockerExe)) { throw "Docker is not ready." }
Write-Host "  Docker engine: OK"

if (-not $SkipPull) {
  foreach ($img in $Images) {
    if (Test-ImagePresent $DockerExe $img) { Write-Host "  Image ready: $img"; continue }
    Write-Host "  Pulling $img ..."
    $old = $ErrorActionPreference; $ErrorActionPreference = "SilentlyContinue"
    $pullOut = & $DockerExe pull $img 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $old
    if ($code -ne 0) {
      Write-Warning ("  docker pull failed: {0}" -f $img)
      foreach ($line in @($pullOut | Select-Object -Last 6)) { Write-Host "    $line" }
    } else { Write-Host "  Pulled: $img" }
  }
}

$pgRun = Test-ContainerRunning $DockerExe $PostgresContainer
$rdRun = Test-ContainerRunning $DockerExe $RedisContainer
if ($pgRun -and $rdRun) {
  Write-Host "  Containers already running"
} else {
  $toStart = @()
  if ((Invoke-Docker $DockerExe @("inspect", $PostgresContainer)) -eq 0 -and -not $pgRun) { $toStart += $PostgresContainer }
  if ((Invoke-Docker $DockerExe @("inspect", $RedisContainer)) -eq 0 -and -not $rdRun) { $toStart += $RedisContainer }
  if ($toStart.Count -gt 0) {
    Write-Host ("  Starting existing: {0}" -f ($toStart -join ", "))
    [void](Invoke-Docker $DockerExe (@("start") + $toStart))
  }
  $pgRun = Test-ContainerRunning $DockerExe $PostgresContainer
  $rdRun = Test-ContainerRunning $DockerExe $RedisContainer
  if (-not ($pgRun -and $rdRun)) {
    Write-Host "  docker compose up -d (infra/)..."
    $composeDir = Split-Path -Parent $ComposeFile
    Push-Location $composeDir
    try {
      $old = $ErrorActionPreference; $ErrorActionPreference = "SilentlyContinue"
      $composeOut = & $DockerExe compose -f $ComposeFile up -d 2>&1
      $code = $LASTEXITCODE
      $ErrorActionPreference = $old
      if ($code -ne 0) {
        $pgRun = Test-ContainerRunning $DockerExe $PostgresContainer
        $rdRun = Test-ContainerRunning $DockerExe $RedisContainer
        if (-not ($pgRun -and $rdRun)) {
          foreach ($line in @($composeOut)) { Write-Host "  $line" }
          throw "docker compose up failed"
        }
      }
    } finally { Pop-Location }
  }
}

if (-not (Wait-PostgresReady $DockerExe 90)) { throw "PostgreSQL not ready" }
Write-Host "  Postgres: ready"
$dbName = Get-DatabaseName

if (Test-Path -LiteralPath $InitSql) {
  Write-Host "  Applying RAG schema..."
  $old = $ErrorActionPreference; $ErrorActionPreference = "SilentlyContinue"
  Get-Content -LiteralPath $InitSql -Raw -Encoding utf8 |
    & $DockerExe exec -i $PostgresContainer psql -U postgres -d $dbName -v ON_ERROR_STOP=1 2>&1 | Out-Null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $old
  if ($code -eq 0) { Write-Host "  RAG tables: OK" }
  else { Write-Warning "  init-db non-zero (ok if exists); rag-service will retry" }
} else {
  Write-Warning "  init-db.sql missing"
}

Write-Host "=== Infra ready (openclawProject/infra) ==="