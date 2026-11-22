# Types arbitrary text into WeChat 4.x and screenshots the result, so a
# transcription mismatch can be reproduced and read back by eye.
#
# Two targets:
#   -Target composer : clicks the message composer (default)
#   -Target search   : replicates the app's Ctrl+F search-box focus sequence
#
# Characters are delivered as SendInput KEYEVENTF_UNICODE events, the path the
# shipping build uses. Enter is never sent, so nothing is ever posted. The text
# is cleared afterwards.
#
# -TextHex takes UTF-16 code units, e.g. "0061 0069 002D 0032" for "ai-2";
# it avoids any command-line encoding ambiguity for CJK.

param(
    [ValidateSet('composer', 'search')]
    [string]$Target = 'composer',
    [string]$Text = '',
    [string]$TextHex = '',
    [int]$CharDelayMs = 15,
    [string]$ProofPath = '',
    [ValidateSet('unicode', 'wmchar', 'vkminus', 'ctltap', 'dashbs', 'mixed', 'mention')]
    [string]$Method = 'unicode',
    [switch]$ClearFirst,
    [switch]$KeepText,
    [switch]$ReadBack,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

if (-not ('TypeProbe.Native' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace TypeProbe {
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
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern IntPtr SendMessageTimeoutW(IntPtr h, uint msg, IntPtr wParam,
            IntPtr lParam, uint flags, uint timeout, out IntPtr result);
        [DllImport("user32.dll")] public static extern int GetLastError();
        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassNameW(IntPtr h, System.Text.StringBuilder s, int n);
    }
}
'@
}

$N = [TypeProbe.Native]
$SW_RESTORE = 9
$SW_SHOW = 5
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
$VK_C = 0x43
$VK_F = 0x46
$VK_BACK = 0x08
$SM_XVIRTUALSCREEN = 76
$SM_YVIRTUALSCREEN = 77
$SM_CXVIRTUALSCREEN = 78
$SM_CYVIRTUALSCREEN = 79

# Same client-relative anchors as src/automation.cpp.
$ComposerBottomDips = 64
$SearchListPointXDips = 100
$SearchListPointYDips = 58

$InputSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'TypeProbe.INPUT')

function Send-One([TypeProbe.INPUT]$eventInput) {
    $buffer = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($InputSize)
    try {
        [System.Runtime.InteropServices.Marshal]::StructureToPtr($eventInput, $buffer, $false)
        if ($N::SendInputRaw(1, $buffer, $InputSize) -ne 1) {
            throw ("SendInput failed, GetLastError=" + $N::GetLastError())
        }
    }
    finally {
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buffer)
    }
}

function New-KeyInput([uint16]$vk, [uint16]$scan, [uint32]$flags) {
    $key = New-Object TypeProbe.KEYBDINPUT
    $key.wVk = $vk
    $key.wScan = $scan
    $key.dwFlags = $flags
    $eventInput = New-Object TypeProbe.INPUT
    $eventInput.type = $INPUT_KEYBOARD
    $eventInput.ki = $key
    return $eventInput
}

function Send-KeyDown([int]$vk) { Send-One (New-KeyInput ([uint16]$vk) ([uint16]0) ([uint32]0)) }
function Send-KeyUp([int]$vk) { Send-One (New-KeyInput ([uint16]$vk) ([uint16]0) ([uint32]$KEYEVENTF_KEYUP)) }
function Send-Tap([int]$vk) {
    Send-KeyDown $vk
    Start-Sleep -Milliseconds 15
    Send-KeyUp $vk
}

function Send-Chord([int]$vk, [int]$modifier) {
    Send-KeyDown $modifier
    Start-Sleep -Milliseconds 15
    Send-Tap $vk
    Start-Sleep -Milliseconds 15
    Send-KeyUp $modifier
}

function Send-UnicodeChar([char]$ch) {
    Send-One (New-KeyInput ([uint16]0) ([uint16][int]$ch) ([uint32]$KEYEVENTF_UNICODE))
    Send-One (New-KeyInput ([uint16]0) ([uint16][int]$ch) ([uint32]($KEYEVENTF_UNICODE -bor $KEYEVENTF_KEYUP)))
}

