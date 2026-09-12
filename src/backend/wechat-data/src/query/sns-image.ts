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
  mtimeMs: number
  size: number
  byMd5: Map<string, string>
}
interface SnsImageIndex {
  months: Map<string, MonthEntry>
  /** 认过「全月份扫完都没有」的 key（索引一旦有月份被重新扫描就清空）。 */
  misses: Set<string>
}
const snsImageIndex = new Map<string, SnsImageIndex>()

/** 列出 `cache/<月>/Sns/Img` 根目录及其签名，按月份由新到旧排序。 */
function snsMonthRoots(wechatBaseDir: string): Array<{ month: string; root: string; mtimeMs: number; size: number }> {
  const cacheRoot = join(wechatBaseDir, 'cache')
  const out: Array<{ month: string; root: string; mtimeMs: number; size: number }> = []
  if (!existsSync(cacheRoot)) return out
  let months: string[] = []
  try { months = readdirSync(cacheRoot) } catch { return out }
  for (const month of months.sort().reverse()) {
    const root = join(cacheRoot, month, 'Sns', 'Img')
    if (!existsSync(root)) continue
    try {
      const st = statSync(root)
      out.push({ month, root, mtimeMs: st.mtimeMs, size: st.size })
    } catch { /* skip */ }
  }
  return out
}

/** 扫描一个月份目录，得到「明文 md5 → 文件路径」。 */
function scanMonth(root: string, aesKey: string | undefined, xorKey: number): Map<string, string> {
  const byMd5 = new Map<string, string>()
  const files: string[] = []
  walkFiles(root, files, 0)
  for (const f of files) {
    try {
      const dec = decodeDatBytes(new Uint8Array(readFileSync(f)), aesKey ?? null, xorKey)
      if ('error' in dec) continue
      const key = md5Of(dec.bytes)
      if (!byMd5.has(key)) byMd5.set(key, f)
    } catch {
      // next file
    }
  }
  return byMd5
}

/**
 * 按月增量查找 `wantMd5`，命中即停。
 * @returns `{ file }` 命中文件；否则 `{ complete }` 表示「是否已按当前签名扫完全部月份」。
 */
function snsResolveByIndex(
  wechatBaseDir: string,
  aesKey: string | undefined,
  xorKey: number,
  wantMd5: string,
): { file?: string; complete: boolean } {
  const roots = snsMonthRoots(wechatBaseDir)
  let idx = snsImageIndex.get(wechatBaseDir)
  if (!idx) { idx = { months: new Map(), misses: new Set() }; snsImageIndex.set(wechatBaseDir, idx) }
  // 月份目录集合变化时，丢弃已不存在的月份缓存
  const live = new Set(roots.map((r) => r.month))
  for (const m of [...idx.months.keys()]) if (!live.has(m)) idx.months.delete(m)

  for (const { month, root, mtimeMs, size } of roots) {
    const cached = idx.months.get(month)
    if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
      const hit = cached.byMd5.get(wantMd5)
      if (hit) return { file: hit, complete: false }
      continue
    }
    // 该月份没扫过 / 签名变了 → 只重扫这一个月
    const byMd5 = scanMonth(root, aesKey, xorKey)
    idx.months.set(month, { mtimeMs, size, byMd5 })
    idx.misses.clear() // 树变了，之前的「未命中」结论失效
    const hit = byMd5.get(wantMd5)
    if (hit) return { file: hit, complete: false }
  }
  return { complete: true }
}

function md5Of(bytes: Uint8Array): string {
  return createHash('md5').update(Buffer.from(bytes)).digest('hex')
}

function walkFiles(dir: string, out: string[], depth: number): void {
  if (depth > 5 || !existsSync(dir)) return
  let entries: Array<{ name: string; isDir: boolean }> = []
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() }))
  } catch {
    return
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDir) walkFiles(p, out, depth + 1)
    else if (!e.name.endsWith('.db') && !e.name.includes('_shm') && !e.name.includes('_wal')) out.push(p)
  }
}

