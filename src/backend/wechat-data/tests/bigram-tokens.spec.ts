/**
 * `bigramTokens` 的**行为锁** —— 中文检索的分词口径，改它等于改索引。
 *
 * ## 为什么单独立一份
 *
 * 这个函数被两处生产代码共用（`search-build.ts` 建索引、`kb-search.ts` 查索引），
 * 还有一份 `ftsPhrase` 走同一个切法。它的输出一旦变，**已经建好的索引与新的查询词就不再对得上**
 * —— 症状是「搜得到昨天搜不到今天」这种按时间分裂的怪现象，而不是任何一条报错。
 * 所以要动它之前，先要有一份能钉死输出的用例；这份用例的**参照实现是冻结的旧算法**，
 * 新实现必须与它在任意输入上逐字相同。
 *
 * ## 参照实现会不会自己漂掉
 *
 * 会 —— 如果有人把 {@link reference} 也一起改了，这条差分测试就成了自己跟自己比。
 * 所以另外还有一组**枚举出来的期望值**（下面那批 `toBe('微信 信转 …')`），
 * 它们不依赖任何实现，改坏了口径会立刻红。
 *
 * @module wechat-data/tests/bigram-tokens
 */
import { describe, expect, it } from 'vitest'

import { bigramTokens } from '../src/query/search-scaffold.ts'
import { at } from '../../tests/helpers/strict-index.ts'

/** **冻结的旧算法**（2026-09-24 从生产代码逐字拷来）。改这里 = 让差分测试失效，不许。 */
function reference (text: string): string {
  const out: string[] = []
  for (const run of String(text || '').match(/[\u4e00-\u9fff]+|[A-Za-z0-9_]+/g) ?? []) {
    if (/^[A-Za-z0-9_]+$/.test(run)) {
      out.push(run.toLowerCase())
      continue
    }
    if (run.length === 1) { out.push(run); continue }
    for (let i = 0; i + 2 <= run.length; i += 1) out.push(run.slice(i, i + 2))
  }
  return out.join(' ')
}

const ALPHABET = ['微', '信', '转', '账', 'a', 'B', '9', '_', '，', ' ', '👍', 'AB', '微信']
/** 定长种子序列 —— 不用 `Math.random`：随机语料今天过了不代表明天还测到同一件事。 */
function corpus (): string[] {
  const out: string[] = ['', ' ', '微信', 'AB12', 'a', '👍', '微信，转账', '___', '9_9', '微信a账']
  let s = 20260924
  for (let i = 0; i < 400; i += 1) {
    let text = ''
    const n = 1 + (i % 7)
    for (let k = 0; k < n; k += 1) {
      s = (s * 1103515245 + 12345) % 2147483648
      text += at(ALPHABET, s % ALPHABET.length, '字母表')
    }
    out.push(text)
  }
  return out
}

const CASES = corpus()

describe('bigramTokens：中文 bigram 的切法是要被锁住的口径（两处生产代码共用）', () => {
  it('枚举出来的期望值 —— 不依赖任何实现，改坏了立刻红', () => {
    expect(bigramTokens('微信转账收到转账')).toBe('微信 信转 转账 账收 收到 到转 转账')
    expect(bigramTokens('微信')).toBe('微信')
    expect(bigramTokens('微'), '单字没有 bigram ⇒ 原样留一个（否则单字消息永远搜不到）').toBe('微')
    expect(bigramTokens('AB12'), '拉丁/数字/下划线整词小写，不切 bigram').toBe('ab12')
    expect(bigramTokens('a_b9')).toBe('a_b9')
    expect(bigramTokens('微信，转账'), '标点不是 CJK 也不是词 ⇒ 断开两个 run，不产出跨标点的 bigram').toBe('微信 转账')
    expect(bigramTokens('')).toBe('')
    expect(bigramTokens('   ')).toBe('')
  })

  it('非字符串也要照旧（生产代码里 `text` 有可能是一个数或 null）', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(bigramTokens(null as any)).toBe('')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(bigramTokens(undefined as any)).toBe('')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(bigramTokens(0 as any), '0 走 `text || ""` 这一支 —— 是既成行为，改它要先想清楚调用方').toBe('')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(bigramTokens(12 as any)).toBe('12')
  })

  it('语料够大且多样（差分测试不能是空跑的）', () => {
    const multi = CASES.filter((c) => /[\u4e00-\u9fff]/.test(c) && /[A-Za-z0-9_]/.test(c))
    expect(CASES.length).toBeGreaterThanOrEqual(400)
    expect(new Set(CASES).size, '语料几乎全是重复串的话，差分等于没做').toBeGreaterThan(100)
    expect(multi.length, '没有「CJK 与拉丁混排」的样本就测不到跨 run 的空格拼接').toBeGreaterThan(10)
  })

  it('与冻结的旧算法逐字相同（任何输入、包括表情符号与代理对）', () => {
    const bad = CASES.filter((c) => bigramTokens(c) !== reference(c))
    expect(bad.slice(0, 3).map((c) => JSON.stringify(c) + ' ⇒ ' + JSON.stringify(bigramTokens(c)) + ' vs ' + JSON.stringify(reference(c))).join('\n'),
      '切法变了：已建好的索引与新查询词会对不上').toBe('')
  })

  it('表情符号一律丢弃（今天的口径；留着是为了改的时候有人被红提醒）', () => {
    expect(bigramTokens('转账👍微信'), '代理对既不在 \\u4e00-\\u9fff 也不是拉丁 ⇒ 整段被丢掉').toBe('转账 微信')
    expect(bigramTokens('👍')).toBe('')
  })
})
