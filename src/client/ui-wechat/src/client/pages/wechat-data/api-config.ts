/**
 * `api.ts` 的「配置与接入：头像、打开路径、微信配置与路径、检索配置与反馈、解密密钥、whisper」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module api-config
 */

import type {
  AccountsSnapshot,
  AnnualReport,
  AnnualSnapshot,
  AssetInsightsSnapshot,
  AutoDbKeyResult,
  AutoImageKeyResult,
  AskHistoryClearResult,
  AskHistoryDeleteResult,
  AskHistoryQuery,
  AskHistorySnapshot,
  AskOptimizeResult,
  AskResult,
  ReplySuggestResult,
  AvatarResult,
  BackupMutationResult,
  BackupRestoreResult,
  BackupPreviewSnapshot,
  ExportHistoryDeleteResult,
  ExportHistoryPruneOptions,
  ExportHistoryQuery,
  ExportHistorySnapshot,
  BackupSnapshot,
  CalendarSnapshot,
  ChatHistoryResolveResult,
  ConfigSnapshot,
  Contact360Snapshot,
  ContactsSnapshot,
  DailySummaryResult,
  DbHealthSnapshot,
  DbIntegrityResult,
  DbRepairResult,
  DbStatusSnapshot,
  DataRevision,
  DecryptAllResult,
  DecryptImagesResult,
  DecryptStatus,
  ImageUpgradeResult,
  DeleteFavoriteResult,
  DraftClearResult,
  DraftsClearResult,
  EditMutationResult,
  EditedListSnapshot,
  EmoticonsSnapshot,
  ExportResult,
  FavoritesSnapshot,
  FeedbackRecord as RetrievalFeedbackItem,
  FilesSnapshot,
  GenerateKeysResult,
  CallsSnapshot,
  GraphSnapshot,
  GroupInfoSnapshot,
  GroupInsightsSnapshot,
  HandoffRemindsSnapshot,
  ImageDataUrlResult,
  KeysInfoResult,
  LedgerSnapshot,
  MediaAssetsSnapshot,
  MemberSearchSnapshot,
  MessagesSnapshot,
  MomentsInsightsSnapshot,
  MomentsMonthlyRow,
  MomentsSnapshot,
  OfficialAssetsSnapshot,
  OverviewInsights,
  OverviewSnapshot,
  RegionMapSnapshot,
  OperationLogClearResult,
  OperationLogQuery,
  OperationLogSnapshot,
  PaymentStatus,
  PeriodSummaryResult,
  PrivacyAuditClearResult,
  PrivacyAuditRow,
  PrivacySnapshot,
  PrivacyStateSnapshot,
  RerankWeights,
  RecordsSnapshot,
  RetrievalConfig,
  RetrievalConfigPatch,
  RetrievalEvalResult,
  RetrievalStatus,
  RevokedSnapshot,
  SearchBuildResult,
  SearchIndexStatus,
  SearchSnapshot,
  SessionsSnapshot,
  SimpleResult,
  StorageSnapshot,
  SummaryRecordSnapshot,
  SummaryTask,
  SummaryTaskMutationResult,
  SummaryTaskRunResult,
  SummaryTaskSnapshot,
  TaskMutationResult,
  TasksSnapshot,
  UnifiedSearchSnapshot,
  VerifyImageKeyResult,
  VerifyKeyResult,
  VideoInfoResult,
  VoiceInfoResult,
  VoiceTranscriptResult,
  VoiceTranscribeOneResult,
  VoiceTranscribeResult,
  VectorBuildResult,
  WechatConfigFull,
  WechatConfigPatch,
  WhisperDownloadResult,
  WhisperStatus,
} from '@deepseek-ai/dsh-wechat-data/types'
import {
  cachedFetch,
  cachedGet,
  invalidateSnapshotCache,
  invalidateAndNotify,
  readRenderCache,
  snapshotDelete,
  subscribeSnapshot,
  writeRenderCache,
} from './cache.ts'
import { createImageLoadQueue } from './image-batch.ts'
import { remote, unwrap } from './api-core.ts'
import { apiGetRemoteImageUrl } from './api-media.ts'

