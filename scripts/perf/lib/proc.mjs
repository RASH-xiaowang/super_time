/**
 * 进程内存快照（PowerShell `Get-Process`）与解码缓存目录统计。
 *
 * 主进程 Working Set / Private Bytes 必须由**操作系统**给（任务卡口径）；
 * Electron 的 `app.getAppMetrics()` 作为 per-process 明细的交叉验证一起采。
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB_DIR = fileURLToPath(new URL('.', import.meta.url))
const PS1 = join(LIB_DIR, 'proc-snapshot.ps1')

/**
 * 跑一次进程快照。
 * @param {number} mainPid - Electron 主进程 pid（由 app.evaluate 取到）。
 * @param {number} [timeoutMs]
 * @returns {Promise<Array<{ pid: number, ppid: number, cls: string, ws: number, priv: number, cpu: number, threads: number }>>}
 */
export function snapshotProcesses (mainPid, timeoutMs = 20000) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1, String(mainPid)],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) { resolve({ error: String(err.message || err).slice(0, 200), processes: [] }); return }
        const text = String(stdout || '').trim()
        if (text === '' || text === '[]') { resolve({ processes: [] }); return }
        try {
          const parsed = JSON.parse(text)
          resolve({ processes: Array.isArray(parsed) ? parsed : [parsed] })
        } catch (e) {
          resolve({ error: 'JSON 解析失败: ' + String(e.message).slice(0, 120), processes: [] })
        }
      },
    )
  })
}

/**
 * 采集运行环境（CPU / 内存 / OS / 浏览器与 Node 版本）。
 *
 * 报告里必须写清"在哪台机器上量的"，否则跨运行的数字没有可比性。
 * @param {string} root - 仓库根（用于读 electron/package.json 版本）。
 * @returns {Promise<object>}
 */
export function collectHostInfo (root) {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1 Name,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed",
    "$cs = Get-CimInstance Win32_ComputerSystem | Select-Object -First 1 TotalPhysicalMemory",
    "$os = Get-CimInstance Win32_OperatingSystem | Select-Object -First 1 Caption,Version,BuildNumber,CSName",
    "[pscustomobject]@{ cpu=$cpu; cs=$cs; os=$os } | ConvertTo-Json -Compress -Depth 4",
  ].join('; ')
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 20000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const out = { hostError: err ? String(err.message || err).slice(0, 200) : null }
        try {
          const parsed = JSON.parse(String(stdout || '').trim())
          out.cpu = {
            name: parsed?.cpu?.Name ?? null,
            cores: parsed?.cpu?.NumberOfCores ?? null,
            logicalProcessors: parsed?.cpu?.NumberOfLogicalProcessors ?? null,
            maxClockMhz: parsed?.cpu?.MaxClockSpeed ?? null,
          }
          out.ramBytes = parsed?.cs?.TotalPhysicalMemory ?? null
          out.os = {
            caption: parsed?.os?.Caption ?? null,
            version: parsed?.os?.Version ?? null,
            build: parsed?.os?.BuildNumber ?? null,
            hostname: parsed?.os?.CSName ?? null,
          }
        } catch (e) {
          out.parseError = String(e.message || e).slice(0, 120)
        }
        try {
          const pkg = JSON.parse(readFileSync(join(root, 'node_modules', 'electron', 'package.json'), 'utf8'))
          out.electronPackageVersion = pkg.version ?? null
        } catch { out.electronPackageVersion = null }
        resolve(out)
      })
  })
}

/**
 * 把进程快照归并成按 class 的汇总（main/renderer/gpu/backend-worker/utility）。
 * @param {Array<{ pid: number, cls: string, ws: number, priv: number, cpu: number, ppid: number }>} processes
 */
export function summarizeProcesses (processes) {
  const byClass = {}
  let totalWs = 0
  let totalPriv = 0
  let totalCpu = 0
  for (const p of processes) {
    const key = p.cls || 'other'
    if (!byClass[key]) byClass[key] = { count: 0, workingSetBytes: 0, privateBytes: 0, cpuSeconds: 0, pids: [] }
    byClass[key].count += 1
    byClass[key].workingSetBytes += Number(p.ws) || 0
    byClass[key].privateBytes += Number(p.priv) || 0
    byClass[key].cpuSeconds += Number(p.cpu) || 0
    byClass[key].pids.push(p.pid)
    totalWs += Number(p.ws) || 0
    totalPriv += Number(p.priv) || 0
    totalCpu += Number(p.cpu) || 0
  }
  return {
    processCount: processes.length,
    totalWorkingSetBytes: totalWs,
    totalPrivateBytes: totalPriv,
    totalCpuSeconds: Math.round(totalCpu * 100) / 100,
    byClass,
  }
}

/**
 * 解码缓存（decoded_images）统计：总文件数 + 自 `sinceMs` 以来有变化的目录里的新增文件/字节。
 *
 * 之所以不每次递归 stat 全部 4.8 万个文件（本机实测 2.2s）：用目录 mtime 先筛，
 * 只对"最近有写入"的目录 stat 文件（<100ms）。总文件数走 recursive readdir（44ms）。
 *
 * @param {string} dir - decoded_images 根。
 * @param {number} sinceMs - 只统计 mtime > sinceMs 的目录里的文件（做增量）。
 */
export async function decodedCacheStats (dir, sinceMs) {
  const out = { dir, files: 0, totalBytesKnown: false, deltaFiles: 0, deltaBytes: 0, changedDirs: 0, error: null }
  let entries
  try {
    entries = await readdir(dir, { recursive: true, withFileTypes: true })
  } catch (e) {
    out.error = String(e.message || e).slice(0, 160)
    return out
  }
  const dirMtime = new Map()
  for (const e of entries) {
    if (!e.isFile()) continue
    out.files += 1
    const parent = e.parentPath ?? join(dir, e.name)
    let mtime = dirMtime.get(parent)
    if (mtime === undefined) {
      try { mtime = (await stat(parent)).mtimeMs } catch { mtime = 0 }
      dirMtime.set(parent, mtime)
    }
    if (mtime > sinceMs) {
      out.deltaFiles += 1
      try { out.deltaBytes += (await stat(join(parent, e.name))).size } catch { /* ignore */ }
    }
  }
  out.changedDirs = [...dirMtime.values()].filter((m) => m > sinceMs).length
  return out
}

/**
 * 只数文件（不 stat），比 `decodedCacheStats` 更便宜；用于不关心增量的快照。
 * @param {string} dir
 */
export async function countDecodedFiles (dir) {
  try {
    let files = 0
    for await (const d of await readdir(dir, { recursive: true, withFileTypes: true })) if (d.isFile()) files += 1
    return files
  } catch {
    return null
  }
}
