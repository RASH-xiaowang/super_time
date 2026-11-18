/**
 * 消息列表的纯展示映射与小工具。
 *
 * 这里不放 React 状态或 API 调用，便于直接单测来源/状态文案、图片入参清洗和
 * 「会话名 × 触发对象」规则范围展示。
 */
import type {
  MessageListImage,
  MessageListRecord,
  MessageListRule,
  MessageListSource,
  MessageListStatus,
  MessageListSnapshot,
} from '@deepseek-ai/dsh-wechat-data/types'

export type MessageListView = 'records' | 'rules'

/** 首屏与后续页使用同一页大小；后端仍保留 500 的硬上限。 */
export const MESSAGE_LIST_PAGE_SIZE = 200
/**
 * 前端只保留一个有界数据窗口。十万级记录不会全部进入 React state；
 * 达到上限后停止追加，并明确提示用户用搜索/筛选缩小范围。
 */
export const MESSAGE_LIST_WINDOW_MAX = 2_000
/** SSR 冒烟没有滚动容器尺寸，只渲染固定首段，仍保持 DOM 上界。 */
export const MESSAGE_LIST_SSR_ROWS = 30

export interface MessageListWindowState {
  items: MessageListRecord[]
  total: number
  nextCursor?: string
  hasMore: boolean
  /** 服务端是否因单页上限缩过这一页。 */
  truncated: boolean
  /** 是否因前端有界窗口而停止继续追加。 */
  windowCapped: boolean
}

export const EMPTY_MESSAGE_LIST_WINDOW: MessageListWindowState = {
  items: [],
  total: 0,
  hasMore: false,
  truncated: false,
  windowCapped: false,
}

export function compareMessageListRecords(a: MessageListRecord, b: MessageListRecord): number {
  if (a.triggeredAt !== b.triggeredAt) return b.triggeredAt - a.triggeredAt
  return b.id - a.id
}

export function messageListPageHasMore(
  snapshot: MessageListSnapshot,
  pageSize = MESSAGE_LIST_PAGE_SIZE,
): boolean {
  if (snapshot.hasMore !== undefined) return snapshot.hasMore
  // 兼容尚未升级的 Remote：旧接口没有 hasMore，只能按游标或“取满一页”推断。
  return snapshot.nextCursor !== undefined || snapshot.items.length >= pageSize
}

function uniqueSortedRecords(
  groups: ReadonlyArray<readonly MessageListRecord[]>,
  maxItems: number,
): MessageListRecord[] {
  const byId = new Map<number, MessageListRecord>()
  for (const group of groups) {
    for (const record of group) {
      if (!Number.isSafeInteger(record.id) || record.id <= 0) continue
      // Later groups are fresher and win by id.
      byId.set(record.id, record)
    }
  }
  return [...byId.values()].sort(compareMessageListRecords).slice(0, maxItems)
}

function cursorOf(snapshot: MessageListSnapshot, hasMore: boolean): string | undefined {
  return hasMore ? snapshot.nextCursor : undefined
}

/** 第一页/主动刷新：整页替换窗口，绝不在旧筛选结果上追加。 */
export function replaceMessageListWindow(
  snapshot: MessageListSnapshot,
  maxItems = MESSAGE_LIST_WINDOW_MAX,
): MessageListWindowState {
  const items = uniqueSortedRecords([snapshot.items], maxItems)
  const serverHasMore = messageListPageHasMore(snapshot)
  const nextCursor = cursorOf(snapshot, serverHasMore)
  const canContinue = serverHasMore && nextCursor !== undefined
  const windowCapped = canContinue && items.length >= maxItems
  return {
    items,
    total: Math.max(0, Math.trunc(snapshot.total)),
    ...(nextCursor === undefined ? {} : { nextCursor }),
    hasMore: canContinue && !windowCapped,
    truncated: snapshot.truncated === true,
    windowCapped,
  }
}

