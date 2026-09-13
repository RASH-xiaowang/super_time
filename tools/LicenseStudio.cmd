@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
set "TOOLS_DIR=%~dp0"
set "ROOT=%TOOLS_DIR%.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "ELECTRON=%ROOT%\node_modules\electron\dist\electron.exe"
set "APP_DIR=%TOOLS_DIR%license-studio"
if not exist "%ELECTRON%" (
  echo [ERROR] Electron not found: %ELECTRON%
  pause
  exit /b 1
)
if not exist "%APP_DIR%\main.js" (
  echo [ERROR] App not found: %APP_DIR%\main.js
  pause
  exit /b 1
)
start "License Studio" "%ELECTRON%" "%APP_DIR%"
endlocal
