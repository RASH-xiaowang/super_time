/**
 * queryRegionMap: builds world → country → province → city → friends tree from
 * a synthetic contact.db with region-bearing contacts.
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { queryRegionMap } from '../src/query/region-map.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** Encode a protobuf length-delimited string field. */
function pstring(field: number, value: string): Buffer {
  const tag = Buffer.from([(field << 3) | 2])
  const raw = Buffer.from(value, 'utf8')
  const len = Buffer.from([raw.length])
  return Buffer.concat([tag, len, raw])
}

/** Build a contact.extra_buffer with country(5)/province(6)/city(7). */
function extra(country?: string, province?: string, city?: string): Buffer {
  const parts: Buffer[] = []
  if (country) parts.push(pstring(5, country))
  if (province) parts.push(pstring(6, province))
  if (city) parts.push(pstring(7, city))
  return Buffer.concat(parts)
}

/** Create a synthetic contact.db, insert friend rows with regions. */
function makeContactDb(): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-region-'))
  scratch.push(root)
  const dir = join(root, 'contact')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'contact.db'))
  db.exec(`CREATE TABLE contact (
    id INTEGER PRIMARY KEY, username TEXT, local_type INTEGER, alias TEXT, delete_flag INTEGER,
    remark TEXT, nick_name TEXT, big_head_url TEXT, small_head_url TEXT, extra_buffer BLOB
  )`)
  const ins = db.prepare('INSERT INTO contact (id, username, local_type, remark, nick_name, extra_buffer) VALUES (?, ?, ?, ?, ?, ?)')
  ins.run(1, 'u_gx_nn_a', 1, '南宁甲', '', extra('CN', 'Guangxi', 'Nanning'))
  ins.run(2, 'u_gx_nn_b', 1, '南宁乙', '', extra('CN', 'Guangxi', 'Nanning'))
  ins.run(3, 'u_gx_hc', 1, '河池甲', '', extra('CN', 'Guangxi', 'Hechi'))
  ins.run(4, 'u_gd_gz', 1, '广州甲', '', extra('CN', 'Guangdong', 'Guangzhou'))
  ins.run(5, 'u_cn_noprov', 1, '仅国家', '', extra('CN'))
  ins.run(6, 'u_us', 1, '美国好友', '', extra('US'))
  // official account (local_type 1 but gh_) excluded
  ins.run(7, 'gh_abc', 1, '公众号', '', extra('CN', 'Guangdong', 'Guangzhou'))
  // admin/system excluded
  ins.run(8, 'weixin', 1, '系统', '', extra('CN'))
  // enterprise / kefu accounts excluded
  ins.run(9, 'u_ent@openim', 1, '企业', '', extra('CN', 'Guangdong', 'Guangzhou'))
  ins.run(10, 'u_kefu@kefu.openim', 1, '客服', '', extra('CN', 'Guangdong', 'Guangzhou'))
  db.close()
  return root
}

describe('queryRegionMap', () => {
  it('builds a world → country → province → city tree with friend lists', () => {
    const root = makeContactDb()
    const env = queryRegionMap(root)
    expect(env.total).toBe(6)
    expect(env.unknown).toBe(0)
    expect(env.world.name).toBe('世界')
    const cn = env.world.children.find(c => c.name === '中国')
    expect(cn).toBeDefined()
    // CN has 5 friends (4 with province + 1 country-only).
    expect(cn?.count).toBe(5)
    const gx = cn?.children.find(n => n.name === '广西')
    expect(gx?.count).toBe(3)
    const nn = gx?.children.find(n => n.name === '南宁')
    expect(nn?.count).toBe(2)
    expect(nn?.friends.map(f => f.username)).toEqual(['u_gx_nn_a', 'u_gx_nn_b'])
    const us = env.world.children.find(c => c.name === '美国')
    expect(us?.count).toBe(1)
    // Country-only contact lands under province/city fallback buckets.
    const cnOnly = cn?.children.find(n => n.name === '省份未填')
    expect(cnOnly?.children[0]?.name).toBe('城市未填')
    expect(cnOnly?.children[0]?.friends.map(f => f.username)).toEqual(['u_cn_noprov'])
    // Children sorted by count desc.
    expect(cn?.children[0]?.name).toBe('广西')
  })

  it('counts contacts without any country as unknown and skips them', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-region2-'))
    scratch.push(root)
    const dir = join(root, 'contact')
    mkdirSync(dir, { recursive: true })
    const db = new DatabaseSync(join(dir, 'contact.db'))
    db.exec(`CREATE TABLE contact (
      id INTEGER PRIMARY KEY, username TEXT, local_type INTEGER, alias TEXT, delete_flag INTEGER,
      remark TEXT, nick_name TEXT, big_head_url TEXT, small_head_url TEXT, extra_buffer BLOB
    )`)
    const ins = db.prepare('INSERT INTO contact (id, username, local_type, remark, nick_name, extra_buffer) VALUES (?, ?, ?, ?, ?, ?)')
    ins.run(1, 'u_no_region', 1, '无地区', '', Buffer.alloc(0))
    ins.run(2, 'u_cn', 1, '有地区', '', extra('CN'))
    db.close()
    const env = queryRegionMap(root)
    expect(env.total).toBe(1)
    expect(env.unknown).toBe(1)
    expect(env.world.count).toBe(1)
  })
})
