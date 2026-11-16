/**
 * Unified search across local WeChat data domains: messages (index), contacts,
 * moments, favorites, files, and records. Every domain is best-effort and
 * returns its own typed hit shape; one failed domain never blocks the others.
 *
 * 每个域的连接都经 `withDb` 打开 —— catch 分支只负责降级成空结果，
 * 句柄由 `withDb` 的 finally 关掉（P0-1：原先 catch 拿不到 try 内的 `const db`，
 * 一次查询抛错就永久泄漏一个 SQLite 句柄）。
 */
import { withDb, type DatabaseSync } from './db-open.ts'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fmtDateTimeSec } from '../format.ts'
import type {
  UnifiedSearchContact,
  UnifiedSearchDomainError,
  UnifiedSearchFavorite,
  UnifiedSearchFile,
  UnifiedSearchMoment,
  UnifiedSearchRecord,
  UnifiedSearchResourceDomain,
  UnifiedSearchSnapshot,
} from '../types.ts'
import { searchIndexMessages, searchIndexMessagesCancellable, type SearchControl } from './search.ts'
import { contactMeta, shardCatalogDirs } from './meta.ts'
import { favTypeLabel, parseFavContent, parseFavParts } from './favorites.ts'
import { parseSnsXml } from './moments.ts'
import { resolveSelfUsername } from '../config/resolve.ts'
import { isEnterpriseWechatUser, loadOpenimDirectoryFromDb } from './openim.ts'
import {
  displayNameForUsername,
  isMessageTableHash,
  messageTableHash,
  messageTableName,
  resolveChatIdentity,
  resolveTalkerUsername,
} from './message-identity.ts'
import { parseMessageContent } from './parse.ts'
import { parseCnyAmount } from './payment-money.ts'
import { queryRecords } from './records.ts'

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

/** Session titles provide a group/contact fallback when contact.db has no display name. */
function loadRecordSessionTitles(decryptedDir: string): Map<string, string> {
  const titles = new Map<string, string>()
  const path = join(decryptedDir, 'session', 'session.db')
  if (!existsSync(path)) return titles
  try {
    withDb(path, (db) => {
      const has = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='SessionNoContactInfoTable'",
      ).get() !== undefined
      if (!has) return
      const rows = db.prepare(
        'SELECT username, session_title FROM SessionNoContactInfoTable',
      ).all() as Array<{ username: unknown; session_title: unknown }>
      for (const row of rows) {
        const stored = cellString(row.username).trim()
        const username = stored ? resolveTalkerUsername(decryptedDir, stored) : ''
        const title = cellString(row.session_title).trim()
        if (username !== '' && title !== '' && title !== stored && !isMessageTableHash(title)) {
          titles.set(username, title)
        }
      }
    })
  } catch { /* session.db schema drift: records still use contact/participant fallbacks */ }
  return titles
}

function like(q: string): string {
  return '%' + q + '%'
}

/** Stored references may predate canonical identities: accept both the real
 * username and the physical message-table forms when scoping a query. */
function storedChatAliases(username: string, displayName?: string): string[] {
  const aliases = [
    username,
    messageTableHash(username),
    messageTableName(username),
    displayName?.trim() ?? '',
  ].filter(Boolean)
  return [...new Set(aliases)]
}

/**
 * 一个域读失败时记一笔（域名 + 原因）。
 *
 * 域名用中文是刻意的：这个字符串会原样出现在全局搜索的下拉里，
 * 用户看得懂的「联系人读不到」才有用，`contacts` 只是给日志看的。
 */
interface DomainFailure {
  domain: string
  key: 'contacts' | 'moments' | 'favorites' | 'files' | 'records'
  reason: string
}
function noteFailure(
  sink: DomainFailure[],
  domain: string,
  key: DomainFailure['key'],
  err: unknown,
): void {
  const msg = err instanceof Error ? err.message : String(err)
  sink.push({ domain, key, reason: msg.slice(0, 160) })
}

/**
 * 域错误的运行时类别。
 *
 * `types-insights.ts` 里的联合类型只有 `read_failed | unsupported_scope`；
 * 工具路径还需要把「库还没解密/生成」单独说清楚，否则会被模型转述成「没有记录」。
 * 这里只在运行时扩展，快照对外仍按原有形状序列化（多的 code 是超集）。
 */
type DomainErrorCode = UnifiedSearchDomainError['code'] | 'not_configured'
interface DomainErrorEntry {
  code: DomainErrorCode
  message: string
}
type DomainErrorMap = Partial<Record<UnifiedSearchResourceDomain, DomainErrorEntry>>

/**
 * 内容域工具的过滤/排序选项（全局搜索面板不传 ⇒ 行为与旧版一致）。
 *
 * `domains` 是工具路径的开关：只有显式指定时，空查询才会去列「最近的资源」；
 * 不指定时保持旧语义（空查询直接返回空快照，不把 LIKE '%%' 扫全库）。
 */
export interface UnifiedSearchOptions {
  from?: string
  to?: string
  username?: string
  /** 只运行这些资源域；提供后允许空查询 = 最近条目。 */
  domains?: ReadonlyArray<UnifiedSearchResourceDomain>
  /** 缺库/缺表时写入 domainErrors（工具路径要区分「缺库」与「确实没有」）。 */
  reportMissing?: boolean
  /** 时间排序：recent = 最新在前（默认），oldest = 最早在前。 */
  order?: 'recent' | 'oldest'
  /** 记录类型过滤（`revokes` 走 `queryRecords` 的撤回域）。 */
  recordKind?: 'all' | 'transfers' | 'redpackets' | 'revokes'
  /** 收支方向；只有转账/红包能判定。 */
  direction?: 'all' | 'in' | 'out'
  /** 金额区间（分，含边界）；仅转账/红包，未知金额的行不满足区间。 */
  minAmountCents?: number
  maxAmountCents?: number
  /** 收藏类型过滤（未知类型归 other）。 */
  favoriteType?: 'all' | 'text' | 'image' | 'video' | 'file' | 'link' | 'other'
  /** 文件大类过滤。 */
  fileCategory?: 'all' | 'file' | 'image' | 'video'
  /** 文件排序：recent = 修改时间倒序，size = 体积倒序。 */
  fileOrder?: 'recent' | 'size'
  /** 文件体积区间（字节，含边界）。 */
  minSize?: number
  maxSize?: number
  /** 从消息分片解析支付卡片金额（仅工具路径开启）。 */
  resolveRecordMoney?: boolean
}

/** 记录行的内部形状：在公开的 `UnifiedSearchRecord` 上补金额/方向/状态。 */
interface UnifiedSearchRecordInternal extends UnifiedSearchRecord {
  /** 排序用的原始秒级时间（`time` 是格式化字符串）。 */
  timeSec?: number
  /** 金额（分）；`null` = 已查但支付卡片没有金额。 */
  amountCents?: number | null
  direction?: 'in' | 'out' | 'unknown'
  /** 人类可读状态（与「转账红包」面板一致：未验证的字段只展示原始值）。 */
  statusLabel?: string
  /** 精确类型（公开字段 `kind` 是 string）。 */
  recordKind?: 'transfers' | 'redpackets' | 'revokes'
}

