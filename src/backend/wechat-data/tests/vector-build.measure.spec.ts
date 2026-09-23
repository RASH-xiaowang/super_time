/**
 * M10 的性能实测（不是回归用例，但文件名必须保留 *.spec.ts —— vitest 只收集这个后缀）。
 * 靠 `describe.skipIf(MEASURE_M10 !== '1')` 默认跳过。
 *
 * 为什么需要它：验收标准是「建库耗时有量化改善，期间后端可响应其他查询」——
 * 前者要数字，后者要**事件循环最长阻塞**的实测。两者都受机器负载影响，不适合做 CI 门禁。
 * 确定性的那部分（去重扇出、并发上限、失败不半写）由 `vector-build.spec.ts` 在 CI 里守。
 *
 * 运行：
 *   MEASURE_M10=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/vector-build.measure.spec.ts
 *   MEASURE_M10=1 MEASURE_M10_DOCS=8000 MEASURE_M10_LATENCY=40 ...（可调规模与单次延迟）
 *
 * 方法：桩 embedding 带**固定延迟**（模拟远端往返）。
 *   · 旧实现的墙钟 = 请求数 × 单次延迟（它严格串行，所以可以直接建模）；
 *   · 新实现的墙钟 = 实测（去重 + 有界并发一起生效）。
 * 这样两个数都来自同一次运行、同一个桩，可比。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { buildVectorIndex } from '../src/query/retrieval/embedding.ts'

describe.skipIf(process.env.MEASURE_M10 !== '1')('M10 建库实测', () => {
  it('去重 + 有界并发：请求数与墙钟对比（含事件循环最长阻塞）', async () => {
    const DOCS = Number(process.env.MEASURE_M10_DOCS ?? '4000')
    const LATENCY = Number(process.env.MEASURE_M10_LATENCY ?? '40')
    const BATCH = Number(process.env.MEASURE_M10_BATCH ?? '16')
    const CONC = Number(process.env.MEASURE_M10_CONCURRENCY ?? '4')
    // 真实数据的重复率是 56.5%，这里按同样比例造：另外 43.5% 各自唯一
    const DUPLICATE_RATE = Number(process.env.MEASURE_M10_DUP ?? '0.565')

    const dir = mkdtempSync(join(tmpdir(), 'wx-m10-measure-'))
    const dec = join(dir, 'decrypted')
    mkdirSync(dec, { recursive: true })
    const db = new DatabaseSync(join(dir, 'wechat_search.db'))
    db.exec('CREATE TABLE message_meta (rowid INTEGER PRIMARY KEY, text TEXT, username TEXT, local_id INTEGER, create_time INTEGER)')
    const ins = db.prepare('INSERT INTO message_meta VALUES (?,?,?,?,?)')
    const uniqueCount = Math.max(1, Math.round(DOCS * (1 - DUPLICATE_RATE)))
    // 其中一部分行是**同一个**热门文本（复读率极高的情形：群里的「收到」「好的」），
    // 用来把「扇出突发写」的最坏情况也量进去（MEASURE_M10_HOT 可调比例）。
    const hot = Math.round(DOCS * Number(process.env.MEASURE_M10_HOT ?? '0.3'))
    let uniq = 0
    db.exec('BEGIN')
    for (let i = 0; i < DOCS; i += 1) {
      const text = i < hot
        ? '收到'
        : (i < hot + uniqueCount ? '唯一文本 ' + String(i) + ' ' + 'x'.repeat(i % 40) : '复读文本 ' + String(i % 5))
      ins.run(i + 1, text, 'wxid_a', i + 1, 1700000000 + i)
      if (i >= hot && i < hot + uniqueCount) uniq += 1
    }
    db.exec('COMMIT')
    db.close()

    const embed = async (texts: string[]): Promise<number[][]> => {
      await new Promise((r) => setTimeout(r, LATENCY))
      return texts.map((t) => {
        const v = [0, 0, 0, 0, 0, 0, 0, 0]
        for (let i = 0; i < t.length; i += 1) { const k = i % 8; v[k] = (v[k] ?? 0) + t.charCodeAt(i) % 7 }
        return v
      })
    }

    // 事件循环最长阻塞采样（5ms 一跳）
    let last = Number(process.hrtime.bigint()) / 1e6
    let maxStall = 0
    const timer = setInterval(() => {
      const now = Number(process.hrtime.bigint()) / 1e6
      maxStall = Math.max(maxStall, now - last - 5)
      last = now
    }, 5)

    const t0 = Date.now()
    let r
    try {
      r = await buildVectorIndex(dec, embed, {
        model: 'stub', batchSize: BATCH, maxCharsPerDoc: 200, maxDocsPerBuild: DOCS, concurrency: CONC,
      })
    } finally {
      clearInterval(timer)
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    const elapsed = Date.now() - t0

    // 实际唯一文本数：热门文本 1 个 + 唯一池里的（受 DOCS-hot 截断）+ 尾部的 i%5
    // （复审指出原来的 `uniqueCount + 5` 在 DOCS < hot + uniqueCount 时会算错）
    const uniqueRows = Math.max(0, Math.min(uniqueCount, DOCS - hot))
    const tailRows = Math.max(0, DOCS - hot - uniqueRows)
    const distinct = (hot > 0 ? 1 : 0) + uniqueRows + Math.min(5, tailRows)
    const oldCalls = Math.ceil(DOCS / BATCH)
    const newCalls = r.embed_calls
    const oldWall = oldCalls * LATENCY
    const expectedNew = Math.ceil(Math.min(distinct, DOCS) / BATCH / CONC) * LATENCY

    console.log(`\nM10 建库实测：${DOCS} 行（实际 ${distinct} 个不同文本，重复率 ${(((DOCS - distinct) / DOCS) * 100).toFixed(1)}%），单次延迟 ${LATENCY}ms，batchSize=${BATCH}，concurrency=${CONC}`)
    console.log(`  embed 请求数：旧 ${oldCalls} 次（串行）  →  新 ${newCalls} 次（去重后只对唯一文本请求）`)
    console.log(`  墙钟：旧 ≈ ${(oldWall / 1000).toFixed(2)}s（建模：请求数 × 延迟）  →  新 ${(elapsed / 1000).toFixed(2)}s（实测）`)
    console.log(`  → 约 ${(oldWall / Math.max(elapsed, 1)).toFixed(1)}×（理论上限约 ${(Math.max(oldCalls, 1) / Math.max(newCalls, 1) * CONC).toFixed(1)}×：去重 + 并发共同作用）`)
    console.log(`  理论新墙钟 ≈ ${(expectedNew / 1000).toFixed(2)}s（唯一文本数 / batch / concurrency × 延迟），与实测对比可看出调度有无额外开销`)
    console.log(`  事件循环最长阻塞：${maxStall.toFixed(1)}ms（验收要求建库期间后端仍可响应查询）`)
    console.log(`  落库 ${r.embedded} 行（含扇出），status=${r.status}`)
  }, 600_000)
})
