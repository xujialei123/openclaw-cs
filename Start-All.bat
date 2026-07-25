@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Starting OpenClaw CS (admin + watch)...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Start-All.ps1" %*
if errorlevel 1 pause
