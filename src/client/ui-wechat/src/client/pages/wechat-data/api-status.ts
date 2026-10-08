/**
 * `api.ts` 的「年度报告类型与接口、Remote 健康状态与订阅」部分（M21 拆分）。
 *
 * 从原模块原样搬出，**行为逐字节不变**；原文件继续以 `export *` 转发
 * ⇒ 所有既有 import 一行都不用改。
 *
 * @module api-status
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
import { remote, unwrap } from './api-core.ts'

/**
 * Fetch the annual report for a year.
 * @param options - Query options: the report year.
 * @returns AnnualReport.
 */
export async function apiGetAnnualReport(options: { year: number }): Promise<AnnualReport> {
  return unwrap(await remote().getAnnualReport(options))
}

// ─────────────────────────────────────────────────────────────
// 年度回顾（看板）：15 张卡片所需的完整年度聚合
// 形状与后端 query/annual-review.ts 的 AnnualReview 对齐。
// 前端在此独立声明（不依赖 lib/types 里那份上游生成的 .d.ts，它没有这个名字）。
// ─────────────────────────────────────────────────────────────

/** 榜单条目。 */
export interface AnnualRankRow { username: string; name: string; total: number; mine: number; theirs: number }
/** 最疯的一天。 */
export interface AnnualBusiestDay {
  date: string; n: number; ratio: number; share: number
  topName: string; topCount: number; firstAt: string; firstText: string; lastAt: string; lastText: string; spanMin: number
}
/** 年度搭子。 */
export interface AnnualBuddy {
  username: string; name: string; total: number; mine: number; theirs: number
  streakDays: number; commonHour: number; replyBacks: number; fastestSec: number; slowestSec: number
}
/** 十二个月的主演。 */
export interface AnnualMonthlyStar { month: number; username: string; name: string; count: number }
/** 深夜卡。 */
export interface AnnualNight {
  share: number; mine: number; theirs: number; topName: string; topCount: number; sampleAt: string; sampleText: string
}
/** 作息切片。 */
export interface AnnualRhythm {
  heat: number[]; brightestDow: number; brightestHour: number; brightestCount: number
  quietestHour: number; quietestCount: number; nightShare: number; workWeekendRatio: number
}
/** 你说的话。 */
export interface AnnualWords {
  mineChars: number; receivedChars: number; keystrokes: number
  voiceSentCount: number; voiceSentSec: number; voiceRecvCount: number; voiceRecvSec: number
  callSec: number; callCount: number; callConnected: number; callMissed: number
  videoSent: number; voiceMsgSent: number; longestVoiceSec: number; longestVoiceFrom: string
}
/** 年度口头禅。 */
export interface AnnualCatchphrase {
  phrase: string; count: number; top: Array<{ phrase: string; count: number }>; shortTotal: number; catchTotal: number
}
/** 回复速度。 */
export interface AnnualReply {
  medianSec: number; p90Sec: number
  avgPartnerName: string; avgPartnerSec: number
  fastestName: string; fastestSec: number; slowestName: string; slowestSec: number
}
/** 谁先开口。 */
export interface AnnualOpener {
  mine: number; theirs: number; share: number
  mostInitiatedByMe: Array<{ name: string; count: number }>
  mostInitiatedByThem: Array<{ name: string; count: number }>
}
/** 表情宇宙。 */
export interface AnnualEmoji {
  threw: number; kept: number; perDay: number; days: number
  peakDow: number; peakHour: number; peakCount: number
  top: Array<{ emoji: string; count: number }>
}
/** 「还有这些人」。`username` 用于点头像/跳会话（后端 annual-review.ts 一直在发，这里漏了）。 */
export interface AnnualHighlight { label: string; name: string; username: string; value: string }

/**
 * 朋友圈年度（形状与后端 `query/annual-moments.ts` 的 `AnnualMoments` 对齐）。
 *
 * `available` 是**必需**的：朋友圈是另一个库（sns.db），读不到时不能显示成 0 ——
 * 那会被读成"今年一条没发"。界面据此显示"未读取到"。
 */
export interface AnnualMoments {
  count: number
  topPost: { at: string; likes: number; comments: number; excerpt: string } | null
  topMonth: { month: number; count: number } | null
  lateNight: number
  available: boolean
}

