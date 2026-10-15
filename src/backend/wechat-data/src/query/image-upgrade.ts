/**
 * 「升级解码缓存」：把老缓存里由**低档** `.dat`（聊天版 / 缩略图）解出来的图，
 * 用本机现存更好的那一档重解一遍。
 *
 * ## 为什么需要一次显式重解
 *
 * `<decoded>/<md5>.<ext>` 是「谁先解出来谁占坑」的：`decodeImageDataUrl` 第 1 步只要命中
 * 缓存就直接返回，**不会**回头看一眼 `msg/attach` 里是不是多了一份更大的 `.dat`。
 * 于是那批「先解了 `_t` / 聊天版」的缓存，在用户后来于微信里点开原图、或本机装上 wxgf
 * 解码库之后，**仍然是糊的那一份** —— 症状正是「我明明看过原图，这里还是糊的」。
 *
 * 逐条读图时没法顺手修：「本机有没有更好的一份」要扫 `msg/attach`，那是每张图一次目录遍历
 * （`decodeImageDataUrl` 只在缓存**未命中**时才付这个代价），放进每次渲染的路径上不划算，
 * 而且虚拟列表一屏几十张。所以做成一次性动作：用户点一次，之后所有渲染都命中升级后的缓存。
 *
 * ## 判据：只认「严格更大」
 *
 * 缓存条目**没有**记录自己是从哪一档解出来的（老缓存更没有），所以这里不比档位、比**字节数**：
 * 用本机最好的一档重解，只有当结果**严格大于**缓存里现存最大的一份时才覆盖。三条性质靠它：
 *   · **幂等** —— 第二次跑，重解结果与缓存逐字节相同 ⇒ 不满足「更大」⇒ 什么都不动；
 *   · **不降级** —— 缓存里若是 `getImageOriginal` 取回的 CDN 原图（可能比本机 `_h` 还大），
 *     重解本机那份只会更小 ⇒ 跳过；
 *   · **不需要元数据** —— 老缓存没有档位记录也修得动。
 *
 * 代价如实写在下面 §未覆盖：**字节数相同但质量更好的编码不会被换掉**（例如 100KB 的放大图
 * 与 100KB 的真原图）。这是刻意选的保守方向 —— 宁可漏升，不可降级。
 *
 * ## 未覆盖（写清楚，别让人以为它无敌）
 *
 *   · 只在本机 CDN 上有原图（XML 带 `tpurl`/`tphdurl`）的图，本模块**不联网**，
 *     仍要逐条点「取原图」；批量走 CDN 是另一件事（要扫消息表 + 出网开关，不做在这里）。
 *   · 同字节数不同质量的那一类，见上。
 *   · `.t.` 兜底槽里那份**不会被删**：升级后主槽优先，它退化成纯兜底，留着无害。
 */

import { readdirSync, statSync } from 'node:fs'
import { access, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { collectImageDatFiles, collectImageDatFilesAsync, groupImageDatsByMd5 } from './decrypt-images.ts'
import { decodeDatBytesAsync } from './media-image-async.ts'
import { REMOTE_IMAGE_CACHE_DIRNAME } from './remote-image.ts'
import { yieldToLoop } from './search-build.ts'
import { MD5_SEGMENT } from '../md5.ts'

/** 可渲染的缓存扩展名（与 `media-image.ts` 的 `RENDERABLE_EXTS` 同集合，外加 `.hevc` 占位）。 */
const CACHE_EXTS = 'jpg|jpeg|png|gif|webp|bmp|tif'

/**
 * 一个解码缓存文件名：`<32位md5>[.t].<ext>`。
 *
 * `.hevc` 也算进来：它是「上一版 wxgf 解不开」的**失败标记**，本身不可渲染，但
 * `decodeImageDataUrl` 在转码能力不可用时会因它直接早退 —— 所以要能找到它并在升级成功时清掉。
 */
const CACHE_FILE_RE = new RegExp('^(' + MD5_SEGMENT + ')(\\.t)?\\.(' + CACHE_EXTS + '|hevc)$', 'i')

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** 一个 md5 在解码缓存里的现状。 */
interface CachedEntry {
  /** 出现过该 md5 缓存的目录（升级产物要逐个写回这些槽位）。 */
  dirs: string[]
  /** 现存**可渲染**条目的最大字节数 —— 升级的门槛（只有严格更大才写）。 */
  bestBytes: number
}

/**
 * 扫一遍解码缓存，按 md5 归并出「出现在哪些目录、现有多大」。
 *
 * 目录口径：缓存根下的散文件（批量解密、`getImageOriginal`、表情取回都写这里）**加上**
 * 一层子目录（`<username>/`，逐条读图时 `writeDecodedCache` 写的槽位）。
 * **排除 `remote-images/`**：那是远端图片代理的缓存，文件名同样是 32 位十六进制
 * （它是 url 的 md5），不排除就会把一堆「本机根本没有 .dat」的条目算进待升级集合。
 * @param decodedDir - 解码缓存根（`data/wechat/decoded_images`）。
 * @returns md5 → 目录列表与现存最大字节数。
 */
function scanCachedImages(decodedDir: string): Map<string, CachedEntry> {
  const out = new Map<string, CachedEntry>()
  const add = (dir: string, name: string): void => {
    const m = CACHE_FILE_RE.exec(name)
    if (m === null) return
    const md5 = (m[1] ?? '').toLowerCase()
    let e = out.get(md5)
    if (e === undefined) { e = { dirs: [], bestBytes: 0 }; out.set(md5, e) }
    if (!e.dirs.includes(dir)) e.dirs.push(dir)
    if ((m[3] ?? '').toLowerCase() === 'hevc') return
    try {
      const size = statSync(join(dir, name)).size
      if (size > e.bestBytes) e.bestBytes = size
    } catch { /* 读不到大小就当 0：它不构成升级门槛 */ }
  }
  let rootEntries: Array<{ name: string; isDir: boolean }> = []
  try {
    rootEntries = readdirSync(decodedDir, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() }))
  } catch { return out }
  const subDirs: string[] = []
  for (const e of rootEntries) {
    if (!e.isDir) { add(decodedDir, e.name); continue }
    if (e.name === REMOTE_IMAGE_CACHE_DIRNAME) continue
    subDirs.push(join(decodedDir, e.name))
  }
  for (const dir of subDirs) {
    let files: string[] = []
    try { files = readdirSync(dir, { withFileTypes: true }).filter(f => !f.isDirectory()).map(f => f.name) } catch { continue }
    for (const name of files) add(dir, name)
  }
  return out
}

