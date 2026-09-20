/**
 * 知识库「文件」的关键词检索 —— FTS5 稀疏通道（计划 T3，第一个检索闭环）。
 *
 * ── 为什么单独一个文件，而不是塞进 `kb-files.ts` ────────────────────────
 *   · `kb/**`（`chunk.ts` / `parse-plain.ts`）的约定是**零依赖纯函数**，
 *     而检索要开库、要碰盘，放进去就把那条约定破掉了；
 *   · `kb-files.ts` 是**写路径**（登记 / 删除 / 恢复），检索是**读路径**，
 *     且它是唯一需要「把两个域 join 起来」的地方（chunks × files × fts）。
 *   放在 `query/` 下与两者平级的第三个文件，依赖方向单向：
 *   `kb-search.ts → kb-files.ts`（复用 `openStore`）与 `→ search.ts`（复用短语编法）。
 *   反向没有引用 ⇒ 没有环，也没有「检索改动拖垮写路径」的耦合。
 *
 * ── 作用域（本文件唯一的硬不变量）──────────────────────────────────────
 *   **每一处查询都必须带库过滤**，且**只允许有一处**。
 *   只写一处不是省事，是为了让「漏掉过滤」这件事**可被变异测试咬到**：
 *   若在 `JOIN kb_files` 上也补一句 `f.kb_id = ?`，删掉 `c.kb_id = ?` 时结果依然正确，
 *   那条护栏就再也测不出问题了 —— 而它真正失效的场合（未来某次重构）没人会发现。
 *
 * ── 降级：T3 阶段恒为「仅关键词」────────────────────────────────────────
 *   向量库在 T4 才落地，所以此刻**每一次检索都是降级态**。这里不假装有稠密通道，
 *   而是把「为什么只有关键词」如实回报给界面（设计稿 §6.3：降级必须被看见）。
 *   等 T4 接上稠密通道，只需往 `channels` 里加一员，形状不动。
 */
import { DatabaseSync } from 'node:sqlite'
import type { KbHit, KbSearchResult, KbSearchStats } from '../types.ts'
import { openStore } from './kb-files.ts'
import { ftsPhrase } from './search.ts'

/**
 * 一次检索默认返回多少条。
 *
 * 20 而不是消息检索的 400：知识库的单元是**文件块**（一块最长 500 字），
 * 20 条已经铺满一屏可读内容；再多用户也不会逐条读，只会让一次 RPC 变慢。
 */
export const DEFAULT_KB_TOP_K = 20

/** 单次检索的条数上限（防止调用方传一个把界面拖死的数）。 */
export const MAX_KB_TOP_K = 100

/** 摘要窗口：命中词前后各多少字符（设计稿 §8.4）。 */
export const KB_SNIPPET_RADIUS = 60

/** 检索入参。 */
export interface KbSearchOptions {
  /** 用户输入（可为多词，空格分隔）。 */
  query?: string
  /** 最多返回多少条；不给按 `DEFAULT_KB_TOP_K`。 */
  topK?: number
  /**
   * 只搜「允许参与 RAG」的文件（`kb_files.include_in_rag = 1`）。
   *
   * 问答路径**必须**传 true：文件级开关是用户对「我的这份文件能不能被送进模型」
   * 的显式表态，问答把它的正文写进 prompt 就等于把开关绕过去了。
   * 面板检索保持缺省（false）—— 那是用户在自己本机看自己的文件，不受该开关约束。
   */
  onlyRag?: boolean
}

/**
 * 把用户输入切成若干检索词。
 *
 * 按空白切分：中文整句（没有空格）会成为一个词，交由 `ftsPhrase` 编成**连续短语**
 * —— 这正是「输入夹具里那句独有短语」能精确命中的原因（探针第 6 步）。
 * 多个词则各自成短语、彼此 `OR`。
 */
function splitTerms(query: string): string[] {
  return query.split(/\s+/).map((s) => s.trim()).filter((s) => s !== '')
}

/**
 * 摘要与高亮区间。
 *
 * 高亮**必须自己算**，不能用 FTS5 的 `snippet()`：那张索引里存的是
 * `bigramTokens` 切出的 **tokens 串**（`微信 信转 转账`），不是原文。
 * `snippet(kb_chunks_fts, ...)` 会在 tokens 串上标记，产出的「原文」是
 * `[转账] 账收 收到` 这种东西 —— 看起来像分词结果，不是用户要的那句话。
 * 原文在 `kb_chunks.text` 里，所以定位也在那里做。
 * @param text - 块正文。
 * @param terms - 检索词（原始词，不是 bigram）。
 * @param radius - 命中词前后各保留多少字符。
 * @returns 摘要文本 + **相对摘要**的高亮区间（前端只渲染，不做二次匹配）。
 */