/**
 * Resolve one SNS media md5 to an offline base64 data URL.
 * @param wechatBaseDir - raw WeChat install dir (current account root).
 * @param aesKey - image AES key (16-char ASCII string), optional.
 * @param xorKey - XOR key byte.
 * @param md5 - 32-char media md5 from the moments XML.
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

/** Gather cache/<month>/Sns/Img roots. */
function snsImgRoots(wechatBaseDir: string): string[] {
  const cacheRoot = join(wechatBaseDir, 'cache')
  const out: string[] = []
  if (!existsSync(cacheRoot)) return out
  try {
    for (const e of readdirSync(cacheRoot, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const root = join(cacheRoot, e.name, 'Sns', 'Img')
      if (existsSync(root)) out.push(root)
    }
  } catch {
    // ignore
  }
  return out
}

export function resolveSnsImageDataUrl(
  wechatBaseDir: string | undefined,
  aesKey: string | undefined,
  xorKey: number,
  md5: string,
  timelineId?: string,
  mediaId?: string,
): { url?: string; error?: string } {
  const key = (md5 || '').trim().toLowerCase()
  const cacheKey = (timelineId && mediaId)
    ? createHash('md5').update(timelineId + '_' + mediaId + '_2', 'utf8').digest('hex')
    : key
  if (!cacheKey) return { error: '缺少图片标识' }
  if (md5UrlCache.has(cacheKey)) {
    const cached = md5UrlCache.get(cacheKey) ?? ''
    if (cached) return { url: cached }
  }
  if (!wechatBaseDir) return { error: '未配置微信原始目录，无法离线解码' }
  // 优先：tid_mediaid_type 缓存键路径（WDA 同款算法，兼容 _2/_1/_0/无后缀）
  if (timelineId && mediaId) {
    for (const suffix of ['_2', '_1', '_0', '']) {
      const k = createHash('md5').update(timelineId + '_' + mediaId + suffix, 'utf8').digest('hex')
      const sub = k.slice(0, 2)
      const rest = k.slice(2)
      for (const root of snsImgRoots(wechatBaseDir)) {
        const p = join(root, sub, rest)
        if (existsSync(p)) {
          const data = decodeCachedFile(p, aesKey, xorKey)
          if (data) {
            boundedSet(md5UrlCache, cacheKey, data)
            return { url: data }
          }
        }
      }
    }
  }
  // 无 MD5 时不能全量（会误匹配任意图片），直接失败
  if (!key) {
    return { error: '未找到匹配的本地 SNS 图片' }
  }
  // 索引优先：**按月增量、命中即停**（见 snsResolveByIndex 注释）。
  // 旧实现在索引未命中后还会在下面把同一批文件再全量扫一遍 —— 等于双倍开销，已删除。
  const idxRes = snsResolveByIndex(wechatBaseDir, aesKey, xorKey, key)
  let indexDead = false
  if (idxRes.file) {
    const data = decodeCachedFile(idxRes.file, aesKey, xorKey)
    if (data) {
      boundedSet(md5UrlCache, cacheKey, data)
      return { url: data }
    }
    indexDead = true // 索引指向的文件解不开（损坏/被清理）→ 仍值得兜底扫一遍
  }
  // 兜底：按解密后 MD5 全量扫描（仅当索引已按当前签名扫完所有月份，却仍指向一个解不开的文件）
  if (indexDead || !idxRes.complete) {
  const files: string[] = []
  for (const root of snsImgRoots(wechatBaseDir)) walkFiles(root, files, 0)
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
  const attachRoot = join(wechatBaseDir, 'msg', 'attach')
  if (existsSync(attachRoot)) {
    const attachFiles: string[] = []
    walkFiles(attachRoot, attachFiles, 0)
    // 先找缩略图（_t/_h/_b，通常为 jpg，浏览器可直接显示）；HEVC/HEIC 大图回退到最后
    let hevcFallback: { data: string } | null = null
    for (const f of attachFiles) {
      try {
        const bytes = readFileSync(f)
        const dec = decodeDatBytes(new Uint8Array(bytes), aesKey ?? null, xorKey)
        if ('error' in dec) continue
        const nameBase0 = f.split(/[\\/]/).pop() ?? ''
        const nameBase = nameBase0.replace(/\.dat$/i, '').replace(/_(t|h|b|thumb.*)$/i, '')
        // 前缀匹配必须带**长度门槛**：msg/attach 里有 504 个文件名短于 16 字符（实测有 2 个
        // 就叫 `0_t`），而 `key.startsWith('0')` 对任意以 0 开头的 md5 都成立 ——
        // 于是「目标图本地缺失」时会返回一张毫不相关的图（实测 md5=000…0 也 ok=true）。
        // 只对 ≥16 字符的名字做前缀匹配，短名一律要求完全相等。
        const nameMatch = nameBase === key
          || (nameBase.length >= 16 && (nameBase.startsWith(key) || key.startsWith(nameBase)))
        if (md5Of(dec.bytes) !== key && !nameMatch) continue
        const data = dataUrlOf(dec)
        const lower = f.toLowerCase()
        const isThumb = lower.includes('_t.') || lower.includes('_h.') || lower.includes('_b.') || lower.includes('_thumb')
        if (isThumb) {
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
  }
  return { error: '未找到匹配的本地图片' }
}
