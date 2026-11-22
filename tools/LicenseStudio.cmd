@echo off
setlocal
set "ROOT=%~dp0.."
for %%I in ("%ROOT%") do set "ROOT=%%~fI"
set "EXE=%ROOT%\apps\license-studio\build\LicenseStudio.exe"
if not exist "%EXE%" (
  echo [ERROR] 未找到 Win32 签发台: %EXE%
  echo 请先运行: %ROOT%\apps\license-studio\build.bat
  pause
  exit /b 1
)
start "License Studio" "%EXE%"
endlocal