function Invoke-ClickAt([int]$x, [int]$y) {
    $vx = $N::GetSystemMetrics($SM_XVIRTUALSCREEN)
    $vy = $N::GetSystemMetrics($SM_YVIRTUALSCREEN)
    $vw = [Math]::Max(1, $N::GetSystemMetrics($SM_CXVIRTUALSCREEN) - 1)
    $vh = [Math]::Max(1, $N::GetSystemMetrics($SM_CYVIRTUALSCREEN) - 1)

    $move = New-Object TypeProbe.MOUSEINPUT
    $move.dx = [int](($x - $vx) * 65535 / $vw)
    $move.dy = [int](($y - $vy) * 65535 / $vh)
    $move.dwFlags = [uint32]($MOUSEEVENTF_MOVE -bor $MOUSEEVENTF_ABSOLUTE -bor $MOUSEEVENTF_VIRTUALDESK)
    $down = New-Object TypeProbe.MOUSEINPUT
    $down.dwFlags = [uint32]$MOUSEEVENTF_LEFTDOWN
    $up = New-Object TypeProbe.MOUSEINPUT
    $up.dwFlags = [uint32]$MOUSEEVENTF_LEFTUP

    foreach ($button in @($move, $down, $up)) {
        $eventInput = New-Object TypeProbe.INPUT
        $eventInput.type = $INPUT_MOUSE
        $eventInput.mi = $button
        Send-One $eventInput
        Start-Sleep -Milliseconds 30
    }
}

function Invoke-ClearInput {
    Send-Chord $VK_A $VK_CONTROL
    Start-Sleep -Milliseconds 80
    for ($i = 0; $i -lt 30; $i++) {
        Send-Tap $VK_BACK
        Start-Sleep -Milliseconds 12
    }
    Start-Sleep -Milliseconds 120
}

if (-not $Text) {
    if ($TextHex) {
        $units = $TextHex -split '[\s,]+' | Where-Object { $_ }
        $Text = -join ($units | ForEach-Object { [char][Convert]::ToInt32($_, 16) })
    }
    else {
        throw 'Pass -Text or -TextHex'
    }
}

$hwnd = 0
foreach ($proc in @(Get-Process -Name Weixin, WeChat -ErrorAction SilentlyContinue)) {
    if ($proc.MainWindowHandle -ne 0) { $hwnd = [IntPtr]$proc.MainWindowHandle; break }
}
if ($hwnd -eq 0) { throw 'WeChat main window not found' }

$targetPid = 0
[void]$N::GetWindowThreadProcessId($hwnd, [ref]$targetPid)

if ($N::IsIconic($hwnd)) { [void]$N::ShowWindow($hwnd, $SW_RESTORE) }
if (-not $N::IsWindowVisible($hwnd)) { [void]$N::ShowWindow($hwnd, $SW_SHOW) }

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

$clientRect = New-Object TypeProbe.RECT
[void]$N::GetClientRect($hwnd, [ref]$clientRect)
$origin = New-Object TypeProbe.POINT
[void]$N::ClientToScreen($hwnd, [ref]$origin)
$dpi = $N::GetDpiForWindow($hwnd)
if ($dpi -eq 0) { $dpi = 96 }
$scale = $dpi / 96.0
$clientWidth = $clientRect.Right - $clientRect.Left
$clientHeight = $clientRect.Bottom - $clientRect.Top

$savedCursor = New-Object TypeProbe.POINT
[void]$N::GetCursorPos([ref]$savedCursor)

"target`t$Target"
"method`t$Method"
"process`tpid $targetPid dpi $dpi client ${clientWidth}x${clientHeight} at $($origin.X),$($origin.Y)"
"text`t$Text"
"codepoints`t" + (($Text.ToCharArray() | ForEach-Object { 'U+{0:X4}' -f [int]$_ }) -join ' ')

if ($DryRun) {
    'result' + "`t" + 'dry-run only'
    exit 0
}

if ($N::GetForegroundWindow() -ne $hwnd) {
    [void]$N::SetCursorPos($savedCursor.X, $savedCursor.Y)
    'result' + "`t" + 'aborted: WeChat is not the foreground window'
    exit 2
}

