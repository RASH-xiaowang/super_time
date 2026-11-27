import type { ChatAiReplyContext, ChatAiReplyContextImage } from './context.ts'

/**
 * 会话级 AI 回复的稳定契约。
 *
 * 账号身份只用后端解析出的 selfWxid；会话身份只用 WechatSession.username。
 * 显示名与会话槽位都不是普通聊天的稳定键。
 */

/**
 * 插件适配方式（展示与审计提示）。
 * 实际请求体由消息列表记录最终解析出的 Webhook 路径决定：`/send/text` 使用
 * `{talker,text}`，`/webhook/<token>` 使用 `{target,message}`，其它地址保持
 * 通用消息列表 JSON，避免旧 provider 值导致误发。
 */
export type ChatAiReplyProvider = 'dsh-wechat-bridge' | 'custom-webhook'

/** 回复任务阶段。 */
export type ChatAiReplyStage =
  | 'idle'
  | 'disabled'
  | 'queued'
  | 'generating'
  | 'saving'
  | 'dispatching'
  | 'waiting_config'
  | 'success'
  | 'failed'

/** 持久化的会话级设置。 */
export interface ChatAiReplySetting {
  enabled: boolean
  provider: ChatAiReplyProvider
  /**
   * 长回复是否在落库前按语义拆成多条消息记录。
   * 默认开启；关闭后仍只写一条，并遵守发送端单条 511 UTF-16 上限。
   */
  splitReply: boolean
  /** 会话级人格名称；空串表示使用内置默认人格。 */
  personaName: string
  /** 会话级人格/回复风格要求；空串表示使用内置默认人格。 */
  personaPrompt: string
  /** 是否让知识库参与本会话的自动回复；默认关闭。 */
  kbEnabled: boolean
  /** 参与回复的知识库 id；0 表示尚未选择（此时 `kbEnabled` 必须为 false）。 */
  kbId: number
  /**
   * 上下文时间窗（小时）：只把最近这个时间范围内的消息当作上下文。
   *
   * `0` = 不限（沿用「最近 60 条」）。设了窗口后，窗口之外的消息**不进提示词**，
   * 模型也就不会把几天前的旧事项当成还没做完的待办反复追问。
   * 上限 720 小时（30 天），超出按上限夹紧。
   */
  contextWindowHours: number
  /** 知识库没有依据时原样发送的转人工话术。 */
  safetyHandoff: string
  /** 额外禁说词，中文逗号分隔。空串表示只用固定红线。 */
  safetyBlocked: string
  /** 防两条旧请求互相覆盖。 */
  revision: number
  updatedAt: number
  /** 开启时的锚点；空串 = 尚未建立，下一拍只记录最新水位。 */
  cursor: string
}

/** 当前会话的只读状态与最近一次执行摘要。 */
export interface ChatAiReplyState extends ChatAiReplySetting {
  accountKey: string
  chatUsername: string
  chatName: string
  stage: ChatAiReplyStage
  /** 是否已保存当前账号的默认 Webhook；旧调用方可忽略。 */
  defaultWebhookConfigured?: boolean
  /** 默认 Webhook 的脱敏展示值，不包含路径 token 或查询凭据。 */
  defaultWebhookEndpoint?: string
  /**
   * 已预约但尚未完成的锚点；进程重启后据此恢复。
   * 若会话已出现更晚的可视消息，旧任务会收口，不再补发。
   */
  pendingCursor?: string
  /** 与 pendingCursor 对应的消息列表 sourceRef。 */
  pendingSourceRef?: string
  /**
   * 创建当前 pending 任务时的设置 revision。
   *
   * 进程重启后状态里的 revision 可能已被另一个窗口推进；保留起始 revision
   * 才能区分“同一任务恢复”与“旧任务已被新配置作废”。
   */
  pendingRevision?: number
  lastRunAt?: number
  recordId?: number
  error?: string
}

/** 默认 Webhook 的只读状态，供本机配置界面展示。 */
export interface ChatAiReplyDefaultWebhookState {
  configured: boolean
  /** 脱敏端点；未配置时为空串。 */
  endpoint: string
  updatedAt: number
  error?: string
}

