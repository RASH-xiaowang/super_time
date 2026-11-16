/**
 * 聊天消息渲染缓存的出入口：**键与值都必须自证属于同一个会话**。
 *
 * 背景见 `chat-render-cache.ts` / `msg-scope.ts` 的文件头：2026-09 的报障是
 * 「某个单聊窗口里出现了别人的聊天记录」，根因是渲染缓存被写进了上一个会话的列表。
 * 这条守卫钉住三件事：键升到 v3、值里带 talker、单聊内容还要拿得出 sender 证据。
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'

const store = vi.hoisted(() => ({
  readRenderCache: vi.fn(),
  writeRenderCache: vi.fn(),
}))

vi.mock('../api.ts', () => ({
  readRenderCache: store.readRenderCache,
  writeRenderCache: store.writeRenderCache,
}))

import {
  CHAT_RENDER_CACHE_MAX_MESSAGES,
  CHAT_RENDER_CACHE_PREFIX,
  readChatRenderCache,
  writeChatRenderCache,
} from './chat-render-cache.ts'

const TALKER = 'wxid_peer'
const SELF = 'wxid_me'
const msg = (localId: number, extra?: Partial<WechatMessage>): WechatMessage => ({
  localId, sortSeq: localId, type: 1, isSender: 0, createTime: 1700000000 + localId, ...extra,
})

beforeEach(() => {
  store.readRenderCache.mockReset()
  store.writeRenderCache.mockReset()
})

describe('writeChatRenderCache', () => {
  it('键是 v3，值是自描述信封（talker + 消息窗口）', () => {
    writeChatRenderCache(TALKER, [msg(1, { isSender: 1 }), msg(2, { sender: TALKER })])
    expect(store.writeRenderCache).toHaveBeenCalledTimes(1)
    const [key, payload] = store.writeRenderCache.mock.calls[0] as [string, { talker: string; messages: WechatMessage[] }]
    expect(key).toBe(CHAT_RENDER_CACHE_PREFIX + TALKER)
    expect(key).toBe('chat-msgs:v3:' + TALKER)
    expect(payload.talker).toBe(TALKER)
    expect(payload.messages.map((m) => m.localId)).toEqual([1, 2])
  })

  it('只写最新窗口，尾部对齐', () => {
    const list = Array.from({ length: CHAT_RENDER_CACHE_MAX_MESSAGES + 5 }, (_, i) => msg(i + 1, { isSender: 1 }))
    writeChatRenderCache(TALKER, list)
    const payload = store.writeRenderCache.mock.calls[0]?.[1] as { messages: WechatMessage[] }
    expect(payload.messages).toHaveLength(CHAT_RENDER_CACHE_MAX_MESSAGES)
    expect(payload.messages.at(-1)?.localId).toBe(list.length)
  })
})

describe('readChatRenderCache', () => {
  it('信封 talker 与请求一致且内容带归属证据 ⇒ 返回原窗口', () => {
    const messages = [msg(1, { isSender: 1 }), msg(2, { sender: TALKER })]
    store.readRenderCache.mockReturnValue({ talker: TALKER, messages })
    expect(readChatRenderCache(TALKER, SELF)).toEqual(messages)
    expect(store.readRenderCache).toHaveBeenCalledWith(CHAT_RENDER_CACHE_PREFIX + TALKER)
  })

  it('信封写着别的会话 ⇒ 拒绝（即使键是当前会话的）', () => {
    store.readRenderCache.mockReturnValue({ talker: 'wxid_other', messages: [msg(1, { sender: 'wxid_other' })] })
    expect(readChatRenderCache(TALKER, SELF)).toBeNull()
  })

  it('旧格式裸数组 ⇒ 拒绝（没有归属信息）', () => {
    store.readRenderCache.mockReturnValue([msg(1, { sender: TALKER })])
    expect(readChatRenderCache(TALKER, SELF)).toBeNull()
  })

  it('单聊缓存缺发送者证据 ⇒ 拒绝', () => {
    store.readRenderCache.mockReturnValue({ talker: TALKER, messages: [msg(1)] })
    expect(readChatRenderCache(TALKER, SELF)).toBeNull()
  })

  it('群聊缓存由信封负责归属（群里本来就有多个发送者）', () => {
    const room = '1@chatroom'
    const messages = [msg(1, { sender: 'a' }), msg(2, { sender: 'b' })]
    store.readRenderCache.mockReturnValue({ talker: room, messages })
    expect(readChatRenderCache(room, SELF)).toEqual(messages)
    store.readRenderCache.mockReturnValue({ talker: '2@chatroom', messages })
    expect(readChatRenderCache(room, SELF)).toBeNull()
  })
})