/** 加载更早一页：按 id 去重、按服务端同一复合顺序排序，并裁到数据窗口上限。 */
export function appendMessageListWindow(
  current: MessageListWindowState,
  snapshot: MessageListSnapshot,
  maxItems = MESSAGE_LIST_WINDOW_MAX,
): MessageListWindowState {
  const items = uniqueSortedRecords([current.items, snapshot.items], maxItems)
  const serverHasMore = messageListPageHasMore(snapshot)
  const nextCursor = cursorOf(snapshot, serverHasMore)
  const canContinue = serverHasMore && nextCursor !== undefined
  const windowCapped = canContinue && items.length >= maxItems
  return {
    items,
    total: Math.max(0, Math.trunc(snapshot.total)),
    ...(nextCursor === undefined ? {} : { nextCursor }),
    hasMore: canContinue && !windowCapped,
    truncated: current.truncated || snapshot.truncated === true,
    windowCapped: current.windowCapped || windowCapped,
  }
}

/**
 * 静默回源只刷新第一页：已有深页窗口时原位合并状态，不丢失当前游标或尾部。
 *
 * 新记录只有在第一页仍与当前窗口有重叠、且窗口剩余容量足以一次容纳全部新记录时
 * 才插入。否则只更新重叠记录：部分插入会在第一页和深页之间留下空洞，挤出尾部则
 * 会让旧游标失去可恢复语义。显式刷新仍走 replace 路径，从第一页重建窗口。
 */
export function mergeMessageListRefresh(
  current: MessageListWindowState,
  snapshot: MessageListSnapshot,
  maxItems = MESSAGE_LIST_WINDOW_MAX,
): MessageListWindowState {
  const currentIds = new Set(current.items.map((record) => record.id))
  const merged = new Map<number, MessageListRecord>()
  for (const record of current.items) merged.set(record.id, record)

  const freshNewIds = new Set<number>()
  let overlapsCurrent = false
  for (const record of snapshot.items) {
    if (!Number.isSafeInteger(record.id) || record.id <= 0) continue
    if (currentIds.has(record.id)) {
      overlapsCurrent = true
      merged.set(record.id, record)
    } else {
      freshNewIds.add(record.id)
      merged.set(record.id, record)
    }
  }

  // 后写入的新记录只在上面的插入条件满足时保留；否则先回滚，避免被挤出尾部。
  const availableSlots = Math.max(0, maxItems - current.items.length)
  const canInsertAllNew = overlapsCurrent && freshNewIds.size <= availableSlots
  if (!canInsertAllNew) {
    for (const id of freshNewIds) merged.delete(id)
  }

  const items = [...merged.values()].sort(compareMessageListRecords)
  const nextCursor = current.nextCursor
  const canContinue = current.hasMore && nextCursor !== undefined
  const windowCapped = current.windowCapped || (canContinue && items.length >= maxItems)
  return {
    items,
    total: Math.max(0, Math.trunc(snapshot.total)),
    ...(nextCursor === undefined ? {} : { nextCursor }),
    hasMore: canContinue && !windowCapped,
    truncated: current.truncated || snapshot.truncated === true,
    windowCapped,
  }
}

/**
 * 事件后的定向记录刷新。
 *
 * 服务端会继续应用当前 search/status/source 筛选；因此请求过的 id 若未返回，
 * 说明记录已删除或已不满足筛选，前端必须一并移除，不能只合并返回项。
 * 游标、总数边界和窗口上限仍由当前分页窗口持有。
 */
export function mergeMessageListRecordUpdates(
  current: MessageListWindowState,
  snapshot: MessageListSnapshot,
  ids: readonly number[],
): MessageListWindowState {
  const requested = new Set(
    ids.filter((id) => Number.isSafeInteger(id) && id > 0),
  )
  if (requested.size === 0) return current
  const freshById = new Map<number, MessageListRecord>()
  for (const record of snapshot.items) {
    if (!requested.has(record.id) || !Number.isSafeInteger(record.id) || record.id <= 0) continue
    freshById.set(record.id, record)
  }
  const items = current.items
    .flatMap((record): MessageListRecord[] => {
      if (!requested.has(record.id)) return [record]
      const fresh = freshById.get(record.id)
      return fresh === undefined ? [] : [fresh]
    })
    .sort(compareMessageListRecords)
  return {
    ...current,
    items,
    // 同一次事件已经由第一页刷新过全局 total；定向查询只负责行状态，
    // 不再用第二个时间点的计数覆盖它，避免事件重叠时数字回退。
    total: current.total,
  }
}

export function nextMessageListPageSize(
  loaded: number,
  pageSize = MESSAGE_LIST_PAGE_SIZE,
  maxItems = MESSAGE_LIST_WINDOW_MAX,
): number {
  return Math.max(0, Math.min(pageSize, maxItems - loaded))
}

