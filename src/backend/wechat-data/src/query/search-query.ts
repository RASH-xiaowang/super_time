/**
 * `query/search.ts` 的「查询侧：兜底扫描生成器、命中投影、可取消的搜索入口」部分（M21 拆分）。
 *
 * 从 `search.ts` 原样搬出，**行为逐字节不变**；`search.ts` 继续以 `export *` 转发
 * ⇒ 所有 `from './search.ts'` 的导入一行都不用改。
 *
 * @module search-query
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import type { SearchHit } from '../types.ts'
import { decodeCell, loadDisplayNames, loadSessionUsernames, messageShardFiles, msgTableName, searchIndexBatch } from './search-scaffold.ts'

/** Split the group-message sender prefix (`wxid_xxx:\n`) into sender id + body. */
export function splitGroupPrefix(text: string, username: string): { sender: string; body: string } {
  if (!username.endsWith('@chatroom')) return { sender: '', body: text }
  const m = text.match(/^[A-Za-z0-9_@.\-]{3,64}:\n/)
  return m ? { sender: m[0].slice(0, -2), body: text.slice(m[0].length) } : { sender: '', body: text }
}

/** Strip the group-message sender prefix (wxid_xxx:\n) from display text. */
export function stripGroupPrefix(text: string, username: string): string {
  return splitGroupPrefix(text, username).body
}

/** 群内发送者的显示名（联系人表里有就用名字，否则退回 wxid）。 */
export function senderLabel(sender: string, names: Map<string, string>): string {
  if (!sender) return ''
  return names.get(sender) ?? sender
}

/**
 * 从 appmsg / 系统消息的 XML 里抽出可读文本。
 *
 * 微信把「转账、链接、文件、引用、系统提示」这类消息存成
 * `<msg><appmsg><title><![CDATA[微信转账]]></title><des>收到转账1500.00元…</des>…`
 * —— **不是**纯文本。旧索引只收 `local_type=1`，于是「微信转账收到转账1500元」
 * 这类消息完全不在索引里，而它恰恰是「最近一次转账给我的是谁」的唯一答案（实测）。
 * 这里按字段名抽取（title/des/content…），并剥掉标签与 CDATA。
 * @param raw - 原始消息内容（可能是 XML 也可能是纯文本）。
 * @returns 可读文本（无可读内容时返回空串）。
 */
export function readableMessageText(raw: string): string {
  const t = String(raw || '').trim()
  if (!t) return ''
  if (!t.startsWith('<')) return t
  const parts: string[] = []
  for (const tag of ['title', 'des', 'content', 'nickname', 'username']) {
    let from = 0
    while (parts.length < 8) {
      const si = t.indexOf('<' + tag, from)
      if (si < 0) break
      const gt = t.indexOf('>', si)
      if (gt < 0) break
      const ei = t.indexOf('</' + tag, gt)
      if (ei < 0) break
      let v = t.slice(gt + 1, ei).trim()
      // 匹配成功就一定有捕获组 1；兜回 `v` 本身而不是空串 —— 万一没有，宁可留着原文也不静默丢内容。
      const cdata = v.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)
      if (cdata) v = cdata[1] ?? v
      v = v.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
      if (v) parts.push(v)
      from = ei + 1
    }
    if (parts.length >= 8) break
  }
  return parts.join('  ').trim()
}

