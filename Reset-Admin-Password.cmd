@echo off
setlocal EnableExtensions
title Icarus Server Manager — Reset admin password

REM One-shot helper: restarts Icarus Server Manager and prints a new Genis221
REM temporary password in the console window. Optional: set ICARUS_ADMIN_PASSWORD
REM first to choose the password.

cd /d "%~dp0"
echo This will reset the Genis221 admin password and sign everyone out of that account.
echo.
if defined ICARUS_ADMIN_PASSWORD (
  echo Using ICARUS_ADMIN_PASSWORD from the environment.
) else (
  echo A new temporary password will be printed in the Icarus Manager console after restart.
)
echo.
pause
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0StartIcarusManager.ps1" -ResetAdmin %*
