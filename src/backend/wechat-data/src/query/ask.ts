/**
 * AI Q&A over WeChat data: builds a **ranked** retrieval context (message
 * search hits) that the host gateway feeds to the DSH LLM service. The actual
 * LLM call lives in the gateway (needs ctx.llm); this module only prepares the
 * context + citations.
 *
 * ── 检索策略（本轮重写）──────────────────────────────────
 * 旧实现按「原问题 → 原问题分词 → 逐个 bigram」顺序检索，谁先命中谁占名额，
 * 到 cap 就停。实测（1664px 窗口、230 个会话）暴露两个致命问题：
 *
 *   Q「最近一次转账给我的是谁？」词序：最近一次转账给我的是谁 / 最近 / 近一 / 一次 /
 *     次转 / 转账 / …。`最近` 一次就返回 20 条（= cap），**`转账` 根本没被检索**。
 *   Q「上周三我和李四聊了什么？」：`上周`(9) + `周三`(20) 吃满 cap，
 *     **人名 `李四`(7) 根本没被检索** —— 最该起作用的词被通用词挤掉。
 *   Q「谁答应过我下周交报告？」：`我下`(20) / `下周`(20) / `报告`(20) 全是通用词。
 *
 * 新策略：**先全量召回、再统一打分排序**，而不是「先到先得」。
 *   ① 词项来自「规划器关键词 + 问题内容 bigram」，剔除功能词 bigram；
 *   ② 每个词各自检索（per-term cap），**不互相抢名额**；
 *   ③ 用观测命中数做 IDF 近似：`w = base / (1 + hits)` —— 稀有词（答应=1、李四=7）
 *      权重远高于饱和词（最近/报告/转账 都顶到 cap）；
 *   ④ 一条消息命中越多词、命中越稀有的词，得分越高；同分再看时间；
 *   ⑤ 识别「最近/最新/最后一次」这类**时间意图**：把时间词从检索词里摘掉
 *      （它们是排序意图而不是内容词），改由时间降序来体现。
 */
import { countIndexMatches, loadMessageWindow, searchIndexBatch, searchIndexMessages } from './search.ts'

/** Optional retrieval scope: one talker and/or an inclusive date range (YYYY-MM-DD). */
export interface AskScope {
  username?: string
  from?: string
  to?: string
}

/** One citation (source message) for an Ask answer. */
export interface AskCitation {
  name: string
  time: string
  snippet: string
  username: string
  local_id: number
  /** 群聊里这条消息的发送者显示名（单聊为空）。 */
  sender?: string
}

/** 规划器给出的结构化检索线索。 */
export interface AskHints {
  /** 关键词组（规划器已去停用词）。 */
  subQueries?: string[]
  /** 问题里隐含的绝对日期范围，由规划器换算成 YYYY-MM-DD。 */
  from?: string
  to?: string
  /** 问题里点名的人：命中其会话名或群内发送者时加分。 */
  person?: string
}

/** 检索统计（写进操作日志，便于回答「为什么没检索到」）。 */
export interface AskRetrievalStats {
  terms: number
  probed: number
  candidates: number
  kept: number
  scope: string
  recency: boolean
  /** 规划器推断出的时间线索（软偏好，非硬过滤）。 */
  timeHint: string
  /** 保留的引用里落在时间线索范围内的条数。 */
  hintHits: number
  /** 命中消息聚类后的对话窗口数（chunk 级检索）。 */
  chunks: number
  /** 窗口展开实际取回的消息条数。 */
  windowMessages: number
  /** 召回通道：bm25 = 自建 bigram 索引（相关度排序）；like = 索引未就绪时的兜底扫描。 */
  recall: 'bm25' | 'like'
}

/**
 * 一个对话窗口（chunk）—— RAG 的检索单元。
 *
 * 为什么按「窗口」而不是按「单条消息」检索：微信里一条消息经常只有几个字
 * （「好的」「我没答应」「明天吧」），单独看无法判断它回答了谁的什么问题。
 * 「谁答应过我下周交报告」的答案往往分散在相邻两三条里（对方问 → 我答）。
 * 所以召回仍然按消息做（精确），但**送给模型的单元是它所在的对话窗口**。
 */