function buildSnippet(text: string, terms: readonly string[], radius = KB_SNIPPET_RADIUS): { snippet: string; marks: Array<{ start: number; end: number }> } {
  // 命中位置用不区分大小写的副本找；拉丁词大小写不该影响「命中了哪一段」。
  const lower = text.toLowerCase()
  const found: Array<{ start: number; end: number }> = []
  for (const term of terms) {
    const needle = term.toLowerCase()
    if (needle === '') continue
    let from = 0
    for (;;) {
      const at = lower.indexOf(needle, from)
      if (at < 0) break
      found.push({ start: at, end: at + needle.length })
      from = at + 1
    }
  }
  found.sort((a, b) => a.start - b.start)

  const head = found[0]
  // 一个都没找到：可能是**只命中了 heading**（标题不在块正文里），或词被归一化吃掉了。
  // 此时退回「块的开头一段」而不是给空串 —— 空摘要在界面上和「没有内容」长得一样。
  if (head === undefined) {
    const slice = text.slice(0, radius * 2)
    return { snippet: slice === text ? slice : slice + '…', marks: [] }
  }

  const winStart = Math.max(0, head.start - radius)
  const winEnd = Math.min(text.length, head.start + (head.end - head.start) + radius)
  const prefix = winStart > 0 ? '…' : ''
  const suffix = winEnd < text.length ? '…' : ''
  const body = text.slice(winStart, winEnd)
  const marks = found
    .filter((m) => m.start >= winStart && m.end <= winEnd)
    .map((m) => ({ start: prefix.length + (m.start - winStart), end: prefix.length + (m.end - winStart) }))
  return { snippet: prefix + body + suffix, marks }
}

/** 收敛 topK：非有限值 / <=0 一律回落到默认；超过上限则夹住。 */
function normalizeTopK(value: unknown): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_KB_TOP_K
  return Math.min(n, MAX_KB_TOP_K)
}

function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

function cellStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return ''
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint' || typeof v === 'symbol') return String(v)
  return ''
}

/**
 * 在某个知识库里做关键词检索。
 *
 * 排序交给 FTS5 的 `bm25`（`ORDER BY rank`），不自己算相似度 ——
 * 消息检索那条路径已经验证过它的排序比「按插入顺序取前 N」好得多，两处口径一致。
 *
 * ⚠ **不能**为了性能把 `MATCH` 写进子查询先取全局前 N 再按库过滤：
 * 那样在「甲库命中一千块、乙库只有十块」时，全局前 N 会被甲库占满，
 * 乙库明明有内容却搜不出来 —— 这是**正确性**问题，不是性能取舍。
 * 正确写法是 MATCH 与库过滤一起下推（SQLite 会先算匹配集再 join）。
 * @param decryptedDir - 解密数据根（库文件在它的父目录下）。
 * @param kbId - 目标知识库；作用域过滤**只此一处**。
 * @param opts - 查询词、条数，以及是否只搜「允许参与 RAG」的文件（问答路径要开）。
 * @returns 命中（按相关度）+ 统计 + 降级说明；库读不到时给 `readError`。
 */
