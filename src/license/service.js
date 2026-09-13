/**
 * License 服务：状态汇总、导入、校验链。
 *
 * 校验链（客户端放行顺序）：
 *   数字签名 → 授权状态 → 有效期 → 设备指纹 → 功能范围
 *
 * 混合模式：默认本地验证；心跳为可选扩展（当前仅记录 lastCheck）。
 *
 * **没有试用期**：未导入许可证时一律 `unlicensed`（拒绝一切业务调用），
 * 也不会在 userData 里写任何试用状态文件。是否需要短期授权由厂商签发
 * 带 `expiresAt` 的证书决定（见 tools/license-studio）。
 */
const { verifyPayload } = require('./crypto')
const { getDeviceFingerprint } = require('./fingerprint')
const { validatePayload, evaluatePayload, PRODUCT_ID, KNOWN_FEATURES } = require('./schema')
const { readLicenseFile, writeLicenseFile, deleteLicenseFile, licensePath } = require('./store')
const { PUBLIC_KEY_PEM } = require('./public-key')

/**
 * 完整状态。
 * @param {string} userDataDir
 * @param {string} appVersion
 */
function getLicenseStatus(userDataDir, appVersion) {
  const fp = getDeviceFingerprint()
  const doc = readLicenseFile(userDataDir)
  const base = {
    productId: PRODUCT_ID,
    appVersion,
    device: {
      fingerprint: fp.fingerprint,
      // 不把 MachineGuid 等原始特征回传前端，只给展示用摘要
      fingerprintShort: fp.fingerprint.slice(0, 12),
      platform: fp.parts.platform,
      hostname: fp.parts.hostname,
    },
    licensePath: licensePath(userDataDir),
    knownFeatures: KNOWN_FEATURES,
    mode: 'hybrid-local',
  }

  if (!doc || !doc.payload || !doc.signature) {
    return {
      ...base,
      state: 'unlicensed',
      licensed: false,
      payload: null,
      reason: 'no_license',
      code: 'LICENSE_REQUIRED',
    }
  }

  // 1) 结构
  const struct = validatePayload(doc.payload)
  if (!struct.ok) {
    return {
      ...base,
      state: 'invalid',
      licensed: false,
      payload: doc.payload,
      reason: struct.reason,
      code: 'INVALID_PAYLOAD',
    }
  }

  // 2) 签名
  const sig = verifyPayload(doc.payload, doc.signature, PUBLIC_KEY_PEM)
  if (!sig.ok) {
    return {
      ...base,
      state: 'invalid',
      licensed: false,
      payload: doc.payload,
      reason: sig.reason,
      code: 'BAD_SIGNATURE',
    }
  }

  // 3–5) 语义：时间 / 设备 / 版本
  const evalRes = evaluatePayload(doc.payload, {
    fingerprint: fp.fingerprint,
    appVersion,
  })
  if (!evalRes.valid) {
    return {
      ...base,
      state: evalRes.code === 'EXPIRED' ? 'expired' : evalRes.code === 'DEVICE_MISMATCH' ? 'device_mismatch' : 'invalid',
      licensed: false,
      payload: doc.payload,
      reason: evalRes.reason,
      code: evalRes.code,
    }
  }

  // 功能范围
  const features = Array.isArray(doc.payload.features) ? doc.payload.features : []
  return {
    ...base,
    state: 'licensed',
    licensed: true,
    reason: 'ok',
    code: 'OK',
    payload: {
      licenseId: doc.payload.licenseId,
      edition: doc.payload.edition,
      issuedTo: doc.payload.issuedTo,
      issuedAt: doc.payload.issuedAt,
      notBefore: doc.payload.notBefore ?? null,
      expiresAt: doc.payload.expiresAt ?? null,
      features,
      seats: doc.payload.seats,
      appVersionMin: doc.payload.appVersionMin ?? null,
      notes: doc.payload.notes ?? '',
    },
    importedAt: doc.importedAt ?? null,
    // 到期前提示
    daysToExpiry: doc.payload.expiresAt
      ? Math.ceil((new Date(doc.payload.expiresAt).getTime() - Date.now()) / (24 * 3600 * 1000))
      : null,
  }
}

/**
 * 导入许可证文件内容（字符串或对象）。
 * @returns {{ ok: boolean, status?: object, error?: string }}
 */
