/**
 * Call (type 50) inventory across every message shard.
 *
 * WeChat stores voice/video calls as `local_type = 50` rows whose
 * `message_content` is a zstd blob (magic 0x28B52FFD) holding a
 * `<voipmsg type="VoIPBubbleMsg">` XML. Everything the UI needs is in that XML:
 *
 * | field | measured (164/164 locally) | usable |
 * | --- | --- | --- |
 * | `<msg>` | 通话时长 00:21 / 对方已取消 / 已拒绝 / 未应答 / 已在其它设备接听 … | ✅ only informative field |
 * | `<duration>` | **always 0** | ❌ the real length is inside `<msg>` |
 * | `<room_type>` | 0×61 / 1×103, all in 1:1 chats | ✅ 0=语音 / 1=视频（判据见 parse.ts `parseVoipKind`） |
 *
 * Direction comes from `real_sender_id` resolved through each shard's own
 * `Name2Id` (rowid → wxid): the logged-in account means 呼出, anyone else 呼入.
 * Locally that resolves 135/135 rows, and the resolved "other" value is always
 * the conversation's own talker.
 *
 * 本文件（通话记录面板）**仍然只暴露原始 `room_type`、不自己下结论**：面板的语义是
 * 「按人/按月盘点通话」，语音还是视频不影响它的排序与汇总，少一个可能错的断言更安全。
 * 消息气泡那条链路（parse.ts → `rich.voipType`）需要画图标与「语音通话 / 视频通话」文案，
 * 所以它在拿到时长分布证据后按 **0=语音 / 1=视频** 判定 —— 判据与反例都写在
 * `parse.ts` 的 `parseVoipKind` 注释里。
 */
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { decompress } from 'fzstd'
import { join } from 'node:path'
import { contactMeta, shardCatalog, shardCatalogSig, cachedBySig, fileSigOf } from './meta.ts'
import type { CallRecord, CallPeer, CallMonthRow, CallsSnapshot } from '../types.ts'

const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])

/** `已在其它设备接听`：接通了，但本机没有时长。 */
const ANSWERED_ELSEWHERE = /已在其它设备接听/

/**
 * Decode a message cell: zstd-inflate when the magic matches, else UTF-8/GBK.
 * @param v - raw cell (BLOB, or TEXT holding a comma-joined byte list).
 * @returns the decoded UTF-8 text.
 */
function decodeContent(v: unknown): string {
  let raw: Buffer
  if (v instanceof Uint8Array) raw = Buffer.from(v)
  else if (typeof v === 'string') {
    raw = /^\d+(,\d+)*$/.test(v.trim()) ? Buffer.from(v.split(',').map(Number)) : Buffer.from(v, 'utf8')
  } else return ''
  if (raw.length === 0) return ''
  const bytes = raw.length >= 4 && raw.subarray(0, 4).equals(ZSTD_MAGIC)
    ? (() => { try { return Buffer.from(decompress(raw)) } catch { return raw } })()
    : raw
  try {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('gbk', { fatal: false }).decode(bytes)
  }
}

/** Inner text of the first `<tag>`; CDATA unwrapped. */
function tagText(xml: string, tag: string): string {
  const open = '<' + tag
  const si = xml.indexOf(open)
  if (si < 0) return ''
  const gt = xml.indexOf('>', si)
  if (gt < 0) return ''
  const ei = xml.indexOf('</' + tag, gt)
  if (ei < 0) return ''
  const body = xml.slice(gt + 1, ei).trim()
  const c = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(body)
  return c ? (c[1] ?? '') : body
}

/** The duration lives in the `<msg>` text (the XML `<duration>` is always 0). */
function parseDuration(text: string): number | undefined {
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(text)
  if (!m) return undefined
  const a = Number(m[1] ?? 0)
  const b = Number(m[2] ?? 0)
  return m[3] === undefined ? a * 60 + b : a * 3600 + b * 60 + Number(m[3])
}

