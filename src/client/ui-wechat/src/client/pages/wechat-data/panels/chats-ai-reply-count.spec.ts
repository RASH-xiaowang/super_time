// @vitest-environment node
/**
 * 会话列表「AI 回复」判据。
 *
 * 现场缺陷：chip 显示「AI 回复 1」，但列表里有两个会话带 AI 徽标（一个群聊、
 * 一个单聊）。原因是计数处只统计单聊、筛选与徽标处包含群聊 —— 同一件事写了三遍。
 * 现在三处共用 `sessionHasAiReply`，这里钉住判据本身。
 */
import { describe, expect, it } from 'vitest'
import {
  sessionHasAiReply,
  sessionIsConversational,
} from './use-chat-ai-reply-enabled.ts'

const enabled = (...usernames: string[]): ReadonlySet<string> => new Set(usernames)

describe('sessionIsConversational', () => {
  it('单聊与群聊都算可对话会话（群聊只回 @我 的消息，但仍算已开启）', () => {
    expect(sessionIsConversational({ type: 'private' })).toBe(true)
    expect(sessionIsConversational({ type: 'group' })).toBe(true)
  })
})

describe('sessionHasAiReply', () => {
  it('群聊开启后必须计入（这正是「开了 2 个显示 1 个」的漏项）', () => {
    const set = enabled('wxid_peer', 'room@chatroom')
    expect(sessionHasAiReply({ type: 'private', username: 'wxid_peer' }, set)).toBe(true)
    expect(sessionHasAiReply({ type: 'group', username: 'room@chatroom' }, set)).toBe(true)
    // 用同一个判据数一遍：两个都算。
    const sessions = [
      { type: 'private' as const, username: 'wxid_peer' },
      { type: 'group' as const, username: 'room@chatroom' },
      { type: 'private' as const, username: 'wxid_other' },
    ]
    expect(sessions.filter((session) => sessionHasAiReply(session, set))).toHaveLength(2)
  })

  it('只开了单聊时群聊不算', () => {
    const set = enabled('wxid_peer')
    expect(sessionHasAiReply({ type: 'group', username: 'room@chatroom' }, set)).toBe(false)
  })

  it('username 不在集合里就不算，即使类型支持', () => {
    expect(sessionHasAiReply({ type: 'private', username: 'wxid_peer' }, enabled())).toBe(false)
    expect(sessionHasAiReply({ type: 'group', username: 'room@chatroom' }, enabled('other'))).toBe(false)
  })
})
