<#
.SYNOPSIS
Runs the SuperLanguage real-send probe against the current project build.

.DESCRIPTION
Dev-only probe: fill the SuperLanguage input edits, click the send button and capture
the result. This can create a real WeChat message. It requires a running
<repo>\build\SuperLanguage.exe and an interactive desktop; it moves the SuperLanguage
window to the foreground and posts window messages.

The script refuses to run unless -ConfirmRealSend is supplied. Use a dedicated
test conversation only. No UI input, click, or send is performed when the
switch is omitted.

.PARAMETER Target
Conversation name to enter in the search box.

.PARAMETER Message
Message text to enter. The text is never written to the transcript.

.PARAMETER Wait
Seconds to wait before capturing the result. Defaults to 75.

.PARAMETER OutDir
Output directory. Defaults to <repo>\artifacts.

.PARAMETER ConfirmRealSend
Explicitly confirms that this run may send a real WeChat message.

.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\run-send.ps1 `
  -Target "<dedicated test conversation>" -Message "<test message>" `
  -ConfirmRealSend
#>
param(
    [string]$Target = '',
    [string]$Message = '',
    [int]$Wait = 75,
    [string]$OutDir = '',
    [switch]$ConfirmRealSend
)
$ErrorActionPreference = 'Stop'

if (-not $ConfirmRealSend) {
    Write-Output 'Real-send probe refused: -ConfirmRealSend was not supplied.'
    Write-Output 'Nothing was focused, clicked, or sent. Re-run with -ConfirmRealSend only against a dedicated test conversation.'
    return
}

if (-not $Target) {
    throw 'Target is required: -Target "<conversation name>"'
}
if (-not $Message) {
    throw 'Message is required: -Message "<text to send>"'
}

$root = Split-Path -Parent $PSScriptRoot
$expectedExe = [IO.Path]::GetFullPath((Join-Path $root 'build\SuperLanguage.exe'))

