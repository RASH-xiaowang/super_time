/**
 * 知识库文件块通道（`ChannelName = 'kb'`）—— 把 `kb-search.ts` 的命中
 * 适配成检索流水线的统一文档形状。
 *
 * ── 为什么需要一个适配层，而不是让 kb-search 直接返回 RetrievedDoc ──────────
 *   依赖方向必须单向：`retrieval/` 是**编排层**，`kb-search.ts` 是**读路径**。
 *   若让 `kb-search.ts` 去 import `retrieval/types.ts`，读路径就被绑死在编排层上，
 *   而 `retrieval/` 里的融合权重、通道枚举都还在演进 —— 改一次权重签名就要动读路径。
 *   放在中间的适配层把「知识库检索长什么样」与「检索流水线要什么」彻底解耦。
 *
 * ── 本文件唯一的硬不变量：docKey 的格式 ────────────────────────────────
 *   **`kb:<kbId>:<chunkId>`，只能由 `kbDocKey()` 产出。**
 *   理由有三，缺一条都会静默出错：
 *     ① 与消息键 `username:local_id` 天然不冲突（消息键不含 `kb:` 前缀）；
 *     ② 反馈归因靠它把「用户标为有用的第 [n] 条」对应回特征向量
 *        （`gateway` 落 trace 时用 `citationDocKey()`，与本函数的产物必须逐字相同）；
 *     ③ 融合去重靠它把同一块在多通道的命中合并成一条。
 *   因此**不要在别处手拼这个字符串**（含前缀、分隔符、顺序）。
 *
 * ── create_time 为什么是 0 ──────────────────────────────────────────────
 *   文件块没有「发生时间」。0 在本项目里已经是「无时间」的哨兵：`formatDay` /
 *   `formatClock` / `inRange` / `inSoft` 全部按 0 判空。给一个假时间戳
 *   （如 now）会立刻制造三类错误：新鲜度衰减把文件算成「刚发生的事」、
 *   软时间范围把文件算成「落在你说的那周里」、窗口展开按这个时间去翻聊天记录。
 */
import type { KbHit, KbChannelName, KbSearchResult } from '../../types.ts'
import type { ChannelHit, ChannelResult, RetrievedDoc } from './types.ts'
import { searchKb } from '../kb-search.ts'
import { searchKbDense } from '../kb-vectors.ts'
// `EmbedFn` 从**真源**取（`vector-math.ts`）：`embedding.ts` 只是把它再导出一次，
// 而 `embedding.ts` 是消息域的稠密层 —— 知识库侧不该为了一个类型依赖消息域。
import type { EmbedFn } from '../vector-math.ts'

/**
 * 知识库块的全局去重 / 归因键（**唯一产出点**，不要在别处手拼）。
 * @param kbId - 知识库 id。
 * @param chunkId - 块 id。
 * @returns `kb:<kbId>:<chunkId>`。
 */
export function kbDocKey(kbId: number, chunkId: number): string {
  return 'kb:' + kbId + ':' + chunkId
}

/**
 * 引用 → 反馈归因键。
 *
 * 消息引用是 `username:local_id`（与 `RetrievedDoc.docKey` 同构），
 * 知识库引用是 `kb:<kbId>:<chunkId>`（同上）。两处必须是同一套规则，否则
 * 「这条引用有用」会归因不到任何特征向量上 —— 而且**不报错**，只是调参永远不动。
 * @param c - 引用（或引用形状的对象）。
 * @returns 归因键；KB 引用缺 `kb` 明细时退化为空串（宁可归因不到，也不要错配到别人身上）。
 */
export function citationDocKey(c: {
  source?: 'msg' | 'kb'
  username?: string
  local_id?: number
  kb?: { kbId: number; chunkId: number }
}): string {
  if (c.source === 'kb') {
    const kb = c.kb
    return kb ? kbDocKey(kb.kbId, kb.chunkId) : ''
  }
  return (c.username ?? '') + ':' + (c.local_id ?? 0)
}

/**
 * 一条知识库命中 → 统一文档。
 *
 * `username` 用 `kb:<kbId>:<fileId>`（**按文件分组**，不是按库、也不是空串）：
 *   · 空串会让同一库里所有块看起来「同会话」，压缩阶段选了一个块就会把 ±15 分钟
 *     窗口内其余块全部当作「这段对话已经进上下文了」而跳过 —— 只剩一条；
 *   · 按库分组同样错误（文件之间没有共同语境）；
 *   · 按文件分组正好等于「同源」的语义，与去重要求一致。
 *   前缀 `kb:` 保证与真实会话 username 不可能相撞（微信 username 不以 `kb:` 开头）。
 * @param kbId - 命中所在知识库。
 * @param h - 检索命中。
 * @returns 统一文档。
 */