/** Format a unix timestamp as YYYY-MM-DD HH:MM. */
export function formatFullTime(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 一条会话窗口内的消息（用于 chunk 级上下文：单条微信消息几乎不构成检索单元）。 */
export interface WindowMessage {
  local_id: number
  sort_seq: number
  create_time: number
  text: string
  sender: string
}

/** (分片|表名) → 该表是否存在。窗口展开会按会话反复查同一张表，缓存掉这个探测。 */
export const windowTableCache = new Map<string, boolean>()

/**
 * 取某个会话在 centerMs 前后 spanMs 内的连续消息（对话窗口）。
 *
 * 为什么便宜：Msg_* 表上带 `(local_type, sort_seq)` 复合索引，窗口查询走
 * `SEARCH ... USING INDEX _TYPE_SEQ`，实测 0ms。这是 chunk 级检索可行的前提 ——
 * 单条消息「我没答应」本身无法回答「谁答应过什么」，必须带上前后的对话。
 *
 * @param decryptedDir - decrypted data root.
 * @param username - 会话 username。
 * @param centerMs - 窗口中心（毫秒时间戳）。
 * @param spanMs - 前后各取多少毫秒。
 * @param limit - 窗口内最多几条。
 * @returns 按时间升序的消息；会话不可读时返回空数组（调用方退化为单条引用）。
 */
export function loadMessageWindow(
  decryptedDir: string,
  username: string,
  centerMs: number,
  spanMs: number,
  limit = 14,
): WindowMessage[] {
  if (!username || !Number.isFinite(centerMs) || centerMs <= 0) return []
  const table = msgTableName(username)
  const lo = Math.max(0, Math.floor(centerMs - spanMs))
  const hi = Math.floor(centerMs + spanMs)
  const out: WindowMessage[] = []
  for (const shard of messageShardFiles(decryptedDir)) {
    const key = shard + '|' + table
    let has = windowTableCache.get(key)
    if (has === undefined) {
      let probe: DatabaseSync | null = null
      try {
        probe = new DatabaseSync(shard, { readOnly: true })
        has = probe.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
      } catch {
        has = false
      } finally {
        try { probe?.close() } catch { /* ignore */ }
      }
      windowTableCache.set(key, has)
    }
    if (!has) continue
    let sdb: DatabaseSync | null = null
    try {
      sdb = new DatabaseSync(shard, { readOnly: true })
      const rows = sdb.prepare(
        'SELECT local_id, sort_seq, create_time, message_content FROM "' + table + '"'
        + ' WHERE local_type=1 AND sort_seq BETWEEN ? AND ? ORDER BY sort_seq LIMIT ?',
      ).all(lo, hi, limit) as Array<Record<string, unknown>>
      for (const r of rows) {
        const raw = decodeCell(r['message_content']).trim()
        if (!raw || raw.startsWith('<')) continue
        const { sender, body } = splitGroupPrefix(raw, username)
        const text = body.replace(/\s+/g, ' ').trim()
        if (!text) continue
        out.push({
          local_id: Number(r['local_id'] ?? 0),
          sort_seq: Number(r['sort_seq'] ?? 0),
          create_time: Number(r['create_time'] ?? 0),
          text,
          sender,
        })
      }
      // 同一会话的窗口只落在一个分片里；命中即停，避免把全部分片扫一遍
      if (out.length > 0) break
    } catch {
      /* 分片不可读：跳过 */
    } finally {
      try { sdb?.close() } catch { /* ignore */ }
    }
  }
  return out
}

/**
 * Search WeChat's own message_fts.db (message_fts_v4_* + ImgFts*) which
 * covers text AND image messages, mapping session_id back through name2id.
 * @returns hits (empty when the built-in index is absent/empty).
 */
export function searchWechatFts(
  decryptedDir: string,
  q: string,
  cap: number,
  names: Map<string, string>,
  scopeUsername?: string,
): { hits: SearchHit[] } {
  const p = join(decryptedDir, 'message', 'message_fts.db')
  if (!existsSync(p)) return { hits: [] }
  try {
    const db = new DatabaseSync(p, { readOnly: true })
    const sessions = new Map<number, string>()
    try {
      const rows = db.prepare('SELECT rowid AS id, username AS u FROM name2id').all() as Array<{ id: number; u: unknown }>
      for (const r of rows) sessions.set(r.id, decodeCell(r.u))
    } catch { /* no name2id */ }
    const out: SearchHit[] = []
    const like = '%' + q.replace(/[%_]/g, ' ') + '%'
    for (const [content, aux] of [
      ['message_fts_v4_0_content', 'message_fts_v4_aux_0'],
      ['message_fts_v4_1_content', 'message_fts_v4_aux_1'],
      ['message_fts_v4_2_content', 'message_fts_v4_aux_2'],
      ['message_fts_v4_3_content', 'message_fts_v4_aux_3'],
    ] as const) {
      try {
        const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(content) !== undefined
        if (!exists) continue
        const sql = 'SELECT c.c0 AS c, a.message_local_id AS lid, a.sort_seq AS ss, a.session_id AS sid FROM "' + content + '" c LEFT JOIN "' + aux + '" a ON a.rowid = c.id WHERE c.c0 LIKE ? ORDER BY c.id DESC LIMIT ?'
        const rows = db.prepare(sql).all(like, cap) as Array<Record<string, unknown>>
        for (const r of rows) {
          const username = sessions.get(Number(r['sid'])) ?? ''
          // 会话范围必须真的过滤（此前兜底路径忽略 scope，选了会话仍混入其他会话）
          if (scopeUsername && username !== scopeUsername) continue
          const text = decodeCell(r['c'])
          const { sender, body: display } = splitGroupPrefix(text, username)
          // sort_seq 是毫秒时间戳：恢复 create_time，时间筛选与显示才可用（此前恒为 0，时间范围会把命中全部滤掉）
          const ssMs = Number(r['ss'] ?? 0)
          const createTime = ssMs > 1e12 ? Math.floor(ssMs / 1e3) : ssMs > 1e9 ? Math.floor(ssMs) : 0
          out.push({
            text,
            username,
            create_time: createTime,
            local_id: Number(r['lid'] ?? 0),
            name: names.get(username) ?? username,
            time: createTime ? formatFullTime(createTime) : '',
            snippet: display.slice(0, 120),
            sender: senderLabel(sender, names),
          })
          if (out.length >= cap) break
        }
      } catch { /* shard unavailable */ }
      if (out.length >= cap) break
    }
    db.close()
    return { hits: out }
  } catch {
    return { hits: [] }
  }
}

/**
 * 搜索的取消通道（N9）。与导出的 `StreamControl` 同构，但搜索没有进度可言，只留取消令牌。
 */
export interface SearchControl {
  /** 取消令牌；aborted 后兜底扫描尽快收尾，返回已找到的部分并带 `cancelled: true`。 */
  signal?: AbortSignal
}

/** 兜底扫描的协作粒度：每 128 行查一次取消（在慢 20 倍的 runner 上也能守住 100ms 口径）。 */
export const ABORT_CHECK_EVERY_ROWS = 128

/** 让出事件循环的时间预算：单次不让出的时间超过它就 `await setImmediate`。 */
export const YIELD_EVERY_MS = 25

/**
 * 兜底扫描的**遍历核心**：逐条产出「talker + 原始行」，直到预算耗尽或调用方提前 break。
 *
 * 为什么是生成器：扫描有两种驱动方式（见下两个导出函数），而遍历/连接/预算只能有一份 ——
 *   · 同步驱动：一口气跑完，行为与改造前逐字节一致（问答路径与既有调用方在用）；
 *   · 协作驱动：每 {@link ABORT_CHECK_EVERY_ROWS} 行查取消、每 {@link YIELD_EVERY_MS} 毫秒让出。
 * 生成器的 `finally` 保证调用方 break/return（命中上限 / 取消）时 shard 读连接一定被关掉。
 *
 * @param decryptedDir - decrypted data root.
 * @param username - 可选：只扫一个 talker（群聊内搜索）。
 * @returns `{ talker, row }`。
 */
function* scanFallbackRows(
  decryptedDir: string,
  username?: string,
): Generator<{ talker: string; row: Record<string, unknown> }, void, void> {
  let budget = 800_000
  const shards = messageShardFiles(decryptedDir)
  const scopeUsernames = username ? [username] : loadSessionUsernames(decryptedDir).slice(0, 800)
  for (const talker of scopeUsernames) {
    if (budget <= 0) return
    const table = msgTableName(talker)
    for (const shard of shards) {
      if (budget <= 0) return
      let sdb: DatabaseSync | null = null
      try { sdb = new DatabaseSync(shard, { readOnly: true }) } catch { continue }
      const has = sdb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table) !== undefined
      if (!has) { sdb.close(); continue }
      try {
        const sql = 'SELECT local_id, create_time, message_content FROM "' + table + '" WHERE local_type=1'
        // 用 iterate() 而不是 all()：all() 会把整张 Msg_ 表先物化成一个数组，
        // 单会话几十万条时峰值直接与消息数同阶；而下面本来就是逐条判断后即丢。
        for (const row of sdb.prepare(sql).iterate() as Iterable<Record<string, unknown>>) {
          budget -= 1
          if (budget <= 0) return
          yield { talker, row }
        }
      } catch {
        // skip unreadable shard
      } finally {
        sdb.close()
      }
    }
  }
}

