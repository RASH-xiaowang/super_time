#!/usr/bin/env node
/**
 * Super Time 授权签发台 — 发证引擎（JSON CLI）。
 *
 * Win32 原生界面通过本脚本调用现有 `src/license` 与 `scripts/license-key-path`，
 * 不在 C++ 里重写 Ed25519 / 载荷格式，以免和主应用验签不兼容。
 *
 * 用法：
 *   node engine.js meta
 *   node engine.js keys
 *   node engine.js generate-keys --yes
 *   node engine.js sync-client-pub
 *   node engine.js import-request --in <file>
 *   node engine.js issue --form <file> --out <file>
 *   node engine.js verify --in <file>
 *
 * 全局可选参数（用于隔离测试，生产界面不传）：
 *   --repo-root <dir>
 *   --vendor-dir <dir>
 *   --client-pub <file>
 *   --private-key <file>
 *
 * 标准输出始终是一个 JSON 对象；密钥材料（PEM）不会写进输出。
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

function arg(name, def = null) {
  const flag = `--${name}`
  const i = process.argv.indexOf(flag)
  if (i >= 0 && process.argv[i + 1] && !String(process.argv[i + 1]).startsWith('--')) {
    return process.argv[i + 1]
  }
  return def
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`)
}

function fail(error, extra = {}) {
  process.stdout.write(JSON.stringify({ ok: false, error: String(error), ...extra }) + '\n')
  process.exit(0)
}

function ok(data) {
  process.stdout.write(JSON.stringify({ ok: true, ...data }) + '\n')
}

const engineDir = __dirname
const defaultRepoRoot = path.join(engineDir, '..', '..')
const repoRoot = path.resolve(arg('repo-root', defaultRepoRoot))

const { generateKeyPair, signPayload, verifyPayload } = require(path.join(repoRoot, 'src', 'license', 'crypto'))
const {
  PRODUCT_ID,
  FEATURE_CATALOG,
  FEATURE_GROUPS,
  FEATURE_SCHEMA_VERSION,
  REQUIRED_FEATURES,
  validatePayload,
  isKnownFeature,
  featureLabel,
} = require(path.join(repoRoot, 'src', 'license', 'schema'))
const {
  APP_CAPABILITIES,
  DEFAULT_APP_CAPABILITIES,
  DEFAULT_APP_MAX_JOBS_PER_HOUR,
} = require(path.join(repoRoot, 'src', 'license', 'features'))
const {
  resolvePrivateKeyPath,
  describeKeyFailure,
  ENV_KEY,
  KEY_FILE,
} = require(path.join(repoRoot, 'scripts', 'license-key-path'))

const vendorDir = path.resolve(arg('vendor-dir', path.join(repoRoot, 'vendor-keys')))
const pubPath = path.join(vendorDir, 'license-public.pem')
const clientPubPath = path.resolve(arg('client-pub', path.join(repoRoot, 'src', 'license', 'public-key.js')))

function resolvePrivate(options = {}) {
  const env = { ...process.env, ...(options.env || {}) }
  const explicit = arg('private-key')
  if (explicit) env[ENV_KEY] = path.resolve(explicit)
  return resolvePrivateKeyPath({ env, repoRoot, homeDir: options.homeDir })
}

function privateKeyPathOrThrow() {
  const where = resolvePrivate()
  if (!where.ok) throw new Error(describeKeyFailure(where))
  return where
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function readClientPublicPem() {
  try {
    delete require.cache[require.resolve(clientPubPath)]
    return String(require(clientPubPath).PUBLIC_KEY_PEM || '')
  } catch {
    return ''
  }
}

function publicPemFromPrivate(privPem) {
  return crypto
    .createPublicKey(crypto.createPrivateKey(privPem))
    .export({ type: 'spki', format: 'pem' })
    .toString()
}

function readKeys() {
  let privPath = ''
  let privError = ''
  let privateSource = ''
  const where = resolvePrivate()
  if (!where.ok) {
    privError = describeKeyFailure(where)
  } else {
    privPath = where.path
    privateSource = where.source
  }
  const hasPrivate = privPath !== '' && fs.existsSync(privPath)
  const hasPublic = fs.existsSync(pubPath)
  const publicKeyPem = hasPublic ? fs.readFileSync(pubPath, 'utf8') : ''
  const clientPublicKeyPem = readClientPublicPem()
  let derivedFromPrivate = ''
  if (hasPrivate) {
    try {
      derivedFromPrivate = publicPemFromPrivate(fs.readFileSync(privPath, 'utf8'))
    } catch (err) {
      privError = privError || `私钥无法读取：${err.message}`
    }
  }
  const matchClient = !!(publicKeyPem && clientPublicKeyPem && publicKeyPem.trim() === clientPublicKeyPem.trim())
  const matchPrivate = !!(derivedFromPrivate && publicKeyPem && derivedFromPrivate.trim() === publicKeyPem.trim())
  // 真正决定「签出来的证能不能被主程序验过」的是**客户端内嵌公钥**与私钥是否同源；
  // vendor-keys 只是厂商侧的留档。缺 vendor 文件时这条仍能给出一致的结论。
  const matchDerivedClient = !!(
    derivedFromPrivate && clientPublicKeyPem && derivedFromPrivate.trim() === clientPublicKeyPem.trim()
  )
  return {
    hasPrivate,
    hasPublic,
    hasClientPublic: !!clientPublicKeyPem,
    privatePath: privPath,
    privateError: privError,
    privateSource,
    publicPath: pubPath,
    clientPublicPath: clientPubPath,
    matchClient,
    matchPrivate,
    matchDerivedClient,
  }
}

function clientPublicSource(pem) {
  return `/**
 * 客户端内嵌公钥（Ed25519 SPK PEM）。
 * 必须与仓库外的签发私钥（默认 ~/.supertime/${KEY_FILE}）同源。
 */
