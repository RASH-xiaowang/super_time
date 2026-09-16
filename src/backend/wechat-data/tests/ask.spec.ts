/**
 * AI Q&A retrieval scope: talker filter, inclusive date range, dedupe, and
 * the no-hit context message. search.ts is mocked; this module only formats.
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  searchIndexMessages: vi.fn(),
}))

vi.mock('../src/query/search.ts', () => ({
  searchIndexMessages: mocks.searchIndexMessages,
  // ask.ts 还会用到下面这三个导出。旧版 mock 只给了 searchIndexMessages，
  // 于是首次访问就抛 "No ... export is defined"，3 个用例在断言前就崩。
  // countIndexMatches 返回 -1 = 「索引不可用」，让 ask.ts 跳过 BM25 分支、
  // 走 like 兜底 —— 这正是这些用例想覆盖的格式化路径。
  countIndexMatches: () => -1,
  searchIndexBatch: () => ({ hits: [], ranked: false }),
  loadMessageWindow: () => [],
}))

import { buildAskContext, formatAskContext, type AskChunk } from '../src/query/ask.ts'

/** One minimal SearchHit. */
function hit(localId: number, createTime: number, name = '张三'): Record<string, unknown> {
  return {
    text: 'text',
    username: 'wxid_a',
    create_time: createTime,
    local_id: localId,
    name,
    time: '2026-09-01 10:00',
    snippet: '这是一条命中消息',
  }
}

describe('buildAskContext', () => {
  it('passes the talker scope to the index search', () => {
    mocks.searchIndexMessages.mockReturnValue({ hits: [hit(1, 0)], total: 1, indexed: true })
    const res = buildAskContext('/tmp/decrypted', '转账', undefined, { username: 'wxid_a' })
    expect(res.citations).toHaveLength(1)
    expect(mocks.searchIndexMessages).toHaveBeenCalledWith('/tmp/decrypted', '转账', expect.any(Number), 'wxid_a')
  })

  it('filters hits by an inclusive date range and drops unknown times', () => {
    const inside = hit(2, new Date('2026-09-01T12:00:00').getTime() / 1000)
    const before = hit(3, new Date('2026-08-31T12:00:00').getTime() / 1000)
    const after = hit(4, new Date('2026-09-03T12:00:00').getTime() / 1000)
    const unknown = hit(5, 0)
    mocks.searchIndexMessages.mockReturnValue({
      hits: [inside, before, after, unknown],
      total: 4,
      indexed: true,
    })
    const res = buildAskContext('/tmp/decrypted', '问题', undefined, {
      from: '2026-09-01',
      to: '2026-09-02',
    })
    expect(res.citations.map(c => c.local_id)).toEqual([2])
  })

  it('numbers citations and formats a no-hit message', () => {
    mocks.searchIndexMessages.mockReturnValue({ hits: [], total: 0, indexed: true })
    const empty = buildAskContext('/tmp/decrypted', '无结果问题')
    expect(empty.context).toContain('未检索到相关消息')
    expect(empty.citations).toEqual([])
  })
})

describe('formatAskContext：逐行日期（跨天窗口）', () => {
  /** 窗口压在午夜上：锚点在 09-02，前一条还在 09-01。 */
  const citation = { name: '李四', time: '2026-09-02 00:05', snippet: '今天的消息', username: 'wxid_lisi', local_id: 2 }
  const chunks: AskChunk[] = [{
    username: 'wxid_lisi', name: '李四', anchor: citation,
    lines: [
      { time: '23:58', day: '2026-09-01', sender: '', text: '前一天的消息' },
      { time: '00:05', day: '2026-09-02', sender: '', text: '今天的消息' },
    ],
    score: 1, pref: 0, createTime: 0,
  }]

  it('跨天的行带上自己的月-日，锚点当天不重复', () => {
    const out = formatAskContext([citation], { terms: ['消息'] }, chunks)
    expect(out).toContain('09-01 23:58')
    expect(out).toContain('    00:05')
    // 锚点当天的日期只在窗口头出现一次，行内不重复
    expect(out).not.toContain('09-02 00:05     ')
  })

  it('窗口头仍然给出锚点的完整日期与命中时间', () => {
    const out = formatAskContext([citation], {}, chunks)
    expect(out).toContain('（2026-09-02，命中时间 00:05）')
  })
})
