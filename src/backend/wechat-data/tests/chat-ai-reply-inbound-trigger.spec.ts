// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  contextualMessageText,
  isInboundReplyTrigger,
  messageDisplayText,
  visualKindOf,
} from '../src/query/ai-reply/inbound-trigger.ts'
import { anchorOf, cursorOf, latestInboundAfterCursor, latestVisibleMessage } from '../src/query/ai-reply/runner-recovery.ts'

const base = {
  localId: 1,
  sortSeq: 100,
  createTime: 1_700_000_000,
  isSender: 0,
}

describe('AI 回复入站触发矩阵', () => {
  it.each([
    ['quote', '[引用]'],
    ['image', '[图片]'],
    ['emoji', '[表情]'],
    ['sticker', '[表情]'],
    ['voice', '[语音]'],
    ['video', '[视频]'],
    ['file', '[文件]'],
    ['link', '[链接]'],
    ['miniapp', '[小程序]'],
    ['channels', '[视频号]'],
    ['live', '[直播]'],
    ['music', '[音乐]'],
    ['product', '[商品]'],
    ['card', '[卡片]'],
    ['note', '[笔记]'],
    ['announcement', '[群公告]'],
    ['solitaire', '[接龙]'],
    ['chatlog', '[聊天记录]'],
    ['transfer', '[转账]'],
    ['redpacket', '[红包]'],
    ['location', '[位置]'],
    ['contactCard', '[名片]'],
    ['voip', '[通话]'],
  ])('%s 消息即使没有 displayText 也可触发并生成稳定上下文', (renderType, expected) => {
    const message = { ...base, renderType }
    expect(messageDisplayText(message)).toBe(expected)
    expect(contextualMessageText(message)).toBe(expected)
    expect(isInboundReplyTrigger(message)).toBe(true)
  })

  it('文本消息使用正文作为上下文与触发依据', () => {
    const message = { ...base, renderType: 'text', displayText: '你好' }
    expect(messageDisplayText(message)).toBe('你好')
    expect(contextualMessageText(message)).toBe('你好')
    expect(isInboundReplyTrigger(message)).toBe(true)
  })

  it.each(['system', 'revoke', 'empty', 'unknown', 'unsupported', 'pat'])(
    '%s 不是可回复的对话事件',
    (renderType) => {
      const message = { ...base, renderType, displayText: '事件文本' }
      expect(contextualMessageText(message)).toBe('')
      expect(isInboundReplyTrigger(message)).toBe(false)
    },
  )

  it('自己的消息、空文本和没有类型依据的消息不会被当成触发锚点', () => {
    expect(isInboundReplyTrigger({ ...base, isSender: 1, displayText: '我发的' })).toBe(false)
    expect(isInboundReplyTrigger({ ...base, renderType: 'text' })).toBe(false)
    expect(isInboundReplyTrigger(base)).toBe(false)
  })

  it('表情锚点保留 [表情] 内容并推进到正确的 v2 游标', () => {
    const message = {
      ...base,
      type: 47,
      renderType: 'emoji',
      rich: {
        type: 'emoji',
        md5: '0123456789abcdef0123456789abcdef',
        emojiUrl: 'https://example.invalid/sticker.gif',
      },
    }
    const anchor = anchorOf(message)
    expect(anchor).toMatchObject({ localId: 1, content: '[表情]' })
    expect(cursorOf(anchor!)).toBe('v2:100:1')
    expect(visualKindOf(message)).toBe('sticker')
  })

  it('普通图片仍按视觉图片处理', () => {
    expect(visualKindOf({ ...base, type: 3 })).toBe('image')
    expect(visualKindOf({ ...base, renderType: 'image' })).toBe('image')
  })
})

