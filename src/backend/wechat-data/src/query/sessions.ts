/**
 * Session queries over st_control's decrypted session.db, rewritten from the
 * Rust sessions::get_session_list. Reads ordinary SQLite via node:sqlite.
 */
import { DatabaseSync } from './db-open.ts'
import { join } from 'node:path'
import type { SessionsSnapshot, WechatSession } from '../types.ts'
import { contactMeta, cachedBySigAsync, fileSigOf, isServiceBizType, shardCatalogSig } from './meta.ts'
import { msgCreateTimeByServerId } from './messages.ts'
import { yieldToLoop } from './search-build.ts'
import {
  fallbackChatDisplayName,
  isMessageTableHash,
  resolveTalkerUsername,
} from './message-identity.ts'

/**
 * 每解析这么多条「未读最早时间」就让出一次。
 *
 * 取 8：单次解析实测约 1.4ms（真实数据 `working/diag-sessions.ts`），8 次≈11ms
 * —— 与其它模块的片段量级对齐（词云 13ms、通话 22ms、资产 39ms）。
 */
const YIELD_EVERY_UNREAD_LOOKUPS = 8

/** Read SessionTable column names (wechat 4.x may add/remove columns). */
function tableColumns(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  return new Set(rows.map(r => r.name))
}

/** Resolve a byte/TEXT summary/draft column to a string. */
function bytesToString(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) {
    // summary/draft are UTF-8 text stored as BLOB or TEXT
    return new TextDecoder('utf-8', { fatal: false }).decode(v)
  }
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/**
 * Session titles from SessionNoContactInfoTable (display name source 2).
 *
 * The same legacy table may key a title by either the real username or the
 * `Msg_<md5>` suffix, depending on how the row was first written. Canonicalize
 * both keys before lookup so the hash never wins over the readable title.
 * @param db - open session database.
 * @param decryptedDir - decrypted data root, used for the identity index.
 * @returns canonical username -> session title.
 */
function loadSessionTitles(db: DatabaseSync, decryptedDir: string): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const rows = db.prepare('SELECT username, session_title FROM SessionNoContactInfoTable').all() as Array<Record<string, unknown>>
    for (const r of rows) {
      const stored = bytesToString(r.username).trim()
      const username = stored ? resolveTalkerUsername(decryptedDir, stored) : ''
      const title = bytesToString(r.session_title).trim()
      if (username && title && title !== stored && !isMessageTableHash(title)) {
        map.set(username, title)
      }
    }
  } catch {
    // table may be absent
  }
  return map
}

/**
 * Collapse two SessionTable rows that canonicalize to the same conversation.
 *
 * Old upgrades can leave a real-username row and a hash-keyed row side by side.
 * Keeping both renders duplicate chats; keeping only the tail row loses unread
 * or draft metadata from the other one. Prefer the newer row, then fill gaps.
 * @param previous - row already collected for this canonical username.
 * @param incoming - duplicate row from SessionTable.
 * @returns one merged row in the UI shape.
 */
function mergeDuplicateSession(previous: WechatSession, incoming: WechatSession): WechatSession {
  const newer = incoming.lastTimestamp >= previous.lastTimestamp ? incoming : previous
  const older = newer === incoming ? previous : incoming
  return {
    ...older,
    ...newer,
    summary: newer.summary || older.summary,
    draft: newer.draft || older.draft,
    unreadCount: Math.max(newer.unreadCount, older.unreadCount),
    pinned: newer.pinned || older.pinned,
    hidden: newer.hidden || older.hidden,
    lastMsgSender: newer.lastMsgSender || older.lastMsgSender,
    lastMsgSenderName: newer.lastMsgSenderName || older.lastMsgSenderName,
    lastMsgType: newer.lastMsgType || older.lastMsgType,
    lastMsgSubType: newer.lastMsgSubType || older.lastMsgSubType,
    ...((newer.enterpriseName ?? older.enterpriseName)
      ? { enterpriseName: newer.enterpriseName ?? older.enterpriseName }
      : {}),
    ...((newer.bizType ?? older.bizType) !== undefined
      ? { bizType: newer.bizType ?? older.bizType }
      : {}),
    ...((newer.accountKind ?? older.accountKind)
      ? { accountKind: newer.accountKind ?? older.accountKind }
      : {}),
  }
}

