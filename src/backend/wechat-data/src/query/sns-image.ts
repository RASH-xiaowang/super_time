/**
 * SNS (朋友圈) offline image resolution: scans WeChat's cache/<month>/Sns/Img
 * directories for V2-encrypted image blobs, decrypts them with the image AES
 * key and matches the plaintext MD5 against the media md5 from the moments XML.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { decodeDatBytes } from './media-image.ts'
import { boundedSet } from './meta.ts'
import { MD5_SEGMENT } from '../md5.ts'
import { missWithScanNotes, noteScan, snsLeafRoots, snsMonthRoots } from './sns-scan.ts'
import type { ScanNotes } from './sns-scan.ts'

/** 「文件名本身就是明文 md5」的形状（32 位 hex）——字面量只许住在 `md5.ts`（P3-3）。 */
const MD5_NAME_RE = new RegExp('^' + MD5_SEGMENT + '$', 'i')

const md5UrlCache = new Map<string, string>()

/**
 * 按月增量的明文 md5 索引。
 *
 * 改造原因（第 40 轮实测）
 * ----------------------
 * 旧实现是**整树重建**：只要任一月份目录的 mtime/size 变化，就把 80 个月份根目录下的
 * **全部 15,220 个文件（约 1.2 GB）逐个解密**算明文 md5 —— 实测单次 12–20 秒，
 * 且发生在**同步请求内**。延迟分布极不均衡：p50=3ms / p99=8ms，但有 2 次分别 19.9s、12.4s。
 *
 * 新实现：
 *  · 每个月份目录单独存一份 `byMd5` 与它的签名的（mtimeMs,size）；
 *  · 只重新扫描**签名变化**的月份，其余沿用；
 *  · 扫描顺序按月份**从新到旧**，命中目标 md5 立即停止 —— 朋友圈浏览以近期图片为主，
 *    所以常见情况只需扫 1–2 个月；
 *  · 若所有月份都按当前签名扫过仍未命中，说明「确实没有」，调用方**不必再重复全量扫描**
 *    （旧代码在索引未命中后还会把同一批文件再扫一遍，等于白费一次同样的开销）。
 */
interface MonthEntry {
  byMd5: Map<string, string>
  /**
   * 已处理过的文件 → 当时的签名 + 它的明文 md5。
   * 有它才能做到"**只解密新增/变化的文件**"：微信一直在往这个月目录里写新图，
   * 早先那种"目录 mtime 一变就整月重扫"等于每次请求都重扫（见下面 SNS_INDEX_BUDGET_FILES 的说明）。
   */
  files: Map<string, { mtimeMs: number; size: number; md5: string }>
  /** 待处理文件（按 mtime 新→旧排好），空 = 这个月的文件都处理过了。 */
  pending: Array<{ path: string; mtimeMs: number; size: number }>
  /** 这个月**至少完整走过一遍目录**（`pending` 为空且 `walked` 为真才算扫完）。 */
  walked: boolean
  /** 上次刷新时这个月**根目录**的签名：没变就不必再走一遍目录（6,304 个文件的列+stat ≈ 90ms）。 */
  rootMtimeMs: number
  rootSize: number
  /** 上次走目录的时刻（配合 {@link SNS_MONTH_REFRESH_MIN_MS} 的闸门）。 */
  refreshedAt: number
  /** 上次增量解密的时刻（配合 {@link SNS_INDEX_DRAIN_MIN_INTERVAL_MS} 的闸门）。 */
  drainedAt: number
  /** 上次列出的目录清单（{@link SNS_LISTING_TTL_MS} 内复用）。 */
  listing: string[]
  /** 上次列目录清单的时刻。 */
  listingAt: number
}
interface SnsImageIndex {
  months: Map<string, MonthEntry>
}
const snsImageIndex = new Map<string, SnsImageIndex>()

/**
 * 单次调用**最多解密多少个缓存文件**（2026-09-29 实测后加的硬上限）。
 *
 * ## 为什么必须有它
 *
 * 实测：进入朋友圈后 `getSnsImageDataUrl` **单次 130 秒**（主进程日志：
 * `慢调用 getSnsImageDataUrl 耗时 134879ms / 131051ms / 130499ms / 132016ms`）。原因不是解密慢
 * （纯 AES+md5 实测 0.12 ms/个），而是**整月重扫**：一个月 3,100 张图、两个月 6,300 张，
 * 其中绝大多数是 wxgf 容器，要**逐个调微信原生转码库**才能算明文 md5（约 20 ms/个）
 * ⇒ 6,300 × 20 ms ≈ 126 s。而 worker 是**串行**的，这一下把后面所有请求都堵到 60s 超时
 * —— 用户看到的就是"点开朋友圈之后整个应用卡死好几分钟"。
 *
 * 现在：目录**每轮只做增量**（只解密新增/变化的文件，按 mtime 新→旧），并且**单次调用有上限**；
 * 没扫完的部分留在 `pending` 里，下次调用接着扫。于是
 *   · 一次调用最多约 40 × 20 ms ≈ 0.8 s（绝大多数月是几十毫秒，因为增量后通常没有新文件）；
 *   · 冷启动那次也不会再把几百秒的活压在一次调用里 —— 进度分散到多次调用，界面全程可用。
 */
export const SNS_INDEX_BUDGET_FILES = 40

/**
 * 把目录里的**新增/变化/已删除**文件同步进索引（只 stat，不解密）。
 *
 * 为什么不看目录 mtime 就整月重扫：微信持续往 `cache/<月>/Sns/Img` 写新图，
 * 目录 mtime 几乎每次请求前都变 ⇒ 整月重扫 = 每次请求都重扫（这就是上面 130 s 的来源）。
 * 逐文件签名（mtimeMs+size）才是正确的失效粒度。
 * @param entry - 该月的索引条目（原地更新）。
 * @param root - 该月媒体根目录。
 * @param notes - 读不动的目录记在这里。
 */