/**
 * 收藏与文件的**总量盘点**（形状与后端 `query/annual-assets.ts` 的 `AnnualAssets` 对齐）。
 *
 * 这两个数**不随年份变化**：收藏表没有时间列、文件也不按年切 —— 所以界面标题写"总量盘点"，
 * 不写成年度数字（写了就是编）。
 */
export interface AnnualAssets {
  favorites: number
  files: number
  bytes: number
  sentFiles: number
  available: boolean
}

/** 年度资金（形状与后端 `query/annual-extras.ts` 的 `AnnualMoney` 对齐）。 */
export interface AnnualMoney {
  count: number
  total: number
  topAmount: number
  topPeerName: string
  byPeer: Array<{ username: string; name: string; amount: number; count: number }>
}

/** 年度撤回（形状与后端 `AnnualRevoke` 对齐）。 */
export interface AnnualRevoke {
  count: number
  topPeerName: string
  /** 24 个时段桶（0..23 点）。 */
  byHour: number[]
}

/** 群聊年度（形状与后端 `AnnualGroups` 对齐）。 */
export interface AnnualGroups {
  messages: number
  /** 群聊占全年全部消息的比例（0..1）。 */
  share: number
  top: Array<{ username: string; name: string; count: number }>
}

/** 年度回顾完整结果。 */
export interface AnnualReviewShape {
  year: number
  sent: number; sentTo: number; sentDailyAvg: number; activeDaysMine: number
  longestStreak: number; newFriends: number; mediaSent: number
  longestSpanFrom: string; longestSpanTo: string
  calendar: Array<{ d: string; n: number }>; activeDaysAll: number; maxDayAll: number
  busiest: AnnualBusiestDay | null
  buddy: AnnualBuddy | null
  monthlyStar: AnnualMonthlyStar[]
  starName: string; starUsername: string; starMonths: number; hottestMonth: number; hottestMonthCount: number
  night: AnnualNight
  rhythm: AnnualRhythm
  words: AnnualWords
  catchphrase: AnnualCatchphrase
  reply: AnnualReply
  opener: AnnualOpener
  ranking: AnnualRankRow[]
  emoji: AnnualEmoji
  highlights: AnnualHighlight[]
  firstAt: string; firstText: string; lastAt: string; lastText: string
  /* ⑯ 起：第二段「更多」长页（2026-09-30）。这两块来自**另外的库**（朋友圈 sns.db / 收藏），
     `available=false` 表示库没读到 —— 界面据此显示"未读取到"，不许把 0 当真实值。 */
  moments: AnnualMoments
  assets: AnnualAssets
  money: AnnualMoney
  revoke: AnnualRevoke
  groups: AnnualGroups
}

/**
 * 取某年的完整年度回顾（首次扫描较慢：要逐条读该年消息以计算序列类指标）。
 * @param year - 自然年。
 * @returns 年度回顾看板数据。
 */
export async function apiGetAnnualReview(year: number): Promise<AnnualReviewShape> {
  return unwrap(await remote().getAnnualReview({ year }))
}

// ── Remote gateway readiness status ──
/**
 * Remote gateway readiness status: unknown before the first probe, online/offline after.
 */
export type ApiStatus = 'unknown' | 'online' | 'offline'
let _status: ApiStatus = 'unknown'
export const _listeners = new Set<() => void>()
/**
 * Return the current Remote gateway readiness status.
 * @returns ApiStatus ('unknown' | 'online' | 'offline').
 */
export function getApiStatus(): ApiStatus { return _status }
/**
 * Subscribe to Remote gateway status changes.
 * @param fn - Callback invoked when the status changes.
 * @returns An unsubscribe function that removes the listener.
 */
export function subscribeApiStatus(fn: () => void): () => void {
  _listeners.add(fn)
  return () => { _listeners.delete(fn) }
}
export function setApiStatus(s: ApiStatus): void {
  if (_status === s) return
  _status = s
  for (const fn of _listeners) { try { fn() } catch { /* ignore */ } }
}

/**
 * Probe the WeChat Remote gateway (local decrypted data ready).
 * @returns true when the gateway responds to a minimal getSessions probe, false otherwise.
 */
export async function checkApiHealth(): Promise<boolean> {
  try {
    await remote().getSessions({ limit: 1 })
    setApiStatus('online')
    return true
  } catch {
    setApiStatus('offline')
    return false
  }
}
