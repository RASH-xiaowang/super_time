/**
 * 「消息列表 / 回复投递规则」域的可序列化契约。
 *
 * 消息列表记录的是**已经产生或即将发出的一条回复**：任务首次触发、外部平台经局域网
 * Webhook 写入、或在面板里手动新增。规则按「会话名 + 触发对象」匹配一个下游 Webhook，
 * 记录落库时会保存地址快照，重发不会被后来改规则悄悄改道。
 *
 * 内部枚举保持英文（稳定存储），界面负责映射中文：
 *  · source: `first_trigger` / `webhook` / `manual` / `ai_reply`
 *  · status: `success` / `failed` / `pending` / `queued` / `running` / ...
 */
/** 一条消息记录的来源。 */
export type MessageListSource = 'first_trigger' | 'webhook' | 'manual' | 'ai_reply';
/**
 * 一次回复投递的状态。
 *
 * `queued` / `running` 表示下游已受理异步任务、但尚未得到终态；它们不是
 * `success`，也不能被批量重发。`sent_unconfirmed` 只表示对端已接受 HTTP
 * 请求、但本地未能确认结果已回写；它刻意不是 pending，避免后台或界面把它
 * 当成可安全重发的记录。
 */
export type MessageListStatus = 'success' | 'failed' | 'pending' | 'dispatching' | 'queued' | 'running' | 'sent_unconfirmed';
/** 记录里的一张图：微信本地引用、远程 URL、data URL 三选一。 */
export interface MessageListImage {
    /** 微信消息 local_id（配合记录的 chatUsername 解码）。 */
    localId?: number;
    /** 图片时间（毫秒）。 */
    createTime?: number;
    /** 发送者显示名。 */
    sender?: string;
    /** 图片 md5（有则带上）。 */
    md5?: string;
    /** 外部附件地址（仅 http/https）。 */
    url?: string;
    /** 外部附件内容（仅 data:image/...;base64）。 */
    dataUrl?: string;
    /** 附件显示名（可选，兼容调用方原文件名）。 */
    name?: string;
    /**
     * Super Time 本机受控附件暂存 id（40 位 hex）。
     *
     * 只由桌面文件选择器 + 本机 Remote 生成；入站 Webhook 不接受该字段，
     * 避免调用方引用其它记录的附件。投递时后端读取字节并上传到发送端 spool，
     * 不把本机绝对路径写入数据库或发给远端。
     */
    stagedId?: string;
    /** 暂存附件字节数。 */
    size?: number;
    /** 附件 MIME（仅元数据，发送时以实际字节为准）。 */
    mime?: string;
}
/** 桌面端选择文件后，在本机受控目录暂存附件。 */
export interface MessageListAttachmentStageInput {
    /** 桌面文件选择器返回的本机绝对路径；仅 LOCAL_ONLY Remote 可调用。 */
    path: string;
}
export interface MessageListAttachmentStageResult {
    ok: boolean;
    error?: string;
    attachment?: MessageListImage;
}
/** 一条消息列表记录。 */
export interface MessageListRecord {
    /** 自增序号。 */
    id: number;
    /** 回复 id：调用方提供或本机生成；下游响应里带回的 id 也会回写。 */
    replyId: string;
    /** 会话显示名。 */
    chatName: string;
    /** 会话对应企微用户的企业名称（仅展示，不参与规则匹配）。 */
    chatEnterpriseName?: string;
    /** 触发对象显示名。 */
    targetName: string;
    /** 触发对象对应企微用户的企业名称（仅展示，不参与规则匹配）。 */
    targetEnterpriseName?: string;
    /** 触发/回复文本。 */
    text: string;
    /** 触发/回复图片。 */
    images: MessageListImage[];
    /** 触发时间（毫秒）。 */
    triggeredAt: number;
    /** 来源。 */
    source: MessageListSource;
    /** 投递状态。 */
    status: MessageListStatus;
    /** 备注。 */
    note: string;
    /** 会话 username（本地图片解码、排障用，可为空）。 */
    chatUsername: string;
    /** 触发对象 username（排障用，可为空）。 */
    targetUsername: string;
    /** 本次投递使用的 Webhook 地址快照（重发优先用它）。 */
    webhookUrl: string;
    /** 最近一次失败原因。 */
    error: string;
    /**
     * 失败原因分类（稳定枚举，仅作展示与清理依据）：
     * `superseded` 按设计过期、`no_webhook` 缺发送地址、`generation_failed`
     * 未生成正文、`send_failed` 投递失败、`unconfirmed` 结果未确认、
     * `config_changed` 设置变更。空串/缺省表示未分类（旧行）。
     */
    failureKind?: string;
    /** 本机尝试次数。 */
    attempts: number;
    /** 最近一次尝试时间（毫秒）。 */
    lastAttemptAt?: number;
    /** 下游响应摘要。 */
    responseSummary?: string;
    /** 下游异步发送任务 id（例如 Feather 的 `jobs/<id>`）。 */
    jobId?: string;
    /** 下游任务状态原文；不据此推断消息是否已实际送达。 */
    jobState?: string;
    /** 最近一次查询下游任务状态的时间（毫秒）。 */
    jobCheckedAt?: number;
    /** 关联任务 id（任务触发时写入）。 */
    taskId?: number;
    /** 关联任务触发记录 id（任务触发时写入）。 */
    triggerId?: number;
    /** 来源幂等键（目前任务首次触发用 `task-trigger:<id>`）。 */
    sourceRef?: string;
    /** AI 回复分段组的基础 sourceRef；非分段记录为空。 */
    segmentGroupRef?: string;
    /** 当前段在 AI 回复分组中的序号，从 1 开始。 */
    segmentIndex?: number;
    /** AI 回复分组的总段数。 */
    segmentCount?: number;
    createdAt: number;
    updatedAt: number;
}
/** 消息列表查询。 */
export interface MessageListQuery {
    /** 在回复 id / 会话 / 对象 / 文本 / 备注 / 错误里做包含搜索。 */
    search?: string;
    status?: MessageListStatus | '';
    source?: MessageListSource | '';
    /**
     * 只读取指定记录，用于事件驱动地刷新已加载的深页窗口。
     *
     * 最多 500 个唯一正整数；该模式不分页，会继续应用 search/status/source 筛选。
     * 返回结果中缺少的请求 id 表示记录已删除或已不满足当前筛选。
     */
    ids?: number[];
    /**
     * 本页最多返回多少条（1..500，默认 200）。
     *
     * 超过上限时不会静默截断：返回的 `truncated` 为 true，并同时给出
     * `hasMore` / `nextCursor`，调用方可以继续翻页。
     */
    limit?: number;
    /**
     * 上一页返回的不透明游标。服务端按 `(triggeredAt, id)` 稳定续页，
     * 同一毫秒内的多条记录也不会跳过或重复。
     */
    cursor?: string;
}
/** 消息记录快照。 */
export interface MessageListSnapshot {
    items: MessageListRecord[];
    total: number;
    /**
     * 当前筛选条件下是否还有更早的记录。
     *
     * 新后端总会返回；声明为可选只为兼容尚未升级的旧 Remote。
     */
    hasMore?: boolean;
    /** 续页游标；只在 `hasMore === true` 时出现。 */
    nextCursor?: string;
    /**
     * 请求的 `limit` 是否被服务端单页上限截断。
     *
     * 它与 `hasMore` 分开：前者说明“这一页被缩过”，后者说明“后面还有记录”。
     */
    truncated?: boolean;
    readError?: string;
}
/** 新建一条记录的手动入参。 */
export interface MessageListRecordInput {
    replyId?: string;
    chatName?: string;
    targetName: string;
    text: string;
    images?: MessageListImage[];
    note?: string;
    chatUsername?: string;
    targetUsername?: string;
    triggeredAt?: number;
}
/** 会话级 AI 回复写入消息列表的专用入参；来源和幂等键由服务端强制。 */
export interface AiReplyMessageListInput {
    targetName: string;
    text: string;
    chatName?: string;
    chatUsername?: string;
    targetUsername?: string;
    triggeredAt?: number;
    /** `ai-reply:<account>:<talker>:<createTime>:<localId>`。 */
    sourceRef: string;
    note?: string;
}
/**
 * AI 回复预约写入消息列表的入参。
 *
 * 预约记录只有来源和幂等键，正文为空且不保存 Webhook 地址；生成完成后由
 * `completeAiReplyMessageListRecord` 补正文并重新解析地址，避免后台投递空消息。
 */