/**
 * 一行 → 命中（不匹配返回 null）。两个驱动共用，保证匹配与摘要口径只有一份。
 * @param row - 消息表原始行。
 * @param talker - 该行所属会话 username。
 * @param qLower - 已小写的查询词。
 * @param names - username → 显示名。
 * @returns SearchHit 或 null。
 */
export function hitFromRow(
  row: Record<string, unknown>,
  talker: string,
  qLower: string,
  names: Map<string, string>,
): SearchHit | null {
  const text = decodeCell(row['message_content']).replace(/\n/g, ' ').trim()
  if (!text || !text.toLowerCase().includes(qLower)) return null
  const localId = Number(row['local_id'] ?? 0)
  const ts = Number(row['create_time'] ?? 0)
  const { sender, body: display } = splitGroupPrefix(text, talker)
  const dIdx = display.toLowerCase().indexOf(qLower)
  const dStart = Math.max(0, dIdx < 0 ? 0 : dIdx - 20)
  const snippet = (dStart > 0 ? '…' : '') + display.slice(dStart, dStart + 100)
  return {
    text,
    username: talker,
    create_time: ts,
    local_id: localId,
    name: names.get(talker) ?? talker,
    time: formatFullTime(ts),
    snippet,
    sender: senderLabel(sender, names),
  }
}

/**
 * 索引与内置 FTS 两条快路径。都没命中时返回 null —— 由调用方决定要不要走兜底扫描。
 * @param decryptedDir - decrypted data root.
 * @param q - 原始查询词。
 * @param cap - 命中上限。
 * @param names - username → 显示名。
 * @param username - 可选：只搜一个 talker。
 * @returns 命中结果，或 null（两条快路径都没命中）。
 */
