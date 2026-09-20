/**
 * Relationship graph: contact/group nodes with display names, message counts,
 * shared-group codes (people mode) and shared-member metrics (groups mode),
 * mirroring st_control insights/graph.rs. Edges are derived client-side from
 * group_codes (people: contact↔contact by common groups; groups: group↔group
 * by common members), like the source GraphModel.
 */
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { contactMeta, shardCatalog } from './meta.ts'
import { parseChatRoomExtBuffer } from './group-info.ts'
import type { GraphSnapshot } from '../types.ts'

/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
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

/** Strip the WeChat instance suffix (wxid_xxx_f312 -> wxid_xxx). */
function cleanWxid(username: string): string {
  const m = username.match(/^(wxid_[A-Za-z0-9]+)(?:_[A-Za-z0-9]+)?$/)
  return m ? (m[1] ?? username) : username
}

/** 「非数字开头前缀 + 数字编号」形态；前缀 lazy 取最短，先遇到的编号就分组。 */
const REMARK_KEY_RE = /^([^\d\s][^\d]*?)\s*(\d+)(?=\D|$)/
/** 前缀**去标点后**至少几个字（挡住 `--202` / `_12` 这类纯符号前缀成组）。 */
const REMARK_KEY_MIN_PREFIX = 2
/** 编号位数区间：1 位是噪声（门店序号偶合），>6 位是手机号/单号。 */
const REMARK_KEY_MIN_DIGITS = 2
const REMARK_KEY_MAX_DIGITS = 6
/** 判定「纯符号前缀」时剔除的标点（中英文都算）。 */
const PUNCT_RE = /[\s\-_—–~～·、,，.。:：;；/|()（）【】#*+"'“”‘’]/g

/**
 * 群节点携带的共同成员上限。
 *
 * 8 → 200 的依据（真机探针：64 个群、2541 条成员条目，见 working/probe-remark-key.txt ③）：
 *   cap=8   439 条 / ≈21KB / 群组网络边 1228 / **被截断的群 38 个**
 *   cap=200 2115 条 / ≈98KB / 群组网络边 3079 / 被截断的群 3 个
 * 8 的上限把 38/64 个群的成员关系直接砍掉，这正是「群与群之间看不到共同成员」的来源；
 * 200 让 95% 的群拿到完整成员，IPC 体积仍在百 KB 量级。前端 `GROUP_PAIR_MEMBERS`
 * 还会再按权重截一次配对规模，两处口径不冲突。
 */
const GROUP_MEMBER_CAP = 200
/** 备注班级名册每个键最多带多少成员（详情面板展示用；真机最大班 43 人）。 */
const REMARK_ROSTER_CAP = 100

/**
 * 备注里的「班级/批次」键：**非数字前缀 + 数字编号**（`宜州一中404陈泳达` → `宜州一中404`）。
 *
 * 规则为什么是这几个数（真机 280 条备注全量扫描，见 working/probe-remark-key.txt ①）：
 *   - **编号 ≥2 位**：`前缀≥2/编号≥2` 与 `前缀≥3/编号≥2` 结果**完全一致**（86 人 / 9 组 /
 *     1233 条潜在边），而放宽到 1 位只多出「一汽大众-7」这种**门店序号**的偶然同号
 *     （多 1 条边）—— 收益为 0、误连风险不为 0，所以取下界 2；
 *   - **编号 ≤6 位**：更长的数字串是手机号/单号（备注里真实存在，如
 *     `一汽大众-7鑫广达吴善钊19195897571`），当班级处理会造出假关系；
 *   - **前缀去标点后 ≥2 字**：挡掉纯符号前缀。
 * 未被命中的 194 条备注抽样全是「表弟_陈忠凯」「法院_梧州万秀_会计小郭」这类
 * 亲属/单位+姓名（无编号），确实不该成组 —— 说明规则没有漏掉成规模的班级型分组。
 * @param remark - 原始备注（含首尾空白也可）。
 * @returns 分组键；不构成「前缀+编号」形态、或编号位数不在区间内时返回空串。
 */
export function remarkClassKey(remark: string | undefined | null): string {
  const s = (remark ?? '').trim()
  if (!s) return ''
  const m = REMARK_KEY_RE.exec(s)
  if (!m) return ''
  const prefix = (m[1] ?? '').trim()
  const digits = m[2] ?? ''
  if (digits.length < REMARK_KEY_MIN_DIGITS || digits.length > REMARK_KEY_MAX_DIGITS) return ''
  if (prefix.replace(PUNCT_RE, '').length < REMARK_KEY_MIN_PREFIX) return ''
  return prefix + digits
}

/** Per-taker message counts (Msg_<md5> tables across shards, file-first). */
function loadMessageCounts(decryptedDir: string, usernames: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  const tableToUser = new Map<string, string>()
  for (const u of usernames) tableToUser.set('Msg_' + createHash('md5').update(u, 'utf8').digest('hex'), u)
  for (const sh of shardCatalog(decryptedDir)) {
    for (const t of sh.tables.keys()) {
      const u = tableToUser.get(t)
      if (!u || counts.has(u)) continue
      let db: DatabaseSync | null = null
      try { db = new DatabaseSync(sh.file, { readOnly: true }) } catch { continue }
      try {
        counts.set(u, (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n)
      } catch { /* next table */ } finally {
        db.close()
      }
    }
  }
  return counts
}

/** Friend flag + avatar + remark per contact username. */
function loadContactMeta(decryptedDir: string): Map<string, { isFriend: boolean; avatar: string; remark: string }> {
  const meta = new Map<string, { isFriend: boolean; avatar: string; remark: string }>()
  const p = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(p)) return meta
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    const cols = tableColumns(db, 'contact')
    if (!cols.has('username')) { db.close(); return meta }
    const sel = (c: string, dft: string): string => (cols.has(c) ? c : dft)
    // 备注列名有 remark / Remark 两种历史写法（与 meta.ts 同口径）
    const remarkSel = cols.has('remark') ? 'remark' : cols.has('Remark') ? 'Remark' : "''"
    const rows = db.prepare(`SELECT ${sel('username', "''")} AS u, ${sel('local_type', '0')} AS lt, ${sel('delete_flag', '0')} AS df, ${sel('small_head_url', "''")} AS s, ${sel('big_head_url', "''")} AS b, ${remarkSel} AS rm FROM contact`).all() as Array<{ u: string; lt: number; df: number; s: string; b: string; rm: string }>
    for (const r of rows) {
      const u = cellString(r.u)
      if (!u || u.endsWith('@chatroom')) continue
      const avatar = cellString(r.b).trim() || cellString(r.s).trim()
      meta.set(u, { isFriend: r.lt === 1 && r.df === 0, avatar, remark: cellString(r.rm).trim() })
    }
    db.close()
  } catch { /* contact db unavailable */ }
  return meta
}

