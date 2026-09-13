/**
 * 许可证载荷结构与语义校验（不含密码学）。
 *
 * 回答授权六问：产品/客户/设备/期限/额度/停止条件。
 */
const PRODUCT_ID = 'super-time-wechat'

const KNOWN_FEATURES = [
  'wechat-data',
  'ai-ask',
  'ai-summary',
  'export',
  'backup',
  'privacy-audit',
  'voice-transcribe',
]

function isIsoDate(v) {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v))
}

/**
 * @param {unknown} payload
 * @returns {{ ok: true, value: object } | { ok: false, reason: string }}
 */
function validatePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, reason: 'payload_not_object' }
  }
  const p = /** @type {Record<string, unknown>} */ (payload)

  if (p.product !== PRODUCT_ID) return { ok: false, reason: 'product_mismatch' }
  if (typeof p.licenseId !== 'string' || !p.licenseId) return { ok: false, reason: 'missing_licenseId' }
  if (typeof p.edition !== 'string' || !p.edition) return { ok: false, reason: 'missing_edition' }

  if (!p.issuedTo || typeof p.issuedTo !== 'object') return { ok: false, reason: 'missing_issuedTo' }
  const to = /** @type {Record<string, unknown>} */ (p.issuedTo)
  if (typeof to.name !== 'string' || !to.name) return { ok: false, reason: 'missing_customer' }

  if (!p.device || typeof p.device !== 'object') return { ok: false, reason: 'missing_device' }
  const dev = /** @type {Record<string, unknown>} */ (p.device)
  if (typeof dev.fingerprint !== 'string' || dev.fingerprint.length < 32) {
    return { ok: false, reason: 'missing_fingerprint' }
  }

  if (!isIsoDate(p.issuedAt)) return { ok: false, reason: 'bad_issuedAt' }
  if (p.notBefore != null && !isIsoDate(p.notBefore)) return { ok: false, reason: 'bad_notBefore' }
  if (p.expiresAt != null && !isIsoDate(p.expiresAt)) return { ok: false, reason: 'bad_expiresAt' }

  if (!Array.isArray(p.features) || p.features.length === 0) {
    return { ok: false, reason: 'missing_features' }
  }
  for (const f of p.features) {
    if (typeof f !== 'string') return { ok: false, reason: 'bad_feature' }
  }

  const seats = p.seats
  if (typeof seats !== 'number' || !Number.isInteger(seats) || seats < 1) {
    return { ok: false, reason: 'bad_seats' }
  }

  if (p.appVersionMin != null && typeof p.appVersionMin !== 'string') {
    return { ok: false, reason: 'bad_appVersionMin' }
  }

  return { ok: true, value: p }
}

/**
 * 语义有效性（签名之外）：时间窗 + 设备绑定 + 版本下限。
 * @param {Record<string, any>} payload
 * @param {{ fingerprint: string, appVersion: string, now?: Date }} ctx
 */
function evaluatePayload(payload, ctx) {
  const now = ctx.now ?? new Date()
  const notBefore = payload.notBefore ? new Date(payload.notBefore) : null
  const expiresAt = payload.expiresAt ? new Date(payload.expiresAt) : null

  if (notBefore && now < notBefore) {
    return { valid: false, reason: 'not_yet_active', code: 'NOT_BEFORE' }
  }
  if (expiresAt && now > expiresAt) {
    return { valid: false, reason: 'license_expired', code: 'EXPIRED' }
  }
  if (payload.device.fingerprint !== ctx.fingerprint) {
    return { valid: false, reason: 'device_mismatch', code: 'DEVICE_MISMATCH' }
  }
  if (payload.appVersionMin) {
    if (compareSemver(ctx.appVersion, payload.appVersionMin) < 0) {
      return { valid: false, reason: 'app_version_too_low', code: 'VERSION' }
    }
  }
  return { valid: true, reason: 'ok', code: 'OK' }
}

/** 简单 semver 比较：a < b → -1 */
function compareSemver(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0)
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

module.exports = {
  PRODUCT_ID,
  KNOWN_FEATURES,
  validatePayload,
  evaluatePayload,
  compareSemver,
}
