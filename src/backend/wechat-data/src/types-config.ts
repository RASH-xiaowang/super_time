/**
 * `types.ts` 的 config 部分（M21 拆分；纯类型，无运行期值）。
 *
 * 从 `types.ts` 原样搬出，`types.ts` 继续以 `export *` 转发 ⇒ 所有
 * `from './types.ts'` / `from '../types.ts'` 的导入路径一行都不用改。
 *
 * @module types-config
 */
/** Detected WeChat account. */
export interface WechatAccount {
  wxid: string
  db_dir: string
  last_active?: number
  /** 解密库文件数（db_storage 下 .db 计数，不含 -wal/-shm）。 */
  db_files?: number
}

/** Account detection snapshot. */
export interface AccountsSnapshot {
  accounts: WechatAccount[]
  total: number
  /** 微信版本（安装目录下的版本文件夹，如 4.1.12.26）。 */
  version?: string
  /** 微信安装目录（注册表 InstallPath，供密钥扫描定位 Weixin.dll）。 */
  install_dir?: string
}

/** Database key verification result. */
export interface VerifyKeyResult {
  valid: boolean
  aesOk?: boolean
  hmacOk?: boolean
  error?: string
}

/** Keys-file generation result. */
export interface GenerateKeysResult {
  ok: boolean
  verified: number
  total: number
  error?: string
}

/** Keys-file info. */
export interface KeysInfoResult {
  keyFormat?: string
  keyCount: number
  loaded: boolean
}

/** Auto-recovered V4 database key result (key_v4 memory scan). */
export interface AutoDbKeyResult {
  ok: boolean
  key?: string
  source?: string
  error?: string
}

/** Auto-recovered image key result (V2-verified memory scan). */
export interface AutoImageKeyResult {
  ok: boolean
  xorKey?: number
  aesKey?: string
  verified?: boolean
  wxid?: string
  code?: number
  templatePath?: string
  error?: string
}

/** One per-database decryption failure. */
export interface DecryptFailure {
  /** Database rel path inside db_storage. */
  db: string
  error: string
}

/** Full decryption result (立即解密). */
export interface DecryptAllResult {
  ok: boolean
  /** Databases found in db_storage. */
  total: number
  okCount: number
  failed: DecryptFailure[]
  error?: string
}

/** Saved image-key verification result. */
export interface VerifyImageKeyResult {
  verified: boolean
  aesKey?: string
  xorKey?: number
  templatePath?: string
  error?: string
}

/** Batch image decryption result (立即解密图片). */
export interface DecryptImagesResult {
  ok: boolean
  /** md5-prefixed .dat files found under msg/attach. */
  total: number
  okCount: number
  failed: number
  /** Already-cached / non-renderable (hevc) files. */
  skipped: number
  errors: Array<{ file: string; error: string }>
  /** 被跳过的文件与原因（详情弹窗用）。 */
  skippedDetails?: Array<{ file: string; reason: string }>
  error?: string
}

/**
 * 「升级解码缓存」结果（把老缓存里由低档 `.dat` 解出的图重解成本机最好的一份）。
 *
 * 类型真源在 `query/image-upgrade.ts`（实现与它同处一地），这里再导出一次是为了让
 * Remote 客户端能从 `<pkg>/types` 取到它 —— 与 `types.ts` 里
 * `export type { ContactsPageOptions } from './query/contacts.ts'` 同款做法。
 * 反过来（query 去 import 本文件）会踩 M24 的分层守卫：`query → glue` 只放行
 * `dirs.ts / asar-path.ts / types.ts` 三个叶子。
 */
export type { ImageUpgradeResult } from './query/image-upgrade.ts'

/**
 * 「批量取原图」的盘点与结果类型（真源在 `query/image-original-batch.ts`）。
 * 同上一行的理由：query 不能 import 本文件（M24 分层守卫），所以由这里再导出给 Remote 客户端。
 */
export type { ImageOriginalCandidate, OriginalBatchResult, OriginalFetchPlan } from './query/image-original-batch.ts'

/**
 * 「原图自动收割」的结果与状态类型（真源在 `query/original-harvester.ts`）。
 * 同上一行的理由：query 不能 import 本文件（M24 分层守卫），所以由这里再导出给 Remote 客户端。
 */
