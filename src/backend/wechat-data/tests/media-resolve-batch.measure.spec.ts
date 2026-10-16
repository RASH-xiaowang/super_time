/**
 * W1 观测基线 · 图片 .dat 路径解析：逐张 vs 批量（合成数据）。**不是回归用例**，靠 `MEASURE_MEDIA_RESOLVE=1` 门控。
 *
 * ## 背景与它要回答的问题
 *
 * N16 已把 `WHERE lower(md5) = ?`（在 `image_hardlink_info_v4` 上等价全表扫）改成
 * `WHERE lower(md5) IN (...)` 批量查询，单张路径也已走批量入口（`resolveImageFilePath`
 * → `resolveImageFilePathsByMd5([md5])`）。所以还剩两个问题没有数：
 *   ① 端到端看，30 张图逐张调用 vs 一次批量调用，差多少（连接开销、readDir2id 重复读都在里面）；
 *   ② 纯 SQL 阶段（同一连接上 30 次单查 vs 1 次 IN 查）差多少 —— 这一层与连接/文件探测解耦，
 *      决定「批量入口」到底省在哪一段。
 *
 * N16 条目里记的实测：本机真实表 3309 行 0.30ms/次、合成 20 万行 17.27ms/次 ⇒ 30 张 ≈518ms。
 * 这里用合成表复现同一量级，并把「批量已接线之后」的数字量出来，作为后续还能不能优化的基线。
 *
 * 运行：
 *   MEASURE_MEDIA_RESOLVE=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/media-resolve-batch.measure.spec.ts
 *   行数用 MEDIA_IMG_N 覆盖（默认 200000）。
 *
 * 档位：quick（登记在 `scripts/run-measures.mjs`；本行由 measures-registry 逐条核对，
 *   改了 runner 里的 tier 而不同步这里 ⇒ 红）。
 *   选档依据是**实测耗时**，不是「哪个更重要」：本条实测秒级（远低于单测时长，可进 PR 门禁）。
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { resolveImageFilePath, resolveImageFilePathsByMd5 } from '../src/query/media-image.ts'
import { at } from '../../tests/helpers/strict-index.ts'

/** 建一个合成 hardlink.db：dir2id 89 行（对齐真实量级）+ image_hardlink_info_v4 N 行。 */
function makeHardlinkDb(dir: string, rows: number): { md5s: string[] } {
  mkdirSync(join(dir, 'hardlink'), { recursive: true })
  const db = new DatabaseSync(join(dir, 'hardlink', 'hardlink.db'))
  db.exec('CREATE TABLE dir2id (rowid INTEGER PRIMARY KEY, username TEXT)')
  db.exec('CREATE TABLE image_hardlink_info_v4 (md5 TEXT, file_name TEXT, dir1 INTEGER, dir2 INTEGER, modify_time INTEGER)')
  const insDir = db.prepare('INSERT INTO dir2id (rowid, username) VALUES (?, ?)')
  // ⚠️ 必须包事务：SQLite 默认 autocommit + synchronous=FULL ⇒ 每条 INSERT 两次 fsync。
  // 本 spec 第一版没包，20 万行入库实测 **221 秒**（与 CI 假红 N36 的「批量写不包事务」同族，
  // 连症状都一样）。批量写不包事务在这台机器上就是每分钟几千行的量级，夹具也一样中招。
  db.exec('BEGIN')
  for (let i = 1; i <= 89; i += 1) insDir.run(i, 'd' + String(i))
  const ins = db.prepare('INSERT INTO image_hardlink_info_v4 (md5, file_name, dir1, dir2, modify_time) VALUES (?, ?, ?, ?, ?)')
  const md5s: string[] = []
  for (let i = 0; i < rows; i += 1) {
    const md5 = createHash('md5').update('img-' + String(i)).digest('hex')
    md5s.push(md5)
    ins.run(md5, md5 + '.dat', (i % 89) + 1, ((i + 7) % 89) + 1, 1700000000 + i)
  }
  db.exec('COMMIT')
  db.close()
  return { md5s }
}