export interface AskChunk {
  username: string
  name: string
  /** 窗口里最匹配的那条消息 —— 引用卡片与「点击跳转原文」都以它为锚点。 */
  anchor: AskCitation
  /** 窗口内的连续消息（按时间升序）；day 为该行自己的日期，窗口跨天时用它。 */
  lines: Array<{ time: string; day?: string; sender: string; text: string }>
  score: number
  /** 锚点是否落在时间线索范围内；排序时优先（与消息级排序保持同一套语义）。 */
  pref: number
  /** 锚点时间（秒）。窗口级打分并列时按时间新→旧兜底 ——
   *  否则「最近一次转账」这类问题会在聚类后丢掉时间序（实测踩到过）。 */
  createTime: number
}

/** 相邻消息归入同一窗口的最大间隔（秒）：超过就是另一次对话了。 */
const CHUNK_GAP_S = 900
/** 窗口展开的前后跨度（毫秒），以及窗口内最大条数。 */
const WINDOW_SPAN_MS = 15 * 60 * 1000
const WINDOW_MAX_MSGS = 14
/** 最终送给模型的窗口数上限（每个窗口最多 6 行）。 */
const CHUNK_LIMIT = 10
const CHUNK_LINES = 6

/** 按「同会话 + 时间相邻」把候选消息聚成对话窗口。 */
function clusterChunks(ranked: Candidate[]): Candidate[][] {
  const bySession = new Map<string, Candidate[]>()
  for (const c of ranked) {
    const list = bySession.get(c.username)
    if (list) list.push(c)
    else bySession.set(c.username, [c])
  }
  const clusters: Candidate[][] = []
  for (const list of bySession.values()) {
    list.sort((a, b) => a.create_time - b.create_time)
    let cur: Candidate[] = []
    for (const c of list) {
      const prev = cur[cur.length - 1]
      if (prev && c.create_time - prev.create_time > CHUNK_GAP_S) {
        clusters.push(cur)
        cur = []
      }
      cur.push(c)
    }
    if (cur.length > 0) clusters.push(cur)
  }
  return clusters
}

/**
 * 把排序后的候选消息展开成对话窗口，并按「窗口内容与检索词的重合度」重排。
 *
 * 这一步是 RAG 里的 **rerank**：先按单条消息的命中得分召回，再用窗口全文
 * 重新打分 —— 窗口里出现越多检索词（尤其是稀有词）、词与词越靠近，
 * 说明这段对话越可能真的在讲这件事。
 * @param decryptedDir - decrypted data root.
 * @param ranked - 按消息得分排序的候选。
 * @param termWeight - 词 → 权重（IDF 近似），用于窗口级重合度打分。
 * @param person - 规划器点名的人（命中会话名/发送者时加分）。
 * @returns 重排后的窗口列表。
 */
function buildChunks(
  decryptedDir: string,
  ranked: Candidate[],
  termWeight: Map<string, number>,
  person: string,
  recency: boolean,
): { chunks: AskChunk[]; windowMessages: number } {
  const clusters = clusterChunks(ranked)
  const chunks: AskChunk[] = []
  let windowMessages = 0
  for (const members of clusters) {
    // 锚点：组内单条得分最高的那条（引用卡片显示它）
    const anchor = members.reduce((a, b) => (b.score > a.score ? b : a))
    const centerMs = Math.round(((members[0].create_time + members[members.length - 1].create_time) / 2) * 1000)
    const win = loadMessageWindow(decryptedDir, anchor.username, centerMs, WINDOW_SPAN_MS, WINDOW_MAX_MSGS)
    windowMessages += win.length
    let lines = (win.length > 0
      ? win.map(w => ({
        time: formatClock(w.create_time),
        day: formatDay(w.create_time),
        sender: w.sender ? w.sender : '',
        text: w.text,
      }))
      : [{ time: formatClock(anchor.create_time), day: formatDay(anchor.create_time), sender: anchor.sender ?? '', text: anchor.snippet }]
    ).slice(0, CHUNK_LINES)
    // 锚点（真正命中的那条）必须出现在窗口里：聚类跨度可能大于窗口跨度、
    // 窗口也可能被条数上限截掉锚点 —— 一旦如此，模型看到的是「一段不包含
    // 命中消息的对话」，窗口级打分也会跟着失真（实测会把最近的转账排到后面）。
    if (win.length > 0 && !win.some(w => w.local_id === anchor.local_id)) {
      const anchorLine = { time: formatClock(anchor.create_time), day: formatDay(anchor.create_time), sender: anchor.sender ?? '', text: anchor.snippet }
      const at = lines.findIndex(l => l.time > anchorLine.time)
      if (at < 0) lines.push(anchorLine)
      else lines.splice(at, 0, anchorLine)
      lines = lines.slice(0, CHUNK_LINES)
    }

    // 窗口级重排分：命中消息得分 + 窗口全文的检索词覆盖（稀有词权重更高）
    const blob = lines.map(l => l.text).join(' ')
    let coverage = 0
    for (const [t, w] of termWeight) if (blob.includes(t)) coverage += w
    let score = anchor.score + 0.6 * coverage
    if (person && (anchor.name.includes(person) || (anchor.sender ?? '').includes(person))) score += 0.5
    chunks.push({
      username: anchor.username,
      name: anchor.name,
      anchor: {
        name: anchor.name,
        time: anchor.time,
        snippet: anchor.snippet,
        username: anchor.username,
        local_id: anchor.local_id,
        ...(anchor.sender ? { sender: anchor.sender } : {}),
      },
      lines,
      score,
      pref: anchor.pref,
      createTime: anchor.create_time,
    })
  }
  // 窗口级排序沿用消息级的同一套优先级：时间线索 → 窗口得分 → 时间新→旧。
  // 「最近/最后一次」类问题**必须**按时间排 —— 否则这里会用量化得分把
  // 消息级刚排好的时间序又打乱（实测「最近一次转账」回到 2 月那条）。
  chunks.sort(recency
    ? (a, b) => (b.pref - a.pref) || (b.createTime - a.createTime)
    : (a, b) => (b.pref - a.pref) || (b.score - a.score) || (b.createTime - a.createTime))
  return { chunks: chunks.slice(0, CHUNK_LIMIT), windowMessages }
}

