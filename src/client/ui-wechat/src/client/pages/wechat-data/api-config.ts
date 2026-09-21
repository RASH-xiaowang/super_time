/**
 * `api.ts` 的「配置与接入：头像、打开路径、微信配置与路径、检索配置与反馈、解密密钥、whisper、CDN 开关」部分（M21 拆分）。
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
  DbStatusSnapshot,
  DecryptAllResult,
  DecryptImagesResult,
  DecryptStatus,
  DeleteFavoriteResult,
  DraftClearResult,
  DraftsClearResult,
  EditMutationResult,
  EditedListSnapshot,
  EmoticonsSnapshot,
  ExportResult,
  FavoritesSnapshot,
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
  RecordsSnapshot,
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
  WechatConfigFull,
  WechatConfigPatch,
  WhisperDownloadResult,
  WhisperStatus,
} from '@deepseek-ai/dsh-wechat-data/types'
import {
  cachedFetch,
  cachedGet,
  invalidateSnapshotCache,
  invalidateWechatCache,
  readRenderCache,
  snapshotDelete,
  subscribeSnapshot,
  writeRenderCache,
} from './cache.ts'
import { remote, unwrap } from './api-core.ts'

/**
 * Fetch the avatar for a username.
 * @param options - Query options: username.
 * @returns AvatarResult.
 */
export async function apiGetAvatar(options: { username: string; nickname?: string }): Promise<AvatarResult> {
  return unwrap(await remote().getAvatar(options))
}
/**
 * 批量读取本地头像(head_image.db,单次请求,纯本地)。
 * @param options - usernames 列表。
 * @returns username → data URL。
 */
export async function apiGetAvatarsLocal(options: { usernames: string[] }): Promise<Record<string, string>> {
  return unwrap(await remote().getAvatarsLocal(options))
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
export async function apiOpenPath(path: string): Promise<{ ok: boolean; path: string }> {
  return unwrap(await remote().openPath({ path }))
}
export async function apiOpenConfig(): Promise<{ ok: boolean; path: string }> {
  return unwrap(await remote().openConfig())
}
/** 路径配置中心 wechat/config.json 的绝对路径（用于“点击打开”）。 */
export async function apiGetWechatPathConfig(): Promise<string> {
  try {
    const api = (window as any)?.electronAPI?.wechat
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
  apiGetLlmProfiles,
  apiActivateLlmProfile,
  apiSaveLlmProfile,
  apiDeleteLlmProfile,
} from './llm-config.ts'
export type { WechatLlmConfig, WechatLlmProfile, LlmProfilesSnapshot, LlmModelsResult } from './llm-config.ts'
// ─────────────────────────────────────────────────────────────
// RAG 检索层：状态 / 调参 / 向量索引 / 评估 / 反馈闭环
// ─────────────────────────────────────────────────────────────

/** 检索配置（与后端 RetrievalConfig 对齐；只声明前端面板用到的字段）。 */
export interface RetrievalConfigShape {
  enabled: boolean
  embedding: { enabled: boolean; model: string; batchSize: number; maxDocsPerBuild: number; maxCharsPerDoc: number }
  channels: {
    sparse: { enabled: boolean; topK: number }
    dense: { enabled: boolean; topK: number; minSimilarity: number; candidatePool: number }
    structured: { enabled: boolean; topK: number }
  }
  fusion: { k: number; keep: number }
  rerank: { weights: Record<string, number>; minScore: number }
  compress: { maxChars: number; maxChunks: number; linesPerChunk: number; dedupThreshold: number }
  intent: { llmAssist: boolean }
  feedback: { enabled: boolean; learningRate: number; maxRecords: number }
}

/** 检索层综合状态。 */
export interface RetrievalStatus {
  enabled: boolean
  config: RetrievalConfigShape
  vector: { rows: number; dim: number; model: string }
  feedback: { total: number; up: number; down: number }
  weights: Record<string, number>
  intentAccuracy: { correct: number; total: number; accuracy: number }
}

/** 向量索引构建结果。 */
export interface VectorBuildResult {
  ok: boolean
  status: string
  rows: number
  embedded: number
  elapsed_ms: number
  message?: string
}

/** 一条历史反馈。 */
export interface RetrievalFeedbackItem {
  id: string
  question: string
  answer: string
  rating: 'up' | 'down'
  citedUseful: number[]
  citedUseless: number[]
  intent: string
  features: string[]
  createdAt: number
}

/** 评估报告（合成评测集 + 混合/稀疏消融）。 */
export interface RetrievalEvalResult {
  report: string
  hybrid: { precision: number; recall: number; mrr: number; ndcg: number; map: number; cases: number; hits: number }
  sparseOnly: { precision: number; recall: number; mrr: number; ndcg: number; map: number; cases: number; hits: number }
  intentAccuracy: { correct: number; total: number; accuracy: number }
}

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
export async function apiSaveRetrievalConfig(patch: unknown): Promise<void> {
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
}): Promise<{ ok: boolean; adaptedWeights?: Record<string, number>; features?: string[]; message?: string }> {
  return unwrap(await remote().submitAskFeedback(options))
}

/** 历史反馈列表。 */
export async function apiListRetrievalFeedback(limit = 50): Promise<{ items: RetrievalFeedbackItem[]; stats: { total: number; up: number; down: number } }> {
  return unwrap(await remote().listRetrievalFeedback({ limit }))
}

/** 丢弃反馈带来的权重偏移，回默认值。 */
export async function apiResetRetrievalWeights(): Promise<{ ok: boolean; weights: Record<string, number> }> {
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
 * Batch-decode every md5-prefixed .dat image into the decoded-images cache.
 * @param options - optional worker concurrency.
 * @returns DecryptImagesResult: total/ok/failed/skipped counts.
 */
export async function apiDecryptAllImages(options?: { concurrency?: number }): Promise<DecryptImagesResult> {
  return unwrap(await remote().decryptAllImages(options))
}
/**
 * Read the live decryption progress snapshot.
 * @returns DecryptStatus: op/done/total/failed/skipped + current item.
 */
export async function apiGetDecryptStatus(): Promise<DecryptStatus> {
  return unwrap(await remote().getDecryptStatus())
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
export async function apiDownloadWhisperModel(options: { model: string }): Promise<WhisperDownloadResult> {
  return unwrap(await remote().downloadWhisperModel(options))
}
/**
 * Download + install the whisper.cpp CLI engine into the models dir.
 * @returns WhisperDownloadResult: ok + path, or an error.
 */
export async function apiInstallWhisperEngine(): Promise<WhisperDownloadResult> {
  return unwrap(await remote().installWhisperEngine())
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
 * Enable or disable CDN image handling.
 * @param options - Mutation options: enabled flag.
 * @returns SimpleResult.
 */
export async function apiSetCdnImageEnabled(options: { enabled: boolean }): Promise<SimpleResult> {
  return unwrap(await remote().setCdnImageEnabled(options))
}
/**
 * Enable or disable local decryption of CDN images.
 * @param options - Mutation options: localDecrypt flag.
 * @returns SimpleResult.
 */
export async function apiSetCdnImageLocalDecrypt(options: { localDecrypt: boolean }): Promise<SimpleResult> {
  return unwrap(await remote().setCdnImageLocalDecrypt(options))
}
/**
 * Delete favorite items by ids.
 * @param options - Mutation options: favorite item ids.
 * @returns DeleteFavoriteResult.
 */
export async function apiDeleteFavoriteItems(options: { ids: number[] }): Promise<DeleteFavoriteResult> {
  const r = await remote().deleteFavoriteItems(options)
  invalidateWechatCache('favorites')
  return unwrap(r)
}
