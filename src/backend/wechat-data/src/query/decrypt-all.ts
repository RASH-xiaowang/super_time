/**
 * Full SQLCipher decyption of the WeChat raw db_storage tree into the
 * decrypted snapshot (one-call "立即解密"). Per database: page-1 salt →
 * PBKDF2-HMAC-SHA512(256000) derive (wx_key_v4.1) → AES-256-CBC page stream
 * decrypt → atomic publish at `<decrypted>/<rel>` with a SQLite-header check.
 * Reuses the same layout as sync.ts so the realtime watchers keep working.
 */
import { pbkdf2Sync } from 'node:crypto'
import {
  closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, unlinkSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fullDecryptFile } from './sync.ts'
import { getConfig, scanDbFiles } from './config.ts'

const PBKDF2_ITERS = 256000
const SQLITE_HDR = Buffer.from('SQLite format 3\x00')

/** Read exactly the first n bytes (readFileSync cannot bound a read). */
function readPrefix(file: string, n: number): Buffer {
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

/** Raw key hex for one database: all_keys.json entry first, config fallback. */
function rawKeyHexFor(decryptedDir: string, rel: string, fallbackHex: string): string {
  try {
    const keysPath = join(decryptedDir, '..', 'all_keys.json')
    if (existsSync(keysPath)) {
      const raw = JSON.parse(readPrefix(keysPath, 1024 * 1024).toString('utf8')) as Record<string, unknown>
      const entry = raw[rel.replace(/\\/g, '/')] as { key?: unknown } | undefined
      if (typeof entry?.['key'] === 'string' && entry['key'].length === 64) return entry['key']
    }
  } catch { /* unreadable store, config fallback */ }
  return fallbackHex
}

/** Derive the per-database AES-256 key (wx_key_v4.1 PBKDF2, else raw). */
function deriveEncKey(rawKey: Buffer, salt: Buffer, keyFormat: string): Buffer {
  if (keyFormat === 'wx_key_v4.1') return pbkdf2Sync(rawKey, salt, PBKDF2_ITERS, 32, 'sha512')
  return rawKey
}

/**
 * Decrypt every .db under the raw db_storage tree into the decrypted root.
 * Yields between databases so a progress-polling RPC stays served.
 * @param rawDbDir - raw WeChat db_storage dir (from config db_dir).
 * @param decryptedDir - decrypted snapshot root (target mirrors db_storage).
 * @param onProgress - per-database progress callback (done/total/failed/message).
 * @returns ok + success/failure counts (per-db failures never abort the run).
 */
export async function decryptAllDbs(
  rawDbDir: string,
  decryptedDir: string,
  onProgress?: (done: number, total: number, failed: number, message: string) => void,
): Promise<{ ok: boolean; total: number; okCount: number; failed: Array<{ db: string; error: string }>; error?: string }> {
  if (!rawDbDir || !existsSync(rawDbDir)) {
    return {
      ok: false, total: 0, okCount: 0, failed: [],
      error: rawDbDir
        ? `数据库目录不存在（${rawDbDir}）。请确认「数据配置」中的数据库目录指向真实的 db_storage，或使用「检测账号」自动选择。`
        : '数据库目录未配置。请先在「数据配置」中检测账号或填写数据库目录（…\\xwechat_files\\<wxid>\\db_storage）。',
    }
  }
  const cfg = getConfig(decryptedDir)
  const rawKeyHex = typeof cfg['db_enc_key'] === 'string' ? cfg['db_enc_key'].trim() : ''
  if (!rawKeyHex || rawKeyHex.length !== 64) {
    return { ok: false, total: 0, okCount: 0, failed: [], error: '未配置 64 位数据库密钥（请先获取密钥）' }
  }
  const keyFormat = typeof cfg['key_format'] === 'string' ? cfg['key_format'] : 'wx_key_v4.1'
  const rawKey = Buffer.from(rawKeyHex, 'hex')
  if (rawKey.length !== 32) {
    return { ok: false, total: 0, okCount: 0, failed: [], error: '数据库密钥不是合法的 64 位 hex' }
  }

  const dbs = scanDbFiles(rawDbDir)
  const failed: Array<{ db: string; error: string }> = []
  let okCount = 0
  let done = 0
  for (const db of dbs) {
    const rel = relative(rawDbDir, db).replace(/\\/g, '/')
    const target = join(decryptedDir, rel)
    const staged = target + '.decrypt_tmp'
    try {
      mkdirSync(dirname(target), { recursive: true })
      const salt = readPrefix(db, 16)
      if (salt.length < 16) throw new Error('文件过小')
      const keyHex = rawKeyHexFor(decryptedDir, rel, rawKeyHex)
      if (keyHex.length !== 64) throw new Error('db_enc_key 缺失')
      const encKey = deriveEncKey(Buffer.from(keyHex, 'hex'), salt, keyFormat)
      await fullDecryptFile(db, staged, encKey)
      const head = readPrefix(staged, 15)
      if (!head.equals(SQLITE_HDR.subarray(0, 15))) throw new Error('解密结果校验失败（密钥不匹配？）')
      try { unlinkSync(target) } catch { /* not yet present */ }
      renameSync(staged, target)
      okCount += 1
    } catch (e) {
      try { unlinkSync(staged) } catch { /* best effort cleanup */ }
      failed.push({ db: rel, error: (e as Error).message })
    }
    done += 1
    onProgress?.(done, dbs.length, failed.length, rel)
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
  return { ok: failed.length === 0, total: dbs.length, okCount, failed }
}
