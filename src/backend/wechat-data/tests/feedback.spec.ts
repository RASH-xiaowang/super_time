/**
 * H11 引入 typecheck 时暴露的真缺陷：反馈记录里的 `features` 是**字符串数组**
 * （RerankWeights 的键名），但读取端用 `safeJson`（对每项 `Number()` 再滤非有限值）
 * 去读，于是永远读回 `[]` —— `adaptWeights` 的循环一次都不执行，
 * 「点赞/点踩自动调权重」实际完全失效。
 *
 * 两条命题：
 *   ① `recordFeedback` → `listFeedback` 的往返必须保真（数字数组与字符串数组都要）；
 *   ② 有了 features，`adaptWeights` 必须真的动权重。
 * @vitest-environment node
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { adaptWeights, listFeedback, recordFeedback } from '../src/query/retrieval/feedback.ts'
import type { RerankWeights } from '../src/query/retrieval/types.ts'
import type { FeedbackRecord } from '../src/query/retrieval/types.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/**
 * 反馈库是「解密目录的兄弟文件」（`feedbackDbPath` = `join(retrievalRoot(decryptedDir), …)`），
 * 所以夹具必须是**嵌套**的：给每个用例一个独立的父目录，否则多个用例会共用同一个库文件。
 */
function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'rag-feedback-'))
  scratch.push(root)
  return join(root, 'decrypted')
}

const BASE: RerankWeights = {
  sparse: 1, dense: 1, entity: 1, coverage: 1, timePref: 1, recency: 1, agreement: 1,
} as RerankWeights

function record(overrides: Partial<FeedbackRecord> = {}): FeedbackRecord {
  return {
    id: 'r1',
    question: '上个月谁给我转过账',
    answer: '小何 [1]',
    rating: 'up',
    citedUseful: [1, 3],
    citedUseless: [2],
    intent: 'fact' as FeedbackRecord['intent'],
    features: ['entity', 'coverage'] as FeedbackRecord['features'],
    createdAt: 1700000000,
    ...overrides,
  }
}

describe('问答反馈：features 往返保真', () => {
  it('recordFeedback → listFeedback 不丢 features（字符串数组）', () => {
    const dir = tempDir()
    recordFeedback(dir, record())
    const [got] = listFeedback(dir, 10)
    // 回归：旧实现这里读回 []（safeJson 对 'entity' 做 Number → NaN → 被滤掉）
    expect(got.features).toEqual(['entity', 'coverage'])
    // 数字数组仍要正常
    expect(got.citedUseful).toEqual([1, 3])
    expect(got.citedUseless).toEqual([2])
    expect(got.intent).toBe('fact')
    expect(got.rating).toBe('up')
  })

  it('点赞/点踩会真的把对应特征权重调上去/调下来', () => {
    const dir = tempDir()
    recordFeedback(dir, record({ id: 'up', rating: 'up' }), 500)
    recordFeedback(dir, record({ id: 'down', rating: 'down' }), 500)
    const recs = listFeedback(dir, 10)
    expect(recs).toHaveLength(2)
    const adapted = adaptWeights(BASE, recs, 0.5)
    // 一上一下 → 抵消回原值；但如果 features 是空的，这里也「恰好」等于原值，所以
    // 关键是下一条：只留一条 up 时权重必须变大。
    expect(adapted.entity).toBeCloseTo(BASE.entity, 5)

    const dir2 = tempDir()
    recordFeedback(dir2, record({ id: 'only-up', rating: 'up' }), 500)
    const adapted2 = adaptWeights(BASE, listFeedback(dir2, 10), 0.5)
    expect(adapted2.entity).toBeGreaterThan(BASE.entity)
    expect(adapted2.coverage).toBeGreaterThan(BASE.coverage)
    // 未出现在 features 里的特征不动
    expect(adapted2.sparse).toBe(BASE.sparse)
  })
})
