#!/usr/bin/env node
/**
 * License 冒烟测试：生成密钥 → 签发 → 导入校验（临时 userData）。
 *
 * 为什么不再改写仓库里的 `src/license/public-key.js`（L4）：`src/license/service.js` 在
 * **模块加载时**就把内嵌公钥读成常量，所以「用测试密钥验签」必须在 service 被加载之前把
 * 公钥换掉。旧做法是把测试公钥**写进仓库文件**、跑完在 `finally` 里还原 —— 一旦中断
 * （Ctrl+C / 断言失败 / 断电），仓库里留下的就是一张测试公钥，症状是「所有正式许可证都
 * 验签失败」，排查时毫无线索。现在改成**只注入到 require 缓存**：同样在 service 加载前生效，
 * 但一个字节都不写仓库，中断也不会留下任何痕迹。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { generateKeyPair, signPayload, verifyPayload } = require('../src/license/crypto')
const { getDeviceFingerprint } = require('../src/license/fingerprint')
const { validatePayload, evaluatePayload, PRODUCT_ID } = require('../src/license/schema')

/** 仓库里那份**正式**内嵌公钥（注入前先读出来，用于下面的反向断言）。 */
const PUBLIC_KEY_PATH = require.resolve('../src/license/public-key')
const REAL_PUBLIC_KEY_PEM = require(PUBLIC_KEY_PATH).PUBLIC_KEY_PEM

function assert(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg)
    process.exit(1)
  }
  console.log('ok:', msg)
}

function clearLicenseCache() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes(`${path.sep}license${path.sep}`)) delete require.cache[k]
  }
}

/**
 * 在「注入的测试公钥」下执行 `fn`。
 *
 * 为什么注入 require 缓存而不是写文件：`service.js` 的 `require('./public-key')` 在 Node 里
 * 就是按**解析后的绝对路径**查缓存，所以只要在它被加载前把这一项塞进 `require.cache`，
 * 它拿到的就是测试公钥 —— 效果与改写文件完全相同，但不碰磁盘。
 * @param {string} publicKeyPem 测试用公钥（PEM）。
 * @param {() => T} fn 在这个公钥生效期间执行的代码。
 * @returns {T}
 * @template T
 */
function withTestPublicKey(publicKeyPem, fn) {
  clearLicenseCache()
  require.cache[PUBLIC_KEY_PATH] = {
    id: PUBLIC_KEY_PATH,
    filename: PUBLIC_KEY_PATH,
    loaded: true,
    exports: { PUBLIC_KEY_PEM: publicKeyPem },
  }
  try {
    return fn()
  } finally {
    delete require.cache[PUBLIC_KEY_PATH]
    // 清掉在测试公钥下加载过的 service 等模块，避免残留被后续用例复用。
    clearLicenseCache()
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-license-'))
  const keys = generateKeyPair()
  const fp = getDeviceFingerprint()
  const keyFileBefore = sha256(PUBLIC_KEY_PATH)

  const payload = {
    product: PRODUCT_ID,
    licenseId: 'test-001',
    edition: 'pro',
    issuedTo: { name: 'Test User', company: 'Demo Co' },
    device: { fingerprint: fp.fingerprint },
    issuedAt: new Date().toISOString(),
    notBefore: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 365 * 864e5).toISOString(),
    features: ['wechat-data', 'ai-ask'],
    seats: 1,
    appVersionMin: '1.0.0',
  }

  const sig = signPayload(payload, keys.privateKeyPem)
  assert(verifyPayload(payload, sig, keys.publicKeyPem).ok, '签名验证通过')
  assert(!verifyPayload(payload, 'AAAA', keys.publicKeyPem).ok, '错误签名被拒绝')
  assert(!verifyPayload({ ...payload, seats: 99 }, sig, keys.publicKeyPem).ok, '篡改载荷被拒绝')
  assert(validatePayload(payload).ok, '结构校验通过')
  assert(evaluatePayload(payload, { fingerprint: fp.fingerprint, appVersion: '1.0.0' }).valid, '设备+有效期通过')
  assert(!evaluatePayload(payload, { fingerprint: 'deadbeef', appVersion: '1.0.0' }).valid, '设备不匹配拒绝')
  // 反向对照：仓库里那把正式公钥**验不了**测试私钥签的东西 —— 否则下面「走注入」的断言等于没测。
  assert(!verifyPayload(payload, sig, REAL_PUBLIC_KEY_PEM).ok, '正式公钥验不了测试签名（注入前）')

  withTestPublicKey(keys.publicKeyPem, () => {
    const service = require('../src/license/service')
    const r = service.importLicense(tmp, '1.0.0', { payload, signature: sig })
    assert(r.ok, `importLicense 成功${r.error ? ` (${r.error})` : ''}`)
    assert(r.status?.licensed === true, '状态为已授权')
    assert(r.status?.payload?.features?.includes('ai-ask'), '功能列表正确')
    const st = service.getLicenseStatus(tmp, '1.0.0')
    assert(st.licensed && st.code === 'OK', '二次读取状态 OK')
  })

  // L4 的核心不变量：本脚本不写仓库。跑完文件必须**逐字节**一致（中断场景由「从不写盘」保证）。
  assert(sha256(PUBLIC_KEY_PATH) === keyFileBefore, '仓库里的 public-key.js 未被本脚本改写')
  const realKeyAfter = require(PUBLIC_KEY_PATH).PUBLIC_KEY_PEM
  assert(realKeyAfter === REAL_PUBLIC_KEY_PEM, '注入未残留：进程内读回仍是仓库里的正式公钥')

  console.log('\n全部通过。临时目录:', tmp)
}

// 只在直接执行时跑冒烟：单测要 require 本模块拿 withTestPublicKey，不能被 process.exit 带走。
if (require.main === module) {
  main()
}

module.exports = { withTestPublicKey, clearLicenseCache, PUBLIC_KEY_PATH }
