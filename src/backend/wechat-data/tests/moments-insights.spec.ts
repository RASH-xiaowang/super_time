/**
 * Moments insights over a minimal sns fixture: likes/comments parsing and
 * today's items.
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { queryMomentsInsights } from '../src/query/moments-insights.ts'
import { queryMoments } from '../src/query/moments.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-mi-'))
  scratch.push(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

function postXml(ts: number): string {
  return `<contentDesc>今天发布</contentDesc><createTime>${ts}</createTime><LocalExtraInfo><comment_user_list><user_comment><comment_id>1</comment_id><username>wxid_b</username><nickname>李四</nickname><content>好</content><create_time>${ts}</create_time><type>1</type></user_comment><user_comment><comment_id>2</comment_id><username>wxid_b</username><nickname>李四</nickname><content>赞</content><create_time>${ts}</create_time><type>2</type></user_comment></comment_user_list></LocalExtraInfo>`
}

describe('queryMomentsInsights', () => {
  it('counts likes/comments and returns today items', async () => {
    const root = tempRoot()
    const now = new Date()
    const todayTs = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime() / 1000)
    const oldTs = Math.floor(new Date(2020, now.getMonth(), now.getDate() + 1, 12).getTime() / 1000)
    makeDb(join(root, 'sns', 'db_sns', 'sns.db'), (db) => {
      db.exec('CREATE TABLE SnsTimeLine (tid INTEGER, user_name TEXT, content TEXT)')
      db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?)').run(1, 'wxid_a', postXml(todayTs))
      db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?)').run(2, 'wxid_a', postXml(oldTs))
    })

    // 2026-09-28：改成 async 是为了在整张 SnsTimeLine 的游标上加让出点
    // （实测冷跑 228ms 且一次不让出，排在串行 worker 上会堵住后面所有 RPC）。
    const snap = await queryMomentsInsights(root, 'wxid_a')
    expect(snap.posts).toBe(2)
    expect(snap.likes).toBe(2)
    expect(snap.comments).toBe(2)
    expect(snap.likedBy[0]?.nickname).toBe('李四')
    expect(snap.commenters[0]?.count).toBe(2)
    expect(snap.today).toHaveLength(1)
    expect(snap.today[0]?.text).toContain('今天发布')
  })

  it('好友删帖后，洞察仍从归档计入（删掉整张 sns.db 也成立）', async () => {
    const root = tempRoot()
    const now = new Date()
    const ts = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime() / 1000)
    makeDb(join(root, 'sns', 'db_sns', 'sns.db'), (db) => {
      db.exec('CREATE TABLE SnsTimeLine (tid INTEGER, user_name TEXT, content TEXT)')
      db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?)').run(1, 'wxid_a', postXml(ts))
    })
    // 先让归档库收下这条（真实链路就是 queryMoments 触发归档）。
    expect(queryMoments(root, 0, 50, 'wxid_a').total).toBe(1)
    rmSync(join(root, 'sns'), { recursive: true, force: true })

    const snap = await queryMomentsInsights(root, 'wxid_a')
    expect(snap.posts, '删帖后洞察不该退回 0').toBe(1)
    expect(snap.likes).toBe(1)
    expect(snap.comments).toBe(1)
    expect(snap.likedBy[0]?.nickname).toBe('李四')
    expect(snap.monthly[0]?.count).toBe(1)
    expect(snap.today).toHaveLength(1)
  })
})
