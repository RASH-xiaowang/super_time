/**
 * 推荐回复的知识库检索适配。
 *
 * 推荐回复不能只拿最后一句做检索：微信里大量短问句（“你是干嘛的啊？”）本身
 * 没有领域词，真正能定位知识库的是前面几句在聊什么。这里把最近对话同时整理成：
 *   · semantic：保留原句，供向量通道理解真实意图；
 *   · lexical：去掉口语停用词后的内容词，供 FTS5 做精确词法召回。
 * 两路查询交给 `kbChannel` 融合，并强制只使用 `include_in_rag = 1` 的文件。
 */
import { bigramTokens } from './search-scaffold.ts'
import { loadRetrievalConfig } from './retrieval/config.ts'
import { kbChannel } from './retrieval/kb-channel.ts'
import type { EmbedFn } from './vector-math.ts'
import type { ChannelHit } from './retrieval/types.ts'

const RECENT_LINE_LIMIT = 8
const MAX_LINE_CHARS = 180
const MAX_SEMANTIC_CHARS = 800
const MAX_LEXICAL_TERMS = 48

/**
 * 微信口语里高频、但对知识库定位几乎没有区分度的 bigram。
 *
 * bigram 索引会把“你是干嘛的”切成“你是 / 是干 / 干嘛 / 嘛的”，如果不筛掉，
 * FTS 的 OR 查询会把这些词召回到大量无关块里。
 */
const STOP_BIGRAMS = new Set([
  '你是', '是干', '干嘛', '嘛的', '的啊', '我是', '是做', '那块', '那个', '这个',
  '一下', '一点', '有点', '给你', '你的', '我的', '我们', '你们', '他们', '她们',
  '就是', '不是', '可以', '什么', '怎么', '为什么', '因为', '所以', '但是', '不过',
  '而且', '然后', '现在', '刚才', '刚刚', '今天', '明天', '昨天', '最近', '已经',
  '还是', '还有', '没有', '一个', '一些', '这些', '那些', '觉得', '知道', '真的',
  '其实', '可能', '应该', '如果', '哈哈', '呵呵', '好的', '收到', '谢谢', '请问',
  '帮我', '告诉', '东西', '事情', '时候', '的话', '了吧', '了吗', '行吧', '好吧',
])

export interface ReplyKbQuery {
  /** 原句上下文，优先交给语义向量通道。 */
  semantic: string
  /** 去停用词后的内容词，交给 FTS5 稀疏通道。 */
  lexical: string
}

export interface ReplyKbSnippetResult {
  snippets: string[]
  /** 未命中/降级原因；命中正常时为空串。 */
  note: string
}

export interface CollectReplyKbSnippetsInput {
  decryptedDir: string
  kbId: number
  lines: readonly string[]
  latestPeer?: string
  topK?: number
  makeEmbedFn: (model: string, feature: 'kb_embed') => EmbedFn | undefined
  kbModel: (kbId: number, role: 'embed') => { model: string }
}

function normalizeLine(line: string): string {
  return String(line)
    .replace(/^\s*(?:我|对方|[^：:\n]{1,24})\s*[：:]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function clipTail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max)
}

/**
 * 从推荐回复的对话上下文构造双通道查询。
 * @param lines - `collectReplyContext` 产出的“我/对方：...”行。
 * @param latestPeer - 对方最后一句（用于确保它不因上下文截断而丢失）。
 * @returns semantic/lexical 两种查询。
 */
export function buildReplyKbQuery(lines: readonly string[], latestPeer = ''): ReplyKbQuery {
  const recent = lines
    .slice(-RECENT_LINE_LIMIT)
    .map(normalizeLine)
    .filter((line) => line !== '')
    .map((line) => (line.length <= MAX_LINE_CHARS ? line : line.slice(-MAX_LINE_CHARS)))

  const tail = normalizeLine(latestPeer)
  if (tail !== '' && !recent.some((line) => line.endsWith(tail))) recent.push(tail)

  const semantic = clipTail(recent.join('；'), MAX_SEMANTIC_CHARS)
  const counts = new Map<string, { count: number; order: number }>()
  for (const token of bigramTokens(recent.join(' ')).split(/\s+/)) {
    const term = token.trim().toLowerCase()
    if (term.length < 2 || STOP_BIGRAMS.has(term)) continue
    const prev = counts.get(term)
    if (prev === undefined) counts.set(term, { count: 1, order: counts.size })
    else prev.count += 1
  }

  const ranked = [...counts.entries()]
    .sort((a, b) => {
      const aLatin = /^[a-z0-9][a-z0-9_.+-]*$/i.test(a[0]) ? 1 : 0
      const bLatin = /^[a-z0-9][a-z0-9_.+-]*$/i.test(b[0]) ? 1 : 0
      // 型号、产品名、英文缩写通常比普通二字词更有区分度；同权重按出现次数，再按原顺序。
      const score = (latin: number, count: number): number => latin * 8 + Math.min(count, 4) * 2
      return score(bLatin, b[1].count) - score(aLatin, a[1].count) || a[1].order - b[1].order
    })
    .slice(0, MAX_LEXICAL_TERMS)
    .map(([term]) => term)

  return { semantic, lexical: ranked.join(' ') }
}

function snippetOf(hit: ChannelHit): string {
  const name = String(hit.doc.name || hit.doc.kb?.fileName || '').trim()
  const text = String(hit.doc.snippet || hit.doc.text || '').replace(/\s+/g, ' ').trim()
  if (text === '') return ''
  return `《${name || '知识库文件'}》${text}`
}

/**
 * 使用与问答链路相同的知识库混合检索，为推荐回复取证据片段。
 * @param input - 会话上下文、目标库与模型注入。
 * @returns 最多 `topK` 段带文件名的片段，以及未命中时的真实原因。
 */
export async function collectReplyKbSnippetsHybrid(
  input: CollectReplyKbSnippetsInput,
): Promise<ReplyKbSnippetResult> {
  const kbId = Math.trunc(Number(input.kbId))
  if (!Number.isFinite(kbId) || kbId <= 0) return { snippets: [], note: '没有指定知识库' }

  const query = buildReplyKbQuery(input.lines, input.latestPeer)
  if (query.semantic === '' && query.lexical === '') return { snippets: [], note: '没有可检索的对话上下文' }

  const cfg = loadRetrievalConfig(input.decryptedDir)
  if (!cfg.enabled || !cfg.channels.kb.enabled) {
    return { snippets: [], note: '知识库检索通道已关闭' }
  }

  const embedModel = cfg.embedding.enabled ? input.kbModel(kbId, 'embed').model.trim() : ''
  const embedFn = cfg.channels.dense.enabled && embedModel !== ''
    ? input.makeEmbedFn(embedModel, 'kb_embed')
    : undefined
  const topK = Math.max(1, Math.min(Math.trunc(input.topK ?? 3), 5))
  const result = await kbChannel(input.decryptedDir, kbId, query.semantic, topK, {
    ...(query.lexical !== '' ? { sparseQuery: query.lexical } : {}),
    ...(embedFn !== undefined
      ? { embedFn, denseEnabled: true, embedModel }
      : {}),
    minSimilarity: cfg.channels.dense.minSimilarity,
    candidatePool: cfg.channels.dense.candidatePool,
    fusionK: cfg.fusion.k,
  })

  return {
    snippets: result.hits.map(snippetOf).filter((snippet) => snippet !== ''),
    note: result.note ?? '',
  }
}
