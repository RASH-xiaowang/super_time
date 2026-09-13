/**
 * Super Time License — Ed25519 签名工具
 *
 * 厂商持有私钥签发许可证；客户端只内嵌公钥做验签。
 * 载荷为稳定排序的 JSON 规范串，避免字段顺序导致验签失败。
 */
const crypto = require('node:crypto')

/** 生成 Ed25519 密钥对（仅厂商发证脚本使用）。 */
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  }
}

/** 规范化 JSON：对象键排序后序列化，作为签名原文。 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  const keys = Object.keys(value).sort()
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
  return `{${parts.join(',')}}`
}

function payloadBytes(payload) {
  return Buffer.from(canonicalize(payload), 'utf8')
}

/** 用私钥 PEM 对 payload 签名，返回 base64。 */
function signPayload(payload, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem)
  const sig = crypto.sign(null, payloadBytes(payload), key)
  return sig.toString('base64')
}

/**
 * 验签。
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function verifyPayload(payload, signatureB64, publicKeyPem) {
  try {
    if (typeof signatureB64 !== 'string' || !signatureB64) {
      return { ok: false, reason: 'missing_signature' }
    }
    const key = crypto.createPublicKey(publicKeyPem)
    const sig = Buffer.from(signatureB64, 'base64')
    const ok = crypto.verify(null, payloadBytes(payload), key, sig)
    return ok ? { ok: true } : { ok: false, reason: 'signature_invalid' }
  } catch (err) {
    return { ok: false, reason: `signature_error:${err.message}` }
  }
}

module.exports = {
  generateKeyPair,
  canonicalize,
  signPayload,
  verifyPayload,
}
