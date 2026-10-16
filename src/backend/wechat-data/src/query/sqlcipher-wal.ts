/**
 * SQLCipher-4 **WAL 帧**增量共享件（2026-10-13 自 `sync.ts` 拆出）。
 *
 * 拆出的原因：主库页级差分增量（`sync-page-diff.ts`）需要在 staging 快照上打 WAL 补丁，
 * 而这份逻辑住在贴着 1000 行硬上限的 `sync.ts` 里。纯搬移，逐字节未改；
 * `sync.ts` 继续 re-export，既有 import 一行不用动。
 *
 * @module query/sqlcipher-wal
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { PAGE_SZ, decryptPage } from './sqlcipher-page.ts'
import { stageOpenRetry } from './snapshot-sidecars.ts'

export const WAL_HEADER_SZ = 32
export const WAL_FRAME_HEADER_SZ = 24

/**
 * Patch a decrypted DB file with valid frames from an encrypted WAL.
 * @param walPath - encrypted WAL file path.
 * @param outPath - decrypted DB file to patch in place.
 * @param encKey - derived 32-byte AES-256 key.
 * @returns the number of frames patched.
 */
export async function decryptWalPatch(walPath: string, outPath: string, encKey: Buffer): Promise<number> {
  if (!existsSync(walPath)) return 0
  const wal = await readFile(walPath)
  if (wal.length <= WAL_HEADER_SZ) return 0
  const frameSize = WAL_FRAME_HEADER_SZ + PAGE_SZ
  const walSalt1 = wal.readUInt32BE(16)
  const walSalt2 = wal.readUInt32BE(20)
  const fh = await stageOpenRetry(outPath, 'r+')
  let patched = 0
  try {
    let offset = WAL_HEADER_SZ
    while (offset + frameSize <= wal.length) {
      const pgno = wal.readUInt32BE(offset)
      const frameSalt1 = wal.readUInt32BE(offset + 8)
      const frameSalt2 = wal.readUInt32BE(offset + 12)
      if (pgno === 0 || pgno > 1_000_000 || frameSalt1 !== walSalt1 || frameSalt2 !== walSalt2) {
        offset += frameSize
        continue
      }
      const ep = wal.subarray(offset + WAL_FRAME_HEADER_SZ, offset + WAL_FRAME_HEADER_SZ + PAGE_SZ)
      const dec = decryptPage(encKey, ep, pgno)
      await fh.write(dec, 0, PAGE_SZ, (pgno - 1) * PAGE_SZ)
      patched += 1
      offset += frameSize
    }
  } finally {
    await fh.close()
  }
  return patched
}

/** True when at least one WAL frame's salt epoch matches the WAL header,
 * i.e. the frames can be decrypted with the current snapshot key. WeChat
 * rotates the salt on login/checkpoint; when it does, frames carry a different
 * epoch and cannot be patched — the next main-DB rewrite (mtime change)
 * triggers a clean full decrypt instead. */
export async function walFramesPatchable(walPath: string): Promise<boolean> {
  if (!existsSync(walPath)) return false
  const wal = await readFile(walPath)
  if (wal.length <= WAL_HEADER_SZ) return false
  const frameSize = WAL_FRAME_HEADER_SZ + PAGE_SZ
  const walSalt1 = wal.readUInt32BE(16)
  const walSalt2 = wal.readUInt32BE(20)
  let offset = WAL_HEADER_SZ
  while (offset + frameSize <= wal.length) {
    const frameSalt1 = wal.readUInt32BE(offset + 8)
    const frameSalt2 = wal.readUInt32BE(offset + 12)
    if (frameSalt1 === walSalt1 && frameSalt2 === walSalt2) return true
    offset += frameSize
  }
  return false
}
