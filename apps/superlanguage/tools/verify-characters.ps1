# Character-fidelity harness for WeChat 4.x's composer.
#
# Types each corpus chunk into the message composer, then measures what the
# composer actually holds by select-all + copy and comparing the clipboard
# against the expected code units. This detects silent character substitution
# (for example a '-' consuming the character that follows it) that a pixel
# check cannot see.
#
# Corpus ranges are deliberately wide: ASCII, Latin-1, Latin Extended-A, general
# punctuation, currency, arrows, math, box drawing, CJK punctuation, kana, CJK
# ideographs, Hangul, fullwidth forms, halfwidth katakana, plus astral
# characters delivered as UTF-16 surrogate pairs.
#
# Nothing is ever sent: Enter is never pressed except as part of clearing.

param(
    [ValidateSet('wmchar', 'vkpacket', 'hybrid')]
    [string]$Method = 'wmchar',
    [int]$ChunkSize = 100,
    [int]$CharDelayMs = 8,
    [string]$ReportPath = '',
    [switch]$SkipAstral
)

$ErrorActionPreference = 'Stop'

if (-not ('CharCheck.Native' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CharCheck {
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

$N = [CharCheck.Native]
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
$VK_BACK = 0x08
$SM_XVIRTUALSCREEN = 76
$SM_YVIRTUALSCREEN = 77
$SM_CXVIRTUALSCREEN = 78
$SM_CYVIRTUALSCREEN = 79
$ComposerBottomDips = 64
$InputSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'CharCheck.INPUT')

function Send-One([CharCheck.INPUT]$eventInput) {
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
    $key = New-Object CharCheck.KEYBDINPUT
    $key.wVk = $vk
    $key.wScan = $scan
    $key.dwFlags = $flags
    $eventInput = New-Object CharCheck.INPUT
    $eventInput.type = $INPUT_KEYBOARD
    $eventInput.ki = $key
    return $eventInput
}

function Send-KeyDown([int]$vk) { Send-One (New-KeyInput ([uint16]$vk) ([uint16]0) ([uint32]0)) }
function Send-KeyUp([int]$vk) { Send-One (New-KeyInput ([uint16]$vk) ([uint16]0) ([uint32]$KEYEVENTF_KEYUP)) }
function Send-Tap([int]$vk) {
    Send-KeyDown $vk
    Start-Sleep -Milliseconds 12
    Send-KeyUp $vk
}
function Send-Chord([int]$vk, [int]$modifier) {
    Send-KeyDown $modifier
    Start-Sleep -Milliseconds 12
    Send-Tap $vk
    Start-Sleep -Milliseconds 12
    Send-KeyUp $modifier
}

function Invoke-ClickAt([int]$x, [int]$y) {
    $vx = $N::GetSystemMetrics($SM_XVIRTUALSCREEN)
    $vy = $N::GetSystemMetrics($SM_YVIRTUALSCREEN)
    $vw = [Math]::Max(1, $N::GetSystemMetrics($SM_CXVIRTUALSCREEN) - 1)
    $vh = [Math]::Max(1, $N::GetSystemMetrics($SM_CYVIRTUALSCREEN) - 1)

    $move = New-Object CharCheck.MOUSEINPUT
    $move.dx = [int](($x - $vx) * 65535 / $vw)
    $move.dy = [int](($y - $vy) * 65535 / $vh)
    $move.dwFlags = [uint32]($MOUSEEVENTF_MOVE -bor $MOUSEEVENTF_ABSOLUTE -bor $MOUSEEVENTF_VIRTUALDESK)
    $down = New-Object CharCheck.MOUSEINPUT
    $down.dwFlags = [uint32]$MOUSEEVENTF_LEFTDOWN
    $up = New-Object CharCheck.MOUSEINPUT
    $up.dwFlags = [uint32]$MOUSEEVENTF_LEFTUP

    foreach ($button in @($move, $down, $up)) {
        $eventInput = New-Object CharCheck.INPUT
        $eventInput.type = $INPUT_MOUSE
        $eventInput.mi = $button
        Send-One $eventInput
        Start-Sleep -Milliseconds 25
    }
}

function Invoke-ClearComposer {
    Send-Chord $VK_A $VK_CONTROL
    Start-Sleep -Milliseconds 60
    for ($i = 0; $i -lt 40; $i++) {
        Send-Tap $VK_BACK
        Start-Sleep -Milliseconds 6
    }
    Start-Sleep -Milliseconds 100
}

$hwnd = 0
foreach ($proc in @(Get-Process -Name Weixin, WeChat -ErrorAction SilentlyContinue)) {
    if ($proc.MainWindowHandle -ne 0) { $hwnd = [IntPtr]$proc.MainWindowHandle; break }
}
if ($hwnd -eq 0) { throw 'WeChat main window not found' }

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
if ($N::GetForegroundWindow() -ne $hwnd) {
    throw 'WeChat is not the foreground window'
}

$clientRect = New-Object CharCheck.RECT
[void]$N::GetClientRect($hwnd, [ref]$clientRect)
$origin = New-Object CharCheck.POINT
[void]$N::ClientToScreen($hwnd, [ref]$origin)
$dpi = $N::GetDpiForWindow($hwnd)
if ($dpi -eq 0) { $dpi = 96 }
$scale = $dpi / 96.0
$clientWidth = $clientRect.Right - $clientRect.Left
$clientHeight = $clientRect.Bottom - $clientRect.Top

$savedCursor = New-Object CharCheck.POINT
[void]$N::GetCursorPos([ref]$savedCursor)
$savedClipboard = $null
try { $savedClipboard = Get-Clipboard -Raw -ErrorAction Stop } catch { $savedClipboard = $null }

Invoke-ClickAt ($origin.X + [int]($clientWidth / 2)) `
               ($origin.Y + $clientHeight - [int]($ComposerBottomDips * $scale))
Start-Sleep -Milliseconds 300

# --- corpus ---------------------------------------------------------------
# 0x09 (tab) and 0x0D/0x0A are exercised separately: the app maps line breaks to
# Shift+Enter, so the composer corpus keeps to printable text.
$ranges = @(
    @{ Name = 'ascii'; From = 0x20; To = 0x7E },
    @{ Name = 'latin-1'; From = 0xA0; To = 0xFF },
    @{ Name = 'latin-ext-a'; From = 0x100; To = 0x17F },
    @{ Name = 'general-punct'; From = 0x2010; To = 0x2030 },
    @{ Name = 'currency'; From = 0x20A0; To = 0x20BF },
    @{ Name = 'arrows'; From = 0x2190; To = 0x21FF },
    @{ Name = 'math'; From = 0x2200; To = 0x22FF },
    @{ Name = 'box-drawing'; From = 0x2500; To = 0x257F },
    @{ Name = 'block-elements'; From = 0x2580; To = 0x259F },
    @{ Name = 'cjk-punct'; From = 0x3000; To = 0x303F },
    @{ Name = 'hiragana'; From = 0x3041; To = 0x3096 },
    @{ Name = 'katakana'; From = 0x30A1; To = 0x30FA },
    @{ Name = 'cjk-unified'; From = 0x4E00; To = 0x4EFF },
    @{ Name = 'cjk-unified-mid'; From = 0x5000; To = 0x51FF },
    @{ Name = 'cjk-unified-high'; From = 0x9E00; To = 0x9FFF },
    @{ Name = 'hangul'; From = 0xAC00; To = 0xACFF },
    @{ Name = 'fullwidth'; From = 0xFF01; To = 0xFF5E },
    @{ Name = 'halfwidth-kana'; From = 0xFF61; To = 0xFF9F },
    @{ Name = 'cjk-compat'; From = 0xF900; To = 0xF97F },
    @{ Name = 'special'; From = 0xFFF9; To = 0xFFFF }
)

$astral = @(0x1F600, 0x1F601, 0x1F60A, 0x1F44D, 0x1F4A9, 0x1F680, 0x1F9D1,
            0x20000, 0x20001, 0x2A6D6)

function ConvertTo-Units([int]$codepoint) {
    if ($codepoint -le 0xFFFF) {
        return @([uint16]$codepoint)
    }
    $value = $codepoint - 0x10000
    return @([uint16](0xD800 + ($value -shr 10)), [uint16](0xDC00 + ($value -band 0x3FF)))
}

$failures = New-Object System.Collections.ArrayList
$chunkReport = New-Object System.Collections.ArrayList

function Test-Chunk([string]$name, [uint16[]]$units) {
    $expected = -join ($units | ForEach-Object { [char]$_ })
    Invoke-ClearComposer

    $messageResult = [IntPtr]::Zero
    for ($u = 0; $u -lt $units.Count; $u++) {
        $unit = $units[$u]
        $isHigh = ($unit -ge 0xD800 -and $unit -le 0xDBFF)
        if ($Method -eq 'hybrid' -and $isHigh -and ($u + 1) -lt $units.Count) {
            # Surrogate pair: WM_CHAR drops lone surrogates, VK_PACKET pairs work.
            foreach ($pairUnit in @($units[$u], $units[$u + 1])) {
                Send-One (New-KeyInput ([uint16]0) ([uint16]$pairUnit) ([uint32]$KEYEVENTF_UNICODE))
                Send-One (New-KeyInput ([uint16]0) ([uint16]$pairUnit) ([uint32]($KEYEVENTF_UNICODE -bor $KEYEVENTF_KEYUP)))
            }
            $u++
        }
        elseif ($Method -eq 'vkpacket') {
            Send-One (New-KeyInput ([uint16]0) ([uint16]$unit) ([uint32]$KEYEVENTF_UNICODE))
            Send-One (New-KeyInput ([uint16]0) ([uint16]$unit) ([uint32]($KEYEVENTF_UNICODE -bor $KEYEVENTF_KEYUP)))
        }
        else {
            [void]$N::SendMessageTimeoutW($hwnd, 0x0102, [IntPtr][int]$unit, [IntPtr]1,
                0x0003, 2000, [ref]$messageResult)
        }
        Start-Sleep -Milliseconds $CharDelayMs
    }
    Start-Sleep -Milliseconds 200

    Send-Chord $VK_A $VK_CONTROL
    Start-Sleep -Milliseconds 60
    Send-Chord $VK_C $VK_CONTROL
    Start-Sleep -Milliseconds 250
    $actual = ''
    try { $actual = [string](Get-Clipboard -Raw -ErrorAction Stop) } catch { $actual = '' }
    $actual = $actual -replace "`r`n", "`n"

    $chunkFailures = New-Object System.Collections.ArrayList
    $limit = [Math]::Min($actual.Length, $expected.Length)
    for ($i = 0; $i -lt $limit; $i++) {
        if ($actual[$i] -ne $expected[$i]) {
            [void]$chunkFailures.Add([pscustomobject]@{
                range  = $name
                index  = $i
                expect = ('U+{0:X4}' -f [int]$expected[$i])
                actual = ('U+{0:X4}' -f [int]$actual[$i])
                expectChar = [string]$expected[$i]
                actualChar = [string]$actual[$i]
            })
        }
    }
    $status = if ($chunkFailures.Count -eq 0 -and $actual.Length -eq $expected.Length) {
        'PASS'
    }
    else {
        'FAIL'
    }
    [void]$chunkReport.Add([pscustomobject]@{
        range    = $name
        units    = $units.Count
        expected = $expected.Length
        actual   = $actual.Length
        status   = $status
    })
    foreach ($item in $chunkFailures) { [void]$failures.Add($item) }
    "{0}`t{1}`tunits={2} expected={3} actual={4}" -f $status, $name, $units.Count, $expected.Length, $actual.Length
    if ($chunkFailures.Count -gt 0 -and $chunkFailures.Count -le 8) {
        foreach ($item in $chunkFailures) {
            "      idx={0} expected={1} actual={2}" -f $item.index, $item.expect, $item.actual
        }
    }
    elseif ($chunkFailures.Count -gt 8) {
        "      {0} mismatches, first: idx={1} expected={2} actual={3}" -f `
            $chunkFailures.Count, $chunkFailures[0].index, $chunkFailures[0].expect, $chunkFailures[0].actual
    }
}

"method`t$Method"
"hwnd`t$hwnd dpi=$dpi client=${clientWidth}x${clientHeight}"

foreach ($range in $ranges) {
    $units = @()
    for ($code = $range.From; $code -le $range.To; $code++) {
        $units += @(ConvertTo-Units $code)
    }
    for ($offset = 0; $offset -lt $units.Count; $offset += $ChunkSize) {
        $end = [Math]::Min($offset + $ChunkSize, $units.Count) - 1
        $slice = [uint16[]]$units[$offset..$end]
        $label = if ($units.Count -le $ChunkSize) { $range.Name } else {
            '{0}[{1}-{2}]' -f $range.Name, $offset, $end
        }
        Test-Chunk $label $slice
    }
}

if (-not $SkipAstral) {
    $units = @()
    foreach ($code in $astral) { $units += @(ConvertTo-Units $code) }
    Test-Chunk 'astral' ([uint16[]]$units)
}

Invoke-ClearComposer
if ($savedClipboard) { Set-Clipboard -Value $savedClipboard -ErrorAction SilentlyContinue }
[void]$N::SetCursorPos($savedCursor.X, $savedCursor.Y)

'--- summary ---'
$passed = @($chunkReport | Where-Object { $_.status -eq 'PASS' }).Count
"chunks`t{0}/{1} passed" -f $passed, $chunkReport.Count
"mismatched_characters`t$($failures.Count)"
if ($failures.Count -gt 0) {
    $failures | Group-Object range | ForEach-Object {
        $codes = ($_.Group | ForEach-Object { $_.expect } | Select-Object -Unique) -join ','
        "fail`t{0}`tcount={1}`texpected={2}" -f $_.Name, $_.Count, $codes
    }
}

if ($ReportPath) {
    $lines = @()
    foreach ($row in $chunkReport) {
        $lines += ('{0}`t{1}`t{2}`t{3}`t{4}' -f $row.status, $row.range, $row.units, $row.expected, $row.actual)
    }
    foreach ($item in $failures) {
        $lines += ('DIFF`t{0}`t{1}`t{2}`t{3}' -f $item.range, $item.index, $item.expect, $item.actual)
    }
    $directory = Split-Path -Parent $ReportPath
    if ($directory -and -not (Test-Path $directory)) {
        [void](New-Item -ItemType Directory -Path $directory)
    }
    Set-Content -Path $ReportPath -Value $lines -Encoding UTF8
    "report`t$ReportPath"
}