/** Contact names: remark > nick > username, plus category label. */
function searchContacts(
  sink: DomainFailure[],
  decryptedDir: string,
  q: string,
  cap: number,
  username?: string,
): UnifiedSearchContact[] {
  const p = join(decryptedDir, 'contact', 'contact.db')
  if (!existsSync(p)) return []
  try {
    return withDb(p, (db) => {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='contact'").get() !== undefined
      if (!has) return []
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
      if (!userCol) return []
      const searchCols = [userCol, remarkCol, nickCol, aliasCol, quanCol, remarkQuanCol].filter(Boolean)
      const likeClauses = searchCols.map(c => `${c} LIKE ?`).join(' OR ')
      if (!likeClauses) return []
      const params = searchCols.map(() => like(q))
      const enterpriseNames = loadOpenimDirectoryFromDb(db).enterpriseNames
      const matchedEnterpriseUsers = [...enterpriseNames]
        .filter(([, name]) => name.toLocaleLowerCase().includes(q.toLocaleLowerCase()))
        .map(([contactUsername]) => contactUsername)
      const enterpriseSql = matchedEnterpriseUsers.length > 0
        ? ` OR ${userCol} IN (${matchedEnterpriseUsers.map(() => '?').join(', ')})`
        : ''
      const userSql = username ? ` AND ${userCol} = ?` : ''
      const userParam = username ? [username] : []
      const rows = db.prepare(`SELECT ${userCol} AS u, ${remarkCol || 'NULL'} AS r, ${nickCol || 'NULL'} AS n, ${aliasCol || 'NULL'} AS a FROM contact WHERE (${likeClauses}${enterpriseSql})${userSql} LIMIT ?`).all(...params, ...matchedEnterpriseUsers, ...userParam, cap) as Array<Record<string, unknown>>
      // 群人数只服务群聊结果。一次把 room → count 读成 Map，避免每行再开一次查询。
      const memberCounts = new Map<string, number>()
      try {
        const roomTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chat_room'").get()
        const memberTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='chatroom_member'").get()
        if (roomTable !== undefined && memberTable !== undefined) {
          const rooms = db.prepare('SELECT id, username FROM chat_room').all() as Array<{ id: unknown; username: unknown }>
          const roomUsers = new Map<number, string>()
          for (const room of rooms) {
            const id = Number(room.id ?? 0)
            const roomUsername = cellString(room.username).trim()
            if (id > 0 && roomUsername !== '') roomUsers.set(id, roomUsername)
          }
          const counts = db.prepare('SELECT room_id, COUNT(*) AS c FROM chatroom_member GROUP BY room_id').all() as Array<{ room_id: unknown; c: unknown }>
          for (const row of counts) {
            const roomUsername = roomUsers.get(Number(row.room_id ?? 0))
            if (roomUsername !== undefined) memberCounts.set(roomUsername, Number(row.c ?? 0))
          }
        }
      } catch { /* 群表缺失或版本不同：不阻断联系人主结果 */ }
      return rows.map((r) => {
        const contactUsername = cellString(r.u)
        const remark = cellString(r.r).trim()
        const nickname = cellString(r.n).trim()
        const alias = cellString(r.a).trim()
        const memberCount = contactUsername.endsWith('@chatroom') ? memberCounts.get(contactUsername) : undefined
        const enterpriseName = enterpriseNames.get(contactUsername)?.trim()
        const category = contactUsername.endsWith('@chatroom')
          ? 'group'
          : contactUsername.startsWith('gh_')
            ? 'official'
            : contactUsername.endsWith('@kefu.openim')
              ? 'service'
              : isEnterpriseWechatUser(contactUsername)
                ? 'enterprise'
                : 'contact'
        return {
          username: contactUsername,
          name: remark || nickname || alias || contactUsername,
          category,
          ...(enterpriseName ? { enterpriseName } : {}),
          ...(remark !== '' ? { remark } : {}),
          ...(nickname !== '' ? { nickname } : {}),
          ...(alias !== '' ? { alias } : {}),
          ...(memberCount !== undefined ? { memberCount } : {}),
        }
      })
    })
  } catch (e) {
    noteFailure(sink, '联系人', 'contacts', e)
    return []
  }
}

/** 时间过滤条件：`from` = 当天 00:00，`to` = 当天 23:59:59（本地时区）。 */
interface TimeRange {
  fromSec: number
  toSec: number
}

/** 严格校验 `YYYY-MM-DD`（拒绝 `2026-02-30`）。 */
function validDay(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return false
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const probe = new Date(year, month - 1, day)
  return probe.getFullYear() === year && probe.getMonth() === month - 1 && probe.getDate() === day
}

/**
 * 把 `YYYY-MM-DD` 转成时间过滤范围。
 *
 * 这里只接受严格格式；调用方（`searchUnified`）会先校验一次并返回
 * `unsupported_scope`，所以本函数不会把非法日期静默变成「不过滤」。
 */
function dayRange(from: string, to: string): TimeRange {
  const start = (d: string): number => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d)
    if (!m) return 0
    return Math.floor(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0).getTime() / 1000)
  }
  const fromSec = from ? start(from) : 0
  const toStart = to ? start(to) : 0
  return { fromSec, toSec: toStart === 0 ? 0 : toStart + 86399 }
}


/** Moments by author + content LIKE (or recent list when the query is empty). */
function searchMoments(
  sink: DomainFailure[],
  decryptedDir: string,
  q: string,
  cap: number,
  range?: TimeRange,
  username?: string,
  opts?: UnifiedSearchOptions,
): UnifiedSearchMoment[] {
  const dbPathCandidates = [join(decryptedDir, 'sns', 'db_sns', 'sns.db'), join(decryptedDir, 'sns', 'sns.db')]
  const hasQuery = q.trim() !== ''
  const dir = opts?.order === 'oldest' ? 'ASC' : 'DESC'
  let sawDb = false
  let sawTable = false
  let readFailed = false
  for (const p of dbPathCandidates) {
    if (!existsSync(p)) continue
    sawDb = true
    try {
      // `null` = 这个路径里没有可用的 SnsTimeLine 表 → 换下一个候选路径；数组（含空数组）= 命中这个库。
      const hits = withDb(p, (db): UnifiedSearchMoment[] | null => {
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined
        if (!has) return null
        const cols = tableColumns(db, 'SnsTimeLine')
        const uname = cols.has('user_name') ? 'user_name' : cols.has('userName') ? 'userName' : ''
        const content = cols.has('content') ? 'content' : cols.has('Content') ? 'Content' : ''
        if (!uname || !content) return null
        sawTable = true
        const idCol = cols.has('tid') ? 'tid' : cols.has('Id') ? 'Id' : 'rowid'
        const idExpr = idCol === 'rowid' ? 'rowid' : `CAST(${idCol} AS TEXT)`
        const timeCol = cols.has('createTime') ? 'createTime' : cols.has('create_time') ? 'create_time' : ''
        // 作者显示名也要能搜：朋友圈面板内是按 `m.author`（解析后的显示名）过滤的，
        // 而这里原先只比正文 ⇒ 同一个词「面板内筛得出 57 条、全局搜索 0 条」。
        // 显示名存在通讯录里，做法是先把匹配的用户名算出来，再用 IN 精确命中。
        const meta = contactMeta(decryptedDir)
        const names = meta.names
        const enterpriseNames = meta.enterpriseNames
        const lower = q.trim().toLowerCase()
        const matchedAuthors = new Set<string>()
        if (hasQuery) {
          for (const [authorUsername, name] of names) {
            if (String(name).toLowerCase().includes(lower)) matchedAuthors.add(authorUsername)
          }
          for (const [authorUsername, enterpriseName] of enterpriseNames) {
            if (enterpriseName.toLowerCase().includes(lower)) matchedAuthors.add(authorUsername)
          }
        }
        const authorUsers = [...matchedAuthors].slice(0, 50)
        const inSql = authorUsers.length > 0 ? ' OR ' + uname + ' IN (' + authorUsers.map(() => '?').join(', ') + ')' : ''
        if (range && timeCol === '') {
          // 老库没有时间列：无法执行范围过滤，必须明确报错，不能静默扩大范围。
          sink.push({
            domain: '朋友圈',
            key: 'moments',
            reason: 'unsupported_scope: 该朋友圈库没有时间列，无法应用日期范围',
          })
          return []
        }
        const conditions: string[] = []
        const params: Array<string | number> = []
        if (hasQuery) {
          conditions.push(`(${content} LIKE ? OR ${uname} LIKE ?${inSql})`)
          params.push(like(q), like(q), ...authorUsers)
        }
        if (username) {
          conditions.push(`${uname} = ?`)
          params.push(username)
        }
        if (range && timeCol !== '') {
          if (range.fromSec > 0) {
            conditions.push(`${timeCol} >= ?`)
            params.push(range.fromSec)
          }
          if (range.toSec > 0) {
            conditions.push(`${timeCol} <= ?`)
            params.push(range.toSec)
          }
        }
        const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
        // 默认最新在前；时间列缺失的老库保持原顺序（无法安全排序）。
        const orderSql = timeCol !== '' ? ` ORDER BY ${timeCol} ${dir}` : ''
        const rows = db.prepare(`SELECT ${idExpr} AS i, ${uname} AS u, ${content} AS c${timeCol ? `, ${timeCol} AS t` : ''} FROM SnsTimeLine${whereSql}${orderSql} LIMIT ?`)
          .all(...params, cap) as Array<{ i: unknown; u: unknown; c: unknown; t?: unknown }>
        return rows.map((r) => {
          const authorUsername = cellString(r.u)
          const xml = cellString(r.c)
          const parsed = parseSnsXml(xml)
          const firstImage = parsed.images[0]
          const firstVideo = parsed.videos[0]
          const media = firstImage ?? firstVideo
          const time = Number(r.t ?? 0) > 0
            ? fmtDateTimeSec(Number(r.t))
            : fmtDateTimeSec(parsed.createTime)
          const enterpriseName = enterpriseNames.get(authorUsername)?.trim()
          return {
            username: authorUsername,
            name: displayNameForUsername(authorUsername, names, parsed.nickname),
            ...(enterpriseName ? { enterpriseName } : {}),
            snippet: (parsed.text || xml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()).slice(0, 200),
            tid: cellString(r.i),
            time,
            ...(media?.id ? { mediaId: media.id } : {}),
            ...(media ? { mediaKind: firstVideo ? 'video' as const : 'image' as const } : {}),
            ...(media?.md5 ? { md5: media.md5 } : {}),
            ...(media?.url ? { url: media.url } : {}),
            ...(firstImage?.token ? { token: firstImage.token } : {}),
            ...(firstImage?.key ? { seed: firstImage.key } : {}),
          }
        })
      })
      if (hits) return hits
    } catch (e) { /* 两个候选路径都读不到才算这个域失败（中间那次成功会先 return） */
      readFailed = true
      noteFailure(sink, '朋友圈', 'moments', e) }
  }
  if (opts?.reportMissing && !readFailed) {
    if (!sawDb) {
      sink.push({
        domain: '朋友圈',
        key: 'moments',
        reason: 'not_configured: 还没有朋友圈数据（sns.db 不存在）：请先完成解密，或在微信里打开朋友圈让该库生成',
      })
    } else if (!sawTable) {
      sink.push({
        domain: '朋友圈',
        key: 'moments',
        reason: 'not_configured: 朋友圈库里没有 SnsTimeLine 表，无法列出动态',
      })
    }
  }
  return []
}

