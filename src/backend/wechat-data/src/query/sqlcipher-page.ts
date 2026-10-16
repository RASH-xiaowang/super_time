/**
 * SQLCipher-4 页级加解密共享件（2026-10-13 自 `sync.ts` 拆出）。
 *
 * ## 为什么拆
 *
 * 主库尾部增量解密（`sync-tail-patch.ts`）需要与 `sync.ts` 完全相同的页布局口径
 * （每页 4096、页 1 带 16B 盐、页尾 16B IV + 64B HMAC 预留），而 `sync.ts` 已贴着
 * 「单文件 1000 行」硬上限。复制一份口径 = 两处真相；拆出来 = 一处，两边 import。
 * 纯搬移，逐字节未改。
 *
 * @module query/sqlcipher-page
 */
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { closeSync, openSync, readSync } from 'node:fs'

export const PAGE_SZ = 4096
export const SALT_SZ = 16
export const IV_SZ = 16
export const RESERVE_SZ = 80
export const PBKDF2_ITERS = 256000
export const SQLITE_HDR = Buffer.from('SQLite format 3\x00')

/** Read exactly the first n bytes of a file (readFileSync has no length option). */
export function readPrefix(file: string, n: number): Buffer {
  const fd = openSync(file, 'r')
  const buf = Buffer.alloc(n)
  let filled = 0
  try {
    while (filled < n) {
      const r = readSync(fd, buf, filled, n - filled, null)
      if (r === 0) break
      filled += r
    }
  } finally {
    closeSync(fd)
  }
  return buf.subarray(0, filled)
}

/**
 * 读 SQLite 页 1 头部偏移 20 的**预留字节数**（读不到按 0 处理）。
 *
 * 真实微信库是 SQLCipher 创建的、每页原生预留 80 字节（页尾只放 IV+HMAC）；
 * 测试夹具（node:sqlite 建的库）预留为 0（页尾是指针区）。发布前的 quick_check
 * 自检只在预留非 0 的库上有意义——零尾补丁对预留 0 的库必然破坏指针区。
 */
export function reserveByteOf(file: string): number {
  try {
    return readPrefix(file, 24)[20] ?? 0
  } catch {
    return 0
  }
}

/** Derive the per-database AES-256 key (wx_key_v4.1 PBKDF2, else raw). */
export function deriveEncKey(rawKey: Buffer, salt: Buffer, keyFormat?: string): Buffer {
  if (keyFormat === 'wx_key_v4.1') {
    return pbkdf2Sync(rawKey, salt, PBKDF2_ITERS, 32, 'sha512')
  }
  return rawKey
}

/**
 * Decrypt one SQLCipher page (pgno is 1-based) into a plain SQLite page.
 * The per-page IV lives at the page tail; page 1 additionally prefixes the
 * decrypted payload with the SQLite header (the salt occupied those 16 bytes
 * on disk), matching st_control's decrypt_page output layout.
 */
export function decryptPage(encKey: Buffer, page: Buffer, pgno: number): Buffer {
  const iv = page.subarray(PAGE_SZ - RESERVE_SZ, PAGE_SZ - RESERVE_SZ + IV_SZ)
  const encrypted = pgno === 1 ? page.subarray(SALT_SZ, PAGE_SZ - RESERVE_SZ) : page.subarray(0, PAGE_SZ - RESERVE_SZ)
  const decipher = createDecipheriv('aes-256-cbc', encKey, iv)
  decipher.setAutoPadding(false)
  const dec = Buffer.concat([decipher.update(encrypted), decipher.final()])
  const out = Buffer.alloc(PAGE_SZ)
  if (pgno === 1) SQLITE_HDR.copy(out, 0)
  dec.copy(out, pgno === 1 ? SQLITE_HDR.length : 0)
  return out
}