export type {
  RetrievalConfig as RetrievalConfigShape,
  RetrievalConfigPatch,
  RetrievalEvalResult,
  RetrievalStatus,
  VectorBuildResult,
  RetrievalFeedbackItem,
}

/** 本机地址（能直接画）；与 `panels/remote-img.tsx` 的 `localImageSrc` 同一判据。 */
const LOCAL_DRAWABLE = /^(data:|blob:|file:)/i

/**
 * 把一个「可能是远程」的头像地址换成能画进 `<img>` 的地址（M23）。
 * @param url - 后端回的本机 data URL 或远端头像地址。
 * @returns 可画的地址；远程地址取不到（开关关掉、主机不在白名单、CDN 404）回空串。
 */
async function avatarDrawable(url: string | undefined): Promise<string> {
  const u = String(url ?? '').trim()
  if (u === '') return ''
  if (LOCAL_DRAWABLE.test(u)) return u
  return apiGetRemoteImageUrl(u)
}

/**
 * Fetch the avatar for a username.
 *
 * 后端本机没有这张头像时会回一个**远端地址**，而渲染层不许自己去取（M23）：远端地址不进
 * 操作记录、也没有缓存。这里就地换成代理拿回的 data URL，取不到就如实回「没有头像」。
 * @param options - Query options: username.
 * @returns AvatarResult（`kind: 'url'` 在这一层就被收敛成 `'data'` 或 `'none'`）。
 */
export async function apiGetAvatar(options: { username: string; nickname?: string }): Promise<AvatarResult> {
  const r = unwrap(await remote().getAvatar(options))
  if (r.kind !== 'url') return r
  const drawable = await avatarDrawable(r.url)
  return drawable === '' ? { kind: 'none' } : { kind: 'data', data: drawable }
}
/**
 * 批量读取本地头像(head_image.db,单次请求,纯本地)。
 * @param options - usernames 列表。
 * @returns username → data URL。
 */
export async function apiGetAvatarsLocal(options: { usernames: string[] }): Promise<Record<string, string>> {
  const map = unwrap(await remote().getAvatarsLocal(options))
  // 后端会把本机没有、但微信记录里有地址的远端头像地址一起放进来 —— 那些地址不许渲染层自己去取（M23）。
  // 逐条走代理即可：`apiGetRemoteImageUrl` 内部会攒批（一屏合成一次 RPC）并按 URL 回填。
  // 取不到的**保留键、值留空串**，不删键：三个调用点都是「按用户名取值再判空」
  // （`map[u] ?? null` / `map[username] ?? ''` / `Object.entries(map)` 过滤），
  // 删键不省任何东西，却让「这批人问过了没有」在每个调用点都要重新推理一遍。
  const entries = Object.entries(map)
  const remoteKeys = entries.filter(([, v]) => v !== '' && !LOCAL_DRAWABLE.test(v)).map(([k]) => k)
  if (remoteKeys.length === 0) return map
  const settled = await Promise.all(remoteKeys.map((k) => avatarDrawable(map[k])))
  const out: Record<string, string> = {}
  remoteKeys.forEach((k, i) => { out[k] = settled[i] ?? '' })
  return { ...map, ...out }
}

/**
 * 头像攒批队列（W2-10.2）。
 *
 * 与图片（W1-2 `imageLoadQueue`）、表情（E1 `emoticonQueue`）同一个 `createImageLoadQueue`：
 * 一屏挂 N 个 `<Avatar>`、每个组件各自取图 ⇒ 攒到同一 tick 整批发出去。
 *
 * 实测（`avatar-batch-cost.measure.spec.ts`，200 个头像全部命中 `head_image.db`）：
 * 逐张 200 次 **34.18ms**（0.171ms/个）vs 批量 1 次 **6.15ms** ⇒ **5.6×**，
 * 省下 28ms 与 **199 次 IPC 往返**（这个基准直接调 query 函数，量不到往返开销，
 * 所以真实收益比 5.6× 更大）。
 *
 * **没有新 Remote**：批量入口 M23 的 `getAvatarsLocal` 早就有了，计划里「需新批量 Remote」
 * 这一句对头像已经不成立；表情那条更早（E1）就批完了。
 */
