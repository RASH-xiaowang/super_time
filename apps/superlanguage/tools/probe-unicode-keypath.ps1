# A/B probe: does WeChat 4.x's Qt composer accept text delivered as
# SendInput KEYEVENTF_UNICODE (VK_PACKET), the way it accepts WM_CHAR?
#
# Control group uses SendMessageTimeoutW(WM_CHAR), which the shipping build
# already relies on. Treatment group uses SendInput with KEYEVENTF_UNICODE.
# Both write the same 10 CJK characters into the composer and are cleared
# afterwards. Enter is never sent, so no message leaves the client.
#
# Green send-button pixels (the same heuristic the app uses) are the only
# signal: the button turns green when the composer holds content.
#
# Output is tab-separated key/value lines for easy reading by hand or script.

param(
    [long]$WindowHandle = 0,
    [int]$CharDelayMs = 60,
    [switch]$DryRun,
    [switch]$CleanOnly,
    [string]$ProofPath = '',
    [string]$Text = '',
    [ValidateSet('composer', 'search')]
    [string]$Mode = 'composer'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not ('Probe.Native' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace Probe {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx, dy;
        public uint mouseData, dwFlags, time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk, wScan;
        public uint dwFlags, time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT {
        [FieldOffset(0)] public uint type;
        [FieldOffset(8)] public MOUSEINPUT mi;
        [FieldOffset(8)] public KEYBDINPUT ki;
    }

    public static class Native {
        [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
        [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
        [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
        [DllImport("user32.dll", EntryPoint = "SendInput")]
        public static extern uint SendInputRaw(uint n, IntPtr inputs, int size);
        [DllImport("user32.dll")] public static extern int GetLastError();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, IntPtr wParam,
            IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    }
}
'@
}

$N = [Probe.Native]
$SW_RESTORE = 9
$SW_SHOW = 5
$WM_CHAR = 0x0102
$SMTO_BLOCK = 0x0001
$SMTO_ABORTIFHUNG = 0x0002
$INPUT_KEYBOARD = 1
$INPUT_MOUSE = 0
$KEYEVENTF_KEYUP = 0x0002
$KEYEVENTF_UNICODE = 0x0004
$MOUSEEVENTF_MOVE = 0x0001
$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004
$MOUSEEVENTF_ABSOLUTE = 0x8000
$MOUSEEVENTF_VIRTUALDESK = 0x4000
$VK_CONTROL = 0x11
$VK_A = 0x41
$VK_BACK = 0x08
$SM_XVIRTUALSCREEN = 76
$SM_YVIRTUALSCREEN = 77
$SM_CXVIRTUALSCREEN = 78
$SM_CYVIRTUALSCREEN = 79

$InputSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'Probe.INPUT')

# Composer anchors copied from src/automation.cpp: centre horizontally,
# 64 DIP above the client bottom; the send button region is 120x56 DIP
# inset 8 DIP from the bottom-right corner, 40+ "green" pixels means filled.
$ComposerBottomDips = 64
$RegionRightDips = 8
$RegionBottomDips = 8
$RegionWidthDips = 120
$RegionHeightDips = 56
$GreenPixelThreshold = 40

function New-KeyInput([uint16]$vk, [uint16]$scan, [uint32]$flags) {
    $key = New-Object Probe.KEYBDINPUT
    $key.wVk = $vk
    $key.wScan = $scan
    $key.dwFlags = $flags
    $eventInput = New-Object Probe.INPUT
    $eventInput.type = $INPUT_KEYBOARD
    $eventInput.ki = $key
    return $eventInput
}

function Send-One([Probe.INPUT]$eventInput) {
    # PowerShell cannot reliably marshal an INPUT[] built field by field, so the
    # struct is written to unmanaged memory and handed to SendInput as a pointer.
    $buffer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($InputSize)
    try {
        [System.Runtime.InteropServices.Marshal]::StructureToPtr($eventInput, $buffer, $false)
        $sent = $N::SendInputRaw(1, $buffer, $InputSize)
        if ($sent -ne 1) {
            throw ("SendInput failed, GetLastError=" + $N::GetLastError())
        }
    }
    finally {
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
    }
}

function Send-KeyDown([int]$vk) { Send-One (New-KeyInput ([uint16]$vk) ([uint16]0) ([uint32]0)) }
function Send-KeyUp([int]$vk) { Send-One (New-KeyInput ([uint16]$vk) ([uint16]0) ([uint32]$KEYEVENTF_KEYUP)) }
function Send-Tap([int]$vk) { Send-KeyDown $vk; Start-Sleep -Milliseconds 15; Send-KeyUp $vk }

function Send-UnicodeChar([char]$ch) {
    Send-One (New-KeyInput ([uint16]0) ([uint16][int]$ch) ([uint32]$KEYEVENTF_UNICODE))
    Send-One (New-KeyInput ([uint16]0) ([uint16][int]$ch) ([uint32]($KEYEVENTF_UNICODE -bor $KEYEVENTF_KEYUP)))
}

function Invoke-ClickAt([int]$x, [int]$y) {
    $vx = $N::GetSystemMetrics($SM_XVIRTUALSCREEN)
    $vy = $N::GetSystemMetrics($SM_YVIRTUALSCREEN)
    $vw = [Math]::Max(1, $N::GetSystemMetrics($SM_CXVIRTUALSCREEN) - 1)
    $vh = [Math]::Max(1, $N::GetSystemMetrics($SM_CYVIRTUALSCREEN) - 1)

    $move = New-Object Probe.MOUSEINPUT
    $move.dx = [int](($x - $vx) * 65535 / $vw)
    $move.dy = [int](($y - $vy) * 65535 / $vh)
    $move.dwFlags = [uint32]($MOUSEEVENTF_MOVE -bor $MOUSEEVENTF_ABSOLUTE -bor $MOUSEEVENTF_VIRTUALDESK)
    $down = New-Object Probe.MOUSEINPUT
    $down.dwFlags = [uint32]$MOUSEEVENTF_LEFTDOWN
    $up = New-Object Probe.MOUSEINPUT
    $up.dwFlags = [uint32]$MOUSEEVENTF_LEFTUP

    foreach ($button in @($move, $down, $up)) {
        $eventInput = New-Object Probe.INPUT
        $eventInput.type = $INPUT_MOUSE
        $eventInput.mi = $button
        Send-One $eventInput
        Start-Sleep -Milliseconds 30
    }
}

function Invoke-ClearComposer {
    # Ctrl+A then Backspace through the input queue, plus a few blind
    # backspaces in case select-all is not handled by the composer.
    Send-KeyDown $VK_CONTROL
    Start-Sleep -Milliseconds 20
    Send-Tap $VK_A
    Start-Sleep -Milliseconds 20
    Send-KeyUp $VK_CONTROL
    Start-Sleep -Milliseconds 80
    for ($i = 0; $i -lt 24; $i++) {
        Send-Tap $VK_BACK
        Start-Sleep -Milliseconds 15
    }
    Start-Sleep -Milliseconds 150
}

function Resolve-WeChatWindow {
    if ($WindowHandle -ne 0) {
        return [IntPtr]$WindowHandle
    }
    foreach ($proc in @(Get-Process -Name Weixin, WeChat -ErrorAction SilentlyContinue)) {
        if ($proc.MainWindowHandle -ne 0) {
            return [IntPtr]$proc.MainWindowHandle
        }
    }
    throw 'WeChat main window not found'
}

function Get-GreenCount([int]$x, [int]$y, [int]$w, [int]$h) {
    $bitmap = New-Object System.Drawing.Bitmap $w, $h
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($x, $y, 0, 0, $bitmap.Size)
        $count = 0
        for ($py = 0; $py -lt $h; $py++) {
            for ($px = 0; $px -lt $w; $px++) {
                $c = $bitmap.GetPixel($px, $py)
                if ($c.G -gt 110 -and ($c.G - $c.R) -gt 40 -and ($c.G - $c.B) -gt 40) {
                    $count++
                }
            }
        }
        return $count
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

$hwnd = Resolve-WeChatWindow
$targetPid = 0
[void]$N::GetWindowThreadProcessId($hwnd, [ref]$targetPid)
$procName = (Get-Process -Id $targetPid).ProcessName

if ($N::IsIconic($hwnd)) { [void]$N::ShowWindow($hwnd, $SW_RESTORE) }
if (-not $N::IsWindowVisible($hwnd)) { [void]$N::ShowWindow($hwnd, $SW_SHOW) }

# Foreground the client; the foreground lock often refuses the first attempt.
$foregroundThread = 0
$idleThread = 0
[void]$N::GetWindowThreadProcessId($N::GetForegroundWindow(), [ref]$foregroundThread)
[void]$N::GetWindowThreadProcessId($hwnd, [ref]$idleThread)
[void]$N::SetForegroundWindow($hwnd)
Start-Sleep -Milliseconds 150
if ($N::GetForegroundWindow() -ne $hwnd) {
    [void]$N::AttachThreadInput($N::GetCurrentThreadId(), $foregroundThread, $true)
    [void]$N::AttachThreadInput($N::GetCurrentThreadId(), $idleThread, $true)
    [void]$N::SetForegroundWindow($hwnd)
    [void]$N::AttachThreadInput($N::GetCurrentThreadId(), $foregroundThread, $false)
    Start-Sleep -Milliseconds 300
}

$clientRect = New-Object Probe.RECT
[void]$N::GetClientRect($hwnd, [ref]$clientRect)
$origin = New-Object Probe.POINT
[void]$N::ClientToScreen($hwnd, [ref]$origin)
$dpi = $N::GetDpiForWindow($hwnd)
if ($dpi -eq 0) { $dpi = 96 }
$scale = $dpi / 96.0

$clientWidth = $clientRect.Right - $clientRect.Left
$clientHeight = $clientRect.Bottom - $clientRect.Top
$composerX = $origin.X + [int]($clientWidth / 2)
$composerY = $origin.Y + $clientHeight - [int]($ComposerBottomDips * $scale)

$regionW = [int]($RegionWidthDips * $scale)
$regionH = [int]($RegionHeightDips * $scale)
$regionX = $origin.X + $clientWidth - [int]($RegionRightDips * $scale) - $regionW
$regionY = $origin.Y + $clientHeight - [int]($RegionBottomDips * $scale) - $regionH

$savedCursor = New-Object Probe.POINT
[void]$N::GetCursorPos([ref]$savedCursor)

$text = if ($Text) {
    $Text
}
else {
    -join (@(0x4E00, 0x4E8C, 0x4E09, 0x56DB, 0x4E94, 0x516D, 0x4E03, 0x516B, 0x4E5D, 0x5341) |
        ForEach-Object { [char]$_ })
}

"hwnd`t$hwnd"
"process`t$procName (pid $targetPid)"
"dpi`t$dpi"
"client`t$clientWidth x $clientHeight at $($origin.X),$($origin.Y)"
"composer_point`t$composerX,$composerY"
"green_region`t$regionX,$regionY ${regionW}x${regionH}"
"probe_text`t$text (length $($text.Length))"

$baseline = Get-GreenCount $regionX $regionY $regionW $regionH
"green_baseline`t$baseline"

if ($DryRun) {
    [void]$N::SetCursorPos($savedCursor.X, $savedCursor.Y)
    'result' + "`t" + 'dry-run only'
    exit 0
}

if ($N::GetForegroundWindow() -ne $hwnd) {
    [void]$N::SetCursorPos($savedCursor.X, $savedCursor.Y)
    'result' + "`t" + 'aborted: WeChat is not the foreground window'
    exit 2
}

Invoke-ClickAt $composerX $composerY
Start-Sleep -Milliseconds 250

if ($CleanOnly) {
    Invoke-ClearComposer
    $afterClean = Get-GreenCount $regionX $regionY $regionW $regionH
    "green_after_clean`t$afterClean"
    [void]$N::SetCursorPos($savedCursor.X, $savedCursor.Y)
    if ($afterClean -lt $GreenPixelThreshold) {
        'result' + "`t" + 'cleaned'
    }
    else {
        'result' + "`t" + 'still has content: clear the composer manually'
    }
    exit 0
}

# --- control group: WM_CHAR, the mechanism the shipping build already uses ---
$result = [IntPtr]::Zero
foreach ($ch in $text.ToCharArray()) {
    [void]$N::SendMessageTimeoutW($hwnd, $WM_CHAR, [IntPtr][int]$ch, [IntPtr]1,
        ($SMTO_BLOCK -bor $SMTO_ABORTIFHUNG), 2000, [ref]$result)
    Start-Sleep -Milliseconds 20
}
Start-Sleep -Milliseconds 300
$controlGreen = Get-GreenCount $regionX $regionY $regionW $regionH
"green_wmchar`t$controlGreen"

Invoke-ClearComposer
$clearedAfterControl = Get-GreenCount $regionX $regionY $regionW $regionH
"green_after_clear_control`t$clearedAfterControl"

# --- treatment group: SendInput KEYEVENTF_UNICODE (VK_PACKET) ---
foreach ($ch in $text.ToCharArray()) {
    Send-UnicodeChar $ch
    Start-Sleep -Milliseconds $CharDelayMs
}
Start-Sleep -Milliseconds 400
$unicodeGreen = Get-GreenCount $regionX $regionY $regionW $regionH
"green_sendinput_unicode`t$unicodeGreen"

if ($ProofPath) {
    # Capture the composer strip so the written glyphs can be inspected.
    $proofH = [int](200 * $scale)
    $proofX = $origin.X
    $proofY = $origin.Y + $clientHeight - $proofH
    $proofBitmap = New-Object System.Drawing.Bitmap $clientWidth, $proofH
    $proofGraphics = [System.Drawing.Graphics]::FromImage($proofBitmap)
    try {
        $proofGraphics.CopyFromScreen($proofX, $proofY, 0, 0, $proofBitmap.Size)
        $proofDirectory = Split-Path -Parent $ProofPath
        if ($proofDirectory -and -not (Test-Path $proofDirectory)) {
            [void](New-Item -ItemType Directory -Path $proofDirectory)
        }
        $proofBitmap.Save($ProofPath, [System.Drawing.Imaging.ImageFormat]::Png)
        "proof`t$ProofPath"
    }
    finally {
        $proofGraphics.Dispose()
        $proofBitmap.Dispose()
    }
}

Invoke-ClearComposer
$clearedAfterUnicode = Get-GreenCount $regionX $regionY $regionW $regionH
"green_after_clear_unicode`t$clearedAfterUnicode"

[void]$N::SetCursorPos($savedCursor.X, $savedCursor.Y)

$controlAccepted = $controlGreen -ge $GreenPixelThreshold
$unicodeAccepted = $unicodeGreen -ge $GreenPixelThreshold

if ($baseline -ge $GreenPixelThreshold) {
    'result' + "`t" + 'inconclusive: composer already had content before the probe'
}
elseif (-not $controlAccepted) {
    'result' + "`t" + 'inconclusive: control group failed (no open conversation, or the click did not focus the composer)'
}
elseif ($unicodeAccepted) {
    'result' + "`t" + 'accepted: SendInput KEYEVENTF_UNICODE reached the composer'
}
else {
    'result' + "`t" + 'rejected: WM_CHAR filled the composer but SendInput KEYEVENTF_UNICODE did not'
}
"clean_after_probe`t$($clearedAfterUnicode -lt $GreenPixelThreshold)"
