@echo off
rem Super Time - always launch the latest build of the perf branch worktree.
rem ASCII only (cmd codepage), the Node launcher prints the Chinese messages.
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node scripts\launch-latest.mjs %*
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" (
  echo.
  echo [Super Time] launch failed, exit code %RC%
  pause
)
endlocal
exit /b %RC%
