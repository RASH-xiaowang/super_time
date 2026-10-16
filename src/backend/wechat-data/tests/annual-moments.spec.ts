/**
 * `queryAnnualMoments` 的年度朋友圈口径（新模块，2026-09-30 首次立判据）。
 *
 * ## 为什么这些判据必须钉住
 *
 * 朋友圈这块卡片有三条**会直接影响读者判断**的口径，任何一条松掉，界面上都会出现
 * "看着像真数据、其实是编的"数字：
 *
 *   ① **`available` 与「真的是 0」必须分得开**：库不存在 / 表不存在 ⇒ `available: false`
 *      且计数为 0（界面写「未读取到朋友圈数据」）；库和表都在、这一年只是没发 ⇒
 *      `available: true` 且计数是真实的 0。两者混起来，缺数据会被显示成"你今年一条没发"。
 *   ② **并列取更早**：点赞+评论相同的时候取 `createTime` 小的那条 —— 这条不看 `tid`
 *      （`tid` 在本机 100% 超出 JS 安全整数范围，本模块刻意根本不读它）。
 *   ③ **摘要**：去标签、去掉正文里的换行、截到 40 字以内。换行带进卡片会把后面的
 *      统计数字挤出可视区；不截断则一条长文能把整张卡撑成一屏。
 *
 * 没有真实解密库，所以这里全部用临时目录 + 自己造的 SQLite 库，
 * XML 形态照 `moments.ts#parseSnsXml` / `parseSnsLikesComments` 认的标签写。
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { queryAnnualMoments, summarizeAnnualMoments } from '../src/query/annual-moments.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** 造一个空目录作为解密数据根（下面再往里放 sns.db）。 */
function makeRoot(prefix = 'annual-moments-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(root)
  return root
}

/** 本地时刻（本地时区）→ unix 秒。判年用的是本地时区，夹具也必须按本地时刻造。 */
function at(y: number, m: number, d: number, h = 12, min = 0): number {
  return Math.floor(new Date(y, m - 1, d, h, min, 0, 0).getTime() / 1000)
}

/** 一条互动的 XML 块（`type 1` = 点赞，`type 2` = 评论，与 `parseSnsLikesComments` 对应）。 */
function interact(type: number, u: string, content = ''): string {
  return '<user_comment>'
    + `<comment_id>c-${type}-${u}</comment_id>`
    + `<username>${u}</username><nickname>${u}</nickname>`
    + `<content>${content}</content><create_time>1700000000</create_time>`
    + `<ref_comment_id>0</ref_comment_id><type>${type}</type>`
    + '</user_comment>'
}

/**
 * 造一条 SnsTimeLine 的 content XML —— 标签形态与 `moments.ts` 解析的一致。
 * @param ts - createTime（unix 秒）。
 * @param text - 正文（写进 `<contentDesc>`，会被 CDATA 包住，照真实数据）。
 * @param likes - 点赞人（每人一条 type=1）。
 * @param comments - 评论人（每人一条 type=2）。
 * @returns 完整 XML。
 */
function contentXml(ts: number, text: string, likes: string[] = [], comments: string[] = []): string {
  const social = likes.map(u => interact(1, u)).join('') + comments.map(u => interact(2, u, '说得对')).join('')
  return '<TimelineObject><id>tl-' + ts + '</id>'
    + `<createTime>${ts}</createTime>`
    + `<contentDesc><![CDATA[${text}]]></contentDesc>`
    + (social ? `<LocalExtraInfo>${social}</LocalExtraInfo>` : '')
    + '</TimelineObject>'
}

/** 一条待写入的行。 */
interface Row { ts: number; text: string; likes?: string[]; comments?: string[] }

/**
 * 写一个 `sns.db`。
 * @param root - 解密数据根。
 * @param rows - 要写入 SnsTimeLine 的条目。
 * @param sub - `sns/db_sns/sns.db`（默认，主形态）或 `sns/sns.db`。
 */
