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
const { getDeviceFingerprint, clearFingerprintCache } = require('./fingerprint')
const {
  validatePayload,
  evaluatePayload,
  PRODUCT_ID,
  KNOWN_FEATURES,
  FEATURE_SCHEMA_VERSION,
  REQUIRED_FEATURES,
  FEATURE_CATALOG,
  FEATURE_GROUPS,
  FEATURE_LABELS,
  GRANULAR_FEATURES,
  featureLabel,
} = require('./schema')
const {
  readLicenseFile, writeLicenseFile, deleteLicenseFile, licensePath,
  readLastSeen, writeLastSeen, clearLastSeen,
} = require('./store')
const { PUBLIC_KEY_PEM } = require('./public-key')

/**
 * last-seen 落盘节流：`getLicenseStatus` 在每次过闸调用里都会走（桌面 IPC 与 HTTP
 * 远程访问共用），不能每次都写盘。内存里每次更新，磁盘每小时最多写一次；
 * 掉电最多丢失一小时的基线，回拨检测仍有意义。
 */
const LAST_SEEN_PERSIST_INTERVAL_MS = 60 * 60 * 1000
/** userDataDir → { at: number|null, persistedAt: number|null } */
const lastSeenCache = new Map()

/** 取（并懒读一次）某个 userData 的 last-seen 缓存。 */
function lastSeenState(userDataDir) {
  const key = String(userDataDir || '')
  let state = lastSeenCache.get(key)
  if (!state) {
    const persisted = readLastSeen(key)
    state = { at: persisted, persistedAt: persisted }
    lastSeenCache.set(key, state)
  }
  return state
}

/**
 * 记录「刚刚看到过」并视情况落盘。
 * 时钟回拨时**不**把基线往回改：那正是要检测的情形。
 * @returns {number|null} 当前基线。
 */
function rememberLastSeen(userDataDir, atMs) {
  const state = lastSeenState(userDataDir)
  if (Number.isFinite(atMs) && (state.at === null || atMs > state.at)) state.at = atMs
  const due = state.at !== null
    && (state.persistedAt === null || state.at - state.persistedAt >= LAST_SEEN_PERSIST_INTERVAL_MS)
  if (due && writeLastSeen(userDataDir, state.at)) state.persistedAt = state.at
  return state.at
}

/** 许可证导入/删除后清掉基线（下次从当前时间重新开始）。 */
function resetLastSeen(userDataDir) {
  const key = String(userDataDir || '')
  lastSeenCache.delete(key)
  clearLastSeen(key)
}

/**
 * 完整状态。
 * @param {string} userDataDir
 * @param {string} appVersion
 */
function getLicenseStatus(userDataDir, appVersion) {
  const fp = getDeviceFingerprint()
  const doc = readLicenseFile(userDataDir)
  const lastSeenAt = lastSeenState(userDataDir).at
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
    featureSchemaVersion: FEATURE_SCHEMA_VERSION,
    featureGroups: FEATURE_GROUPS,
    featureCatalog: FEATURE_CATALOG,
    featureLabels: FEATURE_LABELS,
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
    lastSeenAt,
  })
  if (!evalRes.valid) {
    return {
      ...base,
      state: evalRes.code === 'EXPIRED'
        ? 'expired'
        : evalRes.code === 'DEVICE_MISMATCH'
          ? 'device_mismatch'
          : 'invalid',
      licensed: false,
      payload: doc.payload,
      reason: evalRes.reason,
      code: evalRes.code,
    }
  }

  // 功能范围
  const features = Array.isArray(doc.payload.features) ? doc.payload.features : []
  // 授权有效才推进 last-seen 基线；无效（含回拨）不更新，避免把异常时间写进去。
  rememberLastSeen(userDataDir, Date.now())
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
      featureSchemaVersion: doc.payload.featureSchemaVersion ?? null,
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

  // 导入前先丢掉指纹缓存：用户可能刚换过硬件/修过 MachineGuid，重新采集一次。
  clearFingerprintCache()
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
  // 新证从「现在」重新建立 last-seen 基线（旧证/旧文件的基线不能继承）。
  resetLastSeen(userDataDir)
  rememberLastSeen(userDataDir, Date.now())
  return { ok: true, status: getLicenseStatus(userDataDir, appVersion) }
}

