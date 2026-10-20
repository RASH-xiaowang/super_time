/**
 * 朋友圈**原图**的落盘缓存（`<数据根>/decoded_images/sns-media/`）与**长期归档**
 * （`<数据根>/moments-media/`，2026-10-19 加）。
 *
 * 主缓存放 `decoded_images` 下，换密钥时会被整体清空；用户要求「CDN 原图落盘后保留」，
 * 所以再加一份独立于解码缓存的长期归档，按 md5 内容寻址，读取时长期归档优先。
 *
 * ## 为什么要有它
 *
 * 用户的诉求是「拿到高清原图、自动存下来、以后每次进入都用它」。而在这之前有两条路都会
 * 把**缩略图**当成最终结果交出去：
 *
 *   · `sns-image.ts` 的 `msg/attach` 兜底**优先**返回 `_t/_h/_b` 缩略图（注释写着
 *     「通常为 jpg，浏览器可直接显示」），而它排在 CDN 之前 ⇒ 本机有缩略图就永远轮不到原图；
 *   · 前端 IndexedDB 只存 `{url, at}`，**不记这是不是原图** ⇒ 老版本存下来的缩略图
 *     会永久遮住后来取到的高清图。
 *
 * 于是这里提供两件事：
 *   1. **一张落盘的原图优先于一切**（进朋友圈先查这里 ⇒ 这就是「每次进入自动用原图覆盖缩略图」）；
 *   2. **只收确认是原图的字节**（CDN 尺寸段 `/0`、或本机 `Sns/Img` 命中的那份）。
 *      `msg/attach` 的缩略图**不进这里** —— 让它进来就等于把它变成永久的「高清」。
 *
 * ## 为什么不放微信原始目录
 *
 * 微信目录是只读的事实来源，往里写会让「本机有什么」和「我们自己存了什么」混成一谈，
 * 也会被微信自己的清理逻辑卷走。放在 `decoded_images` 下有额外一层好处：
 * `wechat-config.ts` 在**密钥变更**时会整体清掉该目录 ⇒ 缓存自动失效重取，语义正好。
 *
 * ## 落盘纪律
 *
 *   · **先写 `.part` 再 rename**：半个文件比没有文件更坏 —— 它会被当原图缓存下来，
 *     此后每次进入都返回一张坏图，而且再也不会重抓；
 *   · **写失败绝不影响本次展示**（与 `article-cover.ts` 同口径）：磁盘满、只读目录、
 *     权限不足都只是「这次没存上」，取图本身照常返回；
 *   · **淘汰按字节**（默认 2 GB）而不是条数：一张原图 base64 后能到几百 KB，
 *     按条数算等于没上限。
 *
 * @module query/sns-media-store
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'
import { MD5_RE } from '../md5.ts'

/** 落盘子目录名（在 `decoded_images` 之下，与 `article-covers` 同级）。 */
export const SNS_MEDIA_STORE_SUBDIR = 'sns-media'

/**
 * 容量上限（字节）。默认 2 GB。
 *
 * 为什么按字节：朋友圈原图普遍 200–800 KB，按条数（哪怕 4000 条）也会上 GB。
 * 环境变量 `SUPERTIME_SNS_MEDIA_STORE_BYTES` 可覆盖（测试与「我想少留点」的场景）。
 */
export const SNS_MEDIA_STORE_BUDGET_BYTES = ((): number => {
  const raw = Number(process.env['SUPERTIME_SNS_MEDIA_STORE_BYTES'] ?? '')
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2 * 1024 * 1024 * 1024
})()

/**
 * W3-4.3：**条数**上陔。
 *
 * 为什么除了字节还要条数：字节上陔在“平均大小”稳定时很有效，但有两类情形它管不到：
 * 很多小图（表情、缩略图，几十 KB），以及“同一张图被不断重新保存”。
 * 后者耗尽的是 inode/目录项，而 Windows 上一个目录数万条后列目录
 * 会明显变慢（本库按 md5 前两位分 shard，但一个 shard 仍然可以很多）。
 * 20000 条对 2GB 预算来说意味着平均 100KB/张 —— 超过它就说明
 * 存的东西比“原图”小得多，该回收了。
 * 环境变量 `SUPERTIME_SNS_MEDIA_STORE_FILES` 可覆盖（与字节那个同构）。
 */
