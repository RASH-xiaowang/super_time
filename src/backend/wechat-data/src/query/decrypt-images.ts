/**
 * Batch decryption of WeChat .dat image files (V2/V1 encrypted, md5-prefixed
 * file names under msg/attach) into the decoded_images cache:
 * `<decoded_images>/<md5>.<ext>`, the same layout decodeImageDataUrl reads,
 * so a batch pass makes per-message lookups hit the cache instantly.
 */
import { promises as fs } from 'node:fs'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decodeDatBytes } from './media-image.ts'

/** Image-dat file names start with the content md5: `<md5>[_t|_h].dat`. */
const MD5_PREFIX_RE = /^([0-9a-f]{32})/i

/** Browser-renderable output extensions (hevc/wxgf skipped, counted). */
const WRITE_EXTS = new Set(['jpg', 'png', 'gif', 'webp'])

/** Prefer full images over thumbnails for the same md5 (0 best). */
function scoreDatPath(p: string): number {
  if (p.endsWith('_t.dat')) return 2
  if (p.endsWith('_h.dat')) return 1
  return 0
}

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
  files.sort((a, b) => scoreDatPath(a) - scoreDatPath(b))
  const aes = aesKey && aesKey.trim().length > 0 ? aesKey.trim() : null

  let okCount = 0
  let failed = 0
  let skipped = 0
  const errors: Array<{ file: string; error: string }> = []
  const skippedDetails: Array<{ file: string; reason: string }> = []
  let cursor = 0
  let processed = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = cursor
      cursor += 1
      if (idx >= files.length) return
      const file = files[idx]
      if (file === undefined) return
      const name = file.split(/[\\/]/).pop() ?? ''
      const md5 = (MD5_PREFIX_RE.exec(name)?.[1] ?? '').toLowerCase()
      try {
        for (const ext of WRITE_EXTS) {
          if (existsSync(join(decodedDir, md5 + '.' + ext))) {
            skipped += 1
            skippedDetails.push({ file: name, reason: `已存在解码缓存（${md5}.${ext}），无需重复解码` })
            continue
          }
        }
        const bytes = await fs.readFile(file)
        const dec = decodeDatBytes(new Uint8Array(bytes), aes, xorKey)
        if ('error' in dec) { failed += 1; errors.push({ file: name, error: dec.error }); continue }
        if (dec.format === 'hevc') {
          skipped += 1
          skippedDetails.push({ file: name, reason: 'HEVC 视频帧格式，当前环境暂不支持解码' })
          continue
        }
        const ext = dec.format === 'jpeg' ? 'jpg' : dec.format
        if (!WRITE_EXTS.has(ext)) {
          skipped += 1
          skippedDetails.push({ file: name, reason: `不支持的图片格式（${ext}），已跳过` })
          continue
        }
        await fs.mkdir(decodedDir, { recursive: true })
        await fs.writeFile(join(decodedDir, md5 + '.' + ext), Buffer.from(dec.bytes))
        okCount += 1
      } catch (e) {
        failed += 1
        errors.push({ file: name, error: (e as Error).message })
      } finally {
        processed += 1
        onProgress?.(processed, files.length, failed, name)
      }
    }
  }

  const pool: Promise<void>[] = []
  const workers = Math.max(1, Math.min(Math.floor(concurrency), 32))
  for (let i = 0; i < workers; i += 1) pool.push(worker())
  await Promise.all(pool)
  return { total: files.length, okCount, failed, skipped, errors, skippedDetails }
}
