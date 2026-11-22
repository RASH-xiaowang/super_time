@echo off
setlocal EnableExtensions
set "TEST_DIR=%~dp0"
set "ROOT=%TEST_DIR%.."
set "OUT=%~1"
if not defined OUT set "OUT=%TEST_DIR%.tmp\queue_state"
if not exist "%OUT%" mkdir "%OUT%"

set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo [error] vswhere.exe not found.
    exit /b 1
)
for /f "usebackq tokens=*" %%I in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%I"
if not defined VSDIR (
    echo [error] MSVC x64 toolchain not found.
    exit /b 1
)

call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1

pushd "%ROOT%"
if errorlevel 1 exit /b 1
cl /nologo /O2 /MT /c /w ^
    /DSQLITE_THREADSAFE=1 /DSQLITE_OMIT_LOAD_EXTENSION /DSQLITE_OMIT_DEPRECATED ^
    /DSQLITE_OMIT_PROGRESS_CALLBACK /DSQLITE_OMIT_SHARED_CACHE ^
    /DSQLITE_OMIT_TCL_VARIABLE /DSQLITE_OMIT_TRACE ^
    /DSQLITE_OMIT_GET_TABLE /DSQLITE_OMIT_COMPILEOPTION_DIAGS ^
    /DSQLITE_DEFAULT_MEMSTATUS=0 /DSQLITE_MAX_MMAP_SIZE=0 ^
    /Fo"%OUT%\sqlite3.obj" "third_party\sqlite\sqlite3.c"
if errorlevel 1 (
    popd
    exit /b 1
)
cl /nologo /std:c++17 /utf-8 /O2 /MT /EHsc /W4 /permissive- ^
    /DUNICODE /D_UNICODE ^
    /Fo"%OUT%\\" /Fe"%OUT%\queue_state_test.exe" ^
    "tests\queue_state_test.cpp" "src\queue_store.cpp" "%OUT%\sqlite3.obj"
set "RESULT=%ERRORLEVEL%"
popd
exit /b %RESULT%
