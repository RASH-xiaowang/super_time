/**
 * Batch decryption of WeChat .dat image files (V2/V1 encrypted, md5-prefixed
 * file names under msg/attach) into the decoded_images cache:
 * `<decoded_images>/<md5>.<ext>`, the same layout decodeImageDataUrl reads,
 * so a batch pass makes per-message lookups hit the cache instantly.
 */
import { promises as fs } from 'node:fs'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { datTierOf, datTierRank, decodeDatBytes, isThumbTier, type DatTier } from './media-image.ts'

/** Image-dat file names start with the content md5: `<md5>[_t|_h].dat`. */
const MD5_PREFIX_RE = /^([0-9a-f]{32})/i

/** Browser-renderable output extensions (hevc/wxgf skipped, counted). */
const WRITE_EXTS = new Set(['jpg', 'png', 'gif', 'webp'])

/** Recursively collect md5-prefixed .dat files under msg/attach. */
function walkDataDats(dir: string, out: string[], depth: number): void {
  if (depth > 10 || !existsSync(dir)) return
  let entries: Array<{ name: string; isDir: boolean }>
  try {
    entries = readdirSync(dir, { withFileTypes: true }).map(e => ({ name: e.name, isDir: e.isDirectory() }))
  } catch { return }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDir) walkDataDats(p, out, depth + 1)
    else if (e.name.toLowerCase().endsWith('.dat') && MD5_PREFIX_RE.test(e.name)) out.push(p)
  }
}

/** Batch decrypt result. */
export interface BatchDecryptResult {
  total: number
  okCount: number
  failed: number
  skipped: number
  errors: Array<{ file: string; error: string }>
  /** 跳过项的原因（已存在缓存 / HEVC 暂不支持 / 格式不支持…），供界面说明「为什么少了几张」。 */
  skippedDetails?: Array<{ file: string; reason: string }>
}

/**
 * Decrypt every md5-prefixed .dat under `<rawRoot>/msg/attach` into the
 * decoded-images cache with a bounded concurrent pool.
 * @param rawRoot - raw WeChat account root (parent of db_storage).
 * @param decodedDir - decoded-images cache root.
 * @param aesKey - V2 AES key (16-char ASCII) or null.
 * @param xorKey - XOR key byte.
 * @param concurrency - worker count (clamped 1..32).
 * @param onProgress - per-file progress callback (processed/total/failed/message).
 * @returns total/ok/failed/skipped counts + per-file errors.
 */
