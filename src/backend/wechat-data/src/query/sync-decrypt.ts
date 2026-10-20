/** 解密整库（从 sync.ts 搬出，2026-10-18：m21 的 1000 行硬上限）。 */
import { PAGE_SZ, decryptPage } from './sqlcipher-page.ts'
import { stageOpenRetry } from './snapshot-sidecars.ts'

const DECRYPT_CHUNK_PAGES = 64

/**
 * Stream-decrypt a whole SQLCipher database to a plain SQLite file.
 * Chunked（64 页/步）以在单线程 worker 上让出事件循环；一次 200MB+ 的分片不会卡死面板查询。
 * @param dbPath - encrypted source database path.
 * @param outPath - plain SQLite output path.
 * @param encKey - derived 32-byte AES-256 key.
 * @returns the number of pages decrypted.
 */
export async function fullDecryptFile(dbPath: string, outPath: string, encKey: Buffer): Promise<number> {
  const input = await stageOpenRetry(dbPath, 'r')
  const output = await stageOpenRetry(outPath, 'w')
  const rawChunk = Buffer.alloc(PAGE_SZ * DECRYPT_CHUNK_PAGES)
  const decChunk = Buffer.alloc(PAGE_SZ * DECRYPT_CHUNK_PAGES)
  let pgno = 0
  try {
    for (;;) {
      let filled = 0
      while (filled < rawChunk.length) {
        const { bytesRead } = await input.read(rawChunk, filled, rawChunk.length - filled, null)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      if (filled === 0) break
      for (let offset = 0; offset < filled; offset += PAGE_SZ) {
        const page = rawChunk.subarray(offset, offset + PAGE_SZ)
        const padded = page.length < PAGE_SZ ? Buffer.concat([page, Buffer.alloc(PAGE_SZ - page.length)]) : page
        decryptPage(encKey, padded, pgno + 1).copy(decChunk, offset)
        pgno += 1
      }
      await output.write(decChunk.subarray(0, filled))
      await new Promise<void>((resolve) => { setImmediate(resolve) })
    }
  } finally {
    await input.close()
    await output.close()
  }
  return pgno
}

