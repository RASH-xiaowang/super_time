/**
 * Member / contact search (成员搜索). Uses the local contact_fts index in
 * wechat_search.db when available (built lazily on first use) and falls back to
 * a LIKE scan over contact.db; room-scoped searches join chatroom_member.
 *
 * 这里是 `wechat_search.db` 的**第二个写者**（第一个是 `search.ts` 的 `buildSearchIndex`），
 * 所以它的写必须走 `search.ts` 导出的那把索引库写闸（`withIndexWrite`）——
 * 否则构建在飞时写事务会被拒、然后被吞掉、静默退化成 LIKE。
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { searchIndexPath, withIndexWrite } from './search.ts'
import type { MemberSearchHit, MemberSearchSnapshot } from '../types.ts'

const CONTACT_FTS_META = 'contact_rows'

/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/** Whether a table exists in this database. */
function tableExists(db: DatabaseSync, table: string): boolean {
  try {
    return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
  } catch {
    return false
  }
}

/** Map raw contact rows to member-search hits. */
function hitsFromRows(rows: Array<Record<string, unknown>>, roomName?: string): MemberSearchHit[] {
  const out: MemberSearchHit[] = []
  for (const r of rows) {
    const username = cellText(r['username']).trim()
    if (!username) continue
    const name = cellText(r['remark']).trim() || cellText(r['nick_name']).trim() || username
    const hit: MemberSearchHit = { username, name }
    const head = cellText(r['small_head_url']).trim() || cellText(r['big_head_url']).trim()
    if (head) hit.head = head
    const room = cellText(r['room']).trim()
    if (room) hit.roomUsername = room
    if (roomName) hit.roomName = roomName
    const sig = cellText(r['signature']).trim()
    if (sig) hit.signature = sig
    const region = cellText(r['region']).trim()
    if (region) hit.region = region
    out.push(hit)
  }
  return out
}

/**
 * contact_fts 的可用状态。
 * - `ready`：已有索引可读（本次调用**没有**写索引库）。
 * - `busy`：索引库写闸拿不到（建索引在飞），本次**没有**尝试写。
 * - `unavailable`：没有可用的 contact.db 或构建失败（已打日志，不静默）。
 */
type ContactFtsState = 'ready' | 'busy' | 'unavailable'

/**
 * contact_fts 是否已建好 —— **只读**判断（不建表、不写 meta）。
 * @param db - 索引库连接。
 * @returns 索引存在且行数记录 > 0 时为 true。
 */
function contactFtsReady(db: DatabaseSync): boolean {
  if (!tableExists(db, 'meta') || !tableExists(db, 'contact_fts')) return false
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(CONTACT_FTS_META) as { value?: unknown } | undefined
  return row !== undefined && Number(row.value ?? 0) > 0
}

/** 在闸内建 contact_fts（DDL + 插入 + COMMIT）。@returns ready / unavailable。 */
function buildContactFts(db: DatabaseSync, decryptedDir: string): 'ready' | 'unavailable' {
  const contactPath = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(contactPath)) return 'unavailable'
  let cdb: DatabaseSync | null = null
  let rows: Array<Record<string, unknown>>
  try {
    cdb = new DatabaseSync(contactPath, { readOnly: true })
    if (!tableExists(cdb, 'contact')) return 'unavailable'
    rows = cdb.prepare('SELECT username, remark, nick_name, alias, quan_pin FROM contact').all() as Array<Record<string, unknown>>
  } catch (e) {
    console.warn('[members] contact.db 读不到，本次成员搜索回退 LIKE：' + (e as Error).message)
    return 'unavailable'
  } finally {
    try { cdb?.close() } catch { /* already closed */ }
  }
  try {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS contact_fts USING fts5(name, username UNINDEXED, remark UNINDEXED, alias UNINDEXED, quanpin UNINDEXED, local_type UNINDEXED, tokenize='unicode61')")
    db.exec('BEGIN')
    try {
      const ins = db.prepare('INSERT INTO contact_fts(name, username, remark, alias, quanpin, local_type) VALUES(?, ?, ?, ?, ?, 0)')
      for (const r of rows) {
        const username = cellText(r['username']).trim()
        if (!username) continue
        ins.run(cellText(r['remark']).trim() || cellText(r['nick_name']).trim() || username, username, cellText(r['remark']).trim(), cellText(r['alias']).trim(), cellText(r['quan_pin']).trim())
      }
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* no active tx */ }
      throw e
    }
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run(CONTACT_FTS_META, String(rows.length))
    return 'ready'
  } catch (e) {
    // 写失败（例如跨进程写锁）不再静默：留痕 + 由调用方回退 LIKE。
    console.warn('[members] contact_fts 构建失败，本次成员搜索回退 LIKE：' + (e as Error).message)
    return 'unavailable'
  }
}