export interface RecordForm {
  chatName: string
  targetName: string
  text: string
  note: string
  imageUrls: string
  /** 桌面文件选择 + 本机 spool 后的稳定资源引用。 */
  stagedAttachments: MessageListImage[]
}

export interface RuleForm {
  id?: number
  chatName: string
  targetName: string
  webhookUrl: string
  greetingText: string
  note: string
  enabled: boolean
  /** 从记录打开表单时携带的来源，用于隐藏该来源不需要的配置项。 */
  recordSource?: MessageListSource
}

export interface Notice {
  kind: 'ok' | 'warn' | 'err'
  text: string
}

export const EMPTY_RECORD_FORM: RecordForm = {
  chatName: '',
  targetName: '',
  text: '',
  note: '',
  imageUrls: '',
  stagedAttachments: [],
}

export const EMPTY_RULE_FORM: RuleForm = {
  chatName: '',
  targetName: '',
  webhookUrl: '',
  greetingText: '你好',
  note: '',
  enabled: true,
}

/** 规则实体 → 表单副本；新增和编辑共用同一份字段映射。 */
export function ruleFormFromRule(rule: MessageListRule): RuleForm {
  return {
    id: rule.id,
    chatName: rule.chatName,
    targetName: rule.targetName,
    webhookUrl: rule.webhookUrl,
    greetingText: rule.greetingText || '你好',
    note: rule.note,
    enabled: rule.enabled,
  }
}

/** 查找与记录「会话名 + 触发对象」完全相同的规则。 */
export function findExactRuleForRecord(
  rules: readonly MessageListRule[],
  record: Pick<MessageListRecord, 'chatName' | 'targetName'>,
): MessageListRule | undefined {
  return rules.find((rule) => (
    rule.chatName === record.chatName && rule.targetName === record.targetName
  ))
}

/**
 * 从记录生成本地规则表单。
 *
 * 有完全匹配规则时编辑原规则；否则新建精确匹配规则，并预填记录中的匹配键。
 */
export function ruleFormForRecord(
  record: Pick<MessageListRecord, 'chatName' | 'targetName' | 'source'>,
  existing?: MessageListRule,
): RuleForm {
  const recordSource = record.source
  if (existing !== undefined) return { ...ruleFormFromRule(existing), recordSource }
  return {
    ...EMPTY_RULE_FORM,
    chatName: record.chatName,
    targetName: record.targetName,
    recordSource,
  }
}

export const SOURCE_LABEL: Record<MessageListSource, string> = {
  first_trigger: '首次触发',
  webhook: 'Webhook',
  manual: '手动',
  ai_reply: 'AI回复',
}

export const STATUS_LABEL: Record<MessageListStatus, string> = {
  success: '成功',
  failed: '失败',
  pending: '待执行',
  dispatching: '投递中',
  queued: '已受理·排队',
  running: '下游执行中',
  sent_unconfirmed: '已发送·未确认',
}

/** 空白 AI 预约超过这个时长没有正文，就按「生成停滞」展示。 */
export const AI_REPLY_STALLED_MS = 10 * 60_000

export type AiReplyPhase =
  | 'generating'
  | 'stalled'
  | 'waiting_config'
  | 'superseded'
  | 'failed_generation'
  | 'failed_send'
  | 'other'

type MessageListAiStatusInput = Pick<
  MessageListRecord,
  'source' | 'status' | 'text' | 'webhookUrl' | 'createdAt' | 'error'
> & { failureKind?: string }

/** 旧版把「已过期」写成普通失败文本；新行优先用 failureKind。 */
const LEGACY_EXPIRED_REPLY_ERROR = /会话已有更新的消息|过期取消/

/**
 * 是否按设计过期（会话已有更新消息，旧问题不补发）。
 *
 * 新后端写 `failureKind='superseded'`；旧行没有分类时用错误前缀兜底，
 * 避免升级后仍把这类记录当成真正的发送/生成失败。
 */
export function isSupersededAiReply(
  record: Pick<MessageListRecord, 'source' | 'status' | 'error'> & { failureKind?: string },
): boolean {
  if (record.source !== 'ai_reply') return false
  if (record.failureKind === 'superseded') return true
  return record.status === 'failed' && LEGACY_EXPIRED_REPLY_ERROR.test(record.error)
}

