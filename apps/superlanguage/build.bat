@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

rem A double-clicked run closes its console the moment the script exits, so every
rem error message would flash past unseen. Remember that launch style and pause
rem on failure; an interactive cmd (typed path) keeps the old behavior.
set "PAUSE_ON_ERROR="
echo %cmdcmdline% | findstr /i /c:"build.bat" >nul 2>&1 && set "PAUSE_ON_ERROR=1"

rem ============================================================
rem  SuperLanguage build script
rem    build.bat          build; refuses while this build\SuperLanguage.exe runs
rem    build.bat /kill    stop this build\SuperLanguage.exe, then build
rem    build.bat /check   environment/dependency checks only (no compile)
rem    build.bat /help    show this help
rem
rem  Process guard is path-aware and lock-aware (Windows PowerShell 5.1):
rem    - only a SuperLanguage.exe whose full path equals .\build\SuperLanguage.exe counts
rem      as "this build" (path compare is case-insensitive; unreadable paths
rem      are skipped), so a SuperLanguage.exe running from another checkout does
rem      not block this one;
rem    - if .\build\SuperLanguage.exe exists, a FileShare.None write-open attempt
rem      is the fallback lock probe: failure means the output is busy;
rem    - /kill only stops processes selected by the path match, never other
rem      SuperLanguage.exe instances; when ownership cannot be determined it
rem      reports an error instead of killing blindly.
rem
rem  Build inputs:
rem    src\*.cpp, src\*.h, assets\app.ico, assets\app.manifest,
rem    third_party\sqlite\sqlite3.c, third_party\sqlite\sqlite3.h
rem    tools\gen_icon.py is used only when assets\app.ico is missing.
rem ============================================================

set "MODE=build"
set "ARG=%~1"
if /i "%ARG%"=="/kill"  goto :arg_kill
if /i "%ARG%"=="/check" goto :arg_check
if /i "%ARG%"=="/help"  goto :usage
if /i "%ARG%"=="-h"     goto :usage
if "%ARG%"=="" goto :args_ok
echo [error] Unknown argument: %ARG%
echo         Run build.bat /help for usage.
goto :fail
:arg_kill
set "MODE=kill"
goto :args_ok
:arg_check
set "MODE=check"
goto :args_ok
:args_ok
set "START_TIME=%TIME%"

echo [1/6] Checking SuperLanguage process state ...
call :probe_guard
if errorlevel 40 goto :guard_unknown
if errorlevel 30 goto :guard_locked
if errorlevel 20 goto :guard_this
if errorlevel 10 goto :guard_other
if errorlevel 1 goto :guard_unknown
goto :guard_clear

:guard_clear
echo       No SuperLanguage.exe process is running for this build.
goto :guard_ready

:guard_other
echo       A SuperLanguage.exe runs from another directory; this build\SuperLanguage.exe is free.
goto :guard_ready

:guard_this
echo       This build\SuperLanguage.exe is running (path-matched) and locks the output file.
if /i "%MODE%"=="check" goto :guard_check_continue
if /i not "%MODE%"=="kill" goto :close_required
echo       Stopping this build\SuperLanguage.exe ...
call :stop_this_supertime
if errorlevel 1 goto :fail
goto :guard_ready

:guard_locked
echo       build\SuperLanguage.exe exists but is locked by an unidentified process.
if /i "%MODE%"=="check" goto :guard_check_continue
echo [error] build\SuperLanguage.exe is locked by another process. Close it and retry.
goto :fail

:guard_unknown
echo       Cannot determine whether a running SuperLanguage.exe belongs to this directory.
if /i "%MODE%"=="check" goto :guard_check_continue
echo [error] Refusing to build: cannot verify that build\SuperLanguage.exe is free.
echo         Check SuperLanguage.exe processes manually, then retry.
goto :fail

:guard_check_continue
echo       /check mode: continuing without stopping it.
goto :guard_ready

:close_required
echo [error] Close this build\SuperLanguage.exe first, or run: build.bat /kill
goto :fail

:guard_ready

if not exist "assets\app.ico" (
    echo [2/6] Generating icon ...
    python "tools\gen_icon.py"
    if errorlevel 1 goto :fail
) else (
    echo [2/6] Icon ready.
)

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo [error] vswhere.exe not found. Install Visual Studio Build Tools with the C++ workload.
    goto :fail
)

for /f "usebackq tokens=*" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%I"
if not defined VSDIR (
    echo [error] MSVC x64 toolchain not found.
    goto :fail
)

echo [3/6] Activating MSVC x64 environment ...
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 goto :fail
where cl >nul 2>&1
if errorlevel 1 (
    echo [error] cl.exe not found after activating MSVC.
    goto :fail
)
where rc >nul 2>&1
if errorlevel 1 (
    echo [error] rc.exe not found. Check the Windows SDK installation.
    goto :fail
)

echo [4/6] Validating dependencies ...
if not exist build mkdir build
if not exist "third_party\sqlite\sqlite3.c" (
    echo [error] third_party\sqlite\sqlite3.c is missing. Unpack the SQLite amalgamation there.
    goto :fail
)
echo       Dependencies OK.

if /i "%MODE%"=="check" (
    echo.
    echo Check OK. Guard state reported above; dependencies are OK.
    echo Started: %START_TIME%  Finished: %TIME%
    endlocal
    exit /b 0
)

