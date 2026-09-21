/**
 * `types.ts` 的 calls 部分（M21 拆分；纯类型，无运行期值）。
 *
 * 从 `types.ts` 原样搬出，`types.ts` 继续以 `export *` 转发 ⇒ 所有
 * `from './types.ts'` / `from '../types.ts'` 的导入路径一行都不用改。
 *
 * @module types-calls
 */
/**
 * One call (type 50) peer aggregate.
 *
 * 语音/视频刻意不分类：`room_type` 的语义在本机数据里判不了（见 query/calls.ts）。
 */
export interface CallPeer {
  username: string
  name: string
  calls: number
  connected: number
  durationSec: number
  lastTime: number
}

/** One month of call activity (`YYYY-MM`). */
export interface CallMonthRow {
  month: string
  calls: number
  connected: number
  durationSec: number
}

/** One call record (newest first in the snapshot). */
export interface CallRecord {
  username: string
  name: string
  localId: number
  createTime: number
  status: string
  connected: boolean
  outgoing: boolean
  durationSec?: number
}

/**
 * Call inventory snapshot, derived from the zstd `voipmsg` XML of type-50 rows.
 *
 * `missed` counts every non-connected outcome (取消/拒绝/未应答/忙线). `ackElsewhere`
 * counts calls answered on another device: connected but with no local duration.
 */
export interface CallsSnapshot {
  total: number
  connected: number
  missed: number
  durationSec: number
  avgSec: number
  longestSec: number
  longestPeer: string
  outgoing: number
  incoming: number
  ackElsewhere: number
  peers: CallPeer[]
  peerCount: number
  months: CallMonthRow[]
  byHour: number[]
  unanswered: Array<{ status: string; count: number }>
  recent: CallRecord[]
  from: number | null
  to: number | null
  updatedAt: number
}

/** One edited-message record. */
export interface EditedMessageRecord {
  sessionId: string
  db: string
  tableName: string
  localId: number
  lastEditedAt: number
  editCount: number
  originalMsgJson: string
}

/** Edited-message list snapshot. */
export interface EditedListSnapshot {
  items: EditedMessageRecord[]
  total: number
}

/** Edit mutation result. */
export interface EditMutationResult {
  ok: boolean
  error?: string
  localId?: number
}

/** Draft clear result (one session). */
export interface DraftClearResult {
  ok: boolean
  updated: number
  error?: string
}

/** Clear-all-drafts result with the cleared list. */
export interface DraftsClearResult {
  ok: boolean
  cleared: Array<{ username: string; draft: string }>
  count: number
  error?: string
}

/** One summary task. */
export interface SummaryTask {
  id: number
  groupUsername: string
  groupName: string
  targetUsers: string[]
  format: string
  customPrompt: string
  scheduleTime: string
  enabled: boolean
  lastRunAt?: number
  lastStatus: string
  lastError: string
  createdAt: number
  updatedAt: number
}

/** Task list snapshot. */
export interface SummaryTaskSnapshot {
  items: SummaryTask[]
  total: number
}

/** Task mutation result. */
export interface SummaryTaskMutationResult {
  ok: boolean
  id?: number
  error?: string
}

/** One summary record. */
export interface SummaryRecord {
  id: number
  taskId: number
  groupUsername: string
  groupName?: string
  summaryDate: string
  summary: string
  messageCount: number
  status: string
  error: string
  createdAt: number
}

/** Record list snapshot. */
export interface SummaryRecordSnapshot {
  items: SummaryRecord[]
  total: number
}

/** Run-task result. */
export interface SummaryTaskRunResult {
  ok: boolean
  summary?: string
  messageCount?: number
  error?: string
}

/** Avatar resolution result. */
export interface AvatarResult {
  kind: string
  data?: string
  url?: string
}

/** Full WeChat config + resolved fixed paths. */
export interface WechatConfigFull {
  db_dir: string
  wechat_process: string
  key_format: string
  db_enc_key: string
  image_aes_key: string
  image_xor_key: number
  api_enabled: boolean
  api_port: number
  api_token: string
  cdn_enabled: boolean
  cdn_local_decrypt: boolean
  whisper_device: 'cpu' | 'gpu'
  whisper_model: string
  whisper_threads: number
  whisper_models_dir: string
  /** Persisted whisper-cli engine path (file or its bin dir). */
  whisper_bin: string
  resolved?: Record<string, string>
}