/**
 * 按记录里已有事实判定 AI 回复阶段。
 *
 * 空正文 pending 的时长一律从 `createdAt` 起算：`updatedAt` 会被无关的状态回写
 * 刷新，用它计时会让停滞的预约永远显示「生成中」。
 */
export function aiReplyPhase(
  record: MessageListAiStatusInput,
  now = Date.now(),
): AiReplyPhase {
  if (record.source !== 'ai_reply') return 'other'
  if (isSupersededAiReply(record)) return 'superseded'
  if (record.status === 'pending') {
    if (record.text.trim() === '') {
      const createdAt = Number.isFinite(record.createdAt) ? record.createdAt : 0
      return now - createdAt < AI_REPLY_STALLED_MS ? 'generating' : 'stalled'
    }
    return record.webhookUrl.trim() === '' ? 'waiting_config' : 'other'
  }
  if (record.status === 'failed') {
    return record.text.trim() === '' ? 'failed_generation' : 'failed_send'
  }
  return 'other'
}

/** AI 回复正文已落库，但还没有匹配到 Webhook 时的专用状态文案。 */
export function isAiReplyWaitingForWebhook(
  record: Pick<MessageListRecord, 'source' | 'status' | 'text' | 'webhookUrl'>,
): boolean {
  return record.source === 'ai_reply'
    && record.status === 'pending'
    && record.text.trim() !== ''
    && record.webhookUrl.trim() === ''
}

export function messageListRecordStatusLabel(
  record: MessageListAiStatusInput,
  now = Date.now(),
): string {
  switch (aiReplyPhase(record, now)) {
    case 'generating': return '生成中'
    case 'stalled': return '生成停滞'
    case 'waiting_config': return '待配置'
    case 'superseded': return '已过期'
    case 'failed_generation': return '生成失败'
    case 'failed_send': return '发送失败'
    default: return STATUS_LABEL[record.status]
  }
}

/** 状态徽标的悬停说明；失败阶段直接给出记录里保存的失败原文摘要。 */
export function messageListRecordStatusHint(
  record: MessageListAiStatusInput,
  now = Date.now(),
): string {
  const error = record.error.trim()
  switch (aiReplyPhase(record, now)) {
    case 'generating': return '模型正在生成，尚无正文'
    case 'stalled': return '超过 10 分钟没有进展，可能已中断'
    case 'waiting_config': return '正文已生成并保存；配置发送地址后自动投递'
    case 'superseded': return '会话已有更新消息，这条按设计不发送'
    case 'failed_generation':
    case 'failed_send': return error !== '' ? error : '未提供失败原因'
    default: return error
  }
}

export interface MessageListFailureCopy {
  title: string
  detail: string
  hint: string
}

const NO_SENDING_ADDRESS_ERROR =
  /未匹配到\s*Webhook|未配置(?:默认)?\s*Webhook|没有(?:已保存的)?(?:投递|发送)地址/i
const UNCONFIRMED_SEND_ERROR = /未确认|无法确认|可能已发出|可能已受理/

/**
 * 失败记录的分层文案。
 *
 * 备注列只展示 `title`，完整文本放悬停属性/详情抽屉；有 `failureKind` 时先按
 * 稳定分类映射，旧行没有分类才退回错误字符串判断。判断顺序从最具体到最宽泛，
 * 避免把「过期」「没地址」误报成泛化的操作失败。
 */