export type { HarvestResult, HarvestStatus } from './query/original-harvester.ts'

/**
 * 「实时同步修订」的对外类型（真源在 `query/sync-status.ts`）。
 * 同上：query 不能 import 本文件（M24 分层守卫），所以由这里再导出给 Remote 客户端。
 */
export type { DataRevision } from './query/sync-status.ts'

/**
 * 「第三方原图服务」的额度类型（真源在 `query/wxcdn-original.ts`）。
 * 同上一行的理由：query 不能 import 本文件（M24 分层守卫），所以由这里再导出给 Remote 客户端。
 */
export type { WxcdnQuota, WxcdnDownloadResult } from './query/wxcdn-original.ts'

/**
 * 「微信原图自动下载」的状态与动作类型（真源在 `query/wechat-image-autodownload.ts`）。
 * 同上一条：query 不 import 本文件（M24 分层守卫），由这里再导出给 Remote 客户端。
 */
export type {
  WechatImageAutoDownloadAction,
  WechatImageAutoDownloadState,
  WechatImageAutoDownloadStatus,
} from './query/wechat-image-autodownload.ts'

/** Live decryption progress snapshot (getDecryptStatus). */
export interface DecryptStatus {
  /**
   * Which decryption op is (or was last) running.
   *
   * `image-upgrade` 是「升级解码缓存」（把老缓存里由低档 `.dat` 解出的图重解成本机最好的一份）：
   * 它与 `images` 共用同一条忙闲闸门（同一时刻只许一个解密类任务在跑），但**不是**同一件事 ——
   * 状态里如实写清是哪一个，排障时才分得清「用户点的是批量解密还是升级」。
   */
  op: 'databases' | 'images' | 'image-upgrade' | 'image-original-batch' | null
  active: boolean
  done: number
  total: number
  failed: number
  skipped: number
  /** Current file/database short label. */
  message: string
  /**
   * **失败明细**（W3-2.5）：哪个库 / 哪张图、因为什么没解出来。
   *
   * 为什么必须有它：`failed` 只是个计数。用户在「数据健康中心」看到「失败 3」，
   * 完全无法知道是哪三个、该修什么 —— 而这三条恰恰是**可操作**的
   * （库被占用？密钥不对？文件缺失？）。计数只能告警，明细才能动手。
   *
   * 只保留**最近一次**解密的明细（新一轮开始时清空）：历史明细属于操作日志的事，
   * 塞进实时快照会让它无限增长。上限 20 条，防异常情况下把快照撑爆。
   */
  failures: Array<{ db: string; error: string }>
}

/** One Whisper model catalog entry (installed flag from the models dir). */
export interface WhisperModelInfo {
  id: 'tiny' | 'base' | 'small' | 'medium' | 'large-v3' | 'turbo'
  name: string
  sizeLabel: string
  installed: boolean
}

/** Live Whisper model download progress. */
export interface WhisperDownloadProgress {
  model: string
  file: string
  received: number
  total: number
}

/** Live voice batch transcription progress. */
export interface WhisperTranscribing {
  active: boolean
  done: number
  total: number
  failed: number
  skipped: number
  current: string
}

/** Voice batch transcription result. */
export interface VoiceTranscribeResult {
  ok: boolean
  total: number
  done: number
  failed: number
  skipped: number
  errors: Array<{ svrId: string; username: string; error: string }>
  engine: string
  model?: string
  error?: string
}

/** Per-message transcript result. */
export interface VoiceTranscriptResult {
  text?: string
  error?: string
}

/** One-shot voice-message transcription result (chat bubble 语音转文字). */
export interface VoiceTranscribeOneResult {
  ok: boolean
  text?: string
  error?: string
}

/** Whisper model download result. */
export interface WhisperDownloadResult {
  ok: boolean
  file?: string
  bytes?: number
  error?: string
}

/** Whisper transcription configuration status (getWhisperStatus). */
export interface WhisperStatus {
  /** Detected whisper engine ('whisper-cli' | 'whisper' | '' when none). */
  engine: string
  enginePath?: string
  hasCuda: boolean
  /** Effective models dir (configured or the default under the data root). */
  modelsDir: string
  models: WhisperModelInfo[]
  /** Active model download progress (null when idle). */
  downloading: WhisperDownloadProgress | null
  /** Active voice transcription progress. */
  transcribing: WhisperTranscribing
}

