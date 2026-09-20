/**
 * 知识库检索评估（G-08 的落点）—— 把「知识库搜得好不好」从主观感受变成可回归的数字。
 *
 * ── 为什么必须另起一套（而不是复用 eval-dataset.ts）───────────────────────────
 * `eval-dataset.ts` 评的是**聊天消息**检索：语料是内联在源码里的合成消息，检索适配器
 * 复现「融合 + 重排」。知识库的单元完全不同：单元是**文件块**、语料是磁盘上的真文件、
 * 走的是 `kb-search.ts` 的 FTS5 路径（`ftsPhrase` 把词编成连续 bigram 短语）。
 * 把两者混在一个数据集里，任一侧的改动都会让另一侧的指标漂移，谁也说不清是谁退化了。
 *
 * ── 语料为什么是「真夹具文件」──────────────────────────────────────────────
 * 真实微信数据隐私敏感、分布漂移，不能作为可提交的回归基准；但**合成字符串**又测不出
 * 解析与分块的真实行为（多块切点、CSV 表头重复、GB18030 解码）。折中是：在
 * `src/backend/wechat-data/tests/fixtures/kb-eval/` 放一组固定的真文件，测试把它们
 * 经 `registerKbFile` 写进临时数据根 —— 走的是与线上**逐字节相同**的
 * 「读字节 → 解析 → 分块 → 落 chunk + FTS」路径。
 *
 * ── ground truth 两层，缺一不可 ────────────────────────────────────────────
 *   · **块级**（`markers`）：答案所在的那一块里独有的字符串。它答的是「答案排多前」
 *     （MRR 是这一层最有意义的指标；Precision@10 在「一个答案块 vs 九个正常块」的
 *     场景里天然偏低，别拿它当主指标）。
 *   · **文件级**（`expectFiles`）：答案所在文件。它答的是「那份文件找到了吗」——
 *     用户真正在意的一层，且对分块口径的变动不敏感（换切点不影响文件名）。
 *   两层一起看才能区分「没找到文件」与「找到了文件但那一块没排上来」。
 *
 * ── 检索适配必须复现流水线的 query 构造 ─────────────────────────────────────
 * `pipeline.ts` 的知识库通道传的是 `plan.terms.slice(0, 12).join(' ')`，**不是原问题**。
 * 原因见该处注释：`kb-search` 用 `ftsPhrase` 把每个词编成「连续 bigram 短语」，
 * 把整句问题当一个词传进去就成了要求文件里逐字出现这一整句 —— 正常提问必然 0 命中。
 * 本文件的 `kbEvalRetrieve` 逐字复现这条构造，否则评的是一个不存在的检索器。
 */
import type { KbHit } from '../../types.ts'
import { searchKb } from '../kb-search.ts'
import { defaultPolicyFor } from './config.ts'
import { evaluate, formatEvalReport, type EvalCase, type EvalReport } from './eval.ts'
import { classifyIntent } from './intent.ts'
import { kbDocKey } from './kb-channel.ts'
import { buildQueryPlan } from './rewrite.ts'

/**
 * 评估集夹具文件名（相对 `src/backend/wechat-data/tests/fixtures/kb-eval/`）。
 *
 * 测试会断言「磁盘上的文件集合 == 这张表」：少一个夹具时用例会以「找不到文件」当场报红，
 * 而不是静默退化成「这个库只有 6 个文件」之后指标悄悄变好。
 * `玄武纪要.md` 不在任何用例的 ground truth 里 —— 它属于**另一个知识库**，
 * 只服务于「同一问题在乙库检索不到甲库的块」这条隔离断言的反向一半。
 */
export const KB_EVAL_FIXTURES = [
  '蓝鲸合同.md',
  '合作台账.csv',
  '会议纪要-九月.txt',
  '行业规范摘录.md',
  '客户拜访记录.md',
  '旧版合同草稿.md',
  '押金说明-棠樾.txt',
  '玄武纪要.md',
] as const