export const SNS_MEDIA_STORE_BUDGET_FILES = ((): number => {
  const raw = Number(process.env['SUPERTIME_SNS_MEDIA_STORE_FILES'] ?? '')
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20_000
})()
/** 认识的原图格式 → 扩展名。顺序即查找顺序，所以把最常见的 jpeg 放最前。 */
const EXTS: ReadonlyArray<{ ext: string; mime: string }> = [
  { ext: 'jpg', mime: 'image/jpeg' },
  { ext: 'png', mime: 'image/png' },
  { ext: 'webp', mime: 'image/webp' },
  { ext: 'avif', mime: 'image/avif' },
  { ext: 'heic', mime: 'image/heic' },
  { ext: 'gif', mime: 'image/gif' },
  { ext: 'bmp', mime: 'image/bmp' },
]

/**
 * md5 字面量的唯一出处是 `md5.ts`（`md5-image-key.spec.ts` 对「md5 正则只许住在那里」零容忍）——
 * 这里**不复写**一份，哪怕两者当前完全同义：抄一份就等于把口径又分叉了。
 * 直接用上面 import 进来的 {@link MD5_RE}（= 32 位小写十六进制整串）。
 */

/**
 * 小于这个字节数的一律不认。
 *
 * 为什么要有：只看魔数的话，一个只剩 `[ff d8]` 的截断文件照样通过 JPEG 判定，而它会被
 * 永久缓存、此后每次进入都返回它。16 字节远低于任何真实缩略图（本机实测最小的一张
 * 6479 字节），所以这道门槛只会挡住残桩。
 *
 * 诚实说明它挡不住什么：一个「头对、但被砍掉一大截」的文件在字节层面与「小图」无法区分，
 * 要判真伪得整体解码一遍 —— 代价与收益不成比例。这里的兜底是**写入侧的原子改名**
 * （先 `.part` 再 `rename`），所以真出现半截文件只可能是外部改动，而那属于要报警的情况。
 */
const MIN_ORIGINAL_BYTES = 16

/** 从字节头判格式；认不出返回 `null`（**不猜** —— 猜错会把坏字节当原图永久缓存）。 */
export function sniffOriginalExt(b: Uint8Array): string | null {
  if (b.length < MIN_ORIGINAL_BYTES) return null
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xd8) return 'jpg'
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp'
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = ascii(b, 8, 4)
    if (brand === 'avif') return 'avif'
    // heif/mif1/msf1 落成 `.heic`：容器一样，扩展名不必细分（与 `sns-cdn-image.ts` 同一口径）
    if (brand === 'heic' || brand === 'heix' || brand === 'hevc' || brand === 'hevx'
      || brand === 'heif' || brand === 'mif1' || brand === 'msf1') return 'heic'
  }
  if (b.length >= 6 && ascii(b, 0, 3) === 'GIF') return 'gif'
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  return null
}

function ascii(b: Uint8Array, at: number, len: number): string {
  let s = ''
  for (let i = 0; i < len; i += 1) s += String.fromCharCode(b[at + i] ?? 0)
  return s
}

/** 该扩展名对应的 mime（供调用方直接拼 data URL，省得再判一次）。 */
export function mimeOfExt(ext: string): string {
  return EXTS.find((e) => e.ext === ext)?.mime ?? 'application/octet-stream'
}

function shardOf(decodedDir: string, md5: string): string {
  return join(decodedDir, SNS_MEDIA_STORE_SUBDIR, md5.slice(0, 2))
}

/**
 * 查这张图的落盘原图。
 *
 * @param decodedDir - `decoded_images` 目录（`rc.dirs().decoded`）。
 * @param md5 - 32 位媒体 md5。
 * @returns 命中的字节与格式；没有则 `null`。
 */
