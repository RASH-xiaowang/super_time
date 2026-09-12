@echo off
rem Super Time launcher - ASCII only to avoid codepage issues
setlocal
set "ELECTRON_RUN_AS_NODE="
set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
set "ELECTRON=%APP_DIR%\node_modules\electron\dist\electron.exe"
if not exist "%ELECTRON%" (
  echo [ERROR] Electron not found: %ELECTRON%
  pause
  exit /b 1
)
start "Super Time" "%ELECTRON%" "%APP_DIR%"
endlocal
exit /b 0