/** 客服会话识别（真实企业微信/品牌客服会话，排除占位 holder）。 */
function isKefuLike(u: string): boolean {
  const s = u.toLowerCase()
  return s.includes('@weclaw') || s.includes('@kefu.openim') || s.includes('opencustomerservicemsg')
}

/**
 * 公众号/服务号聚合占位会话。
 *
 * 它们只承载入口摘要，没有对应的 `Msg_<md5(username)>` 消息表；真实内容在
 * `gh_*` 账号会话里。保留在普通会话列表会让用户点进一个永远为空的聊天页。
 */
const SYNTHETIC_SESSION_HOLDERS = new Set([
  'brandsessionholder',
  'brandservicesessionholder',
])

export function isSyntheticSessionHolder(username: string): boolean {
  return SYNTHETIC_SESSION_HOLDERS.has((username ?? '').trim().toLowerCase())
}

/**
 * Read the session list from the decrypted session.db.
 * @param decryptedDir - st_control decrypted data root (…/data/wechat/decrypted).
 * @param keyword - optional username/name filter.
 * @param limit - max rows.
 * @returns the session snapshot.
 */
export async function querySessions(
  decryptedDir: string,
  keyword?: string,
  limit?: number,
  offset?: number,
): Promise<SessionsSnapshot> {
  const key = `sessions:${decryptedDir}:${keyword ?? ''}:${limit ?? ''}:${offset ?? ''}`
  const sig = [
    fileSigOf(join(decryptedDir, 'session', 'session.db')),
    fileSigOf(join(decryptedDir, 'contact', 'contact.db')),
    // 会话行的「最近活跃 / 未读」要回查消息分片（msgCreateTimeByServerId），所以分片变了
    // 这份快照也可能变。原先只签 session/contact，靠「事件后整表清空」兜住 —— M8 去掉那层
    // 兜底后必须补上真正读了的东西（shardCatalogSig 内部走按文件粒度的缓存，代价很小）。
    shardCatalogSig(decryptedDir, ['message']),
  ].join('|')
  // 2026-09-28：同步 `cachedBySig` → async 版 —— 冷算实测 78ms 且**一次都不让出**
  // （真实数据 `working/probe-stall.txt`）。见 `computeSessions` 里让出点的注释。
  return cachedBySigAsync(key, sig, () => computeSessions(decryptedDir, keyword, limit, offset))
}

/**
 * 界面全局搜索使用的可取消会话查询。
 *
 * 普通调用仍走按文件签名缓存；带 signal 的操作不能复用缓存 Promise，也不能把
 * 中途取消的部分结果写回缓存，否则下一次同一关键词会命中残缺快照。这里直接
 * 计算并在分片解析的让出点检查取消。
 */
export async function querySessionsCancellable(
  decryptedDir: string,
  keyword?: string,
  limit?: number,
  offset?: number,
  signal?: AbortSignal,
): Promise<SessionsSnapshot> {
  if (signal === undefined) return querySessions(decryptedDir, keyword, limit, offset)
  if (signal.aborted) return { sessions: [], total: 0, cancelled: true }
  return computeSessions(decryptedDir, keyword, limit, offset, signal)
}

