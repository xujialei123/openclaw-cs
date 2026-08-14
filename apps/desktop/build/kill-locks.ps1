# Called by NSIS before overwrite. Kill only exact desktop exe + portable runtimes
# that lock INSTDIR. Do not match installer names (OpenClaw-CS-Setup-*.exe).
$ErrorActionPreference = "SilentlyContinue"

foreach ($n in @("OpenClaw-CS")) {
  Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force
}

# Exact image name via CIM (avoid substring hits on Setup exe)
Get-CimInstance Win32_Process -Filter "Name = 'OpenClaw-CS.exe'" -ErrorAction SilentlyContinue |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Get-CimInstance Win32_Process | Where-Object {
  $path = [string]$_.ExecutablePath
  $cmd = [string]$_.CommandLine
  if ($path -match '\\OpenClaw-CS\.exe$') { return $true }
  if ($path -match 'openclaw-portable|@openclawdesktop|openclaw-desktop') { return $true }
  if ($cmd -match 'openclaw-portable|@openclawdesktop|Start-OpenClaw\.ps1|cs-watch\.js') { return $true }
  return $false
} | ForEach-Object {
  # Never kill the NSIS setup process itself
  if ($_.Name -match 'Setup|nsis') { return }
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

Start-Sleep -Seconds 1