/** 默认 Webhook 保存并应用后的结果；错误时也返回当前脱敏状态。 */
export interface ChatAiReplyDefaultWebhookMutationResult extends ChatAiReplyDefaultWebhookState {
  ok: boolean
  ruleId?: number
  ruleCreated?: boolean
  backfilled?: number
}

/**
 * 后台恢复读取设置列表的结果。
 *
 * 空列表只表示可以确认没有已开启会话；数据库读取失败必须显式返回
 * ok=false，调用方才能保持 pending 预约与水位不变。
 */
export type ChatAiReplyEnabledStatesReadResult =
  | { ok: true; states: ChatAiReplyState[] }
  | { ok: false; error: string }

/**
 * 会话列表筛选所需的轻量摘要。
 *
 * 不把游标、最近记录或错误详情带到列表接口：前端只需要知道哪些单聊已开启，
 * 逐会话读取完整状态仍走 getChatAiReplyState。
 */
export interface ChatAiReplyEnabledChat {
  chatUsername: string
  chatName: string
  updatedAt: number
}

/** 批量读取已开启会话的结果；读取失败不能伪装成空列表。 */
export type ChatAiReplyEnabledChatsResult =
  | { ok: true; chats: ChatAiReplyEnabledChat[] }
  | { ok: false; error: string }

/** 开关写入结果。 */
export interface ChatAiReplyMutationResult {
  ok: boolean
  error?: string
  state?: ChatAiReplyState
}

/** 后台扫描的一拍。 */
export interface ChatAiReplyScanResult {
  scanned: number
  queued: number
  created: number
  dispatched: number
  /** 本次从 generating/saving/dispatching 或未完成投递中恢复的会话数。 */
  recovered?: number
  errors?: string[]
}

/**
 * 模型输出。适配器只返回一次生成的完整正文；是否拆分由消息列表落库层决定，
 * 避免为了分段重复调用付费模型。
 */
export interface ChatAiReplyGenerationResult {
  toolCalls?: import('../reply-tools/types.ts').ReplyToolObservation[]
  toolSources?: import('../reply-tools/types.ts').ReplyToolSource[]
  ok: boolean
  text: string
  error?: string
  /** 生成期被主动取消；`text` 可能只含已流出的部分正文。 */
  canceled?: boolean
  /**
   * 实际使用的模型（`provider/model`）。只用于本机留痕与详情展示，
   * 不会出现在投递请求体里；缺省表示注入的生成器没有报告。
   */
  model?: string
}

/** 本层只关心这些稳定状态，不反向依赖消息列表的顶层展示类型。 */
export type ChatAiReplyMessageStatus =
  | 'success'
  | 'failed'
  | 'pending'
  | 'dispatching'
  | 'queued'
  | 'running'
  | 'sent_unconfirmed'

/** AI 回复在消息列表中的预约/更新结果（不暴露完整消息正文给运行器）。 */
export interface ChatAiReplyRecordResult {
  ok: boolean
  id?: number
  created?: boolean
  status?: ChatAiReplyMessageStatus
  text?: string
  sourceRef?: string
  error?: string
}

/** 恢复扫描时读取消息列表记录的最小只读快照。 */
export interface ChatAiReplyRecordSnapshot {
  found: boolean
  status?: ChatAiReplyMessageStatus
  text?: string
  sourceRef?: string
  error?: string
  /**
   * 桌面端「重新生成」守卫所需的只读事实。
   * 只带定位与安全判据，不把 Webhook 地址等凭据带进运行器。
   */
  source?: string
  imageCount?: number
  jobId?: string
  attempts?: number
  failureKind?: string
  createdAt?: number
}

/** 一次 AI 回复分组中的单段台账快照。 */
export interface ChatAiReplySegmentSnapshot {
  id: number
  segmentIndex: number
  segmentCount: number
  status: ChatAiReplyMessageStatus
  text: string
  sourceRef: string
  error?: string
  /** 重新生成/清理守卫所需：分段是否带附件、投递任务与发送尝试。 */
  imageCount?: number
  jobId?: string
  attempts?: number
  failureKind?: string
}

/** 原子补全一个 AI 回复分组的返回值。 */
export interface ChatAiReplySegmentsResult {
  ok: boolean
  segments?: ChatAiReplySegmentSnapshot[]
  error?: string
}

/** 消息列表投递失败中可稳定识别的机器状态。 */
export type ChatAiReplyDispatchReason = 'missing_webhook'