/**
 * 确保 contact_fts 可用。
 *
 * 为什么先只读判断：`contact_fts` 已经建好时，改前那两句 `CREATE ... IF NOT EXISTS` 其实是纯读
 * （实测：另一连接持写锁时它们不报错）；**只有真要建表时**才需要写锁，那时构建在飞就会被拒
 * （`database is locked`）—— 条目里 155/155 次退化正是「索引还没建出来的那个窗口」。所以：
 * 已经建好就只读照用（构建期间成员搜索也不必降级），要建/重建才进写闸。
 *
 * 真要写时也不能去撞锁：`searchMembers` 是同步契约，排不了队。拿不到闸就返回 `busy`，
 * 由调用方显式降级并留痕（见 searchGlobalMembers）。
 * @param db - 以读写方式打开的索引库连接。
 * @param decryptedDir - 已解密数据根（用于定位 contact.db）。
 * @returns contact_fts 的可用状态。
 */
function ensureContactFts(db: DatabaseSync, decryptedDir: string): ContactFtsState {
  if (contactFtsReady(db)) return 'ready'
  const gated = withIndexWrite(decryptedDir, () => buildContactFts(db, decryptedDir))
  if (!gated.ok) return 'busy'
  return gated.value
}

/**
 * Global search: prefer contact_fts, otherwise LIKE over contact.db.
 * @param decryptedDir - decrypted data root.
 * @param term - search term.
 * @param cap - max hits.
 * @returns matching members + total + source.
 */
function searchGlobalMembers(decryptedDir: string, term: string, cap: number): MemberSearchSnapshot {
  const p = searchIndexPath(decryptedDir)
  if (existsSync(p)) {
    let db: DatabaseSync | null = null
    try {
      db = new DatabaseSync(p)
      const state = ensureContactFts(db, decryptedDir)
      if (state === 'busy') {
        // 构建在飞：闸拿不到（同步契约排不了队）。这里**显式**降级并把原因写进日志 ——
        // 改前是「先尝试建表 → 被拒 → 外层 catch 静默退回 LIKE」，在这个窗口里每次调用都重现一遍。
        console.warn('[members] 搜索索引构建在飞，本次成员搜索显式走 LIKE（未尝试写 contact_fts）')
        return searchGlobalLike(decryptedDir, term, cap)
      }
      if (state === 'ready') {
        const escaped = '"' + term.replace(/"/g, '""') + '"'
        const rows = db.prepare('SELECT name, username, remark, alias FROM contact_fts WHERE contact_fts MATCH ? ORDER BY rank LIMIT ?').all(escaped, cap * 4) as Array<Record<string, unknown>>
        if (rows.length > 0) {
          const items: MemberSearchHit[] = []
          const cdbPath = join(decryptedDir, 'contact', 'contact.db')
          let cdb: DatabaseSync | null = null
          try { cdb = new DatabaseSync(cdbPath, { readOnly: true }) } catch { cdb = null }
          const headStmt = cdb && tableExists(cdb, 'contact') ? cdb.prepare('SELECT small_head_url, big_head_url FROM contact WHERE username=?') : null
          try {
            for (const r of rows) {
              const username = cellText(r['username']).trim()
              if (!username) continue
              const hit: MemberSearchHit = { username, name: cellText(r['name']).trim() || username }
              if (headStmt) {
                try {
                  const hr = headStmt.get(username) as { small_head_url?: unknown; big_head_url?: unknown } | undefined
                  const head = cellText(hr?.small_head_url ?? '').trim() || cellText(hr?.big_head_url ?? '').trim()
                  if (head) hit.head = head
                } catch { /* skip */ }
              }
              items.push(hit)
            }
          } finally {
            try { cdb?.close() } catch { /* already closed */ }
          }
          return { items: items.slice(0, cap), total: items.length, source: 'fts' }
        }
      }
    } catch (e) {
      console.warn('[members] contact_fts 查询失败，本次成员搜索回退 LIKE：' + (e as Error).message)
    } finally {
      try { db?.close() } catch { /* already closed */ }
    }
  }
  return searchGlobalLike(decryptedDir, term, cap)
}

/** LIKE fallback over contact.db (remark / nick / username / alias / quan_pin). */
function searchGlobalLike(decryptedDir: string, term: string, cap: number): MemberSearchSnapshot {
  const p = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(p)) return { items: [], total: 0, source: 'like' }
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    try {
      if (!tableExists(db, 'contact')) return { items: [], total: 0, source: 'like' }
      const like = '%' + term + '%'
      const sql = 'SELECT username, remark, nick_name, alias, small_head_url, big_head_url FROM contact WHERE remark LIKE ? OR nick_name LIKE ? OR username LIKE ? OR alias LIKE ? OR quan_pin LIKE ? ORDER BY remark, nick_name LIMIT ?'
      const rows = db.prepare(sql).all(like, like, like, like, like, cap) as Array<Record<string, unknown>>
      return { items: hitsFromRows(rows), total: rows.length, source: 'like' }
    } finally {
      db.close()
    }
  } catch {
    return { items: [], total: 0, source: 'like' }
  }
}

