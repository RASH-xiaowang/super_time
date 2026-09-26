/**
 * @vitest-environment node
 *
 * 为什么这份文件必须是 node 环境：夹具要用 `node:sqlite` 在临时目录里现造分片库。
 *
 * P1-7 里被点名「零 spec 引用」的日历统计（CODE-AUDIT-2026-09-26 `query/calendar.ts`，
 * PERF-BASELINE 那一行「消息日历 7ms ❌ 无」也是它）。
 *
 * 这个函数是聊天面板日历热力图**唯一的**数据来源：`chats-view.tsx:868` 按
 * `calCounts[String(day)]`（**不补零**的 1–31）取数，所以它真正要守的是三件事：
 *   1. 天与月的归属按**本地时区**算，区间是「左闭右开」——月初 00:00:00 属于本月，
 *      前一秒属于上月，既不许算两次也不许漏；
 *   2. 只读本会话那张 `Msg_<md5(username)>` 表、只读真正的消息分片，跨分片要**相加**；
 *   3. 一个坏分片不许把整个月带走。
 *
 * 判据为什么写成「整份 counts 逐键对齐」而不是「有键、值 > 0」：这条链路上没有任何地方
 * 会补算缺失的天，多算一天（月界写成 `<=`）与少算一天（漏读一个分片）在界面上都是
 * 热力图看不出来的错数 —— 只有 `toEqual({...})` 能同时抓住多和少。每条用例的期望值都是
 * **具体数字**，返回 `{}` 的空壳桩件必然红。顺带钉住值是 `number` 而不是 `bigint`
 * （`node:sqlite` 的 COUNT(*) 一旦回 bigint，IPC 序列化与面板的 reduce 求和都会坏）。
 *
 * 夹具全部在临时目录里现造现删（仓库内不落任何东西）：本仓有过一次测试在仓库里
 * 建了目录、把无关的打包守卫照红的教训。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDailyCounts } from '../src/query/calendar.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根：用来证明「测试没在仓库里落东西」。 */
const REPO_ROOT = join(HERE, '..', '..', '..', '..')

/** 被测会话；表名必须由 `Msg_<md5(username)>` 推出来才读得到。 */
const ME = 'wxid_calendar@chatroom'
/** 同库里**别人**的会话：它的行一条都不许进上面的 counts。 */
const OTHER = 'wxid_other@chatroom'

const scratch: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of scratch) {
    // 兜底吞错：正常情况下每条句柄都已归还（见最后那条用例），但临时目录里若还有
    // 被占用的文件，不该让整份用例文件因为清理失败而红。
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败由句柄计数那条用例自己管 */ }
  }
  scratch.length = 0
})

const tableOf = (username: string): string => 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')

/**
 * 本地时区的 unix 秒（与 calendar.ts 自己的 `new Date(year, month - 1, day)` 同口径）。
 * @param year - 年。
 * @param month - 月（1-12）。
 * @param day - 日。
 * @param hour - 时，默认 12 点（远离月界，用来放「稳定落在本月内」的行）。
 * @returns unix 秒。
 */
function tsLocal(year: number, month: number, day: number, hour = 12): number {
  return Math.floor(new Date(year, month - 1, day, hour, 0, 0, 0).getTime() / 1000)
}

/**
 * 造一个解密根目录（`<临时目录>/decrypted`）。
 * @returns 可直接喂给 getDailyCounts 的解密根目录。
 */
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-calendar-'))
  scratch.push(root)
  return join(root, 'decrypted')
}

/**
 * 写一个 `message/<file>` 分片：每张表按给定的 create_time 逐条插入。
 * 写完立刻 close —— 之后只读打开的纪律归被测函数负责。
 * @param decrypted - 解密根目录。
 * @param file - 分片文件名（住在 `message/` 下）。
 * @param entries - 每张表（按 username 取 md5 表名）要插的时间戳。
 */
function writeShard(decrypted: string, file: string, entries: Array<{ username: string; times: number[] }>): void {
  const dir = join(decrypted, 'message')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, file))
  try {
    for (const e of entries) {
      const t = tableOf(e.username)
      db.exec(`CREATE TABLE IF NOT EXISTS "${t}" (local_id INTEGER, create_time INTEGER, message_content TEXT)`)
      const ins = db.prepare(`INSERT INTO "${t}" VALUES (?,?,?)`)
      e.times.forEach((time, i) => { ins.run(i + 1, time, 'x') })
    }
  } finally {
    db.close()
  }
}

/** 分片里放一张**没有 create_time 列**的表（结构不符的库）。 */
function writeShardMissingCreateAt(decrypted: string, file: string, username: string): void {
  const dir = join(decrypted, 'message')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, file))
  try {
    db.exec(`CREATE TABLE "${tableOf(username)}" (local_id INTEGER, weird TEXT)`)
    db.prepare(`INSERT INTO "${tableOf(username)}" VALUES (1,'x')`).run()
  } finally {
    db.close()
  }
}

