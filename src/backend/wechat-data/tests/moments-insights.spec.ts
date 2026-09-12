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
  it('counts likes/comments and returns today items', () => {
    const root = tempRoot()
    const now = new Date()
    const todayTs = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12).getTime() / 1000)
    const oldTs = Math.floor(new Date(2020, now.getMonth(), now.getDate() + 1, 12).getTime() / 1000)
    makeDb(join(root, 'sns', 'db_sns', 'sns.db'), (db) => {
      db.exec('CREATE TABLE SnsTimeLine (tid INTEGER, user_name TEXT, content TEXT)')
      db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?)').run(1, 'wxid_a', postXml(todayTs))
      db.prepare('INSERT INTO SnsTimeLine VALUES (?, ?, ?)').run(2, 'wxid_a', postXml(oldTs))
    })

    const snap = queryMomentsInsights(root, 'wxid_a')
    expect(snap.posts).toBe(2)
    expect(snap.likes).toBe(2)
    expect(snap.comments).toBe(2)
    expect(snap.likedBy[0]?.nickname).toBe('李四')
    expect(snap.commenters[0]?.count).toBe(2)
    expect(snap.today).toHaveLength(1)
    expect(snap.today[0]?.text).toContain('今天发布')
  })
})
