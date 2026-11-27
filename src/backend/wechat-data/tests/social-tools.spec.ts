/**
 * 社交圈摘要：只统计最常联系的人和备注编号圈子，不重建整张关系图。
 *
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { getSocialSummaryTool } from '../src/query/tools/social-tools.ts'
import type { ToolContext } from '../src/query/tools/types.ts'

const scratch: string[] = []

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env['DSH_WECHAT_SELF_WXID']
})

function tempRoot(): { root: string; decrypted: string } {
  const root = mkdtempSync(join(tmpdir(), 'wx-social-'))
  scratch.push(root)
  const decrypted = join(root, 'decrypted')
  mkdirSync(join(decrypted, 'contact'), { recursive: true })
  return { root, decrypted }
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

function ctx(decryptedDir: string): ToolContext {
  return { decryptedDir, now: new Date('2026-11-26T10:00:00') }
}

describe('get_social_summary', () => {
  it('索引不存在时说明还不能统计，而不是假装没有联系人', () => {
    const { decrypted } = tempRoot()
    const result = getSocialSummaryTool.run({}, ctx(decrypted))
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('not_configured')
  })

  it('按消息数排出最熟的人，并把同一备注编号收成圈子', () => {
    process.env['DSH_WECHAT_SELF_WXID'] = 'wxid_me'
    const { root, decrypted } = tempRoot()
    makeDb(join(root, 'wechat_search.db'), (db) => {
      db.exec('CREATE TABLE message_meta (username TEXT, create_time INTEGER)')
      const insert = db.prepare('INSERT INTO message_meta (username, create_time) VALUES (?, 1)')
      for (let i = 0; i < 5; i++) insert.run('wxid_a')
      for (let i = 0; i < 3; i++) insert.run('wxid_b')
      insert.run('wxid_c')
      for (let i = 0; i < 9; i++) insert.run('wxid_me')
      for (let i = 0; i < 20; i++) insert.run('room@chatroom')
    })
    makeDb(join(decrypted, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT)')
      const insert = db.prepare('INSERT INTO contact (username, remark, nick_name) VALUES (?, ?, ?)')
      insert.run('wxid_a', '宜州一中404张三', '张三')
      insert.run('wxid_b', '宜州一中404李四', '李四')
      insert.run('wxid_c', '朋友', '王五')
    })
    const result = getSocialSummaryTool.run({}, ctx(decrypted))
    expect(result.ok).toBe(true)
    expect(result.hits.map(hit => hit.name)).toEqual(['张三', '李四', '王五', '宜州一中404'])
    expect(result.hits[0]?.snippet).toContain('5 条消息')
    expect(result.hits.find(hit => hit.name === '宜州一中404')?.snippet).toContain('张三')
    expect(result.hits.some(hit => hit.name === 'wxid_me' || hit.snippet.includes('room@chatroom'))).toBe(false)
    expect(result.facts?.some(fact => fact.title === '备注圈子')).toBe(true)
  })

  it('query 只留下名字对得上的人和圈子', () => {
    process.env['DSH_WECHAT_SELF_WXID'] = 'wxid_me'
    const { root, decrypted } = tempRoot()
    makeDb(join(root, 'wechat_search.db'), (db) => {
      db.exec('CREATE TABLE message_meta (username TEXT, create_time INTEGER)')
      db.prepare('INSERT INTO message_meta (username, create_time) VALUES (?, 1)').run('wxid_a')
      db.prepare('INSERT INTO message_meta (username, create_time) VALUES (?, 1)').run('wxid_b')
    })
    makeDb(join(decrypted, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT)')
      db.prepare('INSERT INTO contact (username, remark, nick_name) VALUES (?, ?, ?)').run('wxid_a', '宜州一中404张三', '张三')
      db.prepare('INSERT INTO contact (username, remark, nick_name) VALUES (?, ?, ?)').run('wxid_b', '', '李四')
    })
    const result = getSocialSummaryTool.run({ query: '李四' }, ctx(decrypted))
    expect(result.ok).toBe(true)
    expect(result.hits.map(hit => hit.name)).toEqual(['李四'])
  })

  it('多级备注去掉姓名后成圈，不同办事处不并在一起', () => {
    process.env['DSH_WECHAT_SELF_WXID'] = 'wxid_me'
    const { root, decrypted } = tempRoot()
    makeDb(join(root, 'wechat_search.db'), (db) => {
      db.exec('CREATE TABLE message_meta (username TEXT, create_time INTEGER)')
      const insert = db.prepare('INSERT INTO message_meta (username, create_time) VALUES (?, 1)')
      insert.run('wxid_a')
      insert.run('wxid_b')
      insert.run('wxid_c')
    })
    makeDb(join(decrypted, 'contact', 'contact.db'), (db) => {
      db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT)')
      const insert = db.prepare('INSERT INTO contact (username, remark, nick_name) VALUES (?, ?, ?)')
      insert.run('wxid_a', '法院_梧州万秀_会计小郭', '小郭')
      insert.run('wxid_b', '法院_梧州万秀_出纳小李', '小李')
      insert.run('wxid_c', '法院_来宾市区_会计小王', '小王')
    })
    const result = getSocialSummaryTool.run({}, ctx(decrypted))
    expect(result.ok).toBe(true)
    const circles = result.hits.filter(hit => hit.key.startsWith('social:circle:')).map(hit => hit.name)
    expect(circles).toEqual(['法院_梧州万秀'])
  })
})
