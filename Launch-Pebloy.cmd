@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\powershell\Launch-Pebloy.ps1"
if errorlevel 1 (
  echo [Pebloy] Launch failed.
  pause
  exit /b 1
)