/**
 * N14 的性能实测（不是回归用例，但文件名必须保留 *.spec.ts —— vitest 只收集这个后缀）。
 * 靠 `describe.skipIf(MEASURE_N14 !== '1')` 默认跳过。
 *
 * 为什么需要它：验收标准里「记录前后耗时」。耗时受机器负载影响，放进 CI 只会变成随机红灯；
 * 确定性的那部分（≤1 次连接、0 次 COUNT、与改前实现逐字段等价）由 `vector-status.spec.ts` 在 CI 里守。
 *
 * 为什么要 oracle 而不是「建模」：M10 的教训是「别用建模数字当实测」（建模低估 17%）。
 * 这里把**改前的实现**整段搬进本文件跑同一份夹具，两个数都来自同一次运行。
 *
 * 运行：
 *   MEASURE_N14=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/vector-status.measure.spec.ts
 *   MEASURE_N14=1 MEASURE_N14_ROWS=200000 MEASURE_N14_RUNS=9 ...（可改规模与轮数）
 *
 * 夹具说明：本机真实向量库是**空的**，所以合成 N 行。为什么 `vec` 只放 16 字节而不按真实的 3KB：
 * `COUNT(*)` 走 `idx_vectors_doc` 覆盖索引（不回表），成本由**行数**决定、与 blob 大小几乎无关
 * （本轮同时测了「显式 COUNT」与「覆盖索引」两档，见输出）。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

import { vectorDbPath, vectorIndexStatus } from '../src/query/retrieval/embedding.ts'

interface Status {
  exists: boolean
  rows: number
  dim: number
  model: string
  built_at: string | null
  ready: boolean
}

/**
 * **改前实现**的 oracle（逐行照抄 N14 之前的 `vectorIndexStatus`）：改前的「一次提问」= 2 次调用
 * = 2 次连接 + 2 次 COUNT + 8 次 meta 读（本文件按 3 次调用量，因为 `searchDense` 内还有一次）。
 * @param dec - 解密目录。
 * @returns 状态快照。
 */
function legacyStatus(dec: string): Status {
  const p = vectorDbPath(dec)
  const readMeta = (db: DatabaseSync, key: string): string => {
    try {
      return ((db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value?: string } | undefined)?.value) ?? ''
    } catch { return '' }
  }
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    const rows = (db.prepare('SELECT COUNT(*) AS c FROM vectors').get() as { c: number }).c
    const dim = Number(readMeta(db, 'dim') || 0)
    const model = readMeta(db, 'model')
    const built = readMeta(db, 'built_at') || null
    const ver = readMeta(db, 'schema_version')
    db.close()
    return { exists: true, rows, dim, model, built_at: built, ready: rows > 0 && dim > 0 && ver === '1' }
  } catch {
    return { exists: true, rows: 0, dim: 0, model: '', built_at: null, ready: false }
  }
}

/** 造一个「已建好」的向量库：N 行 + meta（含 rows，模拟 N14 之后构建出来的库）。 */
function makeBuiltIndex(root: string, n: number, vecBytes: number): string {
  const dec = join(root, 'decrypted')
  mkdirSync(dec, { recursive: true })
  const db = new DatabaseSync(vectorDbPath(dec))
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  db.exec('CREATE TABLE vectors (fts_rowid INTEGER PRIMARY KEY, doc_key TEXT NOT NULL, username TEXT NOT NULL, local_id INTEGER NOT NULL, create_time INTEGER NOT NULL, dim INTEGER NOT NULL, vec BLOB NOT NULL, hash_lo INTEGER NOT NULL, hash_hi INTEGER NOT NULL)')
  db.exec('CREATE INDEX idx_vectors_doc ON vectors(doc_key)')
  const blob = new Uint8Array(vecBytes)
  const ins = db.prepare('INSERT INTO vectors VALUES (?,?,?,?,?,?,?,?,?)')
  db.exec('BEGIN')
  for (let i = 0; i < n; i += 1) {
    ins.run(i + 1, 'wxid_a:' + String(i + 1), 'wxid_a', i + 1, 1700000000 + i, blob.length / 4, blob, i & 0xffff, (i >>> 16) & 0xffff)
  }
  db.exec('COMMIT')
  for (const [k, v] of Object.entries({ schema_version: '1', dim: String(blob.length / 4), model: 'stub', built_at: '2026-09-15 10:00:00', rows: String(n) })) {
    db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(k, v)
  }
  db.close()
  return dec
}