function refreshMonth(entry: MonthEntry, root: string, notes: ScanNotes): void {
  let files: string[]
  // 10 秒内复用同一份清单（见 SNS_LISTING_TTL_MS）：省掉反复 readdir，代价是新图索引最多晚 10 秒。
  if (entry.listing.length > 0 && Date.now() - entry.listingAt < SNS_LISTING_TTL_MS) {
    files = entry.listing
  } else {
    files = []
    walkFiles(root, files, 0, notes)
    entry.listing = files
    entry.listingAt = Date.now()
  }
  const seen = new Set<string>()
  for (const f of files) {
    seen.add(f)
    /**
     * **已知文件不再 stat**（2026-09-29 优化）。
     *
     * 依据：SNS 缓存文件是**内容寻址**的 —— 文件名由 `md5(timelineId_mediaId_后缀)` 决定
     * （见 `resolveSnsImageDataUrl` 的快路径），同一个名字永远对应同一份内容，写进去就不会再改。
     * 所以对已经进过索引的路径，`mtimeMs + size` 的比对是**纯开销**：本机实测这一圈
     * 6,304 次 statSync ≈ **58–60 ms**，而它每次"月根签名变了"都要付一遍。
     * 只 stat **新出现的路径**（真正可能带来新图的那种），其余直接跳过；
     * 删除的文件仍由下面的"目录里没有的则清掉"处理（那一步只依赖路径集合，不需要 stat）。
     */
    if (entry.files.has(f)) continue
    let mtimeMs = 0
    let size = 0
    try {
      const st = statSync(f)
      mtimeMs = st.mtimeMs
      size = st.size
    } catch (e) {
      noteScan(notes, f, e)
      continue
    }
    entry.pending.push({ path: f, mtimeMs, size })
  }
  // 目录里已经没有的文件：连同它的映射一起清掉
  for (const [p, prev] of [...entry.files]) {
    if (seen.has(p)) continue
    if (prev.md5 !== '' && entry.byMd5.get(prev.md5) === p) entry.byMd5.delete(prev.md5)
    entry.files.delete(p)
  }
  // 新图优先：朋友圈看的多半是近期的，先解新文件能让首屏更快命中。
  entry.pending.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

/**
 * 解密最多 `budget` 个待处理文件，把它们并进索引。
 * @returns 实际处理了几个。
 */
function drainPending(entry: MonthEntry, aesKey: string | undefined, xorKey: number, budget: number): number {
  let done = 0
  while (entry.pending.length > 0 && done < budget) {
    const it = entry.pending.shift()
    if (it === undefined) break
    done += 1
    let md5 = ''
    try {
      const dec = decodeDatBytes(new Uint8Array(readFileSync(it.path)), aesKey ?? null, xorKey)
      if (!('error' in dec)) md5 = md5Of(dec.bytes)
    } catch {
      // 单张失败只记签名：别每次调用都重试同一张坏文件。
    }
    entry.files.set(it.path, { mtimeMs: it.mtimeMs, size: it.size, md5 })
    if (md5 !== '' && !entry.byMd5.has(md5)) entry.byMd5.set(md5, it.path)
  }
  return done
}

/**
 * 按需增量地查 `wantMd5`：只扫**必须扫的**，且单次有预算。
 * @returns `{ file }` 命中文件；否则 `{ complete }` 表示「是否已把全部月份扫完（可以断言"本机没有"）」。
 */
function snsResolveByIndex(
  wechatBaseDir: string,
  aesKey: string | undefined,
  xorKey: number,
  wantMd5: string,
  notes: ScanNotes,
  budget = SNS_INDEX_BUDGET_FILES,
): { file?: string; complete: boolean } {
  const roots = snsMonthRoots(wechatBaseDir, 'Img', notes)
  let idx = snsImageIndex.get(wechatBaseDir)
  if (!idx) { idx = { months: new Map() }; snsImageIndex.set(wechatBaseDir, idx) }
  // 月份目录集合变化时，丢弃已不存在的月份缓存
  const live = new Set(roots.map((r) => r.month))
  for (const m of [...idx.months.keys()]) if (!live.has(m)) idx.months.delete(m)

  let left = budget
  let allWalked = true
  for (const { month, root, mtimeMs, size } of roots) {
    let entry: MonthEntry | undefined = idx.months.get(month)
    if (entry === undefined) {
      entry = { byMd5: new Map(), files: new Map(), pending: [], walked: false, rootMtimeMs: -1, rootSize: -1, refreshedAt: 0, drainedAt: 0, listing: [], listingAt: 0 }
      idx.months.set(month, entry)
    }
    const before = notes.length
    // 只有"根目录签名变了、或还有没扫完的"才需要走目录/解密 —— 否则这一段就是 0 成本。
    // 另外加 2 秒闸门：微信在持续写图，签名几乎每次都变，不加闸门就是每张图都走一遍 6,304 个文件
    // （实测 61–69 ms/次，见 SNS_MONTH_REFRESH_MIN_MS）。
    const rootChanged = (entry.rootMtimeMs !== mtimeMs || entry.rootSize !== size) &&
      Date.now() - entry.refreshedAt >= SNS_MONTH_REFRESH_MIN_MS
    if (left > 0 && (rootChanged || entry.pending.length > 0)) {
      if (entry.pending.length === 0) {
        refreshMonth(entry, root, notes)
        entry.walked = true
        entry.rootMtimeMs = mtimeMs
        entry.rootSize = size
        entry.refreshedAt = Date.now()
      }
      // 增量解密也有突发闸门（见 SNS_INDEX_DRAIN_MIN_INTERVAL_MS）：一屏里连续多个未命中
      // 不该每个都把"解码 40 个新文件"重付一遍。
      if (entry.pending.length > 0 && Date.now() - entry.drainedAt >= SNS_INDEX_DRAIN_MIN_INTERVAL_MS) {
        entry.drainedAt = Date.now()
        left -= drainPending(entry, aesKey, xorKey, left)
      }
    }
    if (notes.length !== before) allWalked = false
    const hit = entry.byMd5.get(wantMd5)
    if (hit !== undefined) return { file: hit, complete: false }
    if (entry.pending.length > 0 || !entry.walked) {
      // 这个月还有没处理完的文件 / 这轮预算已用尽 ⇒ **不能**下「本机没有」的结论（P1-1/#9 同一条纪律）。
      allWalked = false
      if (left === 0) break
    }
  }
  return { complete: allWalked && notes.length === 0 }
}

function md5Of(bytes: Uint8Array): string {
  return createHash('md5').update(Buffer.from(bytes)).digest('hex')
}

function walkFiles(dir: string, out: string[], depth: number, notes?: ScanNotes): void {
  if (depth > 5 || !existsSync(dir)) return
  let entries: Array<{ name: string; isDir: boolean }> = []
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() }))
  } catch (e) {
    // 「这个子目录没读到」必须留下记录：否则索引残缺会被当成「本机就是没有这张图」。
    noteScan(notes, dir, e)
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDir) walkFiles(p, out, depth + 1, notes)
    else if (!e.name.endsWith('.db') && !e.name.includes('_shm') && !e.name.includes('_wal')) out.push(p)
  }
}