/** AI 回复投递结果；普通投递失败可只返回 ok/error。 */
export interface ChatAiReplyDispatchResult {
  ok: boolean
  error?: string
  reason?: ChatAiReplyDispatchReason
}

/** 单个会话的一条候选触发消息（只含定位所需的稳定字段）。 */
export interface ChatAiReplyAnchor {
  localId: number
  sortSeq: number
  createTime: number
  content: string
  /**
   * 触发者（群里 @我 的那个人）的 wxid 与展示名。
   *
   * 群聊回复必须 @ 提问者，投递时把它作为 `mention` 放在消息列表记录的
   * `targetName`/`targetUsername` 上。单聊留空（私聊没有「@某人」的语义）。
   * 只从原始消息现算，不落库：恢复时按 sourceRef 找到同一条消息再取一次。
   */
  mentionUsername?: string
  mentionName?: string
}

/** AI 扫描只需的稳定消息字段；`talker` 是 `WechatSession.username` 的别名。 */
export interface ChatAiReplyScanMessage {
  localId: number
  sortSeq?: number
  createTime: number
  isSender: number
  /** 兼容旧解析形状：3 表示图片。 */
  type?: number
  renderType?: string
  displayText?: string
  strContent?: string
  msgContent?: string
  /** 上下文可能只需读取媒体定位字段，不把整条富消息结构复制进运行器状态。 */
  rich?: {
    type?: string
    title?: string
    nickname?: string
    desc?: string
    md5?: string
    emojiUrl?: string
  }
  /**
   * 群聊专用：这条消息是否 @ 了登录账号。由读取边界注入（见 `listMessages`），
   * 单聊不带此字段。扫描用它把「群里闲聊」与「点名叫我」区分开。
   */
  mentionSelf?: boolean
  /** 发送者 wxid（群聊才有；回复时要 @ 的就是他）。 */
  sender?: string
  /** 发送者展示名（群昵称 → 备注 → wxid）。 */
  senderName?: string
}