/** Generic ok/error result. */
export interface SimpleResult {
  ok: boolean
  error?: string
}

/** Fields the config form can save. */
export interface WechatConfigPatch {
  db_dir?: string
  db_enc_key?: string
  image_aes_key?: string
  image_xor_key?: number
  api_enabled?: boolean
  api_token?: string
  api_port?: number
  whisper_device?: 'cpu' | 'gpu'
  whisper_model?: string
  whisper_threads?: number
  whisper_models_dir?: string
  whisper_bin?: string
  /**
   * 「密钥已搬到 secrets.json」这条提示的确认位（W2-12.3）。
   *
   * 它**不是**密钥字段，所以不走 `SECRET_FIELDS` 那条搬运动作 ——
   * 留在 config.json 里当普通配置项即可。
   */
  secret_migration_notice_ack?: boolean
  /**
   * 「用第三方服务取原图」开关（默认 **false**）。
   *
   * 打开后，本机没有原图时会用 `cdnbigimgurl` 的 fileid 向 `wxcdn.c3o.re` 请求原图
   * （**按流量计费**，Free 套餐 50 MB/天）。该服务不是腾讯官方，且需要把本机的
   * `all_users/config/global_config` 发给它 —— 所以必须默认关闭、由用户显式打开。
   */
  wxcdn_original_enabled?: boolean
  /**
   * 「微信原图自动下载」开关（默认 **false**，实验功能）。
   *
   * 打开后，本应用会把上游 WeFlow-X（MIT）的 `img_helper.dll` 注入正在运行的微信进程，
   * 让微信在**接收新图片时**按原图下载（本应用自己不联网、不碰凭据）。
   * 只影响设置生效之后收到的图片；历史图片仍需在微信里点开原图（或走其它通路）。
   * 该功能会修改微信进程内存，必须由用户显式打开。
   */
  wechat_image_autodownload_enabled?: boolean
  /**
   * 自动下载的会话白名单（会话 username 列表）。空数组 = **全部会话**（与上游组件语义一致）。
   * 只影响新收到的图片，用来把流量/磁盘占用限制在需要的会话里。
   */
  wechat_image_autodownload_whitelist?: string[]
}

/** Delete result. */
export interface DeleteFavoriteResult {
  ok: boolean
  deleted: number
  error?: string
}

/** Annual report (local-only yearly stats). */
export interface AnnualReport {
  year: number
  total: number
  active_days: number
  text_chars: number
  daily_avg: number
  text_share: number
  night_share: number
  morning_share: number
  weekend_share: number
  group_share: number
  heat: number[]
  monthly: number[]
  kind_counts: Record<string, number>
  top_phrases: Array<{ phrase: string; count: number }>
  top_emoji: Array<{ emoji: string; count: number }>
  top_contacts: Array<{ username: string; name: string; count: number; share: number }>
  top_groups: Array<{ username: string; name: string; count: number; share: number }>
  first_message?: string
  last_message?: string
  persona_tags: string[]
}

