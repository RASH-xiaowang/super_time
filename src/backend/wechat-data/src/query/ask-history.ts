/**
 * 问答历史：把每一次「微信问答」的**完整记录**（问题 / 回答 / 引用 / 检索元信息）
 * 落库，供「微信问答」面板的「历史记录」按钮查看。
 *
 * ── 为什么复用 `wechat_privacy.db` ─────────────────────────────
 * 与 `operation-log.ts`、`export-history.ts` 同一个库（`<数据根>/wechat_privacy.db`）。
 * 三者都是「本机元数据」且都按数据根隔离；再开一个库只会多一份文件与一套建表/清理逻辑。
 *
 * ── 与另两张表的分工 ──────────────────────────────────────────
 *   · `operation_log` 是**审计**：谁在何时做了什么，只留脱敏元数据，便于导出给人看；
 *   · `export_history` 是**可操作**：绝对路径 + 重跑参数，用户据此打开/重新导出；
 *   · 本表是**内容**：必须记住回答正文与引用，否则「历史记录」打开只是一串时间戳，
 *     既解释不了「当时问了什么」，也无法据此回到原文。
 *
 * 代价要说清：本表**比审计表敏感得多**（回答正文 + 本机会话名）。因此它的边界是硬的：
 *   · 只落本机、只按数据根隔离，**不参与任何导出/分享路径**（读接口也不出网）；
 *   · 用户可以逐条删除，也可以整体清空（`deleteAskHistory` / `clearAskHistory`）；
 *   · 不做「自动清理」—— 静默丢掉用户的问答历史，比库慢慢变大糟得多。
 *
 * 写入一律 **best-effort**：记录失败绝不能影响问答本身（与 `recordOperation` 同口径）。
 */
import { DatabaseSync } from 'node:sqlite'
import { dirname, join } from 'node:path'
import type {
  AskCitation,
  AskHistoryClearResult,
  AskHistoryDeleteResult,
  AskHistoryEntry,
  AskHistoryQuery,
  AskHistorySnapshot,
  AskHistoryStatus,
} from '../types.ts'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 500
const STATUSES: readonly AskHistoryStatus[] = ['ok', 'insufficient', 'withheld', 'fail']
const ALLOWED_STATUS = new Set<string>(STATUSES)
/** 排序列白名单 —— 直接拼进 SQL，必须白名单化（不参数化标识符）。 */
const SORT_COLUMNS: Record<string, string> = { ts: 'ts', question: 'question' }

/**
 * 单条记录的字段上限。
 *
 * 为什么要有上限：这是唯一一张存**正文**的表，而正文字段来自模型（可能异常长）。
 * 上限不是「省空间」，而是防住「一行把库撑爆」这类病态输入 ——
 * 正常问答（问句 < 200 字、回答 < 1600 token、引用 ≤ 24 条）离上限都有数倍余量。
 */
const MAX_QUESTION = 2_000
const MAX_ANSWER = 20_000
const MAX_CITATIONS = 60
const MAX_TERMS = 40

function dbPath(decryptedDir: string): string {
  return join(dirname(decryptedDir), 'wechat_privacy.db')
}

