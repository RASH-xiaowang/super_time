/**
 * Contact 360° profile: cross-domain stats for one username — message count
 * and first/last time, moments count, transfer/red-packet row counts, and
 * shared groups. All reads are defensive against WeChat 4.x schema drift.
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Contact360Group, Contact360Snapshot } from '../types.ts'
import { contactMeta, shardCatalog } from './meta.ts'

/** Stringify a DB cell. */
function cellString(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map(r => r.name))
}

/** Msg_<md5(username)> table name for a talker. */
function msgTableName(username: string): string {
  return 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
}

/** Message count + first/last create_time across all shards for a talker. */
function messageStats(decryptedDir: string, username: string): { count: number; firstTime: number | null; lastTime: number | null } {
  const table = msgTableName(username)
  let count = 0
  let firstTime: number | null = null
  let lastTime: number | null = null
  for (const sh of shardCatalog(decryptedDir)) {
    const meta = sh.tables.get(table)
    if (!meta) continue
    let db: DatabaseSync
    try { db = new DatabaseSync(sh.file, { readOnly: true }) } catch { continue }
    try {
      const timeCol = meta.cols.has('create_time') ? 'create_time' : meta.cols.has('CreateTime') ? 'CreateTime' : ''
      const row = timeCol
        ? db.prepare(`SELECT COUNT(*) AS c, MIN(${timeCol}) AS mn, MAX(${timeCol}) AS mx FROM "${table}"`).get() as { c: number; mn: number | null; mx: number | null }
        : db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get() as { c: number; mn: null; mx: null }
      count += row.c
      if (row.mn != null) {
        firstTime = firstTime == null ? row.mn : Math.min(firstTime, row.mn)
      }
      if (row.mx != null) {
        lastTime = lastTime == null ? row.mx : Math.max(lastTime, row.mx)
      }
    } catch { /* skip shard */ } finally {
      db.close()
    }
  }
  return { count, firstTime, lastTime }
}

/** Count the author's moments from sns.db. */
function momentsCount(decryptedDir: string, username: string): number {
  for (const p of [join(decryptedDir, 'sns', 'db_sns', 'sns.db'), join(decryptedDir, 'sns', 'sns.db')]) {
    if (!existsSync(p)) continue
    try {
      const db = new DatabaseSync(p, { readOnly: true })
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined
      if (!has) { db.close(); continue }
      const cols = tableColumns(db, 'SnsTimeLine')
      const uname = cols.has('user_name') ? 'user_name' : cols.has('userName') ? 'userName' : ''
      if (!uname) { db.close(); continue }
      const row = db.prepare(`SELECT COUNT(*) AS n FROM SnsTimeLine WHERE ${uname} = ?`).get(username) as { n: number } | undefined
      db.close()
      return row?.n ?? 0
    } catch { /* try next path */ }
  }
  return 0
}

/** Transfer/red-packet row counts where the contact is the session. */
function fundsCount(decryptedDir: string, username: string): { transfers: number; redpackets: number } {
  const p = join(decryptedDir, 'general', 'general.db')
  if (!existsSync(p)) return { transfers: 0, redpackets: 0 }
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    let transfers = 0
    let redpackets = 0
    try {
      const cols = tableColumns(db, 'transferTable')
      if (cols.has('session_name')) {
        const row = db.prepare('SELECT COUNT(*) AS n FROM transferTable WHERE session_name = ?').get(username) as { n: number } | undefined
        transfers = row?.n ?? 0
      }
    } catch { /* transfer table unavailable */ }
    try {
      const cols = tableColumns(db, 'redEnvelopeTable')
      if (cols.has('session_name')) {
        const row = db.prepare('SELECT COUNT(*) AS n FROM redEnvelopeTable WHERE session_name = ?').get(username) as { n: number } | undefined
        redpackets = row?.n ?? 0
      }
    } catch { /* red envelope table unavailable */ }
    db.close()
    return { transfers, redpackets }
  } catch {
    return { transfers: 0, redpackets: 0 }
  }
}

/** Shared groups: chatroom_member -> chat_room, with member counts + names. */
function commonGroups(decryptedDir: string, username: string): Contact360Group[] {
  const p = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(p)) return []
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact'").get() !== undefined
    if (!has) { db.close(); return [] }
    const cols = tableColumns(db, 'contact')
    const userCol = cols.has('username') ? 'username' : cols.has('UserName') ? 'UserName' : ''
    if (!userCol) { db.close(); return [] }
    const contactNames = contactMeta(decryptedDir).names
    const me = db.prepare(`SELECT id FROM contact WHERE ${userCol} = ?`).get(username) as { id?: number } | undefined
    if (!me) { db.close(); return [] }
    const meId = me.id
    if (meId === undefined) { db.close(); return [] }
    const memberId = meId
    const rooms: Contact360Group[] = []
    try {
      const cmCols = tableColumns(db, 'chatroom_member')
      if (cmCols.has('room_id') && cmCols.has('member_id')) {
        const rows = db.prepare('SELECT room_id, COUNT(*) AS n FROM chatroom_member WHERE member_id = ? GROUP BY room_id').all(memberId) as Array<{ room_id: number; n: number }>
        const crCols = tableColumns(db, 'chat_room')
        const crUser = crCols.has('username') ? 'username' : crCols.has('UserName') ? 'UserName' : ''
        if (crUser) {
          for (const r of rows) {
            const room = db.prepare(`SELECT ${crUser} AS u FROM chat_room WHERE id = ?`).get(r.room_id) as { u?: unknown } | undefined
            if (!room) continue
            const ru = cellString(room.u)
            if (!ru) continue
            rooms.push({ username: ru, name: contactNames.get(ru) ?? ru, memberCount: r.n })
            if (rooms.length >= 10) break
          }
        }
      }
    } catch { /* group tables unavailable */ }
    db.close()
    return rooms
  } catch {
    return []
  }
}

/**
 * Compute the contact 360° profile snapshot.
 * @param decryptedDir - decrypted data root.
 * @param username - contact/chatroom username.
 * @returns the profile snapshot.
 */
export function queryContact360(decryptedDir: string, username: string): Contact360Snapshot {
  const msg = messageStats(decryptedDir, username)
  const funds = fundsCount(decryptedDir, username)
  return {
    username,
    displayName: contactMeta(decryptedDir).names.get(username) ?? username,
    messages: msg,
    moments: { count: momentsCount(decryptedDir, username) },
    funds,
    commonGroups: commonGroups(decryptedDir, username),
    updatedAt: Math.floor(Date.now() / 1000),
  }
}
