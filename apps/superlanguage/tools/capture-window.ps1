<#
.SYNOPSIS
Captures a vertical slice of a SuperLanguage window as PNG.

.DESCRIPTION
Dev-only probe: capture part of the client area of the running
<repo>\build\SuperLanguage.exe. If -Hwnd is omitted or zero, the script requires
exactly one SuperLanguage.AutomationShell window belonging to the validated process.
A supplied window handle must belong to that same process.

The transcript redacts 32-character hexadecimal credential tokens. The PNG is
an image of live UI content.

.PARAMETER Top
Top coordinate of the captured slice. Defaults to 560.

.PARAMETER Height
Height of the captured slice. Defaults to 230.

.PARAMETER Name
Output PNG base name. Defaults to log-region.

.PARAMETER Hwnd
Window handle to capture. Zero scans for the validated main window.

.PARAMETER OutDir
Output directory. Defaults to <repo>\artifacts.

.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\capture-window.ps1 `
  -Top 560 -Height 230 -Name log-region
#>
param(
    [int]$Top = 560,
    [int]$Height = 230,
    [string]$Name = 'log-region',
    [long]$Hwnd = 0,
    [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$expectedExe = [IO.Path]::GetFullPath((Join-Path $root 'build\SuperLanguage.exe'))

function Protect-SensitiveText {
    param([AllowNull()][string]$Text)
    if ($null -eq $Text) { return '' }
    return [regex]::Replace(
        $Text,
        '(?i)(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])',
        '[REDACTED_TOKEN]')
}

function Get-ExactSuperLanguageProcess {
    if (-not [IO.File]::Exists($expectedExe)) {
        throw "Expected executable was not found: $expectedExe"
    }

    $candidates = @(Get-Process -Name 'SuperLanguage' -ErrorAction SilentlyContinue)
    if ($candidates.Count -eq 0) {
        throw "SuperLanguage is not running from the expected path: $expectedExe"
    }
    if ($candidates.Count -ne 1) {
        throw 'Multiple SuperLanguage processes were found; refusing because the target is ambiguous.'
    }

    $actualPath = $null
    try {
        $actualPath = [string]$candidates[0].Path
    } catch {
        throw 'The SuperLanguage process path is unreadable; refusing to continue.'
    }
    if ([string]::IsNullOrWhiteSpace($actualPath)) {
        throw 'The SuperLanguage process path is unavailable; refusing to continue.'
    }
    try {
        $actualPath = [IO.Path]::GetFullPath($actualPath)
    } catch {
        throw 'The SuperLanguage process path is invalid; refusing to continue.'
    }
    if (-not [string]::Equals($actualPath, $expectedExe, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The SuperLanguage process path does not exactly match: $expectedExe"
    }
    return $candidates[0]
}

$p = Get-ExactSuperLanguageProcess
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class C {
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool EnumWindows(Cb f, IntPtr l);
    public delegate bool Cb(IntPtr h, IntPtr l);
    public static IntPtr Target;
    public static int Count;
    private static int _processId;
    private static Cb _cb = new Cb(E);
    public static void Scan(int processId) {
        Target = IntPtr.Zero;
        Count = 0;
        _processId = processId;
        EnumWindows(_cb, IntPtr.Zero);
    }
    private static bool E(IntPtr h, IntPtr l) {
        var sb = new System.Text.StringBuilder(256);
        GetClassNameW(h, sb, 256);
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        if (sb.ToString() == "SuperLanguage.AutomationShell" && pid == (uint)_processId) {
            Count++;
            if (Target == IntPtr.Zero) { Target = h; }
        }
        return true;
    }
    public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[C]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null

$hwnd = [IntPtr]$Hwnd
if ($hwnd -eq [IntPtr]::Zero) {
    [C]::Scan($p.Id)
    if ([C]::Count -ne 1) {
        throw "Expected exactly one validated SuperLanguage main window; found $([C]::Count)."
    }
    $hwnd = [C]::Target
} else {
    $windowPid = [uint32]0
    [void][C]::GetWindowThreadProcessId($hwnd, [ref]$windowPid)
    if ([int]$windowPid -ne $p.Id) {
        throw 'The supplied window does not belong to the validated SuperLanguage process; refusing to continue.'
    }
}
if ($hwnd -eq [IntPtr]::Zero) { throw 'no SuperLanguage window' }

if (-not $OutDir) { $OutDir = Join-Path $root 'artifacts' }
if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}
$cl = New-Object C+RECT; [C]::GetClientRect($hwnd, [ref]$cl) | Out-Null
if ($cl.Right -lt 100 -or $cl.Bottom -lt 100) { throw "invalid client rect $($cl.Right)x$($cl.Bottom)" }
if ($Top -lt 0 -or $Top -ge $cl.Bottom) { throw "Top $Top is outside the client height $($cl.Bottom)" }
if ($Height -le 0) { throw "Height must be positive, got $Height" }
if ($Top + $Height -gt $cl.Bottom) { $Height = $cl.Bottom - $Top }
$bmp = New-Object System.Drawing.Bitmap($cl.Right, $cl.Bottom)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::Black)
$g.Dispose()
$gc = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $gc.GetHdc()
[C]::PrintWindow($hwnd, $hdc, 2) | Out-Null
$gc.ReleaseHdc($hdc)
$gc.Dispose()
$crop = New-Object System.Drawing.Bitmap($cl.Right, $Height)
$gp = [System.Drawing.Graphics]::FromImage($crop)
$gp.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gp.DrawImage(
    $bmp,
    (New-Object System.Drawing.Rectangle(0, 0, $cl.Right, $Height)),
    (New-Object System.Drawing.Rectangle(0, $Top, $cl.Right, $Height)),
    [System.Drawing.GraphicsUnit]::Pixel)
$gp.Dispose(); $bmp.Dispose()
$pngPath = Join-Path $OutDir ($Name + '.png')
$crop.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$crop.Dispose()
Protect-SensitiveText -Text ('WROTE ' + $pngPath)
