# Called by NSIS installer before overwrite. Ends OpenClaw desktop + portable runtimes
# that otherwise lock INSTDIR and trigger a fake "cannot close" dialog.
$ErrorActionPreference = "SilentlyContinue"
foreach ($n in @("OpenClaw-CS", "OpenClaw客服一体端")) {
  Get-Process -Name $n -ErrorAction SilentlyContinue | Stop-Process -Force
}
Get-CimInstance Win32_Process | Where-Object {
  ($_.ExecutablePath -and $_.ExecutablePath -match "openclaw-portable|openclawdesktop|openclaw-desktop|\\OpenClaw-CS\.exe") -or
  ($_.CommandLine -and $_.CommandLine -match "openclaw-portable|openclawdesktop|Start-OpenClaw|cs-watch\.js")
} | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1
