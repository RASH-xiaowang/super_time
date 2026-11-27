/**
 * 发送端插件适配层。
 *
 * 当前支持两种已确认的发送协议：
 *  · `/send/text`：`{talker,text}`；
 *  · `/webhook/<token>`：`{target,message}`、附件 `{target,attachments}`、
 *    群成员 `{target,message,mention,mention_separator:"newline"}`。
 *    任务结果用 `GET /webhook/<token>/jobs/{id}`。
 *
 * 两者都只在消息列表记录落库后由 dispatch 调用。未知路径继续走通用消息列表
 * JSON，不猜测字段或鉴权语义。
 *
 * 适配器只接收已经由消息列表隐私闸处理后的正文，不读取原始聊天记录，
 * 也不自行出网。真正 POST 由消息列表 dispatch 完成。
 */
import type { MessageListRecord } from '../../types.ts'
import {
  FEATHER_MESSAGE_MAX_UTF16,
  FEATHER_REQUEST_MAX_BYTES,
  FEATHER_TARGET_MAX_UTF16,
  jsonUtf8Bytes,
} from '../message-list-store-shared.ts'
import { isGroupMessageListRecord, mentionOfRecord } from './queue-plan.ts'

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**  `/webhook/<token>` 发送端点；资源上传子路径不算发送端点。 */
export function isFeatherWebhookEndpoint(url: string): boolean {
  try {
    return /^\/webhook\/[^/]+\/?$/i.test(new URL(url).pathname)
  } catch {
    return /\/webhook\/[^/]+\/?$/i.test(url)
  }
}

/** 附件上传子路径；它不是发送消息的 Webhook。 */
export function isFeatherResourceEndpoint(url: string): boolean {
  try {
    return /^\/webhook\/[^/]+\/resources\/?$/i.test(new URL(url).pathname)
  } catch {
    return /\/webhook\/[^/]+\/resources\/?$/i.test(url)
  }
}

/** 发送端按 UTF-16 code unit 计数；超限时给出可执行的拆分/缩短提示。 */
export function featherTextCapacityError(
  value: string,
  label: string,
  kind: 'name' | 'message',
): string | undefined {
  const max = kind === 'message' ? FEATHER_MESSAGE_MAX_UTF16 : FEATHER_TARGET_MAX_UTF16
  if (value.length <= max) return undefined
  return kind === 'message'
    ? ` ${label} 最多 ${String(max)} 个 UTF-16 字符（当前 ${String(value.length)}），请拆分为多条消息`
    : ` ${label} 最多 ${String(max)} 个 UTF-16 字符（当前 ${String(value.length)}），请缩短发送目标名称`
}

export interface FeatherCapacityInput {
  target: string
  message?: string
  mention?: string
  /** 最终要交给 `fetch` 的 JSON 对象；传入时按它的真实序列化结果检查。 */
  request?: unknown
}

/** 发送请求的四项硬约束：target、mention、message 与整个 JSON body。 */
export function featherRequestCapacityError(input: FeatherCapacityInput): string | undefined {
  const fieldError = featherTextCapacityError(input.target, 'target', 'name')
    || (input.mention === undefined
      ? undefined
      : featherTextCapacityError(input.mention, 'mention', 'name'))
    || (input.message === undefined
      ? undefined
      : featherTextCapacityError(input.message, 'message 正文', 'message'))
  if (fieldError !== undefined) return fieldError
  const request = input.request ?? {
    target: input.target,
    ...(input.message === undefined ? {} : { message: input.message }),
    ...(input.mention === undefined ? {} : { mention: input.mention }),
  }
  const bytes = jsonUtf8Bytes(request)
  return bytes <= FEATHER_REQUEST_MAX_BYTES
    ? undefined
    : `请求体 ${String(bytes)} 字节，超过发送程序 ${String(FEATHER_REQUEST_MAX_BYTES)} 字节上限；请缩短 target/message 或减少附件 resource_ids`
}

type FeatherRecordShape = Pick<
  MessageListRecord,
  'chatName' | 'targetName' | 'text' | 'source' | 'chatUsername'
>

/**
 * 记录落库/补全前的容量闸门。只有命中发送端点时才套用字段上限；
 * 通用 Webhook 仍保留自己的协议空间。
 */
