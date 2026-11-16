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

import { loadOlderChatMessages, openChatSession, openChatSessionAndLocate } from './chats-session-loader.ts'

const HASH = '0369f1affa3bb162c3bf31266d2ba0e6'
const ROOM = '44626999237@chatroom'

function session(username: string): WechatSession {
  return {
    username,
    displayName: '测试会话',
    type: username.endsWith('@chatroom') ? 'group' : 'private',
    lastTimestamp: 0,
    summary: '',
    unreadCount: 0,
    draft: '',
    pinned: false,
    hidden: false,
  }
}

function harness(): {
  runtime: OpenSessionRuntime
  current: () => WechatSession | null
  messages: () => readonly WechatMessage[]
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
    messages: () => messages,
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
    expect(api.writeRenderCache).toHaveBeenCalledWith('chat-msgs:v3:' + ROOM, { talker: ROOM, messages: [] })
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

  it('缓存首屏把最老一条的复合游标交出去，避免 cursor=0 的空续页', async () => {
    const older = {
      localId: 7, sortSeq: 107, type: 1, isSender: 1, createTime: 1,
    } satisfies WechatMessage
    const newer = {
      localId: 8, sortSeq: 108, type: 1, isSender: 0, sender: 'wxid_talker', createTime: 2,
    } satisfies WechatMessage
    api.readRenderCache.mockReturnValue({ talker: 'wxid_talker', messages: [older, newer] })
    api.apiGetMessages.mockResolvedValue({
      messages: [newer],
      total: 2,
      canonicalUsername: 'wxid_talker',
      chatDisplayName: '张三',
      chatType: 'private',
      selfWxid: 'wxid_self',
      hasMore: true,
      cursor: 108,
      cursorLocalId: 8,
    })
    const h = harness()

    await openChatSession(h.runtime, session('wxid_talker'))

    expect(h.runtime.setCursor, '缓存首屏没有交出可用的“更早”游标').toHaveBeenCalledWith(107)
    expect(h.runtime.setCursorLocalId).toHaveBeenCalledWith(7)
  })

  it('游标未就绪（0 且没有第二段）⇒ 不发续页、不动 hasMore/loading', async () => {
    const h = harness()
    h.runtime.messagesTalkerRef.current = 'wxid_talker'
    h.runtime.sessionEpochRef.current = 1
    const onBefore = vi.fn()

    await loadOlderChatMessages(h.runtime, session('wxid_talker'), 0, undefined, onBefore)

    expect(api.apiGetMessages, 'cursor=0 的空续页会把分页关死').not.toHaveBeenCalled()
    expect(onBefore).not.toHaveBeenCalled()
    expect(h.runtime.setHasMore).not.toHaveBeenCalled()
    expect(h.runtime.setMsgLoading).not.toHaveBeenCalled()
  })

  it('缓存信封写着别的会话 ⇒ 当作未命中，绝不把它画进本会话', async () => {
    const foreign = {
      localId: 1, sortSeq: 1, type: 1, isSender: 0, sender: 'wxid_other', createTime: 1,
      displayText: '别人的消息',
    } satisfies WechatMessage
    api.readRenderCache.mockReturnValue({ talker: 'wxid_other', messages: [foreign] })
    const own = {
      localId: 2, sortSeq: 2, type: 1, isSender: 0, sender: 'wxid_talker', createTime: 2,
      displayText: '本会话的消息',
    } satisfies WechatMessage
    api.apiGetMessages.mockResolvedValue({
      messages: [own], total: 1, canonicalUsername: 'wxid_talker',
      chatDisplayName: '张三', chatType: 'private', selfWxid: 'wxid_self', hasMore: false,
    })
    const h = harness()

    await openChatSession(h.runtime, session('wxid_talker'))

    expect(h.messages(), '缓存信封的 talker 与请求不一致时仍被画出来了').toEqual([own])
  })

  it('旧格式（裸数组）与缺发送者证据的单聊缓存都不采用', async () => {
    const bare = [{
      localId: 1, sortSeq: 1, type: 1, isSender: 0, sender: 'wxid_talker', createTime: 1,
    } satisfies WechatMessage]
    const own = {
      localId: 2, sortSeq: 2, type: 1, isSender: 0, sender: 'wxid_talker', createTime: 2,
    } satisfies WechatMessage
    api.apiGetMessages.mockResolvedValue({
      messages: [own], total: 1, canonicalUsername: 'wxid_talker',
      chatDisplayName: '张三', chatType: 'private', selfWxid: 'wxid_self', hasMore: false,
    })

    api.readRenderCache.mockReturnValueOnce(bare)
    const a = harness()
    await openChatSession(a.runtime, session('wxid_talker'))
    expect(a.messages(), 'v2 裸数组没有信封，不能直画').toEqual([own])

    // 单聊行没有 sender：无法核对归属（旧后端/旧缓存），宁可多取一次权威数据。
    api.readRenderCache.mockReturnValueOnce({ talker: 'wxid_talker', messages: [{ isSender: 0 }] })
    const b = harness()
    await openChatSession(b.runtime, session('wxid_talker'))
    expect(b.messages(), '没有任何归属证据的缓存被当成可用').toEqual([own])
  })

  it('续页为空时不留滚动锚点（空页插入后它会按旧高度把视口拽下去）', async () => {
    api.apiGetMessages.mockResolvedValue({ messages: [], total: 0, hasMore: false })
    const h = harness()
    h.runtime.messagesTalkerRef.current = 'wxid_talker'
    h.runtime.sessionEpochRef.current = 1
    const onBefore = vi.fn()

    await loadOlderChatMessages(h.runtime, session('wxid_talker'), 100, 5, onBefore)

    expect(api.apiGetMessages).toHaveBeenCalledWith({
      talker: 'wxid_talker',
      limit: 100,
      cursor: 100,
      cursorLocalId: 5,
    })
    expect(onBefore).not.toHaveBeenCalled()
    expect(h.runtime.setHasMore).toHaveBeenCalled()
  })

  it('续页按下标身份去重：同一页拼两遍不会整段重复', async () => {
    const older = [
      { localId: 1, sortSeq: 10, createTime: 1, type: 1, isSender: 0 } as WechatMessage,
      { localId: 2, sortSeq: 20, createTime: 2, type: 1, isSender: 0 } as WechatMessage,
    ]
    api.apiGetMessages.mockResolvedValue({ messages: older, total: 2, hasMore: true })
    const h = harness()
    h.runtime.messagesTalkerRef.current = 'wxid_talker'
    h.runtime.sessionEpochRef.current = 1
    const onBefore = vi.fn()

    await loadOlderChatMessages(h.runtime, session('wxid_talker'), 100, 5, onBefore)
    expect(h.messages().map((m) => m.localId), '续页没拼上').toEqual([1, 2])

    await loadOlderChatMessages(h.runtime, session('wxid_talker'), 100, 5, onBefore)
    expect(h.messages().map((m) => m.localId), '同一页被拼了第二遍（整段消息重复）').toEqual([1, 2])
  })
})
