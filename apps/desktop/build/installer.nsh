; Kill app + portable runtimes that lock INSTDIR, then wipe the folder.
; Helper script avoids embedding PowerShell "$_" in this .nsh (NSIS $ expansion).

!macro customCheckAppRunning
  DetailPrint "Stopping OpenClaw desktop and portable runtimes..."
  SetOutPath "$PLUGINSDIR"
  File /oname=kill-locks.ps1 "${BUILD_RESOURCES_DIR}\kill-locks.ps1"
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\kill-locks.ps1"'
  Pop $R9
  nsExec::ExecToLog 'cmd /c taskkill /F /T /IM OpenClaw-CS.exe >nul 2>&1'
  Pop $R9
  Sleep 1500
  DetailPrint "Clearing old install directory..."
  RMDir /r "$INSTDIR"
  Sleep 800
!macroend

!macro customRemoveFiles
  DetailPrint "Removing install directory..."
  RMDir /r "$INSTDIR"
!macroend