function openStore(decryptedDir: string): DatabaseSync {
  const db = new DatabaseSync(dbPath(decryptedDir))
  db.exec(`CREATE TABLE IF NOT EXISTS ask_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    source TEXT NOT NULL,
    username TEXT,
    username_name TEXT,
    from_day TEXT,
    to_day TEXT,
    model TEXT,
    intent TEXT,
    terms TEXT,
    citations TEXT,
    cited_indexes TEXT,
    basis TEXT,
    status TEXT NOT NULL,
    error TEXT,
    retrieval TEXT,
    elapsed_ms INTEGER
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS ask_history_ts ON ask_history(ts)')
  return db
}

/** 收敛缺失/占位文本（与 export-history 同口径，避免界面上出现字面量 "undefined"）。 */
function cleanText(v: unknown): string {
  if (typeof v !== 'string') return ''
  const t = v.trim()
  return t === 'undefined' || t === 'null' ? '' : t
}

/** 按上限截断（只在真的超限时才动，正常内容逐字保存）。 */
function clip(v: unknown, max: number): string {
  const t = typeof v === 'string' ? v : ''
  return t.length > max ? t.slice(0, max) : t
}

/** JSON 序列化，失败时退回空串（元信息坏掉不该让整条记录写不进去）。 */
function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v)
    return typeof s === 'string' ? s : ''
  } catch {
    return ''
  }
}

/** JSON 反序列化：坏数据一律退回给定的兜底值（读取路径绝不抛）。 */
function parseJson<T>(raw: unknown, fallback: T): T {
  const s = cleanText(raw)
  if (!s) return fallback
  try {
    return JSON.parse(s) as T
  } catch {
    return fallback
  }
}

/** 一条问答记录写入的入参：调用方只需给「已经发生的事实」。 */
export interface RecordAskInput {
  question: string
  answer: string
  /** 入口来源：`ask`（微信问答页签）/ `session`（会话内问答）/ 其它自定义值。 */
  source?: string
  /** 会话范围（空 = 全部会话）。 */
  username?: string
  /** 会话显示名（便于列表直读，避免历史行只显示 wxid）。 */
  usernameName?: string
  /** 时间范围（YYYY-MM-DD）。 */
  from?: string
  to?: string
  /** 回答模型（provider · model），与面板底部「片段发给谁」同一口径。 */
  model?: string
  /** 规划器意图。 */
  intent?: string
  /** 实际参与检索的词项。 */
  terms?: readonly string[]
  /** 引用来源（原样存 JSON，读取时解析回对象）。 */
  citations?: readonly AskCitation[]
  /** 回答正文里真正引用到的序号（1 基）。 */
  citedIndexes?: readonly number[]
  /** 数据来源说明（由检索结果算出，非模型生成）。 */
  basis?: string
  /** 本轮没有检索到任何原文（未调模型）。 */
  insufficient?: boolean
  /** 模型内容无法对应到任何原文，已不予采用。 */
  withheld?: boolean
  /** 失败原因（有值时 status 记为 fail）。 */
  error?: string
  /** 多阶段检索统计（结构化存 JSON）。 */
  retrieval?: unknown
  /** 端到端耗时（毫秒）；缺省时由调用方决定是否传。 */
  elapsedMs?: number
  ts?: number
}

/**
 * 记录一次问答。best-effort：失败只留痕，绝不抛给调用方 ——
 * 存历史失败绝不能把已经生成好的回答变成一次报错。
 * @param decryptedDir - 解密数据根（历史库位于其父目录）。
 * @param input - 本次问答的事实。
 * @returns 新记录 id；写入失败（或问题/回答都为空）返回 null。
 */
export function recordAsk(decryptedDir: string, input: RecordAskInput): number | null {
  try {
    const question = clip(input.question, MAX_QUESTION).trim()
    const answer = clip(input.answer, MAX_ANSWER)
    // 问题与回答都空的记录没有任何可看内容，不落库（避免攒一堆空行）。
    if (!question && !answer.trim()) return null
    const status: AskHistoryStatus = cleanText(input.error)
      ? 'fail'
      : (input.withheld ? 'withheld' : (input.insufficient ? 'insufficient' : 'ok'))
    const citations = (Array.isArray(input.citations) ? input.citations : []).slice(0, MAX_CITATIONS)
    const terms = (Array.isArray(input.terms) ? input.terms : [])
      .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      .slice(0, MAX_TERMS)
    const db = openStore(decryptedDir)
    try {
      const info = db.prepare(`INSERT INTO ask_history
        (ts, question, answer, source, username, username_name, from_day, to_day, model,
         intent, terms, citations, cited_indexes, basis, status, error, retrieval, elapsed_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.ts ?? Date.now(),
          question,
          answer,
          cleanText(input.source) || 'ask',
          cleanText(input.username),
          cleanText(input.usernameName),
          cleanText(input.from),
          cleanText(input.to),
          cleanText(input.model),
          cleanText(input.intent),
          safeJson(terms),
          safeJson(citations),
          safeJson((Array.isArray(input.citedIndexes) ? input.citedIndexes : []).filter(n => Number.isFinite(n))),
          cleanText(input.basis),
          status,
          cleanText(input.error),
          input.retrieval === undefined ? '' : safeJson(input.retrieval),
          Number.isFinite(input.elapsedMs) ? Math.round(Number(input.elapsedMs)) : 0,
        )
      return Number(info.lastInsertRowid ?? 0) || null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/** 把一个查询条件翻译成 WHERE 子句与参数。 */
function buildWhere(query: AskHistoryQuery): { sql: string; params: Array<string | number> } {
  const clauses: string[] = []
  const params: Array<string | number> = []
  const sources = (query.sources ?? []).filter(s => typeof s === 'string' && s.trim() !== '')
  if (sources.length > 0) {
    clauses.push('source IN (' + sources.map(() => '?').join(', ') + ')')
    params.push(...sources)
  }
  if (query.status && ALLOWED_STATUS.has(query.status)) {
    clauses.push('status = ?')
    params.push(query.status)
  }
  if (typeof query.from === 'number' && Number.isFinite(query.from)) {
    clauses.push('ts >= ?')
    params.push(query.from)
  }
  if (typeof query.to === 'number' && Number.isFinite(query.to)) {
    clauses.push('ts <= ?')
    params.push(query.to)
  }
  const q = cleanText(query.q)
  if (q) {
    // 搜索面：问题 / 回答 / 会话名 / 检索词 / 意图。用 LIKE + 转义，避免 % 与 _ 被当成通配符
    // （用户搜 "2026_09" 时下划线不该变成「任意一个字符」）。
    const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%'
    clauses.push(
      "(question LIKE ? ESCAPE '\\' OR answer LIKE ? ESCAPE '\\' OR username_name LIKE ? ESCAPE '\\'"
      + " OR username LIKE ? ESCAPE '\\' OR terms LIKE ? ESCAPE '\\' OR intent LIKE ? ESCAPE '\\')",
    )
    params.push(like, like, like, like, like, like)
  }
  return { sql: clauses.length > 0 ? ' WHERE ' + clauses.join(' AND ') : '', params }
}

/** 行 → 条目。 */
function rowToEntry(r: Record<string, unknown>): AskHistoryEntry {
  return {
    id: Number(r['id'] ?? 0),
    ts: Number(r['ts'] ?? 0),
    question: cleanText(r['question']),
    answer: cleanText(r['answer']),
    source: cleanText(r['source']) || 'ask',
    username: cleanText(r['username']),
    usernameName: cleanText(r['username_name']),
    from: cleanText(r['from_day']),
    to: cleanText(r['to_day']),
    model: cleanText(r['model']),
    intent: cleanText(r['intent']),
    terms: parseJson<string[]>(r['terms'], []).filter((t): t is string => typeof t === 'string'),
    citations: parseJson<AskCitation[]>(r['citations'], []).filter(c => c !== null && typeof c === 'object'),
    citedIndexes: parseJson<number[]>(r['cited_indexes'], []).filter(n => Number.isFinite(n)),
    basis: cleanText(r['basis']),
    status: (ALLOWED_STATUS.has(cleanText(r['status'])) ? cleanText(r['status']) : 'ok') as AskHistoryStatus,
    error: cleanText(r['error']),
    retrieval: parseJson<Record<string, unknown> | null>(r['retrieval'], null),
    elapsedMs: Number(r['elapsed_ms'] ?? 0),
  }
}

/**
 * 读取问答历史。
 * @param decryptedDir - 解密数据根。
 * @param query - 搜索/筛选/排序/分页条件。
 * @returns 一页条目 + 命中总数 + 各聚合计数（计数按**未分页**的命中集合算）。
 */
export function listAskHistory(decryptedDir: string, query: AskHistoryQuery = {}): AskHistorySnapshot {
  const empty: AskHistorySnapshot = { items: [], total: 0, statusCounts: {}, sourceCounts: {} }
  const { sql: where, params } = buildWhere(query)
  const limitRaw = Number(query.limit)
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), MAX_LIMIT) : DEFAULT_LIMIT
  const offsetRaw = Number(query.offset)
  const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0
  const col = SORT_COLUMNS[String(query.sort ?? 'ts')] ?? 'ts'
  const dir = query.order === 'asc' ? 'ASC' : 'DESC'
  try {
    const db = openStore(decryptedDir)
    try {
      const rows = db.prepare(
        `SELECT id, ts, question, answer, source, username, username_name, from_day, to_day, model,
                intent, terms, citations, cited_indexes, basis, status, error, retrieval, elapsed_ms
         FROM ask_history${where} ORDER BY ${col} ${dir}, id DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as Array<Record<string, unknown>>
      const total = Number((db.prepare(`SELECT COUNT(*) AS c FROM ask_history${where}`).get(...params) as { c?: number } | undefined)?.c ?? 0)
      // 聚合计数按未分页的命中集合算，否则页签数字会随翻页变化。
      const statusRows = db.prepare(`SELECT status, COUNT(*) AS c FROM ask_history${where} GROUP BY status`).all(...params) as Array<{ status: string; c: number }>
      const sourceRows = db.prepare(`SELECT source, COUNT(*) AS c FROM ask_history${where} GROUP BY source`).all(...params) as Array<{ source: string; c: number }>
      const statusCounts: Record<string, number> = {}
      for (const r of statusRows) statusCounts[cleanText(r.status)] = Number(r.c ?? 0)
      const sourceCounts: Record<string, number> = {}
      for (const r of sourceRows) sourceCounts[cleanText(r.source)] = Number(r.c ?? 0)
      return { items: rows.map(rowToEntry), total, statusCounts, sourceCounts }
    } finally {
      db.close()
    }
  } catch {
    return empty
  }
}

/**
 * 删除若干条问答历史。
 * @param decryptedDir - 解密数据根。
 * @param ids - 要删除的记录 id。
 * @returns 实际删除条数。
 */
export function deleteAskHistory(decryptedDir: string, ids: readonly number[]): AskHistoryDeleteResult {
  const result: AskHistoryDeleteResult = { removed: 0 }
  const wanted = ids.map(Number).filter(n => Number.isFinite(n) && n > 0)
  if (wanted.length === 0) return result
  try {
    const db = openStore(decryptedDir)
    try {
      const info = db.prepare(`DELETE FROM ask_history WHERE id IN (${wanted.map(() => '?').join(', ')})`).run(...wanted)
      result.removed = Number(info.changes ?? 0)
      return result
    } finally {
      db.close()
    }
  } catch {
    return result
  }
}

/**
 * 清空全部问答历史。
 *
 * 只由界面上的**显式**入口调用（「清空全部」+ 二次确认）；不做任何自动触发，
 * 也不提供「传空对象就顺手清一遍」的定时策略 —— 静默丢掉历史比库变大糟得多。
 * @param decryptedDir - 解密数据根。
 * @returns 实际删除条数。
 */
export function clearAskHistory(decryptedDir: string): AskHistoryClearResult {
  const result: AskHistoryClearResult = { removed: 0 }
  try {
    const db = openStore(decryptedDir)
    try {
      // 先数再删：DELETE 的 changes 在部分路径上会被依赖项影响，显式计数更可靠。
      const before = Number((db.prepare('SELECT COUNT(*) AS c FROM ask_history').get() as { c?: number } | undefined)?.c ?? 0)
      db.exec('DELETE FROM ask_history')
      result.removed = before
      return result
    } finally {
      db.close()
    }
  } catch {
    return result
  }
}

/** 保留以 `_` 结尾的导出形态，便于单测直接断言表名与列集合（见 tests/ask-history.spec.ts）。 */
export const ASK_HISTORY_DB_FILE = 'wechat_privacy.db'
