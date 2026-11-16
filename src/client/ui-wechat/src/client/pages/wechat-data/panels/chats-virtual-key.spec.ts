// @vitest-environment jsdom
/**
 * 虚拟消息 key 的跨会话隔离与日期分隔稳定性。
 *
 * 这两个 key 一旦只按会话内属性生成，切换会话或向上插页就会把旧测量值套到新行上；
 * 界面不会抛错，只会出现大块空白、消息重叠，因此必须有行为级断言。
 */
import { describe, expect, it } from 'vitest'
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { estimateMsgItemHeight, msgItemKey, scopedMsgItemKey } from './chats-support.tsx'
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

    expect(before).toContain('day-s2:2:1700000000')
    expect(after).toContain('day-s2:2:1700000000')
  })

  /**
   * 真机数据：群 `17660437911@chatroom` 的 `message_0..N` 各自从 `local_id=1` 起编号。
   * 旧实现用 `day-${localId}` 给分隔项建 key，于是「第一条的日期分隔」和「最新一条的
   * 日期分隔」撞成同一个 key（都是 `day-1`）。React 按重复 key 复用节点，日期分隔
   * 「3月15日 20:05」会跟着留在后续打开的每个会话窗口里，虚拟测高也会串用。
   */
  it('跨分片同号消息：日期分隔与消息 key 都不撞', () => {
    const oldShard = { ...message(1, 1_773_576_341), sortSeq: 1_773_576_341_000 } as WechatMessage
    const newShard = { ...message(1, 1_794_735_994), sortSeq: 1_794_735_994_000 } as WechatMessage
    const items = buildMessageItems([oldShard, newShard])
    const dayKeys = items.filter((item) => item.kind === 'day').map((item) => item.key)
    expect(dayKeys.length, '两条消息相隔数月，都应触发日期分隔').toBe(2)
    expect(new Set(dayKeys).size, `日期分隔 key 撞了：${dayKeys.join(',')}`).toBe(2)
    const rowKeys = [oldShard, newShard].map((m) => msgItemKey({ kind: 'msg', m }))
    expect(new Set(rowKeys).size).toBe(2)
  })
})

describe('消息行高估算（估矮 ⇒ 绝对定位的行压到下一行上）', () => {
  it('自定义表情按贴图（≤130px）估算，不能当普通文本行', () => {
    const sticker = { kind: 'msg', m: { ...message(1, 1_700_000_000), renderType: 'sticker' } } as MessageRenderItem
    expect(estimateMsgItemHeight(sticker), '表情行估矮 100px ⇒ 挂载首帧压住下一行').toBeGreaterThanOrEqual(160)
  })

  it('旧渲染缓存（没有 renderType，只有 rich.type=sticker）也要按贴图估算', () => {
    const cached = { kind: 'msg', m: { ...message(1, 1_700_000_000), rich: { type: 'sticker' } } } as MessageRenderItem
    expect(estimateMsgItemHeight(cached)).toBeGreaterThanOrEqual(160)
  })

  it('图片/视频行按占位块（≤240px）估算，内置 emoji 仍按一行文本', () => {
    const image = { kind: 'msg', m: { ...message(1, 1_700_000_000), renderType: 'image' } } as MessageRenderItem
    const video = { kind: 'msg', m: { ...message(2, 1_700_000_000), renderType: 'video' } } as MessageRenderItem
    const emoji = { kind: 'msg', m: { ...message(3, 1_700_000_000), renderType: 'emoji' } } as MessageRenderItem
    expect(estimateMsgItemHeight(image)).toBeGreaterThanOrEqual(160)
    expect(estimateMsgItemHeight(video)).toBeGreaterThanOrEqual(160)
    expect(estimateMsgItemHeight(emoji), '内置 emoji 只是一行 26px 字，估成贴图会留大洞').toBeLessThan(100)
  })

  it('普通文本按长度分档；日期分隔比文本行矮', () => {
    const short = { kind: 'msg', m: { ...message(1, 1_700_000_000), renderType: 'text' } } as MessageRenderItem
    const long = { kind: 'msg', m: { ...message(2, 1_700_000_000), renderType: 'text', strContent: 'x'.repeat(500) } } as MessageRenderItem
    expect(estimateMsgItemHeight(short)).toBeGreaterThanOrEqual(60)
    expect(estimateMsgItemHeight(short)).toBeLessThan(100)
    expect(estimateMsgItemHeight(long)).toBeGreaterThan(estimateMsgItemHeight(short))
    expect(estimateMsgItemHeight({ kind: 'day', label: '9月26日', key: 'day-1' })).toBeLessThan(40)
  })
})
