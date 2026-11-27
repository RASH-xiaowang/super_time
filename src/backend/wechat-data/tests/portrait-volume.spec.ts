/**
 * @vitest-environment node
 *
 * 好友目录按信息量排序的计数：只数请求里的人，图片按 local_type 低 32 位认，跨分片相加。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { queryPortraitVolumes } from '../src/query/portrait-volume.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 临时目录占用时不让清理失败盖住断言 */ }
  }
  scratch.length = 0
})

const tableOf = (username: string): string => 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')

function shard(root: string, file: string, rows: ReadonlyArray<{ user: string; types: number[] }>): void {
  const db = new DatabaseSync(join(root, 'message', file))
  for (const row of rows) {
    const table = tableOf(row.user)
    db.exec(`CREATE TABLE "${table}" (local_type INTEGER)`)
    const insert = db.prepare(`INSERT INTO "${table}" (local_type) VALUES (?)`)
    for (const type of row.types) insert.run(type)
  }
  db.close()
}

describe('queryPortraitVolumes', () => {
  it('按人和分片累加聊天与图片，忽略没点名的会话', () => {
    const root = mkdtempSync(join(tmpdir(), 'wx-volume-'))
    scratch.push(root)
    const decrypted = join(root, 'decrypted')
    mkdirSync(join(decrypted, 'message'), { recursive: true })
    shard(decrypted, 'msg_0.db', [
      { user: 'wxid_rich', types: [1, 1, 3, 3 + 4294967296] },
      { user: 'wxid_quiet', types: [1] },
      { user: 'wxid_other', types: [1, 1, 1, 1] },
    ])
    shard(decrypted, 'msg_1.db', [
      { user: 'wxid_rich', types: [1, 3] },
    ])

    const rows = queryPortraitVolumes(decrypted, ['wxid_quiet', 'wxid_rich', 'room@chatroom', ''])
    const byUser = new Map(rows.map((row) => [row.username, row]))
    expect(byUser.get('wxid_rich')).toEqual({ username: 'wxid_rich', messages: 6, images: 3, moments: 0 })
    expect(byUser.get('wxid_quiet')).toEqual({ username: 'wxid_quiet', messages: 1, images: 0, moments: 0 })
    expect(byUser.has('wxid_other')).toBe(false)
    expect(byUser.has('room@chatroom')).toBe(false)
  })
})