export async function decryptAllImageDats(
  rawRoot: string,
  decodedDir: string,
  aesKey: string | undefined,
  xorKey: number,
  concurrency = 8,
  onProgress?: (processed: number, total: number, failed: number, message: string) => void,
): Promise<BatchDecryptResult> {
  const files: string[] = []
  walkDataDats(join(rawRoot, 'msg', 'attach'), files, 0)
  // 先按档位排序（`_h` 原图 → 主体 → `_t` 缩略），**再按 md5 分组**。
  //
  // 分组不是为了省事，是正确性要求：同一个 md5 的多档必须由**同一个 worker** 顺序处理。
  // 并发 >1 时它们会被不同 worker 同时取走，「谁先写主槽」就变成竞态 —— 实测并发 2 时
  // `.dat`（聊天版）会盖掉 `_h`（原图），症状正是「明明点开过大图，缓存里还是糊的」。
  // 分组后档位回退（原图解不开就退聊天版、再退缩略图）在同一处按序走完。
  files.sort((a, b) => datTierRank(a) - datTierRank(b))
  const groups = new Map<string, string[]>()
  for (const file of files) {
    const name = file.split(/[\\/]/).pop() ?? ''
    const md5 = (MD5_PREFIX_RE.exec(name)?.[1] ?? '').toLowerCase()
    if (!md5) continue
    const bucket = groups.get(md5)
    if (bucket) bucket.push(file)
    else groups.set(md5, [file])
  }
  const work = [...groups.entries()]
  const aes = aesKey && aesKey.trim().length > 0 ? aesKey.trim() : null

  let okCount = 0
  let failed = 0
  let skipped = 0
  const errors: Array<{ file: string; error: string }> = []
  const skippedDetails: Array<{ file: string; reason: string }> = []
  let cursor = 0
  let processed = 0
  /** 本次运行里已经写过主槽的 md5 → 用的是哪一档（用于把「跳过」的原因写准）。 */
  const writtenMain = new Map<string, DatTier>()
  /**
   * 该 md5 在指定槽位是否已有可渲染的解码缓存。
   *
   * **不把 `.hevc` 当命中**：那是上一版「wxgf 解不开」的失败标记 —— 本机装上解码库之后
   * 应该重解一次，而不是被一个占位文件永久钉住。
   */
  const hasCached = (md5: string, thumb: boolean): boolean => {
    for (const ext of WRITE_EXTS) {
      if (existsSync(join(decodedDir, md5 + (thumb ? '.t.' : '.') + ext))) return true
    }
    return false
  }

  /** 处理一个 md5 的某一档：已有相同或更好的就跳过，否则解码并按槽位落盘。 */
  const handleOne = async (md5: string, file: string, name: string): Promise<void> => {
    try {
      // 旧实现这一段只 `continue` 了**内层** for ⇒ 记录写着「无需重复解码」却照样解码，
      // 而且同一 md5 各档写同一个文件名，最后落盘的往往是 `_t`（缩略图盖进主槽）。
      const tier = datTierOf(file)
      const thumbTier = isThumbTier(file)
      if (writtenMain.has(md5) || hasCached(md5, false) || (thumbTier && hasCached(md5, true))) {
        // 原因写清「**已有的那一档**」而不是被跳过这一档 —— 用户看的是「为什么这张没解」。
        const have = writtenMain.get(md5)
        skipped += 1
        skippedDetails.push({
          file: name,
          reason: have
            ? `同一张图已用 ${have} 档解出（${md5}），跳过 ${tier} 档`
            : `已有主槽缓存（${md5}），跳过 ${tier} 档`,
        })
        return
      }
      const bytes = await fs.readFile(file)
      const dec = decodeDatBytes(new Uint8Array(bytes), aes, xorKey)
      if ('error' in dec) { failed += 1; errors.push({ file: name, error: dec.error }); return }
      if (dec.format === 'hevc') {
        skipped += 1
        skippedDetails.push({
          file: name,
          reason: 'wxgf 原图：未找到微信解码库（VoipEngine.dll）或转码失败，本机暂不可渲染',
        })
        return
      }
      const ext = dec.format === 'jpeg' ? 'jpg' : dec.format
      if (!WRITE_EXTS.has(ext)) {
        skipped += 1
        skippedDetails.push({ file: name, reason: `不支持的图片格式（${ext}），已跳过` })
        return
      }
      await fs.mkdir(decodedDir, { recursive: true })
      // `_t`（与更差的档位）进 `.t.` 兜底槽，`_h`/主体进主槽 —— 与单张读取路径的槽位约定一致。
      await fs.writeFile(join(decodedDir, md5 + (thumbTier ? '.t.' : '.') + ext), Buffer.from(dec.bytes))
      if (!thumbTier) writtenMain.set(md5, tier)
      okCount += 1
    } catch (e) {
      failed += 1
      errors.push({ file: name, error: (e as Error).message })
    } finally {
      processed += 1
      onProgress?.(processed, files.length, failed, name)
    }
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor
      cursor += 1
      if (idx >= work.length) return
      const entry = work[idx]
      if (entry === undefined) return
      const [md5, groupFiles] = entry
      // 同一张图的档位在这里**顺序**走完：`_h` 落主槽后，低档位命中 `hasCached(md5, false)`
      // 而跳过 —— 既不会覆盖，也让 processed 计数照样走满。
      for (const file of groupFiles) {
        const name = file.split(/[\\/]/).pop() ?? ''
        await handleOne(md5, file, name)
      }
    }
  }

  const pool: Promise<void>[] = []
  const workers = Math.max(1, Math.min(Math.floor(concurrency), 32))
  for (let i = 0; i < workers; i += 1) pool.push(worker())
  await Promise.all(pool)
  return { total: files.length, okCount, failed, skipped, errors, skippedDetails }
}
