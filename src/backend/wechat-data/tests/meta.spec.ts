/**
 * Shared metadata cache: mtime-based invalidation for contact/shard maps.
 * @vitest-environment node
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { cachedBySig, contactMeta, shardCatalog, invalidateWechatMeta } from '../src/query/meta.ts'

const scratch: string[] = []
afterEach(() => {
  invalidateWechatMeta()
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-meta-'))
  scratch.push(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

function bumpMtime(path: string): void {
  const t = new Date(Date.now() + 1000)
  utimesSync(path, t, t)
}

describe('contactMeta cache', () => {
  it('reloads after contact.db changes (name map reflects new remark)', () => {
    const root = tempRoot()
    const p = join(root, 'contact', 'contact.db')
    makeDb(p, (db) => {
      db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT)')
      db.prepare('INSERT INTO contact VALUES (?,?,?)').run('wxid_a', '旧备注', '旧nick')
    })
    expect(contactMeta(root).names.get('wxid_a')).toBe('旧备注')
    makeDb(p, (db) => {
      db.exec('CREATE TABLE IF NOT EXISTS contact (username TEXT, remark TEXT, nick_name TEXT)')
      db.exec('DELETE FROM contact')
      db.prepare('INSERT INTO contact VALUES (?,?,?)').run('wxid_a', '新备注', '新nick')
    })
    bumpMtime(p)
    expect(contactMeta(root).names.get('wxid_a')).toBe('新备注')
  })

  it('reads pinned and biz types from the same contact.db pass', () => {
    const root = tempRoot()
    const p = join(root, 'contact', 'contact.db')
    makeDb(p, (db) => {
      db.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, flag INTEGER)')
      db.prepare('INSERT INTO contact VALUES (?,?,?,?)').run('wxid_a', 'A', '', 0x800)
      db.exec('CREATE TABLE biz_info (username TEXT, type INTEGER)')
      db.prepare('INSERT INTO biz_info VALUES (?,?)').run('gh_1', 1)
    })
    const meta = contactMeta(root)
    expect(meta.pinned.has('wxid_a')).toBe(true)
    expect(meta.bizTypes.get('gh_1')).toBe(1)
  })
})

describe('shardCatalog cache', () => {
  it('discovers tables across files and picks up newly added shards', () => {
    const root = tempRoot()
    const dir = join(root, 'message')
    mkdirSync(dir, { recursive: true })
    const a = join(dir, 'message_0.db')
    const b = join(dir, 'message_1.db')
    makeDb(a, (db) => { db.exec('CREATE TABLE Msg_a (id INTEGER)') })
    makeDb(b, (db) => { db.exec('CREATE TABLE Msg_b (id INTEGER)') })

    let cat = shardCatalog(root)
    expect(cat.length).toBe(2)
    const hasA = cat.some(s => s.tables.has('Msg_a'))
    const hasB = cat.some(s => s.tables.has('Msg_b'))
    expect(hasA).toBe(true)
    expect(hasB).toBe(true)

    const c = join(dir, 'message_2.db')
    makeDb(c, (db) => { db.exec('CREATE TABLE Msg_c (id INTEGER)') })
    // Directory mtime changes when a new file appears; the cache must refresh.
    bumpMtime(dir)
    cat = shardCatalog(root)
    expect(cat.some(s => s.tables.has('Msg_c'))).toBe(true)
  })
})

describe('cachedBySig', () => {
  it('serves the cached value for the same signature without re-running the loader', () => {
    let calls = 0
    const loader = (): string => { calls += 1; return 'v' }
    expect(cachedBySig('k', 'sig1', loader)).toBe('v')
    expect(cachedBySig('k', 'sig1', loader)).toBe('v')
    expect(calls).toBe(1)
  })

  it('recomputes when the signature changes', () => {
    let calls = 0
    const loader = (): number => { calls += 1; return calls }
    expect(cachedBySig('k2', 's1', loader)).toBe(1)
    expect(cachedBySig('k2', 's2', loader)).toBe(2)
    expect(calls).toBe(2)
  })

  it('evicts when invalidateWechatMeta is called', () => {
    let calls = 0
    const loader = (): number => { calls += 1; return calls }
    expect(cachedBySig('k3', 'sx', loader)).toBe(1)
    invalidateWechatMeta()
    expect(cachedBySig('k3', 'sx', loader)).toBe(2)
    expect(calls).toBe(2)
  })

  it('accepts a per-key maxAgeMs and still caches by signature', () => {
    let calls = 0
    const loader = (): number => { calls += 1; return calls }
    expect(cachedBySig('k-ttl', 's1', loader, 30_000)).toBe(1)
    expect(cachedBySig('k-ttl', 's1', loader, 30_000)).toBe(1)
    expect(calls).toBe(1)
  })
})