/**
 * `msg/attach` 兜底扫描的**增量索引**（2026-09-29 实测后加）。
 *
 * ## 为什么还需要它
 *
 * 按文件名先筛（见下面 `nameIsHash`）之后，真机上仍有 **3,294 个**文件名**不是** 32 位 md5
 * （形如 `1000_1776833994_t.dat`）⇒ 没法只看名字排除，只能解密出来比 md5。
 * 而这条兜底路径**每次未命中都会重跑**，于是单次调用稳定花掉 **3.5 秒**
 * （`[sns-trace] attach-scan=3518ms`，与 3,294 × ~1ms 吻合）。
 *
 * 现在：每个文件**一辈子只解一次**（记住 mtime+size 与它的明文 md5），单次调用再有预算上限。
 * 冷态分摊到多次调用，稳态（本机 17 次调用左右走完）之后这段就是一次名字过滤。
 */
interface AttachIndexEntry {
  mtimeMs: number
  size: number
  md5: string
}
/**
 * 一遍列目录时就把每个文件**分类好**（2026-09-29 加）。
 *
 * 为什么不在每次调用里现算：`attach-scan` 那一段要对 5 万条路径做两次 `replace` + 两次正则，
 * 实测每次调用 **22 ms**（`[sns-trace] attach-scan=22ms`）—— 而路径集合有 30 秒闸门、
 * 期间根本不变，这 22 ms 纯属重复劳动。分类只做一次，之后每次调用只做字段比较。
 */
interface AttachFileMeta {
  path: string
  /** 去掉 `.dat` 与 `_t/_h/_b/thumb*` 后缀后的名字。 */
  nameBase: string
  /** 名字本身就是 32 位哈希（命名规则 ⇒ 名字即明文 md5，对不上就不必解密）。 */
  isHash: boolean
  /** 缩略图（`_t/_h/_b/thumb`）——优先返回它们，浏览器能直接显示。 */
  isThumb: boolean
}
interface AttachIndex {
  files: Map<string, AttachIndexEntry>
  /** 待解密的**非哈希命名**文件。 */
  pending: Array<{ path: string; mtimeMs: number; size: number }>
  /** 上次列出来的全部文件（已分类；30 秒闸门内直接复用，省掉 5 万条 readdir）。 */
  entries: AttachFileMeta[]
  /** 上次列目录的时间。 */
  walkedAt: number
  /** 上次推进解密的时间（配合 {@link ATTACH_DRAIN_MIN_INTERVAL_MS}）。 */
  drainedAt: number
}
const attachIndex = new Map<string, AttachIndex>()

/** 单次调用最多解密多少个 attach 文件。 */
export const ATTACH_BUDGET_FILES = 200

/**
 * 月份目录**清单**的复用窗口（2026-09-29 加）。
 *
 * 背景：微信持续往 `cache/<月>/Sns/Img` 写图 ⇒ 月根签名一直在变 ⇒ 每次"刷新"都要 `readdir`
 * 走一遍目录（本机一个月根 ≈ **25ms**，两个月 ≈ 50ms），而突发取图期间这会反复发生。
 * 10 秒内复用同一份清单：新落的图最多晚 10 秒才被**索引**到 —— 而绝大多数请求走的是
 * `md5(tid_mediaid_后缀)` 的 O(1) 快路径（实测 ~1ms），根本不依赖这份清单。
 */
const SNS_LISTING_TTL_MS = 10_000

/**
 * 单次调用在这段 attach 兜底上最多花多少毫秒（2026-09-29 加；与文件数预算**同时生效**）。
 *
 * 为什么还要时间预算：文件数预算管不住"单文件有多贵" —— 实测 200 个文件 ≈ **139–169 ms**，
 * 而**每一次未命中**都要付这笔钱（`[sns-trace] attach-drain=169ms / 139ms`）。
 * 面板一屏 8 张图里若有多张取不到，就是 8 × 200ms 的白等。改成"最多 25ms / 每次"：
 * 总工作量不变、进度照样跨调用累积，但单次未命中的成本从 ~230ms 降到 ~40ms。
 */
