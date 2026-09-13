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
 * 计算当前设备指纹（hex sha256）。
 * @returns {{ fingerprint: string, parts: Record<string, string> }}
 */
function getDeviceFingerprint() {
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
  return { fingerprint, parts }
}

module.exports = { getDeviceFingerprint }