/** 一个知识库评测用例。 */
export interface KbEvalCase {
  id: string
  question: string
  /** 模拟规划器给出的关键词（真实链路里这一步一定发生，见 rewrite.ts）。 */
  subQueries?: string[]
  /** 块级 ground truth：**只**可能出现在正确答案那一块里的字符串。 */
  markers: string[]
  /** 文件级 ground truth：答案所在文件。 */
  expectFiles: string[]
  /**
   * 该用例在**稀疏基线**下期望一块都召不回来。
   *
   * 这不是「许愿」，是**量化缺口**：第 9 条用例问的东西文件里确实有答案，只是用词
   * 与问法字面不通（问「滞留期有多长」、文件写「押金留存时间」）。稀疏通道给 0 分是
   * 真实且必然的 —— 它记录的就是稠密通道（T4 / G-02）要抬起来的那一格。
   * 稠密上线后这条断言必须变红，届时改成「>0」并刷新 `docs/KB-EVAL-BASELINE.md`：
   * 那次翻红就是「语义召回真的补上了字面不通的缺口」的唯一证据。
   */
  expectNoHit?: boolean
  /** 这条用例难在哪（写进基线报告，别让后人只看 id 猜）。 */
  note?: string
}

/**
 * 评测用例（8 组难例 + 1 条量化缺口的用例）。
 *
 * 难例的选择标准：**都是真实场景里踩过的坑**，且每一组都对应分块/索引的一处具体行为
 * （末块、标题行、CSV 跨组、表头重复、非 UTF-8、实体+属性、纯数字），
 * 而不是「随便问一句看排第几」。
 */
export const KB_EVAL_CASES: KbEvalCase[] = [
  {
    id: 'md-late-chunk',
    question: '钿螺壳纹装饰面板的验收款是多少',
    subQueries: ['钿螺壳纹', '验收款', '付款'],
    markers: ['钿螺壳纹'],
    expectFiles: ['蓝鲸合同.md'],
    note: '长合同里独有短语只出现在**最后一块**：末块没进索引这里就是 0 命中。'
      + '同库还放着「旧版合同草稿」（同样有附则与验收款，金额不同）与「行业规范摘录」'
      + '（塞满合同/验收款这类词）两个干扰项 —— 它们会被召回但不相关，正好检验'
      + '高区分度的短语词项能不能把真正的答案块顶到前面。',
  },
  {
    id: 'md-section-title',
    question: '鲸落测绘的服务范围是怎么约定的',
    subQueries: ['鲸落测绘', '服务范围'],
    markers: ['鲸落测绘'],
    expectFiles: ['蓝鲸合同.md'],
    note: '整词只出现在小节标题里（正文只写「测绘记录」）：标题行不进索引就会漏。',
  },
  {
    id: 'csv-late-group',
    question: '赭石鎏金文创的回款状态是什么',
    subQueries: ['赭石鎏金', '回款状态'],
    markers: ['赭石鎏金'],
    expectFiles: ['合作台账.csv'],
    note: '表格按 40 行一组分块，这一行落在**最后一组**（第 131 行）：跨组召回。',
  },
  {
    id: 'csv-header-only',
    question: '合作台账里合同金额这一列记的是什么',
    subQueries: ['合同金额', '台账'],
    markers: ['合同金额'],
    expectFiles: ['合作台账.csv'],
    note: '列名只在每块首行的表头里出现（数据行不带列名）：能命中说明表头被重复写进了每一块。',
  },
  {
    id: 'txt-late-chunk',
    question: '鹧鸪斑釉打样的结论是什么',
    subQueries: ['鹧鸪斑釉', '打样'],
    markers: ['鹧鸪斑釉'],
    expectFiles: ['会议纪要-九月.txt'],
    note: '纯文本长文，结论写在文末（同样只出现在末块），前面全是无关的会议事项。',
  },
  {
    id: 'entity-attribute',
    question: '苍梧县那个客户留的电话号码是多少',
    subQueries: ['苍梧县', '电话', '号码'],
    markers: ['苍梧县'],
    expectFiles: ['客户拜访记录.md'],
    note: '实体 + 属性：问的是地名/人，答案是一条带标签的事实（联系电话）。',
  },
  {
    id: 'gb18030-file',
    question: '棠樾牌坊群项目的保证金是怎么约定的',
    subQueries: ['棠樾牌坊群', '保证金'],
    markers: ['棠樾牌坊群'],
    expectFiles: ['押金说明-棠樾.txt'],
    note: 'GB18030 落盘的文件：解码错了这一块根本进不了索引，这里必然 0 命中。',
  },
  {
    id: 'digit-only',
    question: '13909876543 是谁留的号码',
    subQueries: [],
    markers: ['13909876543'],
    expectFiles: ['客户拜访记录.md'],
    note: '纯数字查询：数字整段（11 位）会被 `extractAskTerms` 原样当作词项，'
      + '命中要求整段连续出现 —— 同文件里还放了一个 0571 开头的座机号当对照。',
  },
  {
    id: 'multi-block-same-file',
    question: '押金和保证金分别是怎么约定的',
    subQueries: ['押金', '保证金'],
    markers: ['押金留存', '棠樾牌坊群'],
    expectFiles: ['押金说明-棠樾.txt'],
    note: '答案**横跨同一文件的两块**（押金在第一块、保证金在第二块）：只召回一块意味着'
      + '答案不完整。这是 recall 真正有区分度的一条 —— 其余用例的答案都只在一块里。',
  },
  {
    id: 'sparse-gap',
    question: '滞留期有多长',
    subQueries: ['滞留期'],
    markers: ['押金留存'],
    expectFiles: ['押金说明-棠樾.txt'],
    expectNoHit: true,
    note: '⚠ 基线**期望 0 命中**：问法与文件用词字面不通（滞留期 vs 押金留存），'
      + '同义词表也覆盖不到。这就是稀疏检索的天花板，也是 C 阶段（稠密通道）要抬起来的一格。',
  },
]

