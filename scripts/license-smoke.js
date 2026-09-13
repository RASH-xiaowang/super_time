#!/usr/bin/env node
/**
 * License 冒烟测试：生成密钥 → 签发 → 导入校验（临时 userData）。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { generateKeyPair, signPayload, verifyPayload } = require('../src/license/crypto')
const { getDeviceFingerprint } = require('../src/license/fingerprint')
const { validatePayload, evaluatePayload, PRODUCT_ID } = require('../src/license/schema')

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-license-'))
const keys = generateKeyPair()
const fp = getDeviceFingerprint()

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

const pubPath = path.join(__dirname, '..', 'src', 'license', 'public-key.js')
const backup = fs.readFileSync(pubPath, 'utf8')
fs.writeFileSync(pubPath, `const PUBLIC_KEY_PEM = ${JSON.stringify(keys.publicKeyPem)}\nmodule.exports = { PUBLIC_KEY_PEM }\n`)
try {
  clearLicenseCache()
  const service = require('../src/license/service')
  const r = service.importLicense(tmp, '1.0.0', { payload, signature: sig })
  assert(r.ok, `importLicense 成功${r.error ? ` (${r.error})` : ''}`)
  assert(r.status?.licensed === true, '状态为已授权')
  assert(r.status?.payload?.features?.includes('ai-ask'), '功能列表正确')
  const st = service.getLicenseStatus(tmp, '1.0.0')
  assert(st.licensed && st.code === 'OK', '二次读取状态 OK')
} finally {
  fs.writeFileSync(pubPath, backup)
  clearLicenseCache()
}

console.log('\n全部通过。临时目录:', tmp)
