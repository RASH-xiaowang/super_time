/**
 * `query/search.ts` 的「查询侧：兜底扫描生成器、命中投影、可取消的搜索入口」部分（M21 拆分）。
 *
 * 从 `search.ts` 原样搬出，**行为逐字节不变**；`search.ts` 继续以 `export *` 转发
 * ⇒ 所有 `from './search.ts'` 的导入一行都不用改。
 *
 * @module search-query
 */

import { DatabaseSync } from './db-open.ts'
import { withDb } from './db-open.ts'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import type { SearchHit } from '../types.ts'
import {
  decodeCell, ftsPhrase, indexReady, loadDisplayNames, loadSessionUsernames,
  messageShardFiles, msgTableName, searchIndexBatch, searchIndexPath,
} from './search-scaffold.ts'

// 这五个「展示形状」的纯函数搬到了 `search-display.ts`（为了断掉 scaffold ↔ query 的环，
// 理由写在那份文件的头里）。这里继续 re-export：`search.ts` 是 `export *` 转发，
// 外面几十个 `from './search.ts'` 的导入因此一行都不用改。
export { readableMessageText, senderLabel, splitGroupPrefix, stripGroupPrefix } from './search-display.ts'
import { readableMessageText, senderLabel, splitGroupPrefix } from './search-display.ts'
import { fmtDateTimeSec } from '../format.ts'
import { contactMeta } from './meta.ts'
import { clampLimit } from './limits.ts'
import {
  displayNameForUsername, isMessageTableHash, messageTableHash, resolveTalkerUsername,
} from './message-identity.ts'

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
  const canonical = resolveTalkerUsername(decryptedDir, username)
  if (!canonical) return []
  const table = msgTableName(canonical)
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
        const { sender, body } = splitGroupPrefix(raw, canonical)
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
  enterpriseNames: ReadonlyMap<string, string> = new Map(),
): { hits: SearchHit[] } {
  const requestedScope = scopeUsername?.trim() ?? ''
  const canonicalScope = requestedScope ? resolveTalkerUsername(decryptedDir, requestedScope) : ''
  if (requestedScope && !canonicalScope) return { hits: [] }
  const p = join(decryptedDir, 'message', 'message_fts.db')
  if (!existsSync(p)) return { hits: [] }
  try {
    return { hits: withDb(p, (db) => {
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
            const storedUsername = sessions.get(Number(r['sid'])) ?? ''
            const username = storedUsername ? resolveTalkerUsername(decryptedDir, storedUsername) : ''
            if (!username) continue
            // 会话范围必须真的过滤（此前兜底路径忽略 scope，选了会话仍混入其他会话）
            if (canonicalScope && username !== canonicalScope) continue
            const text = decodeCell(r['c'])
            const { sender, body: display } = splitGroupPrefix(text, username)
            // sort_seq 是毫秒时间戳：恢复 create_time，时间筛选与显示才可用（此前恒为 0，时间范围会把命中全部滤掉）
            const ssMs = Number(r['ss'] ?? 0)
            const createTime = ssMs > 1e12 ? Math.floor(ssMs / 1e3) : ssMs > 1e9 ? Math.floor(ssMs) : 0
            const enterpriseName = enterpriseNames.get(username)?.trim()
            const senderEnterpriseName = enterpriseNames.get(sender)?.trim()
            out.push({
              text,
              username,
              create_time: createTime,
              local_id: Number(r['lid'] ?? 0),
              name: displayNameForUsername(username, names),
              ...(enterpriseName ? { enterpriseName } : {}),
              time: createTime ? fmtDateTimeSec(createTime) : '',
              snippet: display.slice(0, 120),
              sender: senderLabel(sender, names),
              ...(sender !== '' ? { sender_username: sender } : {}),
              ...(senderEnterpriseName ? { senderEnterpriseName } : {}),
            })
            if (out.length >= cap) break
          }
        } catch { /* shard unavailable */ }
        if (out.length >= cap) break
      }
      return out
    }) }
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
 * @param range - 可选时间范围（epoch 秒）。**下推到分片 SQL**：日期过滤若只在取回后做，
 *   大表会把扫描预算耗在范围外的行上，甚至一个范围内的结果都扫不到。
 * @returns `{ talker, row }`。
 */