export function messageListFailureCopy(
  record: Pick<
    MessageListRecord,
    'source' | 'status' | 'text' | 'error' | 'webhookUrl'
  > & { failureKind?: string },
): MessageListFailureCopy {
  const error = record.error.trim()
  const missingAddress = NO_SENDING_ADDRESS_ERROR.test(error)
    || (record.status === 'pending'
      && record.text.trim() !== ''
      && record.webhookUrl.trim() === '')
  switch (record.failureKind) {
    case 'superseded':
      return {
        title: '这条回复已过期',
        detail: '对方传来更新的消息，系统只回复最新一条；旧问题不会补发',
        hint: '如需回复，请等待新消息',
      }
    case 'no_webhook':
      return {
        title: '还没有发送地址',
        detail: error !== '' ? error : '记录没有保存可用的发送地址',
        hint: '去配置规则',
      }
    case 'generation_failed':
      return {
        title: '没有生成正文',
        detail: '模型没有返回内容',
        hint: '重试只能重新发送已有正文',
      }
    case 'send_failed':
      return {
        title: '发送失败',
        detail: error !== '' ? error : '下游没有接受本次发送',
        hint: '',
      }
    case 'unconfirmed':
      return {
        title: '发送结果未确认',
        detail: '请求可能已发出，请先在微信核对，避免重复发送',
        hint: '核对后可单条重发',
      }
    case 'config_changed':
      return {
        title: '设置已变更',
        detail: error !== '' ? error : 'AI 回复设置已变更，本次回复已取消',
        hint: '如需回复，请重新触发',
      }
    default:
      break
  }
  if (isSupersededAiReply(record)) {
    return {
      title: '这条回复已过期',
      detail: '对方传来更新的消息，系统只回复最新一条；旧问题不会补发',
      hint: '如需回复，请等待新消息',
    }
  }
  if (missingAddress) {
    return {
      title: '还没有发送地址',
      detail: error !== '' ? error : '记录没有保存可用的发送地址',
      hint: '去配置规则',
    }
  }
  if (record.status === 'failed' && record.text.trim() === '') {
    return {
      title: '没有生成正文',
      detail: '模型没有返回内容',
      hint: '重试只能重新发送已有正文',
    }
  }
  if (record.status === 'sent_unconfirmed' || UNCONFIRMED_SEND_ERROR.test(error)) {
    return {
      title: '发送结果未确认',
      detail: '请求可能已发出，请先在微信核对，避免重复发送',
      hint: '核对后可单条重发',
    }
  }
  return {
    title: '操作失败',
    detail: error !== '' ? error : '未提供失败原因',
    hint: '',
  }
}

export const STATUS_FILTERS: ReadonlyArray<{ value: '' | MessageListStatus; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '待执行' },
  { value: 'dispatching', label: '投递中' },
  { value: 'queued', label: '排队' },
  { value: 'running', label: '执行中' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'sent_unconfirmed', label: '未确认' },
]

export const SOURCE_FILTERS: ReadonlyArray<{ value: '' | MessageListSource; label: string }> = [
  { value: '', label: '全部来源' },
  { value: 'first_trigger', label: '首次触发' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'manual', label: '手动' },
  { value: 'ai_reply', label: 'AI回复' },
]

export function timeText(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export function localImageKey(username: string, localId: number): string {
  return username + ':' + String(localId)
}

export function httpOrDataImages(text: string): MessageListImage[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap<MessageListImage>((line): MessageListImage[] => {
    if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(line)) return [{ dataUrl: line }]
    if (/^https?:\/\//i.test(line)) return [{ url: line }]
    return []
  }).slice(0, 9)
}

export function ruleScope(rule: MessageListRule): string {
  const chat = rule.chatName === '' ? '任意会话' : rule.chatName
  const target = rule.targetName === '' ? '任意对象' : rule.targetName
  return chat + ' × ' + target
}

export function statusTone(status: MessageListStatus): 'green' | 'red' | 'amber' {
  return status === 'success' ? 'green' : status === 'failed' ? 'red' : 'amber'
}

export function sourceTone(source: MessageListSource): 'cyan' | 'blue' | 'purple' | 'green' {
  return source === 'first_trigger' ? 'cyan' : source === 'webhook' ? 'blue' : source === 'ai_reply' ? 'green' : 'purple'
}

export function countStatus(records: readonly MessageListRecord[], status: MessageListStatus): number {
  return records.filter((record) => record.status === status).length
}

export interface BatchActionEligibility {
  eligible: boolean
  reason: string
}

/** 批量重发只处理待执行/失败且有正文或附件的记录；成功记录保留单条重发。 */
export function batchResendEligibility(record: MessageListRecord): BatchActionEligibility {
  if (record.status === 'dispatching') {
    return { eligible: false, reason: '正在投递，不能重复发送' }
  }
  if (record.status === 'queued' || record.status === 'running') {
    return { eligible: false, reason: '下游异步任务尚未结束，不能重复发送' }
  }
  if (record.status === 'sent_unconfirmed') {
    return { eligible: false, reason: '已发出但结果未确认，禁止自动重发' }
  }
  if (record.status === 'success') {
    return { eligible: false, reason: '已成功，不进入批量重发' }
  }
  if (record.text.trim() === '' && record.images.length === 0) {
    return { eligible: false, reason: '正文和附件均为空' }
  }
  return { eligible: true, reason: '' }
}

/** 批量探测只能使用记录内已保存的地址快照。 */
export function batchProbeEligibility(record: MessageListRecord): BatchActionEligibility {
  return record.webhookUrl === ''
    ? { eligible: false, reason: '没有已保存的投递地址，无法探测' }
    : { eligible: true, reason: '' }
}

/**
 * 批量删除护栏：投递中或下游异步任务执行中的记录不能删除；AI 回复有专用
 * 删除/清理入口，一律不进入通用批量删除，避免误伤生成链路。
 */
export function batchDeleteEligibility(record: MessageListRecord): BatchActionEligibility {
  if (record.source === 'ai_reply') {
    return { eligible: false, reason: 'AI 回复请用专用删除/清理' }
  }
  return record.status === 'dispatching' || record.status === 'queued' || record.status === 'running'
    ? { eligible: false, reason: '投递或下游任务执行中，不能删除' }
    : { eligible: true, reason: '' }
}

export function isBatchSelectable(record: MessageListRecord): boolean {
  return batchDeleteEligibility(record).eligible
}

/** 重新生成窗口：后端只接受创建 24 小时内的空白失败 AI 回复。 */
export const AI_REPLY_REGENERATE_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * 可以重新生成的失败分类：过期、模型没产出正文、设置变更。
 *
 * 发送失败/未确认不在其中——前者可能已经产生了外部副作用，后者无法确认，
 * 两者重新生成都可能造成重复调用或重复消息。
 */
const AI_REPLY_REGENERATE_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'superseded',
  'generation_failed',
  'config_changed',
])

