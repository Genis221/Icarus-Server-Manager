@echo off
REM Detached relaunch helper used by the browser "Restart Server Manager" button.
REM Waits so the old node process can exit and free the port, then runs the normal launcher.
setlocal
set "PORT=%~1"
set "HOSTADDR=%~2"
if "%PORT%"=="" set "PORT=3230"
if "%HOSTADDR%"=="" set "HOSTADDR=0.0.0.0"
cd /d "%~dp0"
if not exist "%~dp0data" mkdir "%~dp0data"
>> "%~dp0data\restart.log" echo %DATE% %TIME% helper started port=%PORT% host=%HOSTADDR%
timeout /t 3 /nobreak >nul
>> "%~dp0data\restart.log" echo %DATE% %TIME% launching StartIcarusManager.ps1
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0StartIcarusManager.ps1" -Port %PORT% -HostAddress "%HOSTADDR%" -NoBrowser
set "EC=%ERRORLEVEL%"
>> "%~dp0data\restart.log" echo %DATE% %TIME% StartIcarusManager.ps1 exited code=%EC%
if not "%EC%"=="0" (
  echo Icarus Manager failed to restart. See data\restart.log
  pause
)
exit /b %EC%