export function lookupOriginal(decodedDir: string, md5: string): { bytes: Buffer; ext: string } | null {
  const key = (md5 || '').trim().toLowerCase()
  if (!decodedDir || !MD5_RE.test(key)) return null
  const shard = shardOf(decodedDir, key)
  for (const e of EXTS) {
    const p = join(shard, key + '.' + e.ext)
    try {
      if (!existsSync(p)) continue
      const bytes = readFileSync(p)
      // 落盘的可能被外部工具截断过 ⇒ 读回来再认一次头，认不出就当没有（宁可重抓）
      if (bytes.length === 0 || sniffOriginalExt(bytes) !== e.ext) continue
      return { bytes, ext: e.ext }
    } catch {
      // 读不动（权限/被占用）⇒ 继续试下一个扩展名
    }
  }
  return null
}

/** 最近一次淘汰发生在什么时候（毫秒时间戳）；用于节流。 */
let lastSweepAt = 0
/** 自上次淘汰以来新写入了多少张；用来避免小写入频繁全盘遍历。 */
let writesSinceSweep = 0

/** 淘汰的最小间隔：再密也不会比这个更频繁地全盘遍历。 */
const SWEEP_MIN_INTERVAL_MS = 60_000
/** 写够这么多张才考虑淘汰一次（写 0 张时也允许一次，用于长期挂机后的首次进入）。 */
const SWEEP_EVERY_N_WRITES = 64

/**
 * 按字节预算淘汰最旧的原图（`mtime` 升序先删）。
 *
 * 用 `mtime` 而不是 `atime`：原图写进去之后基本不会被再读（读的是内存缓存与前端缓存），
 * 而 Windows 的 `atime` 默认不可靠。`mtime` 至少稳定地代表「什么时候存的」。
 *
 * @returns 被删掉的张数。
 */
export function sweepOriginalStore(
  decodedDir: string,
  budgetBytes = SNS_MEDIA_STORE_BUDGET_BYTES,
  budgetFiles = SNS_MEDIA_STORE_BUDGET_FILES,
): number {
  const root = join(decodedDir, SNS_MEDIA_STORE_SUBDIR)
  if (!existsSync(root)) return 0
  const files: Array<{ p: string; size: number; mtimeMs: number }> = []
  let total = 0
  let dirs: string[] = [root]
  while (dirs.length > 0) {
    const d = dirs.pop() as string
    let entries: import('node:fs').Dirent[]
    try { entries = readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) { dirs.push(p); continue }
      try {
        const st = statSync(p)
        files.push({ p, size: st.size, mtimeMs: st.mtimeMs })
        total += st.size
      } catch { /* 扫不到就跳过 */ }
    }
  }
  // W3-4.3：字节或条数任一超陔都开始回收。
  // 注意 dropped 必须在 overBudget 之前声明：闭包里读它，
  // 写在后面就是 TDZ（第一版就这样，运行时才报 Cannot access）。
  let dropped = 0
  const overBudget = (): boolean => total > budgetBytes || files.length - dropped > budgetFiles
  if (!overBudget()) return 0
  files.sort((a, b) => a.mtimeMs - b.mtimeMs)
  for (const f of files) {
    if (!overBudget()) break
    try { unlinkSync(f.p); total -= f.size; dropped += 1 } catch { /* 删不掉就跳过 */ }
  }
  return dropped
}

/**
 * 把一份**确认是原图**的字节存下来。
 *
 * @param decodedDir - `decoded_images` 目录。
 * @param md5 - 32 位媒体 md5（缓存键，内容寻址 ⇒ 同名必同内容，重复写无害）。
 * @param bytes - 原图字节。
 * @returns 落盘的扩展名；**不是图片 / 参数不合法 / 写失败**一律返回 `null`。
 *          返回 `null` 只表示「这次没存上」，调用方照常返回本次结果，不得因此报错。
 */
export function saveOriginal(decodedDir: string, md5: string, bytes: Uint8Array): string | null {
  const key = (md5 || '').trim().toLowerCase()
  if (!decodedDir || !MD5_RE.test(key)) return null
  const ext = sniffOriginalExt(bytes)
  if (ext === null) return null
  try {
    const shard = shardOf(decodedDir, key)
    if (!existsSync(shard)) mkdirSync(shard, { recursive: true })
    const target = join(shard, key + '.' + ext)
    if (existsSync(target)) return ext
    // 先写临时文件再改名：半个文件会被当原图缓存下来，此后每次都返回坏图且永不重抓
    const part = target + '.part'
    writeFileSync(part, bytes)
    try { renameSync(part, target) } catch {
      // 极端情况下 rename 失败 ⇒ 清掉临时文件，别留垃圾
      try { unlinkSync(part) } catch { /* best-effort */ }
      return null
    }
    writesSinceSweep += 1
    const now = Date.now()
    if (writesSinceSweep >= SWEEP_EVERY_N_WRITES && now - lastSweepAt >= SWEEP_MIN_INTERVAL_MS) {
      lastSweepAt = now
      writesSinceSweep = 0
      sweepOriginalStore(decodedDir)
    }
    return ext
  } catch {
    // 磁盘满 / 只读 / 权限不足：只是这次没存上
    return null
  }
}

