@echo off
rem Super Time - always launch the latest build of the perf branch worktree.
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