interface RoomMemberData {
  /** username -> set of chatroom usernames it belongs to. */
  memberGroups: Map<string, Set<string>>
  /** chatroom username -> member usernames (chatroom_member + ext_buffer). */
  roomMembers: Map<string, Set<string>>
  /** chatroom username -> member count (union). */
  roomCounts: Map<string, number>
}

/** Build member↔group maps; ext_buffer snapshot fills chatroom_member gaps. */
function loadRoomData(decryptedDir: string): RoomMemberData {
  const out: RoomMemberData = { memberGroups: new Map(), roomMembers: new Map(), roomCounts: new Map() }
  const p = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(p)) return out
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    const cols = tableColumns(db, 'contact')
    const cid = cols.has('id') ? 'id' : 'rowid'
    const idToUser = new Map<number, string>()
    try {
      const users = db.prepare(`SELECT ${cid} AS id, username FROM contact`).all() as Array<{ id: number; username: string }>
      for (const r of users) idToUser.set(r.id, cellString(r.username))
    } catch { /* no contact rows */ }

    let rooms: Array<{ id: number; username: string; ext?: unknown }> = []
    try {
      const crCols = tableColumns(db, 'chat_room')
      if (crCols.has('ext_buffer')) {
        rooms = db.prepare('SELECT id, username, ext_buffer AS ext FROM chat_room').all() as Array<{ id: number; username: string; ext?: unknown }>
      } else if (crCols.has('id') && crCols.has('username')) {
        rooms = db.prepare('SELECT id, username FROM chat_room').all() as Array<{ id: number; username: string }>
      }
    } catch { /* no chat_room */ }
    for (const room of rooms) {
      const u = cellString(room.username)
      if (!u) continue
      if (!out.roomMembers.has(u)) out.roomMembers.set(u, new Set())
    }
    try {
      const rows = db.prepare('SELECT room_id, member_id FROM chatroom_member').all() as Array<{ room_id: number; member_id: number }>
      const roomByUsername = new Map<number, string>()
      for (const room of rooms) roomByUsername.set(room.id, cellString(room.username))
      for (const r of rows) {
        const room = roomByUsername.get(r.room_id)
        const user = idToUser.get(r.member_id)
        if (!room || !user) continue
        out.roomMembers.get(room)?.add(user)
        let groups = out.memberGroups.get(user)
        if (!groups) { groups = new Set(); out.memberGroups.set(user, groups) }
        groups.add(room)
      }
    } catch { /* no member rows */ }
    // ext_buffer snapshot: members absent from chatroom_member still count
    for (const room of rooms) {
      const u = cellString(room.username)
      const raw = room.ext
      const buf = raw instanceof Uint8Array
        ? Buffer.from(raw)
        : typeof raw === 'string' && raw.length > 0
          ? Buffer.from(raw, 'utf8')
          : Buffer.alloc(0)
      if (!u || buf.length === 0) continue
      let snap: Array<{ username: string }> = []
      try { snap = parseChatRoomExtBuffer(buf) } catch { snap = [] }
      for (const s of snap) {
        if (!s.username) continue
        out.roomMembers.get(u)?.add(s.username)
        let groups = out.memberGroups.get(s.username)
        if (!groups) { groups = new Set(); out.memberGroups.set(s.username, groups) }
        groups.add(u)
      }
    }
    for (const [u, members] of out.roomMembers) out.roomCounts.set(u, members.size)
    db.close()
  } catch { /* room data unavailable */ }
  return out
}