/** 一次「提问」的 3 次状态查询（gateway 建库前置 + pipeline + searchDense），返回中位耗时（ms）。 */
function timeAsk(fn: (dec: string) => Status, dec: string, runs: number): { median: number; all: number[] } {
  const all: number[] = []
  for (let i = 0; i < runs; i += 1) {
    const t0 = Number(process.hrtime.bigint()) / 1e6
    // 三次调用：缓存命中之后后两次是纯 Map 查找 + statSync
    fn(dec); fn(dec); fn(dec)
    all.push(Number(process.hrtime.bigint()) / 1e6 - t0)
  }
  const sorted = [...all].sort((a, b) => a - b)
  return { median: sorted[Math.floor(sorted.length / 2)], all }
}

describe.skipIf(process.env.MEASURE_N14 !== '1')('N14 向量库状态查询实测', () => {
  it('一次提问的状态查询：改前 vs 改后（连接数/COUNT 数/耗时）', () => {
    const N = Number(process.env.MEASURE_N14_ROWS ?? '135000')
    const VEC = Number(process.env.MEASURE_N14_VEC ?? '16')
    const RUNS = Number(process.env.MEASURE_N14_RUNS ?? '9')
    const root = mkdtempSync(join(tmpdir(), 'wx-n14-measure-'))

    try {
      const dec = makeBuiltIndex(root, N, VEC)
      // 先确认两边给出的状态一致（否则计时没有意义）
      expect(vectorIndexStatus(dec)).toEqual(legacyStatus(dec))

      // 冷路径单次（改后：1 次连接 + 0 次 COUNT + 1 次 meta 查询）
      const cold = (() => {
        const t0 = Number(process.hrtime.bigint()) / 1e6
        const s = vectorIndexStatus(dec)
        return { ms: Number(process.hrtime.bigint()) / 1e6 - t0, rows: s.rows }
      })()
      // 同一条 SQL 族的对照：改前那次 COUNT(*) 单独的耗时
      const countOnly = (() => {
        const db = new DatabaseSync(vectorDbPath(dec), { readOnly: true })
        const all: number[] = []
        for (let i = 0; i < RUNS; i += 1) {
          const t0 = Number(process.hrtime.bigint()) / 1e6
          db.prepare('SELECT COUNT(*) AS c FROM vectors').get()
          all.push(Number(process.hrtime.bigint()) / 1e6 - t0)
        }
        db.close()
        const sorted = [...all].sort((a, b) => a - b)
        return sorted[Math.floor(sorted.length / 2)]
      })()

      const oldAsk = timeAsk(legacyStatus, dec, RUNS)
      const newAsk = timeAsk((d) => vectorIndexStatus(d) as Status, dec, RUNS)

      const fmt = (x: { median: number; all: number[] }): string =>
        `中位 ${x.median.toFixed(2)}ms（${x.all.map((v) => v.toFixed(2)).join(' / ')}）`
      console.log(`\nN14 实测：合成 ${N} 行（vec 每行 ${VEC} 字节），每次「提问」= 3 次状态查询，每档 ${RUNS} 轮`)
      console.log('  改前（2~3 次连接 + COUNT + 4 次 meta 读/次）：' + fmt(oldAsk))
      console.log('  改后（第 1 次冷查询 + 后 2 次缓存命中）：' + fmt(newAsk))
      console.log(`  → ${(oldAsk.median / Math.max(newAsk.median, 0.001)).toFixed(1)}×（省 ${(oldAsk.median - newAsk.median).toFixed(2)}ms/次提问）`)
      console.log(`  冷路径单次（含 statSync + 1 次 meta 查询）：${cold.ms.toFixed(2)}ms，rows=${cold.rows}`)
      console.log(`  对照：单独一次 SELECT COUNT(*)（走 idx_vectors_doc 覆盖索引）：${countOnly.toFixed(2)}ms`)
      console.log('  诚实结论：这是**毫秒级**优化。一次提问的墙钟由 embedding 网络往返（几百 ms）主导，')
      console.log('  这一步省下的量级看不出来；它值钱的地方是「每次提问都要付两遍的固定开销」被摊成了一次。')
    } finally {
      try { rmSync(root, { recursive: true, force: true }) } catch { /* 见 vector-status.spec.ts 的说明 */ }
    }
  }, 600_000)
})