echo [5/6] Compiling resources and SQLite 3 ...
rc /nologo /c 65001 /fo "build\app.res" "src\app.rc"
if errorlevel 1 goto :fail

cl /nologo /O2 /GL /MT /c /w ^
    /DSQLITE_THREADSAFE=1 /DSQLITE_OMIT_LOAD_EXTENSION /DSQLITE_OMIT_DEPRECATED ^
    /DSQLITE_OMIT_PROGRESS_CALLBACK /DSQLITE_OMIT_SHARED_CACHE ^
    /DSQLITE_OMIT_TCL_VARIABLE /DSQLITE_OMIT_TRACE /DSQLITE_OMIT_GET_TABLE ^
    /DSQLITE_OMIT_COMPILEOPTION_DIAGS /DSQLITE_DEFAULT_MEMSTATUS=0 ^
    /DSQLITE_MAX_MMAP_SIZE=0 ^
    /Fobuild\ "third_party\sqlite\sqlite3.c"
if errorlevel 1 goto :fail

echo [6/6] Compiling SuperLanguage.exe ...
cl /nologo /std:c++17 /utf-8 /O2 /Oi /GL /MT /EHsc /GR- /W4 /permissive- ^
    /DUNICODE /D_UNICODE /Fobuild\ /Febuild\SuperLanguage.exe ^
    "src\main.cpp" "src\automation.cpp" "src\api_server.cpp" "src\queue_store.cpp" ^
    "build\app.res" "build\sqlite3.obj" ^
    /link /SUBSYSTEM:WINDOWS /MANIFEST:NO /LTCG /OPT:REF /OPT:ICF ^
    /DYNAMICBASE /NXCOMPAT /INCREMENTAL:NO
if errorlevel 1 goto :fail

powershell -NoProfile -ExecutionPolicy Bypass -Command "$p=(Resolve-Path -LiteralPath 'build\SuperLanguage.exe').Path;$t=Get-Date;(Get-Item -LiteralPath $p).CreationTime=$t;(Get-Item -LiteralPath $p).LastWriteTime=$t"
if errorlevel 1 goto :fail

echo.
echo Built: build\SuperLanguage.exe
for %%F in ("build\SuperLanguage.exe") do echo Size: %%~zF bytes
set "HASH="
for /f "delims=" %%H in ('certutil -hashfile "build\SuperLanguage.exe" SHA256 2^>nul ^| findstr /R "^[0-9a-f][0-9a-f]*$"') do if not defined HASH set "HASH=%%H"
if defined HASH echo SHA256: !HASH!
echo Started: %START_TIME%  Finished: %TIME%
echo Restart SuperLanguage manually to run the new build.
endlocal
exit /b 0

rem ------------------------------------------------------------
rem  Guard helpers. Exit codes: 0 clear, 10 another directory's
rem  SuperLanguage.exe only, 20 this build\SuperLanguage.exe runs, 30 output
rem  file locked by an unidentified process, 40 cannot determine.
rem ------------------------------------------------------------
:probe_guard
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue';$t=[IO.Path]::GetFullPath((Join-Path (Get-Location).Path 'build\SuperLanguage.exe'));$m=0;$o=0;$u=0;foreach($p in @(Get-Process -Name SuperLanguage)){$q=$null;try{$q=$p.Path}catch{$q=$null};if($q){if([string]::Equals($q,$t,[StringComparison]::OrdinalIgnoreCase)){$m=1}else{$o=1}}else{$u=1}};$l=0;if(Test-Path -LiteralPath $t -PathType Leaf){try{$f=[IO.File]::Open($t,'Open','Write','None');$f.Close()}catch{$l=1}};if($m -eq 1){exit 20};if($l -eq 1){if($u -eq 1){exit 40};exit 30};if($o -eq 1){exit 10};if($u -eq 1){exit 10};exit 0" >nul 2>&1
exit /b %ERRORLEVEL%

:stop_this_supertime
powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue';$t=[IO.Path]::GetFullPath((Join-Path (Get-Location).Path 'build\SuperLanguage.exe'));for($i=0;$i -lt 50;$i++){$m=@();foreach($p in @(Get-Process -Name SuperLanguage)){$q=$null;try{$q=$p.Path}catch{$q=$null};if($q -and [string]::Equals($q,$t,[StringComparison]::OrdinalIgnoreCase)){$m+=$p}};if($m.Count -eq 0){$locked=$false;if(Test-Path -LiteralPath $t -PathType Leaf){try{$f=[IO.File]::Open($t,'Open','Write','None');$f.Close()}catch{$locked=$true}};if(-not $locked){exit 0}};foreach($p in $m){Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue};Start-Sleep -Milliseconds 100};exit 1" >nul 2>&1
exit /b %ERRORLEVEL%

:usage
echo.
echo Usage: build.bat [option]
echo   (no option)  build; refuses while this build\SuperLanguage.exe is running
echo   /kill        stop this build\SuperLanguage.exe (path-matched only), then build
echo   /check       run checks only (no compile)
echo   /help        show this help
echo.
echo Build inputs:
echo   src assets third_party\sqlite tools\gen_icon.py
echo.
exit /b 0

rem ------------------------------------------------------------
rem  Failure exit. Keeps the console open when the script was
rem  started by double-click so the error stays readable.
rem ------------------------------------------------------------
:fail
if defined PAUSE_ON_ERROR pause
endlocal
exit /b 1
