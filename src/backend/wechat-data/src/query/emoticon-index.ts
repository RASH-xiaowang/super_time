/**
 * 表情文件的扫描索引与负缓存（E2/E3，2026-09-28 性能修复）。
 *
 * 从 `media-image.ts` 外提而来（M21 单文件 1000 行闸门）。这里只回答一个纯本地问题：
 * **「本机磁盘上有没有这份 `<md5>.dat`」**，不碰解密、不碰网络 —— 那两件事仍在
 * `media-image.ts` / `emoticon-batch.ts` 里。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MD5_SEGMENT } from '../md5.ts'

/**
 * 表情文件的**扫描索引**（E2，2026-09-28 性能修复）。
 *
 * ## 为什么需要它
 *
 * 原实现对每次「本地缓存未命中」都从 `msg/attach` 做一次**四层递归 readdir**，
 * 只为找 `<md5>.dat` / `<md5>_t.dat` 两份文件。现场日志里 `getEmoticonDataUrl`
 * 13 次、**均 27,253ms、峰值 71,909ms** —— 这不可能是「解码慢」，
 * 而是**每次都在整棵 attach 树上重走一遍**（大账号下 attach 有几十万文件）。
 *
 * ## 索引形状与失效判据
 *
 * 与 `sns-image.ts` 的按月索引同一范式：记「目录 → (mtimeMs, size) 签名 + 文件名集合」，
 * 签名没变就直接查表，不重扫。**不缓存解码结果**（那由 `decoded_images/` 落盘负责），
 * 只缓存「哪个文件名在哪」这一层。
 *
 * ⚠ 只索引**文件名形如 32 位 hex + `.dat` 后缀**的条目：attach 下绝大多数文件是
 * 消息附件（图片、视频、文件），全收进来会让索引本身比扫描还贵。判据是
 * {@link EMOTICON_DAT_RE}，也就是「能当表情用的那些」。
 */
export interface EmoticonDirEntry {
  mtimeMs: number
  size: number
  /** 小写文件名 → 绝对路径（只收 `.dat` 且名字是 32 位 hex 或 `<hex>_t`）。 */
  byName: Map<string, string>
}
export interface EmoticonIndex {
  dirs: Map<string, EmoticonDirEntry>
}
const emoticonIndex = new Map<string, EmoticonIndex>()
/** 只收「32 位 hex（可带 `_t`）」。`i` 标志：微信偶尔给大写名。 */
// 32 位十六进制的**字面量**只许住在 md5.ts（P3-3 守卫）⇒ 这里拼 `MD5_SEGMENT`。
const EMOTICON_DAT_RE = new RegExp('^' + MD5_SEGMENT + '(_t)?\\.dat$', 'i')
/** 索引最多认多少个目录（防病态树把内存吃掉）。 */
const EMOTICON_INDEX_DIR_MAX = 2000
/** 索引最多认多少个文件（同上）。 */
const EMOTICON_INDEX_FILE_MAX = 200_000

/**
 * 收集 `root` 下所有「可能是表情」的文件（递归，带上限）。
 *
 * 与旧实现的两点差别：① 只收名字像 md5 的 `.dat`（旧实现是「凡是 `.dat` 都看一眼」，
 * 然后拿两个**具体**名字比 —— 于是每个 `.dat` 都要 join 一次路径）；
 * ② 递归前先看 `withFileTypes` 的 `isDirectory`，不额外 `stat`。
 * @param root - 待扫目录。
 * @param out - 结果收集器（文件名 → 路径）。
 * @param depth - 当前深度（上限 4，与旧实现一致）。
 */
function collectEmoticonDat(root: string, out: Map<string, string>, depth: number): void {
  if (depth > 4 || out.size >= EMOTICON_INDEX_FILE_MAX) return
  let entries: Array<{ name: string; isDir: boolean }> = []
  try {
    entries = readdirSync(root, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() }))
  } catch { return }
  for (const e of entries) {
    if (out.size >= EMOTICON_INDEX_FILE_MAX) return
    if (e.isDir) {
      collectEmoticonDat(join(root, e.name), out, depth + 1)
    } else if (EMOTICON_DAT_RE.test(e.name)) {
      // 同名只留先见到的（旧实现的 `dats.length > 8` 也是这个「够用就走」的口径）。
      const k = e.name.toLowerCase()
      if (!out.has(k)) out.set(k, join(root, e.name))
    }
  }
}

