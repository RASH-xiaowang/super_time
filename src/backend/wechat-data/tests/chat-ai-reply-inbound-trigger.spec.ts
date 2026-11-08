// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  contextualMessageText,
  isInboundReplyTrigger,
  messageDisplayText,
  visualKindOf,
} from '../src/query/ai-reply/inbound-trigger.ts'
import { anchorOf, cursorOf } from '../src/query/ai-reply/runner-recovery.ts'

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
