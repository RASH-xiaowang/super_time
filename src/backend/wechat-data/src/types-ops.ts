/**
 * `types.ts` 的 ops 部分（M21 拆分；纯类型，无运行期值）。
 *
 * 从 `types.ts` 原样搬出，`types.ts` 继续以 `export *` 转发 ⇒ 所有
 * `from './types.ts'` / `from '../types.ts'` 的导入路径一行都不用改。
 *
 * @module types-ops
 */
import type { ClawbotReplyRunDetail } from './query/clawbot/clawbot-reply-types.ts'

export type {
  ClawbotReplyAskResult,
  ClawbotReplyRunDetail,
  ClawbotReplySendDecision,
} from './query/clawbot/clawbot-reply-types.ts'

/** One native WeChat reminder (handoff_remind_v0) row. */
export interface HandoffRemindItem {
  id: number
  title: string
  time: number | null
}

/** Native reminder snapshot. */
export interface HandoffRemindsSnapshot {
  items: HandoffRemindItem[]
  total: number
}

/** One privacy audit feature aggregate. */
export interface PrivacyAuditFeature {
  feature: string
  count: number
  chars: number
}

/** One raw privacy audit row. */
export interface PrivacyAuditRow {
  id: number
  feature: string
  ts: number
  chars: number
  sessions: number
  messages: number
}

/** Privacy audit clear result. */
export interface PrivacyAuditClearResult {
  ok: boolean
  removed: number
}

/** Privacy settings + audit snapshot. */
export interface PrivacyStateSnapshot {
  redactSensitive: boolean
  audit: {
    total: number
    byFeature: PrivacyAuditFeature[]
    last: number | null
    updatedAt: number
  }
}

/** Operation-log category families recorded by the app (metadata only). */
export type OperationCategory =
  | 'settings'   // 设置更改
  | 'keys'       // 密钥检测/校验/生成
  | 'sync'       // 解密与同步
  | 'export'     // 导出
  | 'delete'     // 删除
  | 'backup'     // 备份与恢复
  | 'edit'       // 消息编辑
  | 'task'       // 任务与摘要
  | 'error'      // 异常事件
  | 'clawbot'    // 微信 ClawBot 集成（绑定/解绑）

/** Outcome of one logged operation. */
export type OperationStatus = 'ok' | 'fail' | 'skip'

/** One operation-log entry (metadata only; never carries message bodies). */
export interface OperationLogEntry {
  id: number
  ts: number
  category: OperationCategory
  action: string
  target: string
  status: OperationStatus
  detail: string
  /**
   * 这条操作花了多少毫秒（H2，2026-09-28 性能修复）。
   *
   * 为什么要有它：PERF-AUDIT-172 报告（已删除，原文见 git 历史）里那张「哪个接口最慢」的分布表**是拿临时探针
   * 从宿主日志里数出来的** —— 每查一次性能就得重写一个 probe 脚本，而探针只能测
   * 「本机能跑的那些接口」。把耗时落进审计表之后，用户现场的那台机器就是唯一的数据源：
   * 直接按 `duration_ms DESC` 查，不必再让用户跑脚本。
   *
   * 口径：**超过 {@link SLOW_OPERATION_MS} 才记**（默认 1000ms，与宿主 `wechat-host.js`
   * 那条 `if (cost > 1000)` 同阈值）。理由有二：① 绝大多数操作是 1~5ms 的配置读写，
   * 全记会让这张审计表在几天内涨到几十万行；② 审计表是给人看的，混进几万条 0ms
   * 反而让「哪条慢」看不出来。**未记录 ≠ 没耗时** —— 它意味着「这次不到 1 秒」。
   */
  durationMs?: number
}

/**
 * Filter for reading the operation log. Categories arrive at the wire
 * boundary, so unknown values are tolerated and dropped by the host.
 */
