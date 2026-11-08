/**
 * Member / contact search (成员搜索). Uses the local contact_fts index in
 * wechat_search.db when available (built lazily on first use) and falls back to
 * a LIKE scan over contact.db; room-scoped searches join chatroom_member.
 *
 * 这里是 `wechat_search.db` 的**第二个写者**（第一个是 `search.ts` 的 `buildSearchIndex`），
 * 所以它的写必须走 `search.ts` 导出的那把索引库写闸（`withIndexWrite`）——
 * 否则构建在飞时写事务会被拒、然后被吞掉、静默退化成 LIKE。
 */
import { DatabaseSync } from './db-open.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { searchIndexPath, withIndexWrite } from './search.ts'
import type { MemberSearchHit, MemberSearchSnapshot } from '../types.ts'
import { loadOpenimDirectoryFromDb, type OpenimDirectory } from './openim.ts'
import { readableProfileSignature } from './profile-signature.ts'

const CONTACT_FTS_META = 'contact_rows'
/**
 * `contact_fts` 的** schema 版本**。
 *
 * v1 只有 `name` 是可检索列（`username/remark/alias/quanpin` 全 UNINDEXED），
 * 而 `name` 装的是 `remark ‖ nick_name ‖ username` —— 于是「按备注全拼 / 别名搜人」在
 * **索引健康时永远搜不到**，只有降级走 LIKE 才搜得到（第 96 轮那次修复只补到了 LIKE 那两条 SQL，
 * FTS 这条一直没补上）。同一句查询因索引在不在给出不同结果，比"两边都搜不到"更坏。
 * v2 把 `alias` 与 `quanpin` 也建成可检索列，并在查询里显式点名这三列。
 * v3 再加入企业微信的 `enterprise`，让企业名称既能展示也能参与搜索。
 * 版本变了就把旧的派生表丢掉重建（索引库任何时候都可从 contact.db 重算，无需保留）。
 */
const CONTACT_FTS_SCHEMA = 3
const CONTACT_FTS_SCHEMA_META = 'contact_fts_schema'

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

/** Column names for an existing table; an empty set means unusable/absent. */
function tableColumns(db: DatabaseSync, table: string): Set<string> {
  try {
    return new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name),
    )
  } catch {
    return new Set()
  }
}