export const ATTACH_BUDGET_MS = 25

/** 重新列 attach 目录的最小间隔：目录内容变化不频繁，没必要每次调用都列 5 万条。 */
const ATTACH_WALK_INTERVAL_MS = 30_000

/**
 * 两次 attach **解密推进**之间的最小间隔（2026-09-29 加）。
 *
 * 为什么：时间预算是"单次 ≤25ms"，但**每一次未命中都要付这 25ms**。真机 `[sns-trace]` 看到的
 * 是一屏里连续 7 个未命中 ⇒ 7 × 25ms 全花在"推进一个跟本例无关的兜底队列"上。
 * 150ms 的间隔让**突发取图只推进一次**：总进度不变（下一个 150ms 窗口接着推进），
 * 但一屏的固定开销从 7×25ms 降到 ~25ms。
 */
const ATTACH_DRAIN_MIN_INTERVAL_MS = 150

/**
 * 月份索引**增量解密**的最小间隔（同上，`drainPending` 每个未命中最多解 40 个文件 ≈ 20ms）。
 *
 * 注意与 `SNS_MONTH_REFRESH_MIN_MS`（走目录、2 秒）是两件事：这条管的是"解码新文件"，
 * 那条管的是"发现新文件"。都要闸，否则突发的未命中会把两者各付好几遍。
 */
const SNS_INDEX_DRAIN_MIN_INTERVAL_MS = 150

/**
 * SNS 月份目录**重新走一遍**的最小间隔（2026-09-29 加）。
 *
 * 微信持续往 `cache/<月>/Sns/Img` 写图，月根签名几乎每次调用都变 ⇒ 每次都走一遍目录
 * （6,304 个文件的列 + stat ≈ **61–69 ms**，见 `[sns-trace] index=61ms`）。
 * 2 秒闸门的意义：这两秒内新落的图晚一点才进索引（面板本身是懒加载 + 重试），
 * 换来的是突发取图时不再每张都付这 60ms。
 */
const SNS_MONTH_REFRESH_MIN_MS = 2_000

/**
 * 刷出"需要解密的非哈希命名文件"（只读签名，不解密）。
 * @param idx - 该账号根下的 attach 索引（原地更新）。
 * @param notes - 读不动的目录记这里。
 */
function refreshAttach (idx: AttachIndex, notes: ScanNotes): void {
  const seen = new Set<string>()
  for (const f of idx.entries) {
    const path = f.path
    // 名字就是 32 位哈希的：命名规则保证"名字 = 明文 md5"，对不上的一律不解密。
    if (f.isHash) continue
    seen.add(path)
    let mtimeMs = 0
    let size = 0
    try {
      const st = statSync(path)
      mtimeMs = st.mtimeMs
      size = st.size
    } catch (e) {
      noteScan(notes, path, e)
      continue
    }
    const prev = idx.files.get(path)
    if (prev !== undefined && prev.mtimeMs === mtimeMs && prev.size === size) continue
    // 变了/新的：清掉旧结论，重新排队。
    idx.files.delete(path)
    idx.pending.push({ path, mtimeMs, size })
  }
  // 目录里已经没有的清掉
  for (const p of [...idx.files.keys()]) if (!seen.has(p)) idx.files.delete(p)
  idx.walkedAt = Date.now()
}

/**
 * 解密待处理文件，把明文 md5 记下来。
 *
 * **两个预算同时生效**：文件数（`budgetFiles`）与墙上时间（`budgetMs`）。
 * 只用文件数管不住"单个文件多贵"，实测 200 个 ≈ 139–169 ms，而每次未命中都要付 —— 见
 * {@link ATTACH_BUDGET_MS}。
 * @returns 实际处理了几个。
 */
function drainAttach (idx: AttachIndex, aesKey: string | undefined, xorKey: number, budgetFiles: number, budgetMs: number): number {
  let done = 0
  const startedAt = Date.now()
  while (idx.pending.length > 0 && done < budgetFiles) {
    // 时间预算：至少处理一个（否则永远推不动），之后就看还剩多少时间。
    if (done > 0 && Date.now() - startedAt >= budgetMs) break
    const it = idx.pending.shift()
    if (it === undefined) break
    done += 1
    let md5 = ''
    try {
      const dec = decodeDatBytes(new Uint8Array(readFileSync(it.path)), aesKey ?? null, xorKey)
      if (!('error' in dec)) md5 = md5Of(dec.bytes)
    } catch {
      // 单张失败也记签名，别每次重试同一张坏文件。
    }
    idx.files.set(it.path, { mtimeMs: it.mtimeMs, size: it.size, md5 })
  }
  return done
}

/**
 * 测试用读数：`msg/attach` 兜底的进度（"单次有界 + 跨调用累积"这两条契约靠它钉住）。
 *
 * 为什么不靠"第几趟能命中"来断言：目录枚举顺序由文件系统决定，测试里控制不了，
 * 那样的断言会变成"碰巧过/碰巧红"。直接读进度最稳。
 * @param wechatBaseDir - 账号根目录。
 * @returns 已记住明文 md5 的文件数、还排队的文件数、已知文件数；没建过索引时 `undefined`。
 */
