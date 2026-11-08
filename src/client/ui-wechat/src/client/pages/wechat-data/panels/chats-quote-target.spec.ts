import { describe, expect, it } from 'vitest'
import type { MessageRich, WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { findQuotedTarget, quotedServerId } from './chats-quote-target.ts'

const message = (over: Partial<WechatMessage>): WechatMessage => ({
  localId: 1,
  sortSeq: 1,
  type: 1,
  isSender: 0,
  createTime: 1700000000,
  ...over,
} as WechatMessage)

const quote = (over: Partial<MessageRich>): MessageRich => ({
  type: 'quote',
  ...over,
})

describe('quoted message target', () => {
  it('uses server_id before same-second time candidates', () => {
    const wanted = message({ localId: 2, serverId: '9007199254740993' })
    const sameTime = message({ localId: 3 })

    expect(findQuotedTarget(
      [sameTime, wanted],
      quote({ referSvrId: '9007199254740993', referTime: 1700000000 }),
    )).toBe(wanted)
  })

  it('accepts a unique time match and rejects ambiguous same-second matches', () => {
    const unique = message({ localId: 4, createTime: 1700000010, displayText: '原消息' })
    expect(findQuotedTarget(
      [message({ localId: 5, createTime: 1700000011 }), unique],
      quote({ referTime: 1700000010 }),
    )).toBe(unique)

    const ambiguous = [
      message({ localId: 6, createTime: 1700000020, displayText: '甲' }),
      message({ localId: 7, createTime: 1700000020, displayText: '乙' }),
    ]
    expect(findQuotedTarget(
      ambiguous,
      quote({ referTime: 1700000020, desc: '不存在' }),
    )).toBeUndefined()
  })

  it('uses quoted text to disambiguate messages sharing a create_time', () => {
    const wanted = message({ localId: 8, createTime: 1700000030, displayText: '需要定位的完整原文' })
    const other = message({ localId: 9, createTime: 1700000030, displayText: '另一条消息' })

    expect(findQuotedTarget(
      [other, wanted],
      quote({ referTime: 1700000030, desc: '需要定位的完整原文' }),
    )).toBe(wanted)
  })

  it('treats server_id zero as absent', () => {
    expect(quotedServerId(quote({ referSvrId: '0' }))).toBe('')
    expect(quotedServerId(quote({ referSvrId: ' 123 ' }))).toBe('123')
  })
})