/** 收藏类型 → fav_db_item.type 取值（未列出的类型归 other）。 */
function favoriteTypeSql(type: NonNullable<UnifiedSearchOptions['favoriteType']>, typeCol: string): string | undefined {
  const known = [1, 2, 4, 5, 8].join(', ')
  switch (type) {
    case 'text': return `${typeCol} = 1`
    case 'image': return `${typeCol} = 2`
    case 'video': return `${typeCol} = 4`
    case 'link': return `${typeCol} = 5`
    case 'file': return `${typeCol} = 8`
    // 语音/位置/音乐/聊天记录/商品/笔记/小程序/视频号以及未知 type 值都归 other。
    case 'other': return `(${typeCol} IS NULL OR ${typeCol} NOT IN (${known}))`
    default: return undefined
  }
}

/** Favorites by content LIKE (fav_db_item in favorite.db); empty query = recent list. */
function searchFavorites(
  sink: DomainFailure[],
  decryptedDir: string,
  q: string,
  cap: number,
  range?: TimeRange,
  username?: string,
  opts?: UnifiedSearchOptions,
): UnifiedSearchFavorite[] {
  const p = join(decryptedDir, 'favorite', 'favorite.db')
  const hasQuery = q.trim() !== ''
  if (!existsSync(p)) {
    if (opts?.reportMissing) {
      sink.push({
        domain: '收藏',
        key: 'favorites',
        reason: 'not_configured: 还没有收藏数据（favorite.db 不存在）：请先完成解密，或在微信里打开收藏让该库生成',
      })
    }
    return []
  }
  try {
    return withDb(p, (db) => {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fav_db_item'").get() !== undefined
      if (!has) {
        if (opts?.reportMissing) {
          sink.push({ domain: '收藏', key: 'favorites', reason: 'not_configured: 收藏库里没有 fav_db_item 表，无法列出收藏' })
        }
        return []
      }
      const cols = tableColumns(db, 'fav_db_item')
      const idCol = cols.has('local_id') ? 'local_id' : cols.has('Id') ? 'Id' : '0'
      const contentCol = cols.has('content') ? 'content' : cols.has('Content') ? 'Content' : ''
      if (!contentCol) {
        if (opts?.reportMissing) {
          sink.push({ domain: '收藏', key: 'favorites', reason: 'not_configured: 收藏表缺少 content 列，无法解析收藏条目' })
        }
        return []
      }
      // content 是收藏条目 XML（标题/描述就在里面），另加来源人 / 来源会话名，
      // 与「我的收藏」面板的搜索面（标题/描述/来源/正文/来源人/会话名）对齐。
      const cols2 = tableColumns(db, 'fav_db_item')
      const fromCol = cols2.has('fromusr') ? 'fromusr' : ''
      const chatCol = cols2.has('realchatname') ? 'realchatname' : ''
      const typeCol = cols2.has('type') ? 'type' : ''
      const timeCol = cols2.has('update_time') ? 'update_time' : ''
      const serverCol = cols2.has('server_id') ? 'CAST(server_id AS TEXT)' : "''"
      const sourceCol = cols2.has('source_id') ? 'CAST(source_id AS TEXT)' : "''"
      const fromExpr = fromCol || "''"
      const chatExpr = chatCol || "''"
      const conditions: string[] = []
      const params: Array<string | number> = []
      if (hasQuery) {
        const extraSql = [fromCol, chatCol].filter(Boolean).map(c => ' OR ' + c + ' LIKE ?').join('')
        conditions.push(`(${contentCol} LIKE ?${extraSql})`)
        params.push(like(q))
        for (const col of [fromCol, chatCol]) {
          if (col) params.push(like(q))
        }
      }
      if (username && fromCol === '' && chatCol === '') {
        sink.push({
          domain: '收藏',
          key: 'favorites',
          reason: 'unsupported_scope: 该收藏库没有来源用户/会话列，无法按会话过滤',
        })
        return []
      }
      const meta = contactMeta(decryptedDir)
      const scopeAliases = username
        ? storedChatAliases(username, meta.names.get(username))
        : []
      if (username) {
        conditions.push(`(${[fromCol, chatCol].filter(Boolean).flatMap(col =>
          scopeAliases.map(() => `${col} = ?`),
        ).join(' OR ')})`)
        params.push(...[fromCol, chatCol].filter(Boolean).flatMap(() => scopeAliases))
      }
      const favoriteType = opts?.favoriteType ?? 'all'
      if (favoriteType !== 'all') {
        if (typeCol === '') {
          sink.push({
            domain: '收藏',
            key: 'favorites',
            reason: 'unsupported_scope: 该收藏库没有 type 列，无法按收藏类型过滤',
          })
          return []
        }
        const typeSql = favoriteTypeSql(favoriteType, typeCol)
        if (typeSql !== undefined) conditions.push(typeSql)
      }
      if (range && timeCol === '') {
        sink.push({
          domain: '收藏',
          key: 'favorites',
          reason: 'unsupported_scope: 该收藏库没有 update_time 列，无法应用日期范围',
        })
        return []
      }
      if (range && timeCol !== '') {
        if (range.fromSec > 0) {
          conditions.push(`${timeCol} >= ?`)
          params.push(range.fromSec)
        }
        if (range.toSec > 0) {
          conditions.push(`${timeCol} <= ?`)
          params.push(range.toSec)
        }
      }
      const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
      const dir = opts?.order === 'oldest' ? 'ASC' : 'DESC'
      const orderSql = timeCol !== '' ? ` ORDER BY ${timeCol} ${dir}` : ''
      const rows = db.prepare(`SELECT ${idCol} AS id, ${contentCol} AS c, ${typeCol || '0'} AS ty, ${timeCol || '0'} AS t, ${serverCol} AS sid, ${sourceCol} AS src, ${fromExpr} AS fu, ${chatExpr} AS cn FROM fav_db_item${whereSql}${orderSql} LIMIT ?`)
        .all(...params, cap) as Array<{ id: unknown; c: unknown; ty: unknown; t: unknown; sid: unknown; src: unknown; fu: unknown; cn: unknown }>
      return rows.map((r) => {
        const xml = cellString(r.c)
        const type = Number(r.ty ?? 0)
        const parsed = parseFavContent(type, xml)
        const parts = parseFavParts(xml)
        const media = parts.find(part => part.kind !== 'text' && (part.fullMd5 || part.md5 || part.name || part.url))
        const contentMd5 = media?.md5 || media?.fullMd5 || media?.thumbMd5 || ''
        const storedFromUsr = cellString(r.fu).trim()
        const storedChatName = cellString(r.cn).trim()
        const fromIdentity = storedFromUsr ? resolveChatIdentity(decryptedDir, storedFromUsr) : undefined
        const chatIdentity = storedChatName ? resolveChatIdentity(decryptedDir, storedChatName) : undefined
        const source = chatIdentity?.resolved
          ? chatIdentity.displayName
          : (fromIdentity?.resolved ? fromIdentity.displayName : '')
        const sourceEnterpriseName = (
          (chatIdentity?.username ? meta.enterpriseNames.get(chatIdentity.username) : undefined)
          || (fromIdentity?.username ? meta.enterpriseNames.get(fromIdentity.username) : undefined)
          || ''
        ).trim()
        return {
          id: Number(r.id ?? 0),
          snippet: parsed.desc || parsed.title || xml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100),
          title: parsed.title,
          time: fmtDateTimeSec(Number(r.t ?? 0)),
          updateTime: Number(r.t ?? 0),
          type,
          typeLabel: favTypeLabel(type),
          ...(cellString(r.sid) ? { serverId: cellString(r.sid) } : {}),
          ...(cellString(r.src) ? { sourceId: cellString(r.src) } : {}),
          ...(source ? { source } : {}),
          ...(sourceEnterpriseName ? { sourceEnterpriseName } : {}),
          ...(media ? {
            resourceKind: media.kind,
            ...(media.name ? { fileName: media.name } : {}),
            ...(media.size !== undefined ? { size: media.size } : {}),
            ...(contentMd5 ? { md5: contentMd5 } : {}),
            ...(media.thumbMd5 ? { thumbMd5: media.thumbMd5 } : {}),
            ...(media.fullMd5 ? { fullMd5: media.fullMd5 } : {}),
            ...(media.url ? { url: media.url } : {}),
          } : {}),
        }
      })
    })
  } catch (e) {
    noteFailure(sink, '收藏', 'favorites', e)
    return []
  }
}

