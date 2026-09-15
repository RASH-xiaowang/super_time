/**
 * SQLCipher 4 密钥校验与 `all_keys.json` 生成（密钥层的一部分）。
 *
 * 为什么从 `query/config.ts` 搬到这里（M24）：`keys/db-key-v4.ts` 校验内存里捞出来的候选密钥
 * 时需要 `verifyDbKey`，而 keys 是最底层能力 —— 让 keys 反向 import 上层的 query 就会与
 * `query/image-key.ts` → `keys/key-store.ts` 构成双向依赖。这里只依赖 `config/**`（更低的层）。
 *
 * SQLCipher 4: PBKDF2-HMAC-SHA512 + AES-256。
 */

import { createDecipheriv, createHmac, pbkdf2Sync } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs'
import { dirname, relative } from 'node:path'
import { scanDbFiles } from '../config/detect.ts'

const PAGE_SZ = 4096
const SALT_SZ = 16
const IV_SZ = 16
const HMAC_SZ = 64
const RESERVE_SZ = 80
const PBKDF2_ITERS = 256000
const SQLITE_HDR = new TextEncoder().encode('SQLite format 3\x00')

/** Read only the first database page (verification needs just the header page). */
function readFirstPage(file: string): Buffer {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(PAGE_SZ)
    const n = readSync(fd, buf, 0, PAGE_SZ, 0)
    return buf.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

/** AES-256-CBC decrypt (no padding). */
function aes256CbcDecrypt(key: Buffer, iv: Buffer, data: Buffer): Buffer {
  const d = createDecipheriv('aes-256-cbc', key, iv)
  d.setAutoPadding(false)
  return Buffer.concat([d.update(data), d.final()])
}

/** AES-256-ECB decrypt one block. */
function aes256EcbDecryptBlock(key: Buffer, block: Buffer): Buffer {
  const d = createDecipheriv('aes-256-ecb', key, null)
  d.setAutoPadding(false)
  return d.update(block)
}

/**
 * SQLCipher page-1 key verification (wx_key_v4.1 PBKDF2).
 * @param page1 - first page (4096 bytes) of the encrypted database.
 * @param wxKeyBin - 32-byte raw database key.
 * @returns whether the HMAC and AES checks pass.
 */
export function verifyDbKey(page1: Buffer, wxKeyBin: Buffer): { hmacOk: boolean; aesOk: boolean } {
  if (page1.length < PAGE_SZ) return { hmacOk: false, aesOk: false }
  page1 = page1.subarray(0, PAGE_SZ)
  const salt = page1.subarray(0, SALT_SZ)
  const derivedKey = pbkdf2Sync(wxKeyBin, salt, PBKDF2_ITERS, 32, 'sha512')
  // HMAC verify
  const macSalt = Buffer.from(salt.map(b => b ^ 0x3a))
  const macKey = pbkdf2Sync(derivedKey, macSalt, 2, 32, 'sha512')
  const hmacData = page1.subarray(16, PAGE_SZ - RESERVE_SZ + IV_SZ)
  const storedHmac = page1.subarray(PAGE_SZ - HMAC_SZ, PAGE_SZ)
  const mac = createHmac('sha512', macKey)
  mac.update(hmacData)
  const pgno = Buffer.alloc(4)
  pgno.writeUInt32LE(1, 0)
  mac.update(pgno)
  const hmacOk = mac.digest().equals(Buffer.from(storedHmac))
  // AES verify
  const firstBlockDec = aes256EcbDecryptBlock(derivedKey, page1.subarray(16, 32))
  const correctedIv = Buffer.from(firstBlockDec.map((b, i) => b ^ (SQLITE_HDR[i] ?? 0)))
  const encrypted = page1.subarray(16, PAGE_SZ - RESERVE_SZ)
  const decrypted = aes256CbcDecrypt(derivedKey, correctedIv, encrypted)
  const aesOk = decrypted.subarray(0, 16).equals(Buffer.from(SQLITE_HDR))
  return { hmacOk, aesOk }
}

/**
 * Verify one database file with a 64-hex key.
 * @param dbPath - path to the encrypted database file.
 * @param encKeyHex - 64-char hex (32-byte) database key.
 * @returns validity plus per-check flags and any error.
 */
export function verifyDatabaseKey(
  dbPath: string,
  encKeyHex: string,
): { valid: boolean; aesOk?: boolean; hmacOk?: boolean; error?: string } {
  if (!existsSync(dbPath)) return { valid: false, error: '数据库文件不存在' }
  const raw = (encKeyHex || '').trim()
  let key: Buffer
  try { key = Buffer.from(raw, 'hex') } catch { key = Buffer.alloc(0) }
  if (key.length !== 32) return { valid: false, error: '密钥必须是 64 位 hex（32 字节）' }
  try {
    const page1 = readFirstPage(dbPath)
    if (page1.length < PAGE_SZ) return { valid: false, error: '文件太小，不是有效的数据库' }
    const { hmacOk, aesOk } = verifyDbKey(page1, key)
    return { valid: hmacOk && aesOk, aesOk, hmacOk }
  } catch (e) {
    return { valid: false, error: (e as Error).message }
  }
}

/**
 * Verify all DBs in db_dir and write all_keys.json (per-db per-file keys).
 * @param dbDir - directory containing the encrypted DBs to verify.
 * @param keysFile - output all_keys.json path.
 * @param encKeyHex - 64-char hex (32-byte) database key.
 * @param keyFormat - key format recorded in the file (default wx_key_v4.1).
 * @returns ok plus verified/total DB counts, or an error description.
 */
export function generateKeysFile(
  dbDir: string,
  keysFile: string,
  encKeyHex: string,
  keyFormat?: string,
): { ok: boolean; verified: number; total: number; error?: string } {
  const raw = (encKeyHex || '').trim()
  let key: Buffer
  try { key = Buffer.from(raw, 'hex') } catch { key = Buffer.alloc(0) }
  if (key.length !== 32) return { ok: false, verified: 0, total: 0, error: '密钥必须是 64 位 hex（32 字节）' }
  const dbs = scanDbFiles(dbDir)
  if (dbs.length === 0) return { ok: false, verified: 0, total: 0, error: '未找到任何 .db 文件' }
  const entries: Record<string, { key: string; valid: boolean }> = {}
  let verified = 0
  for (const db of dbs) {
    try {
      const rel = relative(dbDir, db).replace(/\\/g, '/')
      const page1 = readFirstPage(db)
      const { hmacOk, aesOk } = verifyDbKey(page1, key)
      const valid = hmacOk && aesOk
      if (valid) verified += 1
      entries[rel] = { key: raw, valid }
    } catch { /* skip unreadable */ }
  }
  const payload: Record<string, unknown> = { ...entries, _key_format: keyFormat ?? 'wx_key_v4.1', _db_dir: dbDir }
  try {
    mkdirSync(dirname(keysFile), { recursive: true })
    writeFileSync(keysFile, JSON.stringify(payload, null, 2), 'utf8')
    return { ok: true, verified, total: dbs.length }
  } catch (e) {
    return { ok: false, verified, total: dbs.length, error: (e as Error).message }
  }
}
