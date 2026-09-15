/**
 * N8 的内存实测（不是回归用例，靠 `MEASURE_N8=1` 门控，默认跳过）。
 *
 * 要回答的问题：改前 `SELECT … FROM message_meta` + `.all()` 会把**整张表**先物化，
 * 而下面立刻 `.slice(0, maxDocsPerBuild)` 只留前几万条 —— 峰值到底差多少？
 *
 * 方法：造一份 20 万行、单条 478 字符的合成索引（与计划里那次实测同规模），
 * 每 10ms 采样一次 `process.memoryUsage().rss`，记录构建前后的峰值差。
 * 对照方式与 N10 一致：**把 HEAD 的改前实现换进同一个文件、跑同一个脚本**，
 * 两个数来自同一次会话的同一台机器。
 *
 * 运行：
 *   MEASURE_N8=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/vector-build-read.measure.spec.ts
 *   MEASURE_N8=1 MEASURE_N8_ROWS=200000 MEASURE_N8_CAP=40000 ...（可调规模）
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { buildVectorIndex } from '../src/query/retrieval/embedding.ts'

describe.skipIf(process.env.MEASURE_N8 !== '1')('N8 读取侧内存实测', () => {
  it('20 万行的 message_meta：构建期间 RSS 峰值增量', async () => {
    const ROWS = Number(process.env.MEASURE_N8_ROWS ?? '200000')
    const CAP = Number(process.env.MEASURE_N8_CAP ?? '40000')
    const CHARS = Number(process.env.MEASURE_N8_CHARS ?? '478')
    const DUP = Number(process.env.MEASURE_N8_DUP ?? '0.565')

    const root = mkdtempSync(join(tmpdir(), 'wx-n8-measure-'))
    const dec = join(root, 'decrypted')
    mkdirSync(dec, { recursive: true })
    const db = new DatabaseSync(join(root, 'wechat_search.db'))
    db.exec('CREATE TABLE message_meta (rowid INTEGER PRIMARY KEY, text TEXT, username TEXT, local_id INTEGER, create_time INTEGER)')
    const ins = db.prepare('INSERT INTO message_meta VALUES (?,?,?,?,?)')
    const unique = Math.max(1, Math.round(ROWS * (1 - DUP)))
    db.exec('BEGIN')
    for (let i = 0; i < ROWS; i += 1) {
      // 前 unique 行各自唯一，其余复用（模拟真实语料的 56.5% 重复率）
      const text = i < unique ? `文档 ${i} ` + 'x'.repeat(CHARS) : `复读 ${i % 7} ` + 'y'.repeat(CHARS)
      ins.run(i + 1, text, 'wxid_a', i + 1, 1700000000 + i)
    }
    db.exec('COMMIT')
    db.close()

    // 采样 RSS（每 10ms）
    let peak = 0
    const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss) }, 10)
    const base = process.memoryUsage().rss
    const t0 = Date.now()
    const r = await buildVectorIndex(dec, async (texts) => {
      await new Promise((res) => setTimeout(res, 1))
      return texts.map(() => [0.1, 0.2, 0.3, 0.4])
    }, { model: 'stub', batchSize: 16, maxCharsPerDoc: 200, maxDocsPerBuild: CAP, concurrency: 4 })
    const elapsed = Date.now() - t0
    clearInterval(timer)

    const mb = (n: number) => Math.round(n / 1024 / 1024)
    console.log(`N8 实测：message_meta ${ROWS} 行 × ${CHARS} 字符，上限 ${CAP}，唯一文本 ${unique}`)
    console.log(`  构建结果：status=${r.status} rows=${r.rows} embedded=${r.embedded} embed_calls=${r.embed_calls}`)
    console.log(`  墙钟：${elapsed}ms`)
    console.log(`  RSS：基线 ${mb(base)}MB → 峰值 ${mb(Math.max(peak, base))}MB（增量 ${mb(Math.max(peak, base) - base)}MB）`)

    try { rmSync(root, { recursive: true, force: true }) } catch { /* ignore */ }
    // 极宽松的上界：只是防「又变回整表物化」这类量级级别的回归
    expect(mb(Math.max(peak, base) - base)).toBeLessThan(500)
  })
})
