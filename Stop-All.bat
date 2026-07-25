@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Stopping OpenClaw CS services...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Stop-All.ps1" %*
if errorlevel 1 pause
