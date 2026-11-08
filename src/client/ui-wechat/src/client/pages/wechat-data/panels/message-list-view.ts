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

/** AI 回复正文已落库，但还没有匹配到 Webhook 时的专用状态文案。 */
export function isAiReplyWaitingForWebhook(
  record: Pick<MessageListRecord, 'source' | 'status' | 'webhookUrl'>,
): boolean {
  return record.source === 'ai_reply'
    && record.status === 'pending'
    && record.webhookUrl.trim() === ''
}

export function messageListRecordStatusLabel(
  record: Pick<MessageListRecord, 'source' | 'status' | 'webhookUrl'>,
): string {
  return isAiReplyWaitingForWebhook(record) ? '待配置' : STATUS_LABEL[record.status]
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

/** 投递中或下游异步任务执行中的记录不能删除；否则会丢失任务追踪。 */
export function batchDeleteEligibility(record: MessageListRecord): BatchActionEligibility {
  return record.status === 'dispatching' || record.status === 'queued' || record.status === 'running'
    ? { eligible: false, reason: '投递或下游任务执行中，不能删除' }
    : { eligible: true, reason: '' }
}

export function isBatchSelectable(record: MessageListRecord): boolean {
  return batchDeleteEligibility(record).eligible
}