export interface AiReplyMessageListReserveInput {
    targetName: string;
    chatName?: string;
    chatUsername?: string;
    targetUsername?: string;
    triggeredAt?: number;
    /** `ai-reply:<account>:<talker>:<createTime>:<localId>`。 */
    sourceRef: string;
    note?: string;
}
/** AI 生成成功后的消息列表补全入参。 */
export interface AiReplyMessageListCompleteInput {
    text: string;
    note?: string;
}
/**
 * 局域网 Webhook 的兼容入参。
 *
 * 截图协议用 `target` + `message` + `attachments`；同时接受 `targetName` / `text` /
 * `chatName` 等显式字段。`source` 即使被传入也会在服务端强制覆盖为 `webhook`。
 */
export interface MessageListWebhookPayload {
    target?: string;
    targetName?: string;
    /** 群聊或会话目标；兼容外部服务里直接表示发送目的地的 `target`。 */
    chat?: string;
    /** 群内需要 @ 的成员；未传 chatName 时会与 target 组合成会话名 + 触发对象。 */
    mention?: string;
    message?: string;
    content?: string;
    text?: string;
    chatName?: string;
    conversationName?: string;
    /** 调用方提供的稳定重放键；与 replyId 一样参与服务端幂等键计算。 */
    idempotencyKey?: string;
    /** idempotencyKey 的兼容别名。 */
    sourceRef?: string;
    replyId?: string;
    note?: string;
    attachments?: unknown;
    images?: unknown;
    triggeredAt?: number;
    chatUsername?: string;
    targetUsername?: string;
}
/** 一条规则的入参（`id` 缺省 = 新建）。 */
export interface MessageListRuleInput {
    id?: number;
    /** 会话名；空串 = 任意会话。 */
    chatName?: string;
    /** 触发对象；空串 = 任意对象。 */
    targetName?: string;
    /** 下游 Webhook（http/https）。 */
    webhookUrl: string;
    /** 任务首次触发时插入的问候语；空串按「你好」。 */
    greetingText?: string;
    /** 规则说明。 */
    note?: string;
    enabled?: boolean;
    /**
     * 地址来自哪个托管应用实例（`apps.superlanguage` 的实例 id）；空串 = 手填地址。
     *
     * 只用于「实例端口变了之后自动改地址」与界面标记，不参与匹配：
     * 投递仍然只认 `webhook_url` 快照。
     */
    appInstanceId?: string;
    /**
     * 保留原有的 `managed_by` 标记（内部同步地址时用）。
     *
     * 普通保存会把 `managed_by` 清空（人工规则不再跟随默认地址）；同步托管实例
     * 地址时若也清空，那条 AI 默认规则下次就不会再跟随会话级默认地址了。
     */
    keepManagedBy?: boolean;
}
/** 一条规则。 */
export interface MessageListRule {
    id: number;
    chatName: string;
    targetName: string;
    webhookUrl: string;
    greetingText: string;
    note: string;
    enabled: boolean;
    /** 地址由哪个托管实例提供；空串 = 手填。 */
    appInstanceId: string;
    createdAt: number;
    updatedAt: number;
}
/** 规则列表快照。 */
export interface MessageListRuleSnapshot {
    items: MessageListRule[];
    total: number;
    readError?: string;
}
/** 新建/保存结果的通用形状。 */
export interface MessageListMutationResult {
    ok: boolean;
    id?: number;
    error?: string;
    /** 本次写规则顺带回填地址的记录数；有值说明这些记录已可投递。 */
    backfilled?: number;
}
/** 插入/重发后返回最新记录。 */
export interface MessageListRecordResult extends MessageListMutationResult {
    record?: MessageListRecord;
    /** false = sourceRef 命中旧记录，本次没有新建，也不得再次投递。 */
    created?: boolean;
}
/** 批量重发的单条处理结果。 */
export interface MessageListBatchResendItem {
    id: number;
    status: 'success' | 'failed' | 'skipped';
    error?: string;
}
/**
 * 一次按记录 id 批量重发的结果。
 *
 * `ok` 只表示这批请求被受理并完成处理，不表示每条都发送成功；逐条结果看
 * `items` 与汇总计数。请求中的重复 id 会先去重，单次最多处理 100 条。
 */