if ($Target -eq 'search') {
    # Same sequence as src/automation.cpp search_wechat_conversation().
    Invoke-ClickAt ($origin.X + [int]($SearchListPointXDips * $scale)) `
                   ($origin.Y + [int]($SearchListPointYDips * $scale))
    Start-Sleep -Milliseconds 150
    Send-Chord $VK_F $VK_CONTROL
    Start-Sleep -Milliseconds 120
    Send-Chord $VK_F $VK_CONTROL
    Start-Sleep -Milliseconds 120
    Send-Chord $VK_A $VK_CONTROL
    Start-Sleep -Milliseconds 60
    Send-Tap $VK_BACK
    Start-Sleep -Milliseconds 80
}
else {
    Invoke-ClickAt ($origin.X + [int]($clientWidth / 2)) `
                   ($origin.Y + $clientHeight - [int]($ComposerBottomDips * $scale))
    Start-Sleep -Milliseconds 250
}

if ($ClearFirst) {
    Invoke-ClearInput
}

if ($Method -eq 'wmchar') {
    $message_result = [IntPtr]::Zero
    foreach ($ch in $Text.ToCharArray()) {
        [void]$N::SendMessageTimeoutW($hwnd, 0x0102, [IntPtr][int]$ch, [IntPtr]1,
            0x0003, 2000, [ref]$message_result)
        Start-Sleep -Milliseconds $CharDelayMs
    }
}
elseif ($Method -eq 'vkminus') {
    # Dash as a real VK_OEM_MINUS keystroke, everything else as VK_PACKET.
    foreach ($ch in $Text.ToCharArray()) {
        if ($ch -eq '-') {
            Send-One (New-KeyInput ([uint16]0xBD) ([uint16]0) ([uint32]0))
            Start-Sleep -Milliseconds 20
            Send-One (New-KeyInput ([uint16]0xBD) ([uint16]0) ([uint32]$KEYEVENTF_KEYUP))
        }
        else {
            Send-UnicodeChar $ch
        }
        Start-Sleep -Milliseconds $CharDelayMs
    }
}
elseif ($Method -eq 'dashbs') {
    # The character after a VK_PACKET '-' is replaced by '-' by the target.
    # Emit the dash twice and delete the duplicate, which consumes the poisoned
    # slot without leaving stray text and without depending on layout or IME.
    foreach ($ch in $Text.ToCharArray()) {
        Send-UnicodeChar $ch
        if ($ch -eq '-') {
            Start-Sleep -Milliseconds 30
            Send-UnicodeChar $ch
            Start-Sleep -Milliseconds 40
            Send-Tap $VK_BACK
            Start-Sleep -Milliseconds 40
        }
        Start-Sleep -Milliseconds $CharDelayMs
    }
}
elseif ($Method -eq 'mention') {
    # Replicates the @ flow: packet '@' opens the picker, the filter token is
    # typed with WM_CHAR at whatever window ended up with the foreground, then
    # Enter selects the highlighted member. Reads the composer back to see
    # whether the picker received the filter at all.
    $VK_RETURN = 0x0D
    $message_result = [IntPtr]::Zero
    Send-UnicodeChar '@'
    Start-Sleep -Milliseconds 500
    $pickerHwnd = $N::GetForegroundWindow()
    $pickerClass = New-Object System.Text.StringBuilder 256
    [void]$N::GetClassNameW($pickerHwnd, $pickerClass, 256)
    "picker`thwnd=$pickerHwnd class=$($pickerClass.ToString())"
    foreach ($ch in $Text.ToCharArray()) {
        [void]$N::SendMessageTimeoutW($pickerHwnd, 0x0102, [IntPtr][int]$ch, [IntPtr]1,
            0x0003, 2000, [ref]$message_result)
        Start-Sleep -Milliseconds 120
    }
    Start-Sleep -Milliseconds 400
    Send-Tap $VK_RETURN
    Start-Sleep -Milliseconds 600
}
elseif ($Method -eq 'mixed') {
    # Characters as synchronous WM_CHAR (exact, no layout/IME dependence),
    # line breaks as a real Shift+Enter through the input queue. A wait after
    # the queued key lets it be processed before the next synchronous char.
    $message_result = [IntPtr]::Zero
    $VK_SHIFT = 0x10
    $VK_RETURN = 0x0D
    foreach ($ch in $Text.ToCharArray()) {
        if ($ch -eq "`n" -or $ch -eq "`r") {
            Send-KeyDown $VK_SHIFT
            Start-Sleep -Milliseconds 20
            Send-Tap $VK_RETURN
            Send-KeyUp $VK_SHIFT
            Start-Sleep -Milliseconds 250
        }
        else {
            [void]$N::SendMessageTimeoutW($hwnd, 0x0102, [IntPtr][int]$ch, [IntPtr]1,
                0x0003, 2000, [ref]$message_result)
            Start-Sleep -Milliseconds $CharDelayMs
        }
    }
}
elseif ($Method -eq 'ctltap') {
    # Dash as VK_PACKET, then a bare Ctrl tap (types nothing) before the next char.
    foreach ($ch in $Text.ToCharArray()) {
        Send-UnicodeChar $ch
        if ($ch -eq '-') {
            Start-Sleep -Milliseconds 30
            Send-KeyDown $VK_CONTROL
            Start-Sleep -Milliseconds 20
            Send-KeyUp $VK_CONTROL
            Start-Sleep -Milliseconds 30
        }
        Start-Sleep -Milliseconds $CharDelayMs
    }
}
else {
    foreach ($ch in $Text.ToCharArray()) {
        Send-UnicodeChar $ch
        Start-Sleep -Milliseconds $CharDelayMs
    }
}
Start-Sleep -Milliseconds 500