/** `kbEvalRetrieve` 的可选参数。 */
export interface KbEvalRetrieveOptions {
  /** 通道配额覆盖；不给则按用例意图取策略默认（与流水线一致）。 */
  topK?: number
  /** 已知实体名（影响意图分类）；默认空数组（测试没接联系人表）。 */
  knownEntities?: string[]
  /** 固定「现在」（只影响相对时间解析，本评估集没有时间问法）。 */
  now?: Date
}

/** 一条用例的检索明细（既给断言用，也给基线报告用）。 */
export interface KbEvalRetrieval {
  /** 实际发给 `searchKb` 的查询串（`plan.terms.slice(0,12).join(' ')`）。 */
  query: string
  /** 完整词表（调试用：看 query 是从哪里截断的）。 */
  terms: string[]
  /** 规则判定的意图（决定通道配额）。 */
  intent: string
  /** 本次生效的配额。 */
  topK: number
  hits: KbHit[]
  /** 有序命中键 `kb:<kbId>:<chunkId>`。 */
  docKeys: string[]
  error?: string
  readError?: string
}

/** 有序命中的精简形状（避免把整块正文带进报告）。 */
export interface KbEvalHitRef {
  key: string
  file: string
  ordinal: number
}

/** 一个标记词落在哪个名次 / 哪一块（没召回到 `rank = 0`）。 */
export interface KbEvalMarkerHit {
  marker: string
  /** 1 起的名次；0 = 没召回到。
   *  一条用例有多个标记词时，这个数组就是「答案横跨多块时每一块是否都到了」的直接证据。 */
  rank: number
  /** 命中块的 ordinal（`-1` = 没召回到）。 */
  ordinal: number
  file: string
}

/** 单用例明细。 */
export interface KbEvalCaseDetail {
  id: string
  intent: string
  topK: number
  query: string
  rawHits: number
  /** 去重后的文件名（保持名次顺序）。 */
  files: string[]
  /** 前三个文件（用来断言「干扰项没有抢走首位」）。 */
  topFiles: string[]
  ordered: KbEvalHitRef[]
  expectedFiles: string[]
  /** 每个标记词各落在第几名（见 `KbEvalMarkerHit`）。 */
  markerHits: KbEvalMarkerHit[]
  /** 块级第一个相关块的名次（1 起）；没召回到相关块为 null。 */
  firstRelevantRank: number | null
  /** 块级第一个相关块的 ordinal；没有为 null。 */
  firstRelevantOrdinal: number | null
  /** 该用例是否期望 0 命中（见 `KbEvalCase.expectNoHit`）。 */
  noHitExpected: boolean
}

