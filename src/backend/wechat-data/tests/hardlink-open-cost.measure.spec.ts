/**
 * W2-5.3 观测基线 · `hardlink.db` 一次路径解析的成本分布（合成数据）。**不是回归用例**，靠 `MEASURE_HARDLINK_OPEN=1` 门控。
 *
 * ## 它要回答的问题
 *
 * 5.3 说「只读长连接复用（`hardlink.db`/`dir2id` 小库）」。但本仓有一条硬纪律
 * （`query-db-lifetime.spec.ts`）：Windows 上只要还有一条连接开着，数据根就再也删不掉/换不掉，
 * 所以「长连接」不能是**常驻**的。要决定能不能复用，先得知道**复用能省什么**：
 *
 *   ① 开一次只读连接 + 关掉它要多久（这是长连接唯一能省的那一段）；
 *   ② 每次重读一遍 `dir2id` 要多久（这部分**不需要**长连接也能省：缓存成内存 Map 就行）。
 *
 * 拿到这两个数才能判断：省下来的够不够撑起「常驻连接」带来的纪律风险。
 *
 * 运行：
 *   MEASURE_HARDLINK_OPEN=1 node node_modules/vitest/vitest.mjs run src/backend/wechat-data/tests/hardlink-open-cost.measure.spec.ts
 *   表行数用 HL_ROWS 覆盖（默认 200000），dir2id 行数用 HL_DIRS 覆盖（默认 89）。
 *
 *
 * 档位：quick（登记在 `scripts/run-measures.mjs`；本行由 measures-registry 逐条核对，
 *   改了 runner 里的 tier 而不同步这里 ⇒ 红）。
 *   选档依据是**实测耗时**，不是「哪个更重要」：本条实测秒级（远低于单测时长，可进 PR 门禁）。
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
import { resolveImageFilePathsByMd5 } from '../src/query/media-image.ts'

/** 建一个合成 hardlink.db：dir2id `DIRS` 行 + `image_hardlink_info_v4` `ROWS` 行。 */
function makeHardlink(decrypted: string, rows: number, dirs: number): string[] {
  mkdirSync(join(decrypted, 'hardlink'), { recursive: true })
  const db = new DatabaseSync(join(decrypted, 'hardlink', 'hardlink.db'))
  db.exec('CREATE TABLE dir2id (rowid INTEGER PRIMARY KEY, username TEXT)')
  db.exec('CREATE TABLE image_hardlink_info_v4 (md5 TEXT, file_name TEXT, dir1 INTEGER, dir2 INTEGER, modify_time INTEGER)')
  // ⚠️ 必须包事务：逐行 autocommit 在这台机器上是每行两次 fsync，20 万行要几分钟。
  db.exec('BEGIN')
  const insDir = db.prepare('INSERT INTO dir2id (rowid, username) VALUES (?, ?)')
  for (let i = 1; i <= dirs; i += 1) insDir.run(i, 'd' + String(i))
  const ins = db.prepare('INSERT INTO image_hardlink_info_v4 (md5, file_name, dir1, dir2, modify_time) VALUES (?, ?, ?, ?, ?)')
  const md5s: string[] = []
  for (let i = 0; i < rows; i += 1) {
    const md5 = createHash('md5').update('img-' + String(i)).digest('hex')
    md5s.push(md5)
    ins.run(md5, md5 + '.dat', (i % dirs) + 1, ((i + 7) % dirs) + 1, 1700000000 + i)
  }
  db.exec('COMMIT')
  db.close()
  return md5s
}

describe.skipIf(process.env.MEASURE_HARDLINK_OPEN !== '1')('W2：hardlink.db 开连接 / 重读 dir2id 各占多少', () => {
  it('把一次路径解析拆成三段量', { timeout: 180_000 }, () => {
    const ROWS = Math.max(100, Number(process.env.HL_ROWS ?? '200000'))
    const DIRS = Math.max(1, Number(process.env.HL_DIRS ?? '89'))
    const K = Math.max(1, Number(process.env.HL_K ?? '30'))
    const root = mkdtempSync(join(tmpdir(), 'wx-hl-'))
    const decrypted = join(root, 'decrypted')
    try {
      const md5s = makeHardlink(decrypted, ROWS, DIRS)
      const sample = md5s.filter((_, i) => i % Math.floor(md5s.length / K) === 0).slice(0, K)
      const dbPath = join(decrypted, 'hardlink', 'hardlink.db')

      // ① 开 + 关一条只读连接（跑 20 次取平均）
      const openTimes: number[] = []
      for (let i = 0; i < 20; i += 1) {
        const t = Number(process.hrtime.bigint()) / 1e6
        const db = new DatabaseSync(dbPath, { readOnly: true })
        db.close()
        openTimes.push(Number(process.hrtime.bigint()) / 1e6 - t)
      }
      const openMs = openTimes.reduce((a, b) => a + b, 0) / openTimes.length

      // ② 一次连接里重读一遍 dir2id
      const dirTimes: number[] = []
      {
        const db = new DatabaseSync(dbPath, { readOnly: true })
        for (let i = 0; i < 20; i += 1) {
          const t = Number(process.hrtime.bigint()) / 1e6
          db.prepare('SELECT rowid, username FROM dir2id').all()
          dirTimes.push(Number(process.hrtime.bigint()) / 1e6 - t)
        }
        db.close()
      }
      const dirMs = dirTimes.reduce((a, b) => a + b, 0) / dirTimes.length

      // ③ 端到端：走生产入口（每次自己开连接 + 自己读 dir2id）
      const endTimes: number[] = []
      for (let i = 0; i < 5; i += 1) {
        const t = Number(process.hrtime.bigint()) / 1e6
        resolveImageFilePathsByMd5(decrypted, decrypted, sample)
        endTimes.push(Number(process.hrtime.bigint()) / 1e6 - t)
      }
      const endMs = endTimes.reduce((a, b) => a + b, 0) / endTimes.length

      expect(sample.length, '样本一条都没抽到 ⇒ 夹具形状不对').toBe(K)
      console.log([
        '',
        `[HARDLINK-OPEN] info 表 ${String(ROWS)} 行 / dir2id ${String(DIRS)} 行 / 样本 ${String(K)} 张`,
        `  ① 开+关一条只读连接   ${openMs.toFixed(3)}ms（长连接唯一能省的就是这一段）`,
        `  ② 一次连接里重读 dir2id ${dirMs.toFixed(3)}ms（缓存成内存 Map 就能省，不需要长连接）`,
        `  ③ 端到端一次批量解析    ${endMs.toFixed(2)}ms`,
        `      ② 占端到端        ${(dirMs / Math.max(endMs, 0.001) * 100).toFixed(1)}%`,
        '',
      ].join('\n'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})