if ($ProofPath) {
    if ($Target -eq 'search') {
        $shotW = $clientWidth
        $shotH = [int](320 * $scale)
        $shotX = $origin.X
        $shotY = $origin.Y
    }
    else {
        $shotW = $clientWidth
        $shotH = [int](200 * $scale)
        $shotX = $origin.X
        $shotY = $origin.Y + $clientHeight - $shotH
    }
    $bitmap = New-Object System.Drawing.Bitmap $shotW, $shotH
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.CopyFromScreen($shotX, $shotY, 0, 0, $bitmap.Size)
        $directory = Split-Path -Parent $ProofPath
        if ($directory -and -not (Test-Path $directory)) {
            [void](New-Item -ItemType Directory -Path $directory)
        }
        $bitmap.Save($ProofPath, [System.Drawing.Imaging.ImageFormat]::Png)
        "proof`t$ProofPath"
    }
    finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

if ($ReadBack) {
    # Select-all + copy gives the exact characters the control holds, without
    # relying on reading pixels. The clipboard is restored afterwards; only text
    # content is preserved, not other clipboard formats.
    $savedText = $null
    $hadText = $false
    try {
        $savedText = Get-Clipboard -Raw -ErrorAction Stop
        $hadText = $true
    }
    catch {
        $hadText = $false
    }

    Send-Chord $VK_A $VK_CONTROL
    Start-Sleep -Milliseconds 80
    Send-Chord $VK_C $VK_CONTROL
    Start-Sleep -Milliseconds 250

    $captured = ''
    try {
        $captured = [string](Get-Clipboard -Raw -ErrorAction Stop)
    }
    catch {
        $captured = ''
    }
    $captured = $captured -replace "`r`n", "`n"

    "readback`t$captured"
    "readback_hex`t" + (($captured.ToCharArray() | ForEach-Object { '{0:X4}' -f [int]$_ }) -join ' ')
    if ($captured -ceq $Text) {
        "readback_match`ttrue"
    }
    else {
        "readback_match`tfalse"
        $limit = [Math]::Min($captured.Length, $Text.Length)
        for ($i = 0; $i -lt $limit; $i++) {
            if ($captured[$i] -ne $Text[$i]) {
                "first_diff`tindex=$i expected=U+{0:X4} actual=U+{1:X4}" -f [int]$Text[$i], [int]$captured[$i]
                break
            }
        }
    }

    if ($hadText) {
        Set-Clipboard -Value $savedText -ErrorAction SilentlyContinue
    }
}

if (-not $KeepText) {
    Invoke-ClearInput
    'cleared' + "`t" + 'true'
}

[void]$N::SetCursorPos($savedCursor.X, $savedCursor.Y)
'result' + "`t" + 'done'