/** 秒级时间戳 → YYYY-MM-DD（逐行带上，窗口跨天时模型才不会拿窗口头的日期猜）。 */
function formatDay(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 秒级时间戳 → HH:MM（窗口行内只显示时钟，日期在同一行/窗口头上给）。 */
function formatClock(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 功能词字符集：一个 bigram 两边都落在这里 → 视为功能词组合，直接丢弃。 */
const FUNCTION_CHARS = new Set(
  '的了是我你他她它们在有和就都也很还要会能可这那么吗呢吧啊呀哦嗯给过下上个别不没与及或而但因所为以之其中对从到把被让使得着地谁哪几多少么什怎'.split(''),
)

/** 常见功能词/疑问词 bigram：即使含内容字也是噪音（…的是什么、给我、一下…）。 */
const STOP_BIGRAMS = new Set([
  '什么', '怎么', '怎样', '如何', '为什', '哪些', '哪个', '哪个', '是否', '能否',
  '我的', '你的', '他的', '她的', '我们', '你们', '他们', '她们', '咱们',
  '给我', '的是', '了吗', '了吧', '没有', '可以', '已经', '这个', '那个', '这些', '那些',
  '一下', '一起', '一定', '一样', '一直', '告诉', '帮忙', '请问', '麻烦', '知道', '觉得',
  '应该', '可能', '还是', '就是', '不是', '但是', '因为', '所以', '如果', '虽然', '然后',
  '时候', '地方', '东西', '事情', '问题', '多少', '几个', '以及', '并且', '或者', '而且',
  '不过', '只是', '有时', '大概', '也许', '有没有', '是不是', '能不能', '好不好',
])

/** 「最近/最新/最后」这类**排序意图**词：不参与内容检索，只影响排序。 */
const RECENCY_WORDS = new Set(['最近', '最新', '最后', '一次', '上次', '上一', '近一', '这两', '这几', '刚刚', '之前', '前一', '一次'])
const RECENCY_RE = /最近|最新|最后|上一次|上一回|前几天|这两天|这几天|刚刚|近期/

/** 问题是否在问「最近/最后一次」。 */
export function hasRecencyIntent(question: string): boolean {
  return RECENCY_RE.test(question || '')
}

/**
 * 把一段文字拆成检索词：拉丁/数字整段 + 中文内容 bigram。
 * 中文没有分词器，bigram 是 FTS5 unicode61 下唯一可行的近似 —— 但要剔除
 * 纯功能词组合，否则「的是什么/给我/我的」这类词会吃满召回名额。
 * @param text - 待拆分的文本（问题或规划器给出的关键词）。
 * @returns 去重后的检索词（保持出现顺序）。
 */
export function extractAskTerms(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (t: string): void => {
    const v = t.trim()
    if (!v || seen.has(v)) return
    seen.add(v)
    out.push(v)
  }
  // 中英数必须**分段**匹配：早先用 `[\u4e00-\u9fffA-Za-z0-9]+` 把
  // 「丰田合同差额2000的那个客户是谁」当成一个「含数字」的整段直接入词，
  // 结果一个 17 字的整句变成唯一检索词 → 全库零命中（实测）。
  for (const run of String(text || '').match(/[\u4e00-\u9fff]+|[A-Za-z0-9]+/g) || []) {
    // 拉丁/数字整段（型号、金额、英文名）本身就是好词项
    if (/^[A-Za-z0-9]+$/.test(run)) { push(run); continue }
    if (run.length <= 3) { push(run); continue }
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const bg = run.slice(i, i + 2)
      if (STOP_BIGRAMS.has(bg)) continue
      if (FUNCTION_CHARS.has(bg[0]) && FUNCTION_CHARS.has(bg[1])) continue
      push(bg)
    }
  }
  return out
}

/** Start-of-day epoch ms for a YYYY-MM-DD string (NaN when invalid). */
function dayStartMs(s: string): number {
  return new Date(s + 'T00:00:00').getTime()
}

/** End-of-day epoch ms for a YYYY-MM-DD string (NaN when invalid). */
function dayEndMs(s: string): number {
  return new Date(s + 'T23:59:59').getTime()
}

/** 组内消息前缀 `wxid_xxx:` 的显示名解析。
 *  容忍 `:\n` 与 `: ` 两种分隔 —— 有些路径（全文扫描 / LIKE 结果）会把换行压成空格，
 *  只认 `:\n` 会让 `wxid_xxx: 内容` 整段原样进上下文，既脏又看不出是谁说的。 */
function splitSender(raw: string): { sender: string; body: string } {
  const m = raw.match(/^([A-Za-z0-9_@.\-]{4,64}):\s/)
  return m ? { sender: m[1], body: raw.slice(m[0].length) } : { sender: '', body: raw }
}

/** 以首个命中词为中心截取片段（旧实现恒从第 0 字开始，命中点常被截掉）。 */
function centerSnippet(text: string, terms: string[], max = 90): string {
  const body = text.replace(/\s+/g, ' ').trim()
  if (body.length <= max) return body
  let at = -1
  let hit = ''
  for (const t of terms) {
    const i = body.indexOf(t)
    if (i >= 0 && (at < 0 || i < at)) { at = i; hit = t }
  }
  if (at < 0) return body.slice(0, max) + '…'
  const start = Math.max(0, at - Math.floor((max - hit.length) / 2))
  const end = Math.min(body.length, start + max)
  return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '')
}