function removeLicense(userDataDir, appVersion) {
  clearFingerprintCache()
  resetLastSeen(userDataDir)
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
 * 表中的方法必须逐一登记；未列出的方法默认要求 wechat-data。
 *
 * 一张证书里只有被签名的 features 列表有效。`FEATURE_METHODS` 按功能分组维护，
 * 构建 `METHOD_FEATURE` 时若同名方法出现在两个功能位会直接抛错，避免静默覆盖。
 */
const FEATURE_METHODS = {
  'wechat-data': [
    'autoGetDbKey', 'autoGetImageKey', 'detectWechatAccounts', 'getArticleCover',
    'getArticleCovers', 'getAvatar', 'getAvatarsLocal', 'getDataRevision',
    'getRemoteImages', 'getSelfProfile', 'getSelfUsername', 'getWechatConfig',
    'getWechatConfigFull', 'getWechatKeysInfo', 'getWxcdnQuota',
    'listLlmModels', 'listLlmProviders', 'openConfig', 'openPath',
    'saveWechatConfig', 'verifyDatabaseKey', 'verifyImageKey',
    'generateKeysFile', 'decryptAllDatabases', 'decryptAllImages', 'getDecryptStatus',
  ],
  overview: [
    'getDailyCounts', 'getMapGeoJson', 'getOverview', 'getOverviewInsights',
    'getRegionMap', 'getWordCloud',
  ],
  chats: [
    'clearAllSessionDrafts', 'clearSessionDraft', 'editChatMessage', 'getCalls',
    'getGroupInfo', 'getImageDataUrl', 'getImageDataUrlsBatch', 'getImageOriginal',
    'getMessageFile', 'getMessages', 'getNewMessages', 'getRevoked', 'getSessions',
    'getVideoInfo', 'getVoiceDataUrl', 'getVoiceInfo', 'listEditedMessages',
    'resetEditedMessage', 'resolveChatHistory', 'searchMessages',
  ],
  contacts: ['getContact360', 'getContacts', 'getGraph', 'searchMembers'],
  moments: [
    'getMoments', 'getMomentsAuthors', 'getMomentsInsights', 'getMomentsMonthly',
    'getSnsImageDataUrl', 'getSnsVideoCoverDataUrl', 'getSnsVideoCoversBatch',
    'getSnsVideoDataUrl',
  ],
  favorites: [
    'deleteFavoriteItems', 'getAssetInsights', 'getEmoticonDataUrl',
    'getEmoticonDataUrls', 'getEmoticons', 'getFavoriteMediaDataUrl', 'getFavorites',
  ],
  files: [
    'fetchOriginalImagesBatch', 'getFileImageDataUrl', 'getFileImageDataUrls',
    'getFiles', 'getMediaAssets', 'getOfficialAssets', 'getOriginalHarvestStatus',
    'getStorageStats', 'originalHarvest', 'planOriginalFetch',
  ],
  ledger: ['getLedger', 'getPaymentStatus', 'getRecords'],
  'group-insights': ['getGroupInsights'],
  'knowledge-base': [
    'addKbFiles', 'createKb', 'deleteKb', 'deleteKbFile', 'deleteNote', 'getKbFileChunks',
    'getKbFiles', 'getKbModelConfig', 'getKbs', 'getKnowledgeGraph', 'getNotes',
    'renameKb', 'saveNote', 'setKbFileRag',
  ],
  'annual-report': ['generateAnnualNarrative', 'getAnnual', 'getAnnualReport', 'getAnnualReview'],
  search: [
    'buildSearchIndex', 'cancelSearch', 'cancelSearchIndexBuild', 'getSearchIndexStatus',
    'searchUnified',
  ],
  tasks: [
    'addTask', 'deleteTask', 'extractTasks', 'getHandoffReminds', 'listTasks',
    'setTaskStatus', 'syncHandoffTasks',
  ],
  'task-center': [
    'createChatCollectTask', 'deleteTaskInfo', 'deleteTaskInfos', 'deleteTaskTriggers',
    'dispatchTaskCallback', 'listChatCollectTasks', 'listRpaVendors', 'listTaskInfos',
    'listTaskTriggers', 'revealTaskTriggerSecret', 'saveTaskInfo', 'scanTaskTriggers',
    'setTaskInfoStatus',
  ],
  'message-list': [
    'batchDeleteMessageListRecords', 'batchResendMessageListRecords',
    'deleteMessageListRule', 'getMessageListWebhookInfo', 'ingestMessageListWebhook',
    'insertMessageListRecord', 'listMessageListRecords', 'listMessageListRules',
    'probeMessageListWebhook', 'queryMessageListWebhookJob', 'resendMessageListRecord',
    'saveMessageListRule', 'stageMessageListAttachment',
  ],
  'operation-log': ['clearOperationLog', 'getOperationLog'],
  'ai-ask': [
    'askWechat', 'buildKbVectorIndex', 'buildRagVectorIndex', 'cancelAsk',
    'cancelKbIndexBuild', 'clearAskHistory', 'deleteAskHistory', 'evaluateRetrieval',
    'getAskHistory', 'getKbVectorIndex', 'getRetrievalStatus', 'listRetrievalFeedback',
    'optimizeAskQuestion', 'resetRetrievalWeights', 'saveRetrievalConfig', 'searchKb',
    'setKbModelConfig', 'submitAskFeedback', 'suggestReplies',
  ],
  'ai-summary': [
    'deleteSummaryRecord', 'deleteSummaryTask', 'extractKbEntities', 'generateDailySummary',
    'generatePeriodSummary', 'listSummaryRecords', 'listSummaryTasks', 'runSummaryTask',
    'saveSummaryTask', 'suggestKbLinks', 'summarizeKbFile', 'toggleSummaryTask',
  ],
  'ai-reply': [
    'deleteAiReplyReservations', 'getChatAiReplyDefaultWebhook', 'getChatAiReplyState',
    'listEnabledChatAiReplyStates', 'regenerateChatAiReplyRecord',
    'saveChatAiReplyDefaultWebhook', 'scanChatAiReplyNow', 'setChatAiReplyEnabled',
    'setChatAiReplyPersona',
  ],
  'local-analysis': [
    'adoptLayaModel', 'analyzeMessages', 'analyzeVisibleMessages', 'cancelLayaAnalysis',
    'cancelLayaDownload', 'downloadLayaModel', 'getLayaStatus', 'unloadLaya',
  ],
  'voice-transcribe': [
    'cancelWhisperDownload', 'downloadWhisperModel', 'getVoiceTranscript',
    'getWhisperStatus', 'installWhisperEngine', 'transcribeVoiceBatch',
    'transcribeVoiceMessage',
  ],
  'image-ocr': [],
  'image-ai': [],
  export: [
    'cancelExportJob', 'deleteExportHistory', 'exportAllSessions', 'exportAnnualReport',
    'exportChatFile', 'exportChatImage', 'exportChatVideo', 'exportCsv',
    'exportFavoriteFile', 'exportFavoriteImage', 'exportFavoriteVideo',
    'exportFileAttachment', 'exportFileImage', 'exportFileVideo', 'exportMoments',
    'exportSessionMessages', 'exportSnsImage', 'exportSnsVideo', 'getExportHistory',
    'getExportProgress', 'pruneExportHistory',
  ],
  backup: [
    'createBackup', 'createEncryptedBackup', 'deleteBackup', 'listBackups',
    'previewBackup', 'restoreBackup',
  ],
  'privacy-audit': [
    'clearPrivacyAudit', 'getPrivacyAuditRows', 'getPrivacyScan', 'getPrivacyState',
    'setPrivacyState',
  ],
  maintenance: [
    'checkDbIntegrity', 'getDbHealth', 'getDbStatus', 'repairCorruptDbs',
    'upgradeDecodedImages', 'wechatImageAutoDownload',
  ],
}

const METHOD_FEATURE = {}
for (const [feature, methods] of Object.entries(FEATURE_METHODS)) {
  for (const method of methods) {
    if (METHOD_FEATURE[method]) {
      throw new Error(`License 功能位重复登记：${method} → ${METHOD_FEATURE[method]} / ${feature}`)
    }
    METHOD_FEATURE[method] = feature
  }
}

/** 可用状态：必须是有效正式证。 */
function isUsableStatus(status) {
  return !!status && status.state === 'licensed'
}

/**
 * 校验某项功能是否放行。
 *
 * 新许可证（featureSchemaVersion=2）严格按 features 列表判定；旧许可证没有该字段，
 * 为了让已签发的客户继续可用，保留「旧证的基础位可调用新增数据功能」的兼容行为。
 * 旧证里原有 7 个功能位（AI/导出/备份/转写/隐私）仍必须显式存在。
 *
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function authorizeFeature(status, feature) {
  const required = String(feature || REQUIRED_FEATURES[0] || 'wechat-data')
  if (!isUsableStatus(status)) {
    const code = status?.code || 'LICENSE_REQUIRED'
    const msg = {
      EXPIRED: '许可证已过期，请续费后导入新证',
      DEVICE_MISMATCH: '许可证与本机设备不匹配',
      BAD_SIGNATURE: '许可证签名校验失败',
      INVALID_PAYLOAD: '许可证格式无效',
      NOT_BEFORE: '许可证尚未生效',
      VERSION: '应用版本过低，请升级',
      CLOCK_ROLLBACK: '检测到系统时间被调回（早于上次运行时间），请校正系统时钟后重试',
    }[code] || '需要有效许可证才能使用'
    return { ok: false, code, message: msg }
  }

  const licensedFeatures = Array.isArray(status.payload?.features) ? status.payload.features : []
  const legacy = status.payload?.featureSchemaVersion !== FEATURE_SCHEMA_VERSION
  const legacyBase = legacy && licensedFeatures.includes('wechat-data')
  if (licensedFeatures.includes(required) || (legacyBase && GRANULAR_FEATURES.has(required))) {
    return { ok: true }
  }

  return {
    ok: false,
    code: 'FEATURE_DENIED',
    message: `当前授权未包含「${featureLabel(required)}」功能，请联系厂商续开该功能`,
  }
}

/**
 * 校验一次 Remote 调用是否放行。
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
function authorizeCall(status, method) {
  const feature = METHOD_FEATURE[method] || 'wechat-data'
  return authorizeFeature(status, feature)
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
  authorizeFeature,
  METHOD_FEATURE,
  FEATURE_METHODS,
}
