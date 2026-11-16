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
  cleanupMessageListAttachmentSpool,
  claimMessageListRecordForDispatch,
  getMessageListRecord,
  messageListRecordCanBeClaimed,
  matchMessageListRule,
  pendingMessageListRecordIds,
  recoverInterruptedMessageListDispatches,
  saveMessageListDispatchResult,
} from './message-list-store.ts'
import type { MessageListDispatchIntent, MessageListRuleScope } from './message-list-store.ts'
import { messageListImagesError } from './message-list-store-schema.ts'
import { sendRequest } from './rpa/dispatch.ts'
import {
  featherResourceError,
  uploadMessageListImages,
} from './ai-reply/feather-resources.ts'
import {
  dshBridgeRequestOf,
  featherRequestOf,
  isGroupMessageListRecord,
  isFeatherResourceEndpoint,
} from './ai-reply/provider.ts'
import { MESSAGE_LIST_ATTACHMENT_TOTAL_MAX_BYTES, decodeMessageListImageDataUrl } from './message-list-attachments.ts'
import {
  FEATHER_REQUEST_MAX_BYTES,
  messageListJobPhase,
  messageListStatusForJobPhase,
} from './message-list-store-shared.ts'
import {
  errorText,
  redactWebhookSecrets,
  safeErrorText,
  safeWebhookJobId,
  trimText,
} from './message-list-webhook-probe.ts'
import type { RetryFetch } from '../net/fetch-retry.ts'
import type { ChatAiReplyDispatchReason } from './ai-reply/types.ts'
import { parseChatAiReplySourceRef } from './ai-reply/segments.ts'
import { canonicalChatReference } from './message-identity.ts'
import type { MessageListBatchResendResult, MessageListDispatchBatchResult, MessageListRecord, MessageListRecordResult, MessageListStatus } from '../types.ts'

export { probeMessageListWebhook, queryMessageListWebhookJob, redactWebhookEndpoint, safeWebhookJobId } from './message-list-webhook-probe.ts'

const DISPATCH_LIMIT = 20
const BATCH_RESEND_LIMIT = 100
// 只保留历史台账前缀识别；该功能已退役，但旧记录仍不能被通用 Webhook 重发。
const RETIRED_DEDICATED_SOURCE_REF_PREFIX = 'clawbot:'

/** 历史专用台账记录仍按来源前缀 fail-closed。 */
function isRetiredDedicatedSourceRef(sourceRef: string | undefined): boolean {
  return sourceRef?.trim().startsWith(RETIRED_DEDICATED_SOURCE_REF_PREFIX) === true
}

/** AI 默认规则按 sourceRef 的账号/会话作用域匹配，避免同名联系人跨账号串用。 */
function aiReplyRuleScope(decryptedDir: string, record: MessageListRecord): MessageListRuleScope {
  if (record.source !== 'ai_reply' || record.sourceRef === undefined) return {}
  const parsed = parseChatAiReplySourceRef(record.sourceRef)
  return parsed === null
    ? {}
    : {
        accountKey: parsed.accountKey,
        chatUsername: canonicalChatReference(
          decryptedDir,
          parsed.chatUsername,
          'AI 回复会话',
        ).username,
      }
}

/** 消息列表投递结果，带 AI 回复运行器可分支处理的稳定原因。 */
export type MessageListRecordDispatchResult = MessageListRecordResult & {
  reason?: ChatAiReplyDispatchReason
}

export interface MessageListDispatchDeps {
  decodeImage: (
    username: string,
    localId: number,
    options?: { fileOnly?: boolean },
  ) => Promise<{ url?: string; file?: string }>
  gate: (feature: string, stats: { sessions: number; messages: number }, texts: string[]) => string[]
  fetchImpl?: RetryFetch
}