export function kbDocFromHit(kbId: number, h: KbHit): RetrievedDoc {
  return {
    docKey: kbDocKey(kbId, h.chunkId),
    username: 'kb:' + kbId + ':' + h.fileId,
    // name 只放文件名：界面要把它与面包屑分开展示（`知识库文件 合同.pdf · 第 3 节`），
    // 合并成一个字符串后界面只能整体显示或自己做字符串切割，两种都不好。
    name: h.fileName,
    local_id: 0,
    create_time: 0,
    // text 是块全文（kb-search 随命中一并返回）：重排的词覆盖率要在全文上判命中，
    // 只拿 snippet（命中词前后各 60 字）会把落在窗口外的检索词误判为未命中。
    text: h.text || h.snippet,
    snippet: h.snippet,
    source: 'kb',
    kb: {
      kbId,
      fileId: h.fileId,
      fileName: h.fileName,
      fileExt: h.fileExt,
      chunkId: h.chunkId,
      ordinal: h.ordinal,
      page: h.page,
      heading: h.heading,
    },
  }
}

function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

/**
 * RRF 平滑常数（`config.fusion.k` 的出厂值）。调用方应显式传入，避免两处漂移。
 */
const DEFAULT_FUSION_K = 60

/** 知识库通道的选项：**全都不传 = T3 那条纯关键词老路**（降级说明会如实说「仅关键词」）。 */
export interface KbChannelOptions {
  /**
   * embedding 函数。缺省 ⇒ 稠密子路径不跑。
   *
   * ⚠ 传进来只代表「**有能力**」，是否**该**跑还要看 `denseEnabled`（见下）。
   */
  embedFn?: EmbedFn
  /**
   * 稠密子路径是否启用。
   *
   * 由 `pipeline` 按 `config.embedding.enabled && config.channels.dense.enabled &&
   * policy.channels.includes('dense')` 判定后传进来 —— **刻意不在这里自己读 config**：
   * 本文件是适配层，不该知道检索配置的形状（见头注的依赖方向），判定留在编排层。
   */
  denseEnabled?: boolean
  /**
   * 与 `embedFn` 同一个解析出来的模型名。
   *
   * 缺省（空串）时稠密一路会**主动不可用**：没有它就没法判「库里这批向量是不是
   * 本次这个模型算的」，而硬算余弦会得到一个看起来正常、实际没有意义的排序。
   */
  embedModel?: string
  /** 稠密召回的最低余弦相似度（低于它直接丢）。 */
  minSimilarity?: number
  /** SimHash 粗筛保留多少候选参与精确计算。 */
  candidatePool?: number
  /** RRF 平滑常数；应与 `config.fusion.k` 一致。 */
  fusionK?: number
}

/** 融合后的一条命中。 */
export interface FusedKbHit {
  hit: KbHit
  /** 融合分（RRF 累加值）。**只用于本通道内部排序**：跨通道融合仍只看名次（见 `fusion.ts`）。 */
  score: number
}

/**
 * 把稀疏与稠密两路命中合成一条有序列表（**纯函数**：不碰 IO、不读配置）。
 *
 * 用 RRF（每个名次贡献 `1/(k+rank)`、多路命中**累加**）而不是分数加权：
 * BM25 无上界、余弦在 [-1,1]，加权必须先归一化，而归一化对异常值极敏感 ——
 * 与消息域 `fusion.ts` 同一套理由、同一个 `k`（由调用方从 `config.fusion.k` 传入）。
 *
 * 同一块被两路同时命中 ⇒ 分数累加（这正是「一致性」信号），并且**保留稀疏那一份**：
 * 稀疏命中的 `marks` 是真的高亮区间，稠密那份恒为空数组（稠密没有「命中词」可言）。
 * 取稠密那份的后果是界面上「搜到了，却一个词都没高亮」。
 * @param sparseHits - 稀疏（FTS5 bm25）命中，顺序即名次。
 * @param denseHits - 稠密命中，顺序即名次（`ranks.dense` 有值时以它为准）。
 * @param opts - `k` = RRF 平滑常数。
 * @returns 按融合分降序的命中（每条的 `ranks` 记下它在各路的原始名次）。
 */
