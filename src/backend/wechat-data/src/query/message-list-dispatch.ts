/**
 * 消息列表的下游 Webhook 投递。
 *
 * 出网仍复用 `rpa/dispatch.ts#sendRequest`，保持全仓唯一 `fetchWithRetry` 调用点。
 * 所有文本先过 `task_callback` 隐私闸；只有 HTTP 2xx 算成功。本地图片引用在投递时
 * 解码成 data URL，外部 URL / data URL 原样作为附件。
 *
 * @module query/message-list-dispatch
 */
import {
  getMessageListRecord,
  matchMessageListRule,
  pendingMessageListRecordIds,
  saveMessageListDispatchResult,
} from './message-list-store.ts'
import { sendRequest } from './rpa/dispatch.ts'
import type { RetryFetch } from '../net/fetch-retry.ts'
import type {
  MessageListDispatchBatchResult,
  MessageListRecord,
  MessageListRecordResult,
} from '../types.ts'

const DISPATCH_LIMIT = 20
const RESPONSE_MAX = 500

export interface MessageListDispatchDeps {
  decodeImage: (
    username: string,
    localId: number,
    options?: { fileOnly?: boolean },
  ) => Promise<{ url?: string; file?: string }>
  gate: (feature: string, stats: { sessions: number; messages: number }, texts: string[]) => string[]
  fetchImpl?: RetryFetch
}

function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

function trimText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.trim() : ''
  return text.length > max ? text.slice(0, max) : text
}

function replyIdFromResponse(bodyText: string): string {
  if (bodyText.trim() === '') return ''
  try {
    const body = JSON.parse(bodyText) as unknown
    if (typeof body !== 'object' || body === null) return ''
    const row = body as Record<string, unknown>
    const direct = row['replyId'] ?? row['reply_id'] ?? row['id']
    if (typeof direct === 'string' || typeof direct === 'number') return trimText(String(direct), 200)
    const data = row['data']
    if (typeof data === 'object' && data !== null) {
      const nested = data as Record<string, unknown>
      const value = nested['replyId'] ?? nested['reply_id'] ?? nested['id']
      if (typeof value === 'string' || typeof value === 'number') return trimText(String(value), 200)
    }
  } catch {
    return ''
  }
  return ''
}

async function attachmentsOf(record: MessageListRecord, deps: MessageListDispatchDeps): Promise<string[]> {
  const out: string[] = []
  for (const image of record.images) {
    if (typeof image.dataUrl === 'string' && image.dataUrl !== '') {
      out.push(image.dataUrl)
      continue
    }
    if (typeof image.url === 'string' && image.url !== '') {
      out.push(image.url)
      continue
    }
    if (record.chatUsername === '' || image.localId === undefined || image.localId <= 0) continue
    try {
      const decoded = await deps.decodeImage(record.chatUsername, image.localId)
      if (typeof decoded.url === 'string' && decoded.url !== '') out.push(decoded.url)
    } catch {
      // 单张图片解码失败不阻断整条文本投递；失败图片不会伪装成成功附件。
    }
  }
  return out
}

function requestBody(record: MessageListRecord, text: string, attachments: string[]): string {
  const groupMention = record.chatName !== ''
    && record.targetName !== ''
    && record.chatName !== record.targetName
      ? record.targetName
      : ''
  return JSON.stringify({
    // 轻羽等发送端把 target 当作消息目的地，群成员只能放进 mention。
    target: record.chatName || record.targetName,
    message: text,
    attachments,
    ...(groupMention === '' ? {} : { mention: groupMention }),
    recordId: record.id,
    replyId: record.replyId,
    chatName: record.chatName,
    targetName: record.targetName,
    source: record.source,
    triggeredAt: record.triggeredAt,
    note: record.note,
  })
}

/**
 * 投递一条记录。地址优先使用记录里的快照；没有快照时按当前规则重新匹配。
 * @param decryptedDir - 解密数据根。
 * @param id - 消息记录 id。
 * @param deps - 图片解码、隐私闸与 fetch 注入。
 * @returns 最新记录与成功/失败原因；无匹配规则时保持 pending。
 */