function responseIdsFromBody(
  bodyText: string,
  tokenizedWebhook: boolean,
): { replyId: string; jobId: string; jobState: string } {
  if (bodyText.trim() === '') return { replyId: '', jobId: '', jobState: '' }
  try {
    const body = JSON.parse(bodyText) as unknown
    if (typeof body !== 'object' || body === null) return { replyId: '', jobId: '', jobState: '' }
    const row = body as Record<string, unknown>
    const data = row['data']
    const nested = typeof data === 'object' && data !== null && !Array.isArray(data)
      ? data as Record<string, unknown>
      : {}
    const replyId = trimText(row['replyId'] ?? row['reply_id'] ?? nested['replyId'] ?? nested['reply_id'], 200)
    const jobValue = tokenizedWebhook
      ? (row['jobId'] ?? row['job_id'] ?? row['id'] ?? nested['jobId'] ?? nested['job_id'] ?? nested['id'])
      : (row['jobId'] ?? row['job_id'] ?? nested['jobId'] ?? nested['job_id'])
    const stateValue = row['state'] ?? row['jobState'] ?? row['job_state']
      ?? nested['state'] ?? nested['jobState'] ?? nested['job_state']
    const jobState = typeof stateValue === 'string'
      ? stateValue.trim().slice(0, 80)
      : ''
    return { replyId, jobId: safeWebhookJobId(jobValue), jobState }
  } catch {
    return { replyId: '', jobId: '', jobState: '' }
  }
}

/**
 * HTTP 202 只证明请求已受理；只有任务状态明确 succeeded/failed 才可升级为终态。
 * tokenized Webhook 即使错误地返回 200，只要带异步 job/state，也按异步状态落账。
 */
function acceptedDispatchStatus(
  httpStatus: number,
  jobId: string,
  jobState: string,
  tokenizedWebhook: boolean,
): MessageListStatus | undefined {
  const phase = messageListJobPhase(jobState)
  const status = messageListStatusForJobPhase(phase)
  if (httpStatus === 202) return status ?? 'queued'
  if (tokenizedWebhook && jobId !== '' && (status === 'queued' || status === 'running')) {
    return status
  }
  return undefined
}

async function attachmentsOf(
  record: MessageListRecord,
  deps: MessageListDispatchDeps,
): Promise<{ urls: string[]; dataUrls: string[] }> {
  const urls: string[] = []
  const dataUrls: string[] = []
  let inlineBytes = 0
  const accountInlineDataUrl = (value: string): void => {
    // Legacy/DSH 会把 data URL 直接嵌进 JSON；预算按解码后的文件字节，
    // 不能把 base64 膨胀和 MIME 头计入附件大小。
    const decoded = decodeMessageListImageDataUrl(
      value,
      MESSAGE_LIST_ATTACHMENT_TOTAL_MAX_BYTES,
    )
    if (decoded === undefined) {
      throw new Error('消息列表包含非法图片 data URL，拒绝静默丢件')
    }
    const bytes = decoded.bytes.byteLength
    if (bytes > MESSAGE_LIST_ATTACHMENT_TOTAL_MAX_BYTES - inlineBytes) {
      throw new Error(
        '消息列表内联附件累计超过 20 MB 上限，请拆分为多条记录后分别发送',
      )
    }
    inlineBytes += bytes
  }
  for (const image of record.images) {
    if (typeof image.dataUrl === 'string' && image.dataUrl !== '') {
      accountInlineDataUrl(image.dataUrl)
      dataUrls.push(image.dataUrl)
      continue
    }
    if (typeof image.url === 'string' && image.url !== '') {
      urls.push(image.url)
      continue
    }
    // Never silently send a smaller attachment set than the persisted record.
    if (record.chatUsername === '' || image.localId === undefined || image.localId <= 0) {
      throw new Error('消息列表包含无法解析的附件，拒绝静默丢件')
    }
    try {
      const decoded = await deps.decodeImage(record.chatUsername, image.localId)
      if (typeof decoded.url === 'string' && decoded.url !== '') {
        accountInlineDataUrl(decoded.url)
        dataUrls.push(decoded.url)
      } else {
        throw new Error('empty image result')
      }
    } catch (e) {
      throw new Error('消息列表附件解析失败：' + errorText(e))
    }
  }
  return { urls, dataUrls }
}