/**
 * **预热解码缓存**：主动推进 attach 索引的解密，不等用户点图（2026-09-29）。
 *
 * ── 为什么需要 ────────────────────────────────────────────────
 * 真机自检：**解码缓存 154 张 / 43.5MB**，而媒体资源 **175,963 项 / 16.8GB**。
 * 原因是 `drainAttach()` 此前**只在 `resolveSnsImageDataUrl()` 里被驱动** ——
 * 用户点到哪张才解哪张，于是空闲时缓存完全不涨；而缓存未命中的那张要走
 * 「读文件 + 解密 + 哈希」的重路径（实测 12–21s），超时/失败就成了前端那块空白。
 *
 * ── 做法 ─────────────────────────────────────────────────────
 * 复用**完全相同**的索引与节流：同一份 `attachIndex`、同一个 `ATTACH_WALK_INTERVAL_MS`
 * 列目录闸门、同一个 `ATTACH_DRAIN_MIN_INTERVAL_MS` 突发闸门、同一组文件数/毫秒预算。
 * 唯一区别是**驱动权交给后台节拍**（同步 tick），所以缓存会自己长起来。
 * 幂等且自带节流 ⇒ 调用方可以放心地每隔几秒调一次。
 *
 * @param wechatBaseDir - 微信原始目录（未配置时直接跳过）。
 * @param aesKey - 图片 AES 密钥。
 * @param xorKey - XOR 密钥。
 * @returns 本次是否真的推进了一步（未推进 = 闸门内/没目录，供调用方决定是否记日志）。
 */
export function pumpSnsDecodeCache (
  wechatBaseDir: string | undefined,
  aesKey: string | undefined,
  xorKey: number,
  opts: { maxMs?: number } = {},
): { advanced: boolean; steps: number } {
  if (!wechatBaseDir) return { advanced: false, steps: 0 }
  /**
   * 目录口径**按存在性选择**，不猜层级。
   *
   * 真机探针实测：`msg/attach` 在**账号目录**（`…\wxid_xxx`），而 `config.db_dir` 指向的是
   * `…\wxid_xxx\db_storage` ⇒ 直接 `join(db_dir, 'msg', 'attach')` 不存在、预热会立刻 `advanced: false`
   * （也就是说"接上了但没干活"）。而不同微信版本的层级未必一致，所以这里列出候选、
   * **只认真正存在 `msg/attach` 的那个**；两个都不存在就照旧返回 false（等同未配置）。
   */
  const attachRoot = [
    join(wechatBaseDir, 'msg', 'attach'),
    join(wechatBaseDir, '..', 'msg', 'attach'),
  ].find((p) => existsSync(p))
  if (attachRoot === undefined) return { advanced: false, steps: 0 }
  // 索引按**真实 attach 根**做键（否则同一个目录会因两个入参形成两份索引，预热效率减半）
  const indexKey = attachRoot
  let idx = attachIndex.get(indexKey)
  if (!idx) {
    idx = { files: new Map(), pending: [], entries: [], walkedAt: 0, drainedAt: 0 }
    attachIndex.set(indexKey, idx)
  }
  const notes: string[] = []
  // 与 resolveSnsImageDataUrl 同源：列目录走 30 秒闸门，分类只做一次
  if (idx.entries.length === 0 || Date.now() - idx.walkedAt >= ATTACH_WALK_INTERVAL_MS) {
    const all: string[] = []
    walkFiles(attachRoot, all, 0, notes)
    idx.entries = all.map((path) => {
      const nameBase = (path.split(/[\\/]/).pop() ?? '').replace(/\.dat$/i, '').replace(/_(t|h|b|thumb.*)$/i, '')
      const lower = path.toLowerCase()
      return {
        path,
        nameBase,
        isHash: MD5_NAME_RE.test(nameBase),
        isThumb: lower.includes('_t.') || lower.includes('_h.') || lower.includes('_b.') || lower.includes('_thumb'),
      }
    })
    refreshAttach(idx, notes)
  }
  /**
   * 单次调用内**按时间预算连续推进**（2026-09-29 提速）。
   *
   * 为什么要循环：一次 `drainAttach` 实测只推 35–40 张 / 25ms。同步节拍约 10s 一拍，
   * 那只够消化 40 张 ⇒ 3,262 张积压要约 13 分钟。这里在**明确的时间上限**内多推几步，
   * 于是每拍能消化几百张，同时仍然有界（调用方给 300ms ⇒ 只占每 10s 的 3%）。
   *
   * 三点保证：
   *   · `maxMs` 未给 ⇒ 只推一步（默认行为，兼容旧调用与单测）；
   *   · 每步之间仍看一眼突发闸门 —— 与"正在等图的请求"共用，不抢占；
   *   · 循环条件同时看 deadline 与闸门，**不可能死循环**。
   */
  const deadline = Date.now() + Math.max(0, opts.maxMs ?? 0)
  let steps = 0
  for (;;) {
    if (Date.now() - idx.drainedAt < ATTACH_DRAIN_MIN_INTERVAL_MS) {
      return { advanced: steps > 0, steps }
    }
    idx.drainedAt = Date.now()
    drainAttach(idx, aesKey, xorKey, ATTACH_BUDGET_FILES, ATTACH_BUDGET_MS)
    steps += 1
    if (opts.maxMs === undefined || Date.now() >= deadline) break
  }
  return { advanced: steps > 0, steps }
}

export function snsAttachProgressForTest(wechatBaseDir: string): { decoded: number; pending: number; paths: number } | undefined {
  /**
   * 索引键是**真实 attach 根**（见 `pumpSnsDecodeCache`：真机上它在账号目录，而不是 `config.db_dir`
   * 指向的 `db_storage`）。所以这里三种键都试一遍，兼容调用方传任意一层目录 ——
   * 否则收紧键以后统计会**永远查不到**（`sns-media.spec.ts` 用的是 `?? 0`，抓不到这种回归）。
   */
  const idx = attachIndex.get(wechatBaseDir)
    ?? attachIndex.get(join(wechatBaseDir, 'msg', 'attach'))
    ?? attachIndex.get(join(wechatBaseDir, '..', 'msg', 'attach'))
  if (!idx) return undefined
  let decoded = 0
  for (const v of idx.files.values()) if (v.md5 !== '') decoded += 1
  return { decoded, pending: idx.pending.length, paths: idx.entries.length }
}

