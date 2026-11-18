// @vitest-environment node
/**
 * 「自己的消息不算会话推进」的判据。
 *
 * 现场故障：群聊长回复被拆成 6 段，第 1 段发出后会以本机身份回到会话里
 * （发送端还在前面拼了 `@提及`）。恢复扫描若把它当成「会话已推进」，
 * 剩下 5 段会被整组判成过期 —— 症状就是「只发了第一段」。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  conversationProgressedAfter,
  isOwnSentSegment,
  ownSentSegmentsOf,
} from '../src/query/ai-reply/runner-recovery.ts'
import type { ChatAiReplyScanDeps, ChatAiReplyScanMessage } from '../src/query/ai-reply/types.ts'

const anchor = { localId: 2, sortSeq: 200, createTime: 2000, content: '再来一首' }

function selfMessage(text: string, localId = 3): ChatAiReplyScanMessage {
  return { localId, sortSeq: 300, createTime: 3000, isSender: 1, renderType: 'text', displayText: text }
}

function peerMessage(text: string, localId = 4): ChatAiReplyScanMessage {
  return { localId, sortSeq: 400, createTime: 4000, isSender: 0, renderType: 'text', displayText: text }
}

describe('isOwnSentSegment', () => {
  it('库里的文本包含我们发出去的那一段 ⇒ 视为自己的消息', () => {
    expect(isOwnSentSegment(
      selfMessage('@张三 第一段正文'),
      new Set(['第一段正文']),
    )).toBe(true)
  })

  it('换行/多余空格的差异不影响判定', () => {
    expect(isOwnSentSegment(
      selfMessage('@张三   第一段\n正文'),
      new Set(['第一段 正文']),
    )).toBe(true)
  })

  it('对方的消息永远不算「自己发的」', () => {
    expect(isOwnSentSegment(
      peerMessage('第一段正文'),
      new Set(['第一段正文']),
    )).toBe(false)
  })

  it('人工从手机回复的内容不会命中任何已发分段', () => {
    expect(isOwnSentSegment(
      selfMessage('我自己回一句'),
      new Set(['第一段正文']),
    )).toBe(false)
  })

  it('没有可忽略项时一律按普通消息处理', () => {
    expect(isOwnSentSegment(selfMessage('第一段正文'), undefined)).toBe(false)
    expect(isOwnSentSegment(selfMessage('第一段正文'), new Set())).toBe(false)
  })
})

describe('conversationProgressedAfter 排除已发分段', () => {
  const state = { accountKey: 'wxid_self', chatUsername: 'room@chatroom', chatName: '测试群' } as never

  it('窗口里只有本批次已发的分段 ⇒ 不算推进', async () => {
    const deps = { listMessages: async () => [] } as unknown as ChatAiReplyScanDeps
    expect(await conversationProgressedAfter(
      deps,
      state,
      anchor,
      [selfMessage('@张三 第一段正文')],
      new Set(['第一段正文']),
    )).toBe(false)
  })

  it('对方发了新消息 ⇒ 仍然判为推进（继续回复别的答案没有意义）', async () => {
    const deps = { listMessages: async () => [] } as unknown as ChatAiReplyScanDeps
    expect(await conversationProgressedAfter(
      deps,
      state,
      anchor,
      [selfMessage('@张三 第一段正文'), peerMessage('算了别发了')],
      new Set(['第一段正文']),
    )).toBe(true)
  })

  it('人工插话（自己发的、但不是本批次的分段）⇒ 仍然判为推进', async () => {
    const deps = { listMessages: async () => [] } as unknown as ChatAiReplyScanDeps
    expect(await conversationProgressedAfter(
      deps,
      state,
      anchor,
      [selfMessage('我来说一句')],
      new Set(['第一段正文']),
    )).toBe(true)
  })

  it('不传忽略集合时保持改版前的严格口径', async () => {
    const deps = { listMessages: async () => [] } as unknown as ChatAiReplyScanDeps
    expect(await conversationProgressedAfter(
      deps,
      state,
      anchor,
      [selfMessage('@张三 第一段正文')],
    )).toBe(true)
  })
})

describe('ownSentSegmentsOf', () => {
  it('只收集已发出（success/queued/running）的分段正文', async () => {
    const listReplySegments = vi.fn(async () => [
      { id: 1, segmentIndex: 1, text: '第一段', status: 'success' },
      { id: 2, segmentIndex: 2, text: '第二段', status: 'pending' },
      { id: 3, segmentIndex: 3, text: '第三段', status: 'queued' },
    ])
    const deps = { listReplySegments } as unknown as ChatAiReplyScanDeps
    const own = await ownSentSegmentsOf(deps, 'ai-reply:wxid_self:room@chatroom:2000:2:segment:2')
    expect([...own]).toEqual(['第一段', '第三段'])
    // 段号后缀要归一到基础键，否则读不到整组。
    expect(listReplySegments).toHaveBeenCalledWith('ai-reply:wxid_self:room@chatroom:2000:2')
  })

  it('读不到时返回空集（退回严格口径，不静默放过）', async () => {
    const deps = {
      listReplySegments: async () => { throw new Error('busy') },
    } as unknown as ChatAiReplyScanDeps
    expect((await ownSentSegmentsOf(deps, 'ai-reply:a:b:1:1')).size).toBe(0)
    expect((await ownSentSegmentsOf({} as ChatAiReplyScanDeps, 'ai-reply:a:b:1:1')).size).toBe(0)
    expect((await ownSentSegmentsOf({} as ChatAiReplyScanDeps, undefined)).size).toBe(0)
  })
})
