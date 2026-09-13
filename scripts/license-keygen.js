#!/usr/bin/env node
/**
 * 厂商工具：生成 Ed25519 密钥对。
 * 私钥写入 vendor-keys/（勿提交仓库）；公钥打印并可写入 src/license/public-key.js。
 *
 * 用法：node scripts/license-keygen.js
 */
const fs = require('node:fs')
const path = require('node:path')
const { generateKeyPair } = require('../src/license/crypto')

const root = path.join(__dirname, '..')
const vendorDir = path.join(root, 'vendor-keys')
const privPath = path.join(vendorDir, 'license-private.pem')
const pubPath = path.join(vendorDir, 'license-public.pem')

fs.mkdirSync(vendorDir, { recursive: true })
const keys = generateKeyPair()
fs.writeFileSync(privPath, keys.privateKeyPem, { mode: 0o600 })
fs.writeFileSync(pubPath, keys.publicKeyPem)

// 同步写入客户端公钥
const clientPub = path.join(root, 'src', 'license', 'public-key.js')
const js = `/**
 * 客户端内嵌公钥（Ed25519 SPK PEM）。
 * 由 scripts/license-keygen.js 生成；私钥仅存 vendor-keys/，勿提交。
 */
const PUBLIC_KEY_PEM = ${JSON.stringify(keys.publicKeyPem)}

module.exports = { PUBLIC_KEY_PEM }
`
fs.writeFileSync(clientPub, js, 'utf8')

console.log('已生成密钥对')
console.log('私钥:', privPath)
console.log('公钥:', pubPath)
console.log('已更新:', clientPub)
console.log('')
console.log('请妥善备份私钥，并将 vendor-keys/ 加入 .gitignore')
