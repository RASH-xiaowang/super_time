/**
 * 主库**页级差分**增量（2026-10-13，参考 WeChatDataAnalysis 的合并语义）。
 *
 * ## 背景与实测
 *
 * 检查点除了**追加**页（尾部增量已覆盖），还会**原地重写**部分页——主库大小不变、
 * mtime 变（用户终端日志里 `main变了 prev.main=…:82104320 sig.main=…:82104320` 就是
 * 这种）。旧路径对任何主库变化都整库重解（82MB ≈ 200ms–1s）。本模块用**页指纹列表**
 * 识别真正变化的页：对当前主库做一次 sha256/页 的指纹扫描（82MB ≈ 80–150ms），
 * 与上一轮成功同步时记录的指纹逐页比对，只解密变化页并写进快照对应页槽。
 *
 * ## 正确性口径（宁可慢，不可错）
 *
 * 指纹列表必须带它对应的**源签名**（`mtime:size`）——签名对不上说明列表已过期，
 * 一律退回全量；变化页占比超过 {@link DIFF_MAX_CHANGED_RATIO} 也退回全量
 * （哈希扫描 + 补丁会比全量更贵）。拼好的快照仍要过 `quick_check`（发布前的安全网，
 * 与尾部路径同一条）。
 *
 * @module query/sync-page-diff
 */
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { yieldToLoop } from './search-build.ts'
import { PAGE_SZ, decryptPage } from './sqlcipher-page.ts'

/** 每扫描/补丁这么多页让出一次事件循环（与 query-yield-discipline 同一口径）。 */
export const PAGE_DIFF_YIELD_PAGES = 512

/**
 * 每块读多少页（1 MiB）。**逐页 `await fh.read` 的开销才是大头**：
 * 2.2 万页 = 2.2 万次异步读，实测 428ms；整块读后同样的哈希只要 ~60ms，
 * 而页指纹是每次「主库变了」的必经前置。
 */
const READ_CHUNK_PAGES = 256
/** 变化页占比超过它就退回全量。 */
export const DIFF_MAX_CHANGED_RATIO = 0.2

/** 一页的指纹（加密页字节的 sha256——只用于识别变化，不用于验证）。 */
function pageHash(page: Buffer): Buffer {
  return createHash('sha256').update(page).digest()
}

/**
 * 逐页扫描主库的指纹列表（带让出；空文件返回空表）。
 * @param path - 原始加密主库路径。
 * @returns 每页 32 字节指纹。
 */
export async function pageHashesOf(path: string): Promise<Buffer[]> {
  const fh = await open(path, 'r')
  const hashes: Buffer[] = []
  try {
    for (;;) {
      const chunk = Buffer.alloc(PAGE_SZ * READ_CHUNK_PAGES)
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, hashes.length * PAGE_SZ)
      const pages = Math.floor(bytesRead / PAGE_SZ)
      for (let i = 0; i < pages; i += 1) hashes.push(pageHash(chunk.subarray(i * PAGE_SZ, (i + 1) * PAGE_SZ)))
      if (pages < READ_CHUNK_PAGES) break
      await yieldToLoop()
    }
  } finally {
    await fh.close()
  }
  return hashes
}

/**
 * 只扫 `[startPage, startPage + count)` 区间的指纹（尾部增量成功后补记新页用）。
 */
export async function pageHashesRange(path: string, startPage: number, count: number): Promise<Buffer[]> {
  if (count <= 0) return []
  const fh = await open(path, 'r')
  const hashes: Buffer[] = []
  try {
    let done = 0
    while (done < count) {
      const pages = Math.min(READ_CHUNK_PAGES, count - done)
      const chunk = Buffer.alloc(PAGE_SZ * pages)
      const { bytesRead } = await fh.read(chunk, 0, chunk.length, (startPage + done) * PAGE_SZ)
      const got = Math.floor(bytesRead / PAGE_SZ)
      for (let i = 0; i < got; i += 1) hashes.push(pageHash(chunk.subarray(i * PAGE_SZ, (i + 1) * PAGE_SZ)))
      done += got
      if (got < pages) break
      await yieldToLoop()
    }
  } finally {
    await fh.close()
  }
  return hashes
}

/**
 * 纯判定：两张指纹列表的差异页下标（含新增页）。
 */
export function diffPageIndexes(prev: readonly Buffer[], cur: readonly Buffer[]): number[] {
  const out: number[] = []
  const n = Math.max(prev.length, cur.length)
  for (let i = 0; i < n; i += 1) {
    const a = prev[i]
    const b = cur[i]
    if (a === undefined || b === undefined || !a.equals(b)) out.push(i)
  }
  return out
}

/**
 * 只解密主库里**指定页**并写进 staging 快照的对应页槽。
 * @param rawDb - 原始加密主库。
 * @param stagingDb - staging 快照（旧快照的副本，r+ 打开）。
 * @param indexes - 要解密的页下标（0 起）。
 * @param encKey - 派生密钥。
 * @returns 实际写回的页数。
 */
export async function patchChangedPages(
  rawDb: string, stagingDb: string, indexes: readonly number[], encKey: Buffer,
): Promise<number> {
  if (indexes.length === 0) return 0
  const input = await open(rawDb, 'r')
  const output = await open(stagingDb, 'r+')
  const page = Buffer.alloc(PAGE_SZ)
  let written = 0
  try {
    for (const idx of indexes) {
      const { bytesRead } = await input.read(page, 0, PAGE_SZ, idx * PAGE_SZ)
      if (bytesRead < PAGE_SZ) continue
      const plain = decryptPage(encKey, page, idx + 1)
      await output.write(plain, 0, PAGE_SZ, idx * PAGE_SZ)
      written += 1
      if (written % PAGE_DIFF_YIELD_PAGES === 0) await yieldToLoop()
    }
  } finally {
    await input.close().catch(() => { /* 只读句柄 */ })
    await output.close().catch(() => { /* 写句柄 */ })
  }
  return written
}