export async function dispatchMessageListRecord(
  decryptedDir: string,
  id: number,
  deps: MessageListDispatchDeps,
): Promise<MessageListRecordResult> {
  const record = getMessageListRecord(decryptedDir, id)
  if (record === undefined) return { ok: false, error: '消息记录不存在' }

  let webhookUrl = record.webhookUrl
  if (webhookUrl === '') {
    const rule = matchMessageListRule(decryptedDir, record.chatName, record.targetName)
    webhookUrl = rule?.webhookUrl ?? ''
  }
  if (webhookUrl === '') {
    const latest = saveMessageListDispatchResult(decryptedDir, record.id, {
      status: 'pending',
      error: '未匹配到 Webhook：请先在规则配置中为会话名和触发对象设置地址',
      responseSummary: '',
      webhookUrl: '',
      countAttempt: false,
    })
    return { ok: false, error: '未匹配到 Webhook', record: latest ?? record }
  }

  const gated = deps.gate('task_callback', { sessions: 1, messages: 1 }, [record.text])
  const text = Array.isArray(gated) && gated.length > 0 ? String(gated[0]) : record.text
  let status = 0
  let bodyText = ''
  try {
    const attachments = await attachmentsOf(record, deps)
    const response = await sendRequest({
      method: 'POST',
      url: webhookUrl,
      headers: { 'content-type': 'application/json' },
      body: requestBody(record, text, attachments),
      contentType: 'application/json',
    }, deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }, {
      // 下游通常直接发微信消息，非幂等；失败由台账里的「重发」显式触发，
      // 不能在这里自动重试成两条消息。
      maxAttempts: 1,
      retryOn: [],
    })
    status = response.status
    bodyText = response.bodyText
  } catch (e) {
    const error = trimText(errorText(e), RESPONSE_MAX)
    const latest = saveMessageListDispatchResult(decryptedDir, record.id, {
      status: 'failed',
      error,
      responseSummary: '',
      webhookUrl,
    })
    return { ok: false, error, record: latest ?? record }
  }

  const replyId = replyIdFromResponse(bodyText)
  const summary = trimText('HTTP ' + String(status) + (bodyText === '' ? '' : ' · ' + bodyText), RESPONSE_MAX)
  if (status >= 200 && status < 300) {
    const latest = saveMessageListDispatchResult(decryptedDir, record.id, {
      status: 'success',
      error: '',
      responseSummary: summary,
      replyId,
      webhookUrl,
    })
    return latest === undefined
      ? { ok: false, error: '投递成功，但结果保存失败' }
      : { ok: true, id: latest.id, record: latest }
  }
  const error = trimText('HTTP ' + String(status) + (bodyText === '' ? '' : '：' + bodyText), RESPONSE_MAX)
  const latest = saveMessageListDispatchResult(decryptedDir, record.id, {
    status: 'failed',
    error,
    responseSummary: summary,
    replyId,
    webhookUrl,
  })
  return { ok: false, error, record: latest ?? record }
}

/**
 * 投递一批有地址快照的 pending 记录。
 * 没有地址的记录不会进入自动批次，避免永久占用队头；用户配好规则后可点「重发」。
 * @param decryptedDir - 解密数据根。
 * @param deps - 投递依赖。
 * @param limit - 本拍最多投几条。
 * @returns 成功/失败计数与前 10 条失败原因。
 */
export async function dispatchPendingMessageListRecords(
  decryptedDir: string,
  deps: MessageListDispatchDeps,
  limit = DISPATCH_LIMIT,
): Promise<MessageListDispatchBatchResult> {
  const ids = pendingMessageListRecordIds(decryptedDir, limit)
  let dispatched = 0
  let failed = 0
  const errors: string[] = []
  for (const id of ids) {
    const result = await dispatchMessageListRecord(decryptedDir, id, deps)
    if (result.ok) {
      dispatched += 1
      continue
    }
    failed += 1
    if (errors.length < 10) errors.push('记录 ' + String(id) + '：' + (result.error ?? '投递失败'))
  }
  return errors.length > 0 ? { dispatched, failed, errors } : { dispatched, failed }
}