/**
 * 同一条记录只允许一个进程内投递者。后台批量投递、AI 即时投递与人工重发
 * 可能同一时刻选中同一条 pending；若不在出网前占位，会重复发送微信消息。
 */
const dispatchLocks = new Set<string>()

function messageListRequestBody(record: MessageListRecord, text: string, attachments: string[]): string {
  const group = isGroupMessageListRecord(record)
  // 私聊的 chatName 可能只是未解析会话的展示占位名（如「未命名会话」）；
  // 发送目标必须回落到触发对象，与 featherRecordCapacityError 的取法保持一致。
  const target = group
    ? (record.chatName || record.targetName)
    : (record.targetName || record.chatName)
  const groupMention = group ? record.targetName : ''
  return JSON.stringify({
    // 轻羽等发送端把 target 当作消息目的地，群成员只能放进 mention。
    target,
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
 * 已确认的两条 AI 发送路径：
 *  · `/send/text` → `{ talker, text }`；
 *  · `/webhook/<token>` → `{ target, message }`。
 * 两条分支都只消费已写入消息列表的 ai_reply 记录；其它路径继续走通用
 * 消息列表请求体，不修改 token、不猜测未登记协议。
 */
function isDshBridgeEndpoint(url: string): boolean {
  try {
    return /^\/send\/text\/?$/i.test(new URL(url).pathname)
  } catch {
    return /\/send\/text\/?$/i.test(url)
  }
}

function isTokenizedWebhookEndpoint(url: string): boolean {
  try {
    return /^\/webhook\/[^/]+\/?$/i.test(new URL(url).pathname)
  } catch {
    return /\/webhook\/[^/]+\/?$/i.test(url)
  }
}

function isDshBridgeSuccess(bodyText: string): boolean {
  try {
    const body = JSON.parse(bodyText) as unknown
    return typeof body === 'object' && body !== null
      && (body as Record<string, unknown>)['ok'] === true
  } catch {
    return false
  }
}

function requestBody(
  record: MessageListRecord,
  text: string,
  attachments: { urls: string[]; dataUrls: string[] },
  resolvedWebhookUrl: string,
  resourceIds: string[] = [],
): string {
  if (isTokenizedWebhookEndpoint(resolvedWebhookUrl)) {
    // This invariant must hold at the request builder, not only in the caller.
    if (resourceIds.length > 0 && text !== '') {
      throw new Error('大肥鱼一次任务只能发送正文或附件；请拆成两条消息记录后分别重发')
    }
    const webhook = featherRequestOf(record, text, undefined, resourceIds)
    if (webhook.ok && webhook.request !== undefined) return JSON.stringify(webhook.request)
    throw new Error(webhook.error ?? '无法组装大肥鱼请求体')
  }
  const legacyAttachments = [...attachments.urls, ...attachments.dataUrls]
  if (isDshBridgeEndpoint(resolvedWebhookUrl)) {
    if (record.images.length > 0 || legacyAttachments.length > 0) {
      throw new Error('/send/text 不支持附件；请改用支持附件的 Webhook 或拆分为纯文本')
    }
    if (record.source === 'ai_reply') {
      const bridge = dshBridgeRequestOf({ ...record, text })
      if (bridge.ok && bridge.request !== undefined) return JSON.stringify(bridge.request)
      throw new Error(bridge.error ?? '无法组装 /send/text 请求体')
    }
  }
  return messageListRequestBody(record, text, legacyAttachments)
}

/** 将下游 HTTP 结果落为消息列表终态；出网只发生在上面的唯一 POST 中。 */
function saveDispatchResponse(
  decryptedDir: string,
  record: MessageListRecord,
  webhookUrl: string,
  status: number,
  bodyText: string,
): MessageListRecordDispatchResult {
  const tokenizedWebhook = isTokenizedWebhookEndpoint(webhookUrl)
  const { jobId, replyId, jobState } = responseIdsFromBody(bodyText, tokenizedWebhook)
  const summary = redactWebhookSecrets(
    'HTTP ' + String(status) + (bodyText === '' ? '' : ' · ' + bodyText),
    webhookUrl,
  )
  if (status >= 200 && status < 300) {
    if (isDshBridgeEndpoint(webhookUrl) && !isDshBridgeSuccess(bodyText)) {
      const error = redactWebhookSecrets(
        '大肥鱼桥未确认发送成功' + (bodyText === '' ? '' : '：' + bodyText),
        webhookUrl,
      )
      const latest = saveMessageListDispatchResult(decryptedDir, record.id, {
        status: 'failed',
        error,
        responseSummary: summary,
        replyId,
        jobId,
        jobState: 'submitted',
        webhookUrl,
        countAttempt: true,
      })
      return { ok: false, error, record: latest ?? record }
    }
    const asyncStatus = acceptedDispatchStatus(status, jobId, jobState, tokenizedWebhook)
    if (asyncStatus !== undefined) {
      const error = asyncStatus === 'failed'
        ? redactWebhookSecrets(
            '下游异步任务失败' + (bodyText === '' ? '' : '：' + bodyText),
            webhookUrl,
          )
        : ''
      const latest = saveMessageListDispatchResult(decryptedDir, record.id, {
        status: asyncStatus,
        error,
        responseSummary: summary,
        replyId,
        jobId,
        jobState: jobState || 'queued',
        webhookUrl,
        countAttempt: true,
      })
      if (latest === undefined) {
        const unconfirmed = saveMessageListDispatchResult(decryptedDir, record.id, {
          status: 'sent_unconfirmed',
          error: '下游已受理请求，但本地无法确认任务状态；请核对后人工处理',
          responseSummary: summary,
          replyId,
          jobId,
          jobState: jobState || 'queued',
          webhookUrl,
          countAttempt: true,
        })
        return {
          ok: false,
          error: '下游已受理请求，但本地无法确认任务状态；记录已停止自动重发，请核对后再处理',
          ...(unconfirmed === undefined ? {} : { record: unconfirmed }),
        }
      }
      return asyncStatus === 'failed'
        ? { ok: false, error, record: latest }
        : { ok: true, id: latest.id, record: latest }
    }
    const latest = saveMessageListDispatchResult(decryptedDir, record.id, {
      status: 'success',
      error: '',
      responseSummary: summary,
      replyId,
      jobId,
      jobState: 'submitted',
      webhookUrl,
      countAttempt: true,
    })
    if (latest === undefined) {
      // 第一次回写失败时再尽力留下「已发出但未确认」，避免记录停在 dispatching。
      const unconfirmed = saveMessageListDispatchResult(decryptedDir, record.id, {
        status: 'sent_unconfirmed',
        error: '下游已接受 HTTP 请求，但本地无法确认结果；请核对后人工处理',
        responseSummary: summary,
        replyId,
        jobId,
        jobState: 'submitted',
        webhookUrl,
        countAttempt: true,
      })
      return {
        ok: false,
        error: '下游已接受请求，但本地无法确认结果；记录已停止自动重发，请核对后再处理',
        ...(unconfirmed === undefined ? {} : { record: unconfirmed }),
      }
    }
    return { ok: true, id: latest.id, record: latest }
  }
  const error = redactWebhookSecrets(
    'HTTP ' + String(status) + (bodyText === '' ? '' : '：' + bodyText),
    webhookUrl,
  )
  const latest = saveMessageListDispatchResult(decryptedDir, record.id, {
    status: 'failed',
    error,
    responseSummary: summary,
    replyId,
    jobId,
    webhookUrl,
    countAttempt: true,
  })
  return { ok: false, error, record: latest ?? record }
}

/**
 * 投递一条记录。地址优先使用记录里的快照；没有快照时按当前规则重新匹配。
 * @param decryptedDir - 解密数据根。
 * @param id - 消息记录 id。
 * @param deps - 图片解码、隐私闸与 fetch 注入。
 * @param intent - automatic 只认领 pending；人工单条才可重试终态记录。
 * @returns 最新记录与成功/失败原因；无匹配规则时保持 pending。
 */
export async function dispatchMessageListRecord(
  decryptedDir: string,
  id: number,
  deps: MessageListDispatchDeps,
  intent: MessageListDispatchIntent = 'automatic',
): Promise<MessageListRecordDispatchResult> {
  const recordId = Number(id)
  if (!Number.isFinite(recordId) || recordId <= 0) return { ok: false, error: '消息记录 id 无效' }
  const lockKey = decryptedDir + '\u0000' + String(recordId)
  if (dispatchLocks.has(lockKey)) {
    return { ok: false, error: '该消息记录正在投递，请稍后刷新状态' }
  }
  dispatchLocks.add(lockKey)
  try {
    return await dispatchMessageListRecordUnlocked(decryptedDir, recordId, deps, intent)
  } finally {
    dispatchLocks.delete(lockKey)
  }
}

async function dispatchMessageListRecordUnlocked(
  decryptedDir: string,
  id: number,
  deps: MessageListDispatchDeps,
  intent: MessageListDispatchIntent,
): Promise<MessageListRecordDispatchResult> {
  const existing = getMessageListRecord(decryptedDir, id)
  if (existing === undefined) return { ok: false, error: '消息记录不存在' }
  if (isRetiredDedicatedSourceRef(existing.sourceRef)) {
    return {
      ok: false,
      error: '历史专用台账记录已停用，禁止进入通用 Webhook 投递',
      record: existing,
    }
  }
  const attachmentError = messageListImagesError(existing)
  if (attachmentError !== undefined) {
    const latest = saveMessageListDispatchResult(decryptedDir, existing.id, {
      status: 'failed',
      error: attachmentError,
      responseSummary: '',
      webhookUrl: existing.webhookUrl,
      countAttempt: false,
    })
    return { ok: false, error: attachmentError, record: latest ?? existing }
  }
  if (existing.text.trim() === '' && existing.images.length === 0) {
    return {
      ok: false,
      error: '正文和附件均为空，记录可能仍在生成；已拒绝投递空消息',
      record: existing,
    }
  }
  if (!messageListRecordCanBeClaimed(existing.status, intent)) {
    const error = existing.status === 'dispatching'
      ? '该消息记录正在投递，请稍后刷新状态'
      : intent === 'automatic'
        ? '自动投递只允许 pending 记录；已成功或待核对的记录只能人工单条处理'
        : intent === 'manual_batch'
          ? '批量重发只允许 pending 或 failed 记录'
          : '该消息记录当前状态不允许重复投递；请先核对是否已经发出'
    return { ok: false, error, record: existing }
  }
  let webhookUrl = existing.webhookUrl
  if (webhookUrl === '') {
    const rule = matchMessageListRule(
      decryptedDir,
      existing.chatName,
      existing.targetName,
      aiReplyRuleScope(decryptedDir, existing),
    )
    webhookUrl = rule?.webhookUrl ?? ''
  }
  if (webhookUrl === '') {
    const latest = saveMessageListDispatchResult(decryptedDir, existing.id, {
      status: 'pending',
      error: '未匹配到 Webhook：请先在规则配置中为会话名和触发对象设置地址',
      responseSummary: '',
      webhookUrl: '',
      countAttempt: false,
    })
    return {
      ok: false,
      reason: 'missing_webhook',
      error: '未匹配到 Webhook',
      record: latest ?? existing,
    }
  }
  if (isFeatherResourceEndpoint(webhookUrl)) {
    const error = 'Webhook 快照指向 /webhook/<token>/resources 附件资源端点，不能发送消息；请改为基础地址 /webhook/<token>'
    const latest = saveMessageListDispatchResult(decryptedDir, existing.id, {
      status: 'failed',
      error,
      responseSummary: '',
      webhookUrl,
      countAttempt: false,
    })
    return { ok: false, error, record: latest ?? existing }
  }

  const record = claimMessageListRecordForDispatch(decryptedDir, id, webhookUrl, intent)
  if (record === undefined) {
    const message = existing.status === 'dispatching'
      ? '该消息记录正在投递，请稍后刷新状态'
      : '该消息记录当前状态不允许重复投递；请先核对是否已经发出'
    return {
      ok: false,
      error: message,
      record: existing,
    }
  }
  const claimedAttachmentError = messageListImagesError(record)
  if (claimedAttachmentError !== undefined) {
    const latest = saveMessageListDispatchResult(decryptedDir, record.id, {
      status: 'failed',
      error: claimedAttachmentError,
      responseSummary: '',
      webhookUrl,
      countAttempt: false,
    })
    return { ok: false, error: claimedAttachmentError, record: latest ?? record }
  }

  let text = record.text
  let status = 0
  let bodyText = ''
  let requestStarted = false
  try {
    const gated = deps.gate('task_callback', { sessions: 1, messages: 1 }, [record.text])
    text = Array.isArray(gated) && gated.length > 0 ? String(gated[0]) : record.text
    const isFeather = isTokenizedWebhookEndpoint(webhookUrl) && !isFeatherResourceEndpoint(webhookUrl)
    const attachments = isFeather
      ? { urls: [], dataUrls: [] }
      : await attachmentsOf(record, deps)
    let resourceIds: string[] = []
    // Feather 的正文和附件是两个互斥任务；带图 AI 回复先明确失败，不把图片静默丢掉。
    // 纯附件记录会先上传到 spool，再由 resource_ids 触发。
    if (isFeather && record.images.length > 0) {
      if (text !== '') {
        throw new Error('大肥鱼一次任务只能发送正文或附件；请拆成两条消息记录后分别重发')
      }
      resourceIds = await uploadMessageListImages(
        webhookUrl,
        record.images,
        record.chatUsername,
        {
          decryptedDir,
          decodeImage: deps.decodeImage,
          ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
        },
      )
    }
    const payload = requestBody(record, text, attachments, webhookUrl, resourceIds)
    if (isFeather) {
      const bytes = Buffer.byteLength(payload, 'utf8')
      if (bytes > FEATHER_REQUEST_MAX_BYTES) {
        throw new Error(
          `大肥鱼请求体 ${String(bytes)} 字节，超过发送程序 ${String(FEATHER_REQUEST_MAX_BYTES)} 字节上限`,
        )
      }
    }
    requestStarted = true
    const response = await sendRequest({
      method: 'POST',
      url: webhookUrl,
      headers: { 'content-type': 'application/json' },
      body: payload,
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
    const error = safeErrorText(
      isTokenizedWebhookEndpoint(webhookUrl) ? featherResourceError(e) : errorText(e),
      webhookUrl,
    )
    const uncertain = requestStarted
    const persistedError = uncertain
      ? '投递请求可能已发出，但未收到完整响应；请核对下游与微信记录后人工处理：' + error
      : error
    const latest = saveMessageListDispatchResult(decryptedDir, record.id, {
      status: uncertain ? 'sent_unconfirmed' : 'failed',
      error: persistedError,
      responseSummary: '',
      webhookUrl,
      countAttempt: requestStarted,
    })
    return { ok: false, error: persistedError, record: latest ?? record }
  }

  return saveDispatchResponse(decryptedDir, record, webhookUrl, status, bodyText)
}

/** 仅投递本次新建的 AI 回复记录；sourceRef 已存在时禁止重复出网。 */
export async function dispatchCreatedMessageListRecord(
  decryptedDir: string,
  result: MessageListRecordResult,
  deps: MessageListDispatchDeps,
): Promise<MessageListRecordDispatchResult> {
  if (result.created === false) return result
  if (result.id === undefined) return result
  return dispatchMessageListRecord(decryptedDir, result.id, deps)
}

/** 批量重发前的安全门槛；返回空串表示可处理。 */
export function batchResendSkipReason(record: MessageListRecord): string {
  if (isRetiredDedicatedSourceRef(record.sourceRef)) {
    return '历史专用台账记录禁止进入批量 Webhook 重发'
  }
  if (record.status === 'dispatching') return '记录正在投递，已跳过'
  if (record.status === 'queued' || record.status === 'running') {
    return '下游异步任务尚未结束，禁止重复发送'
  }
  if (record.status === 'sent_unconfirmed') {
    return '记录已发出但结果未确认，禁止自动重复发送'
  }
  if (record.status === 'success') {
    return '已成功记录不进入批量重发；如确需重发请单条操作'
  }
  if (record.status !== 'pending' && record.status !== 'failed') {
    return '记录当前状态不支持重发'
  }
  if (record.text.trim() === '' && record.images.length === 0) {
    return '正文和附件均为空，无法重发'
  }
  return ''
}

function failedBatchResend(error: string, requested = 0): MessageListBatchResendResult {
  return {
    ok: false,
    requested,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    items: [],
    error,
  }
}

/**
 * 按显式勾选的记录 id 顺序重发。
 *
 * 只处理消息列表中已经落库的记录，重复 id 会先去重，单次最多 100 条。逐条复用
 * {@link dispatchMessageListRecord}，因此附件解析、隐私闸、记录锁与状态回写都走同一条链路。
 */
export async function batchResendMessageListRecords(
  decryptedDir: string,
  ids: readonly number[],
  deps: MessageListDispatchDeps,
): Promise<MessageListBatchResendResult> {
  const invalid = !Array.isArray(ids)
    || ids.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)
  if (invalid) return failedBatchResend('批量重发的记录 id 无效')
  const uniqueIds = [...new Set(ids.map((id) => Number(id)))]
  if (uniqueIds.length === 0) return failedBatchResend('请至少选择一条记录')
  if (uniqueIds.length > BATCH_RESEND_LIMIT) {
    return failedBatchResend(
      '单次最多批量重发 ' + String(BATCH_RESEND_LIMIT) + ' 条记录',
      uniqueIds.length,
    )
  }

  let succeeded = 0
  let failed = 0
  let skipped = 0
  const items: MessageListBatchResendResult['items'] = []
  for (const id of uniqueIds) {
    const record = getMessageListRecord(decryptedDir, id)
    if (record === undefined) {
      skipped += 1
      items.push({ id, status: 'skipped', error: '消息记录不存在' })
      continue
    }
    const skipReason = batchResendSkipReason(record)
    if (skipReason !== '') {
      skipped += 1
      items.push({ id, status: 'skipped', error: skipReason })
      continue
    }
    try {
      const result = await dispatchMessageListRecord(decryptedDir, id, deps, 'manual_batch')
      if (result.ok) {
        succeeded += 1
        items.push({ id, status: 'success' })
      } else {
        failed += 1
        items.push({
          id,
          status: 'failed',
          error: result.error ?? '投递失败',
        })
      }
    } catch (e) {
      failed += 1
      items.push({
        id,
        status: 'failed',
        error: safeErrorText(errorText(e), record.webhookUrl),
      })
    }
  }
  return {
    ok: true,
    requested: uniqueIds.length,
    succeeded,
    failed,
    skipped,
    items,
  }
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
  // 启动恢复只处理启动瞬间已超时的记录；长驻进程还需要在周期批次里继续收口，
  // 否则崩溃重启后 5 分钟内留下的 dispatching 会永久卡住。
  recoverInterruptedMessageListDispatches(decryptedDir)
  // spool 是发送成功后的可回收副本；清理只处理 7 天且无记录引用的文件。
  // 放到后台批次而不是每次单条投递，避免重发路径反复扫描目录。
  void cleanupMessageListAttachmentSpool(decryptedDir).catch(() => undefined)
  const ids = pendingMessageListRecordIds(decryptedDir, limit)
  let dispatched = 0
  let failed = 0
  const errors: string[] = []
  for (const id of ids) {
    const result = await dispatchMessageListRecord(decryptedDir, id, deps, 'automatic')
    if (result.ok) {
      dispatched += 1
      continue
    }
    failed += 1
    if (errors.length < 10) errors.push('记录 ' + String(id) + '：' + (result.error ?? '投递失败'))
  }
  return errors.length > 0 ? { dispatched, failed, errors } : { dispatched, failed }
}