/** Files by file_name LIKE across hardlink tables (empty query = recent files). */
function searchFiles(
  sink: DomainFailure[],
  decryptedDir: string,
  q: string,
  cap: number,
  range?: TimeRange,
  username?: string,
  opts?: UnifiedSearchOptions,
): UnifiedSearchFile[] {
  const p = join(decryptedDir, 'hardlink', 'hardlink.db')
  // hardlink 表没有会话列；会话过滤无法在这里执行。
  if (username) {
    sink.push({
      domain: '文件',
      key: 'files',
      reason: 'unsupported_scope: 文件检索不支持按会话过滤',
    })
    return []
  }
  if (!existsSync(p)) {
    if (opts?.reportMissing) {
      sink.push({
        domain: '文件',
        key: 'files',
        reason: 'not_configured: 还没有文件索引数据（hardlink.db 不存在）：请先完成解密，或在微信里收发文件让该库生成',
      })
    }
    return []
  }
  const hasQuery = q.trim() !== ''
  const wantedCategory = opts?.fileCategory ?? 'all'
  const fileOrder = opts?.fileOrder ?? 'recent'
  const minSize = opts?.minSize
  const maxSize = opts?.maxSize
  const hasSizeFilter = minSize !== undefined || maxSize !== undefined
  try {
    return withDb(p, (db) => {
      const out: UnifiedSearchFile[] = []
      let seenTable = false
      for (const table of ['image_hardlink_info_v4', 'file_hardlink_info_v4', 'video_hardlink_info_v4']) {
        if (wantedCategory !== 'all' && fileCategory(table) !== wantedCategory) continue
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
        if (!has) continue
        const cols = tableColumns(db, table)
        const nameCol = cols.has('file_name') ? 'file_name' : cols.has('fileName') ? 'fileName' : ''
        const md5Col = cols.has('md5') ? 'md5' : ''
        const sizeCol = cols.has('file_size') ? 'file_size' : cols.has('fileSize') ? 'fileSize' : ''
        if (!nameCol) continue
        seenTable = true
        const timeCol = cols.has('modify_time')
          ? 'modify_time'
          : cols.has('send_time')
            ? 'send_time'
            : cols.has('create_time') ? 'create_time' : ''
        if (range && timeCol === '') {
          sink.push({
            domain: '文件',
            key: 'files',
            reason: 'unsupported_scope: 该文件表没有 modify_time/send_time 列，无法应用日期范围',
          })
          continue
        }
        if (hasSizeFilter && sizeCol === '') {
          sink.push({
            domain: '文件',
            key: 'files',
            reason: 'unsupported_scope: 该文件表没有 file_size 列，无法按体积过滤',
          })
          continue
        }
        const conditions: string[] = []
        const params: Array<string | number> = []
        if (hasQuery) {
          // 名称/MD5 的 OR 必须整体加括号；否则后面的范围条件只会约束 MD5 分支。
          conditions.push(md5Col ? `(${nameCol} LIKE ? OR ${md5Col} LIKE ?)` : `${nameCol} LIKE ?`)
          params.push(like(q))
          if (md5Col) params.push(like(q))
        }
        if (range && timeCol !== '') {
          if (range.fromSec > 0) {
            conditions.push(`${timeCol} >= ?`)
            params.push(range.fromSec)
          }
          if (range.toSec > 0) {
            conditions.push(`${timeCol} <= ?`)
            params.push(range.toSec)
          }
        }
        if (hasSizeFilter && sizeCol !== '') {
          if (minSize !== undefined) {
            conditions.push(`${sizeCol} >= ?`)
            params.push(minSize)
          }
          if (maxSize !== undefined) {
            conditions.push(`${sizeCol} <= ?`)
            params.push(maxSize)
          }
        }
        const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
        const orderSql = fileOrder === 'size' && sizeCol !== ''
          ? ` ORDER BY ${sizeCol} DESC`
          : (timeCol !== '' ? ` ORDER BY ${timeCol} DESC` : '')
        // 每张表各取 cap 条，再跨表全局排序 —— 否则「图片表先占满」会让最新文件被截掉。
        const rows = db.prepare(`SELECT ${nameCol} AS n, ${md5Col || "'0'"} AS m, ${sizeCol || '0'} AS s, ${timeCol || '0'} AS t FROM ${table}${whereSql}${orderSql} LIMIT ?`)
          .all(...params, cap) as Array<{ n: unknown; m: unknown; s: unknown; t: unknown }>
        for (const r of rows) {
          const modifyTime = Number(r.t ?? 0)
          out.push({
            fileName: cellString(r.n),
            md5: cellString(r.m),
            size: Number(r.s ?? 0),
            category: fileCategory(table),
            time: fmtDateTimeSec(modifyTime),
            modifyTime,
          })
        }
      }
      if (opts?.reportMissing && !seenTable) {
        sink.push({
          domain: '文件',
          key: 'files',
          reason: 'not_configured: 文件索引库里没有可读的文件表（image/file/video hardlink），无法列出文件',
        })
      }
      if (fileOrder === 'size') {
        out.sort((a, b) => b.size - a.size || b.modifyTime - a.modifyTime)
      } else {
        out.sort((a, b) => b.modifyTime - a.modifyTime)
      }
      return out.slice(0, cap)
    })
  } catch (e) {
    noteFailure(sink, '文件', 'files', e)
    return []
  }
}

/**
 * Resolve a transfer/red-packet session to a human-readable title.
 *
 * `contactMeta` intentionally stores the raw username when a contact has no
 * remark or nickname, so "name === username" must still count as unresolved.
 * For private chats we only use a participant as a fallback when the logged-in
 * account is known: this lets us ignore "self" and avoids putting the user's
 * own name on a record whose peer is still unknown.
 */