const avatarQueue = createImageLoadQueue<{ username: string; nickname?: string }, AvatarResult>({
  chunkSize: 200,
  onMissing: (k) => ({ kind: 'none' }),
  flush: async (keys) => {
    const map = await apiGetAvatarsLocal({ usernames: keys.map((k) => k.username) })
    // 批量没给的那几条（本地没有，且 contact 表里也没有 https 地址）**退回单张**：
    // 单张那条路还多一级「按昵称再找一次联系人」的回落（`resolveAvatar` 独有），
    // 批量接口没有这一级。直接丢弃会少一批头像 —— 宁可多几次往返，也不能少图。
    return Promise.all(keys.map(async (k) => {
      const hit = map[k.username]
      if (typeof hit === 'string' && hit !== '') return { kind: 'data', data: hit }
      return apiGetAvatar(k)
    }))
  },
})

/**
 * 取一个头像（W2-10.2 攒批版）。**签名与语义与 {@link apiGetAvatar} 完全一致**，
 * 调用方一行都不用改 —— 只是同一 tick 里的多次调用会合成一次批量 RPC。
 *
 * 为什么不直接换成 `apiGetAvatarsLocal`：单张那条路还多一级「按昵称找联系人」的回落
 *（`resolveAvatar` 独有），批量接口没有。所以这里是「批量优先 + 未命中退回单张」，
 * 而不是二选一。
 * @param options - username 与可选昵称。
 * @returns AvatarResult。
 */
export async function apiGetAvatarBatched(options: { username: string; nickname?: string }): Promise<AvatarResult> {
  const u = (options?.username ?? '').trim()
  if (u === '') return { kind: 'none' }
  return avatarQueue.enqueue(options.nickname === undefined ? { username: u } : { username: u, nickname: options.nickname })
}
/**
 * Fetch the full WeChat config (including keys-related settings).
 * @returns WechatConfigFull.
 */
export async function apiGetWechatConfigFull(): Promise<WechatConfigFull> {
  return unwrap(await remote().getWechatConfigFull())
}
/**
 * Save a WeChat config patch.
 * @param options - Mutation options: the config patch.
 * @returns SimpleResult.
 */

/** Open the owned WeChat config.json (e.g. for manual edit). @returns the opened path. */
/** Open an owned path (dir/file) with the system default. @returns the opened path. */
export async function apiOpenPath(path: string): Promise<{ ok: boolean; path: string; error?: string }> {
  return unwrap(await remote().openPath({ path }))
}
export async function apiOpenConfig(): Promise<{ ok: boolean; path: string; error?: string }> {
  return unwrap(await remote().openConfig())
}
/** 路径配置中心 wechat/config.json 的绝对路径（用于“点击打开”）。 */
export async function apiGetWechatPathConfig(): Promise<string> {
  try {
    const api = window.electronAPI?.wechat
    if (!api?.info) return ''
    const res = await api.info()
    return res?.ok ? (res.value?.pathConfig ?? '') : ''
  } catch {
    return ''
  }
}

/**
 * AI 大模型配置（当前配置 + 已保存的配置集）：实现住在 `./llm-config.ts`。
 *
 * 搬出去的两个原因：① 它们走的是主进程 IPC 而不是 `ctx.remote.wechatData.*`，
 * 与缓存层一样属于「另一个领域」；② 本文件有 < 2010 行的预算守卫（`api-module-split.spec.ts`）。
 * 这里继续转发，使既有调用方（AiModelConfig / Ask / DailySummary / PeriodSummary）
 * 的 `from '../api.ts'` 一行都不用改 —— 与 cache.ts 的拆分口径一致。
 */
