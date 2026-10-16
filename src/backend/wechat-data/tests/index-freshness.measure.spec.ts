/**
 * W2-6.4 观测基线 · 检索索引保鲜：落后多少条时，「提问时同步等」开始不可接受（合成数据）。**不是回归用例**，靠 `MEASURE_INDEX_FRESH=1` 门控。
 *
 * ## 它要回答的问题
 *
 * 6.4 说「分片签名变化超阈值后台重建 + 界面提示」。**阈值定在哪，不能靠猜**：
 * 现在 `ensureSearchIndex` 在提问路径里**同步等**，所以代价全部落在用户这一问上。
 * 于是要量两段：
 *   ① 保鲜探测本身（`getSearchIndexFreshness`：每个分片一次 `statSync`）—— 它决定「能不能常驻轮询」；
 *   ② 增量同步的耗时随**新增条数**怎么长 —— 它决定「同步等」在哪一档开始变成用户可感知的停顿。
 *
 * 合成夹具刻意只留**一个**分片（`message_0.db`）：本条要量的是「新增多少条」的曲线，
 * 不是「分片有多少个」的曲线（后者是 2.3 那条的事）。分片数对探测成本的影响单独用
 * `MEASURE_FRESH_SHARDS` 覆盖。
 *
 * 运行：
 *   MEASURE_INDEX_FRESH=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/index-freshness.measure.spec.ts
 *   初始条数用 FRESH_BASE 覆盖（默认 20000），探测的分片数用 FRESH_SHARDS 覆盖（默认 1）。
 *
 * 档位：quick（登记在 `scripts/run-measures.mjs`；本行由 measures-registry 逐条核对，
 *   改了 runner 里的 tier 而不同步这里 ⇒ 红）。
 *   选档依据是**实测耗时**，不是「哪个更重要」：本条实测秒级（远低于单测时长，可进 PR 门禁）。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { utimesSync } from 'node:fs'
import { join } from 'node:path'
import { appendMessages, makeFixture, trackScratch } from './search-spec-fixtures.ts'
import { closeAllTrackedDbs } from '../../tests/helpers/temp-db.ts'
import { buildSearchIndex, ensureSearchIndex, getSearchIndexFreshness, REFRESH_SLACK_MS } from '../src/query/search.ts'

trackScratch('index-freshness')

describe.skipIf(process.env.MEASURE_INDEX_FRESH !== '1')('W2：索引保鲜 同步等的代价随新增条数怎么长', () => {
  it('探测成本 + 同步成本（新增 0/10/100/1000/5000 条）', { timeout: 300_000 }, async () => {
    const BASE = Math.max(100, Number(process.env.FRESH_BASE ?? '20000'))
    const ADDED = [0, 10, 100, 1000, 5000]
    const rows: string[] = []
    let nextId = BASE + 1
    for (const add of ADDED) {
      const decrypted = makeFixture(BASE, 0)
      await buildSearchIndex(decrypted, false)
      if (add > 0) {
        appendMessages(decrypted, nextId, nextId + add - 1)
        // 把分片 mtime 推到「索引刷新时刻 + 容差」之后：追加完立刻同步是**不会**被
        // 判成过期的（REFRESH_SLACK_MS 的存在意义就是容许这个边界），而本条量的是
        // 「已经过了一段时间、微信又写了一批」之后的那次同步 —— 真实场景就是这个样子。
        const shard = join(decrypted, 'message', 'message_0.db')
        const ahead = Date.now() + REFRESH_SLACK_MS + 1000
        utimesSync(shard, ahead / 1000, ahead / 1000)
      }
      nextId += add

      // ① 探测（不含建库）：重复 5 次取平均 —— 它很小，单次读数会被噪声吃掉。
      const probeTimes: number[] = []
      for (let i = 0; i < 5; i += 1) {
        const t0 = Number(process.hrtime.bigint()) / 1e6
        getSearchIndexFreshness(decrypted)
        probeTimes.push(Number(process.hrtime.bigint()) / 1e6 - t0)
      }
      const probeMs = probeTimes.reduce((a, b) => a + b, 0) / probeTimes.length

      // ② 同步（这就是用户这一问要等的时间）。
      const t1 = Number(process.hrtime.bigint()) / 1e6
      const ensured = await ensureSearchIndex(decrypted)
      const syncMs = Number(process.hrtime.bigint()) / 1e6 - t1
      closeAllTrackedDbs()

      expect(ensured.action, add === 0 ? '一条没新增时不该做动作' : `新增 ${String(add)} 条时应当走同步`).toBe(add === 0 ? 'none' : 'sync')
      expect(ensured.added ?? 0, `新增 ${String(add)} 条时入索引条数不对`).toBe(add)
      rows.push(`  新增 ${String(add).padStart(5)} 条  同步 ${syncMs.toFixed(1).padStart(8)}ms（${(syncMs / Math.max(add, 1) * 1000).toFixed(1)} µs/条）  探测 ${probeMs.toFixed(3)}ms`)
    }
    console.log([
      '',
      `[INDEX-FRESH] 初始 ${String(BASE)} 条 · 单分片`,
      ...rows,
      '',
    ].join('\n'))
  })
})