export function probeIndexedSources(
  decryptedDir: string,
  q: string,
  cap: number,
  names: Map<string, string>,
  username?: string,
): { hits: SearchHit[]; total: number; indexed: boolean } | null {
  // ---- 自建 BM25 索引优先（bigram 切分 + 真实 IDF + 相关度排序）----
  const indexed = searchIndexBatch(decryptedDir, [q], cap, username ? { username } : undefined)
  if (indexed.ranked && indexed.hits.length > 0) {
    return { hits: indexed.hits, total: indexed.hits.length, indexed: true }
  }
  // ---- WeChat built-in content tables (LIKE, tokenizer-independent) ----
  const builtin = searchWechatFts(decryptedDir, q, cap, names, username)
  if (builtin.hits.length > 0) return { hits: builtin.hits, total: builtin.hits.length, indexed: false }
  return null
}

/**
 * Search text messages: FTS5 index first, bounded full-table scan fallback.
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits.
 * @param username - optional scope: only search one talker (chatroom).
 * @returns hits plus whether the index was used.
 */
export function searchIndexMessages(
  decryptedDir: string,
  query: string,
  limit?: number,
  username?: string,
): { hits: SearchHit[]; total: number; indexed: boolean } {
  const q = (query || '').trim()
  if (!q) return { hits: [], total: 0, indexed: false }
  const cap = Math.min(limit ?? 100, 300)
  const names = loadDisplayNames(decryptedDir)
  const early = probeIndexedSources(decryptedDir, q, cap, names, username)
  if (early) return early
  const hits: SearchHit[] = []
  const qLower = q.toLowerCase()
  for (const { talker, row } of scanFallbackRows(decryptedDir, username)) {
    const hit = hitFromRow(row, talker, qLower, names)
    if (hit) hits.push(hit)
    if (hits.length >= cap) break
  }
  return { hits, total: hits.length, indexed: false }
}

/**
 * 与 {@link searchIndexMessages} 同一条链路，但**可取消**（N9，界面搜索专用）。
 *
 * 两件事一起做才有意义 ——
 *   · 每 {@link ABORT_CHECK_EVERY_ROWS} 行看一眼 `ctrl.signal`，取消即收尾（返回部分结果 + `cancelled`）；
 *   · 每 {@link YIELD_EVERY_MS} 毫秒 `await setImmediate` 让出 —— **这是取消能生效的前提**：
 *     本函数跑在后端 worker 里，不让出的话 worker 根本读不到 `cancelSearch` 那条消息，
 *     令牌永远不会被 aborted（旧实现实测单次 621ms~2.5s、期间 10ms 定时器 0 次触发）。
 *
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits.
 * @param username - optional scope: only search one talker (chatroom).
 * @param ctrl - 可选的取消令牌（见 {@link SearchControl}）。
 * @returns hits plus whether the index was used；被取消时多一个 `cancelled: true`。
 */
export async function searchIndexMessagesCancellable(
  decryptedDir: string,
  query: string,
  limit?: number,
  username?: string,
  ctrl?: SearchControl,
): Promise<{ hits: SearchHit[]; total: number; indexed: boolean; cancelled?: boolean }> {
  const q = (query || '').trim()
  if (!q) return { hits: [], total: 0, indexed: false }
  const cap = Math.min(limit ?? 100, 300)
  const names = loadDisplayNames(decryptedDir)
  const early = probeIndexedSources(decryptedDir, q, cap, names, username)
  if (early) return early
  // 走到兜底扫描前先看一眼：已经被取消就没必要开库了
  if (ctrl?.signal?.aborted) return { hits: [], total: 0, indexed: false, cancelled: true }
  const hits: SearchHit[] = []
  const qLower = q.toLowerCase()
  let rowsSeen = 0
  let lastYieldAt = Date.now()
  let cancelled = false
  for (const { talker, row } of scanFallbackRows(decryptedDir, username)) {
    rowsSeen += 1
    if ((rowsSeen & (ABORT_CHECK_EVERY_ROWS - 1)) === 0) {
      if (ctrl?.signal?.aborted) { cancelled = true; break }
      if (Date.now() - lastYieldAt >= YIELD_EVERY_MS) {
        // 让出：worker 的消息泵要能跑，取消消息才进得来（见函数头注释）
        await new Promise<void>((resolve) => { setImmediate(resolve) })
        lastYieldAt = Date.now()
        if (ctrl?.signal?.aborted) { cancelled = true; break }
      }
    }
    const hit = hitFromRow(row, talker, qLower, names)
    if (hit) hits.push(hit)
    if (hits.length >= cap) break
  }
  return cancelled
    ? { hits, total: hits.length, indexed: false, cancelled: true }
    : { hits, total: hits.length, indexed: false }
}
