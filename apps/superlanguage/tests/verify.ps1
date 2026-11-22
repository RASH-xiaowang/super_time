[CmdletBinding()]
param(
    [string]$BuildExe = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Add-VerifyLog {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [AllowEmptyString()][string]$Message
    )
    Add-Content -LiteralPath $Path -Value $Message -Encoding UTF8
}

function Invoke-LoggedNativeCommand {
    param(
        [Parameter(Mandatory = $true)][string]$LogPath,
        [Parameter(Mandatory = $true)][string]$FilePath,
        [string[]]$Arguments = @()
    )
    # Windows PowerShell 5.1 wraps redirected native stderr lines in ErrorRecords;
    # under 'Stop' the first stderr line would abort the script unlogged.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $FilePath @Arguments 2>&1 | ForEach-Object {
            $line = [string]$_
            Add-VerifyLog -Path $LogPath -Message $line
            Write-Host $line
        }
        return $LASTEXITCODE
    } catch {
        Add-VerifyLog -Path $LogPath -Message (
            "native_exception=$FilePath " + $_.Exception.Message)
        return 1
    } finally {
        $ErrorActionPreference = $previousPreference
    }
}

function Get-PathUnderRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $pathFull = [IO.Path]::GetFullPath($Path)
    return $pathFull.StartsWith(
        $rootFull + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase)
}

function Stop-TemporarySuperLanguageProcesses {
    param(
        [Parameter(Mandatory = $true)][string]$RunRoot,
        [Parameter(Mandatory = $true)][string]$LogPath
    )
    $processes = @(Get-Process -Name 'SuperLanguage' -ErrorAction SilentlyContinue)
    foreach ($process in $processes) {
        $processPath = $null
        try {
            $processPath = [string]$process.Path
        } catch {
            continue
        }
        if ([string]::IsNullOrWhiteSpace($processPath)) {
            continue
        }
        if (-not (Get-PathUnderRoot -Root $RunRoot -Path $processPath)) {
            continue
        }

        Add-VerifyLog -Path $LogPath -Message (
            "cleanup: stopping temporary SuperLanguage PID=$($process.Id) path=$processPath")
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        Wait-Process -Id $process.Id -Timeout 10 -ErrorAction SilentlyContinue
    }
}

$repositoryRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($BuildExe)) {
    $BuildExe = Join-Path $repositoryRoot 'build\SuperLanguage.exe'
}
$BuildExe = [IO.Path]::GetFullPath($BuildExe)
if (-not [IO.File]::Exists($BuildExe)) {
    throw "Build executable not found: $BuildExe"
}

$pythonCommand = Get-Command 'python.exe' -ErrorAction SilentlyContinue
$pythonPrefix = @()
if (-not $pythonCommand) {
    $pythonCommand = Get-Command 'py.exe' -ErrorAction SilentlyContinue
    if ($pythonCommand) {
        $pythonPrefix = @('-3')
    }
}
if (-not $pythonCommand) {
    throw 'Python 3 was not found on PATH.'
}

$runId = (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '-' +
    [guid]::NewGuid().ToString('N').Substring(0, 8)
$temporaryBase = [IO.Path]::GetFullPath(
    (Join-Path ([IO.Path]::GetTempPath()) 'supertime-tests'))
$runRoot = [IO.Path]::GetFullPath((Join-Path $temporaryBase $runId))
if (-not $runRoot.StartsWith(
        $temporaryBase + [IO.Path]::DirectorySeparatorChar,
        [StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe temporary run path: $runRoot"
}

New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
$verifyLog = Join-Path $runRoot 'verify.log'
Add-VerifyLog -Path $verifyLog -Message "run_id=$runId"
Add-VerifyLog -Path $verifyLog -Message "build_exe=$BuildExe"
Add-VerifyLog -Path $verifyLog -Message "run_root=$runRoot"

$existingSuperLanguage = @(Get-Process -Name 'SuperLanguage' -ErrorAction SilentlyContinue)
if ($existingSuperLanguage.Count -ne 0) {
    foreach ($process in $existingSuperLanguage) {
        $pathText = '<unavailable>'
        try {
            $pathText = [string]$process.Path
        } catch {
        }
        Add-VerifyLog -Path $verifyLog -Message (
            "refusing to start: existing SuperLanguage PID=$($process.Id) path=$pathText")
    }
    throw "An existing SuperLanguage process is running. Refusing to start isolated tests. Logs: $runRoot"
}

$pythonScript = Join-Path $PSScriptRoot 'verify_api.py'
if (-not [IO.File]::Exists($pythonScript)) {
    Add-VerifyLog -Path $verifyLog -Message "missing_python_driver=$pythonScript"
    throw "Python test driver not found: $pythonScript. Logs: $runRoot"
}

$pythonArguments = @($pythonPrefix) + @(
    $pythonScript,
    '--build-exe', $BuildExe,
    '--run-root', $runRoot
)

$driverExitCode = Invoke-LoggedNativeCommand -LogPath $verifyLog `
    -FilePath $pythonCommand.Source -Arguments $pythonArguments
if ($driverExitCode -ne 0) {
    Stop-TemporarySuperLanguageProcesses -RunRoot $runRoot -LogPath $verifyLog
    throw "Safe regression failed. Logs retained at: $runRoot"
}

$queueBuildScript = Join-Path $PSScriptRoot 'build_queue_state_test.cmd'
if (-not [IO.File]::Exists($queueBuildScript)) {
    Add-VerifyLog -Path $verifyLog -Message "missing_queue_build=$queueBuildScript"
    throw "Queue-state build script not found: $queueBuildScript. Logs: $runRoot"
}

$queueRoot = Join-Path $runRoot 'queue-state'
$queueBuildExitCode = Invoke-LoggedNativeCommand -LogPath $verifyLog `
    -FilePath 'cmd.exe' -Arguments @('/d', '/c', $queueBuildScript, $queueRoot)
if ($queueBuildExitCode -ne 0) {
    Add-VerifyLog -Path $verifyLog -Message "queue_state_build_failed=$queueBuildExitCode"
    throw "Queue-state test build failed. Logs retained at: $runRoot"
}

$queueTestExe = Join-Path $queueRoot 'queue_state_test.exe'
$queueTestExitCode = Invoke-LoggedNativeCommand -LogPath $verifyLog `
    -FilePath $queueTestExe
if ($queueTestExitCode -ne 0) {
    Add-VerifyLog -Path $verifyLog -Message "queue_state_test_failed=$queueTestExitCode"
    throw "Queue-state test failed. Logs retained at: $runRoot"
}

$remaining = @(
    Get-Process -Name 'SuperLanguage' -ErrorAction SilentlyContinue |
        Where-Object {
            try {
                $candidate = [string]$_.Path
                -not [string]::IsNullOrWhiteSpace($candidate) -and
                    (Get-PathUnderRoot -Root $runRoot -Path $candidate)
            } catch {
                $false
            }
        }
)
if ($remaining.Count -ne 0) {
    Add-VerifyLog -Path $verifyLog -Message (
        "failure: temporary SuperLanguage processes remained after a passing driver")
    Stop-TemporarySuperLanguageProcesses -RunRoot $runRoot -LogPath $verifyLog
    throw "Temporary SuperLanguage processes remained after the test run. Logs retained at: $runRoot"
}

try {
    Remove-Item -LiteralPath $runRoot -Recurse -Force
} catch {
    throw "Tests passed, but temporary cleanup failed for ${runRoot}: $($_.Exception.Message)"
}

Write-Output "PASS: isolated SuperLanguage API regression completed."
Write-Output "Temporary assets cleaned: $runRoot"
exit 0
