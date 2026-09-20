/**
 * Unified search across local WeChat data domains: messages (index), contacts,
 * moments, favorites, files, and records. Every domain is best-effort and
 * returns its own typed hit shape; one failed domain never blocks the others.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type {
  UnifiedSearchContact,
  UnifiedSearchFavorite,
  UnifiedSearchFile,
  UnifiedSearchMoment,
  UnifiedSearchRecord,
  UnifiedSearchSnapshot,
} from '../types.ts'
import { searchIndexMessages } from './search.ts'
import { contactMeta } from './meta.ts'

/** Safe display wrapper: never throw; fall back to the raw username. */
function cellString(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  return ''
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map(r => r.name))
}

function like(q: string): string {
  return '%' + q + '%'
}

/** Contact names: remark > nick > username, plus category label. */
function searchContacts(decryptedDir: string, q: string, cap: number): UnifiedSearchContact[] {
  const p = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(p)) return []
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact'").get() !== undefined
    if (!has) { db.close(); return [] }
    const cols = tableColumns(db, 'contact')
    const userCol = cols.has('username') ? 'username' : cols.has('UserName') ? 'UserName' : ''
    const remarkCol = cols.has('remark') ? 'remark' : cols.has('Remark') ? 'Remark' : ''
    const nickCol = cols.has('nick_name') ? 'nick_name' : cols.has('NickName') ? 'NickName' : ''
    const aliasCol = cols.has('alias') ? 'alias' : ''
    const quanCol = cols.has('quan_pin') ? 'quan_pin' : ''
    // 第 86 轮：`remark_quan_pin` 是**备注**（列表里显示的那个名字）的拼音。
    // 此前只搜 `quan_pin`（昵称拼音）—— 全局搜索框的 placeholder 明写「联系人」，
    // 但按显示名的拼音搜不到（实测「桂西北_教练黄剑腾」搜 guixibeijiaolianhuangjianteng 无结果）。
    const remarkQuanCol = cols.has('remark_quan_pin') ? 'remark_quan_pin' : ''
    if (!userCol) { db.close(); return [] }
    const searchCols = [userCol, remarkCol, nickCol, aliasCol, quanCol, remarkQuanCol].filter(Boolean)
    const likeClauses = searchCols.map(c => `${c} LIKE ?`).join(' OR ')
    if (!likeClauses) { db.close(); return [] }
    const params = searchCols.map(() => like(q))
    const rows = db.prepare(`SELECT ${userCol} AS u, ${remarkCol || 'NULL'} AS r, ${nickCol || 'NULL'} AS n, ${aliasCol || 'NULL'} AS a FROM contact WHERE ${likeClauses} LIMIT ?`).all(...params, cap) as Array<Record<string, unknown>>
    db.close()
    return rows.map(r => ({
      username: cellString(r.u),
      name: cellString(r.r) || cellString(r.n) || cellString(r.a) || cellString(r.u),
      category: cellString(r.u).endsWith('@chatroom') ? 'group' : cellString(r.u).startsWith('gh_') ? 'official' : 'contact',
    }))
  } catch {
    return []
  }
}

/** Moments by author + content LIKE. */
function searchMoments(decryptedDir: string, q: string, cap: number): UnifiedSearchMoment[] {
  const dbPathCandidates = [join(decryptedDir, 'sns', 'db_sns', 'sns.db'), join(decryptedDir, 'sns', 'sns.db')]
  for (const p of dbPathCandidates) {
    if (!existsSync(p)) continue
    try {
      const db = new DatabaseSync(p, { readOnly: true })
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined
      if (!has) { db.close(); continue }
      const cols = tableColumns(db, 'SnsTimeLine')
      const uname = cols.has('user_name') ? 'user_name' : cols.has('userName') ? 'userName' : ''
      const content = cols.has('content') ? 'content' : cols.has('Content') ? 'Content' : ''
      if (!uname || !content) { db.close(); continue }
      // 作者显示名也要能搜：朋友圈面板内是按 `m.author`（解析后的显示名）过滤的，
      // 而这里原先只比正文 ⇒ 同一个词「面板内筛得出 57 条、全局搜索 0 条」。
      // 显示名存在通讯录里，做法是先把匹配的用户名算出来，再用 IN 精确命中。
      const names = contactMeta(decryptedDir).names
      const lower = q.trim().toLowerCase()
      const authorUsers = [...names.entries()]
        .filter(([, n]) => String(n).toLowerCase().includes(lower))
        .map(([u]) => u)
        .slice(0, 50)
      const kw = like(q)
      const inSql = authorUsers.length > 0 ? ' OR ' + uname + ' IN (' + authorUsers.map(() => '?').join(', ') + ')' : ''
      const rows = db.prepare(`SELECT ${uname} AS u, ${content} AS c FROM SnsTimeLine WHERE ${content} LIKE ? OR ${uname} LIKE ?${inSql} LIMIT ?`)
        .all(kw, kw, ...authorUsers, cap) as Array<{ u: unknown; c: unknown }>
      db.close()
      return rows.map((r) => {
        const username = cellString(r.u)
        return { username, name: names.get(username) ?? username, snippet: cellString(r.c).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) }
      })
    } catch { /* try next path */ }
  }
  return []
}

