/**
 * 向量检索的**共用纯数学**。
 *
 * ── 为什么单独一个文件（而不是各自复制一份）─────────────────────────────
 *   本仓库有**两个**向量库：消息域 `wechat_rag_vectors.db`（`retrieval/embedding.ts`）
 *   与知识库域 `wechat_kb_vectors.db`（`query/kb-vectors.ts`）。两者都用
 *   「SimHash 64 位粗筛 → 精确余弦」这一套：
 *     · 粗筛与查询两侧必须用**同一组随机超平面**（`getPlanes` 按维度确定性生成）；
 *     · 哈希位序、popcount、归一化口径必须逐位一致；
 *     · 汉明距离上界 `MAX_HAMMING` 是选择器内部直方图的大小，两边不一致会静默漏候选。
 *   这些函数**没有**任何域知识（不认识 message / chunk，也不碰 SQLite），
 *   复制第二份的唯一后果是「某天只改了一处」—— 表现为检索质量悄悄下降而不报错。
 *   所以在此抽出：**只有一份实现，两侧共享同一组单测**。
 *
 * ── 边界：什么**不**属于本文件 ──────────────────────────────────────────
 *   · `docKeyOf`（`username:local_id`）—— 消息域专有的去重键，留在 embedding.ts；
 *   · schema / 建库 / 事务 / 缓存 —— 两者的表结构、语料来源、失效条件都不同，
 *     刻意不抽象（硬抽成一个泛型建库器会需要一堆回调，反而更难读）。
 */
import { statSync } from 'node:fs'

/** 一次 embedding 请求的函数签名（由 gateway 注入，内部走 ctx.llm.embed）。 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>

/** SimHash 位数（= 粗筛表的哈希宽度）。 */
export const SIMHASH_BITS = 64

/** 汉明距离的上界：两个 32 位 popcount 相加，最大 64。 */
export const MAX_HAMMING = 64

/**
 * 粗筛表的一行（只保留定位与哈希，不含向量本身）。
 *
 * `rowid` 是「回到向量表取向量的主键」：消息域是 `vectors.fts_rowid`，
 * 知识库域是 `kb_vectors.chunk_id`。
 *
 * `username` 是**分区键**，语义随域而变，两处刻意不同：
 *   · 消息域 = 会话 `username`，`searchDense` 会拿它按会话过滤（粗筛在内存里做，所以必须带上）；
 *   · 知识库域 = 空串 —— 那里按库过滤已经在 SQL 里做掉了（`WHERE kb_id = ?`），
 *     内存再过滤一遍反而会掩盖「SQL 里漏了 kb_id」这种失效（同 kb-search 的单一过滤点纪律）。
 */
export interface HashRow { rowid: number; lo: number; hi: number; username: string }

// ── SimHash 随机超平面（按维度缓存；同一维度内进程生命周期内复用）──
const PLANES_CACHE = new Map<number, Int8Array[]>()

/** xorshift32 PRNG（确定性，保证索引/查询两侧同一维度的超平面一致）。 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9
  return () => {
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s >>> 0
  }
}

/** 生成 SIMHASH_BITS 个随机超平面（每个长度 = dim）。 */
export function getPlanes(dim: number): Int8Array[] {
  const cached = PLANES_CACHE.get(dim)
  if (cached) return cached
  const rng = makeRng(dim * 2654435761)
  const planes: Int8Array[] = []
  for (let b = 0; b < SIMHASH_BITS; b += 1) {
    const p = new Int8Array(dim)
    // 用 ±1 而非高斯：乘加更快，SimHash 性质足够（随机超平面的符号投影）。
    for (let i = 0; i < dim; i += 1) p[i] = (rng() & 1) ? 1 : -1
    planes.push(p)
  }
  PLANES_CACHE.set(dim, planes)
  return planes
}

/** 计算向量的 64 位 SimHash（返回两个 32 位无符号整数表示的高/低位）。 */
export function simhash(vec: Float32Array, planes: Int8Array[]): { lo: number; hi: number } {
  let lo = 0
  let hi = 0
  const dim = vec.length
  for (let b = 0; b < planes.length; b += 1) {
    const p = planes[b]
    let dot = 0
    for (let i = 0; i < dim; i += 1) dot += p[i] * vec[i]
    if (dot >= 0) {
      if (b < 32) lo |= (1 << b)
      else hi |= (1 << (b - 32))
    }
  }
  return { lo: lo >>> 0, hi: hi >>> 0 }
}

/** popcount（32 位）。 */
export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555)
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  x = (x + (x >>> 4)) & 0x0f0f0f0f
  return (x * 0x01010101) >>> 24
}

/** L2 归一化（余弦相似度 → 点积）。 */
export function l2normalize(v: number[]): Float32Array {
  const f = Float32Array.from(v)
  let n = 0
  for (let i = 0; i < f.length; i += 1) n += f[i] * f[i]
  n = Math.sqrt(n)
  if (n > 1e-9) for (let i = 0; i < f.length; i += 1) f[i] /= n
  return f
}

