/**
 * 「消息列表 / 回复投递规则」域的可序列化契约。
 *
 * 消息列表记录的是**已经产生或即将发出的一条回复**：任务首次触发、外部平台经局域网
 * Webhook 写入、或在面板里手动新增。规则按「会话名 + 触发对象」匹配一个下游 Webhook，
 * 记录落库时会保存地址快照，重发不会被后来改规则悄悄改道。
 *
 * 内部枚举保持英文（稳定存储），界面负责映射中文：
 *  · source: `first_trigger` / `webhook` / `manual`
 *  · status: `success` / `failed` / `pending`
 */

/** 一条消息记录的来源。 */
export type MessageListSource = 'first_trigger' | 'webhook' | 'manual'

/** 一次回复投递的状态。 */
export type MessageListStatus = 'success' | 'failed' | 'pending'

/** 记录里的一张图：微信本地引用、远程 URL、data URL 三选一。 */
export interface MessageListImage {
  /** 微信消息 local_id（配合记录的 chatUsername 解码）。 */
  localId?: number
  /** 图片时间（毫秒）。 */
  createTime?: number
  /** 发送者显示名。 */
  sender?: string
  /** 图片 md5（有则带上）。 */
  md5?: string
  /** 外部附件地址（仅 http/https）。 */
  url?: string
  /** 外部附件内容（仅 data:image/...;base64）。 */
  dataUrl?: string
  /** 附件显示名（可选，兼容调用方原文件名）。 */
  name?: string
}

/** 一条消息列表记录。 */
export interface MessageListRecord {
  /** 自增序号。 */
  id: number
  /** 回复 id：调用方提供或本机生成；下游响应里带回的 id 也会回写。 */
  replyId: string
  /** 会话显示名。 */
  chatName: string
  /** 会话对应企微用户的企业名称（仅展示，不参与规则匹配）。 */
  chatEnterpriseName?: string
  /** 触发对象显示名。 */
  targetName: string
  /** 触发对象对应企微用户的企业名称（仅展示，不参与规则匹配）。 */
  targetEnterpriseName?: string
  /** 触发/回复文本。 */
  text: string
  /** 触发/回复图片。 */
  images: MessageListImage[]
  /** 触发时间（毫秒）。 */
  triggeredAt: number
  /** 来源。 */
  source: MessageListSource
  /** 投递状态。 */
  status: MessageListStatus
  /** 备注。 */
  note: string
  /** 会话 username（本地图片解码、排障用，可为空）。 */
  chatUsername: string
  /** 触发对象 username（排障用，可为空）。 */
  targetUsername: string
  /** 本次投递使用的 Webhook 地址快照（重发优先用它）。 */
  webhookUrl: string
  /** 最近一次失败原因。 */
  error: string
  /** 本机尝试次数。 */
  attempts: number
  /** 最近一次尝试时间（毫秒）。 */
  lastAttemptAt?: number
  /** 下游响应摘要。 */
  responseSummary?: string
  /** 关联任务 id（任务触发时写入）。 */
  taskId?: number
  /** 关联任务触发记录 id（任务触发时写入）。 */
  triggerId?: number
  /** 来源幂等键（目前任务首次触发用 `task-trigger:<id>`）。 */
  sourceRef?: string
  createdAt: number
  updatedAt: number
}

/** 消息列表查询。 */
export interface MessageListQuery {
  /** 在回复 id / 会话 / 对象 / 文本 / 备注 / 错误里做包含搜索。 */
  search?: string
  status?: MessageListStatus | ''
  source?: MessageListSource | ''
  /** 最多返回多少条（1..500，默认 200）。 */
  limit?: number
}

/** 消息记录快照。 */
export interface MessageListSnapshot {
  items: MessageListRecord[]
  total: number
  readError?: string
}

/** 新建一条记录的手动入参。 */
export interface MessageListRecordInput {
  replyId?: string
  chatName?: string
  targetName: string
  text: string
  images?: MessageListImage[]
  note?: string
  chatUsername?: string
  targetUsername?: string
  triggeredAt?: number
}

/**
 * 局域网 Webhook 的兼容入参。
 *
 * 截图协议用 `target` + `message` + `attachments`；同时接受 `targetName` / `text` /
 * `chatName` 等显式字段。`source` 即使被传入也会在服务端强制覆盖为 `webhook`。
 */
export interface MessageListWebhookPayload {
  target?: string
  targetName?: string
  /** 群聊或会话目标；兼容外部服务里直接表示发送目的地的 `target`。 */
  chat?: string
  /** 群内需要 @ 的成员；未传 chatName 时会与 target 组合成会话名 + 触发对象。 */
  mention?: string
  message?: string
  content?: string
  text?: string
  chatName?: string
  conversationName?: string
  replyId?: string
  note?: string
  attachments?: unknown
  images?: unknown
  triggeredAt?: number
  chatUsername?: string
  targetUsername?: string
}

/** 一条规则的入参（`id` 缺省 = 新建）。 */
export interface MessageListRuleInput {
  id?: number
  /** 会话名；空串 = 任意会话。 */
  chatName?: string
  /** 触发对象；空串 = 任意对象。 */
  targetName?: string
  /** 下游 Webhook（http/https）。 */
  webhookUrl: string
  /** 任务首次触发时插入的问候语；空串按「你好」。 */
  greetingText?: string
  /** 规则说明。 */
  note?: string
  enabled?: boolean
}

/** 一条规则。 */
export interface MessageListRule {
  id: number
  chatName: string
  targetName: string
  webhookUrl: string
  greetingText: string
  note: string
  enabled: boolean
  createdAt: number
  updatedAt: number
}

/** 规则列表快照。 */
export interface MessageListRuleSnapshot {
  items: MessageListRule[]
  total: number
  readError?: string
}

/** 新建/保存结果的通用形状。 */
export interface MessageListMutationResult {
  ok: boolean
  id?: number
  error?: string
}

/** 插入/重发后返回最新记录。 */
export interface MessageListRecordResult extends MessageListMutationResult {
  record?: MessageListRecord
}

/** 局域网 Webhook 信息（只在桌面端本机读取）。 */
export interface MessageListWebhookInfo {
  enabled: boolean
  url: string
  getExample: string
  postExample: string
  version: string
  error?: string
}

/** 批量投递一拍的摘要。 */
export interface MessageListDispatchBatchResult {
  dispatched: number
  failed: number
  errors?: string[]
}