/** Host event vocabulary for the wechat-data surface. */
declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * New WeChat messages were synced from the raw encrypted DBs into the
     * decrypted snapshot (a WAL increment or a full re-decrypt). Panels
     * refresh on it instead of waiting for the next polling tick.
     * @mode emit
     * @param shards - message shard file names that were updated.
     */
    'wechat-data/updated'(shards: string[]): void
    /**
     * 任务触发扫描新建了记录 / 投递了回调（2026-10-19 提速）。
     *
     * 扫描由实时同步回调事件驱动（不再只靠定时器）；新建记录后立刻发这条事件，
     * 让「任务信息」面板不必等到下一次微信同步（约 10s）才看到新记录。
     * @mode emit
     * @param payload - 本拍新建记录数与投递成功数（面板只据此回源，不把它当数据源）。
     */
    'task-center/updated'(payload: { created: number; dispatched: number }): void
    /**
     * 微信问答的流式回答增量：payload 是 `{ id, text }`，`id` 为本次流式请求的标识
     * （由客户端在调用 askWechat 时生成），渲染端按 id 把增量拼起来。
     * 由 `gateway.ts` 的流式回调发出、`src/client/ui-app/ui-entry.tsx` 消费。
     * @mode emit
     * @param payload - 流式标识与本次新增的文本片段。
     */
    'wechat-ask/delta'(payload: { id: string; text: string }): void
    /**
     * 微信问答的**思考过程增量**（2026-10-16）：payload 是 `{ id, text }`，
     * `text` 是**已生成的思考全文**（与 delta 同一套「推全文」约定）。
     *
     * 为什么与 `wechat-ask/delta` 分开两条事件：模型可能先吐一大段 reasoning 再吐正文，
     * 混在一条里渲染端就没法把「思考过程」单独折叠展示（用户要的是「像问答产品一样」）。
     * @mode emit
     * @param payload - 流式标识与已生成的思考全文。
     */
    'wechat-ask/reasoning'(payload: { id: string; text: string }): void
    /**
     * 微信问答的**阶段事件**（2026-10-16）：payload 是
     * `{ id, key, label, status, detail?, phase?, callId?, ... }`。
     *
     * 流水线每一步（规划 → 检索 → 精排 → 生成 → 接地核对）在**发生的那一刻**推一条，
     * 渲染端据此显示「🔍 检索本机记录 · 召回 128 条」这样的过程行。
     * 同一个 `key` 会先推 `running` 再推终态（带结果摘要），渲染端按 key 就地更新。
     * 工具调用额外携带 `callId/toolName/argumentsSummary/attempt/maxAttempts/...`，
     * 前端按 `callId` 合成实时工具卡；`failed` 表示真实失败，不能伪装成 `done`。
     * @mode emit
     * @param payload - 流式标识、阶段标识/名称/状态与结果摘要。
     */
    'wechat-ask/stage'(payload: {
      id: string
      key: string
      label: string
      status: 'running' | 'done' | 'failed' | 'skipped'
      detail?: string
      phase?: 'called' | 'completed' | 'failed' | 'retry'
      callId?: string
      toolName?: string
      argumentsSummary?: string
      attempt?: number
      maxAttempts?: number
      elapsedMs?: number
      errorClass?: string
      deadlineExceeded?: boolean
      hits?: number
      facts?: number
    }): void
    /**
     * 导出/加密备份的进度（M3）：payload 是 `{ jobId, phase, done, total }`。
     *
     * `jobId` 由渲染层在调用 `exportAllSessions` / `exportMoments` / `createEncryptedBackup`
     * 时自己生成并回传 —— 函数与 AbortSignal 都过不了 IPC，所以进度与取消都靠这个标识
     * （取消走 `cancelExportJob({ jobId })`，兜底读进度走 `getExportProgress({ jobId })`）。
     * `total = 0` 表示总量未知（流式压缩阶段算不出来），渲染端据此显示不定量进度。
     * @mode emit
     * @param payload - 任务标识与本次进度。
     */
    'wechat-export/progress'(payload: { jobId: string; phase: string; done: number; total: number }): void
    /**
     * 微信 ClawBot 接入会话有新增消息（写入后即发）。
     *
     * 载荷是 `{ lastId, delta }` —— **只带位置与数量、不带正文**：事件是幂等提示，
     * 渲染端收到后调 `listClawbotMessages({ afterId: lastId })` 拉增量并按 id 去重合并
     * （丢事件也不丢数据，见 types-ops.ts 的 ClawbotMessage 说明）。
     * @mode emit
     * @param payload - 最新消息 id 与本批次新增条数。
     */
    'clawbot/message'(payload: { lastId: number; delta: number }): void
    /**
     * ClawBot 绑定状态迁移（申请二维码 / 绑定成功 / 解绑）。
     * @mode emit
     * @param payload - 迁移前后状态与被绑定的 wxid（未绑定时为 null）。
     */
    'clawbot/binding-changed'(payload: { from: 'unbound' | 'binding' | 'bound' | 'unbound-by-user'; to: 'unbound' | 'binding' | 'bound' | 'unbound-by-user'; wxid: string | null }): void
  }
}
