/**
 * resolveImageResourceHint over a minimal decrypted fixture: the image MD5
 * lookup must find the shard via the shared shard catalog (no per-shard
 * probing of unrelated databases) and return null when the row is absent.
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveImageResourceHint } from '../src/query/media-image.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

/** packed_info 的 st_control 逗号分隔字节文本形式。 */
function packedHex(hex: string): string {
  return Array.from(Buffer.from(hex, 'utf8')).join(',')
}

describe('resolveImageResourceHint', () => {
  it('resolves the image MD5 from the shard catalog', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-img-'))
    scratch.push(root)
    const md5 = 'aabbccddeeff00112233445566778899'
    const table = 'Msg_' + createHash('md5').update('wxid_a', 'utf8').digest('hex')
    makeDb(join(root, 'message', 'message_1.db'), (db) => {
      db.exec(`CREATE TABLE "${table}" (local_id INTEGER, local_type INTEGER, packed_info_data TEXT)`)
      db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?)`).run(1, 3, packedHex(md5))
    })
    // 无关分片：不含目标表，探测时不应报错也不应命中。
    makeDb(join(root, 'message', 'message_2.db'), (db) => {
      db.exec('CREATE TABLE Msg_00000000000000000000000000000000 (local_id INTEGER)')
    })
    expect(resolveImageResourceHint(root, 'wxid_a', 1).md5).toBe(md5)
  })

  it('returns null when no row matches', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-img-'))
    scratch.push(root)
    const table = 'Msg_' + createHash('md5').update('wxid_a', 'utf8').digest('hex')
    makeDb(join(root, 'message', 'message_1.db'), (db) => {
      db.exec(`CREATE TABLE "${table}" (local_id INTEGER, local_type INTEGER, packed_info_data TEXT)`)
    })
    expect(resolveImageResourceHint(root, 'wxid_a', 999)).toEqual({ md5: null, dataIndex: '' })
  })
})