/**
 * 只给被测会话建表、插一批 create_time 的简写（绝大多数用例只需要它自己的表）。
 * @param decrypted - 解密根目录。
 * @param file - 分片文件名。
 * @param times - 要插的 create_time。
 */
function onlyMine(decrypted: string, file: string, times: number[]): void {
  writeShard(decrypted, file, [{ username: ME, times }])
}

/** 库文件当下是否可删 —— 还开着句柄时 Windows 会给 EBUSY/EPERM（口径同 query-db-lifetime.spec.ts）。 */
function deletable(file: string): boolean {
  try { unlinkSync(file); return true } catch { return false }
}

describe('getDailyCounts：按月统计每天的消息数', () => {
  it('夹具落在临时目录里，仓库根不会多出 msg/ 或 message/（打包守卫踩过的坑）', () => {
    const dec = makeRoot()
    mkdirSync(join(dec, 'message'), { recursive: true })
    onlyMine(dec, 'message_0.db', [tsLocal(2024, 3, 10)])
    expect(isAbsolute(relative(REPO_ROOT, dec)), '夹具跑进仓库里了').toBe(true)
    expect(existsSync(join(REPO_ROOT, 'msg')), '仓库根被建出了 msg/').toBe(false)
    expect(existsSync(join(REPO_ROOT, 'message')), '仓库根被建出了 message/').toBe(false)
    const r = getDailyCounts(dec, ME, 2024, 3)
    expect(r.counts).toEqual({ '10': 1 })
  })

  it('月界左闭右开，键不补零；相邻月份不重不漏（含 2 月闰日与 12 月跨年）', () => {
    const dec = makeRoot()
    // 月首整点由 tsLocal 现算，月末最后一秒写成「下月整点 - 1 秒」：两个量与 calendar.ts
    // 自己算 startTs/endTs 用的是同一套本地 Date 表达式，换时区也不会漂到邻日去。
    const marFirst = tsLocal(2024, 3, 1, 0)
    const aprFirst = tsLocal(2024, 4, 1, 0)
    const march = [
      marFirst,             // 本月第一秒 —— 必须算进来
      marFirst - 1,         // 上月最后一秒 2024-02-29 23:59:59 —— 不许进来
      tsLocal(2024, 3, 15),
      aprFirst - 1,         // 本月最后一秒 03-31 23:59:59
      aprFirst,             // 下月第一秒 —— 不许进来
    ]
    onlyMine(dec, 'message_0.db', march)
    const march3 = getDailyCounts(dec, ME, 2024, 3)
    expect(march3.counts, '月初/月末各一秒被多算或漏算').toEqual({ '1': 1, '15': 1, '31': 1 })
    expect(march3.year).toBe(2024)
    expect(march3.month).toBe(3)
    // 那三行「不在三月」的行确实归到了相邻月份：2024-02 是闰月（29 天），所以 29 号只可能是它。
    expect(getDailyCounts(dec, ME, 2024, 2).counts).toEqual({ '29': 1 })
    expect(getDailyCounts(dec, ME, 2024, 4).counts).toEqual({ '1': 1 })
    // 12 月的区间上界必须滚到**次年** 1 月 1 日（`new Date(year, month, 1)` 的 month=12）。
    onlyMine(dec, 'message_1.db', [tsLocal(2024, 12, 20), tsLocal(2025, 1, 1, 0) - 1, tsLocal(2025, 1, 1, 0)])
    expect(getDailyCounts(dec, ME, 2024, 12).counts).toEqual({ '20': 1, '31': 1 })
    expect(getDailyCounts(dec, ME, 2025, 1).counts).toEqual({ '1': 1 })
  })

  it('跨分片相加，且只算本会话那张 Msg_<md5> 表', () => {
    const dec = makeRoot()
    writeShard(dec, 'message_0.db', [
      { username: ME, times: [tsLocal(2024, 6, 5), tsLocal(2024, 6, 5)] },
      // 同一个分片里别人的一堆消息：一条都不许进来（表名推错就会全混）
      { username: OTHER, times: Array.from({ length: 7 }, () => tsLocal(2024, 6, 5)) },
    ])
    writeShard(dec, 'message_1.db', [{ username: ME, times: [tsLocal(2024, 6, 5), tsLocal(2024, 6, 5), tsLocal(2024, 6, 5), tsLocal(2024, 6, 8)] }])
    const r = getDailyCounts(dec, ME, 2024, 6)
    // 5 号是「分片0 两条 + 分片1 三条」：漏读任一片 ⇒ 3 或 2，把 `+=` 退成 `=` ⇒ 3，全都红。
    expect(r.counts).toEqual({ '5': 5, '8': 1 })
    // 换个会话查同一张库，读到的必须是它自己的表（别人那 7 条）。
    expect(getDailyCounts(dec, OTHER, 2024, 6).counts).toEqual({ '5': 7 })
  })

  it('只有 message_*.db 算分片：fts / resource / media 与别的命名一律不读', () => {
    const dec = makeRoot()
    onlyMine(dec, 'message_0.db', [tsLocal(2024, 7, 7), tsLocal(2024, 7, 7)])
    const noiseDays = [tsLocal(2024, 7, 21), tsLocal(2024, 7, 21), tsLocal(2024, 7, 22)]
    // 这些库**也有**同一张 Msg 表、也在同一个月有行：漏进 counts 就说明过滤没生效。
    for (const f of ['message_fts.db', 'message_resource.db', 'message_media.db', 'media_0.db', 'chat_0.db', 'message_0.db.bak']) {
      if (f.endsWith('.bak')) writeFileSync(join(dec, 'message', f), 'not a db')
      else onlyMine(dec, f, noiseDays)
    }
    expect(getDailyCounts(dec, ME, 2024, 7).counts, '非消息分片被算进了日历').toEqual({ '7': 2 })
  })

  it('月份非法要响；1 与 12 是合法边界；没有 message 目录时回空 counts 并原样带回年月', () => {
    const dec = makeRoot()
    onlyMine(dec, 'message_0.db', [tsLocal(2024, 5, 9)])
    expect(() => getDailyCounts(dec, ME, 2024, 0)).toThrow('无效月份')
    expect(() => getDailyCounts(dec, ME, 2024, 13)).toThrow('无效月份')
    expect(getDailyCounts(dec, ME, 2024, 1).counts).toEqual({})
    expect(getDailyCounts(dec, ME, 2024, 12).counts).toEqual({})
    const empty = makeRoot()
    // 解密根在、`message/` 还没生成（新账号/还没同步过）。
    mkdirSync(empty, { recursive: true })
    expect(getDailyCounts(empty, ME, 2024, 5).counts).toEqual({})
    // 整个路径都不存在时也不许抛 —— 前端切月是连点的，报错就等于面板翻脸。
    const r = getDailyCounts(join(empty, 'nothing-here'), ME, 2024, 5)
    // year/month 原样回传是前端切月的依据：归一化或丢掉都会让热力图停在错的月份上。
    expect(r).toEqual({ counts: {}, year: 2024, month: 5 })
  })

  it('表结构不对的分片被跳过，其余分片照常出数，而且句柄当场就还（库文件立刻可删）', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-calendar-leak-'))
    scratch.push(root)
    const dec = join(root, 'decrypted')
    onlyMine(dec, 'message_0.db', [tsLocal(2024, 8, 9), tsLocal(2024, 8, 9)])
    writeShardMissingCreateAt(dec, 'message_1.db', ME)
    writeShard(dec, 'message_2.db', [{ username: ME, times: [tsLocal(2024, 8, 9)] }])
    expect(getDailyCounts(dec, ME, 2024, 8).counts, '一个坏表结构就把整个月带走').toEqual({ '9': 3 })
    // 口径同 query-db-lifetime.spec.ts：只要还有连接没关，Windows 上 unlink 就 EBUSY。
    for (const f of ['message_0.db', 'message_1.db', 'message_2.db']) {
      expect(deletable(join(dec, 'message', f)), `${f} 还被没关的连接占着`).toBe(true)
    }
  })

  it('不是 sqlite 库的 message_*.db：跳过那一个分片、其余照常出数，句柄当场就还', () => {
    const dec = makeRoot()
    onlyMine(dec, 'message_0.db', [tsLocal(2024, 9, 9), tsLocal(2024, 9, 9)])
    writeFileSync(join(dec, 'message', 'message_1.db'), 'not a sqlite database file\n'.repeat(8))
    const opens = vi.spyOn(DatabaseSync.prototype, 'prepare')
    const closes = vi.spyOn(DatabaseSync.prototype, 'close')
    const preparedBefore = opens.mock.calls.length
    const closedBefore = closes.mock.calls.length
    // 旧写法把「表存在性检查」写在 try 之外：一个截断/没解密的半写分片（`file is not a database`）
    // 会一路上抛 ⇒ 日历整个月拿不到数，而不是跳过那一片；那条句柄也没人关
    // （Windows 上等于把解密目录钉住，实时同步再也替换不掉）。现在两层都修了。
    const res = getDailyCounts(dec, ME, 2024, 9)
    expect(res.counts['9'], '坏分片把整个月一起毁了 ⇒ 一个文件毁掉全部').toBe(2)
    // 好分片：1 次存在性检查 + 1 次计数；坏分片：1 次检查就抛（被吞掉）⇒ 共 3 次 prepare
    expect(opens.mock.calls.length - preparedBefore, '分片被打开/查询的次数对不上').toBe(3)
    // 两个分片各开一条、各关一条 —— 判据是「开几次关几次」，坏分片也一样要还。
    expect(closes.mock.calls.length - closedBefore, '有一条句柄没关：Windows 上等于把解密目录钉住').toBe(2)
    for (const f of ['message_0.db', 'message_1.db']) {
      expect(deletable(join(dec, 'message', f)), `${f} 还被没关的连接占着`).toBe(true)
    }
  })
})