/** Room-scoped search: chatroom_member join contact + chat room display name. */
function searchRoomMembers(decryptedDir: string, roomUsername: string, term: string, cap: number): MemberSearchSnapshot {
  const p = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(p)) return { items: [], total: 0, source: 'like' }
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    try {
      if (!tableExists(db, 'chat_room') || !tableExists(db, 'chatroom_member') || !tableExists(db, 'contact')) {
        return { items: [], total: 0, source: 'like' }
      }
      const room = db.prepare('SELECT id FROM chat_room WHERE username=?').get(roomUsername) as { id?: number } | undefined
      if (room?.id === undefined) return { items: [], total: 0, source: 'like' }
      const display = db.prepare('SELECT nick_name, remark FROM contact WHERE username=?').get(roomUsername) as { nick_name?: unknown; remark?: unknown } | undefined
      const roomName = (display ? cellText(display.remark).trim() || cellText(display.nick_name).trim() : '') || roomUsername
      const like = '%' + term + '%'
      // 第 96 轮：这里原先只有 remark / nick_name / username，**漏了备注全拼 `quan_pin` 与别名 `alias`**，
      // 而全库那条路径（searchGlobalLike）两者都有 —— 结果是「按备注全拼在群里搜人」永远搜不到，
      // 全库搜却能搜到（同一类字段误用，藏在没人调用的路径里）。
      // 由 scripts/check-members-search.js 对着真实库把关。
      const sql = 'SELECT c.username, c.remark, c.nick_name, c.small_head_url, c.big_head_url, cr.username AS room FROM chatroom_member m JOIN contact c ON c.id=m.member_id JOIN chat_room cr ON cr.id=m.room_id WHERE m.room_id=? AND (c.remark LIKE ? OR c.nick_name LIKE ? OR c.username LIKE ? OR c.alias LIKE ? OR c.quan_pin LIKE ?) ORDER BY c.remark, c.nick_name LIMIT ?'
      const rows = db.prepare(sql).all(room.id, like, like, like, like, like, cap) as Array<Record<string, unknown>>
      return { items: hitsFromRows(rows, roomName), total: rows.length, source: 'like' }
    } finally {
      db.close()
    }
  } catch {
    return { items: [], total: 0, source: 'like' }
  }
}

/**
 * Search contacts / group members.
 * @param decryptedDir - decrypted data root.
 * @param q - search term (name/remark/username/alias/pinyin).
 * @param opts - optional limit and room scope (roomUsername).
 * @returns matching members + total + source.
 */
export function searchMembers(
  decryptedDir: string,
  q: string,
  opts?: { limit?: number; roomUsername?: string },
): MemberSearchSnapshot {
  const term = q.trim()
  if (!term) return { items: [], total: 0, source: 'like' }
  const cap = Math.min(opts?.limit ?? 50, 200)
  if (opts?.roomUsername) return searchRoomMembers(decryptedDir, opts.roomUsername, term, cap)
  return searchGlobalMembers(decryptedDir, term, cap)
}
