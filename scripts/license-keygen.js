#!/usr/bin/env node
/**
 * 厂商工具：生成 Ed25519 密钥对。
 *
 * 私钥写到 `scripts/license-key-path.js` 解析出的位置（默认 `~/.supertime/license-private.pem`，
 * 可用 `SUPERTIME_LICENSE_PRIVATE_KEY` 指到别的目录 —— **落在仓库里会被直接拒**，P3-10）；
 * 公钥打印并同步写入 `src/license/public-key.js`（客户端内嵌那份），同时在 `vendor-keys/`
 * 留一份公钥 pem 供核对。
 *
 * 用法：node scripts/license-keygen.js
 */
const fs = require('node:fs')
const path = require('node:path')
const { generateKeyPair } = require('../src/license/crypto')
const { resolvePrivateKeyPath, describeKeyFailure, KEY_FILE } = require('./license-key-path')

const root = path.join(__dirname, '..')
const privPath = resolvePrivateKeyPath()
if (!privPath.ok) {
  console.error(describeKeyFailure(privPath))
  process.exit(1)
}
const vendorDir = path.join(root, 'vendor-keys')
const pubPath = path.join(vendorDir, 'license-public.pem')

if (fs.existsSync(privPath.path)) {
  console.error(`私钥已存在：${privPath.path}\n覆盖会作废所有已签发的许可证，确认后再手工删除该文件。`)
  process.exit(1)
}

fs.mkdirSync(path.dirname(privPath.path), { recursive: true })
fs.mkdirSync(vendorDir, { recursive: true })
const keys = generateKeyPair()
fs.writeFileSync(privPath.path, keys.privateKeyPem, { mode: 0o600 })
fs.writeFileSync(pubPath, keys.publicKeyPem)

// 同步写入客户端公钥
const clientPub = path.join(root, 'src', 'license', 'public-key.js')
const js = `/**
 * 客户端内嵌公钥（Ed25519 SPK PEM）。
 * 由 scripts/license-keygen.js 生成；私钥在仓库之外（默认 ~/.supertime/${KEY_FILE}），勿提交。
 */
const PUBLIC_KEY_PEM = ${JSON.stringify(keys.publicKeyPem)}

module.exports = { PUBLIC_KEY_PEM }
`
fs.writeFileSync(clientPub, js, 'utf8')

console.log('已生成密钥对')
console.log('私钥:', privPath.path, `（来源：${privPath.source}）`)
console.log('公钥:', pubPath)
console.log('已更新:', clientPub)
console.log('')
console.log('私钥请自行备份。它不该出现在工作树里 —— src/backend/tests/license-key-location.spec.ts 盯着这件事。')
