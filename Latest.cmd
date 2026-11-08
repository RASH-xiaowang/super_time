@echo off
rem Super Time - compatibility wrapper for the former launcher name.
rem SuperTime.cmd is the canonical entry point; this file keeps existing
rem shortcuts working and runs the same build-and-launch workflow.
rem ASCII only (cmd codepage); Chinese status lines are printed by Node.
rem IMPORTANT: keep this file LF-safe: no parenthesized blocks / labels.
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node scripts\launch-latest.mjs %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" echo.
if not "%RC%"=="0" echo [Super Time] launch failed, exit code %RC%
if not "%RC%"=="0" pause
endlocal
exit /b %RC%
