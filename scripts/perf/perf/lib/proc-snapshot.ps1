# Electron process memory snapshot (PowerShell 5.1 compatible).
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads -File scripts with
# the active ANSI codepage unless a BOM is present; non-ASCII comments were observed
# to corrupt parsing (a GBK lead byte swallowed the following line).
#
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File proc-snapshot.ps1 <mainPid>
# Output: one-line JSON array ([] when nothing matches).
#   pid / ppid / cls / ws(WorkingSet64) / priv(PrivateMemorySize64) / cpu(total CPU seconds) / threads
#
# Classification uses the process command line: Electron processes share the same
# image name (electron.exe; only --type=... distinguishes main/renderer/GPU/utility).
# The backend worker is utilityProcess.fork(..., serviceName) => --utility-sub-type=node.mojom.NodeService.
#
# IMPORTANT: filter by process tree. Other Electron apps on the same machine may also
# be named electron.exe; without this filter their memory was counted into the target
# app (observed 2-3x inflated totals). A pid belongs to this run when walking up
# ParentProcessId (max 32 hops) reaches <mainPid>.
$ErrorActionPreference = 'SilentlyContinue'
$mainPid = 0
if ($args.Count -ge 1) { [void][int]::TryParse([string]$args[0], [ref]$mainPid) }
if ($mainPid -le 0) { Write-Output '[]'; exit 0 }

# pid -> ppid for every process (one snapshot, a few thousand entries).
$parentOf = @{}
foreach ($row in Get-CimInstance Win32_Process) {
  $parentOf[[int]$row.ProcessId] = [int]$row.ParentProcessId
}

function Test-DescendantOfMain([int]$procId) {
  $cur = $procId
  for ($i = 0; $i -lt 32; $i++) {
    $pp = $parentOf[$cur]
    if ($null -eq $pp -or $pp -le 0) { return $false }
    if ($pp -eq $mainPid) { return $true }
    $cur = $pp
  }
  return $false
}

$rows = @()
$all = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'")
foreach ($p in $all) {
  $pidValue = [int]$p.ProcessId
  if ($pidValue -ne $mainPid -and -not (Test-DescendantOfMain $pidValue)) { continue }
  $gp = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
  if ($null -eq $gp) { continue }
  $cmd = [string]$p.CommandLine
  $cls = 'other'
  if ($pidValue -eq $mainPid) { $cls = 'main' }
  elseif ($cmd -match '--type=renderer') { $cls = 'renderer' }
  elseif ($cmd -match '--type=gpu-process') { $cls = 'gpu' }
  elseif ($cmd -match '--type=utility' -and $cmd -match 'NodeService') { $cls = 'backend-worker' }
  elseif ($cmd -match '--type=utility') { $cls = 'utility' }
  $rows += [pscustomobject]@{
    pid     = $pidValue
    ppid    = [int]$p.ParentProcessId
    cls     = $cls
    ws      = [int64]$gp.WorkingSet64
    priv    = [int64]$gp.PrivateMemorySize64
    cpu     = [double]$gp.CPU
    threads = [int]$gp.Threads.Count
  }
}
if ($rows.Count -eq 0) { Write-Output '[]' } else { Write-Output ($rows | ConvertTo-Json -Compress -Depth 3) }