export {
  apiGetLlmConfig,
  apiSaveLlmConfig,
  apiFetchLlmModels,
  apiTestLlmConnection,
  apiGetLlmBalance,
  formatBalance,
  apiGetLlmProfiles,
  apiActivateLlmProfile,
  apiSaveLlmProfile,
  apiDeleteLlmProfile,
} from './llm-config.ts'
export type { WechatLlmConfig, WechatLlmProfile, LlmProfilesSnapshot, LlmModelsResult, LlmConnectionProbe, LlmBalance } from './llm-config.ts'
// ─────────────────────────────────────────────────────────────
// RAG 检索层：状态 / 调参 / 向量索引 / 评估 / 反馈闭环
// ─────────────────────────────────────────────────────────────

// 检索层 wire 类型不再在客户端重复定义：见文件顶部从
// `@deepseek-ai/dsh-wechat-data/types` 的转发。这里保留旧名字作为兼容别名。

/**
 * 检索层的诊断/运维接口镜像（配置 + 向量库 + 反馈 + 权重 + 意图自评）。
 *
 * ⚠️ **界面已不再暴露任何检索参数**：`RetrievalPanel` 面板已下线，阈值 / 权重 / 容量 /
 * 通道开关一律固化为产品默认值（后端 `query/retrieval/config.ts`），稠密向量索引在
 * 首次提问时由网关自动增量构建。本组 `api*Retrieval*` 包装只为与后端 Remote 对齐
 * （诊断用 / 将来说不定有高级模式），**不要接线到界面** ——
 * `scripts/ui-ask-smoke.tsx` 里有对应的源码级回归闸门。
 */
export async function apiGetRetrievalStatus(): Promise<RetrievalStatus> {
  return unwrap(await remote().getRetrievalStatus())
}

/** 保存检索配置（只传要改的字段）。界面已不再暴露该入口，仅供诊断/测试使用。 */
export async function apiSaveRetrievalConfig(patch: RetrievalConfigPatch): Promise<void> {
  unwrap(await remote().saveRetrievalConfig({ patch }))
}

/** 立即构建/重建稠密向量索引。 */
export async function apiBuildRagVectorIndex(force = false): Promise<VectorBuildResult> {
  return unwrap(await remote().buildRagVectorIndex({ force }))
}

/** 提交问答反馈（赞/踩 + 有用/无用引用），后端据此微调检索权重。 */
export async function apiSubmitAskFeedback(options: {
  retrievalId?: string
  rating: 'up' | 'down'
  useful?: number[]
  useless?: number[]
  question?: string
  answer?: string
}): Promise<{ ok: boolean; adaptedWeights?: RerankWeights; features?: string[]; feedbackTotal?: number; message?: string }> {
  return unwrap(await remote().submitAskFeedback(options))
}

/** 历史反馈列表。 */
export async function apiListRetrievalFeedback(limit = 50): Promise<{ items: RetrievalFeedbackItem[]; stats: { total: number; up: number; down: number } }> {
  return unwrap(await remote().listRetrievalFeedback({ limit }))
}

/** 丢弃反馈带来的权重偏移，回默认值。 */
export async function apiResetRetrievalWeights(): Promise<{ ok: boolean; weights: RerankWeights }> {
  return unwrap(await remote().resetRetrievalWeights())
}

/** 跑离线召回评估（合成评测集），返回混合 vs 纯稀疏的对比。 */
export async function apiEvaluateRetrieval(k = 10): Promise<RetrievalEvalResult> {
  return unwrap(await remote().evaluateRetrieval({ k }))
}

export async function apiSaveWechatConfig(options: { patch: WechatConfigPatch }): Promise<SimpleResult> {
  return unwrap(await remote().saveWechatConfig(options))
}
/**
 * Detect locally installed WeChat accounts.
 * @returns AccountsSnapshot.
 */
export async function apiDetectWechatAccounts(): Promise<AccountsSnapshot> {
  return unwrap(await remote().detectWechatAccounts())
}
/**
 * Auto-recover the V4 database key from the running WeChat process.
 * @param options - optional probe db path and install dir.
 * @returns AutoDbKeyResult: ok + 64-hex key, or an error.
 */