/** 后台扫描依赖（队列、生成、落库投递均由网关注入）。 */
export interface ChatAiReplyScanDeps {  decryptedDir: () => string
  selfUsername: () => string
  /** 测试或上层缓存可注入；省略时直接读取真实设置库。 */
  readEnabledStates?: (decryptedDir: string) => ChatAiReplyEnabledStatesReadResult
  /** `talker` 是 `WechatSession.username` 的别名。 */
  listMessages: (talker: string, limit: number) => Promise<ChatAiReplyScanMessage[]>
  /**
   * 精确读取 pending 锚点所在的历史窗口；缺省时退回 `listMessages`。
   * `talker` 是 `WechatSession.username` 的别名。
   */
  listMessagesAtOrBefore?: (
    talker: string,
    localId: number,
    limit: number,
  ) => Promise<ChatAiReplyScanMessage[]>
  /**
   * 读取 cursor 之后最早的一批消息；正常扫描会与最新一页合并，
   * 恢复/投递前也用它判断会话是否已经推进。
   * `talker` 是 `WechatSession.username` 的别名。
   */
  listMessagesAfter?: (
    talker: string,
    cursor: string,
    limit: number,
  ) => Promise<ChatAiReplyScanMessage[]>
  /**
   * 测试可注入合成上下文；生产默认读取当前会话的消息库。
   * `talker` 是 `WechatSession.username` 的别名。
   */
  collectContext?: (
    decryptedDir: string,
    talker: string,
    selfUsername: string,
    anchorLocalId?: number,
    voiceTexts?: ReadonlyMap<number, string>,
    /** 上下文时间窗起点（秒）；0/缺省表示不限。 */
    sinceCreateTime?: number,
  ) => ChatAiReplyContext
  /**
   * 把窗口内的语音转成文本（localId → 文本）。生产网关接本地 whisper；
   * 未选择模型/引擎时返回空 Map，回复按 `[语音]` 占位继续，不阻断生成。
   */
  transcribeVoices?: (input: {
    decryptedDir: string
    /** `talker` 是 `WechatSession.username` 的别名。 */
    talker: string
    localIds: readonly number[]
  }) => Promise<ReadonlyMap<number, string>>
  /**
   * 按会话内 localId 解码图片；生产网关注入真实媒体解码器，测试可省略。
   * 解码器必须自行处理坏图/超预算图片，返回空数组也应被视为正常降级。
   */
  decodeImages?: (input: {
    decryptedDir: string
    /** `talker` 是 `WechatSession.username` 的别名。 */
    talker: string
    candidates: NonNullable<ChatAiReplyContext['imageCandidates']>
  }) => Promise<ChatAiReplyContextImage[]>
  /**
   * 按当前会话最近上下文检索知识库片段；生产网关注入真实混合检索，测试可省略。
   * 只返回带文件名的纯文本片段；检索失败应抛错，由运行器记录并降级为无知识库回复。
   */
  /**
   * 顺带收口上一进程遗留的 dispatching 记录（返回本次收口条数）。
   * 生产网关注入；测试可省略。扫描器会做 30 秒节流，避免每拍都写库。
   */
  closeInterruptedDispatches?: () => number
  collectKbSnippets?: (input: {
    kbId: number
    lines: readonly string[]
    latestPeer?: string
  }) => Promise<{ snippets: string[]; note: string }>
  generate: (input: {
    system: string
    publicText?: string
    prompt: string
    images?: ChatAiReplyContextImage[]
    accountKey: string
    chatUsername: string
    /** 生成期取消信号；生成器应把它透传给模型传输层。 */
    signal?: AbortSignal
  }) => Promise<ChatAiReplyGenerationResult>
  gate: (feature: string, stats: { sessions: number; messages: number }, texts: string[]) => string[]
  /**
   * 先写入一条空正文、无 Webhook 地址的 pending 预约记录。
   * 命中同一 sourceRef 时返回 created=false，并带回已有记录状态供运行器判断是否继续。
   */
  reserveReply: (input: {
    targetName: string
    chatName?: string
    chatUsername?: string
    targetUsername?: string
    triggeredAt?: number
    sourceRef: string
    note?: string
  }) => Promise<ChatAiReplyRecordResult>
  /** 生成成功后补正文、备注和当前规则解析出的 Webhook 地址。 */
  completeReply: (input: {
    id: number
    text: string
    note?: string
  }) => Promise<ChatAiReplyRecordResult>
  /**
   * 原子完成首个预约并插入后续分段。生产实现必须在一个事务内完成；缺省时
   * runner 回退到单条 `completeReply`，兼容旧测试与滚动升级。
   */
  completeReplySegments?: (input: {
    id: number
    segments: string[]
    note?: string
  }) => Promise<ChatAiReplySegmentsResult>
  /** 按基础 sourceRef 读取一个回复分组，供串行投递和崩溃恢复使用。 */
  listReplySegments?: (sourceRef: string) => Promise<ChatAiReplySegmentSnapshot[]>
  /** 某段失败后，把后续尚未发送的 pending 段明确收口，避免乱序补发。 */
  failReplySegmentsAfter?: (input: {
    sourceRef: string
    segmentIndex: number
    error: string
    /** 稳定失败分类：send_failed / unconfirmed / generation_failed 等。 */
    failureKind?: string
  }) => Promise<{ ok: boolean; error?: string }>
  /** 生成失败/取消时把预约记录标记为 failed，保留错误供消息列表展示。 */
  failReply: (input: {
    id: number
    error: string
    /** 稳定失败分类；缺省表示未分类（旧调用方）。 */
    failureKind?: string
  }) => Promise<ChatAiReplyRecordResult>
  /**
   * 删除一组**从未发送**的 AI 预约（整组必须都还是 pending）。
   *
   * 被同一轮更新消息取代的预约直接删除，不再标失败 —— 否则「任务信息」会被
   * 「会话已有更新的消息」这一类记录刷屏。缺省时退回 `failReply`。
   */
  dropReply?: (input: {
    id: number
    sourceRef: string
  }) => Promise<{ ok: boolean; error?: string }>
  /**
   * 桌面端「重新生成」专用：把一条空白失败的 AI 回复记录 CAS 重置为 pending。
   *
   * 只有 id/sourceRef/状态/正文/投递任务都与调用方看到的一致时才允许；
   * 返回失败时记录保持原状，绝不把已生成或已投递的事实改回 pending。
   */
  reopenReply?: (input: {
    id: number
    sourceRef: string
  }) => Promise<{ ok: boolean; error?: string }>
  /** 只读回查记录，用于崩溃后判断该从生成、补投还是人工终态继续。 */
  getReply: (id: number) => Promise<ChatAiReplyRecordSnapshot>
  /** 只允许投递已经由 completeReply 写入消息列表的记录。 */
  dispatchReply: (recordId: number) => Promise<ChatAiReplyDispatchResult>
  onRecordSaved?: (input: {
    accountKey: string
    chatUsername: string
    recordId: number
    created: boolean
  }) => void
  /** 预约记录被补全或标记失败后广播，让消息列表刷新正文/状态。 */
  onRecordUpdated?: (input: {
    accountKey: string
    chatUsername: string
    recordId: number
  }) => void
  onDispatchFinished?: (input: {
    accountKey: string
    chatUsername: string
    recordId: number
    ok: boolean
  }) => void
  /**
   * 过程留痕：把本轮上下文、提示词、模型输出与阶段耗时写到本机
   * `chat_ai_reply_traces`，供消息列表详情查看。
   *
   * 留痕是**诊断增强**：实现必须吞掉自身异常（写不进也不能影响回复），
   * 测试可省略。
   */
  writeTrace?: (patch: ChatAiReplyTracePatch) => void
  op: (action: string, ok: boolean, detail: string) => void
  /** 群聊知识库生成结果必须留待人工确认；写入失败不得自动投递。 */
  holdReply?: (input: { id: number; reason: string }) => Promise<{ ok: boolean; error?: string }>
}