export interface MessageListBatchResendResult {
    ok: boolean;
    requested: number;
    succeeded: number;
    failed: number;
    skipped: number;
    items: MessageListBatchResendItem[];
    error?: string;
}
/**
 * 一次按记录 id 批量删除的结果。
 *
 * `removed` 只统计实际删除的行；不存在或仍处于投递中的记录会计入 `skipped`。
 */
export interface MessageListBatchDeleteResult {
    ok: boolean;
    requested: number;
    removed: number;
    skipped: number;
    items: Array<{
        id: number;
        status: 'removed' | 'skipped';
        error?: string;
    }>;
    error?: string;
}
/** 局域网 Webhook 信息（只在桌面端本机读取）。 */
export interface MessageListWebhookInfo {
    enabled: boolean;
    url: string;
    getExample: string;
    postExample: string;
    version: string;
    error?: string;
}
/** 下游 Webhook 健康检查结果（地址已脱敏）。 */
export interface MessageListWebhookProbe {
    ok: boolean;
    /** 服务返回的原始业务状态；HTTP/解析失败时为空。 */
    status?: number;
    service?: string;
    version?: string;
    api?: number;
    webhook?: boolean;
    /** 只含 origin 与脱敏路径，不含路径令牌或查询串。 */
    endpoint: string;
    error?: string;
}
/** 下游异步发送任务查询结果；字段原样返回，不推断最终送达。 */
export interface MessageListWebhookJob {
    ok: boolean;
    id?: string;
    type?: string;
    state?: string;
    contentVerified?: boolean;
    sentCount?: number;
    mentionNewline?: boolean;
    errorCode?: number;
    endpoint: string;
    error?: string;
}
/** 批量投递一拍的摘要。 */
export interface MessageListDispatchBatchResult {
    dispatched: number;
    failed: number;
    errors?: string[];
}