/** md5(username) → username, for the `Msg_<md5>` table names. */
function md5Index(decryptedDir: string): Map<string, string> {
  const names = contactMeta(decryptedDir).names
  const map = new Map<string, string>()
  for (const u of names.keys()) map.set(createHash('md5').update(u, 'utf8').digest('hex'), u)
  return map
}

interface RawCall {
  username: string
  localId: number
  createTime: number
  status: string
  connected: boolean
  durationSec?: number
  outgoing: boolean
  roomType?: number
}

/** Scan every message shard for type-50 rows and decode the voip XML. */
function scanCalls(decryptedDir: string, selfUsername: string): RawCall[] {
  const byMd5 = md5Index(decryptedDir)
  const self = (selfUsername ?? '').trim()
  const out: RawCall[] = []
  for (const shard of shardCatalog(decryptedDir)) {
    const tables = [...shard.tables.keys()]
    if (tables.length === 0) continue
    let db: DatabaseSync
    try { db = new DatabaseSync(shard.file, { readOnly: true }) } catch { continue }
    try {
      for (const table of tables) {
        const meta = shard.tables.get(table)
        if (!meta || !meta.cols.has('message_content')) continue
        let rows: Array<Record<string, unknown>>
        try {
          rows = db.prepare(
            `SELECT local_id AS l, create_time AS t, real_sender_id AS s, message_content AS c FROM "${table}" WHERE (local_type & 4294967295) = 50`,
          ).all() as Array<Record<string, unknown>>
        } catch { continue }
        if (rows.length === 0) continue
        const talker = byMd5.get(table.slice(4)) ?? ''
        for (const r of rows) {
          const xml = decodeContent(r['c'])
          if (!xml) continue
          const status = tagText(xml, 'msg').trim()
          const durationSec = parseDuration(status)
          const connected = durationSec !== undefined || ANSWERED_ELSEWHERE.test(status)
          const sender = meta.name2id.get(Number(r['s'] ?? 0)) ?? ''
          // 方向：real_sender_id 解析出的是自己的 wxid → 呼出；否则是对方（或退回表名反解）。
          const outgoing = self.length > 0 && sender === self
          const username = outgoing ? talker : (sender && sender !== self ? sender : talker)
          const roomType = Number(tagText(xml, 'room_type'))
          out.push({
            username,
            localId: Number(r['l'] ?? 0),
            createTime: Number(r['t'] ?? 0),
            status,
            connected,
            ...(durationSec !== undefined ? { durationSec } : {}),
            outgoing,
            ...(Number.isFinite(roomType) ? { roomType } : {}),
          })
        }
      }
    } finally {
      db.close()
    }
  }
  return out
}