async function computeSessions(
  decryptedDir: string,
  keyword?: string,
  limit?: number,
  offset: number = 0,
  signal?: AbortSignal,
): Promise<SessionsSnapshot> {
  if (signal?.aborted) return { sessions: [], total: 0, cancelled: true }
  const dbPath = join(decryptedDir, 'session', 'session.db')
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const cols = tableColumns(db, 'SessionTable')
    if (!cols.has('username')) throw new Error('SessionTable 缺少 username 列')

    const sel = (name: string, dft: string): string => (cols.has(name) ? name : dft)
    // unread_first_msg_srv_id 是 int64：必须 CAST 成 TEXT 再读，否则 node:sqlite 直接 ERR_OUT_OF_RANGE
    const srvCol = cols.has('unread_first_msg_srv_id')
      ? 'CAST(unread_first_msg_srv_id AS TEXT) AS unread_srv'
      : "'' AS unread_srv"
    const sql = [
      'SELECT',
      [sel('username', "''"), sel('unread_count', '0'), sel('summary', 'NULL'), sel('draft', 'NULL'),
        sel('is_hidden', '0'), sel('last_timestamp', '0'), sel('sort_timestamp', 'last_timestamp'),
        sel('last_msg_type', '0'), sel('last_msg_sub_type', '0'), sel('last_msg_sender', "''"),
        sel('last_sender_display_name', "''"), srvCol].join(', '),
      'FROM SessionTable',
      'ORDER BY', sel('sort_timestamp', 'last_timestamp'), 'DESC',
      'LIMIT ?',
    ].join(' ')

    const meta = contactMeta(decryptedDir)
    const contactNames = meta.names
    const sessionTitles = loadSessionTitles(db, decryptedDir)
    const pinned = meta.pinned
    const bizTypes = meta.bizTypes
    const q = (keyword ?? '').trim().toLowerCase()
    // Keyword filtering happens after contact-name resolution, and paging
    // (offset/limit) needs a stable total, so always read up to the bounded
    // 5000-row window before slicing. Rows are lightweight text summaries.
    const fetchLimit = 5000
    const rows = db.prepare(sql).all(fetchLimit) as Array<Record<string, unknown>>
    const key = (cand: string, dft: string): string => (cols.has(cand) ? cand : dft)

    const sessionsByUsername = new Map<string, WechatSession>()
    /** username → unread_first_msg_srv_id（TEXT，供「未读从何时开始」解析用） */
    const srvIds = new Map<string, string>()
    for (const r of rows) {
      const storedUsername = bytesToString(r[key('username', '')]).trim()
      const username = storedUsername ? resolveTalkerUsername(decryptedDir, storedUsername) : ''
      // A hash-shaped SessionTable row without a known owner cannot open a
      // real Msg_ table. Drop it instead of surfacing the hash as a chat.
      if (!username) continue
      if (isSyntheticSessionHolder(username)) continue
      const displayName = contactNames.get(username)?.trim()
        || sessionTitles.get(username)?.trim()
        || fallbackChatDisplayName(username)
      const enterpriseName = meta.enterpriseNames.get(username)?.trim()
      // summary 必须在过滤前算出来：客户端的会话搜索也匹配最后一条消息，
      // 而这里只比 username / displayName ⇒ 那些会话在到达前端之前就被丢掉了，
      // 前端那个 `summary` 分支永远不会命中（实测「2026」后端返回 0、前端本可命中 11）。
      const summary = bytesToString(r[key('summary', 'NULL')])
      if (
        q
        && !username.toLowerCase().includes(q)
        && !displayName.toLowerCase().includes(q)
        && !summary.toLowerCase().includes(q)
        && !(enterpriseName ?? '').toLowerCase().includes(q)
      ) continue
      const srv = String(r['unread_srv'] ?? '').trim()
      // Rows arrive newest-first. If two legacy rows canonicalize to the same
      // chat, keep the newest non-empty unread pointer instead of letting an
      // older duplicate overwrite it.
      if (srv && srv !== '0' && !srvIds.has(username)) srvIds.set(username, srv)
      const lastMsgSender = bytesToString(r[key('last_msg_sender', "''")]).trim()
      const storedSenderName = bytesToString(r[key('last_sender_display_name', "''")]).trim()
      const lastMsgSenderName = storedSenderName
        || contactNames.get(lastMsgSender)?.trim()
        || (lastMsgSender ? fallbackChatDisplayName(lastMsgSender) : '')
      const s: WechatSession = {
        username,
        displayName,
        type: username.endsWith('@chatroom') ? 'group' : 'private',
        lastTimestamp: Number(r[key('last_timestamp', '0')] ?? 0),
        summary,
        unreadCount: Number(r[key('unread_count', '0')] ?? 0),
        draft: bytesToString(r[key('draft', 'NULL')]),
        pinned: pinned.has(username),
        hidden: Number(r[key('is_hidden', '0')] ?? 0) === 1,
        lastMsgType: Number(r[key('last_msg_type', '0')] ?? 0),
        lastMsgSubType: Number(r[key('last_msg_sub_type', '0')] ?? 0),
        lastMsgSender,
        // 老库 / 部分企业微信会话的 display_name 列为空；用通讯录映射补一次，
        // 否则非文本消息的预览只能显示裸 wxid，群聊里读不出“谁发的”。
        lastMsgSenderName,
        ...(enterpriseName ? { enterpriseName } : {}),
      }
      if (username.startsWith('gh_')) {
        const bt = bizTypes.get(username)
        s.bizType = bt ?? 0
        // 与通讯录（contacts.ts）共用同一判据，避免同一账号在两个面板落到不同类目。
        s.accountKind = isServiceBizType(bt) ? 'service' : 'official'
      } else if (isKefuLike(username)) {
        s.accountKind = 'kefu'
      }
      const previous = sessionsByUsername.get(username)
      sessionsByUsername.set(
        username,
        previous === undefined ? s : mergeDuplicateSession(previous, s),
      )
    }
    const sessions = [...sessionsByUsername.values()]
    // Pinned first, then newest. Sort explicitly because deduplication can
    // replace an earlier Map value with a row that arrived later in SQL order.
    sessions.sort((a, b) => (
      (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)
      || b.lastTimestamp - a.lastTimestamp
    ))
    const total = sessions.length
    const page = limit === undefined ? sessions : sessions.slice(offset, offset + limit)
    if (signal?.aborted) return { sessions: page, total, cancelled: true }
    /*
     * 「未读从什么时候开始」（第 67 轮）。
     *
     * `SessionTable.unread_first_msg_srv_id` 指向该会话最早的一条未读消息；把它换成 create_time，
     * 界面就能写「未读 48 条 · 最早 2 小时前」——判断先看哪个会话，比光一个数字有用得多。
     * 只对**返回的那一页**里 unread>0 的会话解析（实测 41 个未读会话全部解析约 7ms，
     * 走的是 messages.ts 里 catalog 化的分片索引），并设一个上限，避免 limit=500 时做 500 次查找。
     * 解析不到就留空（2 个 srv_id=0 的合成会话必然为空），界面不显示这一行即可。
     */
    let budget = 80
    let sinceYield = 0
    for (const s of page) {
      if (budget <= 0) break
      if ((s.unreadCount ?? 0) <= 0 || isSyntheticSessionHolder(s.username)) continue
      const sid = srvIds.get(s.username)
      if (!sid || sid === '0') continue
      budget -= 1
      const since = msgCreateTimeByServerId(decryptedDir, s.username, sid)
      if (since !== null) s.unreadSince = since
      // 2026-09-28：让出点。实测口径（`working/diag-sessions.ts`，真实数据）：
      // `SessionTable` 全表读取只要 **1ms**（290 行），而这一圈 **41 次**查找要 **59ms**
      // —— `querySessions(200)` 的 78ms 几乎全在这里。每次查找都要按 catalog 打开分片，
      // 41 次连做就是几十毫秒的**不间断同步执行**（`working/probe-stall.txt` 里它是
      // 仅剩两个"让出 0"的接口之一）。原文注释只量了"约 7ms"，那是单次热缓存的数。
      sinceYield += 1
      if (sinceYield >= YIELD_EVERY_UNREAD_LOOKUPS) {
        sinceYield = 0
        await yieldToLoop()
        if (signal?.aborted) return { sessions: page, total, cancelled: true }
      }
    }
    return { sessions: page, total }
  } finally {
    db.close()
  }
}
