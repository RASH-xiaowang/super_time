/**
 * Contact queries over st_control's decrypted contact.db, mirroring the Rust
 * modules/contacts.rs: full category semantics (friend/group/official/service/
 * enterprise/member/system/deleted), pinyin initials, group owner + member
 * counts, member's owning group, and category stats.
 */
import { DatabaseSync } from 'node:sqlite'
import { cachedBySig, fileSigOf } from './meta.ts'
import { join } from 'node:path'
import type { WechatContact } from '../types.ts'

function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map(r => r.name))
}

/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
function cellString(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/** Official-account check: gh_ prefix (source is_official_account). */
function isOfficialAccount(username: string): boolean {
  return username.startsWith('gh_') || username.includes('gh_')
}

/** Builtin notification accounts (source is_builtin_account). */
function isBuiltinAccount(username: string): boolean {
  const s = username.toLowerCase()
  return s === 'weixin' || s === 'notifymessage' || s === 'cmdamount' || s === 'floatbottle'
    || s === 'fmessage' || s === 'medianote' || s === 'qmessage' || s.startsWith('weixin_')
}

/**
 * Source category_of: 按 local_type + username 划分互斥类别。
 *
 * 类别与实测的 contact.local_type 分布对应（本机真实数据普查）：
 *   3 → 1459 行，1249 个 wxid_*  = **真实好友**
 *   1 → 417 行，系统号 + gh_*    = 系统 / 公众号
 *   2 → 51 行                     = 群聊
 *   5 / 6 → 34 / 28 行 @openim    = 企业微信
 *   0 → 21 行
 * 原实现写的是 `localType === 1` 判好友，导致 1459 个真实好友全部落入
 * 兜底的 'member'（群成员），而 417 个系统/公众号行被当成好友 —— 通讯录整体判反。
 */
function categoryOf(localType: number, username: string, deleteFlag: number): string {
  if (deleteFlag !== 0 || localType === 4) return 'deleted'
  if (username.endsWith('@chatroom')) return 'group'
  if (isOfficialAccount(username)) return 'official'
  if (isBuiltinAccount(username)) return 'system'
  if (username.endsWith('@kefu.openim')) return 'service'
  if (username.endsWith('@openim')) return 'enterprise'
  if (localType === 3) return 'friend'
  return 'member'
}

/** Source category_label. */
function categoryLabel(category: string): string {
  switch (category) {
    case 'friend': return '联系人'
    case 'enterprise': return '企业微信联系人'
    case 'group': return '群聊'
    case 'service': return '服务号'
    case 'official': return '公众号'
    case 'member': return '群成员'
    case 'system': return '系统'
    case 'deleted': return '已删除'
    default: return '其他'
  }
}

/** Source initial_of: remark initial > nick initial > display first char. */
function initialOf(remarkInitial: string, nickInitial: string, display: string): string {
  const raw = remarkInitial || nickInitial || display
  const ch = raw.slice(0, 1).toUpperCase()
  if (/[A-Z]/.test(ch)) return ch
  return '#'
}

/**
 * Read the contact book.
 * @param decryptedDir - decrypted data root.
 * @returns the contacts snapshot (contacts + per-category stats).
 */
export interface ContactsPageOptions { limit?: number; offset?: number }

export function queryContacts(
  decryptedDir: string,
  options?: ContactsPageOptions,
): { contacts: WechatContact[]; total: number; stats: Record<string, number> } {
  // Cache keyed on the contact snapshot's signature. The realtime sync rewrites
  // contact.db under an atomic rename, so the signature changes and this
  // recomputes immediately instead of re-scanning on every panel refresh.
  const limit = options?.limit
  const offset = options?.offset ?? 0
  return cachedBySig(
    'contacts:' + decryptedDir + ':' + String(limit ?? '') + ':' + String(offset),
    fileSigOf(join(decryptedDir, 'contact', 'contact.db')),
    () => computeContacts(decryptedDir, limit, offset),
  )
}

function computeContacts(
  decryptedDir: string,
  limit?: number,
  offset: number = 0,
): { contacts: WechatContact[]; total: number; stats: Record<string, number> } {
  const db = new DatabaseSync(join(decryptedDir, 'contact', 'contact.db'), { readOnly: true })
  try {
    const cols = tableColumns(db, 'contact')
    const sel = (c: string, dft: string): string => (cols.has(c) ? c : dft)
    const sql = [
      'SELECT',
      [sel('id', '0'), sel('username', "''"), sel('local_type', '0'), sel('alias', "''"),
        sel('delete_flag', '0'), sel('remark', "''"), sel('remark_pin_yin_initial', "''"),
        sel('nick_name', "''"), sel('pin_yin_initial', "''"), sel('quan_pin', "''"),
        // 第 85 轮：`remark_quan_pin` 是**备注**（也就是界面上显示的那个名字）的拼音，
        // `quan_pin` 是昵称的拼音。此前只读后者 —— 于是「桂西北_教练黄剑腾」这类
        // 备注名搜 `guixibeijiaolianhuangjianteng` 一条也搜不到（实测可新解锁 270 人）。
        sel('remark_quan_pin', "''"),
        sel('big_head_url', "''"), sel('small_head_url', "''"), sel('description', "''"), sel('is_in_chat_room', '0')].join(', '),
      'FROM contact',
    ].join(' ')
    const rows = db.prepare(sql).all() as Array<Record<string, unknown>>

    // group info: chat_room owner + member counts (chatroom_member.room_id -> id)
    const roomOwners = new Map<number, string>()
    const roomUsernames = new Map<number, string>()
    const memberCounts = new Map<number, number>()
    const memberRooms = new Map<number, number>()
    try {
      const crCols = tableColumns(db, 'chat_room')
      const crSel = (c: string, dft: string): string => (crCols.has(c) ? c : dft)
      const rooms = db.prepare(`SELECT ${crSel('id', '0')} AS id, ${crSel('username', "''")} AS u, ${crSel('owner', "''")} AS o FROM chat_room`).all() as Array<{ id: number; u: string; o: string }>
      for (const r of rooms) {
        roomUsernames.set(r.id, r.u)
        if (r.o) roomOwners.set(r.id, r.o)
      }
      const cmCols = tableColumns(db, 'chatroom_member')
      if (cmCols.has('room_id') && cmCols.has('member_id')) {
        const members = db.prepare('SELECT room_id, member_id FROM chatroom_member').all() as Array<{ room_id: number; member_id: number }>
        for (const m of members) {
          const rid = m.room_id
          memberCounts.set(rid, (memberCounts.get(rid) ?? 0) + 1)
          memberRooms.set(m.member_id, rid)
        }
      }
    } catch { /* no group tables */ }

    // official/service split by biz_info.type
    const bizTypes = new Map<string, number>()
    try {
      const biCols = tableColumns(db, 'biz_info')
      if (biCols.has('username') && biCols.has('type')) {
        const biz = db.prepare('SELECT username, type FROM biz_info').all() as Array<{ username: string; type: number }>
        for (const b of biz) bizTypes.set(b.username, b.type)
      }
    } catch { /* no biz_info */ }

    const contacts: WechatContact[] = []
    const stats: Record<string, number> = { friend: 0, enterprise: 0, group: 0, official: 0, service: 0, member: 0, system: 0, deleted: 0 }
    for (const r of rows) {
      const id = Number(r[sel('id', '0')] ?? 0)
      const username = cellString(r[sel('username', '')])
      if (!username) continue
      const nickName = cellString(r[sel('nick_name', '')])
      const remark = cellString(r[sel('remark', '')])
      const localType = Number(r[sel('local_type', '0')] ?? 0)
      const deleteFlag = Number(r[sel('delete_flag', '0')] ?? 0)
      let category = categoryOf(localType, username, deleteFlag)
      if (category === 'official') {
        const bt = bizTypes.get(username)
        if (bt === 1 || bt === 3 || bt === 5) category = 'service'
      }
      const displayName = remark || nickName || username
      const initial = initialOf(
        cellString(r[sel('remark_pin_yin_initial', '')]),
        cellString(r[sel('pin_yin_initial', '')]),
        displayName,
      )
      stats[category] = (stats[category] ?? 0) + 1
      const isGroup = category === 'group'
      const contact: WechatContact = {
        username,
        nickName,
        remark,
        displayName,
        alias: cellString(r[sel('alias', '')]),
        category,
        localTypeLabel: categoryLabel(category),
        initial,
        quanPin: cellString(r[sel('quan_pin', '')]),
        remarkQuanPin: cellString(r[sel('remark_quan_pin', '')]),
        description: cellString(r[sel('description', '')]),
        inChatRoom: Number(r[sel('is_in_chat_room', '0')] ?? 0) === 1,
        localType,
      }
      const avatar = cellString(r[sel('big_head_url', '')]) || cellString(r[sel('small_head_url', '')])
      if (avatar) contact.avatarUrl = avatar
      if (isGroup) {
        const mc = memberCounts.get(id)
        if (mc !== undefined) contact.memberCount = mc
        const owner = roomOwners.get(id)
        if (owner) contact.owner = owner
      } else if (category === 'member') {
        const rid = memberRooms.get(id)
        if (rid !== undefined) {
          const gname = roomUsernames.get(rid) ?? ''
          if (gname) contact.groupUsername = gname
          if (gname) contact.groupName = gname
        }
      }
      contacts.push(contact)
    }
    // source order: initial + quan_pin + display name
    contacts.sort((a, b) => (a.initial ?? '').localeCompare(b.initial ?? '') || (a.quanPin ?? '').localeCompare(b.quanPin ?? '') || a.displayName.localeCompare(b.displayName))
    const total = contacts.length
    // Bound the page payload: the UI lazy-loads pages instead of one full list.
    const page = limit !== undefined ? contacts.slice(offset, offset + limit) : contacts
    return { contacts: page, total, stats }
  } finally {
    db.close()
  }
}