/** Map raw contact rows to member-search hits. */
function hitsFromRows(
  rows: Array<Record<string, unknown>>,
  roomName?: string,
  enterpriseNames: ReadonlyMap<string, string> = new Map(),
): MemberSearchHit[] {
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
    const sig = readableProfileSignature(cellText(r['signature']))
    if (sig) hit.signature = sig
    const region = cellText(r['region']).trim()
    if (region) hit.region = region
    const enterpriseName = cellText(r['enterprise']).trim() || enterpriseNames.get(username)?.trim()
    if (enterpriseName) hit.enterpriseName = enterpriseName
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
 * contact_fts 是否已建好且**是当前 schema** —— 只读判断（不建表、不写 meta）。
 * @param db - 索引库连接。
 * @returns 索引存在、行数记录 > 0 且 schema 版本对得上时为 true。
 */
function contactFtsReady(db: DatabaseSync): boolean {
  if (!tableExists(db, 'meta') || !tableExists(db, 'contact_fts')) return false
  const row = db.prepare('SELECT value FROM meta WHERE key=?').get(CONTACT_FTS_META) as { value?: unknown } | undefined
  if (row === undefined || Number(row.value ?? 0) <= 0) return false
  // 旧 schema 的索引不算 ready：不这样判的话 v1 留下的表会一直被复用，
  // 「按全拼搜人」仍旧只在降级路径里成立。
  const v = db.prepare('SELECT value FROM meta WHERE key=?').get(CONTACT_FTS_SCHEMA_META) as { value?: unknown } | undefined
  return Number(v?.value ?? 0) === CONTACT_FTS_SCHEMA
}

/** 在闸内建 contact_fts（DDL + 插入 + COMMIT）。@returns ready / unavailable。 */
function buildContactFts(db: DatabaseSync, decryptedDir: string): 'ready' | 'unavailable' {
  const contactPath = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(contactPath)) return 'unavailable'
  let cdb: DatabaseSync | null = null
  let rows: Array<Record<string, unknown>>
  let directory: OpenimDirectory = { wordingNames: new Map(), enterpriseNames: new Map() }
  try {
    cdb = new DatabaseSync(contactPath, { readOnly: true })
    if (!tableExists(cdb, 'contact')) return 'unavailable'
    const cols = new Set(
      (cdb.prepare('PRAGMA table_info(contact)').all() as Array<{ name: string }>).map((row) => row.name),
    )
    const sel = (name: string): string => (cols.has(name) ? name : 'NULL')
    rows = cdb.prepare(
      `SELECT ${sel('username')} AS username, ${sel('remark')} AS remark, ${sel('nick_name')} AS nick_name, ` +
      `${sel('alias')} AS alias, ${sel('quan_pin')} AS quan_pin, ${sel('extra_buffer')} AS extra_buffer FROM contact`,
    ).all() as Array<Record<string, unknown>>
    directory = loadOpenimDirectoryFromDb(cdb)
  } catch (e) {
    console.warn('[members] contact.db 读不到，本次成员搜索回退 LIKE：' + (e as Error).message)
    return 'unavailable'
  } finally {
    try { cdb?.close() } catch { /* already closed */ }
  }
  try {
    db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    if (tableExists(db, 'contact_fts') && !contactFtsReady(db)) {
      // 旧 schema 的表是派生数据，丢掉重建比「留着但搜不到」诚实。
      db.exec('DROP TABLE contact_fts')
    }
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS contact_fts USING fts5(name, username UNINDEXED, remark UNINDEXED, alias, quanpin, enterprise, local_type UNINDEXED, tokenize='unicode61')")
    db.exec('BEGIN')
    try {
      const ins = db.prepare('INSERT INTO contact_fts(name, username, remark, alias, quanpin, enterprise, local_type) VALUES(?, ?, ?, ?, ?, ?, 0)')
      for (const r of rows) {
        const username = cellText(r['username']).trim()
        if (!username) continue
        ins.run(
          cellText(r['remark']).trim() || cellText(r['nick_name']).trim() || username,
          username,
          cellText(r['remark']).trim(),
          cellText(r['alias']).trim(),
          cellText(r['quan_pin']).trim(),
          directory.enterpriseNames.get(username) ?? '',
        )
      }
      db.exec('COMMIT')
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* no active tx */ }
      throw e
    }
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run(CONTACT_FTS_META, String(rows.length))
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run(CONTACT_FTS_SCHEMA_META, String(CONTACT_FTS_SCHEMA))
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
export function ensureContactFts(db: DatabaseSync, decryptedDir: string): ContactFtsState {
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
        // 三列分别点名：`name`（备注‖昵称‖username）、`alias`（别名）、`quanpin`（备注全拼）。
        // 只写 `"词"` 会退化成"只搜 name"，那正是 v1 搜不到全拼/别名的原因。
        const ftsCols = tableColumns(db, 'contact_fts')
        const searchable = ['name', 'alias', 'quanpin', 'enterprise'].filter(col => ftsCols.has(col))
        if (searchable.length === 0) {
          console.warn('[members] contact_fts 缺少可检索列，本次成员搜索回退 LIKE')
          return searchGlobalLike(decryptedDir, term, cap)
        }
        const phrase = '"' + term.replace(/"/g, '""') + '"'
        const match = searchable.map(col => `${col}:${phrase}`).join(' OR ')
        const select = (col: string): string => (ftsCols.has(col) ? col : 'NULL')
        const rows = db.prepare(
          `SELECT ${select('name')} AS name, ${select('username')} AS username, ` +
          `${select('remark')} AS remark, ${select('alias')} AS alias, ${select('enterprise')} AS enterprise ` +
          'FROM contact_fts WHERE contact_fts MATCH ? ORDER BY rank LIMIT ?',
        ).all(match, cap * 4) as Array<Record<string, unknown>>
        // 空命中**不**直接返回空：FTS5 是整词匹配，半截全拼（"wangxiaomi"）在索引里天然命中不了，
        // 得让 LIKE 兜一层，否则"装了索引"反而比没装搜得更少。代价是每次空命中多扫一遍 contact.db。
        if (rows.length > 0) {
          const items: MemberSearchHit[] = []
          const cdbPath = join(decryptedDir, 'contact', 'contact.db')
          let cdb: DatabaseSync | null = null
          try { cdb = new DatabaseSync(cdbPath, { readOnly: true }) } catch { cdb = null }
          const cdbCols = cdb && tableExists(cdb, 'contact') ? tableColumns(cdb, 'contact') : new Set<string>()
          const headSelect = cdbCols.has('username')
            ? [cdbCols.has('small_head_url') ? 'small_head_url' : 'NULL AS small_head_url',
              cdbCols.has('big_head_url') ? 'big_head_url' : 'NULL AS big_head_url'].join(', ')
            : ''
          const headStmt = cdb && headSelect !== ''
            ? cdb.prepare(`SELECT ${headSelect} FROM contact WHERE username=?`)
            : null
          try {
            for (const r of rows) {
              const username = cellText(r['username']).trim()
              if (!username) continue
              const hit: MemberSearchHit = { username, name: cellText(r['name']).trim() || username }
              const enterpriseName = cellText(r['enterprise']).trim()
              if (enterpriseName) hit.enterpriseName = enterpriseName
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
      const cols = tableColumns(db, 'contact')
      if (!cols.has('username')) return { items: [], total: 0, source: 'like' }
      const directory = loadOpenimDirectoryFromDb(db)
      const like = '%' + term + '%'
      const enterpriseUsers = [...directory.enterpriseNames]
        .filter(([, name]) => name.toLocaleLowerCase().includes(term.toLocaleLowerCase()))
        .map(([username]) => username)
      const enterpriseSql = enterpriseUsers.length > 0
        ? ` OR username IN (${enterpriseUsers.map(() => '?').join(', ')})`
        : ''
      const searchable = ['remark', 'nick_name', 'username', 'alias', 'quan_pin'].filter(col => cols.has(col))
      if (searchable.length === 0) return { items: [], total: 0, source: 'like' }
      const likeClauses = searchable.map(col => `${col} LIKE ?`).join(' OR ')
      const sel = (col: string): string => (cols.has(col) ? col : 'NULL')
      const order = [cols.has('remark') ? 'remark' : '', cols.has('nick_name') ? 'nick_name' : ''].filter(Boolean)
      const sql = `SELECT ${sel('username')} AS username, ${sel('remark')} AS remark, ` +
        `${sel('nick_name')} AS nick_name, ${sel('alias')} AS alias, ` +
        `${sel('small_head_url')} AS small_head_url, ${sel('big_head_url')} AS big_head_url ` +
        `FROM contact WHERE (${likeClauses}${enterpriseSql})` +
        (order.length > 0 ? ` ORDER BY ${order.join(', ')}` : '') + ' LIMIT ?'
      const rows = db.prepare(sql).all(
        ...searchable.map(() => like), ...enterpriseUsers, cap,
      ) as Array<Record<string, unknown>>
      return { items: hitsFromRows(rows, undefined, directory.enterpriseNames), total: rows.length, source: 'like' }
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
      const directory = loadOpenimDirectoryFromDb(db)
      const room = db.prepare('SELECT id FROM chat_room WHERE username=?').get(roomUsername) as { id?: number } | undefined
      if (room?.id === undefined) return { items: [], total: 0, source: 'like' }
      const cols = tableColumns(db, 'contact')
      if (!cols.has('username') || !cols.has('id')) return { items: [], total: 0, source: 'like' }
      const sel = (col: string): string => (cols.has(col) ? col : 'NULL')
      const display = db.prepare(
        `SELECT ${sel('nick_name')} AS nick_name, ${sel('remark')} AS remark FROM contact WHERE username=?`,
      ).get(roomUsername) as { nick_name?: unknown; remark?: unknown } | undefined
      const roomName = (display ? cellText(display.remark).trim() || cellText(display.nick_name).trim() : '') || roomUsername
      const like = '%' + term + '%'
      // 第 96 轮：这里原先只有 remark / nick_name / username，**漏了备注全拼 `quan_pin` 与别名 `alias`**，
      // 而全库那条路径（searchGlobalLike）两者都有 —— 结果是「按备注全拼在群里搜人」永远搜不到，
      // 全库搜却能搜到（同一类字段误用，藏在没人调用的路径里）。
      // 把关：`tests/members-search-columns.spec.ts`（三种列各自命中 + FTS 与 LIKE 结果一致 +
      // 旧 schema 索引被识别并重建）。注：此处原先指向 `scripts/` 下一个**从未存在过**的检查脚本，
      // 而它声称守着的 FTS 路径当时也确实没被任何用例碰过。
      // 群内这条**只有 LIKE、没有 FTS 分支**，所以上面那处 v1「可检索列」缺陷与它无关 ——
      // 别照着全库那条给这里"补索引"，这里要补的一向只是列清单。
      const enterpriseUsers = [...directory.enterpriseNames]
        .filter(([, name]) => name.toLocaleLowerCase().includes(term.toLocaleLowerCase()))
        .map(([username]) => username)
      const enterpriseSql = enterpriseUsers.length > 0
        ? ` OR c.username IN (${enterpriseUsers.map(() => '?').join(', ')})`
        : ''
      const searchable = ['remark', 'nick_name', 'username', 'alias', 'quan_pin'].filter(col => cols.has(col))
      if (searchable.length === 0) return { items: [], total: 0, source: 'like' }
      const likeClauses = searchable.map(col => `c.${col} LIKE ?`).join(' OR ')
      const order = [cols.has('remark') ? 'c.remark' : '', cols.has('nick_name') ? 'c.nick_name' : ''].filter(Boolean)
      const selC = (col: string): string => (cols.has(col) ? `c.${col}` : 'NULL')
      const sql = `SELECT ${selC('username')} AS username, ${selC('remark')} AS remark, ` +
        `${selC('nick_name')} AS nick_name, ${selC('small_head_url')} AS small_head_url, ` +
        `${selC('big_head_url')} AS big_head_url, cr.username AS room ` +
        'FROM chatroom_member m JOIN contact c ON c.id=m.member_id JOIN chat_room cr ON cr.id=m.room_id ' +
        `WHERE m.room_id=? AND (${likeClauses}${enterpriseSql})` +
        (order.length > 0 ? ` ORDER BY ${order.join(', ')}` : '') + ' LIMIT ?'
      const rows = db.prepare(sql).all(
        room.id, ...searchable.map(() => like), ...enterpriseUsers, cap,
      ) as Array<Record<string, unknown>>
      return { items: hitsFromRows(rows, roomName, directory.enterpriseNames), total: rows.length, source: 'like' }
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