/** `runKbEval` 的入参。 */
export interface KbEvalOptions extends KbEvalRetrieveOptions {
  /** 知识库 id；缺省 1（= `notes.ts` 的 `DEFAULT_KB_ID`）。 */
  kbId?: number
  /** 截断位置（与 eval.ts 一致，默认 10）。 */
  k?: number
  /** 用例集覆盖（默认 `KB_EVAL_CASES`）。 */
  cases?: KbEvalCase[]
}

/** 一次评估的完整结果。 */
export interface KbEvalResult {
  kbId: number
  k: number
  /** 块级报告（ground truth = `markers`，走 `textIndex` 文本片段匹配）。 */
  chunk: EvalReport
  /** 文件级报告（ground truth = `expectFiles`，按文件名精确匹配，已按名次去重）。 */
  file: EvalReport
  details: KbEvalCaseDetail[]
}

/**
 * 在**当前库**上跑一条用例的检索，复现流水线的 query 构造。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 知识库 id。
 * @param c - 评测用例。
 * @param opts - 配额 / 实体 / 现在。
 * @returns 检索明细。
 */
export function kbEvalRetrieve(
  decryptedDir: string,
  kbId: number,
  c: KbEvalCase,
  opts: KbEvalRetrieveOptions = {},
): KbEvalRetrieval {
  const decision = classifyIntent(c.question, opts.knownEntities ?? [])
  const policy = defaultPolicyFor(decision.intent)
  const topK = Number.isFinite(opts.topK) && (opts.topK ?? 0) > 0 ? (opts.topK as number) : policy.channelTopK.kb
  const plan = buildQueryPlan({ question: c.question, subQueries: c.subQueries, now: opts.now })
  // ★ 与 pipeline.ts 的知识库通道调用点**逐字一致**（含 12 这个截断位置）。
  const query = plan.terms.slice(0, 12).join(' ')
  // onlyRag:true 与问答路径一致（见 kb-channel.ts）：评测要评的是「问答真的会看到的那些块」。
  const res = searchKb(decryptedDir, kbId, { query, topK, onlyRag: true })
  return {
    query,
    terms: plan.terms,
    intent: decision.intent,
    topK,
    hits: res.hits,
    docKeys: res.hits.map(h => kbDocKey(kbId, h.chunkId)),
    ...(res.error ? { error: res.error } : {}),
    ...(res.readError ? { readError: res.readError } : {}),
  }
}

/** 保序去重。 */
function dedupe(list: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const v of list) {
    if (seen.has(v)) continue
    seen.add(v)
    out.push(v)
  }
  return out
}

/** 用例 → eval.ts 的用例形状（相关集可以是 mark 也可以是文件名）。 */
function toEvalCase(c: KbEvalCase, relevant: string[]): EvalCase {
  return { id: c.id, question: c.question, ...(c.subQueries ? { subQueries: c.subQueries } : {}), relevant }
}

/**
 * 跑一遍知识库评估集。
 *
 * 同一次调用里出两份报告（块级 / 文件级），共用同一批检索结果 —— 检索只跑一次
 * （`memo` 保证两个 retrieve 闭包不会各查一遍库）。
 * @param decryptedDir - 解密数据根（`wechat_kb_files.db` 在它的父目录）。
 * @param opts - 见 KbEvalOptions。
 * @returns 两份报告 + 逐用例明细。
 */
