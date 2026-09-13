/**
 * Super Time License Studio — 厂商本地发证工具（Electron）
 *
 * 功能：
 * 1. 管理/生成 Ed25519 密钥对（私钥仅本机 vendor-keys）
 * 2. 导入客户「激活请求」JSON 或手填设备指纹
 * 3. 按授权策略签发 license.json
 * 4. 校验已签发许可证（用当前公钥）
 *
 * 运行：在项目根执行
 *   node_modules\electron\dist\electron.exe tools\license-studio
 * 或双击 tools\LicenseStudio.cmd
 */
const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const ROOT = path.join(__dirname, '..', '..')
const { generateKeyPair, signPayload, verifyPayload } = require(path.join(ROOT, 'src', 'license', 'crypto'))
const { PRODUCT_ID, KNOWN_FEATURES, validatePayload } = require(path.join(ROOT, 'src', 'license', 'schema'))

const VENDOR_DIR = path.join(ROOT, 'vendor-keys')
const PRIV_PATH = path.join(VENDOR_DIR, 'license-private.pem')
const PUB_PATH = path.join(VENDOR_DIR, 'license-public.pem')
const CLIENT_PUB = path.join(ROOT, 'src', 'license', 'public-key.js')

let win = null

function ensureVendorDir() {
  fs.mkdirSync(VENDOR_DIR, { recursive: true })
}

function readKeys() {
  ensureVendorDir()
  const hasPrivate = fs.existsSync(PRIV_PATH)
  const hasPublic = fs.existsSync(PUB_PATH)
  const publicKeyPem = hasPublic ? fs.readFileSync(PUB_PATH, 'utf8') : ''
  let clientPublicKeyPem = ''
  try {
    delete require.cache[require.resolve(CLIENT_PUB)]
    clientPublicKeyPem = require(CLIENT_PUB).PUBLIC_KEY_PEM || ''
  } catch {
    clientPublicKeyPem = ''
  }
  const derivedFromPrivate = hasPrivate
    ? crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(PRIV_PATH, 'utf8')))
        .export({ type: 'spki', format: 'pem' }).toString()
    : ''
  const matchClient = !!(publicKeyPem && clientPublicKeyPem && publicKeyPem.trim() === clientPublicKeyPem.trim())
  const matchPrivate = !!(derivedFromPrivate && publicKeyPem && derivedFromPrivate.trim() === publicKeyPem.trim())
  return {
    hasPrivate,
    hasPublic,
    privatePath: PRIV_PATH,
    publicPath: PUB_PATH,
    clientPublicPath: CLIENT_PUB,
    publicKeyPem,
    clientPublicKeyPem,
    matchClient,
    matchPrivate,
  }
}

function loadPrivate() {
  if (!fs.existsSync(PRIV_PATH)) {
    throw new Error('缺少私钥：请先「生成密钥对」或放入 vendor-keys/license-private.pem')
  }
  return fs.readFileSync(PRIV_PATH, 'utf8')
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 720,
    minHeight: 560,
    backgroundColor: '#0b1220',
    title: 'Super Time License Studio',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.loadFile(path.join(__dirname, 'index.html'))
  win.setMenuBarVisibility(false)
}

