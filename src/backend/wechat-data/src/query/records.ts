/**
 * Records queries (撤回/转账/红包/视频号/小程序/好友验证) over general.db,
 * rewritten from st_control general_records/lists.rs. The revoked cache lives
 * in message shards (handlers/data/revoked.rs mirror).
 */
import { DatabaseSync } from 'node:sqlite'
import { withDb } from './db-open.ts'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordItem } from '../types.ts'
import { contactMeta } from './meta.ts'
import { archiveRevokeCache, readArchivedRevoke } from './anti-revoke-archive.ts'
import { archiveMessages, queryRevokedRetained } from './revoke-retain.ts'

/** Stringify an SQLite cell (TEXT/NUMBER/BLOB) to a string. */
function cellString(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (v instanceof Uint8Array) return new TextDecoder('utf-8', { fatal: false }).decode(v)
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

function countIn(db: DatabaseSync, table: string): number {
  try { return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n } catch { return 0 }
}

/** Count rows with an optional WHERE clause. */
function countWhere(db: DatabaseSync, table: string, whereSql: string): number {
  try {
    if (!whereSql) return countIn(db, table)
    return (db.prepare('SELECT COUNT(*) AS n FROM ' + table + whereSql).get() as { n: number }).n
  } catch {
    return 0
  }
}

/** Query one records table with limit/offset/keyword/direction, returning rows as objects. */
function queryTable(
  db: DatabaseSync,
  table: string,
  cols: string[],
  orderCol: string,
  limit: number,
  offset: number,
  whereSql = '',
  direction: 'asc' | 'desc' = 'desc',
): RecordItem[] {
  try {
    const sel = cols.map(c => c).join(', ')
    const dir = direction === 'asc' ? 'ASC' : 'DESC'
    const sql = 'SELECT ' + sel + ' FROM ' + table + whereSql + ' ORDER BY ' + orderCol + ' ' + dir + ' LIMIT ? OFFSET ?'
    return db.prepare(sql).all(limit, offset) as RecordItem[]
  } catch (e) {
    // 绝不能再静默吞掉：之前这里吞掉了 finder_live_id 的越界 int64 异常，
    // 界面上只表现为「这个页签是空的」，而 total 仍显示 2 —— 两者互相矛盾才暴露出来。
    console.warn('[records] 读取失败（与「确无记录」不同）：' + table + ': ' + ((e as Error)?.message ?? String(e)))
    return []
  }
}

/** Build a numeric time-range WHERE fragment for a time column. */
function timeRangeSql(timeCol: string, from: number, to: number): string {
  const parts: string[] = []
  if (from > 0) parts.push(' ' + timeCol + ' >= ' + String(Math.floor(from)))
  if (to > 0) parts.push(' ' + timeCol + ' <= ' + String(Math.floor(to)))
  return parts.length > 0 ? parts.join(' AND') : ''
}

/**
 * Locate the revoke cache table across message shards.
 * 交出的是**位置**（文件 + 表名）而不是连接：原先 `if (hit) return { db, ... }` 之外
 * 还有 `catch { /* next *\/ }` —— 分片能打开但探测查询抛错时（损坏 / SQLITE_BUSY），
 * 那条连接没人关就跳去下一片，正是 P0-1 那一类漏法。
 */
function findRevokeTable(decryptedDir: string): { file: string; table: string } {
  const msgDir = join(decryptedDir, 'message')
  if (!existsSync(msgDir)) return { file: '', table: '' }
  for (const file of readdirSync(msgDir)) {
    if (!file.endsWith('.db') || file.includes('_shm') || file.includes('_wal')) continue
    const p = join(msgDir, file)
    try {
      const table = withDb(p, (db) => {
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => String(r.name))
        return tables.find(t => t.includes('_weflow_anti_revoke_deleted_cache')) ?? ''
      })
      if (table) return { file: p, table }
    } catch { /* next */ }
  }
  return { file: '', table: '' }
}

/** 为记录追加「人类可读」展示字段（显示名）。 */
function enrichRecords(items: RecordItem[], kind: string, names: Map<string, string>): void {
  const dn = (v: unknown): string => {
    const s = cellString(v)
    return s ? (names.get(s) ?? '') : ''
  }
  for (const it of items) {
    if (kind === 'revokes') it['session_display'] = dn(it['session_name'])
    if (kind === 'transfers') {
      it['session_display'] = dn(it['session_name'])
      it['receiver_display'] = dn(it['pay_receiver'])
      it['payer_display'] = dn(it['pay_payer'])
    }
    if (kind === 'redpackets') {
      it['session_display'] = dn(it['session_name'])
      it['sender_display'] = dn(it['sender_user_name'])
    }
    if (kind === 'finder') it['username_display'] = dn(it['finder_username'])
    if (kind === 'friendverifications') it['user_display'] = dn(it['user_name_'])
  }
}
/** Record-type words that are data-source names, not record content (source stopwords). */
function isRecordTypeStopword(q: string): boolean {
  return [
    '红包', '转账', '转帐', '收款', '付款', '收红包', '发红包', '红包记录', '转账记录',
    'redpacket', 'red_packet', 'transfer', '转账明细', '红包明细',
  ].includes(q.trim().toLowerCase())
}