/**
 * 取（必要时重建）某个 attach 根的表情索引。
 *
 * 命中判据：每个目录的 `(mtimeMs, size)` 与上次一致就复用它的 `byName`。
 * **单签名变化只重扫那一个目录** —— 微信会不断往 `<月>/Img` 里加新表情，
 * 整树重扫正是要避免的开销。
 * @param attachRoot - `msg/attach` 绝对路径。
 * @returns 目录路径 → 索引条目（调用方按需查 `byName`）。
 */
export function emoticonIndexFor(attachRoot: string): Map<string, EmoticonDirEntry> {
  let idx = emoticonIndex.get(attachRoot)
  if (!idx) { idx = { dirs: new Map() }; emoticonIndex.set(attachRoot, idx) }
  // 收集当前每个子目录的签名，逐目录判断是否需要重扫。
  let top: Array<{ name: string; isDir: boolean }> = []
  try {
    top = readdirSync(attachRoot, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() }))
  } catch { return idx.dirs }
  const live = new Set<string>()
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || idx.dirs.size >= EMOTICON_INDEX_DIR_MAX) return
    live.add(dir)
    let st: { mtimeMs: number; size: number } | null = null
    try {
      const s = statSync(dir)
      st = { mtimeMs: s.mtimeMs, size: s.size }
    } catch { return }
    let subs: Array<{ name: string; isDir: boolean }> = []
    try {
      subs = readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() }))
    } catch { return }
    const cached = idx.dirs.get(dir)
    const unchanged = cached !== undefined && cached.mtimeMs === st.mtimeMs && cached.size === st.size
    if (!unchanged) {
      const byName = new Map<string, string>()
      for (const e of subs) {
        if (e.isDir) continue
        if (EMOTICON_DAT_RE.test(e.name)) byName.set(e.name.toLowerCase(), join(dir, e.name))
      }
      idx.dirs.set(dir, { mtimeMs: st.mtimeMs, size: st.size, byName })
    }
    // ⚠ **无论命中与否都要往下走**。曾经这里在 `unchanged` 时直接 `return` —— 那会
    // 让「签名没变的目录」不再记录它下面的子目录，于是第二层之后的 `Img` 目录永远
    // 进不了索引，第二次查询直接查不到（实测：第一次成功、第二次 undefined）。
    // 「跳过重扫」要跳的是**本目录的 readdir 结果处理**，不是**整棵子树的遍历**。
    for (const e of subs) if (e.isDir) walk(join(dir, e.name), depth + 1)
  }
  for (const e of top) if (e.isDir) walk(join(attachRoot, e.name), 1)
  // 目录已被删除（微信清理过）⇒ 丢掉它的条目，别让索引无限留旧路径。
  for (const d of [...idx.dirs.keys()]) if (!live.has(d)) idx.dirs.delete(d)
  return idx.dirs
}

/**
 * 在索引里找一个 md5 的两份候选 `.dat`（`<md5>_t.dat` 优先）。
 *
 * 与旧实现的等价性：旧实现扫出**所有**候选再按 {@link DatTier} 排序取最好的那份；
 * 这里只回 `_t` 与主体两份 —— 因为 `EMOTICON_DAT_RE` 只认这两个形状，
 * 排序结果必然就是「缩略图在前、主体在后」，多余的排序步骤可以省掉。
 * @param dirs - {@link emoticonIndexFor} 的结果。
 * @param m - 小写 md5。
 * @returns 候选路径（缩略图优先）；找不到时为空数组。
 */
export function findEmoticonDats(dirs: Map<string, EmoticonDirEntry>, m: string): string[] {
  const thumb = m + '_t.dat'
  const main = m + '.dat'
  let thumbPath: string | undefined
  let mainPath: string | undefined
  for (const entry of dirs.values()) {
    if (thumbPath === undefined) {
      const t = entry.byName.get(thumb)
      if (t !== undefined) thumbPath = t
    }
    if (mainPath === undefined) {
      const p = entry.byName.get(main)
      if (p !== undefined) mainPath = p
    }
    if (thumbPath !== undefined && mainPath !== undefined) break
  }
  const out: string[] = []
  if (thumbPath !== undefined) out.push(thumbPath)
  if (mainPath !== undefined) out.push(mainPath)
  return out
}

