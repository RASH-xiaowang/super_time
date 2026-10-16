#!/usr/bin/env node
/**
 * 厂商工具：为客户签发许可证文件 license.json
 *
 * 用法示例：
 *   node scripts/license-issue.js \
 *     --fingerprint <客户设备指纹> \
 *     --name "张三" \
 *     --company "某公司" \
 *     --edition pro \
 *     --days 365 \
 *     --features wechat-data,ai-ask,ai-summary,export \
 *     --out ./out/license.json
 *
 *   node scripts/license-issue.js --from-request ./activation-request.json --name "张三" --days 365 --out ./out/license.json
 *
 * 私钥位置：默认 ~/.supertime/license-private.pem，可用 --key <path> 或环境变量
 * SUPERTIME_LICENSE_PRIVATE_KEY 显式指路；**指向仓库内的路径会被直接拒**（P3-10，
 * 见 scripts/license-key-path.js）。
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { signPayload } = require('../src/license/crypto')
const { PRODUCT_ID, KNOWN_FEATURES } = require('../src/license/schema')
const { resolvePrivateKeyPath, describeKeyFailure, ENV_KEY } = require('./license-key-path')

function arg(name, def = null) {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return def
}

/**
 * 读签发私钥。位置由 `scripts/license-key-path.js` 定（P3-10：私钥不住在仓库里，
 * 也不许"退回工作树那一份"），这里只负责读与报错。
 * `--key` 与 `SUPERTIME_LICENSE_PRIVATE_KEY` 等价（前者优先，方便一次性指路）。
 */
function loadPrivatePem() {
  const cliKey = arg('key')
  const where = resolvePrivateKeyPath(cliKey ? { env: { ...process.env, [ENV_KEY]: cliKey } } : {})
  if (!where.ok) {
    console.error(describeKeyFailure(where))
    process.exit(1)
  }
  if (!fs.existsSync(where.path)) {
    console.error(`缺少签发私钥：${where.path}（来源：${where.source}）\n`
      + '先在签发机上生成：node scripts/license-keygen.js；已有别处的私钥就显式指路：--key <path>')
    process.exit(1)
  }
  return fs.readFileSync(where.path, 'utf8')
}

function main() {
  let fingerprint = arg('fingerprint')
  let appVersionMin = arg('min-version', '1.0.0')
  const fromReq = arg('from-request')
  let hostname = arg('hostname', '')

  if (fromReq) {
    const req = JSON.parse(fs.readFileSync(fromReq, 'utf8'))
    fingerprint = req.fingerprint
    hostname = req.hostname || hostname
    if (req.appVersionMin) appVersionMin = req.appVersionMin
  }

  if (!fingerprint) {
    console.error('必须提供 --fingerprint 或 --from-request')
    process.exit(1)
  }

  const name = arg('name', 'Customer')
  const company = arg('company', '')
  const email = arg('email', '')
  const edition = arg('edition', 'pro')
  const days = parseInt(arg('days', '365'), 10)
  const seats = parseInt(arg('seats', '1'), 10)
  const featuresArg = arg('features', KNOWN_FEATURES.join(','))
  const features = featuresArg.split(',').map((s) => s.trim()).filter(Boolean)
  const out = arg('out', path.join(process.cwd(), 'license.json'))

  const now = new Date()
  const expiresAt = days > 0
    ? new Date(now.getTime() + days * 24 * 3600 * 1000).toISOString()
    : null // 0 = 永久

  const payload = {
    product: PRODUCT_ID,
    licenseId: crypto.randomUUID(),
    edition,
    issuedTo: { name, company, email },
    device: { fingerprint, label: hostname || undefined },
    issuedAt: now.toISOString(),
    notBefore: now.toISOString(),
    expiresAt,
    features,
    seats,
    appVersionMin,
    notes: arg('notes', ''),
  }

  // 去掉 undefined 以免规范化差异
  if (!payload.device.label) delete payload.device.label

  const privateKeyPem = loadPrivatePem()
  const signature = signPayload(payload, privateKeyPem)
  const doc = { payload, signature }

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(doc, null, 2), 'utf8')
  console.log('已签发许可证:', out)
  console.log('客户:', name, company ? `(${company})` : '')
  console.log('版本:', edition, '| 席位:', seats)
  console.log('功能:', features.join(', '))
  console.log('到期:', expiresAt ?? '永久')
  console.log('指纹:', fingerprint)
}

main()