function recordIdentity(
  session: string,
  names: Map<string, string>,
  enterpriseNames: ReadonlyMap<string, string>,
  sessionTitles: ReadonlyMap<string, string>,
  participants: string[],
  selfUsername: string,
): { name: string; enterpriseName?: string } {
  if (session === '') return { name: '未命名会话' }
  const direct = names.get(session)?.trim() ?? ''
  const sessionEnterpriseName = enterpriseNames.get(session)?.trim()
  if (direct !== '' && direct !== session) {
    return {
      name: direct,
      ...(sessionEnterpriseName ? { enterpriseName: sessionEnterpriseName } : {}),
    }
  }

  const sessionTitle = sessionTitles.get(session)?.trim() ?? ''
  if (sessionTitle !== '' && sessionTitle !== session) {
    return {
      name: sessionTitle,
      ...(sessionEnterpriseName ? { enterpriseName: sessionEnterpriseName } : {}),
    }
  }

  if (/^wxid_/i.test(session) && selfUsername !== '') {
    const candidates = new Map<string, string>()
    for (const participant of participants) {
      const id = participant.trim()
      if (id === '' || id === session || id === selfUsername) continue
      const name = names.get(id)?.trim() ?? ''
      if (name !== '' && name !== id) candidates.set(id, name)
    }
    if (candidates.size === 1) {
      const [username, name] = [...candidates.entries()][0] ?? []
      if (username !== undefined && name !== undefined) {
        const enterpriseName = enterpriseNames.get(username)?.trim()
        return {
          name,
          ...(enterpriseName ? { enterpriseName } : {}),
        }
      }
    }
  }

  if (session.endsWith('@chatroom')) return { name: '未知群聊' }
  if (/^gh_/i.test(session)) return { name: '未知公众号' }
  if (/^wxid_/i.test(session)) return { name: '未知联系人' }
  return {
    name: session,
    ...(sessionEnterpriseName ? { enterpriseName: sessionEnterpriseName } : {}),
  }
}

/**
 * 记录表里可能出现的金额列（真机 schema 目前**没有**金额列：金额在支付卡片的
 * `wcpayinfo.feedesc` 里，由 `resolveRecordMoney` 从消息分片解析）。
 * 这里仍按列名探测，兼容未来/第三方 schema；金额列只在消息解析不到时兜底。
 */
const RECORD_AMOUNT_COLUMNS: ReadonlyArray<{ name: string; unit: 'cents' | 'yuan' }> = [
  { name: 'amount_cents', unit: 'cents' },
  { name: 'total_fee', unit: 'cents' },
  { name: 'pay_amount', unit: 'yuan' },
  { name: 'transfer_amount', unit: 'yuan' },
  { name: 'amount', unit: 'yuan' },
]

function recordAmountColumn(cols: Set<string>): { name: string; unit: 'cents' | 'yuan' } | undefined {
  return RECORD_AMOUNT_COLUMNS.find(column => cols.has(column.name))
}

/** 金额列 → 分；非法值返回 `null`（= 有列但读不出金额）。 */
function columnAmountCents(value: unknown, unit: 'cents' | 'yuan'): number | null {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return null
  return unit === 'cents' ? Math.round(n) : Math.round(n * 100)
}

interface PaymentMessageInfo {
  kind: 'transfer' | 'redpacket'
  cents: number | null
}

/** 支付卡片 XML → 类型 + 金额（分）；不是转账/红包消息时返回 undefined。 */
function paymentInfoFromContent(content: string): PaymentMessageInfo | undefined {
  if (content === '') return undefined
  const rich = parseMessageContent(49, content, false).rich
  if (rich?.type === 'transfer') return { kind: 'transfer', cents: parseCnyAmount(rich.title).cents }
  if (rich?.type === 'redpacket') return { kind: 'redpacket', cents: parseCnyAmount(rich.amount).cents }
  return undefined
}

/**
 * 从消息分片解析支付卡片的金额。
 *
 * 转账/红包表只有状态与单号，金额只存在于卡片 XML（`feedesc`）。这里按
 * `server_id` 两趟命中（整型等值走索引，文本 CAST 兜底），与账本同口径；
 * 只在工具路径开启，避免全局搜索每次按键都扫分片。
 * @param decryptedDir - 解密数据根。
 * @param serverIds - 当前结果页的消息服务端 id。
 * @returns server_id → 支付信息；解析不到的行不在 Map 里（调用方按「金额未知」展示）。
 */
function resolveRecordMoney(
  decryptedDir: string,
  serverIds: readonly string[],
): Map<string, PaymentMessageInfo> {
  const out = new Map<string, PaymentMessageInfo>()
  const pending = [...new Set(serverIds.map(id => id.trim()).filter(id => id !== '' && id !== '0'))]
  if (pending.length === 0) return out
  const numeric = new Map<string, bigint>()
  for (const id of pending) {
    if (/^\d+$/.test(id)) {
      try { numeric.set(id, BigInt(id)) } catch { /* 非纯数字走文本兜底 */ }
    }
  }
  const shards = shardCatalogDirs(decryptedDir, ['message'])
  if (shards.length === 0) return out
  const scan = (serverExpr: string, params: Array<string | bigint>): void => {
    if (params.length === 0) return
    const placeholders = params.map(() => '?').join(',')
    for (const shard of shards) {
      // 只 SELECT CAST(... AS TEXT)：64 位 server_id 不经过 Number 读取，
      // 因此不需要 readBigInts，也能复用 withDb 的「必关」纪律。
      try {
        withDb(shard.file, (db) => {
          for (const [table, meta] of shard.tables) {
            if (!meta.cols.has('server_id') || !meta.cols.has('message_content')) continue
            try {
              const rows = db.prepare(
                `SELECT CAST(${serverExpr} AS TEXT) AS sid, message_content AS mc FROM "${table}" WHERE ${serverExpr} IN (${placeholders})`,
              ).all(...params) as Array<Record<string, unknown>>
              for (const row of rows) {
                const sid = cellString(row['sid']).trim()
                if (sid === '' || out.has(sid)) continue
                const info = paymentInfoFromContent(cellString(row['mc']))
                if (info) out.set(sid, info)
              }
            } catch { /* 单表读不动不影响其余分片 */ }
          }
        })
      } catch { /* 分片打不开：跳过 */ }
      if (out.size >= pending.length) return
    }
  }
  const numericIds = [...numeric.values()]
  if (numericIds.length > 0) scan('server_id', numericIds)
  const leftover = pending.filter(id => !out.has(id))
  if (leftover.length > 0) scan('CAST(server_id AS TEXT)', leftover)
  return out
}

/** 转账状态：字段域未验证，只展示原始值；`invalid_time` 是能直接证明的失效标记。 */
function transferStatusLabel(paySubType: unknown, invalidTime: unknown): string {
  const parts: string[] = []
  if (paySubType !== null && paySubType !== undefined && String(paySubType) !== '') {
    parts.push(`状态值 ${String(paySubType)}`)
  }
  if (Number(invalidTime ?? 0) > 0) parts.push('已失效')
  return parts.length > 0 ? parts.join('，') : '状态未知'
}

/** 红包状态：`hb_status/receive_status` 没有权威映射，只展示原始值（与面板一致）。 */
function redpacketStatusLabel(hbStatus: unknown, receiveStatus: unknown): string {
  if ((hbStatus === null || hbStatus === undefined) && (receiveStatus === null || receiveStatus === undefined)) {
    return '状态未知'
  }
  const hb = hbStatus === null || hbStatus === undefined ? '—' : String(hbStatus)
  const receive = receiveStatus === null || receiveStatus === undefined ? '—' : String(receiveStatus)
  return `原始状态 ${hb}/${receive}`
}

/** 收支方向：当前登录账号是付款方 = 支出，是收款方 = 收入；无法判定时不猜。 */
function recordDirection(
  kind: 'transfers' | 'redpackets',
  self: string,
  payer: string,
  receiver: string,
  sender: string,
): 'in' | 'out' | 'unknown' {
  if (self === '') return 'unknown'
  if (kind === 'transfers') {
    if (payer !== '' && payer === self) return 'out'
    if (receiver !== '' && receiver === self) return 'in'
    return 'unknown'
  }
  // 红包表没有收款方：发送人是自己 = 支出；否则在已知自己账号时按收入处理（与账本同口径）。
  if (sender === '') return 'unknown'
  return sender === self ? 'out' : 'in'
}

/**
 * Transfers/red packets whose session matches the query.
 *
 * 空 query = 最近记录；`recordKind`/`direction`/金额区间在取到候选行后统一过滤
 * （金额来自消息卡片，无法在 SQL 里比较）。`revokes` 复用 `queryRecords` 的撤回域。
 */