/** 把落盘原图变成 data URL（省得调用方再拼一次 mime）。 */
export function originalAsDataUrl(hit: { bytes: Buffer; ext: string }): string {
  return 'data:' + mimeOfExt(hit.ext) + ';base64,' + hit.bytes.toString('base64')
}

/**
 * 朋友圈原图**长期归档**目录（2026-10-19 用户：「CDN 原图落盘后请保留在本地」）。
 *
 * 与 `decoded_images/sns-media` 的区别：后者是「解码缓存」，`wechat-config.ts` 在密钥
 * 变更时会整体清空；这里放在**数据根**下（`<数据根>/moments-media/`），不随解码缓存
 * 失效 —— 只要原图被我们拿到过一次，换密钥/重新解密后仍可直接用，不必再向 CDN 要。
 *
 * 目录布局仍是 `md5 前两位分 shard`（与主缓存同构），按 md5 内容寻址：
 * 同名必同内容，重复写入无害，也不存在「任务/朋友圈之间串图」。
 */
export const MOMENTS_MEDIA_SUBDIR = 'moments-media'

/** 长期归档容量（字节）。默认 8 GB；`SUPERTIME_MOMENTS_MEDIA_BYTES` 可覆盖。 */
export const MOMENTS_MEDIA_BUDGET_BYTES = ((): number => {
  const raw = Number(process.env['SUPERTIME_MOMENTS_MEDIA_BYTES'] ?? '')
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 8 * 1024 * 1024 * 1024
})()

/** 长期归档条数上限。默认 50000；`SUPERTIME_MOMENTS_MEDIA_FILES` 可覆盖。 */
export const MOMENTS_MEDIA_BUDGET_FILES = ((): number => {
  const raw = Number(process.env['SUPERTIME_MOMENTS_MEDIA_FILES'] ?? '')
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 50_000
})()

/** 长期归档根（数据根下，与 `decoded_images` 同级）。 */
export function momentsMediaArchiveRoot(decodedDir: string): string {
  // 生产布局是 `<数据根>/decoded_images`；显式 pin 的目录（或测试里传数据根）放它自己里面，
  // 避免把同名归档写到共享父目录（`%TEMP%`）里与其它进程/用例互相污染。
  if (basename(decodedDir) === 'decoded_images') return join(dirname(decodedDir), MOMENTS_MEDIA_SUBDIR)
  return join(decodedDir, MOMENTS_MEDIA_SUBDIR)
}

function archiveShardOf(decodedDir: string, md5: string): string {
  return join(momentsMediaArchiveRoot(decodedDir), md5.slice(0, 2))
}

/**
 * 查**长期归档**里的原图（进入朋友圈的第一判断）。
 * @param decodedDir - `decoded_images` 目录（用它定位数据根）。
 * @param md5 - 32 位媒体 md5。
 * @returns 命中的字节与格式；没有则 `null`。
 */
export function lookupArchivedOriginal(decodedDir: string, md5: string): { bytes: Buffer; ext: string } | null {
  const key = (md5 || '').trim().toLowerCase()
  if (!decodedDir || !MD5_RE.test(key)) return null
  const shard = archiveShardOf(decodedDir, key)
  for (const e of EXTS) {
    const p = join(shard, key + '.' + e.ext)
    try {
      if (!existsSync(p)) continue
      const bytes = readFileSync(p)
      if (bytes.length < MIN_ORIGINAL_BYTES) continue
      return { bytes, ext: e.ext }
    } catch { /* 读不到就试下一个扩展名 */ }
  }
  return null
}

