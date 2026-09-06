@echo off
title Icarus Server Manager
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0StartIcarusManager.ps1"
if errorlevel 1 pause