export interface OperationLogQuery {
  from?: number
  to?: number
  categories?: string[]
  status?: OperationStatus
  /**
   * 关键词：在 `action` / `target` / `detail` 上做包含匹配。
   *
   * 为什么必须在服务端做：日志只能按「最新 N 条」取一页，客户端过滤等于
   * **只搜最新那一页**（实测 2144 条里只能搜到最新 500 条，覆盖率 23%），
   * 而按时间往回翻是审计场景最常见的动作。
   */
  q?: string
  limit?: number
  offset?: number
  /**
   * 只看「至少这么慢」的记录（毫秒，H2）。
   *
   * 审计表里绝大多数行不带 `durationMs`（那次不到 1 秒）—— 想找瓶颈时先过一层
   * `minDurationMs`，比在几万行里翻要直接得多。带这个过滤时**同时排除没有耗时字段的行**：
   * 「不知道多快」不能算「够慢」。
   */
  minDurationMs?: number
}

/** Operation-log page: matching entries (newest first) + full match count. */
export interface OperationLogSnapshot {
  items: OperationLogEntry[]
  total: number
  /**
   * **只在读失败时出现**（W3-11.4）。审计库打不开时返回空列表会让「没有操作记录」
   * 与「看不到操作记录」混为一谈 —— 后者才是需要用户知道的那件事。
   */
  readError?: string
}

/** Operation-log clear result. */
export interface OperationLogClearResult {
  ok: boolean
  removed: number
}

// ── 微信 ClawBot 集成（A 方案，2026-10-12）────────────────────────────────────
//
// 官方形态是「手机微信插件 ↔ 桌面端 Agent」的一对一绑定：Super Time 自己就是被
// 绑定的宿主，绑定关系存本机、接入会话正文存本机。没有多实例/心跳/指标 ——
// 那些概念来自被官方文档推翻的旧认知（见 `E:\提示词工程` 的需求基线 §2.4/13.6）。

/** 绑定关系状态四态（对齐官方流程；`unbound-by-user` 与从未绑定的 `unbound` 分开）。 */
export type ClawbotBindingStatus = 'unbound' | 'binding' | 'bound' | 'unbound-by-user'

/** 绑定行（一对一，故本质上只有一行；用表是为承载二维码中间态并与连接账本体系一致）。 */
export interface ClawbotBinding {
  id: number
  /** 实例编号（1 起、只增不复用）。多实例之后一 slot 一行绑定。 */
  slot: number
  status: ClawbotBindingStatus
  /** 一次性绑定凭证（仅 `binding` 态有意义；绑定成功或过期后清空）。 */
  qrToken: string | null
  /** 二维码过期时间戳（TTL 5 分钟）。 */
  qrExpiresAt: number | null
  /** 绑定后回写；未绑定为 null。 */
  wxid: string | null
  /** 微信昵称。 */
  userName: string | null
  /**
   * 用户给这个实例起的**别名**（「工作号」「客服号」；2026-10-16）。
   *
   * 与 `userName` 分开：昵称是绑定回写的（重新绑定会变），别名是用户偏好（活过重新绑定）。
   * `null` / 空串都表示「没起别名」⇒ 界面回落到昵称，再回落到「实例 N」。
   */
  label: string | null
  /** 头像（本地路径或 URL）。 */
  avatar: string | null
  boundAt: number | null
  unboundAt: number | null
  createdAt: number
  updatedAt: number
}

/**
 * iLink 接收通道的运行态（设置卡片 / 环境自检共用）。
 *
 * `running` = 常驻长轮询在跑（绑定后启动，解绑/会话过期停止）；
 * `error` 是最近一次错误的中文说明（`null` = 正常）。
 */
export interface ClawbotChannelInfo {
  running: boolean
  error: string | null
}

