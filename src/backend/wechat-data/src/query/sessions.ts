/**
 * Session queries over st_control's decrypted session.db, rewritten from the
 * Rust sessions::get_session_list. Reads ordinary SQLite via node:sqlite.
 */
import { DatabaseSync } from './db-open.ts'
import { join } from 'node:path'
import type { WechatSession } from '../types.ts'
import { contactMeta, cachedBySigAsync, fileSigOf, isServiceBizType, shardCatalogSig } from './meta.ts'
import { msgCreateTimeByServerId } from './messages.ts'
import { yieldToLoop } from './search-build.ts'

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

/** Session titles from SessionNoContactInfoTable (display name source 2). */
function loadSessionTitles(db: DatabaseSync): Map<string, string> {
  const map = new Map<string, string>()
  try {
    const rows = db.prepare('SELECT username, session_title FROM SessionNoContactInfoTable').all() as Array<Record<string, unknown>>
    for (const r of rows) {
      const u = bytesToString(r.username)
      if (u) map.set(u, bytesToString(r.session_title))
    }
  } catch {
    // table may be absent
  }
  return map
}

/** 客服会话识别（真实企业微信/品牌客服会话，排除占位 holder）。 */
function isKefuLike(u: string): boolean {
  const s = u.toLowerCase()
  return s.includes('@weclaw') || s.includes('@kefu.openim') || s.includes('opencustomerservicemsg')
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
): Promise<{ sessions: WechatSession[]; total: number }> {
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

async function computeSessions(
  decryptedDir: string,
  keyword?: string,
  limit?: number,
  offset: number = 0,
): Promise<{ sessions: WechatSession[]; total: number }> {
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
    const sessionTitles = loadSessionTitles(db)
    const pinned = meta.pinned
    const bizTypes = meta.bizTypes
    const q = (keyword ?? '').trim().toLowerCase()
    // Keyword filtering happens after contact-name resolution, and paging
    // (offset/limit) needs a stable total, so always read up to the bounded
    // 5000-row window before slicing. Rows are lightweight text summaries.
    const fetchLimit = 5000
    const rows = db.prepare(sql).all(fetchLimit) as Array<Record<string, unknown>>
    const key = (cand: string, dft: string): string => (cols.has(cand) ? cand : dft)

    const sessions: WechatSession[] = []
    /** username → unread_first_msg_srv_id（TEXT，供「未读从何时开始」解析用） */
    const srvIds = new Map<string, string>()
    for (const r of rows) {
      const username = bytesToString(r[key('username', '')])
      const displayName = contactNames.get(username) ?? sessionTitles.get(username) ?? username
      // summary 必须在过滤前算出来：客户端的会话搜索也匹配最后一条消息，
      // 而这里只比 username / displayName ⇒ 那些会话在到达前端之前就被丢掉了，
      // 前端那个 `summary` 分支永远不会命中（实测「2026」后端返回 0、前端本可命中 11）。
      const summary = bytesToString(r[key('summary', 'NULL')])
      if (q && !username.toLowerCase().includes(q) && !displayName.toLowerCase().includes(q) && !summary.toLowerCase().includes(q)) continue
      const srv = String(r['unread_srv'] ?? '').trim()
      if (srv && srv !== '0') srvIds.set(username, srv)
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
        lastMsgSender: bytesToString(r[key('last_msg_sender', "''")]).trim(),
        lastMsgSenderName: bytesToString(r[key('last_sender_display_name', "''")]).trim(),
      }
      if (username.startsWith('gh_')) {
        const bt = bizTypes.get(username)
        s.bizType = bt ?? 0
        // 与通讯录（contacts.ts）共用同一判据，避免同一账号在两个面板落到不同类目。
        s.accountKind = isServiceBizType(bt) ? 'service' : 'official'
      } else if (isKefuLike(username)) {
        s.accountKind = 'kefu'
      }
      sessions.push(s)
    }
    // pinned-first ordering (stable: keeps sort_timestamp DESC within groups)
    sessions.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0))
    const total = sessions.length
    const page = limit === undefined ? sessions : sessions.slice(offset, offset + limit)
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
      if ((s.unreadCount ?? 0) <= 0 || s.username === 'brandsessionholder') continue
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
      if (sinceYield >= YIELD_EVERY_UNREAD_LOOKUPS) { sinceYield = 0; await yieldToLoop() }
    }
    return { sessions: page, total }
  } finally {
    db.close()
  }
}
