@echo off
setlocal

cd /d "%~dp0"

call "%~dp0Launch-Pebloy.cmd" %*
exit /b %errorlevel%