/**
 * {@link scanCachedImages} 的**可让出版**：每扫完一个子目录让出一次事件循环。
 *
 * 与同步版共用同一套判定（`CACHE_FILE_RE` + `add` 的语义逐条照搬），只把"扫子目录"的循环
 * 变成会让出。为什么要单独写而不是把同步版改成 async：同步版还被别处调用，
 * 那些路径（如逐条读图时的单槽位查询）不需要让出，改了会平白引入 await。
 * @param decodedDir - 解码缓存根（`data/wechat/decoded_images`）。
 * @param everyDirs - 每扫多少个目录让出一次（默认 40）。
 * @returns md5 → 目录列表与现存最大字节数。
 */
async function scanCachedImagesAsync(decodedDir: string, everyDirs = 40): Promise<Map<string, CachedEntry>> {
  const out = new Map<string, CachedEntry>()
  const add = (dir: string, name: string): void => {
    const m = CACHE_FILE_RE.exec(name)
    if (m === null) return
    const md5 = (m[1] ?? '').toLowerCase()
    let e = out.get(md5)
    if (e === undefined) { e = { dirs: [], bestBytes: 0 }; out.set(md5, e) }
    if (!e.dirs.includes(dir)) e.dirs.push(dir)
    if ((m[3] ?? '').toLowerCase() === 'hevc') return
    try {
      const size = statSync(join(dir, name)).size
      if (size > e.bestBytes) e.bestBytes = size
    } catch { /* 读不到大小就当 0：它不构成升级门槛 */ }
  }
  let rootEntries: Array<{ name: string; isDir: boolean }> = []
  try {
    rootEntries = readdirSync(decodedDir, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() }))
  } catch { return out }
  const subDirs: string[] = []
  for (const e of rootEntries) {
    if (!e.isDir) { add(decodedDir, e.name); continue }
    if (e.name === REMOTE_IMAGE_CACHE_DIRNAME) continue
    subDirs.push(join(decodedDir, e.name))
  }
  let n = 0
  for (const dir of subDirs) {
    let files: string[] = []
    try { files = readdirSync(dir, { withFileTypes: true }).filter(f => !f.isDirectory()).map(f => f.name) } catch { continue }
    for (const name of files) add(dir, name)
    if (++n % everyDirs === 0) await yieldToLoop()
  }
  return out
}

/** 升级结果（类型在 `types-config.ts` 里再导出给 Remote 客户端）。 */export interface ImageUpgradeResult {
  /** 检查过的缓存条目数（按 md5 去重）。 */
  total: number
  /** 真的被换成更大一份的 md5 数。 */
  upgraded: number
  /** 本机最好的一份不比缓存大 —— 已经是最好了。 */
  unchanged: number
  /** `msg/attach` 里没有这个 md5 的 `.dat`（只在微信里、本机没落盘）。 */
  noSource: number
  /** 有源但一档都解不开（读失败 / 密钥不对 / wxgf 转码不可用）。 */
  failed: number
  errors: Array<{ file: string; error: string }>
  /** 升级明细：每张的 md5、升级前后字节数与格式（界面用来说明「大了多少」）。 */
  details?: Array<{ md5: string; from: number; to: number; format: string }>
  /** 跳过与失败的原因（沿用批量解密的 `skippedDetails` 口径，界面「详情」弹窗直接复用）。 */
  skippedDetails?: Array<{ file: string; reason: string }>
  /** 整体失败（如「已有解密任务进行中」）时的说明；此时计数全为 0。 */
  error?: string
}