export function fuseKbHits(sparseHits: readonly KbHit[], denseHits: readonly KbHit[], opts: { k?: number } = {}): FusedKbHit[] {
  const rawK = Number(opts.k)
  const k = Number.isFinite(rawK) && rawK >= 0 ? rawK : DEFAULT_FUSION_K
  const acc = new Map<number, { sparse?: { hit: KbHit; rank: number }; dense?: { hit: KbHit; rank: number } }>()
  const put = (side: 'sparse' | 'dense', hit: KbHit, rank: number): void => {
    const id = Math.trunc(Number(hit.chunkId))
    if (!Number.isFinite(id) || id <= 0) return
    const e = acc.get(id) ?? {}
    const prev = e[side]
    // 同一路对同一个块给了多次时只认最好名次（与 `fusion.ts` 对同一文档的处理一致）。
    if (prev === undefined || rank < prev.rank) e[side] = { hit, rank }
    acc.set(id, e)
  }
  sparseHits.forEach((h, i) => put('sparse', h, i + 1))
  denseHits.forEach((h, i) => {
    const r = Number(h.ranks?.dense ?? 0)
    put('dense', h, r > 0 ? r : i + 1)
  })

  const out: FusedKbHit[] = []
  for (const e of acc.values()) {
    const ranks: Partial<Record<KbChannelName, number>> = {}
    if (e.sparse) ranks.sparse = e.sparse.rank
    if (e.dense) ranks.dense = e.dense.rank
    const base = (e.sparse?.hit ?? e.dense?.hit) as KbHit
    out.push({
      hit: { ...base, ranks },
      score: (e.sparse ? 1 / (k + e.sparse.rank) : 0) + (e.dense ? 1 / (k + e.dense.rank) : 0),
    })
  }
  // 分数降序；同分只在「两路名次组合相同」时发生（各条分别来自同一个块，不会），
  // 仍用 chunkId 兜一个确定序，保证同样的输入永远给出同样的输出。
  out.sort((a, b) => (b.score - a.score) || (a.hit.chunkId - b.hit.chunkId))
  return out
}

/**
 * 知识库通道：在**当前库**内做「关键词（FTS5 bm25）+ 语义（向量余弦）」的混合召回。
 *
 * ── 两路各跑各的、互不阻断 ─────────────────────────────────────────────
 *   这是混合检索的全部意义。旧实现（T3 只有一条路）把 `searchKb` 抛错/读库失败
 *   当成「整条通道不可用」直接返回 —— 那在只有一条路时是对的；有了第二条路之后，
 *   关键词索引坏掉就让语义召回一起陪葬，没有任何理由。
 *   两路都可能给出 0 条，最终 `active` 只看合并后的条数。
 *
 * ── 降级说明必须如实（两条分支互斥）──────────────────────────────────
 *   · 稠密**跑过** ⇒ 只报它这次真遇到的问题（未建索引 / embedding 失败 / 维度不符），
 *     绝不再透传「仅关键词（未建向量索引）」：索引是就绪的、也查过了，
 *     那句话在这条分支上就是假话；
 *   · 稠密**没跑**（没注入 embedding / 通道关闭）⇒ 说清是**哪一种**没跑
 *     （「未配置向量模型」/「本次未启用向量通道」）。**不照抄**稀疏侧那句
 *     「未建向量索引」：索引已建好、只是这次没让它跑时，照抄出来就是一句假话。
 *
 * 出网：稀疏一路全程本机；稠密一路会把**查询文本**送去 embedding 端点
 * （不送库里的正文 —— 正文只在建库时出网一次，且只送 `include_in_rag = 1` 的文件）。
 * `onlyRag:true` 把文件级开关下推到 SQL，保证「不许送进模型」的文件连候选都进不来。
 * @param decryptedDir - 解密数据根。
 * @param kbId - 当前知识库；缺失/非法时通道不参与。
 * @param query - 检索词（沿用消息侧同一份改写结果，见 pipeline 的调用点）。
 * @param topK - 最多取多少块。
 * @param opts - 见 {@link KbChannelOptions}；不传即纯关键词。
 * @returns 通道结果（`hits` 已按融合分排序、`rank` 重新编为 1..n）。
 */
