/**
 * Contact queries over st_control's decrypted contact.db, mirroring the Rust
 * modules/contacts.rs: full category semantics (friend/group/official/service/
 * enterprise/member/system/deleted), pinyin initials, group owner + member
 * counts, member's owning group, and category stats.
 */
import { DatabaseSync } from 'node:sqlite'
import { cachedBySig, fileSigOf, isServiceBizType } from './meta.ts'
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
 * 好友判据是 **local_type === 1**（曾一度被改成 3，已按实测数据改回，理由见下）。
 *
 * 2026-09-13 用本机真实数据（2143 条 contact）定标，两次结论相反，最终以「互动证据」裁定：
 *
 *   local_type=1 → 417 条：其中 249 个 wxid_*、129 个 gh_*、36 个自定义号；
 *                  **有备注名 266 条**；206 个单聊会话对端里**占 170 个**。
 *   local_type=3 → 1568 条：其中 1355 个 wxid_*、209 个自定义号；
 *                  **有备注名 0 条**；206 个单聊对端里**占 0 个**。
 *
 * 改成 3 的那次调查依据是「3 里有 1249 个 wxid_*，所以是好友」——这个推理不成立：
 * **群成员也是 wxid_\***，一个在群里但从未加好友的人同样是 wxid_*。
 * 而 1568 条 lt=3 里没有任何一条有备注名、也没有任何一条出现在单聊会话里，
 * 这不像「好友」，更像「在群里见过、但从没加过的人」。反过来 lt=1 既被备注、又在聊天，
 * 才是好友。且上游随包带来的 tests/contacts.spec.ts 与 tests/overview.spec.ts 夹具
 * 也用 local_type=1 表示好友 —— 与本次裁定一致（此前把它们判成「测试过时」是错的，
 * 它们一直在正确地报这个 bug）。
 *
 * 注：username 类分支（gh_/内置号/kefu/openim）在好友判断**之前**，所以 lt=1 里那
 * 129 个 gh_* 与内置系统号会被前面的分支先行归为 official/system，不会落进 friend。
 */
