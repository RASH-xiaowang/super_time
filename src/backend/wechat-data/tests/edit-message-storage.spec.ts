/** Message edits must preserve SQLite storage type, compression flags and restore snapshots exactly. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as zlib from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { editChatMessage, listEditedMessages, resetEditedMessage } from '../src/query/edit.ts'

const roots: string[] = []
const zstd = zlib as unknown as {
  zstdCompressSync: (bytes: Buffer) => Buffer
  zstdDecompressSync: (bytes: Buffer) => Buffer
}

function tempRoot(): { root: string; decrypted: string; shard: string; table: string } {
  const root = mkdtempSync(join(tmpdir(), 'edit-storage-'))
  roots.push(root)
  const decrypted = join(root, 'decrypted')
  const shard = join(decrypted, 'message', 'message_0.db')
  const table = 'Msg_' + createHash('md5').update('wxid_a', 'utf8').digest('hex')
  mkdirSync(join(decrypted, 'message'), { recursive: true })
  return { root, decrypted, shard, table }
}

function makeDb(path: string, fn: (db: DatabaseSync) => void): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new DatabaseSync(path)
  try { fn(db) } finally { db.close() }
}

function schema(db: DatabaseSync, table: string, contentType = 'TEXT'): void {
  db.exec(`CREATE TABLE "${table}" (
    local_id INTEGER PRIMARY KEY,
    local_type INTEGER,
    message_content ${contentType},
    str_content TEXT,
    WCDB_CT_message_content INTEGER
  )`)
}

function rowOf(shard: string, table: string, localId = 1): Record<string, unknown> {
  const db = new DatabaseSync(shard, { readOnly: true })
  try {
    return db.prepare(`SELECT message_content, str_content, WCDB_CT_message_content FROM "${table}" WHERE local_id = ?`).get(localId) as Record<string, unknown>
  } finally {
    db.close()
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('message edit storage', () => {
  it('TEXT rows stay TEXT, update str_content, and restore every snapshotted cell', () => {
    const { decrypted, shard, table } = tempRoot()
    makeDb(shard, (db) => {
      schema(db, table)
      db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?, ?, ?)`).run(1, 1, '原文', '原文', 0)
    })

    expect(editChatMessage(decrypted, 'wxid_a', 1, '修改后的正文', 'text')).toEqual({ ok: true, localId: 1 })
    const edited = rowOf(shard, table)
    expect(edited['message_content']).toBe('修改后的正文')
    expect(edited['str_content']).toBe('修改后的正文')
    expect(edited['WCDB_CT_message_content']).toBe(0)
    expect(listEditedMessages(decrypted, 'wxid_a').total).toBe(1)

    expect(resetEditedMessage(decrypted, 'wxid_a', 1)).toEqual({ ok: true })
    const restored = rowOf(shard, table)
    expect(restored['message_content']).toBe('原文')
    expect(restored['str_content']).toBe('原文')
    expect(restored['WCDB_CT_message_content']).toBe(0)
    expect(listEditedMessages(decrypted, 'wxid_a').total).toBe(0)
  })

  it('zstd BLOB rows stay compressed BLOB with flag 4, including restore', () => {
    const { decrypted, shard, table } = tempRoot()
    const original = zstd.zstdCompressSync(Buffer.from('<msg>原文</msg>', 'utf8'))
    makeDb(shard, (db) => {
      schema(db, table, 'BLOB')
      db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?, ?, ?)`).run(1, 1, original, '<msg>原文</msg>', 4)
    })

    expect(editChatMessage(decrypted, 'wxid_a', 1, '<msg>修改源码</msg>', 'source')).toEqual({ ok: true, localId: 1 })
    const edited = rowOf(shard, table)
    expect(edited['message_content']).toBeInstanceOf(Uint8Array)
    expect(Number(edited['WCDB_CT_message_content'])).toBe(4)
    expect(zstd.zstdDecompressSync(Buffer.from(edited['message_content'] as Uint8Array)).toString('utf8'))
      .toBe('<msg>修改源码</msg>')
    expect(edited['str_content']).toBe('<msg>修改源码</msg>')

    expect(resetEditedMessage(decrypted, 'wxid_a', 1)).toEqual({ ok: true })
    const restored = rowOf(shard, table)
    expect(restored['message_content']).toBeInstanceOf(Uint8Array)
    expect(Number(restored['WCDB_CT_message_content'])).toBe(4)
    expect(Buffer.compare(Buffer.from(restored['message_content'] as Uint8Array), original)).toBe(0)
    expect(restored['str_content']).toBe('<msg>原文</msg>')
  })

  it('text mode rejects structured messages without touching the row or edit store', () => {
    const { decrypted, shard, table } = tempRoot()
    const payload = zstd.zstdCompressSync(Buffer.from('<msg><img /></msg>', 'utf8'))
    makeDb(shard, (db) => {
      schema(db, table, 'BLOB')
      db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?, ?, ?)`).run(1, 3, payload, '[图片]', 4)
    })

    const r = editChatMessage(decrypted, 'wxid_a', 1, '不能这样改', 'text')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('修改源码')
    expect(listEditedMessages(decrypted, 'wxid_a').total).toBe(0)
    const row = rowOf(shard, table)
    expect(Number(row['WCDB_CT_message_content'])).toBe(4)
    expect(Buffer.compare(Buffer.from(row['message_content'] as Uint8Array), payload)).toBe(0)
  })

  it('vector subset of local_type is recognized as plain text', () => {
    const { decrypted, shard, table } = tempRoot()
    makeDb(shard, (db) => {
      schema(db, table)
      db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?, ?, ?)`).run(1, 0x1_00000001, '原文', '原文', 0)
    })
    expect(editChatMessage(decrypted, 'wxid_a', 1, '低位类型为 1', 'text').ok).toBe(true)
    expect(rowOf(shard, table)['message_content']).toBe('低位类型为 1')
  })

  it('source mode remains available for structured text payloads', () => {
    const { decrypted, shard, table } = tempRoot()
    makeDb(shard, (db) => {
      schema(db, table)
      db.prepare(`INSERT INTO "${table}" VALUES (?, ?, ?, ?, ?)`).run(1, 49, '<msg><title>旧标题</title></msg>', '旧标题', 0)
    })
    expect(editChatMessage(decrypted, 'wxid_a', 1, '<msg><title>新标题</title></msg>', 'source').ok).toBe(true)
    expect(rowOf(shard, table)['message_content']).toBe('<msg><title>新标题</title></msg>')
  })
})
