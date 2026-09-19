@echo off
REM Detached relaunch helper used by the browser "Check for manager updates" button.
REM Waits so the old node process can exit and free the port, then runs the normal launcher.
setlocal
set "PORT=%~1"
set "HOSTADDR=%~2"
if "%PORT%"=="" set "PORT=3230"
if "%HOSTADDR%"=="" set "HOSTADDR=0.0.0.0"
cd /d "%~dp0"
timeout /t 2 /nobreak >nul
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0StartIcarusManager.ps1" -Port %PORT% -HostAddress "%HOSTADDR%" -NoBrowser
if errorlevel 1 (
  echo Icarus Manager failed to restart.
  pause
)