/**
 * 重新生成一条空白失败 AI 回复的资格。
 *
 * 条件：来源 AI、失败且没有正文/图片、没有下游任务、失败分类属于
 * 过期/生成失败/设置变更、创建时间在 24 小时内。任何一条不满足都给出
 * 用户能读懂的原因，按钮据此隐藏而不是点击后才报错。
 * @param record - 消息记录。
 * @param now - 当前时间；测试可固定。
 * @returns 是否可重新生成及不可用原因。
 */
export function aiReplyRegenerateEligibility(
  record: MessageListRecord,
  now = Date.now(),
): BatchActionEligibility {
  if (record.source !== 'ai_reply') {
    return { eligible: false, reason: '只有 AI 回复记录可以重新生成' }
  }
  if (record.status === 'sent_unconfirmed' || record.failureKind === 'unconfirmed') {
    return { eligible: false, reason: '发送结果未确认，不能重新生成' }
  }
  if (record.text.trim() !== '' || record.images.length > 0) {
    return { eligible: false, reason: '已有正文或附件，不能重新生成' }
  }
  if ((record.jobId ?? '').trim() !== '' || (record.jobState ?? '').trim() !== '') {
    return { eligible: false, reason: '已投递到下游或存在任务，不能重新生成' }
  }
  if (record.attempts > 0 || record.lastAttemptAt !== undefined) {
    return { eligible: false, reason: '已经尝试过投递，不能重新生成' }
  }
  if (record.webhookUrl.trim() !== '') {
    return { eligible: false, reason: '已绑定发送地址，不能重新生成' }
  }
  if (record.status !== 'failed') {
    return { eligible: false, reason: '只有失败的 AI 回复可以重新生成' }
  }
  if (!AI_REPLY_REGENERATE_FAILURE_KINDS.has(record.failureKind ?? '')) {
    return { eligible: false, reason: '这条失败类型不支持重新生成' }
  }
  if (!Number.isFinite(record.createdAt)
    || now - record.createdAt >= AI_REPLY_REGENERATE_WINDOW_MS) {
    return { eligible: false, reason: '超过 24 小时，无法重新生成' }
  }
  return { eligible: true, reason: '' }
}

export interface AiReplyDeleteEligibility extends BatchActionEligibility {
  /** 删除会放弃 10 分钟内仍在进行的生成；确认框必须给出警告。 */
  generating: boolean
}

/**
 * 专用清理（整组删除）一条 AI 回复预约/失败记录的资格。
 *
 * 只处理「空白、无附件、无下游任务、从未尝试投递」的 pending/failed。
 * 10 分钟内的空白 pending 视为**仍在生成**，一律不允许删除：删除行并不等于
 * 取消在途模型调用，runner 仍会拿到结果并按同一 sourceRef 恢复/投递。等这一轮
 * 收口（失败）或超过停滞窗口后再清理。
 * @param record - 消息记录。
 * @param now - 当前时间；测试可固定。
 * @returns 是否可清理、原因及是否仍在生成。
 */
