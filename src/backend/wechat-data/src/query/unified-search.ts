/**
 * Unified search across local WeChat data domains: messages (index), contacts,
 * moments, favorites, files, and records. Every domain is best-effort and
 * returns its own typed hit shape; one failed domain never blocks the others.
 *
 * 每个域的连接都经 `withDb` 打开 —— catch 分支只负责降级成空结果，
 * 句柄由 `withDb` 的 finally 关掉（P0-1：原先 catch 拿不到 try 内的 `const db`，
 * 一次查询抛错就永久泄漏一个 SQLite 句柄）。
 */
import type { DatabaseSync } from './db-open.ts'
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
import { withDb } from './db-open.ts'
import { searchIndexMessages, searchIndexMessagesCancellable, type SearchControl } from './search.ts'
import { contactMeta } from './meta.ts'
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

/** 为某张表的实际时间列生成范围条件（允许只给 from 或只给 to）。 */
function rangeClause(timeCol: string, range: TimeRange): { sql: string; params: number[] } {
  const parts: string[] = []
  const params: number[] = []
  if (range.fromSec > 0) {
    parts.push(`${timeCol} >= ?`)
    params.push(range.fromSec)
  }
  if (range.toSec > 0) {
    parts.push(`${timeCol} <= ?`)
    params.push(range.toSec)
  }
  return { sql: parts.length > 0 ? ` AND ${parts.join(' AND ')}` : '', params }
}

