/**
 * Contact queries over st_control's decrypted contact.db, mirroring the Rust
 * modules/contacts.rs: full category semantics (friend/group/official/service/
 * enterprise/member/system/deleted), pinyin initials, group owner + member
 * counts, member's owning group, and category stats.
 */
import { DatabaseSync } from './db-open.ts'
import { cachedBySig, fileSigOf } from './meta.ts'
import { join } from 'node:path'
import type { WechatContact } from '../types.ts'
import { normalizeOffset, normalizePageLimit } from './limits.ts'
import {
  enterpriseNameFromExtra,
  isEnterpriseWechatUser,
  loadOpenimWordingNames,
} from './openim.ts'
import { readableProfileSignature } from './profile-signature.ts'
import { buildRegion, parseContactExtra } from './region.ts'

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

/** SQLite BLOB may arrive as Buffer or Uint8Array; anything else is empty profile data. */
function cellBuffer(v: unknown): Buffer {
  return v instanceof Uint8Array ? Buffer.from(v) : Buffer.alloc(0)
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
  if (isEnterpriseWechatUser(username)) return 'enterprise'
  if (localType === 1) return 'friend'
  return 'member'
}

/**
 * 联系人类别判定（对外只读口径）。
 *
 * 为什么要把私有函数暴露出来：问答的 `search_contacts` 支持 `kind`
 * （all/person/group/enterprise）过滤，如果它自己再写一份判据，
 * 同一个账号在「找人」与「通讯录」里就可能落到不同类目 ——
 * 用户按「人」筛却看不到通讯录里明明标为「联系人」的账号。
 * @param localType - contact.local_type。
 * @param username - 联系人/群 username。
 * @param deleteFlag - contact.delete_flag。
 * @returns 分类键（friend/enterprise/group/official/service/member/system/deleted）。
 */
export function contactCategoryOf(localType: number, username: string, deleteFlag = 0): string {
  return categoryOf(localType, username, deleteFlag)
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
  /**
   * 可选的搜索词：大小写不敏感地匹配 username / 备注 / 昵称 / 别名 / 全拼列。
   *
   * 与 `category` 一起在 **SQL 里**过滤，再分页 —— 否则「搜索 + 翻页」只能搜到当前
   * 已加载的那一页。`stats` 仍是全量口径（页签计数不随搜索变化）。
   */
  search?: string
}