function writeSnsDb(root: string, rows: Row[], sub: 'nested' | 'flat' = 'nested'): void {
  const dir = sub === 'nested' ? join(root, 'sns', 'db_sns') : join(root, 'sns')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'sns.db'))
  // 列形态照真实数据：tid / user_name / content。**刻意带一个超出安全整数范围的 tid**
  // —— 本模块不读 tid，正是为了绕开 `node:sqlite` 物化它时抛 ERR_OUT_OF_RANGE。
  db.exec('CREATE TABLE SnsTimeLine (tid TEXT, user_name TEXT, content BLOB)')
  const ins = db.prepare('INSERT INTO SnsTimeLine VALUES (?,?,?)')
  for (const r of rows) {
    ins.run(String(7330000000000000000n + BigInt(r.ts)), 'wxid_me', contentXml(r.ts, r.text, r.likes ?? [], r.comments ?? []))
  }
  db.close()
}

describe('queryAnnualMoments：数据源可用性（区分「没数据」与「真的是 0」）', () => {
  it('整棵树里没有 sns.db ⇒ available:false、计数为 0', async () => {
    const root = makeRoot()
    expect(await queryAnnualMoments(root, 2026)).toEqual({
      count: 0, topPost: null, topMonth: null, lateNight: 0, available: false,
    })
  })

  it('有 sns.db 但没有 SnsTimeLine 表 ⇒ available:false（不是「今年 0 条」）', async () => {
    const root = makeRoot()
    mkdirSync(join(root, 'sns', 'db_sns'), { recursive: true })
    const db = new DatabaseSync(join(root, 'sns', 'db_sns', 'sns.db'))
    db.exec('CREATE TABLE SomethingElse (a INTEGER)')
    db.close()
    const r = await queryAnnualMoments(root, 2026)
    expect(r.available, '缺表被当成了「今年没发」').toBe(false)
    expect(r.count).toBe(0)
  })

  it('表在但整表为空 ⇒ available:true 且计数是**真实的 0**', async () => {
    const root = makeRoot()
    writeSnsDb(root, [])
    const r = await queryAnnualMoments(root, 2026)
    expect(r.available, '空表被当成了「没读到数据」').toBe(true)
    expect(r.count).toBe(0)
    expect(r.topPost).toBeNull()
    expect(r.topMonth).toBeNull()
    expect(r.lateNight).toBe(0)
  })

  it('备用位置 sns/sns.db 也能读到（与 moments.ts 的两个候选一致）', async () => {
    const root = makeRoot()
    writeSnsDb(root, [{ ts: at(2026, 3, 5), text: '备用路径' }], 'flat')
    const r = await queryAnnualMoments(root, 2026)
    expect(r.available).toBe(true)
    expect(r.count).toBe(1)
  })
})