export async function apiAutoGetDbKey(options: { dbPath?: string; wechatInstallDir?: string } = {}): Promise<AutoDbKeyResult> {
  return unwrap(await remote().autoGetDbKey(options))
}
/**
 * Auto-recover the image key from the running WeChat process (V2-verified).
 * @param options - account dir (wxid_* folder) and optional pid.
 * @returns AutoImageKeyResult: ok + xor/aes pair, or an error.
 */
export async function apiAutoGetImageKey(options: { accountDir?: string; pid?: number } = {}): Promise<AutoImageKeyResult> {
  return unwrap(await remote().autoGetImageKey(options))
}
/**
 * Verify a decrypted database key against a database file.
 * @param options - Mutation options: dbPath and encKeyHex.
 * @returns VerifyKeyResult.
 */
export async function apiVerifyDatabaseKey(options: { dbPath: string; encKeyHex: string }): Promise<VerifyKeyResult> {
  return unwrap(await remote().verifyDatabaseKey(options))
}
/**
 * Generate a keys file from the given encrypted key.
 * @param options - Mutation options: dbDir, keysFile, encKeyHex, optional keyFormat.
 * @returns GenerateKeysResult.
 */
export async function apiGenerateKeysFile(options: {
  dbDir: string
  keysFile: string
  encKeyHex: string
  keyFormat?: string
}): Promise<GenerateKeysResult> {
  return unwrap(await remote().generateKeysFile(options))
}
/**
 * Fetch information about loaded WeChat keys.
 * @returns KeysInfoResult.
 */
export async function apiGetWechatKeysInfo(): Promise<KeysInfoResult> {
  return unwrap(await remote().getWechatKeysInfo())
}
/**
 * Verify the saved image key pair against real V2 templates.
 * @returns VerifyImageKeyResult: verified flag + xor/template evidence.
 */
export async function apiVerifyImageKey(): Promise<VerifyImageKeyResult> {
  return unwrap(await remote().verifyImageKey())
}
/**
 * Full SQLCipher decryption of every db under db_storage.
 * @returns DecryptAllResult: total/ok/failed counts.
 */
export async function apiDecryptAllDatabases(): Promise<DecryptAllResult> {
  return unwrap(await remote().decryptAllDatabases())
}
/**
 * Per-database integrity checkup (PRAGMA integrity_check). Explicit action
 * (the health panel's re-check / repair flow), not part of the cached
 * health snapshot — the latter is read by the hook self-check on mount.
 * @returns DbIntegrityResult: checked/corrupted (repairable) / unreadable (busy etc) /
 *   uncheckable (本机缺模块或分词器，体检不适用 —— 与损坏无关).
 */
export async function apiCheckDbIntegrity(): Promise<DbIntegrityResult> {
  return unwrap(await remote().checkDbIntegrity())
}
/**
 * Repair corrupted decrypted DBs: check integrity, re-decrypt only the
 * corrupted ones from the local raw db_storage, then re-check.
 * @returns DbRepairResult: found/repaired/stillCorrupted + unrepairable reasons.
 */
export async function apiRepairCorruptDbs(): Promise<DbRepairResult> {
  return unwrap(await remote().repairCorruptDbs())
}
/**
 * Batch-decode every md5-prefixed .dat image into the decoded-images cache.
 * @param options - optional worker concurrency.
 * @returns DecryptImagesResult: total/ok/failed/skipped counts.
 */
export async function apiDecryptAllImages(options?: { concurrency?: number }): Promise<DecryptImagesResult> {
  return unwrap(await remote().decryptAllImages(options))
}
/**
 * Upgrade the decoded-image cache: re-decode every cached image from the best
 * .dat still on disk, replacing a cached entry only when the new bytes are
 * strictly larger. Offline (never touches the network).
 * @returns ImageUpgradeResult: total/upgraded/unchanged/noSource/failed + details.
 */
