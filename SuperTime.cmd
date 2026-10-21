@echo off
rem Super Time launcher - delegates to the "latest code" launcher in THIS tree.
rem The perf branch has been merged into this workspace (release/v1.0.9 + merge),
rem so the latest build is built and launched from here. Latest.cmd / scripts\launch-latest.mjs
rem rebuild when sources are newer, close stale dev instances, then start Electron.
rem Pass --no-launch / --force-build / --skip-build through it.
rem ASCII only (cmd codepage); Chinese status lines are printed by the Node launcher.
rem IMPORTANT: keep this file LF-safe: no parenthesized blocks / labels, only single-line ifs.
setlocal
set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
set "LATEST=%ROOT%\Latest.cmd"
if not exist "%LATEST%" echo [ERROR] Latest launcher not found: "%LATEST%"
if not exist "%LATEST%" echo         Restore Latest.cmd, or run: npm run dev
if not exist "%LATEST%" pause
if not exist "%LATEST%" exit /b 1
call "%LATEST%" %*
set "RC=%ERRORLEVEL%"
exit /b %RC%