/** `YYYY-MM` in local time. */
function monthOf(sec: number): string {
  const d = new Date(sec * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function buildSnapshot(raw: RawCall[], names: Map<string, string>, topPeers: number, recentLimit: number): CallsSnapshot {
  const byPeer = new Map<string, { calls: number; connected: number; durationSec: number; lastTime: number }>()
  const byMonth = new Map<string, { calls: number; connected: number; durationSec: number }>()
  const byHour = new Array<number>(24).fill(0)
  const unanswered = new Map<string, number>()
  let total = 0
  let connectedCount = 0
  let durationSec = 0
  let outgoing = 0
  let longestSec = 0
  let longestPeer = ''
  let firstTime: number | null = null
  let lastTime: number | null = null
  const connectedDurations: number[] = []

  for (const c of raw) {
    total += 1
    if (c.connected) connectedCount += 1
    if (c.outgoing) outgoing += 1
    const d = c.durationSec ?? 0
    durationSec += d
    if (d > longestSec) { longestSec = d; longestPeer = c.username }
    if (c.connected) connectedDurations.push(d)
    if (!c.connected && c.status) unanswered.set(c.status, (unanswered.get(c.status) ?? 0) + 1)
    const peer = byPeer.get(c.username) ?? { calls: 0, connected: 0, durationSec: 0, lastTime: 0 }
    peer.calls += 1
    if (c.connected) peer.connected += 1
    peer.durationSec += d
    if (c.createTime > peer.lastTime) peer.lastTime = c.createTime
    byPeer.set(c.username, peer)
    if (c.createTime > 0) {
      const m = monthOf(c.createTime)
      const row = byMonth.get(m) ?? { calls: 0, connected: 0, durationSec: 0 }
      row.calls += 1
      if (c.connected) row.connected += 1
      row.durationSec += d
      byMonth.set(m, row)
      const hour = new Date(c.createTime * 1000).getHours()
      byHour[hour] = (byHour[hour] ?? 0) + 1
      if (firstTime == null || c.createTime < firstTime) firstTime = c.createTime
      if (lastTime == null || c.createTime > lastTime) lastTime = c.createTime
    }
  }

  const peers: CallPeer[] = [...byPeer.entries()]
    .map(([username, p]) => ({ username, name: names.get(username) ?? username, ...p }))
    .sort((a, b) => b.calls - a.calls || b.durationSec - a.durationSec)
  const months: CallMonthRow[] = [...byMonth.entries()]
    .map(([month, m]) => ({ month, ...m }))
    .sort((a, b) => (a.month < b.month ? -1 : 1))
  const recent: CallRecord[] = [...raw]
    .filter(c => c.createTime > 0)
    .sort((a, b) => b.createTime - a.createTime)
    .slice(0, recentLimit)
    .map(c => ({
      username: c.username,
      name: names.get(c.username) ?? c.username,
      localId: c.localId,
      createTime: c.createTime,
      status: c.status,
      connected: c.connected,
      outgoing: c.outgoing,
      ...(c.durationSec !== undefined ? { durationSec: c.durationSec } : {}),
    }))

  return {
    total,
    connected: connectedCount,
    missed: total - connectedCount,
    durationSec,
    avgSec: connectedDurations.length > 0 ? Math.round(durationSec / connectedDurations.length) : 0,
    longestSec,
    longestPeer: longestPeer ? (names.get(longestPeer) ?? longestPeer) : '',
    outgoing,
    incoming: total - outgoing,
    ackElsewhere: raw.filter(c => !c.durationSec && ANSWERED_ELSEWHERE.test(c.status)).length,
    peers: peers.slice(0, topPeers),
    peerCount: peers.length,
    months,
    byHour,
    unanswered: [...unanswered.entries()].map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
    recent,
    from: firstTime,
    to: lastTime,
    updatedAt: Math.floor(Date.now() / 1000),
  }
}

/**
 * Compute the call inventory snapshot (cached on shard + contact fingerprints).
 * @param decryptedDir - decrypted data root.
 * @param selfUsername - logged-in account wxid (direction labels).
 * @param topPeers - how many peers to return (default 20).
 * @param recentLimit - how many recent records to return (default 50).
 * @returns the calls snapshot.
 */
export function queryCalls(decryptedDir: string, selfUsername?: string, topPeers = 20, recentLimit = 50): CallsSnapshot {
  const self = selfUsername ?? ''
  // 通话快照里的对端昵称来自 contact.db，所以它也必须进签名：原先只签分片 + self，
  // 靠「事件后整表清空」兜住（M8 去掉那层兜底后必须补上真正读了的东西）。
  const sig = shardCatalogSig(decryptedDir, ['message']) + '|' + self + '|' + fileSigOf(join(decryptedDir, 'contact', 'contact.db'))
  const names = contactMeta(decryptedDir).names
  return cachedBySig('calls:' + decryptedDir, sig, () => {
    const raw = scanCalls(decryptedDir, self)
    return buildSnapshot(raw, names, topPeers, recentLimit)
  }, 60_000)
}