export async function apiUpgradeDecodedImages(): Promise<ImageUpgradeResult> {
  return unwrap(await remote().upgradeDecodedImages())
}
/**
 * Read the live decryption progress snapshot.
 * @returns DecryptStatus: op/done/total/failed/skipped + current item.
 */
export async function apiGetDecryptStatus(): Promise<DecryptStatus> {
  return unwrap(await remote().getDecryptStatus())
}
/**
 * Read the realtime-sync revision (pure in-memory snapshot on the backend).
 *
 * 聊天面板的轮询用它做闸门：`revision` 没变就什么都不查；变了但
 * `messageChanged=false` 就只跳过消息增量（会话/通讯录/朋友圈等库的变化由各自的
 * 推送处理）。把每秒一次消息 SQL 降成每秒一次内存读。
 * @returns DataRevision: revision / updatedAt / shards / messageChanged.
 */
export async function apiGetDataRevision(): Promise<DataRevision> {
  return unwrap(await remote().getDataRevision())
}
/**
 * Read Whisper transcription configuration status.
 * @returns WhisperStatus: engine detection, CUDA presence, model inventory.
 */
export async function apiGetWhisperStatus(): Promise<WhisperStatus> {
  return unwrap(await remote().getWhisperStatus())
}
/**
 * Download one official whisper.cpp ggml model into the models dir.
 * @param options - model id to download.
 * @returns WhisperDownloadResult: ok + file/bytes, or an error.
 */
export async function apiDownloadWhisperModel(options: { model: string; jobId?: string }): Promise<WhisperDownloadResult> {
  return unwrap(await remote().downloadWhisperModel(options))
}
/**
 * 停止一次正在跑的模型/引擎下载（W3-5.5）。
 *
 * 取消只在下**下一个 chunk** 生效；模型已下载的部分保留为 `.part`（下次可续传），
 * 引擎包本来就是整份重下。
 * @param options - jobId（即 `apiDownloadWhisperModel` / `apiInstallWhisperEngine` 那次的同一标识）。
 * @returns ok + 停不上的原因（下载已结束 / 标识不认识）。
 */
export async function apiCancelWhisperDownload(options: { jobId: string }): Promise<{ ok: boolean; message?: string }> {
  return unwrap(await remote().cancelWhisperDownload(options))
}
/**
 * Download + install the whisper.cpp CLI engine into the models dir.
 * @returns WhisperDownloadResult: ok + path, or an error.
 */
export async function apiInstallWhisperEngine(options?: { jobId?: string }): Promise<WhisperDownloadResult> {
  return unwrap(await remote().installWhisperEngine(options))
}
/**
 * Batch-transcribe the most recent voice messages (silk → whisper-cli).
 * @param options - optional message count.
 * @returns VoiceTranscribeResult: done/failed/skipped counts.
 */
export async function apiTranscribeVoiceBatch(options?: { limit?: number }): Promise<VoiceTranscribeResult> {
  return unwrap(await remote().transcribeVoiceBatch(options))
}
/**
 * Cached transcript for one voice message.
 * @param options - username + local_id.
 * @returns VoiceTranscriptResult.
 */
export async function apiGetVoiceTranscript(options: { username: string; localId: number }): Promise<VoiceTranscriptResult> {
  return unwrap(await remote().getVoiceTranscript(options))
}
/**
 * Transcribe one voice message on demand (chat bubble 语音转文字).
 * @param options - username + local_id.
 * @returns VoiceTranscribeOneResult: ok + text, or error.
 */
export async function apiTranscribeVoiceMessage(options: { username: string; localId: number }): Promise<VoiceTranscribeOneResult> {
  return unwrap(await remote().transcribeVoiceMessage(options))
}
/**
 * Delete favorite items by ids.
 * @param options - Mutation options: favorite item ids.
 * @returns DeleteFavoriteResult.
 */
export async function apiDeleteFavoriteItems(options: { ids: number[] }): Promise<DeleteFavoriteResult> {
  const r = await remote().deleteFavoriteItems(options)
  invalidateAndNotify('favorites')
  return unwrap(r)
}
