/**
 * 微信问答空态示例的纯逻辑判据。
 *
 * 用户看到的第一条必须来自本机真实会话，而不是固定的虚构人名；系统会话和
 * 公众号/服务号也不能被当成「最近聊过的人」。后两条固定校验「跟进 / 核对」
 * 两个真实场景仍在。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { buildAskExamples, isAskableSession } from './ask-examples.ts'

function session(over: Partial<WechatSession> = {}): WechatSession {
  return {
    username: 'wxid_default',
    displayName: '张三',
    type: 'private',
    lastTimestamp: 1,
    summary: '',
    unreadCount: 0,
    draft: '',
    pinned: false,
    hidden: false,
    ...over,
  }
}

describe('微信问答空态示例', () => {
  it('当前选中的范围优先于最近会话', () => {
    const cards = buildAskExamples([
      session({ username: 'wxid_new', displayName: '王五', lastTimestamp: 200 }),
      session({ username: 'wxid_scope', displayName: '赵六', lastTimestamp: 100 }),
    ], '赵六')

    expect(cards[0]?.question).toBe('最近和「赵六」聊了些什么？')
  })

  it('没有选中范围时取最近的真实会话', () => {
    const cards = buildAskExamples([
      session({ username: 'filehelper', displayName: '文件传输助手', lastTimestamp: 999 }),
      session({ username: 'gh_news', displayName: '某公众号', lastTimestamp: 998 }),
      session({ username: 'wxid_old', displayName: '李四', lastTimestamp: 100 }),
      session({ username: 'wxid_new', displayName: '王五', lastTimestamp: 200 }),
    ])

    expect(cards[0]?.question).toBe('最近和「王五」聊了些什么？')
  })

  it('最近会话是群聊时用群聊问法', () => {
    const cards = buildAskExamples([
      session({ username: '123@chatroom', displayName: '项目组', type: 'group', lastTimestamp: 200 }),
    ])

    expect(cards[0]?.question).toBe('最近「项目组」里聊了些什么？')
  })

  it('过滤公众号、服务号、客服号与系统会话', () => {
    expect(isAskableSession(session({ username: 'gh_official' }))).toBe(false)
    expect(isAskableSession(session({ accountKind: 'service' }))).toBe(false)
    expect(isAskableSession(session({ accountKind: 'kefu' }))).toBe(false)
    expect(isAskableSession(session({ displayName: '服务通知' }))).toBe(false)
    expect(isAskableSession(session())).toBe(true)
  })

  it('没有可用会话时给出可执行的活跃度问题', () => {
    const cards = buildAskExamples([])

    expect(cards[0]?.question).toBe('最近一周我和谁聊得最多？')
  })

  it('三张卡分别覆盖回顾、跟进、核对，且不再写死虚构人名', () => {
    const cards = buildAskExamples([])

    expect(cards.map(card => card.tag)).toEqual(['回顾对话', '跟进承诺', '核对转账'])
    expect(cards[1]?.question).toBe('最近谁说过要给我发资料？')
    expect(cards[2]?.question).toBe('最近谁给我转过账？')
    expect(cards.map(card => card.question).join(' ')).not.toContain('李四')
  })
})