/** 绑定卡片快照（`getClawbotBinding` / `unbindClawbot` 共用）。 */
export interface ClawbotBindingSnapshot {
  binding: ClawbotBinding
  /** 接入会话计数（设置卡片展示用）。 */
  todayMessages: number
  totalMessages: number
  /** iLink 接收通道状态（**绑定后由后端常驻长轮询**，与窗口是否打开无关）。 */
  channel: ClawbotChannelInfo
  /** **只在读失败时出现**：库打不开 ≠ 没有绑定（读失败不许显示成「未绑定」）。 */
  readError?: string
}

/**
 * 单个实例的**行为配置**（多实例，2026-10-13）。
 *
 * 与绑定关系**分表存**（`clawbot_instance_config`）：绑定行会被重新绑定覆盖，
 * 而「自动回复开不开、回复要不要带知识库」是用户偏好，必须活过重新绑定。
 * 配置的读写只走 `query/clawbot/clawbot-instance.ts`（配置集中管理，别处不许直接写 SQL）。
 */
export interface ClawbotInstanceConfig {
  slot: number
  /** AI 自动回复总开关（收到入站消息时是否自动生成并回发）。 */
  autoReply: boolean
  /**
   * 自动回复时是否启用知识库增强。
   *
   * `clawbot-auto` 固定 kb-only：`autoReply=true` 必须同时满足本字段为 true 且 `kbId > 0`；
   * 否则保存时拒绝开启，或在实际运行配置中自动收敛为关闭。
   */
  kbEnabled: boolean
  /** 知识库作用域（必须为正整数；没有「所有库」或「无库纯聊天」模式）。 */
  kbId: number | null
  /**
   * 该实例的**系统提示词**（人设 / 语气 / 回复风格；2026-10-17）。
   *
   * 空串 = 用内置的拟人化默认提示词（`DEFAULT_CLAWBOT_SYSTEM_PROMPT`）——
   * 不是「没有提示词」：没有系统提示词时模型会写成报告腔（「综上所述」「根据数据分析」），
   * 而这是微信聊天，用户要的是「像个人在回话」。
   *
   * 与 `autoReply` 分开存：提示词是**用户偏好**，关掉自动回复不该把它清掉
   * （下次打开还是自己写的那套）。
   */
  systemPrompt: string
  /**
   * 长回复是否**分段发送**（2026-10-17）。
   *
   * 微信里一条几千字的消息读起来很累，且容易被折叠。开启后按段落切成多条依次发出
   * （每条不超过 {@link CLAWBOT_REPLY_CHUNK_CHARS} 字），像人连发几条那样。
   */
  splitReply: boolean
}

/**
 * 实例列表项（设置视图的实例卡）。
 *
 * `channel` 由装配层注入（通道注册表在 `remotes/clawbot.ts`，存储层不该知道它）——
 * 与 `ask` 注入同款：存储只回答「库里的实例长什么样」，运行态由持有者补。
 */
export interface ClawbotInstance {
  slot: number
  status: ClawbotBindingStatus
  wxid: string | null
  userName: string | null
  /**
   * 用户给这个实例起的**别名**（「工作号」「客服号」；2026-10-16）。
   *
   * 与 `userName` 分开：昵称是绑定回写的（重新绑定会变），别名是用户偏好（活过重新绑定）。
   * `null` / 空串都表示「没起别名」⇒ 界面回落到昵称，再回落到「实例 N」。
   */
  label: string | null
  avatar: string | null
  /**
   * iLink 机器人 id（`ilink_bot_id`；2026-10-17 补全实例信息）。
   *
   * **公开标识，不是凭证** —— 它标识「这个实例挂在哪个 bot 上」，多实例下用来区分
   * 「哪个号是哪个 bot」。真正的密钥是 `bot_token`，那个**永远不进渲染层**。
   * 未绑定 / 老库无此列时为 null。
   */
  botId: string | null
  boundAt: number | null
  unboundAt: number | null
  config: ClawbotInstanceConfig
  /** 该实例的接入会话条数（今日 / 累计）。 */
  todayMessages: number
  totalMessages: number
  /** 今日自动回复消耗的模型 token（供应商未返回 usage 时不累计，显示 0）。 */
  todayTokens: number
  /** 该实例累计 token 消耗。 */
  totalTokens: number
  /**
   * 最后一条消息的**接收时间**（0 = 还没有消息；2026-10-17 补全实例信息）。
   *
   * 用 `MAX(ts)` 而不是「最后一行的 id」：`ts` 是接收时间，`id` 是插入顺序 ——
   * 补扫历史时两者会不同序，而实例卡要回答的是「这个号最近什么时候有动静」。
   */
  lastMessageAt: number
  /** iLink 接收通道状态（该实例自己的长轮询）。 */
  channel: ClawbotChannelInfo
}

