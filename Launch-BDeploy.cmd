@echo off
setlocal

cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\powershell\Launch-BDeploy.ps1"
if errorlevel 1 (
  echo [BDeploy] Launch failed.
  pause
  exit /b 1
)