describe('群聊：只有 @我 的消息才算入站触发', () => {
  it('mentionSelf 为 false 不触发；true 触发；单聊未注入时不限制', () => {
    const base = { localId: 1, sortSeq: 1, createTime: 1, isSender: 0, renderType: 'text', displayText: '大家好' }
    expect(isInboundReplyTrigger({ ...base, mentionSelf: false })).toBe(false)
    expect(isInboundReplyTrigger({ ...base, mentionSelf: true })).toBe(true)
    // 单聊不带该字段 ⇒ 行为与改版前一致
    expect(isInboundReplyTrigger(base)).toBe(true)
  })

  it('自己发的消息即使 @ 了自己也不算触发', () => {
    const base = { localId: 1, sortSeq: 1, createTime: 1, isSender: 1, renderType: 'text', displayText: '@我' }
    expect(isInboundReplyTrigger({ ...base, mentionSelf: true })).toBe(false)
  })

  it('群里其它消息不进「会话是否已推进」的判断：@我 之后有人闲聊不会作废这一轮', () => {
    const annotated = [
      { localId: 1, sortSeq: 100, createTime: 1000, isSender: 0, renderType: 'text', displayText: '历史', mentionSelf: false },
      { localId: 2, sortSeq: 200, createTime: 2000, isSender: 0, renderType: 'text', displayText: '@我 看一下报价', mentionSelf: true },
      { localId: 3, sortSeq: 300, createTime: 3000, isSender: 0, renderType: 'text', displayText: '哈哈', mentionSelf: false },
    ]
    // 最后一条可视消息仍是那条 @我（闲聊不参与），锚点也仍是它。
    expect(latestVisibleMessage(annotated)?.localId).toBe(2)
    expect(latestInboundAfterCursor(annotated, 'v2:100:1')?.localId).toBe(2)
  })

  it('群里最新一条只是闲聊时不会挑更早的 @ 来补答', () => {
    const annotated = [
      { localId: 2, sortSeq: 200, createTime: 2000, isSender: 0, renderType: 'text', displayText: '@我 报价多少', mentionSelf: true },
      { localId: 3, sortSeq: 300, createTime: 3000, isSender: 0, renderType: 'text', displayText: '我下周也去', mentionSelf: false },
    ]
    expect(latestInboundAfterCursor(annotated, 'v2:100:1')?.localId).toBe(2)
  })
})

describe('卡片类消息进上下文时补细节（界面 displayText 不变）', () => {
  it('转账：带金额与备注', () => {
    const message = {
      ...base,
      renderType: 'transfer',
      displayText: '[转账]',
      rich: { type: 'transfer', title: '￥100.00', desc: '房租' },
    }
    expect(messageDisplayText(message)).toBe('[转账]')
    expect(contextualMessageText(message)).toBe('[转账 ￥100.00] 房租')
  })

  it('红包：带金额与祝福语', () => {
    const message = {
      ...base,
      renderType: 'redPacket',
      displayText: '[红包]',
      rich: { type: 'redpacket', title: '微信红包', amount: '8.88', desc: '恭喜发财' },
    }
    expect(contextualMessageText(message)).toBe('[红包 8.88] 恭喜发财')
  })

  it('引用：同时保留被引用的原文与我的回复', () => {
    const message = {
      ...base,
      renderType: 'quote',
      displayText: '对，就这个',
      rich: { type: 'quote', title: '对，就这个', desc: '明天下午三点见', referName: 'a憨' },
    }
    expect(messageDisplayText(message)).toBe('对，就这个')
    expect(contextualMessageText(message)).toBe('[引用 a憨：明天下午三点见] 对，就这个')
  })

  it('视频：带时长', () => {
    const message = {
      ...base,
      renderType: 'video',
      displayText: '[视频]',
      rich: { type: 'video', durationSec: 12 },
    }
    expect(contextualMessageText(message)).toBe('[视频 12秒]')
  })

  it('语音：带时长（转写文本由上层追加在后面）', () => {
    const message = {
      ...base,
      renderType: 'voice',
      displayText: '[语音]',
      rich: { type: 'voice', durationMs: 4650 },
    }
    expect(contextualMessageText(message)).toBe('[语音 5秒]')
  })

  it('通话：区分语音/视频，并保留结局', () => {
    expect(contextualMessageText({
      ...base,
      renderType: 'voip',
      displayText: '[通话] 已拒绝',
      rich: { type: 'call', title: '已拒绝', status: '已拒绝', voipType: 'video', connected: false },
    })).toBe('[视频通话] 已拒绝')
  })

  it('位置：带地点名与地址', () => {
    const message = {
      ...base,
      renderType: 'location',
      rich: { type: 'location', title: '徐家汇公园', desc: '上海市徐汇区肇嘉浜路' },
    }
    expect(contextualMessageText(message)).toBe('[位置] 徐家汇公园（上海市徐汇区肇嘉浜路）')
  })
})
