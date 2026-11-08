import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import type { LocateRuntime, OpenSessionRuntime } from './chats-session-loader.ts'

const api = vi.hoisted(() => ({
  apiGetMessages: vi.fn(),
  readRenderCache: vi.fn(),
  writeRenderCache: vi.fn(),
}))

vi.mock('../api.ts', () => ({
  apiGetMessages: api.apiGetMessages,
  readRenderCache: api.readRenderCache,
  writeRenderCache: api.writeRenderCache,
}))

import { openChatSession, openChatSessionAndLocate } from './chats-session-loader.ts'

const HASH = '0369f1affa3bb162c3bf31266d2ba0e6'
const ROOM = '44626999237@chatroom'

function harness(): {
  runtime: OpenSessionRuntime
  current: () => WechatSession | null
  locate: ReturnType<typeof vi.fn>
} {
  let current: WechatSession | null = null
  let messages: readonly WechatMessage[] = []
  let loading = false
  const locate = vi.fn()
  const sessionEpochRef = { current: 0 }
  const messagesTalkerRef = { current: null as string | null }
  const runtime = {
    selfWxid: 'wxid_self',
    sessionEpochRef,
    messagesTalkerRef,
    inFlightRef: { current: false },
    msgScrollRef: { current: null },
    watermarkRef: { current: 0 },
    sessionAlive: (epoch: number, talker: string) =>
      sessionEpochRef.current === epoch && messagesTalkerRef.current === talker,
    setCurSession: (value: WechatSession | null | ((previous: WechatSession | null) => WechatSession | null)) => {
      current = typeof value === 'function' ? value(current) : value
    },
    setMessages: (value: readonly WechatMessage[] | ((previous: readonly WechatMessage[]) => readonly WechatMessage[])) => {
      messages = typeof value === 'function' ? value(messages) : value
    },
    setCursor: vi.fn(),
    setCursorLocalId: vi.fn(),
    setTypeStats: vi.fn(),
    setMsgLoading: vi.fn((value: boolean) => { loading = value }),
    setMsgError: vi.fn(),
    setHasMore: vi.fn(),
    setSelfWxid: vi.fn(),
    setWatermarkFrom: vi.fn(),
    pinScrollToBottom: vi.fn(),
    locateMessage: locate,
    sessions: [],
  } as unknown as OpenSessionRuntime
  return {
    runtime,
    current: () => current,
    locate,
  }
}

describe('legacy hash chat navigation', () => {
  beforeEach(() => {
    api.apiGetMessages.mockReset()
    api.readRenderCache.mockReset().mockReturnValue(null)
    api.writeRenderCache.mockReset()
  })

  it('adopts the canonical group identity returned for an old Msg_<hash> link', async () => {
    api.apiGetMessages.mockResolvedValue({
      messages: [],
      total: 0,
      canonicalUsername: ROOM,
      chatDisplayName: '群聊 44626999237',
      chatType: 'group',
      selfWxid: 'wxid_self',
      hasMore: false,
    })
    const h = harness()
    const provisional = {
      username: HASH,
      displayName: '未命名会话',
      type: 'private',
      lastTimestamp: 0,
      summary: '',
      unreadCount: 0,
      draft: '',
      pinned: false,
      hidden: false,
    } satisfies WechatSession

    await openChatSession(h.runtime, provisional)

    expect(api.apiGetMessages).toHaveBeenCalledWith({ talker: HASH, limit: 100 })
    expect(api.readRenderCache).not.toHaveBeenCalled()
    expect(h.runtime.messagesTalkerRef.current).toBe(ROOM)
    expect(h.current()).toMatchObject({
      username: ROOM,
      displayName: '群聊 44626999237',
      type: 'group',
    })
    expect(h.current()?.displayName).not.toContain(HASH)
    expect(api.writeRenderCache).toHaveBeenCalledWith('chat-msgs:v2:' + ROOM, [])
  })

  it('fails closed when a legacy hash has no canonical identity', async () => {
    api.apiGetMessages.mockResolvedValue({
      messages: [],
      total: 0,
      selfWxid: 'wxid_self',
      hasMore: false,
    })
    const h = harness()
    const provisional = {
      username: HASH,
      displayName: HASH,
      type: 'private',
      lastTimestamp: 0,
      summary: '',
      unreadCount: 0,
      draft: '',
      pinned: false,
      hidden: false,
    } satisfies WechatSession

    await openChatSession(h.runtime, provisional)

    expect(h.current()?.username).not.toBe(HASH)
    expect(h.current()?.displayName).not.toContain(HASH)
    expect(api.readRenderCache).not.toHaveBeenCalled()
    expect(api.writeRenderCache).not.toHaveBeenCalled()
    expect(h.runtime.setMsgError).toHaveBeenCalledWith(
      expect.stringContaining('无法解析该会话身份'),
    )
  })

  it('loads a bounded window ending at a quoted target and queues its locate', async () => {
    const target = {
      localId: 42,
      sortSeq: 142,
      type: 1,
      isSender: 0,
      createTime: 1700000042,
      msgContent: '被引用的原消息',
      strContent: '被引用的原消息',
      displayText: '被引用的原消息',
    } satisfies WechatMessage
    api.apiGetMessages.mockResolvedValue({
      messages: [target],
      total: 200,
      canonicalUsername: 'wxid_talker',
      chatDisplayName: '张三',
      chatType: 'private',
      selfWxid: 'wxid_self',
      hasMore: true,
      cursor: 142,
      cursorLocalId: 42,
    })
    const h = harness()

    await openChatSessionAndLocate(
      h.runtime as unknown as LocateRuntime,
      'wxid_talker',
      42,
    )

    expect(api.apiGetMessages).toHaveBeenCalledTimes(1)
    expect(api.apiGetMessages).toHaveBeenCalledWith({
      talker: 'wxid_talker',
      limit: 100,
      beforeLocalId: 42,
    })
    expect(h.runtime.setMsgError).not.toHaveBeenCalledWith(expect.stringMatching(/未找到|失败|无法/))
    expect(h.locate).toHaveBeenCalledWith(
      42,
      'wxid_talker\u0000' + String(h.runtime.sessionEpochRef.current),
    )
  })
})