export async function kbChannel(
  decryptedDir: string,
  kbId: number | undefined,
  query: string,
  topK: number,
  opts: KbChannelOptions = {},
): Promise<ChannelResult> {
  if (!Number.isFinite(kbId) || (kbId ?? 0) <= 0) {
    return { channel: 'kb', hits: [], active: false, note: '本次提问未指定知识库' }
  }
  const q = (query ?? '').trim()
  if (q === '') return { channel: 'kb', hits: [], active: false, note: '无检索词' }
  if (!Number.isFinite(topK) || topK <= 0) return { channel: 'kb', hits: [], active: false, note: '通道配额为 0' }

  const kb = kbId as number
  const embed = opts.embedFn
  const useDense = opts.denseEnabled === true && typeof embed === 'function'

  // 稀疏一路。**包在 try 里**：`searchKb` 是同步的，它抛错时不能连累稠密那一路。
  const sparseTask = (async (): Promise<{
    hits: KbHit[]
    failed?: string
    /** 稀疏侧自报的降级。带 `reason` 是因为要判断这句说明在**本次**场景下是不是真话。 */
    degraded?: { reason: string; label: string }
  }> => {
    try {
      const res: KbSearchResult = searchKb(decryptedDir, kb, { query: q, topK, onlyRag: true })
      // 三种「没搜成」必须分开报，别合并成一句「没有匹配」：`error` 是请求本身无效
      //（重试无用），`readError` 是库临时打不开（重试可能成功），两者都要能让运维看出来。
      if (res.error) return { hits: [], failed: '知识库检索无效：' + res.error }
      if (res.readError) return { hits: [], failed: '知识库打不开：' + res.readError }
      return { hits: res.hits, ...(res.degraded ? { degraded: res.degraded } : {}) }
    } catch (e) {
      return { hits: [], failed: '知识库检索失败：' + errorText(e) }
    }
  })()

  // 稠密一路。未启用则给 null —— 连一次 embedding 都不发起。
  const denseTask: Promise<{ hits: KbHit[]; note?: string } | null> = useDense
    ? (async (): Promise<{ hits: KbHit[]; note?: string }> => {
        try {
          const res = await searchKbDense(decryptedDir, kb, q, embed as EmbedFn, {
            topK,
            minSimilarity: opts.minSimilarity ?? 0,
            candidatePool: opts.candidatePool ?? Math.max(Math.trunc(topK), 1),
            model: opts.embedModel ?? '',
          })
          return { hits: res.hits, ...(res.note ? { note: res.note } : {}) }
        } catch (e) {
          return { hits: [], note: '稠密召回失败：' + errorText(e) }
        }
      })()
    : Promise.resolve(null)

  const [sparse, dense] = await Promise.all([sparseTask, denseTask])

  const fused = fuseKbHits(sparse.hits, dense?.hits ?? [], { k: opts.fusionK ?? DEFAULT_FUSION_K })
  const hits: ChannelHit[] = fused.slice(0, Math.max(1, Math.trunc(topK))).map((f, i) => ({
    doc: kbDocFromHit(kb, f.hit),
    // score 给融合分而不是 bm25 / 余弦：本通道内部已经把两路合成一个序，
    // 拿其中任何一把尺子当分都是「两把尺子量同一件事」（跨通道融合只用名次，分数不外传）。
    score: f.score,
    rank: i + 1,
  }))

  const notes: string[] = []
  if (sparse.failed) notes.push(sparse.failed)
  if (dense) {
    if (dense.note) notes.push(dense.note)
  } else if (sparse.failed === undefined) {
    // 稠密**没跑**、稀疏**跑成了** ⇒ 说清「为什么没跑」，而不是照抄稀疏侧那句
    // 「未建向量索引」：索引其实已建好、只是这次没让它跑时，照抄出来就是假话
    // （头注的「降级说明必须如实」）。稀疏侧其余降级原因（将来可能是断网 / 无 Key）
    // 与本开关无关，照传 —— 唯独 `no-vector-index` 那句是我们**无法背书**的断言。
    if (sparse.degraded && sparse.degraded.reason !== 'no-vector-index') notes.push(sparse.degraded.label)
    notes.push(opts.denseEnabled === true
      ? '仅关键词（未配置向量模型）'
      : '仅关键词（本次未启用向量通道）')
  }
  return {
    channel: 'kb',
    hits,
    active: hits.length > 0,
    // 命中为空时也要给出**如实**的原因（例如「查询里没有可检索的字词」），
    // 而不是让它显示成「知识库是空的」。
    ...(notes.length > 0 ? { note: notes.join('；') } : {}),
    ...(hits.length === 0 && notes.length === 0 ? { note: '知识库没有匹配的内容' } : {}),
  }
}