/** 一条候选：原文 + 打分中间量。 */
interface Candidate {
  name: string
  time: string
  snippet: string
  username: string
  local_id: number
  sender?: string
  create_time: number
  score: number
  matched: string[]
  /** 是否落在规划器推断的时间范围内（1=是）。排序时优先，但**不**因此丢弃其他候选。 */
  pref: number
  /** 原始正文（去群前缀）。人物加成要判断「正文里是否点名」，snippet 会被截断不可靠。 */
  body?: string
}

/** 每个词最多取多少条候选（per-term cap，词与词之间互不抢名额）。 */
const PER_TERM_CAP = 20
/** 兜底 bigram 的最低支持度：只命中 1 条的多半是跨词切分噪音（次转/三我）。 */
const MIN_FALLBACK_SUPPORT = 2

/**
 * 按「规划器关键词 + 问题 bigram」召回候选并统一打分。
 * @param decryptedDir - decrypted data root.
 * @param question - 用户原始问题。
 * @param hints - 规划器给出的关键词/时间/人物线索。
 * @param scope - 用户显式设置的会话与时间范围。
 * @param limit - 最终保留条数（默认 24）。
 * @returns 排序后的引用 + 统计。
 */
export function retrieveAskCitations(
  decryptedDir: string,
  question: string,
  hints?: AskHints,
  scope?: AskScope,
  limit?: number,
): { citations: AskCitation[]; chunks: AskChunk[]; terms: string[]; stats: AskRetrievalStats } {
  const cap = Math.min(Math.max(limit ?? 24, 1), 60)
  const recency = hasRecencyIntent(question)
  const person = (hints?.person ?? '').trim()
  const planned = (hints?.subQueries ?? []).flatMap(q => extractAskTerms(q))
  const fallback = extractAskTerms(question)
  // 词项集：规划器词优先（权重更高），问题 bigram 补齐；时间意图词不进检索
  const terms: Array<{ t: string; base: number; planned: boolean }> = []
  const seenTerm = new Set<string>()
  const addTerm = (t: string, base: number, isPlanned: boolean): void => {
    if (recency && RECENCY_WORDS.has(t)) return
    if (seenTerm.has(t)) return
    seenTerm.add(t)
    terms.push({ t, base, planned: isPlanned })
  }
  for (const t of planned) addTerm(t, 1, true)
  for (const t of fallback) addTerm(t, 0.35, false)
  // 词项上限：每个词一次检索（LIKE 兜底路径下 4 张内容表各扫一次），
  // 12 个词 ≈ 48 次扫描已是可接受上限，再多提问延迟会明显上升。
  const active = terms.slice(0, 12)

  // 时间范围分两档，语义完全不同：
  //   · 用户在界面上选的「时间范围」= **硬过滤**（他明确要求只看这段）；
  //   · 规划器从「上周三」推断出来的日期 = **软偏好**（只是排序倾向）。
  // 后者绝不能当硬过滤：实测把它当过滤时，「上周三我和李四聊了什么」被收窄到
  // 2026-09-02 单日 → 候选 0 条，直接答不出来。推断错了不该让检索归零。
  const hardFromMs = scope?.from ? dayStartMs(scope.from) : NaN
  const hardToMs = scope?.to ? dayEndMs(scope.to) : NaN
  const softFromMs = hints?.from ? dayStartMs(hints.from) : NaN
  const softToMs = hints?.to ? dayEndMs(hints.to) : NaN
  const inHardRange = (ts: number): boolean => {
    if (!Number.isFinite(hardFromMs) && !Number.isFinite(hardToMs)) return true
    const ms = ts * 1000
    if (ms <= 0) return false
    if (Number.isFinite(hardFromMs) && ms < hardFromMs) return false
    if (Number.isFinite(hardToMs) && ms > hardToMs) return false
    return true
  }
  const inSoftRange = (ts: number): boolean => {
    if (!Number.isFinite(softFromMs) && !Number.isFinite(softToMs)) return true
    const ms = ts * 1000
    if (ms <= 0) return false
    if (Number.isFinite(softFromMs) && ms < softFromMs) return false
    if (Number.isFinite(softToMs) && ms > softToMs) return false
    return true
  }

  const byKey = new Map<string, Candidate>()
  let candidates = 0
  /** 召回模式：bm25 = 自建索引（全库 BM25 排序）；like = 索引未就绪时的兜底。 */
  let recallMode: 'bm25' | 'like' = 'like'
  // 词 → 权重（IDF 近似），chunk 阶段算窗口覆盖率时复用
  const termWeight = new Map<string, number>()

  // ── 首选：自建 bigram BM25 索引，一次 MATCH 召回全部词项 ──
  // 关键差别：旧路径对每个词取「LIKE 命中按行号倒序的前 20 条」——
  // 那是**任意 20 条**而非最相关的 20 条，实测 `合同` 全库 4062 条时召回率只有 0.49%。
  // BM25 既按相关度排序，又自带真实词 IDF，不再需要 1/(1+hits) 这种近似。
  //
  // 但 BM25 对**词项质量**零容忍：兜底 bigram 里的跨词切分（`次转`/`账给` 来自
  // 「最近一次转账」）是合法 token，不过滤就会把真正的「转账」通知挤出前列。
  // 所以先用真实 df 过滤一遍：规划器词全留，兜底 bigram 至少要有 2 篇文档支持。
  let bm25Terms = active.map(x => x.t)
  if (countIndexMatches(decryptedDir, active[0]?.t ?? '') >= 0) {
    const kept = active.filter(x => x.planned || countIndexMatches(decryptedDir, x.t) >= MIN_FALLBACK_SUPPORT)
    if (kept.length > 0) bm25Terms = kept.map(x => x.t)
  }
  const batch = searchIndexBatch(
    decryptedDir,
    bm25Terms,
    400,
    {
      ...(scope?.username ? { username: scope.username } : {}),
      ...(person ? { person } : {}),
    },
  )
  if (batch.ranked && batch.hits.length > 0) {
    recallMode = 'bm25'
    const maxScore = batch.hits.reduce((m, h) => Math.max(m, h.score ?? 0), 0) || 1
    // 用返回样本近似词频：命中越少越稀有
    for (const { t, base } of active) {
      let n = 0
      for (const h of batch.hits) if (String(h.text).includes(t)) n += 1
      if (n > 0) termWeight.set(t, base / (1 + Math.min(n, 400)))
    }
    const allTerms = active.map(x => x.t)
    for (const h of batch.hits) {
      if (!inHardRange(h.create_time)) continue
      const { sender, body } = splitSender(String(h.text ?? ''))
      const matched = allTerms.filter(t => body.includes(t))
      // 问某个人时，三条线索都算命中：会话名、群内发送者、**正文里提到他**。
      // 只认前两条会漏掉「合同表单里写着李四」这类正文提名（而问题往往就是在问它）。
      const personMatch = Boolean(
        person && (h.name.includes(person) || (h.sender ?? '').includes(person) || body.includes(person)),
      )
      // who 列命中（问某人 → 命中与他的会话）时正文里可能一个词都没有，不能因此丢掉
      if (matched.length === 0 && !personMatch) continue
      const key = h.username + ':' + h.local_id
      if (byKey.has(key)) continue
      let cov = 0
      for (const t of matched) cov += termWeight.get(t) ?? 0
      candidates += 1
      byKey.set(key, {
        name: h.name,
        time: h.time,
        snippet: centerSnippet(body || String(h.snippet ?? ''), allTerms),
        username: h.username,
        local_id: h.local_id,
        create_time: h.create_time,
        score: (h.score ?? 0) / maxScore + 0.4 * cov,
        matched,
        pref: inSoftRange(h.create_time) ? 1 : 0,
        body,
        ...(sender ? { sender } : {}),
      })
    }
  }

  // ── 兜底：索引未就绪时，每个词各自探测（互不抢名额）──
  let effective: Array<{ t: string; base: number; planned: boolean; hits: ReturnType<typeof searchIndexMessages>['hits'] }> = []
  if (recallMode === 'like') {
    const probes: typeof effective = []
    for (const { t, base, planned: isPlanned } of active) {
      const env = searchIndexMessages(decryptedDir, t, PER_TERM_CAP, scope?.username)
      probes.push({ t, base, planned: isPlanned, hits: env.hits || [] })
    }
    // 剔除「低支持度的兜底 bigram」——只命中 1 条的多半是跨词切分的噪音
    // （次转 / 三我 / 账给）。但若**所有**词都没到支持度阈值（短问题、生僻问法），
    // 就退回「有一个算一个」，否则会出现「明明有命中却一条都不给模型」。
    const usable = probes.filter(p => p.planned || p.hits.length >= MIN_FALLBACK_SUPPORT)
    effective = usable.length > 0 ? usable : probes.filter(p => p.hits.length > 0)
  }
  for (const { t, base, hits } of effective) {
    // IDF 近似：命中越少越稀有 → 权重越高；饱和词（=PER_TERM_CAP）权重最低
    const w = base / (1 + Math.min(hits.length, PER_TERM_CAP))
    termWeight.set(t, w)
    for (const h of hits) {
      if (!inHardRange(h.create_time)) continue
      const key = h.username + ':' + h.local_id
      let c = byKey.get(key)
      if (!c) {
        const { sender, body } = splitSender(String(h.text ?? ''))
        candidates += 1
        c = {
          name: h.name,
          time: h.time,
          snippet: centerSnippet(body || String(h.snippet ?? ''), effective.map(x => x.t)),
          username: h.username,
          local_id: h.local_id,
          create_time: h.create_time,
          score: 0,
          matched: [],
          pref: inSoftRange(h.create_time) ? 1 : 0,
          ...(sender ? { sender } : {}),
        }
        byKey.set(key, c)
      }
      c.score += w
      if (!c.matched.includes(t)) c.matched.push(t)
    }
  }

  // 排名：时间线索优先 → 得分 → 命中词数 → 时间新→旧
  const ranked = [...byKey.values()].sort((a, b) => {
    if (a.pref !== b.pref) return b.pref - a.pref
    if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score
    if (a.matched.length !== b.matched.length) return b.matched.length - a.matched.length
    return b.create_time - a.create_time
  })
  // 人物线索加成：会话名 / 群内发送者 / 正文点名的人都优先，且权重要**压过** BM25 的
  // 微小差值 —— 归一化后的 BM25 挤在 0~1，+0.5 不足以把「正文写着李四的合同」顶上去（实测排名反而下降）。
  if (person) {
    for (const c of ranked) {
      if (c.name.includes(person) || (c.sender ?? '').includes(person) || (c.body ?? '').includes(person)) c.score += 1.0
    }
    ranked.sort((a, b) => (b.pref - a.pref) || (b.score - a.score) || (b.create_time - a.create_time))
  }
  // 「最近/最新/最后一次」：在**命中全部规划器内容词**的候选里按时间新→旧。
  // 不能只按 score 排 —— BM25 偏好「短文本 + 该词多次出现」的讨论型消息，
  // 实测「最近一次转账给我的是谁」会把群里讨论转账脚本的消息排在真正的
  // 转账通知（在房东会话里）之前。语义上「最近一次 X」就是「命中 X 的最新一条」。
  if (recency && ranked.length > 1) {
    const plannedTerms = active.filter(x => x.planned).map(x => x.t)
    const key = plannedTerms.length > 0 ? plannedTerms : active.map(x => x.t)
    const isStrong = (c: Candidate): boolean => key.every(t => c.matched.includes(t))
    const strong = ranked.filter(isStrong)
    const weak = ranked.filter(c => !isStrong(c))
    strong.sort((a, b) => (b.pref - a.pref) || (b.create_time - a.create_time))
    ranked.length = 0
    ranked.push(...strong, ...weak)
  }

  // ── RAG 第三步：把「单条消息」升级成「对话窗口」并按窗口内容重排 ──
  // 召回仍按消息做（精确），但送给模型的单元是消息所在的连续对话 —— 这是
  // 「谁答应过我下周交报告」这类问题能被答对的关键（问与答分散在相邻两条里）。
  const { chunks, windowMessages } = buildChunks(decryptedDir, ranked.slice(0, cap), termWeight, person, recency)

  const citations: AskCitation[] = chunks.map(c => c.anchor)
  const keptRanked = ranked.slice(0, cap)
  const usedTerms = active.filter(x => termWeight.has(x.t)).map(x => x.t)
  const scopeDesc = [
    scope?.username ? '会话限定' : '',
    scope?.from ? `起 ${scope.from}` : '',
    scope?.to ? `止 ${scope.to}` : '',
  ].filter(Boolean).join(' ') || '全库'
  const timeHint = (hints?.from || hints?.to) ? `${hints?.from || '…'} ~ ${hints?.to || '…'}` : ''
  const hasSoftHint = Number.isFinite(softFromMs) || Number.isFinite(softToMs)
  return {
    citations,
    chunks,
    terms: usedTerms,
    stats: {
      terms: usedTerms.length,
      probed: active.length,
      candidates,
      kept: citations.length,
      scope: scopeDesc,
      recency,
      timeHint,
      // 时间线索真正命中的条数：为 0 时回答里不该声称「已限定在该日期」。
      // 没有线索时恒为 0（不把所有候选都算成「命中线索」）。
      hintHits: hasSoftHint ? keptRanked.filter(c => c.pref === 1).length : 0,
      chunks: chunks.length,
      windowMessages,
      recall: recallMode,
    },
  }
}

