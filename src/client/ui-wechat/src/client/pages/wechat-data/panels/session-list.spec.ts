import { describe, expect, it } from 'vitest'
import type { WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { mergeSessionHead, sessionPreviewText, shouldShowEnterpriseBadge } from './session-list.ts'

function session(over: Partial<WechatSession> = {}): WechatSession {
  return {
    username: '123@chatroom',
    displayName: '测试群',
    type: 'group',
    lastTimestamp: 1,
    summary: '',
    unreadCount: 0,
    draft: '',
    pinned: false,
    hidden: false,
    ...over,
  }
}

describe('会话列表最后一条消息预览', () => {
  it('图片摘要为空时显示发送者与 [图片]', () => {
    expect(sessionPreviewText(session({
      lastMsgType: 3,
      lastMsgSender: 'wxid_sender',
      lastMsgSenderName: 'A😘梅子😘车贷13846245015',
    }))).toBe('A😘梅子😘车贷13846245015: [图片]')
  })

  it('语音、视频、文件等非文本类型都不会空白', () => {
    expect(sessionPreviewText(session({ type: 'private', lastMsgType: 34 }))).toBe('[语音]')
    expect(sessionPreviewText(session({ type: 'private', lastMsgType: 43 }))).toBe('[视频]')
    expect(sessionPreviewText(session({ type: 'private', lastMsgType: 49, lastMsgSubType: 6 }))).toBe('[文件]')
  })

  it('已有具体摘要时保留摘要，并给群聊补发送者', () => {
    expect(sessionPreviewText(session({
      summary: '丰田收集资料模版：这份是最终版',
      lastMsgSenderName: '郑州新侨-智能客服小侨',
      lastMsgType: 1,
    }))).toBe('郑州新侨-智能客服小侨: 丰田收集资料模版：这份是最终版')
  })

  it('summary 已带发送者前缀时不重复拼接', () => {
    expect(sessionPreviewText(session({
      summary: '张三: 明天十点开会',
      lastMsgSenderName: '张三',
      lastMsgType: 1,
    }))).toBe('张三: 明天十点开会')
  })

  it('自己发送的群消息显示“我”，XML 摘要降级为类型占位', () => {
    expect(sessionPreviewText(session({
      summary: '<?xml version="1.0"?><msg><img /></msg>',
      lastMsgType: 3,
      lastMsgSender: 'wxid_self',
      lastMsgSenderName: '本人',
    }), 'wxid_self')).toBe('我: [图片]')
  })

  it('草稿优先于空摘要的类型占位', () => {
    expect(sessionPreviewText(session({
      draft: '还没发的话',
      lastMsgType: 3,
      lastMsgSenderName: '张三',
    }))).toBe('[草稿] 还没发的话')
  })

  it('超大 local_type 的小程序值也能识别', () => {
    expect(sessionPreviewText(session({
      type: 'private',
      lastMsgType: 244135593199,
    }))).toBe('[小程序]')
  })
})

describe('企业微信徽标', () => {
  it('企业微信群聊不显示企微徽标，企业微信单聊仍显示', () => {
    expect(shouldShowEnterpriseBadge(session({ type: 'group' }), true)).toBe(false)
    expect(shouldShowEnterpriseBadge(session({ type: 'private' }), true)).toBe(true)
    expect(shouldShowEnterpriseBadge(session({ type: 'private' }), false)).toBe(false)
  })
})

describe('实时首页增量合并', () => {
  it('新会话插到正确位置，变化的旧行换成新对象，未变的行保持引用', () => {
    const oldA = session({ username: 'a', lastTimestamp: 10 })
    const oldB = session({ username: 'b', lastTimestamp: 20 })
    const oldC = session({ username: 'c', lastTimestamp: 30 })
    const freshC = session({ username: 'c', lastTimestamp: 40, summary: '新消息' })
    const newD = session({ username: 'd', lastTimestamp: 50 })

    const merged = mergeSessionHead([oldA, oldB, oldC], [newD, freshC])

    expect(merged.map((row) => row.username)).toEqual(['d', 'c', 'b', 'a'])
    expect(merged[1]).toBe(freshC)
    expect(merged[2], '未变化的行不应被复制成新对象').toBe(oldB)
    expect(merged[3]).toBe(oldA)
  })

  it('首页没有真实变化时返回原数组，避免 600 行整表重渲染', () => {
    const current = [
      session({ username: 'a', lastTimestamp: 20 }),
      session({ username: 'b', lastTimestamp: 10 }),
    ]
    const head = [{ ...current[0]! }]

    expect(mergeSessionHead(current, head)).toBe(current)
  })

  it('分页追加与首页刷新共用合并函数 ⇒ 同一 username 不重复、置顶始终优先', () => {
    const pinned = session({ username: 'pinned', pinned: true, lastTimestamp: 1 })
    const a = session({ username: 'a', lastTimestamp: 30 })
    const b = session({ username: 'b', lastTimestamp: 20 })
    const aFresh = session({ username: 'a', lastTimestamp: 40 })

    const merged = mergeSessionHead([b, a], [pinned, aFresh])

    expect(merged.map((row) => row.username)).toEqual(['pinned', 'a', 'b'])
    expect(merged.filter((row) => row.username === 'a')).toHaveLength(1)
  })
})
