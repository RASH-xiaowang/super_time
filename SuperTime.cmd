@echo off
rem Super Time launcher - delegates to the "latest code" launcher.
rem The newest app lives in the perf branch worktree: .worktrees\perf-v1
rem (branch perf/resource-lifecycle-v1). That launcher rebuilds when sources are
rem newer, closes stale dev instances, then starts Electron - so every start is
rem the latest build. Pass --no-launch / --force-build / --skip-build through it.
rem ASCII only (cmd codepage); Chinese status lines are printed by the Node launcher.
rem IMPORTANT: keep this file LF-safe: no parenthesized blocks / labels, only single-line ifs.
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "LATEST=%ROOT%\.worktrees\perf-v1\Latest.cmd"
if not exist "%LATEST%" echo [ERROR] Latest launcher not found: "%LATEST%"
if not exist "%LATEST%" echo         The perf worktree may have been removed.
if not exist "%LATEST%" echo         Restore the worktree, then relaunch. Or run: npm run dev
if not exist "%LATEST%" pause
if not exist "%LATEST%" exit /b 1
call "%LATEST%" %*
set "RC=%ERRORLEVEL%"
exit /b %RC%
