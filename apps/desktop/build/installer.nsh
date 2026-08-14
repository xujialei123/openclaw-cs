; Override electron-builder default "app cannot be closed" check.
; Default uses substring process match — installer OpenClaw-CS-Setup-*.exe
; falsely matches app OpenClaw-CS.exe and blocks install forever.
; We kill exact locks here and never show that MessageBox.

!macro customCheckAppRunning
  DetailPrint "Stopping OpenClaw-CS.exe and portable runtimes..."
  SetOutPath "$PLUGINSDIR"
  File /oname=kill-locks.ps1 "${BUILD_RESOURCES_DIR}\kill-locks.ps1"
  nsExec::ExecToLog 'powershell -NoProfile -ExecutionPolicy Bypass -File "$PLUGINSDIR\kill-locks.ps1"'
  Pop $R9
  nsExec::ExecToLog 'cmd /c taskkill /F /T /IM OpenClaw-CS.exe >nul 2>&1'
  Pop $R9
  Sleep 1200
  DetailPrint "Clearing old install directory..."
  RMDir /r "$INSTDIR"
  Sleep 600
!macroend

!macro customRemoveFiles
  DetailPrint "Removing install directory..."
  nsExec::ExecToLog 'cmd /c taskkill /F /T /IM OpenClaw-CS.exe >nul 2>&1'
  Pop $R9
  Sleep 500
  RMDir /r "$INSTDIR"
!macroend
