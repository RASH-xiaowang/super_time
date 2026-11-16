/**
 * 许可证文件读写：固定放在 Electron userData/license.json。
 * 结构：{ payload, signature, importedAt }
 *
 * ## 为什么写要经过临时文件 + rename
 *
 * 直接 `writeFileSync` 在「写一半进程被杀 / 磁盘满」时会留下**截断的 JSON**。
 * 读取侧对损坏文件只能 return null ⇒ 用户看到「许可证突然没了」，而且下一次保存
 * 会把这个残缺状态覆盖掉，原始内容再也找不回来。rename 在同一卷上是原子的：
 * 要么是旧文件，要么是完整的新文件。覆盖前再留一份 `license.json.bak`，
 * 给「导入错了证」留一条手工回退路径。
 *
 * ## last-seen（回拨检测）
 *
 * `license-last-seen.json` 记录最近一次看到的时间。它不是授权依据，只用于发现
 * 系统时钟被调回过去（参见 `schema.js` 的 `CLOCK_ROLLBACK`）。读写都走同一套
 * 原子写；文件损坏时按「没有记录」处理，不能让坏文件挡住正常授权。
 */
const fs = require('node:fs')
const path = require('node:path')

/** 同一目录、同卷 ⇒ rename 才是原子的。 */
function writeFileAtomic(target, text) {
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
    // Windows 上目标被瞬态句柄占用时 rename 会 EPERM（与 atomic-json.js 同因）；
    // 有限重试，避免一次杀软扫描让「导入许可证」失败。
    let lastErr = null
    for (let i = 0; i < 5; i += 1) {
      try {
        fs.renameSync(tmp, target)
        return
      } catch (e) {
        lastErr = e
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20) } catch { /* 不支持就不等 */ }
      }
    }
    throw lastErr
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* 清理失败不掩盖原错误 */ }
    throw e
  }
}

function licensePath(userDataDir) {
  return path.join(userDataDir, 'license.json')
}

function readLicenseFile(userDataDir) {
  const p = licensePath(userDataDir)
  try {
    if (!fs.existsSync(p)) return null
    const raw = fs.readFileSync(p, 'utf8')
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object') return null
    return data
  } catch {
    return null
  }
}

function writeLicenseFile(userDataDir, doc) {
  const p = licensePath(userDataDir)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const text = JSON.stringify(doc, null, 2)
  // 覆盖前留一份上一版：导入错证 / 文件损坏时还能手工回退。
  try {
    if (fs.existsSync(p)) fs.copyFileSync(p, `${p}.bak`)
  } catch { /* 备份失败不阻止本次写入 */ }
  writeFileAtomic(p, text)
  return p
}

function deleteLicenseFile(userDataDir) {
  const p = licensePath(userDataDir)
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p)
    return true
  } catch {
    return false
  }
}

/** last-seen 文件路径（与 license.json 同目录）。 */
function lastSeenPath(userDataDir) {
  return path.join(userDataDir, 'license-last-seen.json')
}

/**
 * 读最近一次观察到的授权时间。
 * @returns {number|null} epoch 毫秒；没有/损坏时为 null。
 */
function readLastSeen(userDataDir) {
  try {
    const doc = JSON.parse(fs.readFileSync(lastSeenPath(userDataDir), 'utf8'))
    const at = Number(doc?.at)
    return Number.isFinite(at) && at > 0 ? at : null
  } catch {
    return null
  }
}

/** 原子写最近一次观察时间（秒级抖动无所谓，只用于回拨检测）。 */
function writeLastSeen(userDataDir, atMs) {
  const at = Number(atMs)
  if (!Number.isFinite(at) || at <= 0) return false
  const p = lastSeenPath(userDataDir)
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    writeFileAtomic(p, JSON.stringify({ at: Math.floor(at), updatedAt: new Date(at).toISOString() }) + '\n')
    return true
  } catch {
    return false
  }
}

/** 删除 last-seen（许可证被移除时清掉，避免下次导入继承旧基线）。 */
function clearLastSeen(userDataDir) {
  try {
    fs.rmSync(lastSeenPath(userDataDir), { force: true })
    return true
  } catch {
    return false
  }
}

module.exports = {
  licensePath,
  readLicenseFile,
  writeLicenseFile,
  deleteLicenseFile,
  lastSeenPath,
  readLastSeen,
  writeLastSeen,
  clearLastSeen,
}
