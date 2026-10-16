/**
 * Offline group insights for one chatroom: total/active-day stats, member
 * activity ranks, and the group announcement. Sender identity is extracted
 * from the message-content prefix (`wxid_xxx:\n`) which is reliable for
 * 4.x chatroom rows; Name2Id resolution can be added later.
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from './db-open.ts'
import { withDb } from './db-open.ts'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decompress } from 'fzstd'
import type { GroupInsightsMember, GroupInsightsSnapshot } from '../types.ts'
import { cachedBySig, contactMeta, fileSigOf, INSIGHTS_TTL_MS, shardCatalogSig } from './meta.ts'

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
    return withDb(p, (db) => {
      const cols = tableColumns(db, 'contact')
      if (!cols.has('username')) return 0
      const me = db.prepare('SELECT id FROM contact WHERE username = ?').get(username) as { id?: number } | undefined
      if (!me || me.id === undefined) return 0
      const cm = tableColumns(db, 'chatroom_member')
      if (!cm.has('room_id') || !cm.has('member_id')) return 0
      const row = db.prepare('SELECT COUNT(*) AS n FROM chatroom_member WHERE room_id = ?').get(me.id) as { n: number } | undefined
      return row?.n ?? 0
    })
  } catch {
    return 0
  }
}

function announcement(decryptedDir: string, username: string): { text: string; time: number | null } {
  const p = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(p)) return { text: '', time: null }
  const empty = { text: '', time: null }
  try {
    const row = withDb(p, (db) => {
      const cols = tableColumns(db, 'contact')
      const userCol = cols.has('username') ? 'username' : cols.has('UserName') ? 'UserName' : ''
      if (!userCol) return null
      const me = db.prepare(`SELECT id FROM contact WHERE ${userCol} = ?`).get(username) as { id?: number } | undefined
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(r => r.name)
      const detail = tables.find(t => t.includes('chat_room_info_detail'))
      const roomId = me?.id
      if (roomId === undefined || !detail) return null
      const dc = tableColumns(db, detail)
      const annCol = dc.has('announcement_') ? 'announcement_' : dc.has('announcement') ? 'announcement' : ''
      const timeCol = dc.has('announcement_publish_time_') ? 'announcement_publish_time_' : dc.has('announcement_publish_time') ? 'announcement_publish_time' : ''
      const whereCol = dc.has('room_id_') ? 'room_id_' : dc.has('username_') ? 'username_' : ''
      if (!annCol || !whereCol) return null
      return db.prepare(`SELECT ${annCol} AS a, ${timeCol || '0'} AS t FROM ${detail} WHERE ${whereCol} = ?`).get(roomId) as { a: unknown; t?: unknown } | undefined
    })
    if (!row) return empty
    return { text: decodeCell(row.a).trim() || '', time: Number(row.t ?? 0) || null }
  } catch {
    return empty
  }
}

/** Sender username from a chatroom message-content prefix (wxid_xxx:\n). */
function senderFromPrefix(text: string): string {
  const m = text.match(/^([A-Za-z0-9_@.\-]{3,64}):\n/)
  return m ? (m[1] ?? '') : ''
}

/**
 * 群聊洞察的**签名**（W2-4.4）：必须覆盖 {@link computeGroupInsights} 真正读过的每一个文件。
 *
 * 这是 M8 判据的字面要求 —— 签名少算一个文件，那次漏改就会变成「数据是旧的但没人重算」，
 * 而且这种错**不会报错**，只会让用户看到一个停在上次的统计。三处来源逐个对上：
 *   · `contact.db` —— `contactMeta()` 的显示名、`memberCount()`、`announcement()` 三处都读它；
 *   · `message/` 下的全部分片 —— 主循环逐个打开它们并按 `Msg_<群>` 表全表游标。
 *
 * 为什么用**整个 message 目录**的目录签名而不是「只含有该群表的那些分片」：
 * 后者要先逐个打开每个分片问一次 `sqlite_master` —— 那正是这里要省掉的那笔开销。
 * 代价是「某个**别的**群有新消息」也会让本群重算，属于**多算**而不是漏算：
 * 多算只浪费一次 161ms，漏算会让用户看到过期数据。
 * @param decryptedDir - 已解密数据根。
 * @param username - 群 username（不进签名：它已经在缓存键里）。
 * @returns 签名串。
 */
function groupInsightsSig(decryptedDir: string, _username: string): string {
  return [
    fileSigOf(join(decryptedDir, 'contact', 'contact.db')),
    shardCatalogSig(decryptedDir, ['message']),
  ].join('|')
}

/**
 * 离线群聊洞察：群总消息数 / 活跃天数 / 成员活跃榜 / 群公告。
 *
 * W2-4.4：这层只做「按签名取缓存」，算法体在 {@link computeGroupInsights}。
 * 实测（合成 8 分片 × 20000 行 = 16 万条群消息，`group-insights-cost.measure.spec.ts`）：
 * 冷算 **161.5ms**、签名命中 **0.003ms**。成本随分片数线性增长（真实账号 200+ 分片），
 * 而面板是「打开即查一次」（`useFreshData` 不轮询），所以省下的正是**重复打开**那一档。
 * @param decryptedDir - 已解密数据根。
 * @param username - 群 username。
 * @returns 洞察快照。
 */
export function queryGroupInsights(decryptedDir: string, username: string): GroupInsightsSnapshot {
  const key = 'group-insights:' + decryptedDir + ':' + username
  return cachedBySig(key, groupInsightsSig(decryptedDir, username), () => computeGroupInsights(decryptedDir, username), INSIGHTS_TTL_MS)
}

/**
 * 群洞察的算法体（无缓存，供 {@link queryGroupInsights} 的 loader 调用，也可单测直接打）。
 * @param decryptedDir - 已解密数据根。
 * @param username - 群 username。
 * @returns 洞察快照。
 */
export function computeGroupInsights(decryptedDir: string, username: string): GroupInsightsSnapshot {
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
        // 游标读（N8）：整张 Msg_* 随消息量增长，而这里只是逐条累加统计量 ——
        // `.all()` 会先把整表物化成数组，读完即丢的中间数组纯属浪费内存。
        const sql = `SELECT create_time, message_content FROM "${table}"`
        for (const r of db.prepare(sql).iterate() as Iterable<Record<string, unknown>>) {
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