function importLicense(userDataDir, appVersion, fileContent) {
  let doc
  try {
    doc = typeof fileContent === 'string' ? JSON.parse(fileContent) : fileContent
  } catch (err) {
    return { ok: false, error: `invalid_json:${err.message}` }
  }
  if (!doc || typeof doc !== 'object' || !doc.payload || !doc.signature) {
    return { ok: false, error: 'invalid_license_format' }
  }
  const struct = validatePayload(doc.payload)
  if (!struct.ok) return { ok: false, error: struct.reason }

  const sig = verifyPayload(doc.payload, doc.signature, PUBLIC_KEY_PEM)
  if (!sig.ok) return { ok: false, error: sig.reason }

  const fp = getDeviceFingerprint()
  const evalRes = evaluatePayload(doc.payload, {
    fingerprint: fp.fingerprint,
    appVersion,
  })
  if (!evalRes.valid) return { ok: false, error: evalRes.reason }

  const toStore = {
    payload: doc.payload,
    signature: doc.signature,
    importedAt: new Date().toISOString(),
  }
  writeLicenseFile(userDataDir, toStore)
  return { ok: true, status: getLicenseStatus(userDataDir, appVersion) }
}

function removeLicense(userDataDir, appVersion) {
  deleteLicenseFile(userDataDir)
  return getLicenseStatus(userDataDir, appVersion)
}

/** 某功能是否可用（按证书的 features 列表）。 */
function hasFeature(status, feature) {
  if (!status || status.state !== 'licensed') return false
  return Array.isArray(status.payload?.features) && status.payload.features.includes(feature)
}

/**
 * Remote 方法 → 所需 License 功能位。
 * 未列出的方法默认要求 wechat-data。
 */
const METHOD_FEATURE = {
  askWechat: 'ai-ask',
  optimizeAskQuestion: 'ai-ask',
  generateDailySummary: 'ai-summary',
  generatePeriodSummary: 'ai-summary',
  exportSessionMessages: 'export',
  exportCsv: 'export',
  exportAnnualReport: 'export',
  exportAllSessions: 'export',
  exportMoments: 'export',
  createBackup: 'backup',
  createEncryptedBackup: 'backup',
  restoreBackup: 'backup',
  deleteBackup: 'backup',
  transcribeVoiceBatch: 'voice-transcribe',
  getPrivacyScan: 'privacy-audit',
  getPrivacyState: 'privacy-audit',
  setPrivacyState: 'privacy-audit',
  getPrivacyAuditRows: 'privacy-audit',
  clearPrivacyAudit: 'privacy-audit',
}

/** 可用状态：必须是有效正式证。 */
function isUsableStatus(status) {
  return !!status && status.state === 'licensed'
}

/**
 * 校验一次 Remote 调用是否放行。
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function authorizeCall(status, method) {
  if (!isUsableStatus(status)) {
    const code = status?.code || 'LICENSE_REQUIRED'
    const msg = {
      EXPIRED: '许可证已过期，请续费后导入新证',
      DEVICE_MISMATCH: '许可证与本机设备不匹配',
      BAD_SIGNATURE: '许可证签名校验失败',
      INVALID_PAYLOAD: '许可证格式无效',
      NOT_BEFORE: '许可证尚未生效',
      VERSION: '应用版本过低，请升级',
    }[code] || '需要有效许可证才能使用'
    return { ok: false, code, message: msg }
  }
  const feature = METHOD_FEATURE[method] || 'wechat-data'
  if (!hasFeature(status, feature)) {
    return {
      ok: false,
      code: 'FEATURE_DENIED',
      message: `当前授权未包含功能「${feature}」（方法 ${method}）`,
    }
  }
  return { ok: true }
}

/**
 * 导出本机指纹包，供客户发给厂商申请发证。
 */
function getActivationRequest(userDataDir, appVersion) {
  const fp = getDeviceFingerprint()
  return {
    product: PRODUCT_ID,
    appVersion,
    fingerprint: fp.fingerprint,
    platform: fp.parts.platform,
    hostname: fp.parts.hostname,
    generatedAt: new Date().toISOString(),
    hint: '将此 JSON 发送给厂商，由厂商用私钥签发 license.json 后导入本机',
  }
}

module.exports = {
  PRODUCT_ID,
  getLicenseStatus,
  importLicense,
  removeLicense,
  hasFeature,
  getActivationRequest,
  isUsableStatus,
  authorizeCall,
  METHOD_FEATURE,
}