function Protect-SensitiveText {
    param(
        [AllowNull()][string]$Text,
        [string]$MessageBody = ''
    )
    if ($null -eq $Text) { return '' }
    if (-not [string]::IsNullOrEmpty($MessageBody)) {
        $Text = $Text.Replace($MessageBody, '[REDACTED_MESSAGE]')
    }
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
$out = Join-Path $OutDir 'run-send.txt'
$png = Join-Path $OutDir 'run-send.png'
$lines = @()
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class S2 {
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
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
[S2]::SetProcessDpiAwarenessContext([IntPtr]-4) | Out-Null

$hwnd = [IntPtr]$p.MainWindowHandle
if ($hwnd -eq [IntPtr]::Zero) { throw 'SuperLanguage window hidden' }
$windowPid = [uint32]0
[void][S2]::GetWindowThreadProcessId($hwnd, [ref]$windowPid)
if ([int]$windowPid -ne $p.Id) {
    throw 'SuperLanguage main window does not belong to the validated process; refusing to continue.'
}
$cl = New-Object S2+RECT; [S2]::GetClientRect($hwnd, [ref]$cl) | Out-Null
$dpi = [S2]::GetDpiForWindow($hwnd)
function S([int]$v) { return [int]([Math]::Round($v * $dpi / 96.0)) }
$lines += "process=$($p.Id) hwnd=$hwnd client=$($cl.Right)x$($cl.Bottom) dpi=$dpi"

$search = [S2]::GetDlgItem($hwnd, 1001)
$content = [S2]::GetDlgItem($hwnd, 1002)
if ($search -eq [IntPtr]::Zero -or $content -eq [IntPtr]::Zero) { throw 'input edits missing (API mode?)' }
if ($Target.Length -gt 120) { throw 'Target exceeds the 120-character control limit; refusing to continue.' }
if ($Message.Length -gt 500) { throw 'Message exceeds the 500-character control limit; refusing to continue.' }

$targetSet = [S2]::SendMessageW($search, 0x000C, [IntPtr]::Zero, $Target)
$contentSet = [S2]::SendMessageW($content, 0x000C, [IntPtr]::Zero, $Message)
if ($targetSet.ToInt64() -eq 0 -or $contentSet.ToInt64() -eq 0) {
    throw 'WM_SETTEXT failed for one or more input controls; refusing to continue.'
}

function Read-VerifiedEditText {
    param(
        [IntPtr]$Handle,
        [int]$ExpectedLength,
        [string]$Label
    )
    try {
        $actualLength = [S2]::SendMessageW(
            $Handle, 0x000E, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32()
    } catch {
        throw "$Label control length read failed; refusing to continue."
    }
    if ($actualLength -le 0) {
        throw "$Label control is empty or unreadable after WM_SETTEXT; refusing to continue."
    }
    if ($actualLength -ne $ExpectedLength) {
        throw "$Label control content has an unexpected length; refusing to continue."
    }

    $capacity = $actualLength + 1
    $builder = New-Object System.Text.StringBuilder $capacity
    try {
        $copied = [S2]::SendMessageW(
            $Handle, 0x000D, [IntPtr]$capacity, $builder).ToInt32()
    } catch {
        throw "$Label control read failed; refusing to continue."
    }
    $text = $builder.ToString()
    if ($copied -le 0 -or [string]::IsNullOrEmpty($text)) {
        throw "$Label control is empty or unreadable after WM_SETTEXT; refusing to continue."
    }
    if ($copied -ge $capacity -or $copied -ne $actualLength -or $text.Length -ne $actualLength) {
        throw "$Label control read was truncated; refusing to continue."
    }
    return $text
}

$targetRead = Read-VerifiedEditText -Handle $search -ExpectedLength $Target.Length -Label 'Target'
$contentRead = Read-VerifiedEditText -Handle $content -ExpectedLength $Message.Length -Label 'Content'
if (-not [string]::Equals($targetRead, $Target, [StringComparison]::Ordinal)) {
    throw 'Target control content does not exactly match the requested value; refusing to continue.'
}
if (-not [string]::Equals($contentRead, $Message, [StringComparison]::Ordinal)) {
    throw 'Content control content does not exactly match the requested value; refusing to continue.'
}
$lines += "targetLength=$($Target.Length) messageLength=$($Message.Length) targetRead=verified contentRead=verified messageBody=redacted"

# Re-check the process identity immediately before the click that sends.
$current = Get-ExactSuperLanguageProcess
$currentHwnd = [IntPtr]$current.MainWindowHandle
if ($current.Id -ne $p.Id -or $currentHwnd.ToInt64() -ne $hwnd.ToInt64()) {
    throw 'SuperLanguage process or window changed before send; refusing to click.'
}

$cx = $cl.Right - (S 26) - (S 54)
$cy = (S 136) + (S 17)
$lines += "click send button at client $cx,$cy"
[S2]::ShowWindow($hwnd, 5) | Out-Null
[S2]::SetForegroundWindow($hwnd) | Out-Null
$foreground = [S2]::GetForegroundWindow()
if ($foreground.ToInt64() -ne $hwnd.ToInt64()) {
    throw 'SuperLanguage is not the foreground window; refusing to click.'
}
[void][S2]::SendMessageW($hwnd, 0x0201, [IntPtr]1, [S2]::Pt($cx, $cy))
[void][S2]::SendMessageW($hwnd, 0x0202, [IntPtr]0, [S2]::Pt($cx, $cy))

Start-Sleep -Seconds $Wait

$bmp = New-Object System.Drawing.Bitmap($cl.Right, $cl.Bottom)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::Black)
$g.Dispose()
$dc = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $dc.GetHdc()
[S2]::PrintWindow($hwnd, $hdc, 2) | Out-Null
$dc.ReleaseHdc($hdc)
$dc.Dispose()
$bmp.Save($png, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$lines += "shot=$png"

$safeLines = @($lines | ForEach-Object {
    Protect-SensitiveText -Text ([string]$_) -MessageBody $Message
})
$utf8 = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
[IO.File]::WriteAllLines($out, [string[]]$safeLines, $utf8)
Protect-SensitiveText -Text ('WROTE ' + $out) -MessageBody $Message
