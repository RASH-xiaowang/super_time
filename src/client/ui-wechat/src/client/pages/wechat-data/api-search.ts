/**
 * `api.ts` 的「检索与问答：索引状态/构建、消息检索与取消、统一检索、推荐回复、提问与优化、成员与群信息」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module api-search
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
 * Fetch search index build status.
 * @returns SearchIndexStatus.
 */
export async function apiGetSearchIndexStatus(): Promise<SearchIndexStatus> {
  return unwrap(await remote().getSearchIndexStatus())
}
/**
 * Trigger a search index build (optionally forced).
 * @param options - Query options: force rebuild even when up to date.
 * @returns SearchBuildResult.
 */
export async function apiBuildSearchIndex(options?: { force?: boolean }): Promise<SearchBuildResult> {
  return unwrap(await remote().buildSearchIndex(options))
}
/**
 * Search messages by query text.
 * @param options - Query options: query text and limit.
 * @returns SearchSnapshot.
 */
export async function apiSearchMessages(options: { query: string; limit?: number; username?: string; jobId?: string }): Promise<SearchSnapshot> {
  return unwrap(await remote().searchMessages(options))
}
/**
 * 取消一次正在跑的消息搜索（N9）。
 *
 * 用途是「用户不再关心这次搜索了」：换关键词、清空输入、离开面板 —— 兜底扫描可能还要跑几百毫秒，
 * 而它占着 worker 不放。取消后那一侧的扫描会在百毫秒内收尾（返回部分结果并带 `cancelled`）。
 * @param options - `jobId` 为发起搜索时生成的那个标识。
 * @returns `ok: true` 表示确实打断了一个在跑的搜索。
 */
export async function apiCancelSearch(options: { jobId: string }): Promise<{ ok: boolean }> {
  return unwrap(await remote().cancelSearch(options))
}
/**
 * Run the unified local search across several data domains.
 * @param options - Query options: query text, optional per-domain limit.
 * @returns UnifiedSearchSnapshot.
 */
export async function apiSearchUnified(options: { query: string; limit?: number }): Promise<UnifiedSearchSnapshot> {
  return unwrap(await remote().searchUnified(options))
}
/**
 * Ask a question over the local WeChat data (multi-turn: intent plan → retrieval → synthesis).
 * @param options - Question plus optional talker/date scope and conversation history.
 * @returns AskResult: answer, source citations, and the retrieval plan.
 */
/**
 * 「推荐回复」：按当前会话的上下文（可带当前选中的知识库）生成候选回复。
 * @param options - 会话 username；kbId/count 可缺省。
 * @returns ReplySuggestResult；ok=false 时读 error（被隐私闸门拦下与模型不可用是两句不同的话）。
 */
export async function apiSuggestReplies(options: { username: string; kbId?: number; count?: number }): Promise<ReplySuggestResult> {
  return unwrap(await remote().suggestReplies(options))
}

export async function apiAskWechat(options: {
  question: string
  username?: string
  from?: string
  to?: string
  /** 多轮对话历史（此前轮次的问答，最多带最近 8 轮）。 */
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  /** 流式标识：带上它，后端会在生成过程中推送 wechat-ask/delta 增量事件
   *  （渲染端监听 dsh-wechat-ask-delta）。不传则退化为一次性返回。 */
  streamId?: string
  /** 入口来源（'ask'/'session'）与会话显示名：写进问答历史，供列表区分与直显。 */
  source?: string
  usernameName?: string
  /** 当前知识库 id（见 Remote 接口上的说明）：知识库文件块参与本轮检索。 */
  kbId?: number
}): Promise<AskResult> {
  return unwrap(await remote().askWechat(options))
}

/**
 * Optimize a question for retrieval (rewrite + suggestions) via the configured LLM.
 * @param options - Question plus optional scope/history for context.
 * @returns AskOptimizeResult: optimized question + improvement suggestions.
 */
export async function apiOptimizeAskQuestion(options: {
  question: string
  username?: string
  from?: string
  to?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
}): Promise<AskOptimizeResult> {
  return unwrap(await remote().optimizeAskQuestion(options))
}

/** Group chat info (群聊信息) for the open chatroom. */
export async function apiSearchMembers(options: { q: string; limit?: number; roomUsername?: string }): Promise<MemberSearchSnapshot> {
  return unwrap(await remote().searchMembers(options))
}

export async function apiGetGroupInfo(username: string): Promise<GroupInfoSnapshot> {
  return cachedFetch('group:' + username, async () => unwrap(await remote().getGroupInfo({ username })))
}
/**
 * Fetch offline group insights for one chatroom.
 * @param username - chatroom username.
 * @returns GroupInsightsSnapshot.
 */
export async function apiGetGroupInsights(username: string): Promise<GroupInsightsSnapshot> {
  return unwrap(await remote().getGroupInsights({ username }))
}

/** Resolve a nested merged chat-log pointer by its server_id. */
export async function apiResolveChatHistory(serverId: string): Promise<ChatHistoryResolveResult> {
  return unwrap(await remote().resolveChatHistory({ serverId }))
}

/** Authoritative transfer/redpacket status by message server_id. */
export async function apiGetPaymentStatus(serverId: string): Promise<PaymentStatus> {
  return cachedFetch('pay:' + serverId, async () => unwrap(await remote().getPaymentStatus({ serverId })))
}
/**
 * Fetch per-day message counts for a month.
 * @param options - Query options: username, year, month.
 * @returns CalendarSnapshot.
 */
export async function apiGetDailyCounts(options: { username: string; year: number; month: number }): Promise<CalendarSnapshot> {
  return cachedFetch('daily:' + options.username + ':' + String(options.year) + '-' + String(options.month), async () => unwrap(await remote().getDailyCounts(options)))
}