/**
 * Resolve one SNS media md5 to an offline base64 data URL.
 * @param wechatBaseDir - raw WeChat install dir (current account root).
 * @param aesKey - image AES key (16-char ASCII string), optional.
 * @param xorKey - XOR key byte.
 * @param md5 - 32-char media md5 from the moments XML.
 * @param timelineId - SNS 动态 id（有它 + mediaId 时走 O(1) 的路径探测）。
 * @param mediaId - 媒体 id。
 * @returns data URL or an error description.
 */
function dataUrlOf(dec: { bytes: Uint8Array; format: string }): string {
  const mime = dec.format === 'jpg' ? 'jpeg' : dec.format
  return 'data:image/' + mime + ';base64,' + Buffer.from(dec.bytes).toString('base64')
}

/** Decode one cache file; returns data URL or null. */
function decodeCachedFile(f: string, aesKey: string | undefined, xorKey: number): string | null {
  try {
    const bytes = readFileSync(f)
    const dec = decodeDatBytes(new Uint8Array(bytes), aesKey ?? null, xorKey)
    if ('error' in dec) return null
    return dataUrlOf(dec)
  } catch {
    return null
  }
}

/**
 * 只要「本机**确实**有这张图」的那个判断，不要解码结果（A4，2026-09-28 性能修复）。
 *
 * `resolveSnsImageDataUrl` 会把命中的文件解成 data URL —— 那对本机已有的封面是双重开销
 * （文中封面走 `article-cover.ts` 的缓存，朋友圈那条走 `resolveSnsImageDataUrl`）。
 * 这里只回答「索引里有没有它」，供 {@link file://./article-cover.ts} 决定要不要出网。
 *
 * ⚠ 口径与 `resolveSnsImageDataUrl` 的**索引分支**逐字一致：`complete === false` 且
 * `file !== undefined` 才算命中，`indexDead`（索引指向的文件解不开）**不算** ——
 * 否则「本机有一份坏文件」会被当成「本机有图」，把封面永久钉在坏数据上。
 * @returns 命中的文件路径；没命中 / 索引不完整 / 无法判定时 `undefined`（调用方一律照旧出网）。
 */
/**
 * 版本二：*内容*取回 —— 只要「本机确实有这张图」那份 data URL（A4，2026-09-28 性能修复）。
 *
 * 为什么不在这里 import `meta.ts` 的 `boundedSet`：`decodeCachedFile` 已经做了密钥解析，
 * 这里再原地解一次就够；从 `md5UrlCache` 拿一份已经解过的可以省一次解密。
 * ⚠ 口径与 `resolveSnsImageDataUrl` 的**索引分支**逐字一致：`indexDead`（索引指向的文件
 * 解不开）**不算命中** —— 否则「本机有一份坏文件」会被当成「本机有图」，把封面永久钉在坏数据上。
 * @returns 命中且能解开的 data URL；否则 `undefined`（调用方一律照旧出网）。
 */
