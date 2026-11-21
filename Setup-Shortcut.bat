@echo off
title X GYM - Setup
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-shortcut.ps1"
if %ERRORLEVEL% EQU 0 (
    echo.
    echo  ======================================================
    echo   SUCCESS: X GYM shortcut created with icon on Desktop!
    echo  ======================================================
    echo.
) else (
    echo.
    echo  [ERROR] Setup failed.
    echo.
)
ping -n 4 127.0.0.1 >nul
