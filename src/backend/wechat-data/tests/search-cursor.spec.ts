/**
 * 全文兜底搜索的游标语义与「让出预算」的计量口径（N9 / N36）。
 *
  * 2026-09-24 从 `search-cursor.spec.ts` 拆出来：N36 ① 的判据是**单个文件**里那段同步不让出的时间
 * （CI 那条假红的线是 vitest 硬编码的 60 秒 RPC 超时），而这个文件里两条重夹具用例占了它自身耗时的 92%
 * —— 一份文件装着四个互不相干的命题，榜首就永远是它。拆开不减少总工作量，减的是**单文件的累计**，
 * 正是 `vitest.config.ts` 里记着的那条机制。造数据的夹具两边共用（`search-spec-fixtures.ts`），
 * 不复制一份 —— 复制会让「同一句 FTS 成本没被低估」有两种含义。
 * 
 * 本文件管：① 兜底搜索 `iterate` 与 `all` 的命中集合一致 + RSS；② 让出预算覆盖「被跳过的行」与「批量写入」。
 * @vitest-environment node
 */

import { describe, expect, it, vi } from 'vitest'
import { createPhaseLog } from '../../tests/helpers/phase-log.ts'
import { buildSearchIndex, searchIndexMessages } from '../src/query/search.ts'
import { TERM, assertHighEntropy, buildWithTickProbe, cjkRows, makeFixture, makeRawFixture, trackScratch } from './search-spec-fixtures.ts'

/**
 * 本文件是「重夹具」文件：建真索引 + FTS 写 CJK，CI 的 runner 比本机慢约 24 倍
 * （2026-09-20 实测：整批用例耗时 2658s vs 本机 109s），全局 180s 档位装不下它 ——
 * 4 条夹具最大的用例在 runner 上超时。这里单独抬到 420s（作业级预算见 ci.yml）。
 */
vi.setConfig({ testTimeout: 420_000, hookTimeout: 420_000 })

trackScratch('search-index-build')

describe('全文兜底搜索：iterate 与 all 的命中集合一致', () => {
  it('返回全部命中，且 local_id 与插入顺序一致', () => {
    const decrypted = makeFixture(300, 3)
    const r = searchIndexMessages(decrypted, TERM, 100)
    expect(r.hits.map(h => h.local_id)).toEqual([1, 2, 3])
    // 未命中任何关键词时不返回内容
    expect(r.hits.every(h => h.text.includes(TERM))).toBe(true)
  })

  it('容量上限生效：命中数超过 cap 时只返回 cap 条', () => {
    const decrypted = makeFixture(50, 20)
    const r = searchIndexMessages(decrypted, TERM, 5)
    expect(r.hits.length).toBe(5)
  })

  it('跨过让出阈值后（>2000 行）结果依然完整', () => {
    // 顺带确认：迭代中途 await 让出后，迭代器状态仍然正确（不丢行、不重复）。
    // 注意 searchIndexMessages 本身是同步函数，这里**不走**让出路径；
    // 让出发生在 buildSearchIndex 里，另有用例覆盖。
    const decrypted = makeFixture(2500, 4)
    const r = searchIndexMessages(decrypted, TERM, 100)
    expect(r.hits.map(h => h.local_id)).toEqual([1, 2, 3, 4])
  })
})

describe('让出预算覆盖「被跳过的行」与「批量写入」', () => {
  it('无可读文本的行也计入让出预算（图片/系统消息成片时不至于一次不让出）', async () => {
    // 这些行 readableMessageText() 会返回空串、被 continue 跳过；但它们同样付了
    // zstd 解压+解码成本。计量放在 continue 之前才不会被成片的无文本行绕过。
    const bodies = Array.from({ length: 2500 }, () =>
      `<msg><appmsg><img aeskey="${'a'.repeat(1000)}"/></appmsg></msg>`)
    const decrypted = makeRawFixture(bodies)
    const { ticks } = await buildWithTickProbe(decrypted)
    expect(ticks).toBeGreaterThan(0)
  })

  it('长行下批量写入受字符上界约束，单块不破秒', async () => {
    // 700 行 × 约 2.1 万汉字/行（≈63KB/行）。若批量写入不受字符上界约束，攒到 500 行的
    // 那次 flush 会一次性插入 1000 万+ 汉字，实测单块 550ms（叠上收尾后整块 902ms）；
    // 有了字符上界，同一夹具下循环内单块实测 32ms。
    // 正文必须高熵：`'震'.repeat(n)` 这类重复串只有极少数 distinct bigram，
    // FTS 插入成本会低到看不出差别（会得到假绿，实测过）。这条性质现在由 assertHighEntropy 断住。
    const ph = createPhaseLog('search-cursor｜长行批量写入')
    const bodies = cjkRows(21000, 700)
    ph.mark('造正文')
    assertHighEntropy(bodies[0] ?? '', '首行')
    assertHighEntropy(bodies[bodies.length - 1] ?? '', '末行')
    ph.mark('熵断言')
    const decrypted = makeRawFixture(bodies)
    ph.mark('落夹具')
    const { maxGapMs, ticks } = await buildWithTickProbe(decrypted)
    ph.mark('建索引+探针')
    ph.report()
    // 探针自己也在花时间：它每轮 `setImmediate` 都往数组里 push 一个数。
    // 把这个数打出来是为了下次有人说「减点行数不就快了」时，能分清
    // 「慢在建索引」与「慢在我们为了量它而插进去的表」。
    console.log(`[算料|search-cursor] 正文 ${String(bodies.length)} 行 × 21000 字 = ${String(Math.round(bodies.reduce((a, r) => a + r.length, 0) / 1024 / 1024))}MB；探针 ticks=${String(ticks)}`)
    /**
     * 钉的是**契约**：「建索引不再产生秒级事件循环阻塞」（原文见 `search-cursor.spec.ts`
     * 顶部的验收口径）。本机实测循环内单块 32ms，所以原来写 300ms —— 但那是**本机的墙钟**，
     * 不是代码的性质：2026-09-20 GitHub 的 windows runner 上同一夹具量到 444ms，
     * 于是这条断言把「runner 慢」误报成「回归」。
     * 取 900ms：既给共享 runner 的调度抖动留足余地，又仍能抓住原始缺陷
     * （改前实测单块 550ms、叠上收尾 902ms，也正是要拦的量级）。
     */
    expect(maxGapMs, `单块最长阻塞 ${maxGapMs}ms`).toBeLessThan(900)
  })
})