function categoryOf(localType: number, username: string, deleteFlag: number): string {
  if (deleteFlag !== 0 || localType === 4) return 'deleted'
  if (username.endsWith('@chatroom')) return 'group'
  if (isOfficialAccount(username)) return 'official'
  if (isBuiltinAccount(username)) return 'system'
  if (username.endsWith('@kefu.openim')) return 'service'
  if (username.endsWith('@openim')) return 'enterprise'
  if (localType === 1) return 'friend'
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

/**
 * Source initial_of: remark initial > nick initial > **全拼首字母** > display first char.
 *
 * ── 为什么需要「全拼首字母」这一步（2026-09 补） ──────────────────────
 * 只信 `remark_pin_yin_initial` / `pin_yin_initial` 这两列时，**群成员一律落进 `#`**：
 * 微信只为「加过好友」的联系人写这两列；群成员（在群里见过、但从没加过好友的人，
 * 实测 `local_type=3` 有 1500+ 条）这两列是空的，于是 `raw` 退到中文 `displayName`，
 * `/[A-Z]/` 不匹配 → 全部返回 `#`。表现就是「群成员」整屏没有字母分组、「全部」也
 * 以 `#` 为主（实测形状：friend 得 `[["B",2]]`，member 得 `[["#",4]]`）。
 *
 * 而**全拼列对群成员是有值的**（`remark_quan_pin` 是备注全拼、`quan_pin` 是昵称全拼，
 * 第 85 轮起已在读）——所以从全拼取首字母就能把这些人正确归位。顺序与 `displayName`
 * 的口径一致（备注优先于昵称），否则同一张卡片会「显示 B 开头的备注、却归到 Q 组」。
 *
 * @param remarkInitial - contact.remark_pin_yin_initial（可能为空）。
 * @param nickInitial - contact.pin_yin_initial（可能为空）。
 * @param remarkQuanPin - contact.remark_quan_pin（备注全拼，可能为空）。
 * @param quanPin - contact.quan_pin（昵称全拼，可能为空）。
 * @param display - 显示名（备注 > 昵称 > 用户名）。
 * @returns A–Z 首字母，无法判定时为 `#`。
 */
function initialOf(
  remarkInitial: string,
  nickInitial: string,
  remarkQuanPin: string,
  quanPin: string,
  display: string,
): string {
  // ① 微信写好首字母的列（好友通常有）
  const raw = remarkInitial || nickInitial
  const ch = raw.slice(0, 1).toUpperCase()
  if (/[A-Z]/.test(ch)) return ch
  // ② 从全拼补推（群成员走这条；备注全拼优先，与 displayName 口径一致）
  const pin = (remarkQuanPin || quanPin).trim()
  const pch = pin.slice(0, 1).toUpperCase()
  if (/[A-Z]/.test(pch)) return pch
  // ③ 显示名本身以拉丁字母开头（如 "ai 回复机器人"）
  const dch = display.trim().slice(0, 1).toUpperCase()
  if (/[A-Z]/.test(dch)) return dch
  // ④ 中文且没有任何拼音列可依 —— 只能进 `#`（排在最后）
  return '#'
}

/**
 * Read the contact book.
 * @param decryptedDir - decrypted data root.
 * @returns the contacts snapshot (contacts + per-category stats).
 */
export interface ContactsPageOptions {
  limit?: number
  offset?: number
  /**
   * 只返回该分类的联系人（friend/group/official/service/enterprise/member/system/deleted）。
   *
   * **必须在分页之前过滤**：界面的分类页签（"联系人(282)"）如果靠渲染层在已分页的
   * 结果上再 filter，那么当全局排序（字母 + 全拼）的前 N 条里恰好没有该类目时，
   * 页签看起来就是空的 —— 明明有 282 个联系人却显示"暂无联系人"。把过滤下沉到这里，
   * `total` 与分页切片都按同一口径计算，页签才能显示完整。
   *
   * 未传（或传 `all`）时行为与之前完全一致。
   */
  category?: string
}

export function queryContacts(
  decryptedDir: string,
  options?: ContactsPageOptions,
): { contacts: WechatContact[]; total: number; stats: Record<string, number> } {
  // Cache keyed on the contact snapshot's signature. The realtime sync rewrites
  // contact.db under an atomic rename, so the signature changes and this
  // recomputes immediately instead of re-scanning on every panel refresh.
  const limit = options?.limit
  const offset = options?.offset ?? 0
  const category = normalizeCategory(options?.category)
  return cachedBySig(
    'contacts:' + decryptedDir + ':' + String(limit ?? '') + ':' + String(offset) + ':' + category,
    fileSigOf(join(decryptedDir, 'contact', 'contact.db')),
    () => computeContacts(decryptedDir, limit, offset, category),
  )
}

/**
 * 归一化分类参数：`undefined` / 空串 / `all` 都表示"不过滤"。
 * @param category - 调用方传入的分类。
 * @returns 可直接比较的分类键，或空串表示不过滤。
 */
function normalizeCategory(category?: string): string {
  if (typeof category !== 'string') return ''
  const c = category.trim()
  if (c === '' || c === 'all') return ''
  return c
}

function computeContacts(
  decryptedDir: string,
  limit?: number,
  offset: number = 0,
  category: string = '',
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
      // 与聊天列表（sessions.ts）共用同一判据，避免同一账号在两个面板落到不同类目。
      if (category === 'official' && isServiceBizType(bizTypes.get(username))) category = 'service'
      const displayName = remark || nickName || username
      // 全拼列在下面构造 contact 时还要用，这里先解一次复用（cellString 会做 UTF-8 解码，
      // 重复调用等于对同一格解码两次）。
      const quanPin = cellString(r[sel('quan_pin', '')])
      const remarkQuanPin = cellString(r[sel('remark_quan_pin', '')])
      const initial = initialOf(
        cellString(r[sel('remark_pin_yin_initial', '')]),
        cellString(r[sel('pin_yin_initial', '')]),
        remarkQuanPin,
        quanPin,
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
        quanPin,
        remarkQuanPin,
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
    // '#'（无拼音可依的兜底桶）必须排**最后**。原实现写成
    // `a[0] === '#' ? 1 : b[0] === '#' ? -1 : localeCompare(...)`，但这个三元是空转的：
    // `'#'.localeCompare('A') === -1`（locale 排序把标点排在字母之前），
    // 于是 '#' 组实际排在最前 —— 一进「全部」先看到的是一屏没有字母分类的人。
    //
    // 这里改用显式分级：字母组 rank 0、'#' 组 rank 1，rank 大的排后面。
    // （注意方向：`return ra - rb` —— 给 '#' 更大的 rank 才会把它推到最后。）
    const initialRank = (s: string): number => (s === '#' ? 1 : 0)
    const byInitial = (a: string, b: string): number => {
      const ra = initialRank(a)
      const rb = initialRank(b)
      if (ra !== rb) return ra - rb
      if (ra === 1) return 0 // 两个都是 '#'：无需再比首字母
      return a < b ? -1 : a > b ? 1 : 0
    }
    contacts.sort((a, b) => byInitial(a.initial ?? '#', b.initial ?? '#') || (a.quanPin ?? '').localeCompare(b.quanPin ?? '') || a.displayName.localeCompare(b.displayName))
    // 分类过滤必须在 `total` 与切片**之前**（口径一致：total 就是当前视图的总条数）。
    // `stats` 始终是全量口径 —— 页签上的数字不该随当前选中的类目变化。
    const visible = category ? contacts.filter(c => c.category === category) : contacts
    const total = visible.length
    // 给界面一个稳定的「全部」总数：即使当前按类目过滤，页签上的「全部(N)」也应显示全量。
    // （此前界面拿 total 当「全部」的计数，过滤下沉后 total 变成当前类目数，会把
    //  「全部(2150)」显示成「全部(282)」——所以这里显式补一个 all。）
    stats.all = contacts.length
    // Bound the page payload: the UI lazy-loads pages instead of one full list.
    const page = limit !== undefined ? visible.slice(offset, offset + limit) : visible
    return { contacts: page, total, stats }
  } finally {
    db.close()
  }
}