export function queryContacts(
  decryptedDir: string,
  options?: ContactsPageOptions,
): { contacts: WechatContact[]; total: number; stats: Record<string, number> } {
  // Cache keyed on the contact snapshot's signature. The realtime sync rewrites
  // contact.db under an atomic rename, so the signature changes and this
  // recomputes immediately instead of re-scanning on every panel refresh.
  const limit = normalizePageLimit(options?.limit)
  const offset = normalizeOffset(options?.offset)
  const category = normalizeCategory(options?.category)
  const search = (options?.search ?? '').trim()
  return cachedBySig(
    'contacts:' + decryptedDir + ':' + String(limit ?? '') + ':' + String(offset) + ':' + category + ':' + search,
    fileSigOf(join(decryptedDir, 'contact', 'contact.db')),
    () => computeContacts(decryptedDir, limit, offset, category, search),
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

/** contact.db 的列名集合。 */
type ContactColumns = Set<string>

/** 列名只来自代码常量（PRAGMA 结果），存在则加引号；缺列时退回字面量默认值。 */
function colOf(cols: ContactColumns, name: string, fallback: string): string {
  return cols.has(name) ? `"${name}"` : fallback
}

function castText(expr: string): string {
  return `CAST(${expr} AS TEXT)`
}

/** 一次构造联系人页查询所需的全部 SQL 片段。 */
interface ContactSqlParts {
  /** 分类表达式（含 biz_info 服务号改判）。 */
  categoryExpr: string
  selectCols: string
  orderSql: string
  whereSql: string
  filterArgs: string[]
  baseWhere: string
}

/**
 * P2：把「分类 / 首字母 / 搜索 / 排序」全部翻译成 SQL。
 *
 * 旧实现把 contact（以及 chat_room / chatroom_member / biz_info）整表 `.all()`
 * 进 JS，再在内存里分类、过滤、排序、切片 —— 每次翻页都重新物化全部行、解析全部
 * extra_buffer。现在 `WHERE + ORDER BY + LIMIT/OFFSET` 在 SQLite 内完成，只把当前页
 * 的行解码成 JS 对象；`stats` 另走 GROUP BY，保持全量口径。
 *
 * 排序差异说明：`localeCompare` 使用 ICU collation，SQLite 只有 BINARY；对拼音列
 * （ASCII）两者一致，只有在「首字母 + 全拼都相同」时才会用显示名比较 —— 中文显示名
 * 在 ICU（按拼音）与码点之间可能有细微顺序差异。分页键本身是确定的，不会漏行/重行。
 * @param db - contact.db 连接。
 * @param cols - contact 表的列集合。
 * @param category - 已归一化的分类过滤（空串表示不过滤）。
 * @param search - 已 trim 的搜索词（空串表示不过滤）。
 * @returns SQL 片段与过滤参数。
 */
function buildContactSqlParts(
  db: DatabaseSync,
  cols: ContactColumns,
  category: string,
  search: string,
): ContactSqlParts {
  const usernameCol = colOf(cols, 'username', "''")
  const localTypeCol = colOf(cols, 'local_type', '0')
  const deleteFlagCol = colOf(cols, 'delete_flag', '0')
  const quanPinCol = colOf(cols, 'quan_pin', "''")
  const textOf = (c: string): string => `COALESCE(${castText(colOf(cols, c, "''"))}, '')`

  let bizTypeExpr = 'NULL'
  try {
    const biCols = tableColumns(db, 'biz_info')
    if (biCols.has('username') && biCols.has('type')) {
      // 相关子查询而不是 JOIN：biz_info 即使有重复 username 也不会把 contact 行放大。
      // ⚠️ 外层 username 必须用表名限定，否则子查询里的 `username` 会解析到 biz_info 自己。
      const outerUsername = cols.has('username') ? 'contact."username"' : "''"
      bizTypeExpr = `(SELECT "type" FROM biz_info WHERE ${castText('"username"')} = ${castText(outerUsername)} LIMIT 1)`
    }
  } catch { /* no biz_info */ }

  const rawCategoryExpr = [
    'CASE',
    `WHEN COALESCE(${deleteFlagCol}, 0) <> 0 OR COALESCE(${localTypeCol}, 0) = 4 THEN 'deleted'`,
    `WHEN substr(${castText(usernameCol)}, -9) = '@chatroom' THEN 'group'`,
    `WHEN instr(${castText(usernameCol)}, 'gh_') > 0 THEN 'official'`,
    `WHEN lower(${castText(usernameCol)}) IN ('weixin','notifymessage','cmdamount','floatbottle','fmessage','medianote','qmessage') OR substr(lower(${castText(usernameCol)}), 1, 7) = 'weixin_' THEN 'system'`,
    `WHEN substr(${castText(usernameCol)}, -12) = '@kefu.openim' THEN 'service'`,
    `WHEN substr(${castText(usernameCol)}, -7) = '@openim' AND substr(${castText(usernameCol)}, -12) <> '@kefu.openim' THEN 'enterprise'`,
    `WHEN COALESCE(${localTypeCol}, 0) = 1 THEN 'friend'`,
    `ELSE 'member'`,
    'END',
  ].join(' ')
  // 与 sessions.ts 共用同一判据：biz_info.type 为 1/3/5 的 gh_ 账号归「服务号」。
  const categoryExpr = `CASE WHEN (${rawCategoryExpr}) = 'official' AND COALESCE(${bizTypeExpr}, 0) IN (1, 3, 5)`
    + ` THEN 'service' ELSE (${rawCategoryExpr}) END`

  const remarkInitial = textOf('remark_pin_yin_initial')
  const nickInitial = textOf('pin_yin_initial')
  const pinExpr = `trim(COALESCE(NULLIF(${castText(colOf(cols, 'remark_quan_pin', "''"))}, ''), NULLIF(${castText(quanPinCol)}, '')))`
  const displayExpr = `COALESCE(NULLIF(${castText(colOf(cols, 'remark', "''"))}, ''), NULLIF(${castText(colOf(cols, 'nick_name', "''"))}, ''), ${castText(usernameCol)})`
  const letterOf = (src: string): string => {
    const ch = `upper(substr(${src}, 1, 1))`
    return `CASE WHEN ${ch} BETWEEN 'A' AND 'Z' THEN ${ch} ELSE '' END`
  }
  // `initialOf` 的口径：remarkInitial || nickInitial（空串才回退），再备注全拼 || 昵称全拼，
  // 再显示名；都没有可识别字母时归 '#'。
  const initialExpr = `COALESCE(`
    + ` NULLIF(CASE WHEN ${remarkInitial} <> '' THEN ${letterOf(remarkInitial)} ELSE ${letterOf(nickInitial)} END, ''),`
    + ` NULLIF(${letterOf(pinExpr)}, ''),`
    + ` NULLIF(${letterOf(displayExpr)}, ''),`
    + ` '#')`

  const baseWhere = `COALESCE(${castText(usernameCol)}, '') <> ''`
  const where: string[] = [baseWhere]
  const filterArgs: string[] = []
  if (category !== '') {
    where.push(`(${categoryExpr}) = ?`)
    filterArgs.push(category)
  }
  if (search !== '') {
    const searchTerm = search.toLowerCase()
    const searchable = ['username', 'remark', 'nick_name', 'alias', 'quan_pin', 'remark_quan_pin']
      .filter((c) => cols.has(c))
    if (searchable.length === 0) {
      where.push('0')
    } else {
      where.push('(' + searchable
        .map((c) => `instr(lower(${castText(`"${c}"`)}), ?) > 0`)
        .join(' OR ') + ')')
      for (let i = 0; i < searchable.length; i += 1) filterArgs.push(searchTerm)
    }
  }

  const selectCols = [
    `${colOf(cols, 'id', '0')} AS id`,
    `${usernameCol} AS username`,
    `${localTypeCol} AS local_type`,
    `${colOf(cols, 'alias', "''")} AS alias`,
    `${deleteFlagCol} AS delete_flag`,
    `${colOf(cols, 'remark', "''")} AS remark`,
    `${colOf(cols, 'remark_pin_yin_initial', "''")} AS remark_initial`,
    `${colOf(cols, 'nick_name', "''")} AS nick_name`,
    `${colOf(cols, 'pin_yin_initial', "''")} AS nick_initial`,
    `${quanPinCol} AS quan_pin`,
    `${colOf(cols, 'remark_quan_pin', "''")} AS remark_quan_pin`,
    `${colOf(cols, 'big_head_url', "''")} AS big_head_url`,
    `${colOf(cols, 'small_head_url', "''")} AS small_head_url`,
    `${colOf(cols, 'description', "''")} AS description`,
    `${colOf(cols, 'is_in_chat_room', '0')} AS is_in_chat_room`,
    `${colOf(cols, 'extra_buffer', 'NULL')} AS extra_buffer`,
    `(${categoryExpr}) AS category_key`,
  ].join(', ')
  const orderSql = [
    // '#'（无拼音可依的兜底桶）必须排最后：先按 rank，再按首字母。
    `((${initialExpr}) = '#') ASC`,
    `(${initialExpr}) ASC`,
    `COALESCE(${castText(quanPinCol)}, '') ASC`,
    `(${displayExpr}) ASC`,
    // 稳定分页：旧实现的 sort 是稳定排序，完全相同的键按表扫描顺序；SQL 侧显式补
    // username 作为最后一级，避免同键行在翻页时漂移。
    `COALESCE(${castText(usernameCol)}, '') ASC`,
  ].join(', ')

  return {
    categoryExpr,
    selectCols,
    orderSql,
    whereSql: where.join(' AND '),
    filterArgs,
    baseWhere,
  }
}

/** stats 永远按全量算：分类页签上的数字不能随当前类目/搜索词变化。 */
function contactStats(db: DatabaseSync, categoryExpr: string, baseWhere: string): Record<string, number> {
  const stats: Record<string, number> = { friend: 0, enterprise: 0, group: 0, official: 0, service: 0, member: 0, system: 0, deleted: 0 }
  const rows = db.prepare(
    `SELECT (${categoryExpr}) AS category_key, COUNT(*) AS n FROM contact WHERE ${baseWhere} GROUP BY category_key`,
  ).all() as Array<Record<string, unknown>>
  let all = 0
  for (const row of rows) {
    const key = String(row['category_key'] ?? '')
    const n = Number(row['n'] ?? 0)
    if (!(key in stats)) continue
    stats[key] = (stats[key] ?? 0) + n
    all += n
  }
  // 给界面一个稳定的「全部」总数：即使当前按类目过滤，页签上的「全部(N)」也应显示全量。
  stats.all = all
  return stats
}

/** 页内一行 contact 的解码结果（群信息在第二遍补齐）。 */
interface ContactDraft {
  id: number
  username: string
  nickName: string
  remark: string
  localType: number
  deleteFlag: number
  category: string
  displayName: string
  alias: string
  quanPin: string
  remarkQuanPin: string
  initial: string
  extraRaw: unknown
  avatarBig: string
  avatarSmall: string
  description: string
  inChatRoom: boolean
}

/** 把 SQL 页行解码成 JS 草稿，并收集群 / 成员 id（只针对当前页）。 */
function decodeContactRows(rows: ReadonlyArray<Record<string, unknown>>): {
  drafts: ContactDraft[]
  groupIds: number[]
  memberIds: number[]
} {
  const drafts: ContactDraft[] = []
  const groupIds: number[] = []
  const memberIds: number[] = []
  for (const r of rows) {
    const username = cellString(r['username'])
    if (!username) continue
    const id = Number(r['id'] ?? 0)
    const nickName = cellString(r['nick_name'])
    const remark = cellString(r['remark'])
    const localType = Number(r['local_type'] ?? 0)
    const deleteFlag = Number(r['delete_flag'] ?? 0)
    const categoryKey = String(r['category_key'] ?? '')
    const resolvedCategory = categoryKey || categoryOf(localType, username, deleteFlag)
    const displayName = remark || nickName || username
    const quanPin = cellString(r['quan_pin'])
    const remarkQuanPin = cellString(r['remark_quan_pin'])
    drafts.push({
      id,
      username,
      nickName,
      remark,
      localType,
      deleteFlag,
      category: resolvedCategory,
      displayName,
      alias: cellString(r['alias']),
      quanPin,
      remarkQuanPin,
      initial: initialOf(
        cellString(r['remark_initial']),
        cellString(r['nick_initial']),
        remarkQuanPin,
        quanPin,
        displayName,
      ),
      extraRaw: r['extra_buffer'],
      avatarBig: cellString(r['big_head_url']),
      avatarSmall: cellString(r['small_head_url']),
      description: readableProfileSignature(cellString(r['description'])),
      inChatRoom: Number(r['is_in_chat_room'] ?? 0) === 1,
    })
    if (resolvedCategory === 'group') groupIds.push(id)
    else memberIds.push(id)
  }
  return { drafts, groupIds, memberIds }
}

/** 当前页用到的群信息（owner / 成员数 / 成员所属群）。 */
interface ContactGroupInfo {
  roomOwners: Map<number, string>
  memberCounts: Map<number, number>
  memberRooms: Map<number, string[]>
}

/**
 * 多表合并只针对**当前页**：
 *   · chat_room/chatroom_member —— 群的 owner、成员数、以及非群联系人所属的群；
 *   · biz_info —— 已在分类表达式里用相关子查询处理；
 *   · openim_wording —— 企业名称（只对页内企业微信联系人解码 extra_buffer）。
 * 这样群成员表再大也不会被整表读进 JS；同一个人重复出现在同一群时用 GROUP BY 去重。
 * @param db - contact.db 连接。
 * @param groupIds - 页内群联系人的 contact.id。
 * @param memberIds - 页内非群联系人的 contact.id。
 * @returns 页内群信息映射。
 */
function loadContactGroupInfo(
  db: DatabaseSync,
  groupIds: ReadonlyArray<number>,
  memberIds: ReadonlyArray<number>,
): ContactGroupInfo {
  const roomOwners = new Map<number, string>()
  const roomUsernames = new Map<number, string>()
  const memberCounts = new Map<number, number>()
  /** member_id → 它所在的全部群的 username 列表（旧字段 `groupUsername` 只取第一个）。 */
  const memberRooms = new Map<number, string[]>()
  const uniqueIds = (ids: ReadonlyArray<number>): number[] => [...new Set(ids)]
  const placeholders = (ids: ReadonlyArray<number>): string => ids.map(() => '?').join(', ')
  let roomCols: Set<string> | null = null
  try { roomCols = tableColumns(db, 'chat_room') } catch { roomCols = null }
  let memberCols: Set<string> | null = null
  try { memberCols = tableColumns(db, 'chatroom_member') } catch { memberCols = null }
  const roomIdCol = roomCols?.has('id') ? '"id"' : ''
  const roomUserCol = roomCols?.has('username') ? '"username"' : ''
  const roomOwnerCol = roomCols?.has('owner') ? '"owner"' : ''

  const pageGroupIds = uniqueIds(groupIds)
  if (roomCols !== null && roomIdCol !== '' && pageGroupIds.length > 0) {
    const rows = db.prepare(
      `SELECT ${roomIdCol} AS rid, ${roomUserCol || "''"} AS u, ${roomOwnerCol || "''"} AS o`
      + ` FROM chat_room WHERE ${roomIdCol} IN (${placeholders(pageGroupIds)})`,
    ).all(...pageGroupIds) as Array<Record<string, unknown>>
    for (const r of rows) {
      const rid = Number(r['rid'] ?? 0)
      roomUsernames.set(rid, cellString(r['u']))
      const owner = cellString(r['o'])
      if (owner) roomOwners.set(rid, owner)
    }
  }
  if (memberCols?.has('room_id') && memberCols.has('member_id') && pageGroupIds.length > 0) {
    const rows = db.prepare(
      'SELECT room_id AS rid, COUNT(DISTINCT member_id) AS c FROM chatroom_member'
      + ` WHERE room_id IN (${placeholders(pageGroupIds)}) GROUP BY room_id`,
    ).all(...pageGroupIds) as Array<Record<string, unknown>>
    for (const r of rows) memberCounts.set(Number(r['rid'] ?? 0), Number(r['c'] ?? 0))
  }
  const pageMemberIds = uniqueIds(memberIds)
  if (memberCols?.has('room_id') && memberCols.has('member_id') && pageMemberIds.length > 0) {
    // GROUP BY (member, room) 去重：同一个人在同一群里出现多行时不能把群名重复塞进
    // `groupUsernames`（旧实现会重复，前端按群筛成员时会重复计数）。
    const rows = db.prepare(
      'SELECT room_id AS rid, member_id AS mid FROM chatroom_member'
      + ` WHERE member_id IN (${placeholders(pageMemberIds)}) GROUP BY mid, rid`,
    ).all(...pageMemberIds) as Array<Record<string, unknown>>
    const missingRoomIds = uniqueIds(rows.map((r) => Number(r['rid'] ?? 0)))
      .filter((rid) => rid !== 0 && !roomUsernames.has(rid))
    if (roomCols !== null && roomIdCol !== '' && roomUserCol !== '' && missingRoomIds.length > 0) {
      const roomRows = db.prepare(
        `SELECT ${roomIdCol} AS rid, ${roomUserCol} AS u FROM chat_room`
        + ` WHERE ${roomIdCol} IN (${placeholders(missingRoomIds)})`,
      ).all(...missingRoomIds) as Array<Record<string, unknown>>
      for (const r of roomRows) roomUsernames.set(Number(r['rid'] ?? 0), cellString(r['u']))
    }
    for (const r of rows) {
      const rid = Number(r['rid'] ?? 0)
      const mid = Number(r['mid'] ?? 0)
      const roomName = roomUsernames.get(rid) ?? ''
      if (!roomName) continue
      const list = memberRooms.get(mid)
      if (list) list.push(roomName)
      else memberRooms.set(mid, [roomName])
    }
  }
  return { roomOwners, memberCounts, memberRooms }
}

/** 把页内草稿 + 群信息组装成对外 `WechatContact`（结构与旧实现逐字段一致）。 */
function assembleContacts(
  drafts: ReadonlyArray<ContactDraft>,
  groupInfo: ContactGroupInfo,
  enterpriseWordingNames: ReadonlyMap<string, string>,
): WechatContact[] {
  const contacts: WechatContact[] = []
  for (const d of drafts) {
    const extra = parseContactExtra(cellBuffer(d.extraRaw))
    const region = buildRegion(extra.country ?? '', extra.province ?? '', extra.city ?? '').trim()
    const gender = extra.gender === 1 || extra.gender === 2 ? extra.gender : undefined
    const contact: WechatContact = {
      username: d.username,
      nickName: d.nickName,
      remark: d.remark,
      displayName: d.displayName,
      alias: d.alias,
      category: d.category,
      localTypeLabel: categoryLabel(d.category),
      initial: d.initial,
      quanPin: d.quanPin,
      remarkQuanPin: d.remarkQuanPin,
      description: d.description || readableProfileSignature(extra.signature),
      ...(region === '' ? {} : { region }),
      ...(gender === undefined ? {} : { gender }),
      inChatRoom: d.inChatRoom,
      localType: d.localType,
    }
    if (isEnterpriseWechatUser(d.username)) {
      const enterpriseName = enterpriseNameFromExtra(d.extraRaw, enterpriseWordingNames)
      if (enterpriseName !== undefined) contact.enterpriseName = enterpriseName
    }
    const avatar = d.avatarBig || d.avatarSmall
    if (avatar) contact.avatarUrl = avatar
    if (d.category === 'group') {
      const mc = groupInfo.memberCounts.get(d.id)
      if (mc !== undefined) contact.memberCount = mc
      const owner = groupInfo.roomOwners.get(d.id)
      if (owner) contact.owner = owner
    } else {
      // 2026-10-17 修：归属只由 chatroom_member 决定，与 category 正交；
      // 一个人可以在多个群，`groupUsername` 只留第一个（兼容旧字段），完整列表放
      // `groupUsernames`（前端筛群成员必须用后者）。
      const rooms = groupInfo.memberRooms.get(d.id)
      if (rooms && rooms.length > 0) {
        contact.groupUsername = rooms[0]
        contact.groupName = rooms[0]
        contact.groupUsernames = rooms
      }
    }
    contacts.push(contact)
  }
  return contacts
}

function computeContacts(
  decryptedDir: string,
  limit?: number,
  offset: number = 0,
  category: string = '',
  search: string = '',
): { contacts: WechatContact[]; total: number; stats: Record<string, number> } {
  const db = new DatabaseSync(join(decryptedDir, 'contact', 'contact.db'), { readOnly: true })
  try {
    const cols = tableColumns(db, 'contact')
    const parts = buildContactSqlParts(db, cols, category, search)
    const stats = contactStats(db, parts.categoryExpr, parts.baseWhere)
    // `total` 是当前视图（类目 + 搜索）的条数；无过滤时直接复用 stats 的全量计数。
    const total = category === '' && search === ''
      ? (stats.all ?? 0)
      : Number((db.prepare(`SELECT COUNT(*) AS c FROM contact WHERE ${parts.whereSql}`).get(...parts.filterArgs) as { c?: unknown } | undefined)?.c ?? 0)

    const sql = `SELECT ${parts.selectCols} FROM contact WHERE ${parts.whereSql} ORDER BY ${parts.orderSql}`
      + (limit === undefined ? '' : ' LIMIT ? OFFSET ?')
    const pageArgs: Array<string | number> = [...parts.filterArgs]
    if (limit !== undefined) pageArgs.push(limit, offset)
    const rows = db.prepare(sql).all(...pageArgs) as Array<Record<string, unknown>>

    const { drafts, groupIds, memberIds } = decodeContactRows(rows)
    const groupInfo = loadContactGroupInfo(db, groupIds, memberIds)
    const contacts = assembleContacts(drafts, groupInfo, loadOpenimWordingNames(db))
    return { contacts, total, stats }
  } finally {
    db.close()
  }
}