export function runKbEval(decryptedDir: string, opts: KbEvalOptions = {}): KbEvalResult {
  const kbId = Number.isFinite(opts.kbId) && (opts.kbId ?? 0) > 0 ? (opts.kbId as number) : 1
  const k = opts.k ?? 10
  const cases = opts.cases ?? KB_EVAL_CASES
  const byId = new Map(cases.map(c => [c.id, c]))
  const memo = new Map<string, { r: KbEvalRetrieval; ordered: KbEvalHitRef[]; files: string[] }>()
  // 块级相关度靠「命中块的文本里含这个标记词」判定 —— 值取「文件名 + 标题 + 块正文」。
  //
  // ⚠ 标题必须算进来：`kb-search` 的 `h.text` **不含标题行**（Markdown 的 `# / ##` 被
  // 抽到 `heading` 列单独索引），只取 `h.text` 会让「术语只出现在小节标题里」的用例
  // 永远判成不相关 —— 那是**测量口径**的锅，不是检索的锅（该块其实被召回了）。
  // 文件名也要算：让同一份 ground truth 同时可对上文件级与块级。
  const textIndex = new Map<string, string>()

  const run = (c: KbEvalCase): { r: KbEvalRetrieval; ordered: KbEvalHitRef[]; files: string[] } => {
    const cached = memo.get(c.id)
    if (cached) return cached
    const r = kbEvalRetrieve(decryptedDir, kbId, c, { topK: opts.topK, now: opts.now, knownEntities: opts.knownEntities })
    const ordered: KbEvalHitRef[] = r.hits.map((h, i) => ({
      key: r.docKeys[i] as string,
      file: h.fileName,
      ordinal: h.ordinal,
    }))
    // textIndex 在检索时就地补齐 —— `evaluate()` 的相关度扩展发生在 retrieve 返回**之后**，
    // 所以这里写进去的键必然已就绪。补齐的也只有本次召回到的块：没召回的块永远不会出现在
    // `retrieved` 里，为它建索引对指标没有任何影响。
    r.hits.forEach((h, i) => textIndex.set(
      r.docKeys[i] as string,
      [h.fileName, h.heading, h.text || h.snippet].filter(Boolean).join('\n'),
    ))
    const entry = { r, ordered, files: dedupe(ordered.map(o => o.file)) }
    memo.set(c.id, entry)
    return entry
  }

  const chunk = evaluate(cases.map(c => toEvalCase(c, c.markers)), c => {
    const kc = byId.get(c.id)
    return kc ? run(kc).r.docKeys : []
  }, { k, textIndex })

  const file = evaluate(cases.map(c => toEvalCase(c, c.expectFiles)), c => {
    const kc = byId.get(c.id)
    return kc ? run(kc).files : []
  }, { k })

  const details: KbEvalCaseDetail[] = cases.map((c) => {
    const { r, ordered, files } = run(c)
    const relSet = new Set(c.markers)
    const hitsText = (o: KbEvalHitRef): string => textIndex.get(o.key) ?? ''
    const markerHits: KbEvalMarkerHit[] = c.markers.map((m) => {
      for (let i = 0; i < ordered.length; i += 1) {
        const o = ordered[i] as KbEvalHitRef
        if (relSet.has(o.key) || (m !== '' && hitsText(o).includes(m))) {
          return { marker: m, rank: i + 1, ordinal: o.ordinal, file: o.file }
        }
      }
      return { marker: m, rank: 0, ordinal: -1, file: '' }
    })
    const found = markerHits.filter(m => m.rank > 0).sort((a, b) => a.rank - b.rank)
    const first = found[0]
    return {
      id: c.id,
      intent: r.intent,
      topK: r.topK,
      query: r.query,
      rawHits: ordered.length,
      files,
      topFiles: files.slice(0, 3),
      ordered,
      expectedFiles: c.expectFiles,
      markerHits,
      firstRelevantRank: first ? first.rank : null,
      firstRelevantOrdinal: first ? first.ordinal : null,
      noHitExpected: c.expectNoHit === true,
    }
  })

  return { kbId, k, chunk, file, details }
}

/**
 * 把结果格式化成可读多行文本（写进基线报告 / 操作日志）。
 * @param name - 评估集名。
 * @param r - 结果。
 * @param k - 截断位置（缺省用结果自带的）。
 * @returns 多行文本。
 */
export function formatKbEvalReport(name: string, r: KbEvalResult, k: number = r.k): string {
  const lines = [
    formatEvalReport(name + '｜块级（答案块排多前）', r.chunk, k),
    formatEvalReport(name + '｜文件级（那份文件找到了吗）', r.file, k),
    '',
    '  用例                  意图             配额  召回  首相关块  命中的文件（前 3）',
  ]
  for (const d of r.details) {
    lines.push([
      '  ' + d.id.padEnd(20),
      d.intent.padEnd(16),
      String(d.topK).padStart(4),
      String(d.rawHits).padStart(5),
      (d.firstRelevantRank === null ? '—' : '第' + d.firstRelevantRank + '名').padStart(9),
      '  ' + d.topFiles.join('，'),
    ].join(''))
  }
  lines.push('', '  实发 query（= plan.terms 前 12 个，与流水线逐字一致）')
  for (const d of r.details) lines.push('  ' + d.id.padEnd(20) + '  ' + d.query)
  return lines.join('\n')
}