function registerIpc() {
  ipcMain.handle('studio:keys', () => readKeys())

  ipcMain.handle('studio:generate-keys', async () => {
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['生成', '取消'],
      defaultId: 1,
      cancelId: 1,
      title: '生成新密钥对',
      message: '将生成新的 Ed25519 密钥对并覆盖 vendor-keys/，同时同步客户端公钥。',
      detail: '旧私钥签发的许可证将全部失效。生成后需重启 Super Time 主程序。',
    })
    if (response !== 0) return { ok: false, canceled: true }
    ensureVendorDir()
    const keys = generateKeyPair()
    fs.writeFileSync(PRIV_PATH, keys.privateKeyPem, { mode: 0o600 })
    fs.writeFileSync(PUB_PATH, keys.publicKeyPem)
    const js = `/**
 * 客户端内嵌公钥（Ed25519 SPK PEM）。
 * 必须与 vendor-keys/license-private.pem 同源。
 */
const PUBLIC_KEY_PEM = ${JSON.stringify(keys.publicKeyPem)}

module.exports = { PUBLIC_KEY_PEM }
`
    fs.writeFileSync(CLIENT_PUB, js, 'utf8')
    return { ok: true, ...readKeys() }
  })

  ipcMain.handle('studio:sync-client-pub', () => {
    try {
      if (!fs.existsSync(PUB_PATH)) return { ok: false, error: '缺少 vendor-keys/license-public.pem' }
      const pem = fs.readFileSync(PUB_PATH, 'utf8')
      const js = `/**
 * 客户端内嵌公钥（Ed25519 SPK PEM）。
 * 必须与 vendor-keys/license-private.pem 同源。
 */
const PUBLIC_KEY_PEM = ${JSON.stringify(pem)}

module.exports = { PUBLIC_KEY_PEM }
`
      fs.writeFileSync(CLIENT_PUB, js, 'utf8')
      return { ok: true, ...readKeys() }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('studio:import-request', async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: '导入激活请求',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
    try {
      const data = JSON.parse(fs.readFileSync(picked.filePaths[0], 'utf8'))
      if (!data || typeof data.fingerprint !== 'string') {
        return { ok: false, error: '无效的激活请求：缺少 fingerprint' }
      }
      return {
        ok: true,
        path: picked.filePaths[0],
        request: {
          fingerprint: data.fingerprint,
          hostname: data.hostname || '',
          appVersion: data.appVersion || '1.0.0',
          product: data.product || PRODUCT_ID,
        },
      }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('studio:issue', async (_e, form) => {
    try {
      const fingerprint = String(form?.fingerprint || '').trim()
      if (fingerprint.length < 32) {
        return { ok: false, error: '设备指纹无效（至少 32 位 hex）' }
      }
      const name = String(form?.name || '').trim()
      if (!name) return { ok: false, error: '客户名称必填' }

      const features = Array.isArray(form?.features) && form.features.length
        ? form.features.map(String)
        : KNOWN_FEATURES.slice()
      const seats = Number.isInteger(form?.seats) && form.seats >= 1 ? form.seats : 1
      const days = Number.isFinite(form?.days) ? form.days : 365
      const now = new Date()
      const expiresAt = days > 0
        ? new Date(now.getTime() + days * 24 * 3600 * 1000).toISOString()
        : null

      const payload = {
        product: PRODUCT_ID,
        licenseId: crypto.randomUUID(),
        edition: String(form?.edition || 'pro'),
        issuedTo: {
          name,
          company: String(form?.company || ''),
          email: String(form?.email || ''),
        },
        device: {
          fingerprint,
          ...(form?.hostname ? { label: String(form.hostname) } : {}),
        },
        issuedAt: now.toISOString(),
        notBefore: now.toISOString(),
        expiresAt,
        features,
        seats,
        appVersionMin: String(form?.appVersionMin || '1.0.0'),
        notes: String(form?.notes || ''),
      }

      const struct = validatePayload(payload)
      if (!struct.ok) return { ok: false, error: struct.reason }

      const privateKeyPem = loadPrivate()
      const signature = signPayload(payload, privateKeyPem)
      const doc = { payload, signature }

      const defaultName = `license-${name.replace(/[\\/:*?"<>|]/g, '_')}-${payload.licenseId.slice(0, 8)}.json`
      const saved = await dialog.showSaveDialog(win, {
        title: '保存许可证',
        defaultPath: defaultName,
        filters: [{ name: 'License JSON', extensions: ['json'] }],
      })
      if (saved.canceled || !saved.filePath) return { ok: false, canceled: true }

      fs.writeFileSync(saved.filePath, JSON.stringify(doc, null, 2), 'utf8')
      return {
        ok: true,
        path: saved.filePath,
        payload,
        preview: JSON.stringify(doc, null, 2),
      }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('studio:verify-file', async () => {
    const picked = await dialog.showOpenDialog(win, {
      title: '选择许可证文件',
      properties: ['openFile'],
      filters: [{ name: 'License', extensions: ['json'] }],
    })
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true }
    try {
      const doc = JSON.parse(fs.readFileSync(picked.filePaths[0], 'utf8'))
      if (!doc?.payload || !doc?.signature) return { ok: false, error: '格式错误：需要 payload + signature' }
      const struct = validatePayload(doc.payload)
      if (!struct.ok) return { ok: false, error: `结构无效: ${struct.reason}` }
      const keys = readKeys()
      if (!keys.publicKeyPem) return { ok: false, error: '缺少公钥' }
      const sig = verifyPayload(doc.payload, doc.signature, keys.publicKeyPem)
      return {
        ok: sig.ok,
        error: sig.ok ? undefined : sig.reason,
        path: picked.filePaths[0],
        payload: doc.payload,
        checkedAt: new Date().toISOString(),
      }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('studio:copy', async (_e, text) => {
    const { clipboard } = require('electron')
    clipboard.writeText(String(text ?? ''))
    return true
  })
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
