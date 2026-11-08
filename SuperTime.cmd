@echo off
rem Super Time - the single Windows launcher for building and starting the app.
rem The Node launcher rebuilds when sources are newer, closes stale dev instances,
rem then starts Electron. Pass --no-launch / --force-build / --skip-build through it.
rem ASCII only (cmd codepage); Chinese status lines are printed by the Node launcher.
rem IMPORTANT: keep this file LF-safe: no parenthesized blocks / labels, only single-line ifs.
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
