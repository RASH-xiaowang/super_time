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
} from '@deepseek-ai/dsh-wechat-data/types'

export type MessageListView = 'records' | 'rules'

export interface RecordForm {
  chatName: string
  targetName: string
  text: string
  note: string
  imageUrls: string
}

export interface RuleForm {
  id?: number
  chatName: string
  targetName: string
  webhookUrl: string
  greetingText: string
  note: string
  enabled: boolean
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
}

export const EMPTY_RULE_FORM: RuleForm = {
  chatName: '',
  targetName: '',
  webhookUrl: '',
  greetingText: '你好',
  note: '',
  enabled: true,
}

export const SOURCE_LABEL: Record<MessageListSource, string> = {
  first_trigger: '首次触发',
  webhook: 'Webhook',
  manual: '手动',
}

export const STATUS_LABEL: Record<MessageListStatus, string> = {
  success: '成功',
  failed: '失败',
  pending: '待执行',
}

export const STATUS_FILTERS: ReadonlyArray<{ value: '' | MessageListStatus; label: string }> = [
  { value: '', label: '全部状态' },
  { value: 'pending', label: '待执行' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' },
]

export const SOURCE_FILTERS: ReadonlyArray<{ value: '' | MessageListSource; label: string }> = [
  { value: '', label: '全部来源' },
  { value: 'first_trigger', label: '首次触发' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'manual', label: '手动' },
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

export function sourceTone(source: MessageListSource): 'cyan' | 'blue' | 'purple' {
  return source === 'first_trigger' ? 'cyan' : source === 'webhook' ? 'blue' : 'purple'
}

export function countStatus(records: readonly MessageListRecord[], status: MessageListStatus): number {
  return records.filter((record) => record.status === status).length
}