/**
 * 把解码缓存里能用更好的一档重解的图，全部重解一遍。
 *
 * 顺序执行、不开并发：解码是 CPU 绑定且可能调原生转码（`VoipEngine.dll`），并发只会让
 * 「哪一张崩了」更难定位；这个动作是一次性的，慢一点换可读的错误面划算。
 * @param rawRoot - 微信账号原始根目录（`msg/attach` 的父目录），与批量解密同一个参数。
 * @param decodedDir - 解码缓存根。
 * @param aesKey - V2 AES 密钥（16 字符 ASCII），或 undefined。
 * @param xorKey - XOR key 字节。
 * @param onProgress - 进度回调（已处理 / 总数 / 已失败 / 当前条目说明）。
 * @returns 计数与明细，见 {@link ImageUpgradeResult}。
 */
export async function upgradeDecodedImageCache(
  rawRoot: string,
  decodedDir: string,
  aesKey: string | undefined,
  xorKey: number,
  onProgress?: (processed: number, total: number, failed: number, message: string) => void,
): Promise<ImageUpgradeResult> {
  // 两处目录遍历都改成**可让出**的：本机实测这个接口整段独占事件循环 **186ms 且一次不让出**
  // （`probe-remote.ts` 的"让出 0 且冷跑 >50ms"清单）。它内部是两棵同步 BFS
  // （`scanCachedImages` 读 decoded 缓存、`collectImageDatFiles` 读 attach 树），
  // 量大时正是第 12 轮在 `scanV2Templates` 上遇到过的同一类问题。
  // 串行 worker 上 186ms 意味着这期间**别人的请求全部排队**。
  const cached = await scanCachedImagesAsync(decodedDir)
  const groups = groupImageDatsByMd5(await collectImageDatFilesAsync(rawRoot))
  const aes = aesKey && aesKey.trim().length > 0 ? aesKey.trim() : null
  const total = cached.size

  let processed = 0
  let upgraded = 0
  let unchanged = 0
  let noSource = 0
  let failed = 0
  const errors: Array<{ file: string; error: string }> = []
  const details: Array<{ md5: string; from: number; to: number; format: string }> = []
  const skippedDetails: Array<{ file: string; reason: string }> = []

  // 排序只为让进度与日志稳定可复现（`Map` 的顺序取决于目录枚举，本机与 CI 会不一样）
  const work = [...cached.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  for (const [md5, entry] of work) {
    const candidates = groups.get(md5) ?? []
    let best: { bytes: Uint8Array; format: string } | null = null
    let lastError = ''
    for (const file of candidates) {
      try {
        const dec = await decodeDatBytesAsync(new Uint8Array(await readFile(file)), aes, xorKey)
        if ('error' in dec) { lastError = '解码失败：' + dec.error; continue }
        if (dec.format === 'hevc') {
          lastError = 'wxgf 原图：转码不可用或转码失败（装上微信解码库后重试）'
          continue
        }
        best = dec
        break
      } catch (e) {
        lastError = '读取失败：' + (e as Error).message
      }
    }
    if (best === null) {
      if (candidates.length === 0) {
        noSource += 1
        skippedDetails.push({ file: md5, reason: '本机没有这张图的 .dat（可能只在微信里，未落盘），无从升级' })
      } else {
        failed += 1
        errors.push({ file: md5, error: lastError || '没有可解码的档位' })
      }
    } else if (best.bytes.length <= entry.bestBytes) {
      unchanged += 1
      skippedDetails.push({ file: md5, reason: '缓存里那份已不比本机任何一档小，无需升级' })
    } else {
      const ext = best.format === 'jpeg' ? 'jpg' : best.format
      let wrote = 0
      for (const dir of entry.dirs) {
        try {
          await writeFile(join(dir, md5 + '.' + ext), Buffer.from(best.bytes))
          wrote += 1
          // 顺手清掉同目录的 `.hevc` 占位：它会让「解码库装好了」的那次重解被短接
          // （`media-image.ts` 的早退判据），留着就是一颗埋在缓存里的钉子。
          try {
            const hevc = join(dir, md5 + '.hevc')
            if (await pathExists(hevc)) await rm(hevc)
          } catch { /* 删不掉不影响这张图已经升级 */ }
        } catch (e) {
          errors.push({ file: md5, error: '写入失败：' + (e as Error).message })
        }
      }
      if (wrote === 0) {
        failed += 1
      } else {
        upgraded += 1
        details.push({ md5, from: entry.bestBytes, to: best.bytes.length, format: best.format })
      }
    }
    processed += 1
    onProgress?.(processed, total, failed, md5)
  }

  return {
    total, upgraded, unchanged, noSource, failed, errors,
    ...(details.length > 0 ? { details } : {}),
    ...(skippedDetails.length > 0 ? { skippedDetails } : {}),
  }
}