function searchRecords(
  sink: DomainFailure[],
  decryptedDir: string,
  q: string,
  cap: number,
  range?: TimeRange,
  username?: string,
  opts?: UnifiedSearchOptions,
): UnifiedSearchRecord[] {
  const p = join(decryptedDir, 'general', 'general.db')
  const hasQuery = q.trim() !== ''
  const recordKind = opts?.recordKind ?? 'all'
  const directionFilter = opts?.direction ?? 'all'
  const order = opts?.order === 'oldest' ? 'asc' : 'desc'
  const minCents = typeof opts?.minAmountCents === 'number' && Number.isFinite(opts.minAmountCents)
    ? opts.minAmountCents
    : undefined
  const maxCents = typeof opts?.maxAmountCents === 'number' && Number.isFinite(opts.maxAmountCents)
    ? opts.maxAmountCents
    : undefined
  const hasAmountFilter = minCents !== undefined || maxCents !== undefined
  if (recordKind === 'revokes' && (directionFilter !== 'all' || hasAmountFilter)) {
    sink.push({
      domain: '转账红包',
      key: 'records',
      reason: 'unsupported_scope: 撤回记录没有收支方向和金额，不能按该条件过滤',
    })
    return []
  }
  const wantsMoneyKinds = recordKind === 'all' || recordKind === 'transfers' || recordKind === 'redpackets'
  if (!existsSync(p)) {
    if (opts?.reportMissing) {
      sink.push({
        domain: '转账红包',
        key: 'records',
        reason: 'not_configured: 还没有资金往来数据（general.db 不存在）：请先完成解密，或在微信里打开过转账/红包页面让该库生成',
      })
    }
    return []
  }
  const self = wantsMoneyKinds ? resolveSelfUsername(decryptedDir).trim() : ''
  if (wantsMoneyKinds && directionFilter !== 'all' && self === '') {
    sink.push({
      domain: '转账红包',
      key: 'records',
      reason: 'unsupported_scope: 无法确定当前登录账号，不能按收支方向过滤',
    })
    return []
  }
  // 方向/金额过滤是后置的：先多取候选，避免前 cap 条都被过滤掉后结果虚假为空。
  const scanCap = directionFilter !== 'all' || hasAmountFilter
    ? Math.min(Math.max(cap * 5, 50), 300)
    : cap
  const tables: Array<['transferTable' | 'redEnvelopeTable', 'transfers' | 'redpackets']> = []
  if (recordKind === 'all' || recordKind === 'transfers') tables.push(['transferTable', 'transfers'])
  if (recordKind === 'all' || recordKind === 'redpackets') tables.push(['redEnvelopeTable', 'redpackets'])
  try {
    return withDb(p, (db) => {
      const out: UnifiedSearchRecordInternal[] = []
      const meta = contactMeta(decryptedDir)
      const names = meta.names
      const sessionTitles = loadRecordSessionTitles(decryptedDir)
      let identitySelf: string | undefined
      let foundMoneyTable = false
      for (const [table, kind] of tables) {
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
        if (!has) {
          // kind=all 时少一张表不代表整个域缺库（另一张表仍可能命中）；
          // 只有显式点名该类型时才报 not_configured。
          if (opts?.reportMissing && recordKind === kind) {
            sink.push({
              domain: '转账红包',
              key: 'records',
              reason: `not_configured: 资金往来库里没有 ${table} 表，无法列出${kind === 'transfers' ? '转账' : '红包'}记录`,
            })
          }
          continue
        }
        foundMoneyTable = true
        const cols = tableColumns(db, table)
        const sessionCol = cols.has('session_name') ? 'session_name' : cols.has('SessionName') ? 'SessionName' : ''
        if (!sessionCol) {
          sink.push({ domain: '转账红包', key: 'records', reason: `记录表 ${table} 缺少会话列，无法列出记录` })
          continue
        }
        // 与「转账红包」面板对齐：转账还能按单号查、红包还能按发送人查
        const idCol = kind === 'transfers'
          ? (cols.has('transfer_id') ? 'transfer_id' : '')
          : (cols.has('sender_user_name') ? 'sender_user_name' : '')
        const timeCol = kind === 'transfers'
          ? (cols.has('begin_transfer_time') ? 'begin_transfer_time' : '')
          : (cols.has('last_update_time') ? 'last_update_time' : '')
        const serverCol = cols.has('message_server_id') ? 'CAST(message_server_id AS TEXT)' : "''"
        const transferCol = kind === 'transfers' && cols.has('transfer_id') ? 'transfer_id' : "''"
        const payerCol = kind === 'transfers' && cols.has('pay_payer') ? 'pay_payer' : "''"
        const receiverCol = kind === 'transfers' && cols.has('pay_receiver') ? 'pay_receiver' : "''"
        const senderCol = kind === 'redpackets' && cols.has('sender_user_name') ? 'sender_user_name' : "''"
        const paySubCol = kind === 'transfers' && cols.has('pay_sub_type') ? 'pay_sub_type' : ''
        const invalidCol = kind === 'transfers' && cols.has('invalid_time') ? 'invalid_time' : ''
        const hbStatusCol = kind === 'redpackets' && cols.has('hb_status') ? 'hb_status' : ''
        const receiveStatusCol = kind === 'redpackets' && cols.has('receive_status') ? 'receive_status' : ''
        const amountColumn = recordAmountColumn(cols)
        if (range && timeCol === '') {
          sink.push({
            domain: '转账红包',
            key: 'records',
            reason: 'unsupported_scope: 该记录表没有时间列，无法应用日期范围',
          })
          continue
        }
        const displayName = username ? names.get(username) : undefined
        const scopeAliases = username ? storedChatAliases(username, displayName) : []
        const conditions: string[] = []
        const params: Array<string | number> = []
        if (hasQuery) {
          conditions.push(`(${sessionCol} LIKE ?${idCol ? ` OR ${idCol} LIKE ?` : ''})`)
          params.push(like(q))
          if (idCol) params.push(like(q))
        }
        if (username) {
          conditions.push(`(${scopeAliases.map(() => `${sessionCol} = ?`).join(' OR ')})`)
          params.push(...scopeAliases)
        }
        if (range && timeCol !== '') {
          if (range.fromSec > 0) {
            conditions.push(`${timeCol} >= ?`)
            params.push(range.fromSec)
          }
          if (range.toSec > 0) {
            conditions.push(`${timeCol} <= ?`)
            params.push(range.toSec)
          }
        }
        const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''
        const orderSql = timeCol !== '' ? ` ORDER BY ${timeCol} ${order === 'asc' ? 'ASC' : 'DESC'}` : ''
        const rows = db.prepare(
          `SELECT ${sessionCol} AS s, ${timeCol || '0'} AS t, ${serverCol} AS sid, ${transferCol} AS tid,`
          + ` ${payerCol} AS payer, ${receiverCol} AS receiver, ${senderCol} AS sender,`
          + ` ${paySubCol || 'NULL'} AS pst, ${invalidCol || 'NULL'} AS inv,`
          + ` ${hbStatusCol || 'NULL'} AS hs, ${receiveStatusCol || 'NULL'} AS rs,`
          + ` ${amountColumn ? amountColumn.name : 'NULL'} AS amt`
          + ` FROM ${table}${whereSql}${orderSql} LIMIT ?`,
        ).all(...params, scanCap) as Array<Record<string, unknown>>
        for (const r of rows) {
          const storedSession = cellString(r['s'])
          if (!storedSession) continue
          const chatIdentity = resolveChatIdentity(decryptedDir, storedSession)
          const session = chatIdentity.username
          const messageServerId = cellString(r['sid'])
          const transferId = cellString(r['tid'])
          const payer = cellString(r['payer']).trim()
          const receiver = cellString(r['receiver']).trim()
          const sender = cellString(r['sender']).trim()
          const participants = [payer, receiver, sender].filter(Boolean)
          const directName = names.get(session)?.trim() ?? ''
          if (
            participants.length > 0
            && identitySelf === undefined
            && (directName === '' || directName === session)
          ) {
            identitySelf = self || resolveSelfUsername(decryptedDir).trim()
          }
          const displayIdentity = recordIdentity(
            session || chatIdentity.displayName,
            names,
            meta.enterpriseNames,
            sessionTitles,
            participants,
            identitySelf ?? '',
          )
          const timeSec = Number(r['t'] ?? 0)
          out.push({
            kind,
            recordKind: kind,
            name: displayIdentity.name,
            ...(displayIdentity.enterpriseName ? { enterpriseName: displayIdentity.enterpriseName } : {}),
            session,
            time: fmtDateTimeSec(timeSec),
            sourceId: transferId || messageServerId || `${kind}:${session || '未命名会话'}:${fmtDateTimeSec(timeSec)}`,
            timeSec,
            ...(transferId ? { transferId } : {}),
            ...(messageServerId ? { messageServerId } : {}),
            direction: recordDirection(kind, self, payer, receiver, sender),
            statusLabel: kind === 'transfers'
              ? transferStatusLabel(r['pst'], r['inv'])
              : redpacketStatusLabel(r['hs'], r['rs']),
            amountCents: amountColumn ? columnAmountCents(r['amt'], amountColumn.unit) : undefined,
          })
        }
      }
      // 两张资金表都不存在才算「记录域未配置」；一张缺表只影响该类型。
      if (opts?.reportMissing && wantsMoneyKinds && !foundMoneyTable) {
        sink.push({
          domain: '转账红包',
          key: 'records',
          reason: 'not_configured: 资金往来库里没有 transferTable/redEnvelopeTable 表，无法列出转账/红包记录',
        })
      }
      // 撤回记录：没有金额/方向，按时间与其余记录合并排序。
      if ((recordKind === 'all' || recordKind === 'revokes') && !hasAmountFilter) {
        const hasRevokeTable = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='revokebatchmessage'",
        ).get() !== undefined
        if (!hasRevokeTable) {
          // kind=all 时看不到撤回列表是常态（很多机器没有插件缓存），不报缺库。
          if (opts?.reportMissing && recordKind === 'revokes') {
            sink.push({
              domain: '转账红包',
              key: 'records',
              reason: 'not_configured: 资金往来库里没有 revokebatchmessage 表，无法列出撤回记录',
            })
          }
        } else {
          const revokes = queryRecords(decryptedDir, 'revokes', scanCap, 0, hasQuery ? q : undefined, {
            ...(range ? { from: range.fromSec, to: range.toSec } : {}),
            direction: order,
          })
          if (revokes.readError) {
            sink.push({ domain: '转账红包', key: 'records', reason: revokes.readError })
          }
          for (const item of revokes.items) {
            const storedSession = cellString(item['session_name'])
            const session = storedSession ? resolveTalkerUsername(decryptedDir, storedSession) : ''
            const timeSec = Number(item['msg_create_time'] ?? 0)
            const displayName = cellString(item['session_display']).trim()
              || (session ? names.get(session)?.trim() ?? '' : '')
              || storedSession
              || '未命名会话'
            const enterpriseName = cellString(item['session_enterprise']).trim()
            const sourceId = cellString(item['msg_unique_id'])
              || cellString(item['local_id'])
              || `${session || '未命名会话'}:${fmtDateTimeSec(timeSec)}`
            out.push({
              kind: 'revokes',
              recordKind: 'revokes',
              name: displayName,
              ...(enterpriseName ? { enterpriseName } : {}),
              session,
              time: fmtDateTimeSec(timeSec),
              sourceId,
              timeSec,
              direction: 'unknown',
              statusLabel: '已撤回',
            })
          }
        }
      }
      // 金额兜底：支付卡片 XML 是权威来源；记录表的金额列只在解析不到时使用。
      if (opts?.resolveRecordMoney) {
        const serverIds = out
          .filter(record => record.recordKind !== 'revokes' && (record.messageServerId ?? '') !== '')
          .map(record => record.messageServerId as string)
        const money = resolveRecordMoney(decryptedDir, serverIds)
        for (const record of out) {
          if (record.recordKind === 'revokes') continue
          const serverId = record.messageServerId ?? ''
          const info = serverId !== '' ? money.get(serverId) : undefined
          if (!info) continue
          if (record.recordKind === 'transfers' && info.kind !== 'transfer') continue
          if (record.recordKind === 'redpackets' && info.kind !== 'redpacket') continue
          if (typeof info.cents === 'number') record.amountCents = info.cents
        }
      }
      const kept = out.filter((record) => {
        if (record.recordKind === 'revokes') {
          return directionFilter === 'all' && !hasAmountFilter
        }
        if (directionFilter !== 'all' && record.direction !== directionFilter) return false
        if (hasAmountFilter) {
          if (typeof record.amountCents !== 'number') return false
          if (minCents !== undefined && record.amountCents < minCents) return false
          if (maxCents !== undefined && record.amountCents > maxCents) return false
        }
        return true
      })
      kept.sort((a, b) => {
        const delta = (a.timeSec ?? 0) - (b.timeSec ?? 0)
        if (delta !== 0) return order === 'asc' ? delta : -delta
        const kindCompare = (a.recordKind ?? '').localeCompare(b.recordKind ?? '')
        return kindCompare !== 0 ? kindCompare : (a.sourceId ?? '').localeCompare(b.sourceId ?? '')
      })
      return kept.slice(0, cap)
    })
  } catch (e) {
    noteFailure(sink, '转账红包', 'records', e)
    return []
  }
}