/**
 * Query one records kind.
 * @param decryptedDir - decrypted data root.
 * @param kind - records kind key.
 * @param limit - max rows.
 * @param offset - page offset.
 * @param q - optional session/user/id keyword (applied server-side per kind).
 * @returns the records snapshot.
 */
export function queryRecords(
  decryptedDir: string,
  kind: string,
  limit?: number,
  offset?: number,
  q?: string,
  opts?: { from?: number; to?: number; direction?: 'asc' | 'desc' },
): { items: RecordItem[]; total: number } {
  const gdb = join(decryptedDir, 'general', 'general.db')
  if (!existsSync(gdb)) return { items: [], total: 0 }
  const db = new DatabaseSync(gdb, { readOnly: true })
  try {
    const cap = Math.min(limit ?? 50, 500)
    const off = offset ?? 0
    const kw = (q ?? '').trim()
    const from = Math.max(0, opts?.from ?? 0)
    const to = Math.max(0, opts?.to ?? 0)
    const direction = opts?.direction === 'asc' ? 'asc' : 'desc'
    const esc = (v: string): string => v.replace(/'/g, "''")
    const names = contactMeta(decryptedDir).names

    // per-kind column sets mirror general_records/lists.rs; the frontend maps
    // them to per-kind tables (会话/类型/收款方/…)
    const spec: Record<string, { table: string; cols: string[]; order: string; where?: string; timeCol?: string }> = {
      revokes: {
        table: 'revokebatchmessage',
        cols: ['local_id', 'batch_id', 'msg_unique_id', 'session_name', 'msg_local_id', 'msg_create_time'],
        order: 'msg_create_time',
        timeCol: 'msg_create_time',
        where: kw ? ` WHERE session_name LIKE '%${esc(kw)}%' OR msg_unique_id LIKE '%${esc(kw)}%'` : '',
      },
      transfers: {
        table: 'transferTable',
        cols: ['transfer_id', 'transcation_id', 'CAST(message_server_id AS TEXT) AS message_server_id', 'CAST(second_message_server_id AS TEXT) AS second_message_server_id', 'session_name', 'pay_sub_type', 'pay_receiver', 'pay_payer', 'begin_transfer_time', 'last_modified_time', 'invalid_time', 'last_update_time', 'delay_confirm_flag'],
        order: 'begin_transfer_time',
        timeCol: 'begin_transfer_time',
        where: kw && !isRecordTypeStopword(kw) ? ` WHERE session_name LIKE '%${esc(kw)}%' OR transfer_id LIKE '%${esc(kw)}%'` : '',
      },
      redpackets: {
        table: 'redEnvelopeTable',
        cols: ['CAST(message_server_id AS TEXT) AS message_server_id', 'session_name', 'sender_user_name', 'native_url', 'send_id', 'scene_id', 'hb_status', 'hb_type', 'receive_status'],
        order: 'message_server_id',
        where: kw && !isRecordTypeStopword(kw) ? ` WHERE session_name LIKE '%${esc(kw)}%' OR sender_user_name LIKE '%${esc(kw)}%'` : '',
      },
      finder: {
        table: 'wcfinderlivestatus',
        // CAST 成 TEXT：该列是 64 位整数，实测 1214293303336576460 / 2078956456102183056
        // 都超过 Number.MAX_SAFE_INTEGER，node:sqlite 直接读会抛 ERR_OUT_OF_RANGE，
        // 被 queryTable 的 catch 吞掉后就表现为「页签有 total 但一行都渲染不出来」。
        cols: ['CAST(finder_live_id AS TEXT) AS finder_live_id', 'finder_username', 'finder_export_id', 'live_status', 'replay_status', 'charge_flag'],
        order: 'finder_live_id',
      },
      miniprograms: {
        table: 'wacontact',
        cols: ['user_name', 'type', 'brand_icon_url', 'external_info', 'app_id'],
        order: 'user_name',
        timeCol: 'last_update_time',
      },
      friendverifications: {
        table: 'FMessageTable',
        cols: ['user_name_', 'type_', 'timestamp_', 'content_', 'is_sender_', 'scene_', 'remark_'],
        order: 'timestamp_',
        timeCol: 'timestamp_',
        where: kw ? ` WHERE user_name_ LIKE '%${esc(kw)}%' OR remark_ LIKE '%${esc(kw)}%' OR content_ LIKE '%${esc(kw)}%'` : '',
      },
    }
    const s = spec[kind]
    if (!s) return { items: [], total: 0 }

    // Combine the keyword WHERE clause (may contain OR) with the time range.
    const combineWhere = (base: string, time: string): string => {
      const b = base.trim()
      const t = time.trim()
      if (!b) return t ? ' WHERE ' + t : ''
      // 这里以前是 `if (!t) return b`：`b` 是被 trim 过的，**开头那个空格就是被 trim 掉的**，
      // 于是拼出来的 SQL 是 `FROM transferTableWHERE (…)` —— prepare 语法错误，
      // 上层把它当「没有结果」，用户看到的是「搜关键词就清空」（不带关键词反而正常）。
      // 两个分支现在都保证以 ` WHERE ` 开头。
      const inner = b.replace(/^WHERE\s+/i, '')
      if (!t) return ' WHERE ' + inner
      return ' WHERE (' + inner + ') AND ' + t
    }
    const timeSql = (timeCol: string): string => timeRangeSql(timeCol, from, to)

    // miniprograms: LEFT JOIN the WeApp table for last_update_time and parse
    // the display nickname out of external_info JSON (source lists.rs). Base
    // columns are prefixed with w. because WeApp shares user_name.
    if (kind === 'miniprograms') {
      const prefixed = s.cols.map(c => 'w.' + c).join(', ')
      const sel = prefixed + ', COALESCE(a.last_update_time, 0) AS last_update_time'
      const baseWhere = kw ? ' WHERE w.user_name LIKE \'' + esc(kw) + '%\'' : ''
      const whereSql = combineWhere(baseWhere, s.timeCol ? timeSql('a.' + s.timeCol) : '')
      const dir = direction === 'asc' ? 'ASC' : 'DESC'
      const sql = 'SELECT ' + sel + ' FROM wacontact w LEFT JOIN WeAppBizAttrSyncBufferTableV02 a ON a.user_name = w.user_name' + whereSql + ' ORDER BY COALESCE(a.last_update_time, 0) ' + dir + ', w.user_name ASC LIMIT ? OFFSET ?'
      let items: RecordItem[] = []
      try { items = db.prepare(sql).all(cap, off) as RecordItem[] } catch { items = [] }
      for (const it of items) {
        const ext = String(it['external_info'] ?? '')
        let nickname = ''
        try {
          const v = JSON.parse(ext) as { RegisterSource?: { NickName?: unknown }; NickName?: unknown }
          nickname = cellString(v.RegisterSource?.NickName || v.NickName || '')
        } catch { /* not JSON */ }
        it['nickname'] = nickname
      }
      enrichRecords(items, kind, names)
      let total = 0
      try {
        total = (db.prepare('SELECT COUNT(*) AS n FROM wacontact w LEFT JOIN WeAppBizAttrSyncBufferTableV02 a ON a.user_name = w.user_name' + whereSql).get() as { n: number }).n
      } catch { total = 0 }
      return { items, total }
    }
    const whereSql = combineWhere(s.where ?? '', s.timeCol ? timeSql(s.timeCol) : '')
    const items = queryTable(db, s.table, s.cols, s.order, cap, off, whereSql, direction)
    enrichRecords(items, kind, names)
    return { items, total: countWhere(db, s.table, whereSql) }
  } finally {
    db.close()
  }
}

/** WeChat message local_type → Chinese label (mirror handlers/data/revoked.rs). */
function revokeTypeLabel(t: number): string {
  switch (t) {
    case 1: return '文本'
    case 3: return '图片'
    case 34: return '语音'
    case 42: return '名片'
    case 43: return '视频'
    case 47: return '表情'
    case 48: return '位置'
    case 49: return '文件/链接'
    case 10000: return '系统消息'
    default: return '其他'
  }
}

/** Parse message_content `sender:\n内容` (mirror handlers/data/revoked.rs). */
function parseRevokeContent(raw: string | null | undefined, fallbackSender: string): { sender: string; content: string } {
  if (raw == null) return { sender: fallbackSender, content: '（无内容副本）' }
  const nl = raw.indexOf('\n')
  let sender = fallbackSender
  let body = raw
  if (nl >= 0) {
    const head = raw.slice(0, nl).replace(/:+$/, '').trim()
    if (head) sender = head
    body = raw.slice(nl + 1)
  }
  const content = body.trim()
  return { sender, content: content || '（内容为编码/压缩格式，无法预览）' }
}

/**
 * 把一行撤回记录映射成展示项。
 *
 * 插件直读与**我们的归档库**共用这一套解析（形状相同），避免两处各自解释格式；
 * 原文的"发送者/内容"仍交给 `parseRevokeContent`（首行发送者 + 其余为正文）。
 * @param r - 形状与插件缓存一致的一行。
 * @returns 列表项（sender / type_label / content / create_time）。
 */
function mapRevokeRow (r: { lt?: number; rid?: number; ct?: number; mc?: string | Uint8Array | null }): { sender: string; type_label: string; content: string; create_time: number } {
  const t = r.lt ?? 0
  const realId = r.rid ?? 0
  const fallback = realId > 0 ? `发送者#${realId}` : '未知发送者'
  const { sender, content } = parseRevokeContent(cellString(r.mc), fallback)
  return { sender, type_label: revokeTypeLabel(t), content, create_time: r.ct ?? 0 }
}

/**
 * 撤回消息列表（2026-09-29 起：**优先读我们自己的归档库**，见 `anti-revoke-archive.ts`）。
 *
 * 数据来源两处，形状一致（sender / type_label / content / create_time，按时间倒序）：
 *   ① 我们的归档库 `<数据根>/anti-revoke-archive.db` —— 只增不改，原文永久保留；
 *   ② 第三方反撤回插件的缓存表 `*_weflow_anti_revoke_deleted_cache` —— 仅作来源与降级直读。
 * @param decryptedDir - decrypted data root.
 * @param limit - max rows (default 200, capped 500).
 * @param offset - 偏移。
 * @param q - 关键词（匹配原文 / 发送者 id）。
 * @returns the revoked snapshot.
 */
export function queryRevoked(
  decryptedDir: string,
  limit?: number,
  offset: number = 0,
  /** 关键词：匹配撤回内容 / 发送者 id。放在服务端，避免只搜到已加载那一页。 */
  q?: string,
): { items: Array<{ sender: string; type_label: string; content: string; create_time: number }>; total: number } {
  const cap = Math.min(limit ?? 200, 500)
  /**
   * ① **先归档、再从我们自己的库出列表**（2026-09-29 用户选 C：全量归档）。
   *
   * 真机实测：微信库里只有 `"某某" 撤回了一条消息` 这种系统消息（3,233 条），
   * **提示不含原文也不含 msgid**，撤回后原文那行已不在库 ⇒ 事后读库永远拿不到原文。
   * 所以唯一可行的顺序是"先把内容存进我们自己的库（只增不改），再按'同会话里紧挨在提示之前'
   * 配对原文"——见 `revoke-retain.ts`。归档是幂等的，重复调用只补新行。
   */
  try {
    archiveMessages(decryptedDir)
    const retained = queryRevokedRetained(decryptedDir, cap, offset, q)
    if (retained.items.length > 0) return { items: retained.items, total: retained.total }
  } catch { /* 归档/识别失败 → 退回下面的第三方插件路径，绝不让列表整体挂掉 */ }
  const loc = findRevokeTable(decryptedDir)
  /** 把插件缓存里的记录**幂等归档**到我们自己的库：原文只增不改，插件清缓存也不丢（见该模块注释）。 */
  if (loc.table) {
    try { archiveRevokeCache(decryptedDir, loc.file, loc.table) } catch { /* 归档失败不影响出列表 */ }
    try {
      // 归档成功 ⇒ 从**我们自己的库**出列表（原文永久保留，不再依赖插件那张表还在不在）。
      const archived = readArchivedRevoke(decryptedDir, cap, offset, q)
      if (archived.rows.length > 0) {
        return { items: archived.rows.map((r) => mapRevokeRow(r)), total: archived.total }
      }
    } catch { /* 归档库读不了就退回直读插件缓存 */ }
  }
  if (!loc.table) return { items: [], total: 0 }
  return withDb(loc.file, (db) => {
    const cols = new Set((db.prepare(`PRAGMA table_info(${loc.table})`).all() as Array<{ name: string }>).map(r => r.name))
    const sel = (cand: string, dft: string): string => (cols.has(cand) ? cand : dft)
    const kw = (q ?? '').trim()
    const like = '%' + kw.replace(/[\\%_]/g, (m) => '\\' + m) + '%'
    const whereSql = kw
      ? ` WHERE (${sel('message_content', "''")} LIKE ? ESCAPE '\\' OR CAST(${sel('real_sender_id', '0')} AS TEXT) LIKE ? ESCAPE '\\')`
      : ''
    const kwParams: string[] = kw ? [like, like] : []
    const rows = db.prepare(`SELECT ${sel('local_type', '0')} AS lt, ${sel('real_sender_id', '0')} AS rid, ${sel('create_time', '0')} AS ct, ${sel('message_content', "''")} AS mc FROM ${loc.table}${whereSql} ORDER BY create_time DESC LIMIT ? OFFSET ?`).all(...kwParams, cap, offset) as Array<{ lt?: number; rid?: number; ct?: number; mc?: string | Uint8Array | null }>
    const items = rows.map((r) => mapRevokeRow(r))
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM ${loc.table}${whereSql}`).get(...kwParams) as { n: number } | undefined)?.n ?? items.length
    return { items, total }
  })
}