/**
 * Build a graph snapshot: contact/group nodes enriched for both display modes.
 * @param decryptedDir - decrypted data root.
 * @param selfUsername - logged-in account wxid (excluded from persons).
 * @returns nodes + summary (edges derived client-side from group_codes).
 */
export function queryGraph(decryptedDir: string, selfUsername?: string): GraphSnapshot {
  const nodes: GraphSnapshot['nodes'] = []
  const sessionPath = join(decryptedDir, 'session', 'session.db')

  // session talkers (bounded) so isolated contacts stay out
  const talkers: string[] = []
  if (existsSync(sessionPath)) {
    try {
      const db = new DatabaseSync(sessionPath, { readOnly: true })
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SessionTable'").get() !== undefined
      if (has) {
        const rows = db.prepare('SELECT username FROM SessionTable').all() as Array<{ username: string }>
        for (const r of rows) {
          const u = cellString(r.username)
          if (u && u !== 'self') talkers.push(u)
        }
      }
      db.close()
    } catch { /* no sessions */ }
  }

  const names = contactMeta(decryptedDir).names
  const counts = loadMessageCounts(decryptedDir, talkers)
  const meta = loadContactMeta(decryptedDir)
  const roomData = loadRoomData(decryptedDir)
  const selfWxid = selfUsername ? cleanWxid(selfUsername) : ''

  // persons: contacts + official accounts (except the current account)
  const persons: GraphSnapshot['nodes'] = []
  const personIds = new Set<string>()
  // 备注「班级」名册：键 → 全库成员。刻意在**好友过滤 / nodeLimit 之前**收集 ——
  // 详情面板要靠它说明「本班全库 N 人、当前视图只显示 M 人」，
  // 而这正是「同前缀却没有连线」最常见的原因（人被挡在图外，不是关系缺失）。
  const classRoster = new Map<string, Array<{ username: string; name: string; is_friend: boolean; msg_count: number }>>()
  for (const [u, info] of meta) {
    if (selfWxid && cleanWxid(u) === selfWxid) continue
    const kind = u.startsWith('gh_') ? 'official' : 'contact'
    const groups = Array.from(roomData.memberGroups.get(u) ?? []).sort()
    const node: GraphSnapshot['nodes'][number] = {
      id: u,
      label: names.get(u) || u,
      kind,
      msg_count: counts.get(u) ?? 0,
      group_count: groups.length,
      group_codes: groups,
      is_friend: info.isFriend,
    }
    if (info.avatar) node.avatar_url = info.avatar
    const classKey = remarkClassKey(info.remark)
    if (classKey) {
      node.remark_group = classKey
      let roster = classRoster.get(classKey)
      if (!roster) { roster = []; classRoster.set(classKey, roster) }
      roster.push({ username: u, name: node.label, is_friend: info.isFriend, msg_count: node.msg_count ?? 0 })
    }
    persons.push(node)
    personIds.add(u)
  }
  persons.sort((a, b) => (b.msg_count ?? 0) - (a.msg_count ?? 0) || (b.group_count ?? 0) - (a.group_count ?? 0) || a.id.localeCompare(b.id))

  // groups: chatrooms from sessions, enriched with member/shared metrics
  const groups: GraphSnapshot['nodes'] = []
  for (const u of talkers) {
    if (!u.endsWith('@chatroom')) continue
    const members = roomData.roomMembers.get(u) ?? new Set<string>()
    const shared: Array<{ username: string; name: string; is_friend: boolean; msg_count: number }> = []
    for (const m of members) {
      if (!personIds.has(m)) continue
      shared.push({ username: m, name: names.get(m) || m, is_friend: meta.get(m)?.isFriend ?? false, msg_count: counts.get(m) ?? 0 })
    }
    shared.sort((a, b) => b.msg_count - a.msg_count || a.username.localeCompare(b.username))
    const node: GraphSnapshot['nodes'][number] = {
      id: u,
      label: names.get(u) || u,
      kind: 'group',
      msg_count: counts.get(u) ?? 0,
      member_count: roomData.roomCounts.get(u) ?? members.size,
      shared_count: shared.length,
      shared_members: shared.slice(0, GROUP_MEMBER_CAP),
      is_friend: false,
    }
    groups.push(node)
  }
  groups.sort((a, b) =>
    (b.shared_count ?? 0) - (a.shared_count ?? 0)
    || (b.msg_count ?? 0) - (a.msg_count ?? 0)
    || b.id.localeCompare(a.id),
  )

  const totalMessages = Array.from(counts.values()).reduce((a, b) => a + b, 0)
  const friendCount = persons.filter(n => n.is_friend).length
  const groupNames: Record<string, string> = {}
  for (const g of groups) groupNames[g.id] = g.label
  const topRelations = persons.slice(0, 8).map(n => ({ username: n.id, name: n.label, msg_count: n.msg_count ?? 0 }))

  // 只有 ≥2 人的键才构成「班级」（单例不产生任何关系，前端也会直接跳过）
  const remarkGroups = [...classRoster.entries()]
    .filter(([, members]) => members.length >= 2)
    .map(([key, members]) => {
      members.sort((a, b) =>
        Number(b.is_friend) - Number(a.is_friend)
        || b.msg_count - a.msg_count
        || a.username.localeCompare(b.username),
      )
      return { key, total: members.length, members: members.slice(0, REMARK_ROSTER_CAP) }
    })
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key))

  const selfMeta = selfWxid ? meta.get(selfWxid) : undefined
  nodes.push({
    id: 'self', label: '我', kind: 'self', msg_count: 0, is_friend: true,
    ...(selfMeta?.avatar ? { avatar_url: selfMeta.avatar } : {}),
  })
  nodes.push(...persons, ...groups)

  return {
    self: selfUsername ?? '',
    group_names: groupNames,
    remark_groups: remarkGroups,
    nodes,
    edges: [],
    summary: {
      total_contacts: persons.filter(n => n.kind === 'contact').length,
      total_groups: groups.length,
      total_messages: totalMessages,
      contact_book_total: persons.length,
      contact_book_friends: friendCount,
      contact_book_members: persons.filter(n => (n.group_count ?? 0) > 0).length,
      selected_contacts: persons.length,
      selected_groups: groups.length,
      top_relations: topRelations,
    },
  }
}