describe.skipIf(process.env.MEASURE_MEDIA_RESOLVE !== '1')('W1：图片路径解析 逐张 vs 批量（合成数据）', () => {
  // 20 万行夹具 + 逐张对照：显式给宽超时，别让「夹具还没建完」被算成用例超时（本 spec 第一版
  // 就是因为 20 万次 autocommit 把 180s 默认窗口吃满，数字全对但整文件报超时）。
  it('量连接开销 / readDir2id / SQL 三段各占多少', { timeout: 120_000 }, () => {
    const N = Math.max(1, Number(process.env.MEDIA_IMG_N ?? '200000'))
    const K = Math.max(1, Number(process.env.MEDIA_IMG_K ?? '30'))
    const base = mkdtempSync(join(tmpdir(), 'wx-imgbatch-'))
    try {
      const { md5s } = makeHardlinkDb(base, N)
      // 取 K 个互不相同的 md5（两端各取一半，避免都落在同一批写入的页里）。
      const sample: string[] = []
      for (let i = 0; i < K; i += 1) sample.push(at(md5s, Math.floor((i * N) / K), 'md5 样本') ?? '')

      // ── A. 端到端：逐张调用（每张一次连接 + 一次 readDir2id + 一次单查 + 文件探测）──
      const tA = Number(process.hrtime.bigint()) / 1e6
      let hitsA = 0
      for (const m of sample) if (resolveImageFilePath(base, base, m, '')) hitsA += 1
      const msA = Number(process.hrtime.bigint()) / 1e6 - tA

      // ── B. 端到端：一次批量调用 ──
      const tB = Number(process.hrtime.bigint()) / 1e6
      const got = resolveImageFilePathsByMd5(base, base, sample)
      const msB = Number(process.hrtime.bigint()) / 1e6 - tB
      expect(got.size, '批量入口与逐张入口的命中集合必须一致').toBe(hitsA)

      // ── C. 纯 SQL 阶段（同一连接，隔离连接/文件探测成本）──
      const dbPath = join(base, 'hardlink', 'hardlink.db')
      const db = new DatabaseSync(dbPath, { readOnly: true })
      const tC = Number(process.hrtime.bigint()) / 1e6
      for (const m of sample) {
        db.prepare('SELECT lower(md5) AS m, file_name, dir1, dir2 FROM image_hardlink_info_v4 WHERE lower(md5) = ? ORDER BY modify_time DESC').all(m)
      }
      const msC = Number(process.hrtime.bigint()) / 1e6 - tC
      const ph = sample.map(() => '?').join(', ')
      const tD = Number(process.hrtime.bigint()) / 1e6
      db.prepare(`SELECT lower(md5) AS m, file_name, dir1, dir2 FROM image_hardlink_info_v4 WHERE lower(md5) IN (${ph}) ORDER BY modify_time DESC`).all(...sample)
      const msD = Number(process.hrtime.bigint()) / 1e6 - tD
      const tE = Number(process.hrtime.bigint()) / 1e6
      db.prepare('SELECT rowid, username FROM dir2id').all()
      const msE = Number(process.hrtime.bigint()) / 1e6 - tE
      db.close()

      console.log([
        '',
        `[MEDIA-RESOLVE] info 表 ${String(N)} 行 / dir2id 89 行 / 样本 ${String(sample.length)} 张`,
        `  A 逐张端到端     合计 ${msA.toFixed(1)}ms ⇒ ${(msA / sample.length).toFixed(2)}ms/张（命中 ${String(hitsA)}）`,
        `  B 批量端到端     合计 ${msB.toFixed(2)}ms ⇒ ${(msB / sample.length).toFixed(3)}ms/张`,
        `      A/B           ${(msA / Math.max(msB, 0.001)).toFixed(1)}×`,
        `  C 纯 SQL 逐张     ${msC.toFixed(1)}ms（同一连接，无连接/探测开销）`,
        `  D 纯 SQL 批量     ${msD.toFixed(2)}ms ⇒ C/D ${(msC / Math.max(msD, 0.001)).toFixed(1)}×`,
        `  E readDir2id 一次 ${msE.toFixed(2)}ms（逐张路径每张都付一次）`,
        '',
      ].join('\n'))
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