export function featherRecordCapacityError(
  record: FeatherRecordShape,
  webhookUrl: string,
): string | undefined {
  if (!isFeatherWebhookEndpoint(webhookUrl)) return undefined
  const group = isGroupMessageListRecord(record)
  const target = group
    ? (textOf(record.chatName) || textOf(record.targetName))
    : (textOf(record.targetName) || textOf(record.chatName))
  const message = textOf(record.text)
  // 提及与投递共用同一条策略：私聊永不发，群聊只在批次首条发。
  const mention = mentionOfRecord(record)
  return featherRequestCapacityError({
    target,
    ...(message === '' ? {} : { message }),
    ...(mention === '' || mention === target ? {} : { mention }),
  })
}

/**
 * 判断一条消息列表记录是否代表群聊。
 *
 * 实现已移到 `queue-plan.ts`：入队与投递必须用同一个判据，否则
 * 「写入时按群聊记提问者、投递时按私聊当目的地」这类错位会静默发生。
 */
export { isGroupMessageListRecord } from './queue-plan.ts'

/**
 * 将消息列表记录转成桥接发送请求。该函数不直接出网，便于单测检查
 * “只有消息列表记录能成为发送正文”的约束。
 */
export function dshBridgeRequestOf(record: MessageListRecord): {
  ok: boolean
  error?: string
  request?: { talker: string; text: string }
} {
  if (record.source !== 'ai_reply') {
    return { ok: false, error: '仅 AI 回复记录允许走适配器' }
  }
  if (record.images.length > 0) {
    return { ok: false, error: '/send/text 不支持附件，禁止静默丢件' }
  }
  // 群聊记录的 `targetUsername` 是**提问者**（用于 @ 他），消息目的地仍是群。
  // 这个桥接协议只有 `{talker,text}`、没有 mention 字段，所以群聊只能发到群、
  // 无法真正 @ 人；要 @ 请用 Feather 的 `/webhook/<token>`（它有 mention）。
  const talker = isGroupMessageListRecord(record)
    ? textOf(record.chatUsername)
    : textOf(record.targetUsername)
  if (talker === '') return { ok: false, error: '消息列表记录缺少发送目标 wxid' }
  if (textOf(record.text) === '') return { ok: false, error: '消息列表记录正文为空' }
  return { ok: true, request: { talker, text: record.text } }
}

/**
 * 将已落库的 AI 回复转成 `/webhook/<token>` 发送请求。
 *
 * `target` 使用联系人显示名（与接口示例一致），`message` 使用已过隐私闸的正文。
 * token 只存在于用户配置的 URL 中，本适配器不会读取、复制或记录它。
 */
export function featherRequestOf(
  record: MessageListRecord,
  gatedText = record.text,
  attachments?: string[],
  resourceIds?: string[],
): {
  ok: boolean
  error?: string
  request?: {
    target: string
    message?: string
    mention?: string
    mention_separator?: 'newline'
    attachments?: string
    resource_ids?: string[]
    type?: 'attachments'
  }
} {
  const group = isGroupMessageListRecord(record)
  const target = group
    ? (textOf(record.chatName) || textOf(record.targetName))
    : (textOf(record.targetName) || textOf(record.chatName))
  const message = textOf(gatedText)
  const mention = mentionOfRecord(record)
  if (target === '') return { ok: false, error: '消息列表记录缺少发送目标名称' }
  const hasAttachments = (attachments?.length ?? 0) > 0 || (resourceIds?.length ?? 0) > 0
  if (message === '' && !hasAttachments) {
    return { ok: false, error: '消息列表记录正文和附件均为空' }
  }
  if (resourceIds !== undefined && resourceIds.length > 0 && message !== '') {
    // Feather 的单一任务不能同时粘贴正文和附件；先发资源任务，正文留在记录里。
    return { ok: false, error: '一次任务只能发送正文或附件，不能混发' }
  }
  const request = {
    target,
    ...(message === '' ? {} : { message }),
    ...(mention === '' || mention === target
      ? {}
      : { mention, mention_separator: 'newline' as const }),
    ...(attachments === undefined || attachments.length === 0
      ? {}
      : { attachments: attachments.join(';') }),
    ...(resourceIds === undefined || resourceIds.length === 0
      ? {}
      : { resource_ids: resourceIds }),
    ...(resourceIds === undefined || resourceIds.length === 0
      ? {}
      : { type: 'attachments' as const }),
  }
  const capacityError = featherRequestCapacityError({
    target,
    ...(message === '' ? {} : { message }),
    ...(mention === '' || mention === target ? {} : { mention }),
    request,
  })
  if (capacityError !== undefined) return { ok: false, error: capacityError }
  return {
    ok: true,
    request,
  }
}