function* scanFallbackRows(
  decryptedDir: string,
  username?: string,
  range?: { lo?: number; hi?: number },
): Generator<{ talker: string; row: Record<string, unknown> }, void, void> {
  let budget = 800_000
  const lo = range?.lo ?? 0
  const hi = range?.hi ?? 0
  const timeConds: string[] = []
  const timeArgs: number[] = []
  if (lo > 0) { timeConds.push('create_time >= ?'); timeArgs.push(lo) }
  if (hi > 0) { timeConds.push('create_time <= ?'); timeArgs.push(hi) }
  const shards = messageShardFiles(decryptedDir)
  const requestedScope = username?.trim() ?? ''
  const canonicalScope = requestedScope ? resolveTalkerUsername(decryptedDir, requestedScope) : ''
  if (requestedScope && !canonicalScope) return
  const scopeUsernames = canonicalScope ? [canonicalScope] : loadSessionUsernames(decryptedDir).slice(0, 800)
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
          + (timeConds.length > 0 ? ' AND ' + timeConds.join(' AND ') : '')
        // 用 iterate() 而不是 all()：all() 会把整张 Msg_ 表先物化成一个数组，
        // 单会话几十万条时峰值直接与消息数同阶；而下面本来就是逐条判断后即丢。
        for (const row of sdb.prepare(sql).iterate(...timeArgs) as Iterable<Record<string, unknown>>) {
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
  /** 会话微信 ID —— 同一个概念的正名见 `WechatSession.username`（P3-6：问答链沿用库里更早的列名）。 */
  talker: string,
  qLower: string,
  names: Map<string, string>,
  enterpriseNames: ReadonlyMap<string, string> = new Map(),
): SearchHit | null {
  const raw = decodeCell(row['message_content']).trim()
  if (!raw) return null
  // 群前缀必须以原始换行 `wxid:\n正文` 识别；先压平换行会把 sender 永久吞掉。
  const { sender, body } = splitGroupPrefix(raw, talker)
  const text = raw.replace(/\n/g, ' ').trim()
  const display = body.replace(/\n/g, ' ').trim()
  if (!text || !text.toLowerCase().includes(qLower)) return null
  const localId = Number(row['local_id'] ?? 0)
  const ts = Number(row['create_time'] ?? 0)
  const dIdx = display.toLowerCase().indexOf(qLower)
  const dStart = Math.max(0, dIdx < 0 ? 0 : dIdx - 20)
  const snippet = (dStart > 0 ? '…' : '') + display.slice(dStart, dStart + 100)
  const enterpriseName = enterpriseNames.get(talker)?.trim()
  const senderEnterpriseName = enterpriseNames.get(sender)?.trim()
  return {
    text,
    username: talker,
    create_time: ts,
    local_id: localId,
    name: displayNameForUsername(talker, names),
    ...(enterpriseName ? { enterpriseName } : {}),
    time: fmtDateTimeSec(ts),
    snippet,
    sender: senderLabel(sender, names),
    ...(sender !== '' ? { sender_username: sender } : {}),
    ...(senderEnterpriseName ? { senderEnterpriseName } : {}),
  }
}

/**
 * 索引与内置 FTS 两条快路径。都没命中时返回 null —— 由调用方决定要不要走兜底扫描。
 * @param decryptedDir - decrypted data root.
 * @param q - 原始查询词。
 * @param cap - 命中上限。
 * @param names - username → 显示名。
 * @param username - 可选：只搜一个 talker。
 * @param person - 可选：发送者线索（转发给索引的 `who:` 召回分支；严格过滤在工具边界做）。
 * @returns 命中结果，或 null（两条快路径都没命中）。
 */
export function probeIndexedSources(
  decryptedDir: string,
  q: string,
  cap: number,
  names: Map<string, string>,
  username?: string,
  person?: string,
): { hits: SearchHit[]; total: number; indexed: boolean } | null {
  const requestedScope = username?.trim() ?? ''
  const canonicalScope = requestedScope ? resolveTalkerUsername(decryptedDir, requestedScope) : ''
  if (requestedScope && !canonicalScope) return null
  // ---- 自建 BM25 索引优先（bigram 切分 + 真实 IDF + 相关度排序）----
  const batchOpts = canonicalScope || person
    ? {
      ...(canonicalScope ? { username: canonicalScope } : {}),
      ...(person ? { person } : {}),
    }
    : undefined
  const indexed = searchIndexBatch(decryptedDir, [q], cap, batchOpts)
  if (indexed.ranked && indexed.hits.length > 0) {
    return { hits: indexed.hits, total: indexed.hits.length, indexed: true }
  }
  // ---- WeChat built-in content tables (LIKE, tokenizer-independent) ----
  const builtin = searchWechatFts(
    decryptedDir, q, cap, names, canonicalScope || undefined, contactMeta(decryptedDir).enterpriseNames,
  )
  if (builtin.hits.length > 0) return { hits: builtin.hits, total: builtin.hits.length, indexed: false }
  return null
}

/**
 * 带时间范围的索引检索（把日期条件下推到 FTS JOIN 的 SQL 里）。
 *
 * 为什么不复用 `searchIndexBatch`：它的签名被流水线共用，本轮对 scaffold 的改动
 * 只允许「person 透传」这一处。而日期过滤若仍走「先取 top-N 再在内存里筛」，
 * 命中词高频时（例如「转账」全库上万条）top-N 可能全部落在范围外 ——
 * 范围内的真实结果会被误判成 0。这里把 `create_time` 直接放进 WHERE，
 * 由 SQLite 先约束行集再取 limit。
 *
 * 投影逻辑必须与 `searchIndexBatch` 保持一致（sender 原始 wxid → 显示名等），
 * 否则同一句查询在「带日期/不带日期」两条路径下会返回不同的形状。
 */
function searchIndexInRange(
  decryptedDir: string,
  terms: string[],
  limit: number,
  opts: { username?: string; person?: string; lo?: number; hi?: number },
): { hits: SearchHit[]; ranked: boolean } {
  if (!indexReady(decryptedDir)) return { hits: [], ranked: false }
  const requestedScope = opts.username?.trim() ?? ''
  const scopedUsername = requestedScope ? resolveTalkerUsername(decryptedDir, requestedScope) : ''
  if (requestedScope && !scopedUsername) return { hits: [], ranked: false }
  const parts = terms.map(ftsPhrase).filter(Boolean)
  // `person` 与 `searchIndexBatch` 同一口径：追加 `who:` 召回分支（OR），
  // 严格发送者过滤由工具层按 message_meta.sender 再做一次。
  if (opts.person) {
    const who = ftsPhrase(opts.person)
    if (who) parts.push('who:' + who)
  }
  if (parts.length === 0) return { hits: [], ranked: false }
  const match = parts.join(' OR ')
  try {
    return withDb(searchIndexPath(decryptedDir), (db) => {
      const scopeAliases = scopedUsername
        ? [...new Set([
          requestedScope,
          scopedUsername,
          messageTableHash(scopedUsername),
          msgTableName(scopedUsername),
        ])]
        : []
      const where: string[] = ['message_fts MATCH ?']
      const args: Array<string | number> = [match]
      if (scopeAliases.length > 0) {
        where.push(`m.username IN (${scopeAliases.map(() => '?').join(', ')})`)
        args.push(...scopeAliases)
      }
      if ((opts.lo ?? 0) > 0) { where.push('m.create_time >= ?'); args.push(opts.lo as number) }
      if ((opts.hi ?? 0) > 0) { where.push('m.create_time <= ?'); args.push(opts.hi as number) }
      args.push(limit)
      const rows = db.prepare(
        'SELECT m.text, m.username, m.create_time, m.local_id, m.sender, bm25(message_fts) AS score'
        + ' FROM message_fts JOIN message_meta m ON m.rowid = message_fts.rowid'
        + ' WHERE ' + where.join(' AND ')
        + ' ORDER BY rank LIMIT ?',
      ).all(...args) as Array<Record<string, unknown>>
      const names = loadDisplayNames(decryptedDir)
      const enterpriseNames = contactMeta(decryptedDir).enterpriseNames
      const hits: SearchHit[] = []
      for (const r of rows) {
        const text = decodeCell(r['text'])
        const storedUsername = decodeCell(r['username'])
        const username = resolveTalkerUsername(decryptedDir, storedUsername)
        // 与 `searchIndexBatch` 一致：无主的 hash 是索引残留，不是可点开的会话。
        if (!username || isMessageTableHash(username)) continue
        const createTime = Number(r['create_time'] ?? 0)
        const sender = decodeCell(r['sender'])
        hits.push({
          text,
          username,
          create_time: createTime,
          local_id: Number(r['local_id'] ?? 0),
          name: displayNameForUsername(username, names),
          ...(enterpriseNames.get(username) ? { enterpriseName: enterpriseNames.get(username) } : {}),
          time: fmtDateTimeSec(createTime),
          snippet: text.slice(0, 120),
          sender: senderLabel(sender, names),
          ...(sender !== '' ? { sender_username: sender } : {}),
          ...(sender !== '' && enterpriseNames.get(sender)
            ? { senderEnterpriseName: enterpriseNames.get(sender) }
            : {}),
          score: -Number(r['score'] ?? 0),
        })
      }
      return { hits, ranked: true }
    })
  } catch {
    return { hits: [], ranked: false }
  }
}

/**
 * Search text messages: FTS5 index first, bounded full-table scan fallback.
 * @param decryptedDir - decrypted data root.
 * @param query - search term.
 * @param limit - max hits.
 * @param username - optional scope: only search one talker (chatroom).
 * @param person - optional sender hint: forwarded to the index `who:` branch.
 * @param range - optional epoch-second window; pushed into SQL so a high-frequency
 *   term cannot crowd out the in-range rows before filtering.
 * @returns hits plus whether the index was used.
 */
export function searchIndexMessages(
  decryptedDir: string,
  query: string,
  limit?: number,
  username?: string,
  person?: string,
  range?: { lo?: number; hi?: number },
): { hits: SearchHit[]; total: number; indexed: boolean } {
  const q = (query || '').trim()
  if (!q) return { hits: [], total: 0, indexed: false }
  // 上限从 300 放宽到 1000：工具侧 limit 最大 100，而日期/交集/时间倒序需要
  // 约 10 倍候选池；仍保留硬上限避免调用方传入巨大值把整库物化。
  // 负值在 SQLite 里等价于「不限制」，NaN/小数会抛错 —— 统一走 clampLimit。
  const cap = clampLimit(limit, 100, 1000)
  const requestedScope = username?.trim() ?? ''
  const canonicalScope = requestedScope ? resolveTalkerUsername(decryptedDir, requestedScope) : ''
  if (requestedScope && !canonicalScope) return { hits: [], total: 0, indexed: false }
  const names = loadDisplayNames(decryptedDir)
  const enterpriseNames = contactMeta(decryptedDir).enterpriseNames
  const lo = range?.lo ?? 0
  const hi = range?.hi ?? 0

  // ---- 带日期：索引 SQL 先下推时间条件 ----
  if (lo > 0 || hi > 0) {
    const ranged = searchIndexInRange(decryptedDir, [q], cap, {
      ...(canonicalScope ? { username: canonicalScope } : {}),
      ...(person ? { person } : {}),
      ...(lo > 0 ? { lo } : {}),
      ...(hi > 0 ? { hi } : {}),
    })
    if (ranged.ranked && ranged.hits.length > 0) {
      return { hits: ranged.hits, total: ranged.hits.length, indexed: true }
    }
    // 索引在范围内 0 条或未就绪：仍给内置 FTS / 兜底扫描一次机会
    // （索引可能落后于消息分片，不能因为索引没建完就断定「没有结果」）。
    const inRange = (h: SearchHit): boolean =>
      h.create_time > 0 && (lo === 0 || h.create_time >= lo) && (hi === 0 || h.create_time <= hi)
    // 内置 FTS 的 LIKE 结果先按更大的池取回再筛，同样避免范围外命中挤掉范围内命中。
    const builtin = searchWechatFts(
      decryptedDir, q, Math.min(cap * 10, 2000), names,
      canonicalScope || undefined, enterpriseNames,
    )
    const builtinHits = builtin.hits.filter(inRange)
    if (builtinHits.length > 0) {
      const hits = builtinHits.slice(0, cap)
      return { hits, total: hits.length, indexed: false }
    }
    const hits: SearchHit[] = []
    const qLower = q.toLowerCase()
    for (const { talker, row } of scanFallbackRows(decryptedDir, canonicalScope || undefined, { lo, hi })) {
      const hit = hitFromRow(row, talker, qLower, names, enterpriseNames)
      if (hit) hits.push(hit)
      if (hits.length >= cap) break
    }
    return { hits, total: hits.length, indexed: false }
  }

  const early = probeIndexedSources(decryptedDir, q, cap, names, canonicalScope || undefined, person)
  if (early) return early
  const hits: SearchHit[] = []
  const qLower = q.toLowerCase()
  for (const { talker, row } of scanFallbackRows(decryptedDir, canonicalScope || undefined)) {
    const hit = hitFromRow(row, talker, qLower, names, enterpriseNames)
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
  // 索引快路径是同步的：一进函数就检查，避免预取消仍加载元数据并返回命中。
  if (ctrl?.signal?.aborted) {
    return { hits: [], total: 0, indexed: false, cancelled: true }
  }
  const q = (query || '').trim()
  if (!q) return { hits: [], total: 0, indexed: false }
  // 可取消入口是界面交互路径，候选池上限更小（300）；同样必须先夹紧再使用。
  const cap = clampLimit(limit, 100, 300)
  const requestedScope = username?.trim() ?? ''
  const canonicalScope = requestedScope ? resolveTalkerUsername(decryptedDir, requestedScope) : ''
  if (requestedScope && !canonicalScope) {
    return { hits: [], total: 0, indexed: false, ...(ctrl?.signal?.aborted ? { cancelled: true } : {}) }
  }
  const names = loadDisplayNames(decryptedDir)
  const enterpriseNames = contactMeta(decryptedDir).enterpriseNames
  const early = probeIndexedSources(decryptedDir, q, cap, names, canonicalScope || undefined)
  if (early) {
    // 探针本身无法被同步 AbortSignal 抢占；返回前必须复检，命中绝不能绕过取消标记。
    return ctrl?.signal?.aborted ? { ...early, cancelled: true } : early
  }
  // 走到兜底扫描前先看一眼：已经被取消就没必要开库了
  if (ctrl?.signal?.aborted) return { hits: [], total: 0, indexed: false, cancelled: true }
  const hits: SearchHit[] = []
  const qLower = q.toLowerCase()
  let rowsSeen = 0
  let lastYieldAt = Date.now()
  let cancelled = false
  for (const { talker, row } of scanFallbackRows(decryptedDir, canonicalScope || undefined)) {
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
    const hit = hitFromRow(row, talker, qLower, names, enterpriseNames)
    if (hit) hits.push(hit)
    if (hits.length >= cap) break
  }
  return cancelled
    ? { hits, total: hits.length, indexed: false, cancelled: true }
    : { hits, total: hits.length, indexed: false }
}