/** Float32Array → BLOB 字节。 */
export function vecToBlob(v: Float32Array): Uint8Array {
  return new Uint8Array(v.buffer, v.byteOffset, v.byteLength)
}

/** BLOB 字节 → Float32Array（复制，避免引用底层 buffer 被复用）。 */
export function blobToVec(b: Uint8Array, dim: number): Float32Array {
  const copy = new Uint8Array(dim * 4)
  copy.set(b.subarray(0, dim * 4))
  return new Float32Array(copy.buffer)
}

/** 文件 mtime+size 指纹（缓存失效依据；向量库两处缓存都用它）。 */
export function statSig(p: string): string {
  try {
    const st = statSync(p)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return 'missing'
  }
}

/**
 * 按汉明距离取前 `pool` 个候选（两套向量库共用的粗筛）。
 *
 * 为什么不用 `map(...).sort(...).slice(...)`：粗筛表通常是**十几万行**（本地实测 13.5 万；
 * 另一处 `.all()` 的实测是 20 万行），而每个查询都要为每一行分配一个 `{r, d}` 对象、
 * 再做一次 O(N log N) 的**比较排序** —— 可是我们要的只是**前 pool 名**（pool 是几十到几百）。
 * 这里换成计数选择（计数排序的特例）：
 *   ① 一遍算距离，存进 `Uint8Array`（距离恒在 [0,64]，一字节够）并累加 65 格直方图；
 *   ② 用直方图找出「累计条数 ≥ pool」的那个距离 `limit`；
 *   ③ 再做一遍计数排序，把 `d <= limit` 的行按 **(距离升序, 原顺序)** 落位。
 *
 * 选出来的序列与「全量按距离升序排序后取前 pool」**逐项相同**（含同距离内的先后，
 * 因为计数排序是稳定的）—— 差别只在代价：零逐行分配、无比较排序、两次线性扫描。
 * `pool >= N` 时退化为整表，与原来一致。
 * @param rows - 粗筛表（`loadHashRows` 的结果）。
 * @param qh - 查询向量的 simhash。
 * @param pool - 要取多少个候选。
 * @returns 候选行（距离升序；同距离保持原表顺序）。
 */
export function selectByHamming(rows: readonly HashRow[], qh: { lo: number; hi: number }, pool: number): HashRow[] {
  const n = rows.length
  // pool 来自配置（`rag-config.json` 可手改，`deepMerge` 不做数值校验）：非有限值/小数/负数
  // 都要归一到安全整数。旧实现靠 `slice` 天然容忍（`slice(0, 2000.5)` 截断成 2000、
  // `slice(0, NaN)` 得空数组），而 `new Array(take)` 遇非整数会直接抛 RangeError。
  // `Infinity` 要保留「取整表」的含义（`Math.floor(Infinity)` 仍是 Infinity，再被 min 夹到 n）——
  // 别把它和 NaN 一起归零，那会与旧行为分叉。**唯一有意的分歧**：负数的 pool 旧实现是
  // `slice(0, -k)`（返回「全部去掉后 k 条」，显然是笔误产物），新实现按 0 处理（返回空）。
  const want = Number.isNaN(pool) ? 0 : Math.floor(pool)
  const take = Math.min(Math.max(want, 0), n)
  if (take <= 0) return []
  const dist = new Uint8Array(n)
  const hist = new Uint32Array(MAX_HAMMING + 1)
  for (let i = 0; i < n; i += 1) {
    const r = rows[i]
    const d = popcount32((r.lo ^ qh.lo) >>> 0) + popcount32((r.hi ^ qh.hi) >>> 0)
    dist[i] = d
    hist[d] += 1
  }
  let limit = MAX_HAMMING
  let cum = 0
  for (let d = 0; d <= MAX_HAMMING; d += 1) {
    cum += hist[d]
    if (cum >= take) { limit = d; break }
  }
  // 计数排序（只排到 limit 组）：先算每组起始偏移，再按原顺序落位 —— 稳定。
  const cursor = new Uint32Array(limit + 2)
  let acc = 0
  for (let d = 0; d <= limit; d += 1) { cursor[d] = acc; acc += hist[d] }
  const order = new Uint32Array(acc)
  const next = cursor.slice()
  for (let i = 0; i < n; i += 1) {
    const d = dist[i]
    if (d <= limit) order[next[d]++] = i
  }
  const out: HashRow[] = new Array(take)
  for (let k = 0; k < take; k += 1) out[k] = rows[order[k]]
  return out
}

/** 汉明距离（两条 64 位 SimHash）。 */
export function hammingDistance(a: { lo: number; hi: number }, b: { lo: number; hi: number }): number {
  return popcount32((a.lo ^ b.lo) >>> 0) + popcount32((a.hi ^ b.hi) >>> 0)
}