export function findSnsMediaDataUrlByIndex(
  wechatBaseDir: string,
  aesKey: string | undefined,
  xorKey: number,
  md5: string,
): string | undefined {
  const key = (md5 || '').trim().toLowerCase()
  if (!key) return undefined
  try {
    // 先看解码缓存：命中过的早就解好了（`resolveSnsImageDataUrl` 写入的就是这里）。
    // 省掉一次重扫 —— 但**不能**因此跳过「索引里有没有」这个判断：缓存里有值就说明
    // 之前已经确认过本机有，直接复用即可。
    const memo = md5UrlCache.get(key)
    if (typeof memo === 'string' && memo) return memo
    const notes: ScanNotes = []
    const idxRes = snsResolveByIndex(wechatBaseDir, aesKey, xorKey, key, notes)
    if (!idxRes.file) return undefined
    // 与索引分支同一判据：解不开就不算命中（坏文件不该被当成「本机有」）。
    return decodeCachedFile(idxRes.file, aesKey, xorKey) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * 本进程里是否已经建过**任何**朋友圈媒体索引（A4 的成本闸门）。
 *
 * 为什么需要它：A4 的收益是「省两次网络往返」，成本是「查一次索引（第一次要把某个月的
 * 图片全解一遍算出 md5）」。索引一条都没建时，用户没进过朋友圈 ⇒ 这趟扫描是**纯新增成本**，
 * 而封面省下的网络往返他不一定在意。所以口径定为：**只有索引已在（说明这次会话真的在用朋友圈）
 * 才允许用索引截流**；否则与 A4 之前逐字节同行为。
 * @returns 任一账号下已建过索引时为真。
 */
export function hasSnsMediaIndexEntries(): boolean {
  for (const idx of snsImageIndex.values()) {
    if (idx.months.size > 0) return true
  }
  return false
}

export function resolveSnsImageDataUrl(
  wechatBaseDir: string | undefined,
  aesKey: string | undefined,
  xorKey: number,
  md5: string,
  timelineId?: string,
  mediaId?: string,
  allowThumb = true,
): { url?: string; error?: string } {
  const key = (md5 || '').trim().toLowerCase()
  const baseCacheKey = (timelineId && mediaId)
    ? createHash('md5').update(timelineId + '_' + mediaId + '_2', 'utf8').digest('hex')
    : key
  // 两条档位必须**分开的缓存键**：否则一次 `allowThumb: true` 存进去的缩略图，
  // 会被后面的 `allowThumb: false` 当成原图读出来 —— 恰好是这次要修的那件事。
  const cacheKey = baseCacheKey + (allowThumb ? '' : '#o')
  if (!baseCacheKey) return { error: '缺少图片标识' }
  if (md5UrlCache.has(cacheKey)) {
    const cached = md5UrlCache.get(cacheKey) ?? ''
    if (cached) return { url: cached }
  }
  if (!wechatBaseDir) return { error: '未配置微信原始目录，无法离线解码' }
  // 分段计时（`SUPERTIME_SNS_TRACE=1` 时打到 stderr）：这条链路的分段成本此前全靠猜，
  // 而"整段 1–3 秒"里到底哪一段占大头，只有分段量才知道。
  const trace = process.env.SUPERTIME_SNS_TRACE === '1'
  const marks: Array<[string, number]> = []
  let tMark = performance.now()
  const mark = (name: string): void => {
    if (!trace) return
    const now = performance.now()
    marks.push([name, now - tMark])
    tMark = now
  }
  const flushTrace = (): void => {
    if (!trace || marks.length === 0) return
    console.error('[sns-trace] ' + marks.map(([n, ms]) => `${n}=${ms.toFixed(0)}ms`).join(' '))
  }
  // 扫描注记：记下每一处「读不动」的目录。没有它，「cache 目录扫不动」会被说成
  // 「未找到匹配的本地图片」—— 用户会去翻微信，而病因在文件系统那边（P1-1/#9）。
  const notes: ScanNotes = []
  // 分路诊断：记下「试过哪几条路、每条为什么没成」，最后并进那句 error。
  //
  // 为什么必须分开报：以前「未找到匹配的本地图片」把两种完全不同的情况混成一句 ——
  //   · 本机确实没有这张图（微信清过缓存 / 从别的设备看的 / 没下载过）；
  //   · 我们查错了（缓存键算不出来、索引没扫完、预算用尽）。
  // 混在一起时用户会去翻微信，而病因可能在我们这边 —— 排查方向一开始就错了。
  const routes: string[] = []
  // 优先：tid_mediaid_type 缓存键路径（WDA 同款算法，兼容 _2/_1/_0/无后缀）
  if (timelineId && mediaId) {
    let rootsTried = 0
    let sawButUndecodable = 0
    for (const suffix of ['_2', '_1', '_0', '']) {
      const k = createHash('md5').update(timelineId + '_' + mediaId + suffix, 'utf8').digest('hex')
      const sub = k.slice(0, 2)
      const rest = k.slice(2)
      const roots = snsLeafRoots(wechatBaseDir, 'Img', notes)
      rootsTried = roots.length
      for (const root of roots) {
        const p = join(root, sub, rest)
        if (existsSync(p)) {
          sawButUndecodable += 1
          const data = decodeCachedFile(p, aesKey, xorKey)
          if (data) {
            boundedSet(md5UrlCache, cacheKey, data)
            mark('tid')
            flushTrace()
            return { url: data }
          }
        }
      }
    }
    routes.push(sawButUndecodable > 0
      ? '缓存键路径找到了文件但解不开 ×' + String(sawButUndecodable) + '（已损坏或被清理）'
      : '缓存键路径未命中（4 种后缀 × ' + String(rootsTried) + ' 个月根目录都没有该文件）')
  } else {
    routes.push('没有 timelineId/mediaId ⇒ 缓存键路径未尝试')
  }
  mark('tid')
  // 无 MD5 时不能全量（会误匹配任意图片），直接失败
  if (!key) {
    flushTrace()
    return { error: missWithScanNotes('未找到匹配的本地图片（' + routes.join('；') + '；且没有 md5，无法按内容匹配）', notes) }
  }
  // 索引优先：**按月增量、命中即停**（见 snsResolveByIndex 注释）。
  // 旧实现在索引未命中后还会在下面把同一批文件再全量扫一遍 —— 等于双倍开销，已删除。
  const idxRes = snsResolveByIndex(wechatBaseDir, aesKey, xorKey, key, notes)
  mark('index')
  let indexDead = false
  if (idxRes.file) {
    const data = decodeCachedFile(idxRes.file, aesKey, xorKey)
    if (data) {
      boundedSet(md5UrlCache, cacheKey, data)
      return { url: data }
    }
    indexDead = true // 索引指向的文件解不开（损坏/被清理）→ 仍值得兜底扫一遍
  }
  routes.push(idxRes.file
    ? '按 md5 的索引命中了文件但解不开（已损坏或被清理）'
    : '按 md5 的索引未命中' + (idxRes.complete ? '' : '（索引尚未扫完，下次调用继续推进）'))
  // 兜底：索引说"这个文件解不开"时才值得再全量确认一遍。
  //
  // ⚠️ 2026-09-29 实测修正：这里原先的条件是 `indexDead || !idxRes.complete`，
  // 而 `complete === false` 在**索引还没扫完**时也为真 ⇒ 每次未命中都会把全部月份
  // （6,304 个）再全量解一遍，**并且继续往下走 `msg/attach` 全量**（49,704 个文件）
  // —— 真机测得单次 130–135 秒，把串行 worker 占满，后面所有面板 60s 超时。
  // 索引本身已经是"按月增量 + 单次有预算"的，再暴力扫一遍同一棵树是纯重复劳动；
  // 「还没扫完」应当由索引继续增量推进（下次调用接着扫），而不是退化成全量。
  if (indexDead) {
    routes.push('索引判定损坏 ⇒ 已额外做一次全量确认')
    const files: string[] = []
    for (const root of snsLeafRoots(wechatBaseDir, 'Img', notes)) walkFiles(root, files, 0, notes)
    for (const f of files) {
      try {
        const bytes = readFileSync(f)
        const dec = decodeDatBytes(new Uint8Array(bytes), aesKey ?? null, xorKey)
        if ('error' in dec) continue
        if (key && md5Of(dec.bytes) !== key) continue
        const data = dataUrlOf(dec)
        boundedSet(md5UrlCache, cacheKey, data)
        return { url: data }
      } catch {
        // next file
      }
    }
  }
  // 兜底2：聊天/附件目录 msg/attach（.dat 加密）按 md5 匹配
  //
  // ⚠️ 2026-09-29 实测修正：这里原先**把 attach 下每个 .dat 都解密一遍**再比 md5
  // （本机 50,259 个文件）—— 单次 130+ 秒，正是"整个应用卡死几分钟"的主因。
  // 但 attach 的命名规则就是 **`<md5>.dat`**（本机实测 50,259 个里全是这种形状，
  // 只有 `_t/_h/_b` 后缀差异）⇒ **名字对不上目标 md5 的文件，其明文 md5 不可能等于目标**，
  // 根本不必解密。于是先按文件名筛掉绝大多数，只解真正可能命中的那几个。
  const attachRoot = join(wechatBaseDir, 'msg', 'attach')
  if (!existsSync(attachRoot)) {
    routes.push('本机没有 msg/attach 目录（这条兜底未尝试）')
  }
  if (existsSync(attachRoot)) {
    let idx = attachIndex.get(wechatBaseDir)
    if (!idx) {
      idx = { files: new Map(), pending: [], entries: [], walkedAt: 0, drainedAt: 0 }
      attachIndex.set(wechatBaseDir, idx)
    }
    // 列目录有 30 秒闸门（5 万条不值得每次列）；分类（去掉后缀、判哈希/缩略图）也只在这一步做一次。
    if (idx.entries.length === 0 || Date.now() - idx.walkedAt >= ATTACH_WALK_INTERVAL_MS) {
      const all: string[] = []
      walkFiles(attachRoot, all, 0, notes)
      idx.entries = all.map((path) => {
        const nameBase = (path.split(/[\\/]/).pop() ?? '').replace(/\.dat$/i, '').replace(/_(t|h|b|thumb.*)$/i, '')
        const lower = path.toLowerCase()
        return {
          path,
          nameBase,
          isHash: MD5_NAME_RE.test(nameBase),
          isThumb: lower.includes('_t.') || lower.includes('_h.') || lower.includes('_b.') || lower.includes('_thumb'),
        }
      })
      refreshAttach(idx, notes)
    }
    mark('attach-walk')
    // 突发闸门：一屏里连续多个未命中只推进一次解密（见 ATTACH_DRAIN_MIN_INTERVAL_MS）
    if (Date.now() - idx.drainedAt >= ATTACH_DRAIN_MIN_INTERVAL_MS) {
      idx.drainedAt = Date.now()
      drainAttach(idx, aesKey, xorKey, ATTACH_BUDGET_FILES, ATTACH_BUDGET_MS)
    }
    mark('attach-drain')
    // 先找缩略图（_t/_h/_b，通常为 jpg，浏览器可直接显示）；HEVC/HEIC 大图回退到最后。
    //
    // ⚠️ `allowThumb: false` 时缩略图**直接跳过**（不是「降级到最后」）：调用方要的是
    // 「只要原图」，它自己会把缩略图那一档留到最后兜底。这条顺序过去是反的 ——
    // 缩略图赢了 CDN 的原图，于是「高清」永远拿不到。
    let hevcFallback: { data: string } | null = null
    for (const f of idx.entries) {
      const nameBase = f.nameBase
      // 前缀匹配必须带**长度门槛**：msg/attach 里有 504 个文件名短于 16 字符（实测有 2 个
      // 就叫 `0_t`），而 `key.startsWith('0')` 对任意以 0 开头的 md5 都成立 ——
      // 于是「目标图本地缺失」时会返回一张毫不相关的图（实测 md5=000…0 也 ok=true）。
      // 只对 ≥16 字符的名字做前缀匹配，短名一律要求完全相等。
      const nameMatch = nameBase === key
        || (nameBase.length >= 16 && (nameBase.startsWith(key) || key.startsWith(nameBase)))
      // 名字本身就是 32 位哈希 ⇒ 命名规则保证「名字 = 明文 md5」，对不上就直接跳过（不解密）。
      if (f.isHash && !nameMatch) continue
      // **非**哈希命名的（本机 3,294 个，形如 `1000_1776833994_t.dat`）：只能比明文 md5，
      // 但那个 md5 已经由 `drainAttach` **一辈子算一次**记在 idx.files 里 —— 没解到 / 已知不等就跳过。
      if (!f.isHash && !nameMatch) {
        const memo = idx.files.get(f.path)
        if (memo === undefined || memo.md5 !== key) continue
      }
      try {
        const bytes = readFileSync(f.path)
        const dec = decodeDatBytes(new Uint8Array(bytes), aesKey ?? null, xorKey)
        if ('error' in dec) continue
        if (md5Of(dec.bytes) !== key && !nameMatch) continue
        const data = dataUrlOf(dec)
        if (f.isThumb) {
          if (!allowThumb) continue
          boundedSet(md5UrlCache, cacheKey, data)
          return { url: data }
        }
        if (!hevcFallback) hevcFallback = { data }
      } catch {
        // next file
      }
    }
    if (hevcFallback) {
      boundedSet(md5UrlCache, cacheKey, hevcFallback.data)
      return { url: hevcFallback.data }
    }
    mark('attach-scan')
    routes.push('msg/attach 按 md5 前缀未命中')
  }
  // 扫不全都说到：这句如果是「目录读不动」，就不该只留下「没有这张图」。
  flushTrace()
  return { error: missWithScanNotes('未找到匹配的本地图片（' + routes.join('；') + '）', notes) }
}