export function aiReplyDeleteEligibility(
  record: MessageListRecord,
  now = Date.now(),
): AiReplyDeleteEligibility {
  const no = (reason: string): AiReplyDeleteEligibility => ({
    eligible: false,
    reason,
    generating: false,
  })
  if (record.source !== 'ai_reply') return no('只有 AI 回复记录可以清理')
  if (record.status !== 'pending' && record.status !== 'failed') {
    return no('只有待执行或失败的 AI 回复可以清理')
  }
  if (record.text.trim() !== '' || record.images.length > 0) {
    return no('已有正文或附件，不能清理')
  }
  if ((record.jobId ?? '').trim() !== '' || (record.jobState ?? '').trim() !== '') {
    return no('已投递到下游或存在任务，不能清理')
  }
  if (record.attempts > 0 || record.lastAttemptAt !== undefined) {
    return no('已经尝试过投递，不能清理')
  }
  if (record.webhookUrl.trim() !== '') {
    return no('已绑定发送地址，不能清理')
  }
  if (record.status === 'pending' && aiReplyPhase(record, now) === 'generating') {
    return {
      eligible: false,
      reason: '生成进行中，完成或停滞后再清理',
      generating: true,
    }
  }
  return { eligible: true, reason: '', generating: false }
}

/** 下游任务是否仍在排队/执行（与后端 `ACTIVE_JOB_STATES` 同口径）。 */
function jobStillActive(jobState: string | undefined): boolean {
  const state = String(jobState ?? '').toLowerCase().replace(/[\s-]+/g, '_')
  return state === 'queued' || state === 'pending' || state === 'accepted' || state === 'submitted'
    || state === 'running' || state === 'processing' || state === 'in_progress' || state === 'executing'
}

/**
 * 终态 AI 回复记录的删除资格。
 *
 * 与 {@link aiReplyDeleteEligibility} 的分工：那条只覆盖「空白、从未投递」的预约，
 * 用于清理生成失败的半成品；这条覆盖**已经收口**的记录 —— 成功、已发出未确认、
 * 已失败。它们的正文是已经付费的模型产出或已经发出的消息，删除只是清台账，
 * **不会撤回任何已发出的消息**，所以确认框必须写明这一点。
 *
 * 仍然拒绝的情形（删行不等于停掉在途动作）：
 *   · `pending`：可能正在生成，下一拍 runner 会按同一 sourceRef 恢复并投递；
 *   · `dispatching` / `queued` / `running`：投递或下游任务还没结束；
 *   · `jobState` 仍是排队/执行态：下游异步任务未收口。
 * @param record - 消息记录。
 * @returns 是否可删除及原因。
 */
export function aiReplyTerminalDeleteEligibility(
  record: MessageListRecord,
): AiReplyDeleteEligibility {
  const no = (reason: string): AiReplyDeleteEligibility => ({
    eligible: false,
    reason,
    generating: false,
  })
  if (record.source !== 'ai_reply') return no('只有 AI 回复记录可以删除')
  if (record.status !== 'success' && record.status !== 'failed' && record.status !== 'sent_unconfirmed') {
    return no(
      record.status === 'pending'
        ? '生成中或待恢复的记录不能删除，等这一轮收口后再试'
        : '记录仍在投递或下游执行中，不能删除',
    )
  }
  if (jobStillActive(record.jobState)) return no('下游异步任务尚未结束，不能删除')
  return { eligible: true, reason: '', generating: false }
}

/** 任一删除口径可用即可删；表头清理与行内删除共用这一条判据。 */
export function aiReplyAnyDeleteEligibility(
  record: MessageListRecord,
  now = Date.now(),
): AiReplyDeleteEligibility {
  const reservation = aiReplyDeleteEligibility(record, now)
  if (reservation.eligible) return reservation
  const terminal = aiReplyTerminalDeleteEligibility(record)
  if (terminal.eligible) return terminal
  // 两条都拒绝时优先给更具体的「生成中」说明：它是用户最需要知道的那条。
  return reservation.generating ? reservation : terminal
}