/** Favorites by content LIKE (fav_db_item in favorite.db). */
function searchFavorites(decryptedDir: string, q: string, cap: number): UnifiedSearchFavorite[] {
  const p = join(decryptedDir, 'favorite', 'favorite.db')
  if (!existsSync(p)) return []
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fav_db_item'").get() !== undefined
    if (!has) { db.close(); return [] }
    const cols = tableColumns(db, 'fav_db_item')
    const idCol = cols.has('local_id') ? 'local_id' : cols.has('Id') ? 'Id' : '0'
    const contentCol = cols.has('content') ? 'content' : cols.has('Content') ? 'Content' : ''
    if (!contentCol) { db.close(); return [] }
      // content 是收藏条目 XML（标题/描述就在里面），另加来源人 / 来源会话名，
      // 与「我的收藏」面板的搜索面（标题/描述/来源/正文/来源人/会话名）对齐。
    const cols2 = tableColumns(db, 'fav_db_item')
    const fromCol = cols2.has('fromusr') ? 'fromusr' : ''
    const chatCol = cols2.has('realchatname') ? 'realchatname' : ''
    const extraSql = [fromCol, chatCol].filter(Boolean).map(c => ' OR ' + c + ' LIKE ?').join('')
    const extraParams = [fromCol, chatCol].filter(Boolean).map(() => like(q))
    const rows = db.prepare(`SELECT ${idCol} AS id, ${contentCol} AS c FROM fav_db_item WHERE ${contentCol} LIKE ?${extraSql} LIMIT ?`)
      .all(like(q), ...extraParams, cap) as Array<{ id: unknown; c: unknown }>
    db.close()
    return rows.map(r => ({ id: Number(r.id ?? 0), snippet: cellString(r.c).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100) }))
  } catch {
    return []
  }
}

/** Files by file_name LIKE across hardlink tables. */
function searchFiles(decryptedDir: string, q: string, cap: number): UnifiedSearchFile[] {
  const p = join(decryptedDir, 'hardlink', 'hardlink.db')
  if (!existsSync(p)) return []
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    const out: UnifiedSearchFile[] = []
    for (const table of ['image_hardlink_info_v4', 'file_hardlink_info_v4', 'video_hardlink_info_v4']) {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
      if (!has) continue
      const cols = tableColumns(db, table)
      const nameCol = cols.has('file_name') ? 'file_name' : cols.has('fileName') ? 'fileName' : ''
      const md5Col = cols.has('md5') ? 'md5' : ''
      const sizeCol = cols.has('file_size') ? 'file_size' : cols.has('fileSize') ? 'fileSize' : '0'
      if (!nameCol) continue
      // md5 也参与匹配：与「文件资产」面板承诺的「搜索文件名 / MD5」对齐
      // （此前两边都搜不到 md5 —— 面板是 `||` 短路，全局是只比 file_name）。
      const md5Sql = md5Col ? ' OR ' + md5Col + ' LIKE ?' : ''
      const md5Param = md5Col ? [like(q)] : []
      const rows = db.prepare(`SELECT ${nameCol} AS n, ${md5Col || "'0'"} AS m, ${sizeCol} AS s FROM ${table} WHERE ${nameCol} LIKE ?${md5Sql} LIMIT ?`)
        .all(like(q), ...md5Param, cap - out.length) as Array<{ n: unknown; m: unknown; s: unknown }>
      for (const r of rows) {
        out.push({ fileName: cellString(r.n), md5: cellString(r.m), size: Number(r.s ?? 0) })
        if (out.length >= cap) break
      }
      if (out.length >= cap) break
    }
    db.close()
    return out
  } catch {
    return []
  }
}

/** Transfers/red packets whose session matches the query. */
function searchRecords(decryptedDir: string, q: string, cap: number): UnifiedSearchRecord[] {
  const p = join(decryptedDir, 'general', 'general.db')
  if (!existsSync(p)) return []
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    const out: UnifiedSearchRecord[] = []
    for (const [table, kind] of [['transferTable', 'transfers'], ['redEnvelopeTable', 'redpackets']] as const) {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
      if (!has) continue
      const cols = tableColumns(db, table)
      const sessionCol = cols.has('session_name') ? 'session_name' : cols.has('SessionName') ? 'SessionName' : ''
      if (!sessionCol) continue
      // 与「转账红包」面板对齐：转账还能按单号查、红包还能按发送人查
      const idCol = kind === 'transfers'
        ? (cols.has('transfer_id') ? 'transfer_id' : '')
        : (cols.has('sender_user_name') ? 'sender_user_name' : '')
      const extraSql = idCol ? ' OR ' + idCol + ' LIKE ?' : ''
      const extraParam = idCol ? [like(q)] : []
      const rows = db.prepare(`SELECT ${sessionCol} AS s FROM ${table} WHERE ${sessionCol} LIKE ?${extraSql} LIMIT ?`)
        .all(like(q), ...extraParam, cap - out.length) as Array<{ s: unknown }>
      for (const r of rows) {
        const session = cellString(r.s)
        if (!session) continue
        out.push({ kind, name: session, session })
        if (out.length >= cap) break
      }
      if (out.length >= cap) break
    }
    db.close()
    return out
  } catch {
    return []
  }
}

/**
 * Run the unified local search.
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits per domain (default 6).
 * @returns the unified snapshot.
 */
export function searchUnified(decryptedDir: string, query: string, limit?: number): UnifiedSearchSnapshot {
  const q = (query || '').trim()
  const cap = Math.min(limit ?? 6, 12)
  const messages = q ? searchIndexMessages(decryptedDir, q, cap).hits : []
  return {
    query: q,
    messages,
    contacts: q ? searchContacts(decryptedDir, q, cap) : [],
    moments: q ? searchMoments(decryptedDir, q, cap) : [],
    favorites: q ? searchFavorites(decryptedDir, q, cap) : [],
    files: q ? searchFiles(decryptedDir, q, cap) : [],
    records: q ? searchRecords(decryptedDir, q, cap) : [],
  }
}
