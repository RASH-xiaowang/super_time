/**
 * Offline group insights for one chatroom: total/active-day stats, member
 * activity ranks, and the group announcement. Sender identity is extracted
 * from the message-content prefix (`wxid_xxx:\n`) which is reliable for
 * 4.x chatroom rows; Name2Id resolution can be added later.
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decompress } from 'fzstd'
import type { GroupInsightsMember, GroupInsightsSnapshot } from '../types.ts'
import { contactMeta } from './meta.ts'

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

function decodeCell(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  const raw = Buffer.from(v instanceof Uint8Array ? v : [])
  const decompressed = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC)
    ? (() => { try { return Buffer.from(decompress(raw)) } catch { return raw } })()
    : raw
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(decompressed)
  } catch {
    return new TextDecoder('gbk', { fatal: false }).decode(decompressed)
  }
}

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map(r => r.name))
}

function groupDisplayName(decryptedDir: string, username: string): string {
  return contactMeta(decryptedDir).names.get(username) || username
}

function memberCount(decryptedDir: string, username: string): number {
  const p = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(p)) return 0
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    const cols = tableColumns(db, 'contact')
    if (!cols.has('username')) { db.close(); return 0 }
    const me = db.prepare('SELECT id FROM contact WHERE username = ?').get(username) as { id?: number } | undefined
    if (!me || me.id === undefined) { db.close(); return 0 }
    const cm = tableColumns(db, 'chatroom_member')
    if (!cm.has('room_id') || !cm.has('member_id')) { db.close(); return 0 }
    const row = db.prepare('SELECT COUNT(*) AS n FROM chatroom_member WHERE room_id = ?').get(me.id) as { n: number } | undefined
    db.close()
    return row?.n ?? 0
  } catch {
    return 0
  }
}

function announcement(decryptedDir: string, username: string): { text: string; time: number | null } {
  const p = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(p)) return { text: '', time: null }
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    const cols = tableColumns(db, 'contact')
    const userCol = cols.has('username') ? 'username' : cols.has('UserName') ? 'UserName' : ''
    if (!userCol) { db.close(); return { text: '', time: null } }
    const me = db.prepare(`SELECT id FROM contact WHERE ${userCol} = ?`).get(username) as { id?: number } | undefined
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name)
    const detail = tables.find(t => t.includes('chat_room_info_detail'))
    const roomId = me?.id
    if (roomId === undefined || !detail) { db.close(); return { text: '', time: null } }
    const dc = tableColumns(db, detail)
    const annCol = dc.has('announcement_') ? 'announcement_' : dc.has('announcement') ? 'announcement' : ''
    const timeCol = dc.has('announcement_publish_time_') ? 'announcement_publish_time_' : dc.has('announcement_publish_time') ? 'announcement_publish_time' : ''
    const whereCol = dc.has('room_id_') ? 'room_id_' : dc.has('username_') ? 'username_' : ''
    if (!annCol || !whereCol) { db.close(); return { text: '', time: null } }
    const row = db.prepare(`SELECT ${annCol} AS a, ${timeCol || '0'} AS t FROM ${detail} WHERE ${whereCol} = ?`).get(roomId) as { a: unknown; t?: unknown } | undefined
    db.close()
    if (!row) return { text: '', time: null }
    return { text: decodeCell(row.a).trim() || '', time: Number(row.t ?? 0) || null }
  } catch {
    return { text: '', time: null }
  }
}

/** Sender username from a chatroom message-content prefix (wxid_xxx:\n). */
function senderFromPrefix(text: string): string {
  const m = text.match(/^([A-Za-z0-9_@.\-]{3,64}):\n/)
  return m ? (m[1] ?? '') : ''
}

/**
 * Compute offline group insights for one chatroom.
 * @param decryptedDir - decrypted data root.
 * @param username - chatroom username.
 * @returns the insights snapshot.
 */
export function queryGroupInsights(decryptedDir: string, username: string): GroupInsightsSnapshot {
  const names = contactMeta(decryptedDir).names
  const table = 'Msg_' + createHash('md5').update(username, 'utf8').digest('hex')
  const dir = join(decryptedDir, 'message')
  let total = 0
  let minTime: number | null = null
  let maxTime: number | null = null
  const perMember = new Map<string, number>()
  let activeDays = 0
  const daySet = new Set<number>()
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!/^(biz_)?message_\d+\.db$/.test(f)) continue
      let db: DatabaseSync
      try { db = new DatabaseSync(join(dir, f), { readOnly: true }) } catch { continue }
      try {
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
        if (!has) continue
        const cols = tableColumns(db, table)
        if (!cols.has('message_content') || !cols.has('create_time')) continue
        const rows = db.prepare(`SELECT create_time, message_content FROM "${table}"`).all() as Array<Record<string, unknown>>
        for (const r of rows) {
          total += 1
          const t = Number(r['create_time'] ?? 0)
          if (t > 0) {
            if (minTime == null || t < minTime) minTime = t
            if (maxTime == null || t > maxTime) maxTime = t
            daySet.add(Math.floor(t / 86400))
          }
          const text = decodeCell(r['message_content'])
          const sender = senderFromPrefix(text)
          if (sender) perMember.set(sender, (perMember.get(sender) ?? 0) + 1)
        }
      } catch { /* skip */ } finally {
        db.close()
      }
    }
  }
  activeDays = daySet.size
  const topMembers: GroupInsightsMember[] = Array.from(perMember.entries())
    .map(([u, count]) => ({ username: u, name: names.get(u) ?? u, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10)
  const ann = announcement(decryptedDir, username)
  const spanDays = (minTime != null && maxTime != null) ? Math.max(1, Math.ceil((maxTime - minTime) / 86400)) : 0
  return {
    username,
    name: groupDisplayName(decryptedDir, username),
    memberCount: memberCount(decryptedDir, username),
    total,
    activeDays,
    from: minTime,
    to: maxTime,
    avgPerDay: spanDays > 0 ? total / spanDays : 0,
    announcement: ann.text,
    announcementTime: ann.time,
    topMembers,
  }
}
