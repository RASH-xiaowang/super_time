// @vitest-environment jsdom
/**
 * 虚拟消息 key 的跨会话隔离与日期分隔稳定性。
 *
 * 这两个 key 一旦只按会话内属性生成，切换会话或向上插页就会把旧测量值套到新行上；
 * 界面不会抛错，只会出现大块空白、消息重叠，因此必须有行为级断言。
 */
import { describe, expect, it } from 'vitest'
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { scopedMsgItemKey } from './chats-support.tsx'
import { buildMessageItems, type MessageRenderItem } from '../utils/message-items.ts'

function message(localId: number, createTime: number, serverId?: string): WechatMessage {
  return {
    localId,
    sortSeq: localId,
    ...(serverId ? { serverId } : {}),
    type: 1,
    isSender: 0,
    createTime,
    strContent: `消息 ${String(localId)}`,
    displayText: `消息 ${String(localId)}`,
  } as WechatMessage
}

describe('消息虚拟列表 key', () => {
  it('相同 localId 在不同会话/打开代次下不能撞 key', () => {
    const item: MessageRenderItem = { kind: 'msg', m: message(42, 1_700_000_000) }
    const sessionA = scopedMsgItemKey('wxid_a\u00001', item)
    const sessionB = scopedMsgItemKey('wxid_b\u00001', item)
    const reopenedA = scopedMsgItemKey('wxid_a\u00002', item)
    expect(sessionA).toBe(scopedMsgItemKey('wxid_a\u00001', item))
    expect(new Set([sessionA, sessionB, reopenedA]).size).toBe(3)
  })

  it('keeps reused local ids separate by server id', () => {
    const oldVoice: MessageRenderItem = { kind: 'msg', m: message(42, 1_600_000_000, '111') }
    const newVoice: MessageRenderItem = { kind: 'msg', m: message(42, 1_700_000_000, '222') }
    expect(scopedMsgItemKey('wxid_a\u00001', oldVoice)).not.toBe(scopedMsgItemKey('wxid_a\u00001', newVoice))
  })

  it('向上加载历史后，日期分隔 key 不随数组下标漂移', () => {
    const latest = message(2, 1_700_000_000)
    const next = message(3, 1_700_000_401)
    const before = buildMessageItems([latest, next])
      .filter((item): item is Extract<MessageRenderItem, { kind: 'day' }> => item.kind === 'day')
      .map(item => item.key)

    const older = message(1, 1_699_999_500)
    const after = buildMessageItems([older, latest, next])
      .filter((item): item is Extract<MessageRenderItem, { kind: 'day' }> => item.kind === 'day')
      .map(item => item.key)

    expect(before).toContain('day-2')
    expect(after).toContain('day-2')
  })
})
