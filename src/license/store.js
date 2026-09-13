/**
 * 许可证文件读写：固定放在 Electron userData/license.json。
 * 结构：{ payload, signature, importedAt }
 */
const fs = require('node:fs')
const path = require('node:path')

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
  fs.writeFileSync(p, JSON.stringify(doc, null, 2), 'utf8')
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

module.exports = {
  licensePath,
  readLicenseFile,
  writeLicenseFile,
  deleteLicenseFile,
}