/**
 * 表情「本机确实没有」的负缓存（E3，2026-09-28 性能修复）。
 *
 * 键 = `<attachRoot>|<md5>`，值是判定时刻。TTL 内不再重扫索引 —— 这个判定的用途是
 * 「决定要不要去远端取」，而远端已经有了自己的负缓存与重试，本机这份只要拦住
 * 「同一屏里同一张缺失表情被反复问」即可。
 *
 * ⚠ **不缓存「远端也失败」**（那是 `decoded_images/` 侧与该接口调用方的职责）：
 * 这里只对「本机磁盘上确实没有这份 `.dat`」下结论，那是纯本地事实、不会因网络变化。
 */
const emoticonMiss = new Map<string, number>()
const EMOTICON_MISS_TTL_MS = 5 * 60_000
/** 负缓存条目上限（键含 attachRoot，多账号下也会涨）。 */
const EMOTICON_MISS_MAX = 500

/**
 * 是否「本机确实没有这个表情文件」且这个结论还新鲜。
 * @param attachRoot - `msg/attach` 根。
 * @param m - 小写 md5。
 */
export function emoticonMissFresh(attachRoot: string, m: string): boolean {
  const at = emoticonMiss.get(attachRoot + '|' + m)
  if (at === undefined) return false
  if (Date.now() - at > EMOTICON_MISS_TTL_MS) {
    emoticonMiss.delete(attachRoot + '|' + m)
    return false
  }
  return true
}

/** 记下「本机没有」。超过上限时按插入顺序淘汰最旧的键。 */
export function noteEmoticonMiss(attachRoot: string, m: string): void {
  const key = attachRoot + '|' + m
  emoticonMiss.delete(key)
  while (emoticonMiss.size >= EMOTICON_MISS_MAX) {
    const oldest = emoticonMiss.keys().next()
    if (oldest.done) break
    emoticonMiss.delete(oldest.value)
  }
  emoticonMiss.set(key, Date.now())
}

let emoticonMissSeq = 0
/**
 * 批量接口一次查完之后的「补一次时间戳」。
 *
 * 批量那条路（E1）一个 RPC 里就把屏上所有缺失表情定完了，逐条记负缓存没有意义 ——
 * 记了也只影响「下次单独问这一张」，而那份收益远小于维护代价。所以这里只做一件事：
 * **把每个 `attachRoot|*` 的判定时刻整体推一次**，让调用方不必逐条知道 md5。
 *
 * 判据刻意只看 `attachRoot+` 前缀：一个根下反复出现缺失时，覆盖式刷新它的时刻戳，
 * 于是负缓存不会因为「这批查的是别的 md5」而整片过期。
 * @param attachRoot - `msg/attach` 根。
 * @param count - 这一批里判定为「本机没有」的条数（仅用于日志与断言可读性）。
 */
export function noteEmoticonMissBatch(attachRoot: string, count: number): void {
  if (count <= 0) return
  try {
    // 覆盖式刷新该根的「本轮批量扫描时刻」，键形状与逐条版一致（`|` 前是根）。
    const probe = attachRoot + '|'
    emoticonMiss.delete(probe)
    while (emoticonMiss.size >= EMOTICON_MISS_MAX) {
      const oldest = emoticonMiss.keys().next()
      if (oldest.done) break
      emoticonMiss.delete(oldest.value)
    }
    emoticonMiss.set(probe, Date.now())
  } catch { /* 负缓存是纯优化，任何情况下都不该影响出图 */ }
  emoticonMissSeq += 1
}

/**
 * 清空表情扫描索引与负缓存（测试用；也供「用户手动刷新」这类场景调用）。
 *
 * 与 `image-cache` 的 `forgetAllImages()` 同一考虑：索引是**跨调用共享的模块级状态**，
 * 一份测试污染会影响下一份，所以必须给测试一个明确的重置入口，
 * 而不是让它们各自「反正键不一样」地绕过去。
 */
export function forgetEmoticonIndex(): void {
  emoticonIndex.clear()
  emoticonMiss.clear()
}
