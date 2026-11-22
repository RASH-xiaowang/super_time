$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

Write-Host "[1/3] Locating MSVC..."
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
if (-not (Test-Path -LiteralPath $vswhere)) {
    throw "vswhere.exe not found: $vswhere"
}
$vsInstall = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsInstall) {
    throw "Visual Studio / Build Tools with C++ toolchain not found."
}
$vcvars = Join-Path $vsInstall "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path -LiteralPath $vcvars)) {
    throw "vcvars64.bat not found: $vcvars"
}
Write-Host "      Using $vsInstall"

if (-not (Test-Path -LiteralPath "build")) {
    New-Item -ItemType Directory -Path "build" | Out-Null
}

Write-Host "[2/3] Compiling LicenseStudio.exe..."
$compile = "/nologo /EHsc /std:c++17 /utf-8 /W4 /O2 /DUNICODE /D_UNICODE /I src /Fe:build\LicenseStudio.exe /Fo:build\ /Fd:build\ src\main.cpp /link /SUBSYSTEM:WINDOWS /MACHINE:X64 build\app.res user32.lib gdi32.lib comctl32.lib comdlg32.lib shell32.lib shlwapi.lib advapi32.lib"
$cmd = 'call "' + $vcvars + '" && rc /nologo /fo build\app.res src\app.rc && cl ' + $compile + " && echo BUILD_OK"
cmd.exe /c $cmd
if ($LASTEXITCODE -ne 0) {
    throw "compile failed with exit $LASTEXITCODE"
}

$exe = Join-Path $PSScriptRoot "build\LicenseStudio.exe"
if (-not (Test-Path -LiteralPath $exe)) {
    throw "compile reported success but exe is missing"
}
Write-Host "[3/3] Done."
Write-Host "      Output: $exe"
