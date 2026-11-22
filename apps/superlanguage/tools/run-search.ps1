<#
.SYNOPSIS
Runs the SuperLanguage search probe against the current project build.

.DESCRIPTION
Dev-only probe: drive the SuperLanguage search box and capture the result. It
requires a running <repo>\build\SuperLanguage.exe and an interactive desktop; it
moves the SuperLanguage window to the foreground and posts window messages. Run it
only when nobody else is using the desktop.

The target query is never written to the transcript.

.PARAMETER Target
Conversation name to enter in the search box.

.PARAMETER OutDir
Output directory. Defaults to <repo>\artifacts.

.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\run-search.ps1 `
  -Target "<conversation name>"
#>
param(
    [string]$Target = '',
    [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
if (-not $Target) {
    throw 'Target is required: -Target "<conversation name>"'
}

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
if (-not $OutDir) { $OutDir = Join-Path $root 'artifacts' }
if (-not (Test-Path -LiteralPath $OutDir)) {
    New-Item -ItemType Directory -Path $OutDir | Out-Null
}
$out = Join-Path $OutDir 'run-search.txt'
$png = Join-Path $OutDir 'run-search.png'
$lines = @()
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class D {
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
    [DllImport("user32.dll")] public static extern bool InvalidateRect(IntPtr h, IntPtr r, bool e);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, string l);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr h, uint m, IntPtr w, System.Text.StringBuilder l);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public static IntPtr Pt(int x, int y) { return (IntPtr)((y << 16) | (x & 0xFFFF)); }
}
'@
[D]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null

$hwnd = [IntPtr]$p.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { throw 'SuperLanguage window not found' }
$windowPid = [uint32]0
[void][D]::GetWindowThreadProcessId($hwnd, [ref]$windowPid)
if ([int]$windowPid -ne $p.Id) {
    throw 'SuperLanguage main window does not belong to the validated process; refusing to continue.'
}
$cl = New-Object D+RECT; [D]::GetClientRect($hwnd, [ref]$cl) | Out-Null
$dpi = [D]::GetDpiForWindow($hwnd)
function S([int]$v) { return [int]([Math]::Round($v * $dpi / 96.0)) }
$lines += "process=$($p.Id) hwnd=$hwnd client=$($cl.Right)x$($cl.Bottom) dpi=$dpi"

$edit = [D]::GetDlgItem($hwnd, 1001)
if ($edit -eq [IntPtr]::Zero) { throw 'search edit missing (API mode hides the input rows?)' }
[void][D]::SendMessageW($edit, 0x000C, [IntPtr]::Zero, $Target)
$actualLength = [D]::SendMessageW(
    $edit, 0x000E, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
$readCapacity = [Math]::Max(2, $actualLength + 1)
$read = New-Object System.Text.StringBuilder $readCapacity
$copied = [D]::SendMessageW(
    $edit, 0x000D, [IntPtr]$readCapacity, $read).ToInt32()
$readText = $read.ToString()
$readMatches = $actualLength -gt 0 -and $actualLength -eq $Target.Length -and
    $copied -gt 0 -and $copied -lt $readCapacity -and
    $copied -eq $actualLength -and
    $copied -eq $readText.Length -and
    [string]::Equals($readText, $Target, [StringComparison]::Ordinal)
if (-not $readMatches) {
    throw 'Search edit content does not exactly match the requested value; refusing to click.'
}
$lines += "edit set: matches=$readMatches targetLength=$($Target.Length)"

# Re-check the process identity immediately before the search click.
$current = Get-ExactSuperLanguageProcess
$currentHwnd = [IntPtr]$current.MainWindowHandle
if ($current.Id -ne $p.Id -or $currentHwnd.ToInt64() -ne $hwnd.ToInt64()) {
    throw 'SuperLanguage process or window changed before search; refusing to click.'
}

$cx = $cl.Right - (S 26) - (S 54)
$cy = (S 90) + (S 17)
$lines += "click search button at client $cx,$cy"
[D]::ShowWindow($hwnd, 5) | Out-Null
[D]::SetForegroundWindow($hwnd) | Out-Null
$foreground = [D]::GetForegroundWindow()
if ($foreground.ToInt64() -ne $hwnd.ToInt64()) {
    throw 'SuperLanguage is not the foreground window; refusing to click.'
}
[void][D]::SendMessageW($hwnd, 0x0201, [IntPtr]1, [D]::Pt($cx, $cy))
[void][D]::SendMessageW($hwnd, 0x0202, [IntPtr]0, [D]::Pt($cx, $cy))

$seconds = 75
$lines += "waiting $seconds seconds"
Start-Sleep -Seconds 1
# The former external occlusion-probe script was removed from this project;
# an inline foreground check now provides the same diagnostic signal.
$fg = [D]::GetForegroundWindow()
$lines += "probe(1s): foreground=$fg supertime=$hwnd foregroundIsSuperLanguage=$([int]($fg -eq $hwnd))"
Start-Sleep -Seconds ($seconds - 3)

$bmp = New-Object System.Drawing.Bitmap($cl.Right, $cl.Bottom)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::Black)
$g.Dispose()
$dc = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $dc.GetHdc()
[D]::PrintWindow($hwnd, $hdc, 2) | Out-Null
$dc.ReleaseHdc($hdc)
$dc.Dispose()
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$lines += "shot=$png"

$safeLines = @($lines | ForEach-Object { Protect-SensitiveText -Text ([string]$_) })
$utf8 = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
[IO.File]::WriteAllLines($out, [string[]]$safeLines, $utf8)
Protect-SensitiveText -Text ('WROTE ' + $out)