/** 实例列表快照（`listClawbotInstances`）。 */
export interface ClawbotInstancesSnapshot {
  instances: ClawbotInstance[]
  /** **只在读失败时出现**：库打不开 ≠ 一个实例都没有（读失败不许显示成「空列表」）。 */
  readError?: string
}

/** `createClawbotInstance` 的返回：新实例编号 + 最新列表。 */
export interface ClawbotInstanceCreated extends ClawbotInstancesSnapshot {
  /** 新建实例的编号（界面据此立刻对它发起扫码绑定，不用去猜哪条是新的）。 */
  slot: number
}

/** `deleteClawbotInstance` 的返回：连带删掉的会话条数 + 最新列表。 */
export interface ClawbotInstanceDeleted extends ClawbotInstancesSnapshot {
  /** 连带删掉的接入会话条数（0 = 本来就没有）—— 界面必须如实回报，不许静默丢数据。 */
  removedMessages: number
}

/**
 * 二维码绑定进度（`getClawbotBindState` 返回；一次调用 = 一次上游状态轮询）。
 *
 * `idle` = 当前没有进行中的扫码会话（从未申请 / 进程重启丢会话 / 已完成）；
 * `confirmed` 之后绑定已落库、通道已拉起，`binding` 里能看到结果。
 */
export interface ClawbotBindStateSnapshot {
  state: 'idle' | 'wait' | 'scaned' | 'confirmed' | 'expired'
  binding: ClawbotBindingSnapshot
}

/**
 * 发送结果（`sendClawbotMessage` 返回）。
 *
 * 只有服务端确认成功（`ret=0`）才落库并发事件 —— 失败不写「已发出」的假记录；
 * `error` 是可直接展示的中文（缺绑定 / 没会话令牌 / 网络错 / 服务端拒绝）。
 */
export interface ClawbotSendResult {
  ok: boolean
  /** 成功时 = 落库的会话行 id（事件与续传的定位）；失败为 null。 */
  id: number | null
  /** 失败原因（可读中文；直接展示）。 */
  error?: string
}

/**
 * 取媒体结果（`getClawbotMedia` 返回）。
 *
 * 图片且未超过内联上限时给 `dataUrl`（界面直接画小图）；其余类型（或图片过大）
 * 给已解密落盘的 `path`（界面用既有 `openPath` 交给系统打开）。
 */
export interface ClawbotMediaResult {
  ok: boolean
  /** image | voice | video | file。 */
  kind?: string
  /** 图片内联展示的 data URL（非图片类或超过内联上限时不给）。 */
  dataUrl?: string
  /** 已解密缓存的本机路径。 */
  path?: string
  name?: string | null
  /** 失败原因（可读中文；直接展示）。 */
  error?: string
}

/** 二维码取码结果（`createClawbotBindQr` 返回；四态抄 WeClaw 实现）。 */
export interface ClawbotBindQr {
  /** 一次性凭证。 */
  token: string
  /** 二维码内容（由界面渲染成二维码）。 */
  payload: string
  expiresAt: number
  state: 'wait' | 'scaned' | 'confirmed' | 'expired'
}