const PUBLIC_KEY_PEM = ${JSON.stringify(pem)}

module.exports = { PUBLIC_KEY_PEM }
`
}

function writeClientPublic(pem) {
  ensureDir(path.dirname(clientPubPath))
  fs.writeFileSync(clientPubPath, clientPublicSource(pem), 'utf8')
}

function cmdMeta() {
  ok({
    product: PRODUCT_ID,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    requiredFeatures: REQUIRED_FEATURES,
    featureCatalog: FEATURE_CATALOG,
    featureGroups: FEATURE_GROUPS,
    appCapabilities: APP_CAPABILITIES,
    // 界面默认值：签发台打开「应用托管额度」时直接取这两个数，
    // 不在 C++ 里重复写一份 120 / 全开，避免两边漂。
    defaultAppCapabilities: DEFAULT_APP_CAPABILITIES,
    defaultAppMaxJobsPerHour: DEFAULT_APP_MAX_JOBS_PER_HOUR,
    editions: [
      { value: 'pro', label: '专业版' },
      { value: 'standard', label: '标准版' },
      { value: 'trial-ext', label: '试用扩展版' },
    ],
  })
}

function cmdKeys() {
  ok(readKeys())
}

function cmdGenerateKeys() {
  if (!hasFlag('yes')) {
    fail('生成密钥需要先确认（缺少 --yes）。旧私钥签发的许可证将全部失效。')
  }
  const where = privateKeyPathOrThrow()
  ensureDir(vendorDir)
  ensureDir(path.dirname(where.path))
  const keys = generateKeyPair()
  fs.writeFileSync(where.path, keys.privateKeyPem, { mode: 0o600 })
  fs.writeFileSync(pubPath, keys.publicKeyPem)
  writeClientPublic(keys.publicKeyPem)
  ok({ generated: true, ...readKeys() })
}

function cmdSyncClientPub() {
  if (!fs.existsSync(pubPath)) fail('缺少公钥文件（vendor-keys/license-public.pem）')
  const pem = fs.readFileSync(pubPath, 'utf8')
  writeClientPublic(pem)
  ok({ synced: true, ...readKeys() })
}

function cmdImportRequest() {
  const file = arg('in')
  if (!file) fail('缺少 --in')
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    fail(`无法解析激活请求：${err.message}`)
  }
  if (!data || typeof data.fingerprint !== 'string') {
    fail('无效的激活请求：缺少 fingerprint')
  }
  ok({
    path: path.resolve(file),
    request: {
      fingerprint: data.fingerprint,
      hostname: data.hostname || '',
      appVersion: data.appVersion || data.appVersionMin || '1.0.0',
      product: data.product || PRODUCT_ID,
    },
  })
}

function buildPayload(form) {
  const fingerprint = String(form?.fingerprint || '').trim()
  if (!/^[a-fA-F0-9]{32,}$/.test(fingerprint)) {
    return { error: '设备指纹无效：应为至少 32 位的十六进制字符' }
  }
  const name = String(form?.name || '').trim()
  if (!name) return { error: '客户名称必填' }

  const picked = Array.isArray(form?.features) ? [...new Set(form.features.map(String))] : []
  const unknown = picked.filter((feature) => !isKnownFeature(feature))
  if (unknown.length) return { error: `存在未知功能项：${unknown.join('、')}` }
  for (const required of REQUIRED_FEATURES) {
    if (!picked.includes(required)) picked.push(required)
  }
  const features = FEATURE_CATALOG
    .filter((feature) => picked.includes(feature.id))
    .map((feature) => feature.id)
  if (!features.length) return { error: '至少需要选择“基础数据访问”功能' }

  const seats = Number.isInteger(form?.seats) && form.seats >= 1 ? form.seats : 1
  const days = Number.isInteger(form?.days) && form.days >= 0 ? form.days : 365
  const now = new Date()
  const expiresAt = days > 0
    ? new Date(now.getTime() + days * 24 * 3600 * 1000).toISOString()
    : null

  const apps = buildAppsSection(form, features, seats)
  if (apps.error) return { error: apps.error }

  const hostname = String(form?.hostname || '').trim()
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
      ...(hostname ? { label: hostname } : {}),
    },
    issuedAt: now.toISOString(),
    notBefore: now.toISOString(),
    expiresAt,
    features,
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    seats,
    ...(apps.value === undefined ? {} : { apps: apps.value }),
    appVersionMin: String(form?.appVersionMin || '1.0.0'),
    notes: String(form?.notes || ''),
  }

  const struct = validatePayload(payload)
  if (!struct.ok) return { error: struct.reason }
  return { payload }
}

/**
 * 组装应用托管段。
 *
 * 只有勾了 `apps-superlanguage` 才写 `apps`（没开通就不留半截额度，避免被误读）。
 * 实例数缺省沿用表单的「席位数」—— Super Time 自身按设备指纹绑定，`seats`
 * 目前没有被占用，把它解释成「可绑定的应用实例数」对客户最直观。
 * @param {object} form - 签发表单。
 * @param {string[]} features - 已选功能位（含必选项）。
 * @param {number} seats - 表单席位数。
 * @returns {{ value?: object, error?: string }}
 */
function buildAppsSection(form, features, seats) {
  if (!features.includes('apps-superlanguage')) {
    if (form?.apps != null) return { error: '未勾选「SuperLanguage 应用托管」，不能填写应用额度' }
    return {}
  }
  const raw = form?.apps && typeof form.apps === 'object' ? form.apps : {}
  const known = new Set(APP_CAPABILITIES.map((item) => item.id))
  const rawCaps = Array.isArray(raw.caps) ? raw.caps.map(String) : [...DEFAULT_APP_CAPABILITIES]
  const caps = [...new Set(rawCaps)]
  const unknown = caps.filter((cap) => !known.has(cap))
  if (unknown.length > 0) return { error: `未知应用能力：${unknown.join('、')}` }
  if (caps.length === 0) return { error: '应用能力至少选择一项' }
  const maxInstances = Number.isInteger(raw.maxInstances) && raw.maxInstances >= 1
    ? raw.maxInstances
    : seats
  const maxJobsPerHour = Number.isInteger(raw.maxJobsPerHour) && raw.maxJobsPerHour >= 1
    ? raw.maxJobsPerHour
    : DEFAULT_APP_MAX_JOBS_PER_HOUR
  return {
    value: {
      superlanguage: {
        maxInstances,
        caps,
        maxJobsPerHour,
        standalone: raw.standalone === true,
      },
    },
  }
}

function loadPrivatePem() {
  const where = privateKeyPathOrThrow()
  if (!fs.existsSync(where.path)) {
    throw new Error(
      `缺少私钥：${where.path}\n请先「生成密钥对」（私钥写在仓库之外，默认 ~/.supertime/），`
        + `或用环境变量 ${ENV_KEY} 指向已有私钥`,
    )
  }
  return fs.readFileSync(where.path, 'utf8')
}

function cmdIssue() {
  const formPath = arg('form')
  const outPath = arg('out')
  if (!formPath) fail('缺少 --form')
  if (!outPath) fail('缺少 --out')
  let form
  try {
    const raw = formPath === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(formPath, 'utf8')
    form = JSON.parse(raw)
  } catch (err) {
    fail(`无法读取签发表单：${err.message}`)
  }
  const built = buildPayload(form)
  if (built.error) fail(built.error)
  let privateKeyPem
  try {
    privateKeyPem = loadPrivatePem()
  } catch (err) {
    fail(err.message)
  }
  const signature = signPayload(built.payload, privateKeyPem)
  const doc = { payload: built.payload, signature }
  ensureDir(path.dirname(path.resolve(outPath)))
  fs.writeFileSync(outPath, JSON.stringify(doc, null, 2), 'utf8')
  ok({
    path: path.resolve(outPath),
    payload: built.payload,
    featureLabels: built.payload.features.map(featureLabel),
  })
}

function cmdVerify() {
  const file = arg('in')
  if (!file) fail('缺少 --in')
  let doc
  try {
    doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (err) {
    fail(`无法解析许可证：${err.message}`)
  }
  if (!doc?.payload || !doc?.signature) fail('格式错误：需要 payload + signature')
  const struct = validatePayload(doc.payload)
  if (!struct.ok) fail(`结构无效: ${struct.reason}`)
  const keys = readKeys()
  if (!keys.hasPublic) fail('缺少公钥')
  const publicKeyPem = fs.readFileSync(pubPath, 'utf8')
  const sig = verifyPayload(doc.payload, doc.signature, publicKeyPem)
  if (!sig.ok) {
    fail(sig.reason || 'signature_invalid', {
      path: path.resolve(file),
      payload: doc.payload,
      featureSchemaVersion: doc.payload.featureSchemaVersion ?? null,
      featureLabels: Array.isArray(doc.payload.features) ? doc.payload.features.map(featureLabel) : [],
      checkedAt: new Date().toISOString(),
    })
  }
  ok({
    path: path.resolve(file),
    payload: doc.payload,
    featureSchemaVersion: doc.payload.featureSchemaVersion ?? null,
    featureLabels: Array.isArray(doc.payload.features) ? doc.payload.features.map(featureLabel) : [],
    checkedAt: new Date().toISOString(),
  })
}

function firstCommand() {
  const valueOpts = new Set(['repo-root', 'vendor-dir', 'client-pub', 'private-key', 'in', 'form', 'out'])
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h' || a === 'help') return 'help'
    if (a.startsWith('--')) {
      const name = a.slice(2)
      if (valueOpts.has(name)) i += 1
      continue
    }
    return a
  }
  return null
}

function main() {
  const command = firstCommand()
  if (!command || command === 'help') {
    fail('未知命令。可用：meta、keys、generate-keys、sync-client-pub、import-request、issue、verify')
  }
  try {
    switch (command) {
      case 'meta':
        return cmdMeta()
      case 'keys':
        return cmdKeys()
      case 'generate-keys':
        return cmdGenerateKeys()
      case 'sync-client-pub':
        return cmdSyncClientPub()
      case 'import-request':
        return cmdImportRequest()
      case 'issue':
        return cmdIssue()
      case 'verify':
        return cmdVerify()
      default:
        fail(`未知命令：${command}`)
    }
  } catch (err) {
    fail(err && err.message ? err.message : String(err))
  }
}

main()