interface UnifiedSearchPreparation {
  ok: true
  q: string
  cap: number
  range?: TimeRange
  failures: DomainFailure[]
  domainErrors: DomainErrorMap
  /** 工具路径显式指定的资源域；`undefined` = 旧语义（空查询不跑任何域）。 */
  domains?: Set<UnifiedSearchResourceDomain>
}

type UnifiedSearchPrepared =
  | UnifiedSearchPreparation
  | { ok: false; snapshot: UnifiedSearchSnapshot }

function emptyUnifiedSnapshot(
  query: string,
  domainErrors: DomainErrorMap,
): UnifiedSearchSnapshot {
  return {
    query,
    messages: [],
    contacts: [],
    moments: [],
    favorites: [],
    files: [],
    records: [],
    ...(Object.keys(domainErrors).length > 0
      ? { domainErrors: domainErrors as UnifiedSearchSnapshot['domainErrors'] }
      : {}),
  }
}

/**
 * 同步与可取消入口共享同一份范围校验，避免两条链路对非法日期/会话范围给出不同答案。
 */
function prepareUnifiedSearch(
  query: string,
  limit?: number,
  options: UnifiedSearchOptions = {},
): UnifiedSearchPrepared {
  const q = (query || '').trim()
  const domains = options.domains !== undefined && options.domains.length > 0
    ? new Set(options.domains)
    : undefined
  // 工具可以一次要 60 条；全局搜索面板保持旧上限 12，避免每次按键拉回大页。
  const cap = Math.min(Math.max(limit ?? 6, 1), domains !== undefined ? 60 : 12)
  const failures: DomainFailure[] = []
  const from = (options.from ?? '').trim()
  const to = (options.to ?? '').trim()
  const fromValid = from === '' || validDay(from)
  const toValid = to === '' || validDay(to)
  const domainErrors: DomainErrorMap = {}

  if (!fromValid || !toValid || (from !== '' && to !== '' && from > to)) {
    const message = '日期范围必须是合法的 YYYY-MM-DD，且 from 不能晚于 to'
    for (const key of ['contacts', 'moments', 'favorites', 'files', 'records'] as const) {
      domainErrors[key] = { code: 'unsupported_scope', message }
    }
    return { ok: false, snapshot: emptyUnifiedSnapshot(q, domainErrors) }
  }

  const range = from !== '' || to !== '' ? dayRange(from, to) : undefined
  // 联系人没有可过滤的时间列：带日期范围时必须明确报不支持，不能返回未过滤的联系人。
  if (q && range) {
    failures.push({
      domain: '联系人',
      key: 'contacts',
      reason: 'unsupported_scope: 联系人检索没有时间列，无法应用日期范围',
    })
  }
  return { ok: true, q, cap, range, failures, domainErrors, ...(domains !== undefined ? { domains } : {}) }
}

