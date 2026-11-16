/**
 * 聊天消息渲染缓存的**唯一出入口**（首屏秒开）。
 *
 * 这一层存的是「某个会话上次画出来的消息窗口」，读出来会直接画到消息流里，所以它
 * 必须先证明自己属于谁：
 *  · 键里带 talker 只说明**写入方认为**这份数据属于谁，不能自证；
 *  · 值里再带一份 `talker`（自描述信封），读取时要求与请求的会话完全一致；
 *  · 单聊再用消息行的 `sender` 做一次内容级归属校验，见 `msg-scope.ts`。
 *
 * 键升到 `v3`：v2 的裸列表没有任何归属证据（旧后端不给单聊行 `sender`），
 * 一旦历史上被写进过别人的会话，读出来也识别不了；升版让它们彻底读不到。
 * 旧条目由 `cache.ts` 的 schema 迁移一次性清掉。
 *
 * @module chat-render-cache
 */
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { readRenderCache, writeRenderCache } from '../api.ts'
import { cachedMessagesMatchTalker } from './msg-scope.ts'

/** 渲染缓存键前缀（改版本号 = 旧缓存全部失效，必须与 `cache.ts` 的说明一起改）。 */
export const CHAT_RENDER_CACHE_PREFIX = 'chat-msgs:v3:'
/**
 * 渲染缓存只保留最新窗口。首次打开会话无论如何都会权威拉取最近 100 条，
 * 历史消息由「加载更多」分页取；把用户本次加载的几千条全量写 localStorage
 * 只会在每次新消息时同步 JSON 序列化数 MB，且最终还会撞上 1.5MB 上限被丢弃。
 */
export const CHAT_RENDER_CACHE_MAX_MESSAGES = 300

/** 缓存值：自带归属，读取时据此拒绝「键与内容不是同一个会话」的条目。 */
interface ChatRenderCachePayload {
  /** 这份快照所属的会话 username。 */
  talker: string
  /** 消息窗口（时间升序，尾部是最新）。 */
  messages: readonly WechatMessage[]
}

/**
 * 读取某个会话的渲染缓存。
 * @param talker - 会话 username（必须是 canonical id，调用方保证）。
 * @param selfWxid - 当前登录账号 wxid（用于校验「自己发的」行，未知时传空）。
 * @returns 可直接画的窗口；没有缓存、归属不确定或内容校验失败时为 null。
 */
export function readChatRenderCache(
  talker: string,
  selfWxid?: string,
): readonly WechatMessage[] | null {
  const payload = readRenderCache<ChatRenderCachePayload>(CHAT_RENDER_CACHE_PREFIX + talker)
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null
  if (payload.talker !== talker) return null
  const messages = payload.messages
  if (!Array.isArray(messages)) return null
  return cachedMessagesMatchTalker(messages, talker, selfWxid) ? messages : null
}

/**
 * 写入某个会话的渲染缓存（只存最新窗口）。
 * @param talker - 会话 username；调用方必须保证列表归属已按 `sessionAlive` 校验过。
 * @param messages - 当前会话的完整消息列表（内部截取尾部窗口）。
 */
export function writeChatRenderCache(talker: string, messages: readonly WechatMessage[]): void {
  const tail = messages.length > CHAT_RENDER_CACHE_MAX_MESSAGES
    ? messages.slice(-CHAT_RENDER_CACHE_MAX_MESSAGES)
    : messages
  const payload: ChatRenderCachePayload = { talker, messages: tail }
  writeRenderCache(CHAT_RENDER_CACHE_PREFIX + talker, payload)
}