/** 归档淘汰节流：每 100 次写或 5 分钟检查一次，避免每次保存都全扫。 */
let archiveWritesSinceSweep = 0
let lastArchiveSweepAt = 0
const ARCHIVE_SWEEP_EVERY_N_WRITES = 100
const ARCHIVE_SWEEP_MIN_INTERVAL_MS = 5 * 60_000

/**
 * 把原图写入**长期归档**。
 *
 * 与主缓存同一套纪律：先 `.part` 再 rename（半截文件会被当原图永久缓存）；写失败只是
 * 「这次没存上」，不影响本次展示。容量超了按 mtime 淘汰最旧的（默认 8GB/5 万张，
 * 远高于普通用户朋友圈总量；淘汰是最后手段，不是常态）。
 * @param decodedDir - `decoded_images` 目录。
 * @param md5 - 32 位媒体 md5。
 * @param bytes - 原图字节。
 * @returns 落盘扩展名；不是图片/写失败为 `null`。
 */
export function saveArchivedOriginal(decodedDir: string, md5: string, bytes: Uint8Array): string | null {
  const key = (md5 || '').trim().toLowerCase()
  if (!decodedDir || !MD5_RE.test(key)) return null
  const ext = sniffOriginalExt(bytes)
  if (ext === null) return null
  try {
    const shard = archiveShardOf(decodedDir, key)
    if (!existsSync(shard)) mkdirSync(shard, { recursive: true })
    const target = join(shard, key + '.' + ext)
    if (existsSync(target)) return ext
    const part = target + '.part'
    writeFileSync(part, bytes)
    try { renameSync(part, target) } catch {
      try { unlinkSync(part) } catch { /* best-effort */ }
      return null
    }
    archiveWritesSinceSweep += 1
    const now = Date.now()
    if (archiveWritesSinceSweep >= ARCHIVE_SWEEP_EVERY_N_WRITES && now - lastArchiveSweepAt >= ARCHIVE_SWEEP_MIN_INTERVAL_MS) {
      lastArchiveSweepAt = now
      archiveWritesSinceSweep = 0
      sweepMomentsMediaArchive(decodedDir)
    }
    return ext
  } catch {
    return null
  }
}

/**
 * 按容量回收长期归档（按 mtime 从旧到新删，直到低于预算）。
 * @param decodedDir - `decoded_images` 目录。
 * @param budgetBytes - 字节预算。
 * @param budgetFiles - 条数预算。
 * @returns 删除的条数。
 */
export function sweepMomentsMediaArchive(
  decodedDir: string,
  budgetBytes = MOMENTS_MEDIA_BUDGET_BYTES,
  budgetFiles = MOMENTS_MEDIA_BUDGET_FILES,
): number {
  const root = momentsMediaArchiveRoot(decodedDir)
  if (!existsSync(root)) return 0
  const files: Array<{ p: string; size: number; mtimeMs: number }> = []
  let total = 0
  let shards: string[] = []
  try { shards = readdirSync(root) } catch { return 0 }
  for (const shard of shards) {
    const dir = join(root, shard)
    let names: string[] = []
    try { names = readdirSync(dir) } catch { continue }
    for (const name of names) {
      const p = join(dir, name)
      try {
        const st = statSync(p)
        if (!st.isFile() || name.endsWith('.part')) continue
        files.push({ p, size: st.size, mtimeMs: st.mtimeMs })
        total += st.size
      } catch { /* 扫不到就跳过 */ }
    }
  }
  let dropped = 0
  const overBudget = (): boolean => total > budgetBytes || files.length - dropped > budgetFiles
  if (!overBudget()) return 0
  files.sort((a, b) => a.mtimeMs - b.mtimeMs)
  for (const f of files) {
    if (!overBudget()) break
    try { unlinkSync(f.p); total -= f.size; dropped += 1 } catch { /* 删不掉就跳过 */ }
  }
  return dropped
}

/** 测试用：清掉长期归档的淘汰节流状态。 */
export function forgetMomentsArchiveSweepStateForTest(): void {
  archiveWritesSinceSweep = 0
  lastArchiveSweepAt = 0
}

/** 测试用：清掉淘汰节流的状态（否则两条用例之间会互相吞掉）。 */
export function forgetSweepStateForTest(): void {
  lastSweepAt = 0
  writesSinceSweep = 0
}