/**
 * 把检索结果格式化成给 LLM 的上下文块。
 *
 * 每个 [n] 是一个**对话窗口**而不是单条消息：窗口头给出会话、日期与命中时间点，
 * 下面按时间顺序列出这段对话（群聊带发言人）。模型因此能看到「谁问的、谁答的」，
 * 而不是一条孤立的「我没答应」。
 * @param citations - 已排序的引用（与 chunks 一一对应）。
 * @param meta - 意图 / 关键词 / 范围 / 时间线索，写进上下文头，便于模型判断证据是否充分。
 * @param chunks - 与 citations 对应的对话窗口；缺省时退化为逐条消息。
 * @returns 上下文文本。
 */
export function formatAskContext(
  citations: AskCitation[],
  meta?: { intent?: string; terms?: string[]; scope?: string; recency?: boolean; timeHint?: string; hintHits?: number },
  chunks?: AskChunk[],
): string {
  if (citations.length === 0) {
    return '（本机微信聊天记录中未检索到相关消息。请直接说明未检索到，并给出可以缩小或换种问法的建议，不要编造。）'
  }
  const hintLine = meta?.timeHint
    ? (meta.hintHits && meta.hintHits > 0
      ? `时间线索：${meta.timeHint}（优先展示，其中 ${meta.hintHits} 条落在该范围内）`
      : `时间线索：${meta.timeHint}（该范围内没有命中，以下为放宽时间后的结果，回答时不要声称限定在该日期）`)
    : ''
  const head = [
    meta?.intent ? `检索意图：${meta.intent}` : '',
    meta?.terms?.length ? `实际检索词：${meta.terms.join(' / ')}` : '',
    meta?.scope ? `检索范围：${meta.scope}` : '',
    hintLine,
    meta?.recency ? '排序：按时间新→旧（问题在问“最近/最后一次”）' : '',
  ].filter(Boolean).join('；')

  const blocks: string[] = []
  if (chunks && chunks.length > 0) {
    chunks.forEach((ch, i) => {
      const who = ch.anchor.sender ? `${ch.name} · ${ch.anchor.sender}` : ch.name
      const day = (ch.anchor.time || '').slice(0, 10)
      // 行内只给时钟；**跨天**的行带上自己的日期 —— 否则模型只能拿窗口头那天去猜，
      // 而提示词又要求「写绝对日期」，猜错就把日期编进了回答里（本轮修）。
      const body = ch.lines.map((l) => {
        const stamp = l.day && l.day !== day ? `${l.day.slice(5)} ${l.time}` : l.time
        return `    ${stamp}${l.sender ? ' ' + l.sender : ''}：${l.text}`
      }).join('\n')
      blocks.push(`[${i + 1}] ${who}（${day}，命中时间 ${(ch.anchor.time || '').slice(11)}）\n${body}`)
    })
  } else {
    citations.forEach((c, i) => {
      const who = c.sender ? `${c.name} · ${c.sender}` : c.name
      blocks.push(`[${i + 1}] ${who} (${c.time}): ${c.snippet}`)
    })
  }
  return `${head ? head + '\n' : ''}以下是本机微信聊天记录中检索到的相关对话片段（每个 [n] 是一段连续对话，已按相关度排序），是回答的唯一事实依据：\n${blocks.join('\n\n')}`
}

