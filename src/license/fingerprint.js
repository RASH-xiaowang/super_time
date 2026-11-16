/**
 * 设备指纹：本机稳定特征的 SHA-256，用于绑定许可证。
 *
 * Windows 优先取 MachineGuid + 主机名 + CPU + 内存 + 系统盘卷序列号。
 * 任一维度变化都可能导致指纹变化（换机/重装）；同机重装应用不影响。
 */
const crypto = require('node:crypto')
const os = require('node:os')
const { execFileSync } = require('node:child_process')

function safeExec(cmd, args) {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 4000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    return ''
  }
}

function readMachineGuid() {
  if (process.platform !== 'win32') return ''
  const out = safeExec('reg', [
    'query',
    'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
    '/v',
    'MachineGuid',
  ])
  const m = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out)
  return m ? m[1] : ''
}

function readSystemVolumeSerial() {
  if (process.platform !== 'win32') return ''
  // C: 卷序列号；失败则退回空
  const out = safeExec('cmd.exe', ['/c', 'vol C:'])
  const m = /Serial number is ([0-9A-F]+)/i.exec(out)
  return m ? m[1] : ''
}

function cpuSignature() {
  const cpus = os.cpus()
  const model = cpus[0]?.model ?? 'unknown'
  return `${model}|${cpus.length}`
}

/**
 * 进程内缓存。
 *
 * 指纹采集在 Windows 上要起 `reg` 与 `cmd /c vol` 两个子进程（各 4s 超时），而
 * `getLicenseStatus()` 会在**每一次**过闸调用里走到这里（HTTP 远程访问与桌面 IPC
 * 共用同一道闸）。不缓存的话，每次聊天列表刷新都要再起一次子进程 —— 这是纯粹的
 * 固定开销，而且采集结果在进程生命周期内不会变。
 *
 * 失效点：许可证导入/删除（`service.js`）与显式刷新（`refreshDeviceFingerprint()`）。
 * 用对象引用缓存，测试可以据此断言「第二次没有重新采集」。
 * @type {{ fingerprint: string, parts: Record<string, string> } | null}
 */
let cached = null

/**
 * 计算当前设备指纹（hex sha256）。
 * @returns {{ fingerprint: string, parts: Record<string, string> }}
 */
function getDeviceFingerprint() {
  if (cached !== null) return cached
  const parts = {
    platform: process.platform,
    arch: process.arch,
    machineGuid: readMachineGuid() || 'no-machine-guid',
    hostname: os.hostname(),
    cpu: cpuSignature(),
    mem: String(os.totalmem()),
    volume: readSystemVolumeSerial() || 'no-volume',
  }
  const material = [
    parts.platform,
    parts.arch,
    parts.machineGuid,
    parts.hostname,
    parts.cpu,
    parts.mem,
    parts.volume,
  ].join('||')
  const fingerprint = crypto.createHash('sha256').update(material, 'utf8').digest('hex')
  cached = { fingerprint, parts }
  return cached
}

/** 丢弃进程内缓存（许可证导入/删除、或调用方显式要求重新采集时用）。 */
function clearFingerprintCache() {
  cached = null
}

/** 显式刷新：清缓存并立刻重新采集一次。 */
function refreshDeviceFingerprint() {
  clearFingerprintCache()
  return getDeviceFingerprint()
}

module.exports = { getDeviceFingerprint, clearFingerprintCache, refreshDeviceFingerprint }
