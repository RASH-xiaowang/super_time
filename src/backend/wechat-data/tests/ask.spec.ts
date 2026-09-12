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
}))

import { buildAskContext } from '../src/query/ask.ts'

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
