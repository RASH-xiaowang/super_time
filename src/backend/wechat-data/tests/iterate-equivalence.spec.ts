/**
 * N8：两处**没有既有用例覆盖**的游标改造，补行为断言。
 *
 * `group-insights` / `asset-insights` / `moments-insights` / `overview` 都有各自的 spec
 * （游标改造后全绿，说明行为未变），但 `queryPrivacyScan`（privacy.ts）与
 * `queryOverviewInsights`（overview-insights.ts）**没有被任何 spec 直接调用** ——
 * 游标写错（比如一次都没读、或读全表后漏掉 break）在那边没有任何信号。
 *
 * 这里用最小夹具断言**精确计数**：游标少读一行、多读一行都会立刻露出来。
 * 另外单独锁住 `rowBudget` 的语义 —— 改前 `.all()` 是「先物化全表再 break」，
 * 预算只限制处理量；换游标后预算才真正成为**读取**上界（这正是 N8 的收益之一）。
 *
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'

import { queryOverviewInsights } from '../src/query/overview-insights.ts'
import { queryPrivacyScan } from '../src/query/privacy.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

function makeDecrypted(): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-n8-cover-'))
  scratch.push(root)
  const dec = join(root, 'decrypted')
  mkdirSync(join(dec, 'message'), { recursive: true })
  mkdirSync(join(dec, 'session'), { recursive: true })
  mkdirSync(join(dec, 'sns', 'db_sns'), { recursive: true })
  return dec
}

const USER = 'wxid_a'

/** 造一个带 privacy 扫描所需消息的样本库（可为多个会话各建一张 Msg_ 表）。 */
function seedMessages(dec: string, rows: Array<{ text: string; type?: number; ts?: number }>, users: string[] = [USER]): void {
  const db = new DatabaseSync(join(dec, 'session', 'session.db'))
  db.exec('CREATE TABLE SessionTable (username TEXT)')
  const insUser = db.prepare('INSERT INTO SessionTable (username) VALUES (?)')
  for (const u of users) insUser.run(u)
  db.close()

  const mdb = new DatabaseSync(join(dec, 'message', 'message_0.db'))
  users.forEach((u, idx) => {
    const table = 'Msg_' + createHash('md5').update(u, 'utf8').digest('hex')
    mdb.exec(`CREATE TABLE "${table}" (local_id INTEGER PRIMARY KEY, create_time INTEGER, message_content TEXT, local_type INTEGER)`)
    if (idx !== 0) return // 消息只灌第一个会话，第二个用来验证「按会话/表计数」
    const ins = mdb.prepare(`INSERT INTO "${table}" (local_id, create_time, message_content, local_type) VALUES (?,?,?,?)`)
    rows.forEach((r, i) => ins.run(i + 1, r.ts ?? 1700000000 + i, r.text, r.type ?? 1))
  })
  mdb.close()
}

describe('N8：queryPrivacyScan 的游标读取（行为等价 + 预算语义）', () => {
  it('逐行计数正确：命中数 / 涉及会话数 / 联系人排名', () => {
    const dec = makeDecrypted()
    seedMessages(dec, [
      { text: '手机 13800138000' },
      { text: '另一个 13900139000' },
      { text: '还有 13700137000 和 13600136000' }, // 一行只按类别各计 1 次
      { text: '邮箱 someone@example.com' },
      { text: '今天天气不错' }, // 无命中，但算「涉及」
      { text: '<sys>这类以尖括号开头的行会被跳过</sys>' },
      { text: '这是 local_type=47 的行，不该被扫', type: 47 },
    ], [USER, 'wxid_b'])

    const r = queryPrivacyScan(dec)
    const byKey = new Map(r.categories.map((c) => [c.key, c.count]))
    expect(byKey.get('phone'), '三行手机号 → 3 次（同一行两个号码只算一次）').toBe(3)
    expect(byKey.get('email')).toBe(1)
    expect(r.categories.reduce((a, c) => a + c.count, 0)).toBe(r.total_hits)
    expect(r.total_hits, '3 手机号 + 1 邮箱').toBe(4)
    // involved_sessions 计的是「扫到过表的会话数」，不是行数：两个会话各一张 Msg_ 表
    expect(r.involved_sessions).toBe(2)
    expect(r.top_contacts[0]).toMatchObject({ username: USER, count: 4 })
  })

  it('rowBudget 真正成为**读取**上界（改前是「先物化全表再 break」）', () => {
    const dec = makeDecrypted()
    seedMessages(dec, [
      { text: '手机 13800138000' },
      { text: '手机 13900139000' },
      { text: '手机 13700137000' },
    ])
    // 步进语义：scanned 先自增再判断，所以 budget=1 → 一行都不处理
    expect(queryPrivacyScan(dec, 1).total_hits).toBe(0)
    expect(queryPrivacyScan(dec, 2).total_hits).toBe(1)
    expect(queryPrivacyScan(dec, 100).total_hits).toBe(3)
  })
})

describe('N8：queryOverviewInsights 的朋友圈统计（游标读取的行为等价）', () => {
  it('媒体/视频/点赞/评论计数与逐行解析结果一致', () => {
    const dec = makeDecrypted()
    seedMessages(dec, [])
    const sdb = new DatabaseSync(join(dec, 'sns', 'db_sns', 'sns.db'))
    sdb.exec('CREATE TABLE SnsTimeLine (id INTEGER PRIMARY KEY, user_name TEXT, content TEXT)')
    const ins = sdb.prepare('INSERT INTO SnsTimeLine (user_name, content) VALUES (?, ?)')
    ins.run('wxid_b', '<media>a</media><type>6</type>')
    ins.run('wxid_b', '<LocalExtraInfo><type>1</type><user_comment>hi</user_comment><type>1</type></LocalExtraInfo>')
    ins.run('wxid_c', '<media >x</media ><LocalExtraInfo><type>1</type><user_comment>a</user_comment><user_comment>b</user_comment></LocalExtraInfo>')
    sdb.close()

    const r = queryOverviewInsights(dec)
    expect(r.moments.total, '三行都要被读到').toBe(3)
    expect(r.moments.images, '第 1 行 1 张 + 第 3 行 1 张').toBe(2)
    expect(r.moments.videos).toBe(1)
    expect(r.moments.likes, '第 1 行 0 + 第 2 行 2 + 第 3 行 1').toBe(3)
    expect(r.moments.comments, '第 2 行 max(0,1-2)=0 + 第 3 行 max(0,2-1)=1').toBe(1)
  })
})
