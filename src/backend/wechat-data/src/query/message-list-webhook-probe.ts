/**
 * Message-list Webhook inspection helpers.
 *
 * This module owns endpoint redaction and the two read-only downstream probes so
 * `message-list-dispatch.ts` stays focused on delivery and ledger transitions.
 *
 * @module query/message-list-webhook-probe
 */
import { getMessageListRecord, getMessageListRule, saveMessageListJobResult } from './message-list-store.ts'
import { sendRequest } from './rpa/dispatch.ts'
import {
  WEBHOOK_TEXT_MAX,
  isTokenizedWebhookEndpoint,
  redactWebhookEndpoint,
  redactWebhookSecrets,
  trimText,
} from '../net/webhook-endpoint.ts'
import type { RetryFetch } from '../net/fetch-retry.ts'
import type { MessageListWebhookJob, MessageListWebhookProbe } from '../types.ts'

const RESPONSE_MAX = WEBHOOK_TEXT_MAX

export interface MessageListWebhookDeps {
  fetchImpl?: RetryFetch
}

export function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

// 脱敏与端点判定统一收在 `net/webhook-endpoint.ts`（定时总结推送共用同一把尺子）。
// 这里 re-export 是为了保住 `message-list-dispatch.ts` 既有的对外面。
export { redactWebhookEndpoint, redactWebhookSecrets, trimText }

export function safeErrorText(value: string, webhookUrl: string): string {
  return redactWebhookSecrets(value, webhookUrl)
}

/** Remote job ids must remain conservative ASCII identifiers. */
export function safeWebhookJobId(value: unknown): string {
  const text = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : ''
  return /^[A-Za-z0-9_-]{1,128}$/.test(text) ? text : ''
}

function webhookForRecordOrRule(
  decryptedDir: string,
  input: { recordId?: number; ruleId?: number },
): { webhookUrl: string; recordId?: number } {
  const recordId = Number(input.recordId)
  if (Number.isFinite(recordId) && recordId > 0) {
    const record = getMessageListRecord(decryptedDir, recordId)
    return { webhookUrl: record?.webhookUrl ?? '', recordId: record?.id }
  }
  const ruleId = Number(input.ruleId)
  if (Number.isFinite(ruleId) && ruleId > 0) {
    return { webhookUrl: getMessageListRule(decryptedDir, ruleId)?.webhookUrl ?? '' }
  }
  return { webhookUrl: '' }
}

