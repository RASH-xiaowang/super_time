/**
 * Asset insights over a minimal fixture: favorite type/year counts, emoticon
 * table sizes and top-used emoticon md5s.
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { queryAssetInsights } from '../src/query/asset-insights.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-asset-'))
  scratch.push(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

describe('queryAssetInsights', () => {
  it('aggregates favorites, emoticons and usage', () => {
    const root = tempRoot()
    const msgTable = 'Msg_' + createHash('md5').update('wxid_a', 'utf8').digest('hex')
    const ts = Math.floor(new Date(2026, 8, 1).getTime() / 1000)
    makeDb(join(root, 'favorite', 'favorite.db'), (db) => {
      db.exec('CREATE TABLE fav_db_item (type INTEGER, update_time INTEGER)')
      db.prepare('INSERT INTO fav_db_item VALUES (?, ?)').run(1, ts)
      db.prepare('INSERT INTO fav_db_item VALUES (?, ?)').run(1, ts)
    })
    makeDb(join(root, 'emoticon', 'emoticon.db'), (db) => {
      db.exec('CREATE TABLE kNonStoreEmoticonTable (md5 TEXT)')
      db.prepare('INSERT INTO kNonStoreEmoticonTable VALUES (?)').run('a'.repeat(16))
      db.exec('CREATE TABLE kStoreEmoticonPackageTable (package_id_ TEXT)')
      db.prepare('INSERT INTO kStoreEmoticonPackageTable VALUES (?)').run('pkg1')
      db.exec('CREATE TABLE kStoreEmoticonCaptionsTable (md5 TEXT)')
      db.prepare('INSERT INTO kStoreEmoticonCaptionsTable VALUES (?)').run('c1')
    })
    makeDb(join(root, 'message', 'message_1.db'), (db) => {
      db.exec(`CREATE TABLE "${msgTable}" (local_id INTEGER, create_time INTEGER, local_type INTEGER, message_content TEXT)`)
      db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?, ?)`).run(1, ts, 47, '<emoji md5="abcdef1234567890"/>')
      db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?, ?)`).run(2, ts, 47, '<emoji md5="abcdef1234567890"/>')
    })

    const snap = queryAssetInsights(root)
    expect(snap.favorites.total).toBe(2)
    expect(snap.favorites.byType.find(t => t.label === '文本')?.count).toBe(2)
    expect(snap.favorites.byYear[0]?.year).toBe(2026)
    expect(snap.emoticons.customCount).toBe(1)
    expect(snap.emoticons.storePackages).toBe(1)
    expect(snap.emoticons.captions).toBe(1)
    expect(snap.emoticons.topUsed[0]?.md5).toBe('abcdef1234567890')
    expect(snap.emoticons.topUsed[0]?.count).toBe(2)
  })
})