/** 把域失败映射成统一快照诊断；同步/异步入口只共用这一份收尾逻辑。 */
function finishUnifiedSnapshot(
  snapshot: UnifiedSearchSnapshot,
  failures: DomainFailure[],
  domainErrors: DomainErrorMap,
): UnifiedSearchSnapshot {
  for (const failure of failures) {
    const unsupported = failure.reason.startsWith('unsupported_scope:')
    const notConfigured = failure.reason.startsWith('not_configured:')
    domainErrors[failure.key] = {
      code: unsupported ? 'unsupported_scope' : notConfigured ? 'not_configured' : 'read_failed',
      message: failure.reason.replace(/^(?:unsupported_scope|not_configured):\s*/, ''),
    }
  }
  if (Object.keys(domainErrors).length > 0) {
    snapshot.domainErrors = domainErrors as UnifiedSearchSnapshot['domainErrors']
  }
  const readFailures = failures.filter(failure =>
    !failure.reason.startsWith('unsupported_scope:') && !failure.reason.startsWith('not_configured:'))
  // 去重保序：朋友圈那条会连着试两个候选路径，一次失败可能记两笔。
  const domainList = (list: DomainFailure[]): string => {
    const seen = new Set<string>()
    const parts: string[] = []
    for (const f of list) {
      if (seen.has(f.domain)) continue
      seen.add(f.domain)
      parts.push(f.domain)
    }
    return parts.join('、')
  }
  if (readFailures.length > 0) {
    snapshot.readError = `${domainList(readFailures)}读取失败（${readFailures[0]?.reason ?? '库打不开'}）—— 这不是「没有结果」`
  } else {
    const notConfigured = failures.filter(failure => failure.reason.startsWith('not_configured:'))
    if (notConfigured.length > 0) {
      snapshot.readError = `${domainList(notConfigured)}尚未配置或生成（${notConfigured[0]?.reason.replace(/^not_configured:\s*/, '') ?? '库不存在'}）—— 这不是「没有结果」`
    }
  }
  return snapshot
}

/**
 * 在资源域之间让出 worker 消息泵。
 *
 * node:sqlite 是同步 API，单条查询内部无法被 AbortSignal 抢占；这里保证每个域执行前后
 * 都至少让事件循环跑一次，使 `cancelSearch` RPC 能及时进入 worker，并在进入下一个域前收尾。
 * 消息兜底扫描另有逐行取消点，见 `searchIndexMessagesCancellable`。
 */
async function yieldUnifiedSearch(ctrl?: SearchControl): Promise<boolean> {
  if (ctrl?.signal?.aborted) return true
  await new Promise<void>((resolve) => { setImmediate(resolve) })
  return ctrl?.signal?.aborted === true
}

/**
 * Run the unified local search synchronously for existing query/tool callers.
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits per domain (default 6).
 * @param options - optional hard scope (`from` / `to` / `username`).
 * @returns the unified snapshot.
 */
export function searchUnified(
  decryptedDir: string,
  query: string,
  limit?: number,
  options: UnifiedSearchOptions = {},
): UnifiedSearchSnapshot {
  const prepared = prepareUnifiedSearch(query, limit, options)
  if (!prepared.ok) return prepared.snapshot
  const { q, cap, range, failures, domainErrors, domains } = prepared
  const requestedUsername = (options.username ?? '').trim()
  const username = requestedUsername ? resolveTalkerUsername(decryptedDir, requestedUsername) : ''
  // A legacy hash with no owner must not silently broaden the search to every
  // conversation. Return a scoped empty result instead.
  if (requestedUsername && !username) {
    return finishUnifiedSnapshot(emptyUnifiedSnapshot(q, domainErrors), failures, domainErrors)
  }
  // 没有显式指定域时保持旧语义：空查询不打开任何资源库。
  // 指定了域（工具路径）时，空查询 = 列该域最近的条目。
  const runAll = domains === undefined
  const shouldRun = (domain: UnifiedSearchResourceDomain): boolean =>
    domains !== undefined ? domains.has(domain) : q !== ''
  // 时间过滤在消息层是后置的：先多取一些原始命中，避免前 cap 条全在范围外
  // 时把范围内的结果错误地截掉。
  const messageCap = range ? Math.min(Math.max(cap * 10, cap), 300) : cap
  const messages = runAll && q
    ? searchIndexMessages(decryptedDir, q, messageCap, username || undefined).hits
    : []
  const filteredMessages = range
    ? messages.filter(hit =>
      (range.fromSec === 0 || hit.create_time >= range.fromSec)
      && (range.toSec === 0 || hit.create_time <= range.toSec),
    ).slice(0, cap)
    : messages
  const snapshot: UnifiedSearchSnapshot = {
    query: q,
    messages: filteredMessages,
    contacts: runAll && q && !range ? searchContacts(failures, decryptedDir, q, cap, username || undefined) : [],
    moments: shouldRun('moments') ? searchMoments(failures, decryptedDir, q, cap, range, username || undefined, options) : [],
    favorites: shouldRun('favorites') ? searchFavorites(failures, decryptedDir, q, cap, range, username || undefined, options) : [],
    files: shouldRun('files') ? searchFiles(failures, decryptedDir, q, cap, range, username || undefined, options) : [],
    records: shouldRun('records') ? searchRecords(failures, decryptedDir, q, cap, range, username || undefined, options) : [],
  }
  return finishUnifiedSnapshot(snapshot, failures, domainErrors)
}

/**
 * 可取消的全局搜索（界面链路专用）。
 *
 * 取消后返回**已扫描域的部分结果**并带 `cancelled: true`，不会把未扫描域伪装成
 * 「确实没有命中」。不带令牌时结果与 {@link searchUnified} 相同，只是异步执行。
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits per domain (default 6).
 * @param options - optional hard scope (`from` / `to` / `username`).
 * @param ctrl - optional AbortSignal-backed search control.
 * @returns unified snapshot, with `cancelled: true` when interrupted.
 */
export async function searchUnifiedCancellable(
  decryptedDir: string,
  query: string,
  limit?: number,
  options: UnifiedSearchOptions = {},
  ctrl?: SearchControl,
): Promise<UnifiedSearchSnapshot> {
  const prepared = prepareUnifiedSearch(query, limit, options)
  if (!prepared.ok) return prepared.snapshot
  const { q, cap, range, failures, domainErrors, domains } = prepared
  const runAll = domains === undefined
  const shouldRun = (domain: UnifiedSearchResourceDomain): boolean =>
    domains !== undefined ? domains.has(domain) : q !== ''
  const snapshot = emptyUnifiedSnapshot(q, domainErrors)
  if (q === '' && runAll) return finishUnifiedSnapshot(snapshot, failures, domainErrors)

  if (ctrl?.signal?.aborted) {
    snapshot.cancelled = true
    return finishUnifiedSnapshot(snapshot, failures, domainErrors)
  }

  const requestedUsername = (options.username ?? '').trim()
  const username = requestedUsername ? resolveTalkerUsername(decryptedDir, requestedUsername) : ''
  if (requestedUsername && !username) {
    return finishUnifiedSnapshot(snapshot, failures, domainErrors)
  }
  let cancelled = false
  if (runAll && q !== '') {
    const messageCap = range ? Math.min(Math.max(cap * 10, cap), 300) : cap
    const messageResult = await searchIndexMessagesCancellable(
      decryptedDir,
      q,
      messageCap,
      username || undefined,
      ctrl,
    )
    snapshot.messages = range
      ? messageResult.hits.filter(hit =>
        (range.fromSec === 0 || hit.create_time >= range.fromSec)
        && (range.toSec === 0 || hit.create_time <= range.toSec),
      ).slice(0, cap)
      : messageResult.hits
    cancelled = messageResult.cancelled === true
    if (!cancelled) cancelled = await yieldUnifiedSearch(ctrl)
    if (!cancelled && q && !range) {
      snapshot.contacts = searchContacts(failures, decryptedDir, q, cap, username || undefined)
      cancelled = await yieldUnifiedSearch(ctrl)
    }
  }
  if (!cancelled && shouldRun('moments')) {
    snapshot.moments = searchMoments(failures, decryptedDir, q, cap, range, username || undefined, options)
    cancelled = await yieldUnifiedSearch(ctrl)
  }
  if (!cancelled && shouldRun('favorites')) {
    snapshot.favorites = searchFavorites(failures, decryptedDir, q, cap, range, username || undefined, options)
    cancelled = await yieldUnifiedSearch(ctrl)
  }
  if (!cancelled && shouldRun('files')) {
    snapshot.files = searchFiles(failures, decryptedDir, q, cap, range, username || undefined, options)
    cancelled = await yieldUnifiedSearch(ctrl)
  }
  if (!cancelled && shouldRun('records')) {
    snapshot.records = searchRecords(failures, decryptedDir, q, cap, range, username || undefined, options)
    cancelled = await yieldUnifiedSearch(ctrl)
  }
  if (cancelled) snapshot.cancelled = true
  return finishUnifiedSnapshot(snapshot, failures, domainErrors)
}

/** hardlink 表 → 文件大类。 */
function fileCategory(table: string): string {
  if (table.startsWith('image_')) return 'image'
  if (table.startsWith('video_')) return 'video'
  return 'file'
}