/**
 * 单轮检索入口（保留旧签名，供既有调用方与测试使用）。
 * @param decryptedDir - decrypted data root.
 * @param question - the user question.
 * @param limit - max context hits (default 24).
 * @param scope - optional talker and/or date-range filter.
 * @returns the formatted context lines plus source citations.
 */
export function buildAskContext(
  decryptedDir: string,
  question: string,
  limit?: number,
  scope?: AskScope,
): { context: string; citations: AskCitation[] } {
  const { citations, chunks, terms, stats } = retrieveAskCitations(decryptedDir, question, undefined, scope, limit ?? 24)
  return {
    context: formatAskContext(citations, {
      terms,
      scope: stats.scope,
      recency: stats.recency,
      timeHint: stats.timeHint,
      hintHits: stats.hintHits,
    }, chunks),
    citations,
  }
}

/** 解析检索规划 LLM 的 JSON 输出（容忍 ```json 围栏与前后杂文；取不到时返回空规划）。 */
export function parseAskPlan(text: string): { intent: string; subQueries: string[]; from: string; to: string; person: string } {
  const out = { intent: '', subQueries: [] as string[], from: '', to: '', person: '' }
  if (!text) return out
  let t = String(text).trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(t.slice(start, end + 1)) as Record<string, unknown>
      if (typeof obj.intent === 'string') out.intent = obj.intent.slice(0, 200)
      if (Array.isArray(obj.subQueries)) {
        out.subQueries = obj.subQueries
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          .map(x => x.trim().slice(0, 100))
          .slice(0, 4)
      }
      // 日期必须严格是 YYYY-MM-DD 才采用：模型偶尔会回「上周三」这种相对描述，
      // 直接当 from/to 用会把检索范围悄悄收窄成空集。
      const day = (v: unknown): string => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : '')
      out.from = day(obj.from)
      out.to = day(obj.to)
      if (typeof obj.person === 'string') out.person = obj.person.trim().slice(0, 40)
    } catch { /* 非 JSON 输出按空规划处理 */ }
  }
  return out
}

/** 从回答正文里解析模型实际引用的来源序号（1 基），用于给「来源」列表做标记。 */
export function parseCitedIndexes(answer: string, citationCount: number): number[] {
  const out = new Set<number>()
  for (const m of String(answer || '').matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(m[1])
    if (n >= 1 && n <= citationCount) out.add(n)
  }
  return [...out].sort((a, b) => a - b)
}

/** 解析提问优化 LLM 的 JSON 输出（容忍围栏/杂文；解析失败时由调用方兜底）。 */
export function parseAskOptimize(text: string): { optimized: string; suggestions: string[] } {
  const out: { optimized: string; suggestions: string[] } = { optimized: '', suggestions: [] }
  if (!text) return out
  let t = String(text).trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(t.slice(start, end + 1)) as { optimized?: unknown; suggestions?: unknown }
      if (typeof obj.optimized === 'string') out.optimized = obj.optimized.trim().slice(0, 500)
      if (Array.isArray(obj.suggestions)) {
        out.suggestions = obj.suggestions
          .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
          .map(x => x.trim().slice(0, 200))
          .slice(0, 4)
      }
    } catch { /* 非 JSON 输出按空处理 */ }
  }
  return out
}