describe('queryAnnualMoments：年度聚合', () => {
  it('只算目标年份：别的年份与「时间读不出来」的条目都不计入', async () => {
    const root = makeRoot()
    writeSnsDb(root, [
      { ts: at(2026, 1, 3), text: '2026 年初' },
      { ts: at(2026, 12, 31, 23, 59), text: '2026 年末' },
      { ts: at(2025, 12, 31, 23, 59), text: '跨年前一刻' },
      { ts: at(2027, 1, 1), text: '下一年' },
      { ts: 0, text: '没有 createTime' },
    ])
    const r = await queryAnnualMoments(root, 2026)
    expect(r.available).toBe(true)
    expect(r.count).toBe(2)
  })

  it('正常数据：条数 / 最热一条 / 最多的月份 / 0-6 点条数一次算全', async () => {
    const root = makeRoot()
    writeSnsDb(root, [
      { ts: at(2026, 3, 1, 14), text: '三月的第一条', likes: ['a', 'b'], comments: ['c'] },
      { ts: at(2026, 3, 2, 2), text: '三月深夜' },
      { ts: at(2026, 3, 3, 6, 30), text: '六点半（算深夜）' },
      { ts: at(2026, 3, 4, 7, 0), text: '七点整（不算深夜）' },
      { ts: at(2026, 8, 8, 20), text: '八月的热闹', likes: ['a', 'b', 'c', 'd', 'e'], comments: ['f', 'g'] },
    ])
    const r = await queryAnnualMoments(root, 2026)
    expect(r.count).toBe(5)
    expect(r.lateNight, '0..6 点含 6 点整，不含 7 点').toBe(2)
    expect(r.topMonth, '三月 4 条 > 八月 1 条').toEqual({ month: 3, count: 4 })
    expect(r.topPost?.likes).toBe(5)
    expect(r.topPost?.comments).toBe(2)
    expect(r.topPost?.excerpt).toBe('八月的热闹')
    expect(r.topPost?.at).toBe('8月8日 20:00')
  })

  it('并列取更早：点赞+评论相同 ⇒ 取 createTime 小的那条', async () => {
    const root = makeRoot()
    writeSnsDb(root, [
      // 故意把**晚**的那条写在前面，避免"碰巧取第一条"也能过。
      { ts: at(2026, 9, 9, 21), text: '晚的那条', likes: ['a'], comments: ['b'] },
      { ts: at(2026, 2, 2, 9), text: '早的那条', likes: ['a'], comments: ['b'] },
    ])
    const r = await queryAnnualMoments(root, 2026)
    expect(r.topPost?.excerpt).toBe('早的那条')
    expect(r.topPost?.at).toBe('2月2日 09:00')
  })

  it('高互动胜过时间：点赞+评论更多的晚条目仍然是 topPost', async () => {
    const root = makeRoot()
    writeSnsDb(root, [
      { ts: at(2026, 2, 2, 9), text: '早但只有 1 个互动', likes: ['a'] },
      { ts: at(2026, 9, 9, 21), text: '晚但有 3 个互动', likes: ['a', 'b'], comments: ['c'] },
    ])
    const r = await queryAnnualMoments(root, 2026)
    expect(r.topPost?.excerpt).toBe('晚但有 3 个互动')
    expect(r.topPost?.likes).toBe(2)
    expect(r.topPost?.comments).toBe(1)
  })

  it('摘要截断：超过 40 字的正文截到 40 字并加省略号', async () => {
    const root = makeRoot()
    const long = '一'.repeat(60)
    writeSnsDb(root, [{ ts: at(2026, 5, 5, 15), text: long }])
    const r = await queryAnnualMoments(root, 2026)
    const ex = r.topPost?.excerpt ?? ''
    expect(ex).toBe('一'.repeat(40) + '…')
    expect(ex.length).toBe(41)
  })

  it('摘要清洗：XML/HTML 标签被去掉、正文里的换行不带进界面', async () => {
    const root = makeRoot()
    writeSnsDb(root, [{ ts: at(2026, 5, 5, 15), text: '第一行<br/>第二行\n第三行&#10;第四行 <a href="https://x">链接</a> 收尾' }])
    const r = await queryAnnualMoments(root, 2026)
    const ex = r.topPost?.excerpt ?? ''
    expect(ex.includes('<'), '标签没被剥掉').toBe(false)
    expect(ex.includes('\n'), '换行被带进了界面').toBe(false)
    expect(ex.includes('&#10;'), '实体换行没被折成空格').toBe(false)
    expect(ex).toBe('第一行 第二行 第三行 第四行 链接 收尾')
  })

  it('一条都没有的年份：available:true、topPost/topMonth 为 null（不是 0 月）', async () => {
    const root = makeRoot()
    writeSnsDb(root, [{ ts: at(2025, 6, 6), text: '去年的' }])
    const r = await queryAnnualMoments(root, 2026)
    expect(r.available).toBe(true)
    expect(r.count).toBe(0)
    expect(r.topPost).toBeNull()
    expect(r.topMonth).toBeNull()
    expect(r.lateNight).toBe(0)
  })
})

describe('summarizeAnnualMoments：纯函数口径（同一份判据不依赖数据库）', () => {
  it('空输入 ⇒ 全 0 / null', () => {
    expect(summarizeAnnualMoments([])).toEqual({ count: 0, topPost: null, topMonth: null, lateNight: 0 })
  })

  it('月份并列取更小的月份（读者预期是「年初那个」）', () => {
    const posts = [
      { ts: at(2026, 11, 1), text: 'a', likes: 0, comments: 0 },
      { ts: at(2026, 4, 1), text: 'b', likes: 0, comments: 0 },
    ]
    expect(summarizeAnnualMoments(posts).topMonth).toEqual({ month: 4, count: 1 })
  })

  it('ts 为 0 的条目不计入深夜、也不计入月份', () => {
    const r = summarizeAnnualMoments([{ ts: 0, text: '没有时间', likes: 9, comments: 9 }])
    expect(r.count).toBe(1)
    expect(r.lateNight).toBe(0)
    expect(r.topMonth).toBeNull()
    expect(r.topPost?.at, 'at 必须是空串，不能编一个时刻').toBe('')
  })
})
