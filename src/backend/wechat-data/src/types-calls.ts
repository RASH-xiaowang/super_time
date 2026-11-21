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
  /** 企业微信联系人的企业名称。 */
  enterpriseName?: string
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
  /** 企业微信联系人的企业名称。 */
  enterpriseName?: string
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
  /**
   * 推送地址（Feather `/webhook/<token>`）；空串 = 不推送。
   *
   * 地址里的 token 就是凭据，所以列表返回时由界面层用
   * `redactWebhookEndpoint` 脱敏展示，**不要**直接渲染原值。
   */
  webhookUrl: string
  /** 推送对象（微信会话名）；空串 = 用群名。 */
  webhookTarget: string
  lastRunAt?: number
  lastStatus: string
  lastError: string
  createdAt: number
  updatedAt: number
}

/**
 * `saveSummaryTask` 的入参形状 —— **全项目唯一一份**（此前在 4 处各写一遍
 * `Omit<SummaryTask, 'id' | 'createdAt' | 'updatedAt'> & { id?: number }`）。
 *
 * 剔掉 `lastRunAt` / `lastStatus` / `lastError` 不只是「少写三个自动列」：这三列是**运行状态**，
 * 只有 `updateSummaryTaskRunState` 会写，保存任务的 INSERT/UPDATE 根本不包含它们。
 * 留在入参类型里等于要求调用方交出三个会被静默丢掉的字段 —— `DailySummary.tsx` 就照着类型写了
 * `lastStatus: ''`、`lastError: ''`，读起来像「保存会清掉上次运行状态」。今天它不成立，
 * 而一旦有人「补全」那条 INSERT，界面上编辑一次任务就会抹掉它的运行记录。所以从类型上就不可传。
 */
export type SummaryTaskInput =
  Omit<SummaryTask, 'id' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'lastStatus' | 'lastError' | 'webhookUrl' | 'webhookTarget'>
  & {
    id?: number
    /**
     * 推送地址。**可选**，且 `undefined` 与 `''` 语义不同：
     *   · `undefined` = 「这次保存不谈推送」→ UPDATE 时该列保持原值；
     *   · `''` = 明确关掉推送 → 该列写空串。
     *
     * 为什么必须区分：本项目有两个任务表单（`SummaryTaskDrawer` 是当前入口，
     * `DailySummary.tsx` 是旧的内联表单且没有推送 UI）。若把 `''` 当成「未提供」，
     * 从旧表单编辑一次任务就会把用户配好的推送地址悄悄清空 —— 那种「保存后推送没了」
     * 极难归因。用 COALESCE 落成 SQL，判据只有一处。
     */
    webhookUrl?: string
    /** 推送对象；`undefined` 同 `webhookUrl`（保持原值）。 */
    webhookTarget?: string
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
  /**
   * 推送结果（2026-11-18）。
   *
   * 与 `ok` **刻意分开**：`ok` 说的是「总结有没有生成」，这里说的是「生成的内容有没有
   * 送到微信」。两者可以一个成一个败，界面因此能说出「已生成，但推送失败：<原因>」
   * 而不是笼统的「运行失败」—— 后者会让人以为总结白跑了。
   * 任务没配推送地址时不带这个字段。
   */
  webhook?: {
    ok: boolean
    /** 脱敏后的地址（`/webhook/***`）。 */
    endpoint: string
    status?: number
    error?: string
  }
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
  whisper_device: 'cpu' | 'gpu'
  whisper_model: string
  whisper_threads: number
  whisper_models_dir: string
  /** Persisted whisper-cli engine path (file or its bin dir). */
  whisper_bin: string
  /**
   * 「用第三方服务取原图」开关（默认 **false**）。
   *
   * 打开后，本机没有原图时会用 `cdnbigimgurl` 的 fileid 向 `wxcdn.c3o.re` 请求原图
   * （**按流量计费**，Free 套餐 50 MB/天）。该服务不是腾讯官方，且需要把本机的
   * `all_users/config/global_config` 发给它 —— 所以必须默认关闭、由用户显式打开。
   */
  wxcdn_original_enabled: boolean
  resolved?: Record<string, string>
  /**
   * M1 密钥迁移提示状态（W2-12.3）：`pending` 为真表示 `config.json` 里还留着密钥字段，
   * 下一次保存会把它们搬进 `secrets.json`；`fields` 是那些字段名。
   *
   * 可选字段：旧版本后端不带它，界面必须容忍「没有这个字段」而不是当成 pending。
   */
  secret_migration?: { pending: boolean; fields: string[] }
}