function jsonObject(bodyText: string): Record<string, unknown> | undefined {
  try {
    const body = JSON.parse(bodyText) as unknown
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? body as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function optionalText(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const text = String(value).trim().slice(0, max)
  return text === '' ? undefined : text
}

/** GET health check against an address already stored on a record or rule. */
export async function probeMessageListWebhook(
  decryptedDir: string,
  input: { recordId?: number; ruleId?: number },
  deps: MessageListWebhookDeps = {},
): Promise<MessageListWebhookProbe> {
  const selected = webhookForRecordOrRule(decryptedDir, input)
  const endpoint = redactWebhookEndpoint(selected.webhookUrl)
  if (selected.webhookUrl === '') {
    return { ok: false, endpoint: '', error: '记录或规则没有已保存的下游地址' }
  }
  try {
    const response = await sendRequest({
      method: 'GET',
      url: selected.webhookUrl,
      headers: { accept: 'application/json' },
      body: '',
      contentType: 'application/json',
    }, deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }, {
      maxAttempts: 2,
      retryOn: ['network', 'http-5xx', 'http-429'],
    })
    const body = jsonObject(response.bodyText)
    const ok = response.status >= 200 && response.status < 300 && body?.['ok'] === true
    if (!ok) {
      return {
        ok: false,
        status: response.status,
        endpoint,
        error: redactWebhookSecrets(
          'HTTP ' + String(response.status)
            + (response.bodyText === '' ? '' : '：' + response.bodyText),
          selected.webhookUrl,
        ),
      }
    }
    const service = optionalText(body['service'], 80)
    const version = optionalText(body['version'], 80)
    const api = body['api']
    const webhook = body['webhook']
    if (
      service !== 'feather'
      || version === undefined
      || typeof api !== 'number'
      || !Number.isSafeInteger(api)
      || api <= 0
      || typeof webhook !== 'boolean'
    ) {
      return {
        ok: false,
        status: response.status,
        endpoint,
        error: 'Webhook 健康响应结构无效：需要 feather service、version、正整数 api 与 boolean webhook',
      }
    }
    const result: MessageListWebhookProbe = { ok: true, status: response.status, endpoint }
    result.service = service
    result.version = version
    result.api = api
    result.webhook = webhook
    return result
  } catch (e) {
    return {
      ok: false,
      endpoint,
      error: safeErrorText(errorText(e), selected.webhookUrl),
    }
  }
}

/**
 * Query an asynchronous job using the stored job id or the same strictly
 * validated id supplied by the caller.
 */
export async function queryMessageListWebhookJob(
  decryptedDir: string,
  input: { recordId: number; jobId?: string },
  deps: MessageListWebhookDeps = {},
): Promise<MessageListWebhookJob> {
  const recordId = Number(input.recordId)
  if (!Number.isFinite(recordId) || recordId <= 0) {
    return { ok: false, endpoint: '', error: '消息记录 id 无效' }
  }
  const record = getMessageListRecord(decryptedDir, recordId)
  const endpoint = redactWebhookEndpoint(record?.webhookUrl ?? '')
  if (record === undefined || record.webhookUrl === '') {
    return { ok: false, endpoint, error: '消息记录不存在或没有已保存的下游地址' }
  }
  if (!isTokenizedWebhookEndpoint(record.webhookUrl)) {
    return { ok: false, endpoint, error: '任务查询只支持 /webhook/<token> 地址' }
  }
  const jobId = safeWebhookJobId(input.jobId ?? record.jobId ?? '')
  if (jobId === '') return { ok: false, endpoint, error: '缺少合法的下游任务 id' }
  let url: URL
  try {
    url = new URL(record.webhookUrl)
  } catch {
    return { ok: false, endpoint, error: '已保存的下游地址无效' }
  }
  const basePath = url.pathname.replace(/\/+$/, '')
  url.pathname = basePath + '/jobs/' + jobId
  url.search = ''
  url.hash = ''
  try {
    const response = await sendRequest({
      method: 'GET',
      url: url.toString(),
      headers: { accept: 'application/json' },
      body: '',
      contentType: 'application/json',
    }, deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }, {
      maxAttempts: 2,
      retryOn: ['network', 'http-5xx', 'http-429'],
    })
    const body = jsonObject(response.bodyText)
    if (response.status < 200 || response.status >= 300 || body === undefined) {
      return {
        ok: false,
        endpoint,
        error: redactWebhookSecrets(
          'HTTP ' + String(response.status)
            + (response.bodyText === '' ? '' : '：' + response.bodyText),
          record.webhookUrl,
        ),
      }
    }
    const state = optionalText(body['state'], 80)
    const remoteId = safeWebhookJobId(body['id'])
    const remoteError = optionalText(body['message'], 300)
      ?? optionalText(body['error'], 200)
      ?? (optionalText(body['error_code'], 80) === undefined
        ? undefined
        : '错误码 ' + optionalText(body['error_code'], 80))
    const persisted = saveMessageListJobResult(decryptedDir, record.id, {
      jobId: remoteId === '' ? jobId : remoteId,
      jobState: state ?? '',
      ...(remoteError === undefined ? {} : { error: remoteError }),
    })
    return {
      ok: body['ok'] !== false,
      endpoint,
      ...(remoteId === '' ? {} : { id: remoteId }),
      ...(optionalText(body['type'], 80) === undefined ? {} : { type: optionalText(body['type'], 80) }),
      ...(state === undefined ? {} : { state }),
      ...(typeof body['content_verified'] === 'boolean'
        ? { contentVerified: body['content_verified'] }
        : {}),
      ...(typeof body['sent_count'] === 'number' ? { sentCount: body['sent_count'] } : {}),
      ...(typeof body['mention_newline'] === 'boolean'
        ? { mentionNewline: body['mention_newline'] }
        : {}),
      ...(typeof body['error'] === 'number' ? { errorCode: body['error'] } : {}),
      ...(persisted === undefined ? { error: '任务状态已返回，但消息记录保存失败' } : {}),
    }
  } catch (e) {
    return {
      ok: false,
      endpoint,
      error: safeErrorText(errorText(e), record.webhookUrl),
    }
  }
}