/** Moments by author + content LIKE. */
function searchMoments(
  sink: DomainFailure[],
  decryptedDir: string,
  q: string,
  cap: number,
  range?: TimeRange,
  username?: string,
): UnifiedSearchMoment[] {
  const dbPathCandidates = [join(decryptedDir, 'sns', 'db_sns', 'sns.db'), join(decryptedDir, 'sns', 'sns.db')]
  for (const p of dbPathCandidates) {
    if (!existsSync(p)) continue
    try {
      // `null` = 这个路径里没有可用的 SnsTimeLine 表 → 换下一个候选路径；数组（含空数组）= 命中这个库。
      const hits = withDb(p, (db): UnifiedSearchMoment[] | null => {
        const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='SnsTimeLine'").get() !== undefined
        if (!has) return null
        const cols = tableColumns(db, 'SnsTimeLine')
        const uname = cols.has('user_name') ? 'user_name' : cols.has('userName') ? 'userName' : ''
        const content = cols.has('content') ? 'content' : cols.has('Content') ? 'Content' : ''
        if (!uname || !content) return null
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
        for (const [username, name] of names) {
          if (String(name).toLowerCase().includes(lower)) matchedAuthors.add(username)
        }
        for (const [username, enterpriseName] of enterpriseNames) {
          if (enterpriseName.toLowerCase().includes(lower)) matchedAuthors.add(username)
        }
        const authorUsers = [...matchedAuthors].slice(0, 50)
        const kw = like(q)
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
        const rangeFilter = range ? rangeClause(timeCol, range) : { sql: '', params: [] }
        const userSql = username ? ` AND ${uname} = ?` : ''
        const userParam = username ? [username] : []
        const rows = db.prepare(`SELECT ${idExpr} AS i, ${uname} AS u, ${content} AS c${timeCol ? `, ${timeCol} AS t` : ''} FROM SnsTimeLine WHERE (${content} LIKE ? OR ${uname} LIKE ?${inSql})${userSql}${rangeFilter.sql} LIMIT ?`)
          .all(kw, kw, ...authorUsers, ...userParam, ...rangeFilter.params, cap) as Array<{ i: unknown; u: unknown; c: unknown; t?: unknown }>
        return rows.map((r) => {
          const username = cellString(r.u)
          const xml = cellString(r.c)
          const parsed = parseSnsXml(xml)
          const firstImage = parsed.images[0]
          const firstVideo = parsed.videos[0]
          const media = firstImage ?? firstVideo
          const time = Number(r.t ?? 0) > 0
            ? fmtDateTimeSec(Number(r.t))
            : fmtDateTimeSec(parsed.createTime)
          const enterpriseName = enterpriseNames.get(username)?.trim()
          return {
            username,
            name: displayNameForUsername(username, names, parsed.nickname),
            ...(enterpriseName ? { enterpriseName } : {}),
            snippet: parsed.text || xml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100),
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
      noteFailure(sink, '朋友圈', 'moments', e) }
  }
  return []
}

/** Favorites by content LIKE (fav_db_item in favorite.db). */
function searchFavorites(
  sink: DomainFailure[],
  decryptedDir: string,
  q: string,
  cap: number,
  range?: TimeRange,
  username?: string,
): UnifiedSearchFavorite[] {
  const p = join(decryptedDir, 'favorite', 'favorite.db')
  if (!existsSync(p)) return []
  try {
    return withDb(p, (db) => {
      const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fav_db_item'").get() !== undefined
      if (!has) return []
      const cols = tableColumns(db, 'fav_db_item')
      const idCol = cols.has('local_id') ? 'local_id' : cols.has('Id') ? 'Id' : '0'
      const contentCol = cols.has('content') ? 'content' : cols.has('Content') ? 'Content' : ''
      if (!contentCol) return []
      // content 是收藏条目 XML（标题/描述就在里面），另加来源人 / 来源会话名，
      // 与「我的收藏」面板的搜索面（标题/描述/来源/正文/来源人/会话名）对齐。
      const cols2 = tableColumns(db, 'fav_db_item')
      const fromCol = cols2.has('fromusr') ? 'fromusr' : ''
      const chatCol = cols2.has('realchatname') ? 'realchatname' : ''
      const typeCol = cols2.has('type') ? 'type' : '0'
      const timeCol = cols2.has('update_time') ? 'update_time' : '0'
      const serverCol = cols2.has('server_id') ? 'CAST(server_id AS TEXT)' : "''"
      const sourceCol = cols2.has('source_id') ? 'CAST(source_id AS TEXT)' : "''"
      const fromExpr = fromCol || "''"
      const chatExpr = chatCol || "''"
      const extraSql = [fromCol, chatCol].filter(Boolean).map(c => ' OR ' + c + ' LIKE ?').join('')
      const extraParams = [fromCol, chatCol].filter(Boolean).map(() => like(q))
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
      const userSql = username
        ? ` AND (${[fromCol, chatCol].filter(Boolean).flatMap(col =>
          scopeAliases.map(() => `${col} = ?`),
        ).join(' OR ')})`
        : ''
      const userParams = username
        ? [fromCol, chatCol].filter(Boolean).flatMap(() => scopeAliases)
        : []
      if (range && timeCol === '0') {
        sink.push({
          domain: '收藏',
          key: 'favorites',
          reason: 'unsupported_scope: 该收藏库没有 update_time 列，无法应用日期范围',
        })
        return []
      }
      const rangeFilter = range ? rangeClause(timeCol, range) : { sql: '', params: [] }
      const rows = db.prepare(`SELECT ${idCol} AS id, ${contentCol} AS c, ${typeCol} AS ty, ${timeCol} AS t, ${serverCol} AS sid, ${sourceCol} AS src, ${fromExpr} AS fu, ${chatExpr} AS cn FROM fav_db_item WHERE (${contentCol} LIKE ?${extraSql})${userSql}${rangeFilter.sql} LIMIT ?`)
        .all(like(q), ...extraParams, ...userParams, ...rangeFilter.params, cap) as Array<{ id: unknown; c: unknown; ty: unknown; t: unknown; sid: unknown; src: unknown; fu: unknown; cn: unknown }>
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

/** Files by file_name LIKE across hardlink tables. */
function searchFiles(
  sink: DomainFailure[],
  decryptedDir: string,
  q: string,
  cap: number,
  range?: TimeRange,
  username?: string,
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
  if (!existsSync(p)) return []
  try {
    return withDb(p, (db) => {
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
        const md5Param = md5Col ? [like(q)] : []
        const timeCol = cols.has('modify_time') ? 'modify_time' : '0'
        if (range && timeCol === '0') {
          sink.push({
            domain: '文件',
            key: 'files',
            reason: 'unsupported_scope: 该文件表没有 modify_time 列，无法应用日期范围',
          })
          continue
        }
        const rangeFilter = range ? rangeClause(timeCol, range) : { sql: '', params: [] }
        // 名称/MD5 的 OR 必须整体加括号；否则后面的范围条件只会约束 MD5 分支。
        const matchSql = md5Col ? `(${nameCol} LIKE ? OR ${md5Col} LIKE ?)` : `${nameCol} LIKE ?`
        const rows = db.prepare(`SELECT ${nameCol} AS n, ${md5Col || "'0'"} AS m, ${sizeCol} AS s, ${timeCol} AS t FROM ${table} WHERE ${matchSql}${rangeFilter.sql} LIMIT ?`)
          .all(like(q), ...md5Param, ...rangeFilter.params, cap - out.length) as Array<{ n: unknown; m: unknown; s: unknown; t: unknown }>
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
          if (out.length >= cap) break
        }
        if (out.length >= cap) break
      }
      return out
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

/** Transfers/red packets whose session matches the query. */
function searchRecords(
  sink: DomainFailure[],
  decryptedDir: string,
  q: string,
  cap: number,
  range?: TimeRange,
  username?: string,
): UnifiedSearchRecord[] {
  const p = join(decryptedDir, 'general', 'general.db')
  if (!existsSync(p)) return []
  try {
    return withDb(p, (db) => {
      const out: UnifiedSearchRecord[] = []
      const meta = contactMeta(decryptedDir)
      const names = meta.names
      const sessionTitles = loadRecordSessionTitles(decryptedDir)
      let selfUsername: string | undefined
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
        const extraParam = idCol ? [like(q)] : []
        const timeCol = kind === 'transfers'
          ? (cols.has('begin_transfer_time') ? 'begin_transfer_time' : '0')
          : (cols.has('last_update_time') ? 'last_update_time' : '0')
        const serverCol = cols.has('message_server_id') ? 'CAST(message_server_id AS TEXT)' : "''"
        const transferCol = kind === 'transfers' && cols.has('transfer_id') ? 'transfer_id' : "''"
        const payerCol = kind === 'transfers' && cols.has('pay_payer') ? 'pay_payer' : "''"
        const receiverCol = kind === 'transfers' && cols.has('pay_receiver') ? 'pay_receiver' : "''"
        const senderCol = kind === 'redpackets' && cols.has('sender_user_name') ? 'sender_user_name' : "''"
        if (range && timeCol === '0') {
          sink.push({
            domain: '转账红包',
            key: 'records',
            reason: 'unsupported_scope: 该记录表没有时间列，无法应用日期范围',
          })
          continue
        }
        const rangeFilter = range ? rangeClause(timeCol, range) : { sql: '', params: [] }
        const displayName = username ? names.get(username) : undefined
        const scopeAliases = username ? storedChatAliases(username, displayName) : []
        const userSql = username
          ? ` AND (${scopeAliases.map(() => `${sessionCol} = ?`).join(' OR ')})`
          : ''
        const userParam = username
          ? scopeAliases
          : []
        // `session_name LIKE ... OR transfer_id LIKE ...` 必须整体加括号，
        // 否则日期/会话条件只约束第二个分支。
        const rows = db.prepare(`SELECT ${sessionCol} AS s, ${timeCol} AS t, ${serverCol} AS sid, ${transferCol} AS tid, ${payerCol} AS payer, ${receiverCol} AS receiver, ${senderCol} AS sender FROM ${table} WHERE (${sessionCol} LIKE ?${idCol ? ` OR ${idCol} LIKE ?` : ''})${userSql}${rangeFilter.sql} LIMIT ?`)
          .all(like(q), ...extraParam, ...userParam, ...rangeFilter.params, cap - out.length) as Array<{ s: unknown; t: unknown; sid: unknown; tid: unknown; payer: unknown; receiver: unknown; sender: unknown }>
        for (const r of rows) {
          const storedSession = cellString(r.s)
          if (!storedSession) continue
          const chatIdentity = resolveChatIdentity(decryptedDir, storedSession)
          const session = chatIdentity.username
          const messageServerId = cellString(r.sid)
          const transferId = cellString(r.tid)
          const participants = [cellString(r.payer), cellString(r.receiver), cellString(r.sender)]
            .map(value => value.trim())
            .filter(Boolean)
          const directName = names.get(session)?.trim() ?? ''
          if (
            participants.length > 0
            && selfUsername === undefined
            && (directName === '' || directName === session)
          ) {
            selfUsername = resolveSelfUsername(decryptedDir).trim()
          }
          const displayIdentity = recordIdentity(
            session || chatIdentity.displayName,
            names,
            meta.enterpriseNames,
            sessionTitles,
            participants,
            selfUsername ?? '',
          )
          out.push({
            kind,
            name: displayIdentity.name,
            ...(displayIdentity.enterpriseName ? { enterpriseName: displayIdentity.enterpriseName } : {}),
            session,
            time: fmtDateTimeSec(Number(r.t ?? 0)),
            sourceId: transferId || messageServerId || `${kind}:${session || '未命名会话'}:${fmtDateTimeSec(Number(r.t ?? 0))}`,
            ...(transferId ? { transferId } : {}),
            ...(messageServerId ? { messageServerId } : {}),
          })
          if (out.length >= cap) break
        }
        if (out.length >= cap) break
      }
      return out
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
  domainErrors: Partial<Record<UnifiedSearchResourceDomain, UnifiedSearchDomainError>>
}

type UnifiedSearchPrepared =
  | UnifiedSearchPreparation
  | { ok: false; snapshot: UnifiedSearchSnapshot }

function emptyUnifiedSnapshot(
  query: string,
  domainErrors: Partial<Record<UnifiedSearchResourceDomain, UnifiedSearchDomainError>>,
): UnifiedSearchSnapshot {
  return {
    query,
    messages: [],
    contacts: [],
    moments: [],
    favorites: [],
    files: [],
    records: [],
    ...(Object.keys(domainErrors).length > 0 ? { domainErrors } : {}),
  }
}

/**
 * 同步与可取消入口共享同一份范围校验，避免两条链路对非法日期/会话范围给出不同答案。
 */
function prepareUnifiedSearch(
  query: string,
  limit?: number,
  options: { from?: string; to?: string; username?: string } = {},
): UnifiedSearchPrepared {
  const q = (query || '').trim()
  const cap = Math.min(limit ?? 6, 12)
  const failures: DomainFailure[] = []
  const from = (options.from ?? '').trim()
  const to = (options.to ?? '').trim()
  const fromValid = from === '' || validDay(from)
  const toValid = to === '' || validDay(to)
  const domainErrors: Partial<Record<UnifiedSearchResourceDomain, UnifiedSearchDomainError>> = {}

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
  return { ok: true, q, cap, range, failures, domainErrors }
}

/** 把域失败映射成统一快照诊断；同步/异步入口只共用这一份收尾逻辑。 */
function finishUnifiedSnapshot(
  snapshot: UnifiedSearchSnapshot,
  failures: DomainFailure[],
  domainErrors: Partial<Record<UnifiedSearchResourceDomain, UnifiedSearchDomainError>>,
): UnifiedSearchSnapshot {
  for (const failure of failures) {
    const unsupported = failure.reason.startsWith('unsupported_scope:')
    domainErrors[failure.key] = {
      code: unsupported ? 'unsupported_scope' : 'read_failed',
      message: failure.reason.replace(/^unsupported_scope:\s*/, ''),
    }
  }
  if (Object.keys(domainErrors).length > 0) snapshot.domainErrors = domainErrors
  const readFailures = failures.filter(failure => !failure.reason.startsWith('unsupported_scope:'))
  if (readFailures.length > 0) {
    // 去重保序：朋友圈那条会连着试两个候选路径，一次失败可能记两笔。
    const seen = new Set<string>()
    const parts: string[] = []
    for (const f of readFailures) {
      if (seen.has(f.domain)) continue
      seen.add(f.domain)
      parts.push(f.domain)
    }
    snapshot.readError = `${parts.join('、')}读取失败（${readFailures[0]?.reason ?? '库打不开'}）—— 这不是「没有结果」`
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
  options: { from?: string; to?: string; username?: string } = {},
): UnifiedSearchSnapshot {
  const prepared = prepareUnifiedSearch(query, limit, options)
  if (!prepared.ok) return prepared.snapshot
  const { q, cap, range, failures, domainErrors } = prepared
  const requestedUsername = (options.username ?? '').trim()
  const username = requestedUsername ? resolveTalkerUsername(decryptedDir, requestedUsername) : ''
  // A legacy hash with no owner must not silently broaden the search to every
  // conversation. Return a scoped empty result instead.
  if (requestedUsername && !username) {
    return finishUnifiedSnapshot(emptyUnifiedSnapshot(q, domainErrors), failures, domainErrors)
  }
  // 时间过滤在消息层是后置的：先多取一些原始命中，避免前 cap 条全在范围外
  // 时把范围内的结果错误地截掉。
  const messageCap = range ? Math.min(Math.max(cap * 10, cap), 300) : cap
  const messages = q ? searchIndexMessages(decryptedDir, q, messageCap, username || undefined).hits : []
  const filteredMessages = range
    ? messages.filter(hit =>
      (range.fromSec === 0 || hit.create_time >= range.fromSec)
      && (range.toSec === 0 || hit.create_time <= range.toSec),
    ).slice(0, cap)
    : messages
  const snapshot: UnifiedSearchSnapshot = {
    query: q,
    messages: filteredMessages,
    contacts: q && !range ? searchContacts(failures, decryptedDir, q, cap, username || undefined) : [],
    moments: q ? searchMoments(failures, decryptedDir, q, cap, range, username || undefined) : [],
    favorites: q ? searchFavorites(failures, decryptedDir, q, cap, range, username || undefined) : [],
    files: q ? searchFiles(failures, decryptedDir, q, cap, range, username || undefined) : [],
    records: q ? searchRecords(failures, decryptedDir, q, cap, range, username || undefined) : [],
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
  options: { from?: string; to?: string; username?: string } = {},
  ctrl?: SearchControl,
): Promise<UnifiedSearchSnapshot> {
  const prepared = prepareUnifiedSearch(query, limit, options)
  if (!prepared.ok) return prepared.snapshot
  const { q, cap, range, failures, domainErrors } = prepared
  const snapshot = emptyUnifiedSnapshot(q, domainErrors)
  if (q === '') return finishUnifiedSnapshot(snapshot, failures, domainErrors)

  if (ctrl?.signal?.aborted) {
    snapshot.cancelled = true
    return finishUnifiedSnapshot(snapshot, failures, domainErrors)
  }

  const requestedUsername = (options.username ?? '').trim()
  const username = requestedUsername ? resolveTalkerUsername(decryptedDir, requestedUsername) : ''
  if (requestedUsername && !username) {
    return finishUnifiedSnapshot(snapshot, failures, domainErrors)
  }
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

  let cancelled = messageResult.cancelled === true
  if (!cancelled) cancelled = await yieldUnifiedSearch(ctrl)
  if (!cancelled && q && !range) {
    snapshot.contacts = searchContacts(failures, decryptedDir, q, cap, username || undefined)
    cancelled = await yieldUnifiedSearch(ctrl)
  }
  if (!cancelled) {
    snapshot.moments = searchMoments(failures, decryptedDir, q, cap, range, username || undefined)
    cancelled = await yieldUnifiedSearch(ctrl)
  }
  if (!cancelled) {
    snapshot.favorites = searchFavorites(failures, decryptedDir, q, cap, range, username || undefined)
    cancelled = await yieldUnifiedSearch(ctrl)
  }
  if (!cancelled) {
    snapshot.files = searchFiles(failures, decryptedDir, q, cap, range, username || undefined)
    cancelled = await yieldUnifiedSearch(ctrl)
  }
  if (!cancelled) {
    snapshot.records = searchRecords(failures, decryptedDir, q, cap, range, username || undefined)
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