/** 附件的展示元数据（公开：渲染层只知道「有附件 / 类型 / 名字 / 体积 / 时长」；取数引用与密钥不出渲染层）。 */
export interface ClawbotMediaInfo {
  /** image | voice | video | file（与 msgType 同源）。 */
  kind: string
  /** 文件名（仅文件类有；其余为 null）。 */
  name: string | null
  /** 体积提示（字节；未知为 null）。 */
  size: number | null
  /** 时长（毫秒；**只有语音有**，协议 `voice_item.playtime`；其余为 null）。 */
  duration: number | null
}

/** 接入会话消息（无 instance_id —— 单绑定）。 */
export interface ClawbotMessage {
  /** 序号续传的唯一事实，永不复用。 */
  id: number
  /** 所属实例编号（列表按实例分；续传位也按实例取）。 */
  slot: number
  ts: number
  /** in = 微信→我们；out = 我们→微信。 */
  direction: 'in' | 'out'
  /** text | image | voice | file ... */
  msgType: string | null
  /** 正文原文（打码只在展示层做）。 */
  content: string
  createdAt: number
  /** 附件展示信息（有附件时非空；正文里仍有 `[图片]`/`[语音]` 等占位说明）。 */
  media: ClawbotMediaInfo | null
  /** 自动回复运行详情（入站目标消息与对应出站分段共用同一份摘要）。 */
  run?: ClawbotReplyRunDetail
}

/** 接入会话检索条件（关键词必须服务端过滤，见 operation-log 的同款教训）。 */
export interface ClawbotMessageQuery {
  /** 实例范围（缺省 1 = 第一个实例；多实例之后列表按实例分）。 */
  slot?: number
  /** ts >= from。 */
  from?: number
  /** ts <= to。 */
  to?: number
  direction?: 'in' | 'out'
  /** content 上包含匹配（服务端 LIKE + 转义 `%` `_` `\`）。 */
  q?: string
  /** 序号续传：只取 `id > afterId` 的行（按 id 升序返回，供实时增量合并）。 */
  afterId?: number
  /**
   * 向前取历史：只取 `id < beforeId` 的行（按 id 倒序返回）。
   * 自动回复取目标消息之前的上下文时使用，避免先取最新 N 条再过滤而漏掉较旧目标。
   */
  beforeId?: number
  limit?: number
  offset?: number
}

/** 接入会话页快照。 */
export interface ClawbotMessageSnapshot {
  items: ClawbotMessage[]
  total: number
  /** 表内当前最大 id（不受筛选影响），供前端记 `lastId` 续传。 */
  maxId: number
  /** **只在读失败时出现**；库尚未创建（文件不存在）不算读失败，返回空快照即可。 */
  readError?: string
}

/** 环境自检单项（M-C 精简版：只查 3 项）。 */
export interface ClawbotEnvCheckItem {
  key: string
  label: string
  state: 'ok' | 'warn' | 'error'
  detail: string
}

/** ClawBot 自动回复当前阶段。 */
export type ClawbotAutoReplyStage =
  | 'idle'
  | 'recovering'
  | 'generating'
  | 'sending'
  | 'completing'

/**
 * 自动回复 runner 的进程级可观测快照。
 *
 * 计数从当前进程创建 runner 起累计；`pending` 包含内存队列、debounce 与 durable 定时器。
 */
export interface ClawbotAutoReplyStats {
  pending: number
  inFlight: boolean
  stage: ClawbotAutoReplyStage
  inFlightSlot: number | null
  inFlightRunId: number | null
  recovered: number
  recoveryContinuations: number
  leaseLost: number
  coalesced: number
  generationSucceeded: number
  generationFailed: number
  sendSucceeded: number
  sendRetried: number
  sendFailedPermanently: number
  dropped: number
  backpressure: number
  lastError: string | null
  lastCompletedAt: number | null
}

/** 环境自检快照。 */
export interface ClawbotEnvSnapshot {
  items: ClawbotEnvCheckItem[]
  /** 进程级统计；自动回复是全局单飞，因此该快照跨实例汇总。 */
  autoReplyStats: ClawbotAutoReplyStats
}