export function searchKb(decryptedDir: string, kbId: number, opts: KbSearchOptions = {}): KbSearchResult {
  const started = Date.now()
  const kb = Math.trunc(Number(kbId))
  const query = typeof opts.query === 'string' ? opts.query.trim() : ''
  const topK = normalizeTopK(opts.topK)
  const onlyRag = opts.onlyRag === true

  const empty = (extra: Partial<KbSearchResult>): KbSearchResult => ({
    kbId: Number.isFinite(kb) && kb > 0 ? kb : 0,
    query,
    hits: [],
    stats: {
      channels: [{ channel: 'sparse', count: 0, active: false, note: '未执行检索' }],
      recalled: 0,
      kept: 0,
      terms: 0,
      elapsedMs: Date.now() - started,
    },
    ...extra,
  })

  // 库标识无效与「这个库确实没内容」必须分开：界面上的处置完全不同
  // （前者是界面漏传，后者才该显示空态）。与 `listKbFiles` 的 readError 同一纪律。
  if (!Number.isFinite(kb) || kb <= 0) return empty({ error: '没有指定知识库（可能界面漏传了库标识）' })

  const terms = splitTerms(query)
  if (terms.length === 0) {
    // 空查询不是错误：用户清空输入框时会走到这里，界面只是回到文件列表。
    return empty({ stats: { channels: [{ channel: 'sparse', count: 0, active: true, note: '查询为空' }], recalled: 0, kept: 0, terms: 0, elapsedMs: Date.now() - started } })
  }

  const parts = terms.map(ftsPhrase).filter((p) => p !== '')
  if (parts.length === 0) {
    // 全是标点 / 空白：bigram 化之后没有任何 token。**不抛**，也不谎报「没有匹配的内容」。
    return empty({ stats: { channels: [{ channel: 'sparse', count: 0, active: true, note: '查询里没有可检索的字词' }], recalled: 0, kept: 0, terms: 0, elapsedMs: Date.now() - started } })
  }

  // 多词之间是 `OR` 而不是 `AND`：bm25 会把「两个词都命中」的块排到前面，
  // 于是精度由排序保证，而召回不必为了一个打错的词全军覆没。
  const match = parts.join(' OR ')

  let db: DatabaseSync
  try {
    db = openStore(decryptedDir)
  } catch (e) {
    const readError = errorText(e)
    console.warn('[kb-search] 文件库打开失败：' + readError)
    return empty({ readError })
  }

  try {
    const rows = db.prepare(
      'SELECT c.id AS chunk_id, c.file_id AS file_id, c.ordinal AS ordinal, c.page AS page, '
      + 'c.heading AS heading, c.text AS text, f.name AS file_name, f.ext AS file_ext, '
      + 'bm25(kb_chunks_fts) AS bm25 '
      + 'FROM kb_chunks_fts '
      + 'JOIN kb_chunks c ON c.id = kb_chunks_fts.rowid '
      + 'JOIN kb_files f ON f.id = c.file_id '
      + 'WHERE kb_chunks_fts MATCH ? AND c.kb_id = ? '
      // 文件级 RAG 开关（问答路径）。**下推到 SQL 而不是拿到结果再过滤**：
      // 后过滤会让「不许出网」的文件先占满 topK 名额、再被丢掉，用户看到的
      // 就是「明明有允许参与的文件却一条都没召回」。
      // 注意这不是第二处**库**过滤（那条不变量仍只有 `c.kb_id = ?` 一处）——
      // 判的是另一个列，删掉 kb_id 那条时本条件不会替它兜住。
      + (onlyRag ? 'AND f.include_in_rag = 1 ' : '')
      + 'ORDER BY rank LIMIT ?',
    ).all(match, kb, topK) as Array<Record<string, unknown>>

    const hits: KbHit[] = rows.map((r, i) => {
      const text = cellStr(r['text'])
      const { snippet, marks } = buildSnippet(text, terms)
      return {
        fileId: Number(r['file_id'] ?? 0),
        fileName: cellStr(r['file_name']),
        fileExt: cellStr(r['file_ext']),
        chunkId: Number(r['chunk_id'] ?? 0),
        ordinal: Number(r['ordinal'] ?? 0),
        page: Number(r['page'] ?? 0),
        heading: cellStr(r['heading']),
        snippet,
        text,
        marks,
        // bm25() 越小越相关，取负号变成「越大越相关」（与消息检索同一口径）。
        score: -Number(r['bm25'] ?? 0),
        ranks: { sparse: i + 1 },
      }
    })

    // 「命中了几块」而不是「命中了几行」：一次检索里同一文件的多块各算一条，
    // 界面按块展示（与设计稿 docKey = 'chunk:' + chunkId 一致）。
    const stats: KbSearchStats = {
      channels: [{ channel: 'sparse', count: hits.length, active: true }],
      recalled: hits.length,
      kept: hits.length,
      terms: terms.length,
      elapsedMs: Date.now() - started,
    }
    return {
      kbId: kb,
      query,
      hits,
      stats,
      // T3 恒为降级态：向量库还没建（T4 才做）。文案照设计稿 §6.3，
      // 只说明现状、**不劝用户去开什么**。
      degraded: { reason: 'no-vector-index', label: '仅关键词（未建向量索引）' },
    }
  } catch (e) {
    const readError = errorText(e)
    console.warn('[kb-search] 检索失败：' + readError)
    return empty({ readError })
  } finally {
    try {
      db.close()
    } catch {
      /* 已关闭 */
    }
  }
}