/** 一次自动回复的阶段名（详情抽屉按顺序展示）。 */
export type ChatAiReplyTraceStageName =
  | 'reserved'
  | 'context'
  | 'generated'
  | 'generate_failed'
  | 'saved'
  | 'success'
  | 'failed'

/** 阶段留痕：发生时间与一句话说明（说明里只放数字/原因码，不放聊天正文）。 */
export interface ChatAiReplyTraceStage {
  name: ChatAiReplyTraceStageName
  at: number
  detail?: string
}

/**
 * 写入留痕的增量补丁：只有显式给出的字段会被覆盖。
 *
 * 运行器在预约、装配上下文、生成、落库、投递各阶段分别写一次，
 * 所以任何阶段崩溃都能在详情里看到「走到哪里」。
 */
export interface ChatAiReplyTracePatch {
  /** 消息列表记录 id；<=0 时整条补丁被忽略。 */
  recordId: number
  sourceRef?: string
  accountKey?: string
  chatUsername?: string
  model?: string
  startedAt?: number
  finishedAt?: number
  /** 本轮送进模型的上下文（逐行，已带时间与发言人）。 */
  context?: string
  /** 命中的知识库片段。 */
  kb?: string
  systemPrompt?: string
  userPrompt?: string
  imageCount?: number
  voiceCount?: number
  output?: string
  error?: string
  /** 隐私闸改写了提示词（脱敏）时为 true。 */
  redacted?: boolean
  stage?: ChatAiReplyTraceStage
  /** 本轮的工具调用（整体覆盖；调用方在生成完成时一次写全）。 */
  tools?: ChatAiReplyTraceTool[]
}

/**
 * 一次工具调用的事实（名称 / 成败 / 失败码 / 耗时）。
 *
 * 为什么单独一个结构而不是塞进 `stages.detail` 的一行文本：那一行是给人看的摘要，
 * 界面上没法单独渲染成表；而「为什么天气查不到」恰恰要靠 `code` 才说得清。
 */
export interface ChatAiReplyTraceTool {
  name: string
  ok: boolean
  /** 失败码（`weather_city_not_found` / `tool_network` / `tool_unavailable` …）。 */
  code?: string
  elapsedMs: number
}

/** 读取一条记录的过程留痕（详情抽屉用）。 */
export interface ChatAiReplyTrace {
  recordId: number
  sourceRef: string
  accountKey: string
  chatUsername: string
  model: string
  startedAt: number
  finishedAt: number
  context: string
  kb: string
  systemPrompt: string
  userPrompt: string
  imageCount: number
  voiceCount: number
  output: string
  error: string
  redacted: boolean
  stages: ChatAiReplyTraceStage[]
  /** 本轮实际发生的工具调用（按发生顺序；没有调用时为空数组）。 */
  tools: ChatAiReplyTraceTool[]
  updatedAt: number
}
