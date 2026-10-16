/**
 * `queryAnnual` 的年份口径（2026-09-28 首次立判据）。
 *
 * ## 为什么现在才立
 *
 * 这个接口此前**一份 spec 都没有**，而 2026-09-28 的性能改动动了它的**取数方式**：
 * 由「逐行 `DISTINCT strftime('%Y', datetime(create_time,'unixepoch'))`」换成
 * 「每张 `Msg_*` 表取一次 `MIN/MAX(create_time)`，再按年**区间**展开」。
 *
 * 换法有两处必须钉住的口径：
 *   ① **跨年的表**：一张表里既有 2024 又有 2026 的消息时，旧口径报 `{2024, 2026}`，
 *      新口径按区间展开同样报 `{2024, 2025, 2026}` —— 中间那年**表里其实没有消息**。
 *      这是本改动**唯一有意放宽**的地方：真实数据上实测 0 张表跨年
 *      （`working/diag-annual-equiv.ts`：两种口径产出逐字相同），
 *      而省下的是「逐行 strftime + 去重」（本机 106ms → 56ms）。
 *      所以这条用一个**显式夹具**把行为写下来：断言区间展开，而不是装作它不存在。
 *   ② **UTC**：旧口径的 SQLite `datetime(...,'unixepoch')` 是 UTC，新口径用
 *      `getUTCFullYear()` 对齐。用本地时区会把「1 月 1 日凌晨」的消息算到上一年。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { queryAnnual } from '../src/query/annual.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/**
 * 造一个数据根：一个分片、若干张 `Msg_*` 表，每张表写入给定的 unix 秒。
 * @param rowsPerTable - 每张表的 create_time 列表。
 * @returns 解密数据根路径。
 */
function makeTree(rowsPerTable: number[][]): string {
  const root = mkdtempSync(join(tmpdir(), 'annual-'))
  scratch.push(root)
  const msgDir = join(root, 'message')
  mkdirSync(msgDir, { recursive: true })
  const db = new DatabaseSync(join(msgDir, 'message_0.db'))
  rowsPerTable.forEach((times, i) => {
    const t = `Msg_wxid_${String(i).padStart(32, 'a')}`
    db.exec(`CREATE TABLE "${t}" (create_time INTEGER, local_type INTEGER)`)
    const ins = db.prepare(`INSERT INTO "${t}" VALUES (?,?)`)
    for (const ts of times) ins.run(ts, 1)
  })
  db.close()
  return root
}

/** unix 秒（UTC 指定年月日）。 */
function utc(y: number, m: number, d: number): number {
  return Math.floor(Date.UTC(y, m - 1, d, 12, 0, 0) / 1000)
}

describe('queryAnnual 年份口径', () => {
  it('只报**有消息**的年份，降序；null/0 时间戳不算', async () => {
    const root = makeTree([
      [utc(2026, 5, 1), utc(2026, 6, 1)],   // 2026
      [utc(2024, 3, 3)],                    // 2024
      [0],                                  // create_time > 0 过滤掉
    ])
    const r = await queryAnnual(root)
    expect(r.years).toEqual([2026, 2024])
  })

  it('跨年的表按**年区间**展开（唯一有意放宽处；真实数据 0 张表跨年）', async () => {
    // 同一张表：2024 与 2026 各一条 ⇒ 区间展开会多出 2025（表里其实没有 2025 的消息）。
    const root = makeTree([[utc(2024, 6, 1), utc(2026, 6, 1)]])
    const r = await queryAnnual(root)
    expect(r.years, '区间展开：2025 会被报出来（这是本改动的已知放宽，勿当成 bug）')
      .toEqual([2026, 2025, 2024])
  })

  it('用 **UTC** 判年：1 月 1 日凌晨不得被算到上一年', async () => {
    // UTC 2026-01-01 00:30 —— 在 UTC+8 下是本机 08:30（同年），
    // 而在 UTC-5 下是 2025-12-31（上一年）。口径必须是 UTC ⇒ 判成 2026。
    const ts = Math.floor(Date.UTC(2026, 0, 1, 0, 30, 0) / 1000)
    const root = makeTree([[ts]])
    const r = await queryAnnual(root)
    expect(r.years, '用了本地时区就会在负偏移时区上判成 2025').toEqual([2026])
  })

  it('2000 年（含）以前的时间戳被丢掉（与旧口径的 y > 2000 一致）', async () => {
    const root = makeTree([[utc(1999, 12, 31)], [utc(2001, 1, 1)]])
    const r = await queryAnnual(root)
    expect(r.years).toEqual([2001])
  })

  it('空数据目录：空数组而不是抛错', async () => {
    const root = mkdtempSync(join(tmpdir(), 'annual-empty-'))
    scratch.push(root)
    expect(await queryAnnual(root)).toEqual({ years: [] })
  })

  it('防空转：写进去的年份确实读得到（否则上面的断言都可能恒真）', async () => {
    const root = makeTree([[utc(2026, 7, 7)]])
    expect((await queryAnnual(root)).years).toEqual([2026])
  })
})
