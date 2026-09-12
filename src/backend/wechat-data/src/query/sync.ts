/**
 * Real-time sync from WeChat's raw encrypted DBs into the decrypted snapshot.
 *
 * Mirrors st_control's monitor/db_cache pipeline: the decrypted copy is a
 * snapshot that only moves when something re-decrypts the raw SQLCipher
 * database, so a chat panel polling the snapshot never sees new messages by
 * itself. This module watches the raw message shards (mtime signature, like
 * st_control's msg_dbs_sig), and on change re-decrypts the shard (full main
 * DB + WAL frame patch) into the decrypted tree atomically.
 *
 * SQLCipher 4 layout (per 4096-byte page):
 *   page 1: [16B salt][4000B encrypted][16B IV][64B HMAC]
 *   other : [4016B encrypted][16B IV][64B HMAC]
 * Key derivation (wx_key_v4.1): PBKDF2-HMAC-SHA512(rawKey, salt, 256000).
 */
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import {
  closeSync, existsSync, openSync, readFileSync,
  readdirSync, readSync, statSync,
} from 'node:fs'
import { copyFile, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { getConfig } from './config.ts'

const PAGE_SZ = 4096
const SALT_SZ = 16
const IV_SZ = 16
const RESERVE_SZ = 80
const PBKDF2_ITERS = 256000
const SQLITE_HDR = Buffer.from('SQLite format 3\x00')
const WAL_HEADER_SZ = 32
const WAL_FRAME_HEADER_SZ = 24
const SYNC_INTERVAL_MS = 10_000
const FULL_DECRYPT_COOLDOWN_MS = 6_000

/** Cached raw-dir entries; refreshed when the directory signature changes. */
const dirEntryCache = new Map<string, { sig: string; files: string[] }>()
function cachedDirEntries(dir: string): string[] {
  try {
    const st = statSync(dir)
    const sig = `${st.mtimeMs}:${st.size}`
    const hit = dirEntryCache.get(dir)
    if (hit && hit.sig === sig) return hit.files
    const files = readdirSync(dir)
    dirEntryCache.set(dir, { sig, files })
    return files
  } catch {
    return []
  }
}

/** Read exactly the first n bytes of a file (readFileSync has no length option). */
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

/** Derive the per-database AES-256 key (wx_key_v4.1 PBKDF2, else raw). */
function deriveEncKey(rawKey: Buffer, salt: Buffer, keyFormat?: string): Buffer {
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
function decryptPage(encKey: Buffer, page: Buffer, pgno: number): Buffer {
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

/**
 * Stream-decrypt a whole SQLCipher database to a plain SQLite file.
 *
 * Async and chunked: the snapshot can be 200+ MB, and this runs inside the
 * realtime sync tick on the host's single event loop. One chunk of pages is
 * read, decrypted and written per scheduling step (64 pages ≈ 256 KiB), so
 * other requests — the chat panel's own queries — interleave instead of
 * freezing for the whole decrypt.
 * @param dbPath - encrypted source database path.
 * @param outPath - plain SQLite output path.
 * @param encKey - derived 32-byte AES-256 key.
 * @returns the number of pages decrypted.
 */
const DECRYPT_CHUNK_PAGES = 64

export async function fullDecryptFile(dbPath: string, outPath: string, encKey: Buffer): Promise<number> {
  const input = await open(dbPath, 'r')
  const output = await open(outPath, 'w')
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
  const fh = await open(outPath, 'r+')
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

/** Per-shard state: raw mtimes of the main db and its wal. */
interface ShardSig { main: number; wal: number }

/** True when the target exists and its data (not mtime) is usable. */
function looksDecrypted(dbPath: string): boolean {
  try {
    const head = readPrefix(dbPath, 16)
    return head.length === 16 && head.subarray(0, 15).equals(SQLITE_HDR.subarray(0, 15))
  } catch { return false }
}

/** Atomically replace target with a fully-decrypted temp file (async retries). */
async function atomicReplace(temp: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  let lastErr: unknown = null
  for (let i = 0; i < 8; i += 1) {
    try {
      try { await unlink(target) } catch { /* absent */ }
      await rename(temp, target)
      return
    } catch (e) {
      lastErr = e
      // The snapshot may be briefly held open by a concurrent query; a short
      // asynchronous pause lets the reader close before retrying.
      await new Promise<void>((resolve) => { setTimeout(resolve, 120) })
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('atomicReplace failed')
}

/** all_keys.json read cache (mtime+size fingerprint; rewritten files re-read). */
const allKeysCache = new Map<string, { sig: string; raw: Record<string, unknown> | null }>()

/** Per-shard last full re-decrypt time, keyed by shard/label (bounded). */
const lastFullAt = new Map<string, number>()

/** True once when a full re-decrypt for `key` is allowed by the cooldown. */
function fullDecryptDue(key: string): boolean {
  const last = lastFullAt.get(key) ?? 0
  if (Date.now() - last < FULL_DECRYPT_COOLDOWN_MS) return false
  lastFullAt.set(key, Date.now())
  return true
}

function readAllKeysCached(decryptedDir: string): Record<string, unknown> | null {
  const keysPath = join(decryptedDir, '..', 'all_keys.json')
  let sig = ''
  try {
    const st = statSync(keysPath)
    sig = `${st.mtimeMs}:${st.size}`
  } catch { return null }
  const hit = allKeysCache.get(keysPath)
  if (hit && hit.sig === sig) return hit.raw
  let raw: Record<string, unknown> | null = null
  try {
    raw = JSON.parse(readFileSync(keysPath, 'utf8')) as Record<string, unknown>
  } catch { /* malformed: treat as absent */ }
  allKeysCache.set(keysPath, { sig, raw })
  return raw
}

/**
 * 64-hex raw key for a shard (all_keys.json per-file first, then config).
 * @param decryptedDir - decrypted data root (all_keys.json sits beside it).
 * @param relKey - per-file key entry (e.g. 'message/message_0.db').
 * @param fallbackHex - config `db_enc_key` used when no per-file entry fits.
 * @returns the 64-hex key string to use.
 */
export function resolveShardKey(decryptedDir: string, relKey: string, fallbackHex: string): string {
  const raw = readAllKeysCached(decryptedDir)
  if (raw !== null) {
    // DSH's own generateKeysFile writes `key`; st_control's all_keys.json
    // writes `enc_key`. Accept either so both layouts resolve per-file keys.
    const entry = raw[relKey] as { key?: unknown; enc_key?: unknown } | undefined
    const candidate = typeof entry?.key === 'string' ? entry.key : typeof entry?.enc_key === 'string' ? entry.enc_key : null
    if (candidate && /^[0-9a-fA-F]{64}$/.test(candidate)) return candidate
  }
  return fallbackHex
}

/** Per-file derived AES key cache: PBKDF2 is ~70ms, so sync ticks re-derive
 * only when the raw file's salt or the raw key actually changes. Bounded FIFO. */
const derivedKeyCache = new Map<string, Buffer>()

/**
 * Derive (and cache) the per-database AES-256 key.
 * @param decryptedDir - decrypted data root (cache namespace part).
 * @param relKey - per-file key entry (cache namespace part).
 * @param rawDbFile - encrypted source file (its first 16 bytes are the salt).
 * @param rawKeyHex - 64-hex raw key.
 * @param keyFormat - SQLCipher key format (`wx_key_v4.1` PBKDF2, else raw).
 * @returns the derived 32-byte key.
 */
export function deriveEncKeyCached(
  decryptedDir: string, relKey: string, rawDbFile: string, rawKeyHex: string, keyFormat: string,
): Buffer {
  const salt = readPrefix(rawDbFile, SALT_SZ)
  const saltHex = salt.toString('hex')
  const cacheKey = `${decryptedDir}|${relKey}|${saltHex}|${rawKeyHex}|${keyFormat}`
  const hit = derivedKeyCache.get(cacheKey)
  if (hit !== undefined) return hit
  const encKey = deriveEncKey(Buffer.from(rawKeyHex, 'hex'), salt, keyFormat)
  if (derivedKeyCache.size >= 128) {
    const first = derivedKeyCache.keys().next()
    if (!first.done) derivedKeyCache.delete(first.value)
  }
  derivedKeyCache.set(cacheKey, encKey)
  return encKey
}

/** Resolve the raw key and derive the AES key for one database file. */
function shardEncKey(
  decryptedDir: string, relKey: string, rawDbFile: string, rawKeyHex: string, keyFormat: string,
): Buffer {
  const keyHex = resolveShardKey(decryptedDir, relKey, rawKeyHex)
  return deriveEncKeyCached(decryptedDir, relKey, rawDbFile, keyHex, keyFormat)
}

/** Per-shard mtime signature (main db + its wal). */
function shardSig(msgDir: string, file: string): ShardSig {
  const sig: ShardSig = { main: 0, wal: 0 }
  for (const f of [file, file + '-wal']) {
    try {
      const ms = statSync(join(msgDir, f)).mtimeMs
      if (f === file) sig.main = ms
      else sig.wal = ms
    } catch { /* skip */ }
  }
  return sig
}

/** Copy a raw WAL into staging when it has frames; otherwise drop stale staging. */
async function stageWal(rawWal: string, stagingWal: string): Promise<void> {
  if (existsSync(rawWal) && statSync(rawWal).size > WAL_HEADER_SZ) await copyFile(rawWal, stagingWal)
  else if (existsSync(stagingWal)) await unlink(stagingWal).catch(() => { /* stale staging is best-effort */ })
}

/**
 * Sync one message shard from the raw tree into the decrypted snapshot.
 * - mode 'full': re-decrypt the main DB (first sync or the main file changed)
 *   then WAL-patch the result; atomically replaces the snapshot.
 * - mode 'wal': the main snapshot is current and only the WAL grew — patch the
 *   changed frames into a staging copy of the snapshot (st_control's
 *   write-only-page model) and atomically replace.
 * @param rawMsgDir - raw message dir (encrypted).
 * @param decMsgDir - decrypted message dir.
 * @param file - shard file name (e.g. message_0.db).
 * @param rawKeyHex - fallback 64-hex raw key.
 * @param keyFormat - key format (wx_key_v4.1).
 * @param mode - full or wal-incremental.
 * @returns page counts for reporting.
 */
export async function syncMessageShard(
  rawMsgDir: string, decMsgDir: string, file: string,
  rawKeyHex: string, keyFormat: string, mode: 'full' | 'wal' = 'full',
): Promise<{ fullPages: number; walPages: number }> {
  const relKey = 'message/' + file
  const rawDb = join(rawMsgDir, file)
  const rawWal = join(rawMsgDir, file + '-wal')
  const target = join(decMsgDir, file)
  await mkdir(decMsgDir, { recursive: true })
  const encKey = shardEncKey(decMsgDir, relKey, rawDb, rawKeyHex, keyFormat)

  const stagingDb = target + '.stage_src'
  const stagingWal = target + '.stage_wal'
  const temp = target + '.decrypt_tmp'

  if (mode === 'wal') {
    if (!(await walFramesPatchable(rawWal))) {
      console.warn('[wechat-sync]', file, 'wal salt epoch mismatch, keeping snapshot')
      return { fullPages: 0, walPages: 0 }
    }
    // Snapshot stays; patch only the WAL's changed frames into a staging copy.
    await copyFile(target, stagingDb)
    await stageWal(rawWal, stagingWal)
    try {
      const walPages = existsSync(stagingWal) ? await decryptWalPatch(stagingWal, stagingDb, encKey) : 0
      if (!looksDecrypted(stagingDb)) throw new Error('wal patch invalid for ' + file)
      // No patchable frames despite a matching salt epoch: the snapshot is
      // already current. A full re-decrypt would not recover these WAL-only
      // frames either, so defer to the next main-DB rewrite instead of
      // re-decrypting the whole snapshot on every WAL touch.
      await atomicReplace(stagingDb, target)
      return { fullPages: 0, walPages }
    } finally {
      for (const f of [stagingWal, temp]) {
        try { await unlink(f) } catch { /* ignore */ }
      }
    }
  }

  // Full mode: fresh decrypt of the main db, then WAL patch, then replace.
  await copyFile(rawDb, stagingDb)
  await stageWal(rawWal, stagingWal)
  try {
    const fullPages = await fullDecryptFile(stagingDb, temp, encKey)
    const walPages = existsSync(stagingWal) ? await decryptWalPatch(stagingWal, temp, encKey) : 0
    if (!looksDecrypted(temp)) throw new Error('decrypt result invalid for ' + file)
    await atomicReplace(temp, target)
    return { fullPages, walPages }
  } finally {
    for (const f of [stagingDb, stagingWal, temp]) {
      try { await unlink(f) } catch { /* ignore */ }
    }
  }
}

/**
 * Scan raw shards and sync every changed one. The main file changing forces a
 * full re-decrypt; a WAL-only change applies an incremental frame patch.
 * @param rawDbDir - raw db_storage root.
 * @param decryptedDir - decrypted snapshot root.
 * @param lastState - per-shard signature state (mutated).
 * @returns descriptions of what was synced (file + mode + pages).
 */
export async function syncChangedShards(
  rawDbDir: string, decryptedDir: string, lastState: Map<string, ShardSig>,
): Promise<string[]> {
  const msgDir = join(rawDbDir, 'message')
  const decMsgDir = join(decryptedDir, 'message')
  if (!existsSync(msgDir)) return []
  const cfg = getConfig(decryptedDir)
  const keyFormat = typeof cfg['key_format'] === 'string' ? cfg['key_format'] : 'wx_key_v4.1'
  const fallbackKey = typeof cfg['db_enc_key'] === 'string' ? cfg['db_enc_key'] : ''
  const synced: string[] = []
  for (const f of cachedDirEntries(msgDir)) {
    if (!/^(biz_)?message_\d+\.db$/.test(f)) continue
    const sig = shardSig(msgDir, f)
    const prev = lastState.get(f)
    const target = join(decMsgDir, f)
    if (prev !== undefined && prev.main === sig.main && prev.wal === sig.wal && existsSync(target)) continue
    lastState.set(f, sig)
    const mode: 'full' | 'wal' = (prev === undefined || prev.main !== sig.main || !existsSync(target)) ? 'full' : 'wal'
    if (mode === 'full' && !fullDecryptDue(f)) {
      // Rate-limit full re-decrypts: a checkpoint can grow the main DB on every
      // message. Defer (do not record the signature) so it retries after the
      // cooldown; the WAL patch path still applies incremental frames meanwhile.
      lastState.delete(f)
      continue
    }
    try {
      const r = await syncMessageShard(msgDir, decMsgDir, f, fallbackKey, keyFormat, mode)
      if (mode === 'full' || r.walPages > 0) synced.push(`${f}:${mode}(${r.fullPages}p/w${r.walPages})`)
    } catch (e) {
      lastState.delete(f) // retry next round
      console.error('[wechat-sync]', f, (e as Error).message)
    }
  }
  return synced
}

/** Session-db signature (main + wal). */
function sessionSig(sessionDir: string): ShardSig {
  const sig: ShardSig = { main: 0, wal: 0 }
  for (const f of ['session.db', 'session.db-wal']) {
    try {
      const ms = statSync(join(sessionDir, f)).mtimeMs
      if (f === 'session.db') sig.main = ms
      else sig.wal = ms
    } catch { /* skip */ }
  }
  return sig
}

/**
 * Sync session.db (the conversation list state) from the raw tree into the
 * decrypted snapshot — full re-decrypt when the main file changed, WAL frame
 * patch otherwise. The chat sidebar reads this table, so without it the
 * session list never reflects new messages.
 * @param rawDbDir - raw db_storage root.
 * @param decryptedDir - decrypted snapshot root.
 * @param lastState - shared per-target signature state.
 * @param rawKeyHex - fallback 64-hex raw key.
 * @param keyFormat - key format (wx_key_v4.1).
 * @returns descriptions of what was synced (empty when nothing changed).
 */
export async function syncSessionDb(
  rawDbDir: string, decryptedDir: string, lastState: Map<string, ShardSig>,
  rawKeyHex: string, keyFormat: string,
): Promise<string[]> {
  const rawSess = join(rawDbDir, 'session')
  const decSess = join(decryptedDir, 'session')
  const rawDb = join(rawSess, 'session.db')
  if (!existsSync(rawDb)) return []
  const sig = sessionSig(rawSess)
  const prev = lastState.get('session.db')
  const target = join(decSess, 'session.db')
  if (prev !== undefined && prev.main === sig.main && prev.wal === sig.wal && existsSync(target)) return []
  lastState.set('session.db', sig)
  const mode: 'full' | 'wal' = (prev === undefined || prev.main !== sig.main || !existsSync(target)) ? 'full' : 'wal'
  if (mode === 'full' && !fullDecryptDue('session.db')) {
    lastState.delete('session.db')
    return []
  }
  try {
    const encKey = shardEncKey(decryptedDir, 'session/session.db', rawDb, rawKeyHex, keyFormat)
    await mkdir(decSess, { recursive: true })
    const stagingDb = target + '.stage_src'
    const stagingWal = target + '.stage_wal'
    const temp = target + '.decrypt_tmp'
    if (mode === 'wal') {
      if (!(await walFramesPatchable(rawDb + '-wal'))) {
        console.warn('[wechat-sync] session.db wal salt epoch mismatch, keeping snapshot')
        return []
      }
      await copyFile(target, stagingDb)
      await stageWal(rawDb + '-wal', stagingWal)
      try {
        const walPages = existsSync(stagingWal) ? await decryptWalPatch(stagingWal, stagingDb, encKey) : 0
        if (!looksDecrypted(stagingDb)) throw new Error('session wal patch invalid')
        await atomicReplace(stagingDb, target)
        if (walPages > 0) return [`session.db:wal(w${walPages})`]
        return []
      } finally {
        for (const f of [stagingWal, temp]) { try { await unlink(f) } catch { /* ignore */ } }
      }
    }
    await copyFile(rawDb, stagingDb)
    await stageWal(rawDb + '-wal', stagingWal)
    try {
      const fullPages = await fullDecryptFile(stagingDb, temp, encKey)
      const walPages = existsSync(stagingWal) ? await decryptWalPatch(stagingWal, temp, encKey) : 0
      if (!looksDecrypted(temp)) throw new Error('session decrypt invalid')
      await atomicReplace(temp, target)
      return [`session.db:full(${fullPages}p/w${walPages})`]
    } finally {
      for (const f of [stagingDb, stagingWal, temp]) { try { await unlink(f) } catch { /* ignore */ } }
    }
  } catch (e) {
    lastState.delete('session.db')
    console.error('[wechat-sync] session.db', (e as Error).message)
    return []
  }
}

/** Contact-db signature (main + wal). */
function contactSig(contactDir: string): ShardSig {
  const sig: ShardSig = { main: 0, wal: 0 }
  for (const f of ['contact.db', 'contact.db-wal']) {
    try {
      const ms = statSync(join(contactDir, f)).mtimeMs
      if (f === 'contact.db') sig.main = ms
      else sig.wal = ms
    } catch { /* skip */ }
  }
  return sig
}

/**
 * Sync contact.db (contact/chatroom/friends names + members) from the raw
 * tree into the decrypted snapshot — full re-decrypt when the main file
 * changed, WAL frame patch otherwise. Without this, newly added contacts /
 * official accounts (gh_*) keep showing their raw username in the sidebar.
 * @param rawDbDir - raw db_storage root.
 * @param decryptedDir - decrypted snapshot root.
 * @param lastState - shared per-target signature state.
 * @param rawKeyHex - fallback 64-hex raw key.
 * @param keyFormat - key format (wx_key_v4.1).
 * @returns descriptions of what was synced (empty when nothing changed).
 */
export async function syncContactDb(
  rawDbDir: string, decryptedDir: string, lastState: Map<string, ShardSig>,
  rawKeyHex: string, keyFormat: string,
): Promise<string[]> {
  const rawContact = join(rawDbDir, 'contact')
  const decContact = join(decryptedDir, 'contact')
  const rawDb = join(rawContact, 'contact.db')
  if (!existsSync(rawDb)) return []
  const sig = contactSig(rawContact)
  const prev = lastState.get('contact.db')
  const target = join(decContact, 'contact.db')
  if (prev !== undefined && prev.main === sig.main && prev.wal === sig.wal && existsSync(target)) return []
  lastState.set('contact.db', sig)
  const mode: 'full' | 'wal' = (prev === undefined || prev.main !== sig.main || !existsSync(target)) ? 'full' : 'wal'
  if (mode === 'full' && !fullDecryptDue('contact.db')) {
    lastState.delete('contact.db')
    return []
  }
  try {
    const encKey = shardEncKey(decryptedDir, 'contact/contact.db', rawDb, rawKeyHex, keyFormat)
    await mkdir(decContact, { recursive: true })
    const stagingDb = target + '.stage_src'
    const stagingWal = target + '.stage_wal'
    const temp = target + '.decrypt_tmp'
    if (mode === 'wal') {
      if (!(await walFramesPatchable(rawDb + '-wal'))) {
        console.warn('[wechat-sync] contact.db wal salt epoch mismatch, keeping snapshot')
        return []
      }
      await copyFile(target, stagingDb)
      await stageWal(rawDb + '-wal', stagingWal)
      try {
        const walPages = existsSync(stagingWal) ? await decryptWalPatch(stagingWal, stagingDb, encKey) : 0
        if (!looksDecrypted(stagingDb)) throw new Error('contact wal patch invalid')
        await atomicReplace(stagingDb, target)
        if (walPages > 0) return [`contact.db:wal(w${walPages})`]
        return []
      } finally {
        for (const f of [stagingWal, temp]) { try { await unlink(f) } catch { /* ignore */ } }
      }
    }
    await copyFile(rawDb, stagingDb)
    await stageWal(rawDb + '-wal', stagingWal)
    try {
      const fullPages = await fullDecryptFile(stagingDb, temp, encKey)
      const walPages = existsSync(stagingWal) ? await decryptWalPatch(stagingWal, temp, encKey) : 0
      if (!looksDecrypted(temp)) throw new Error('contact decrypt invalid')
      await atomicReplace(temp, target)
      return [`contact.db:full(${fullPages}p/w${walPages})`]
    } finally {
      for (const f of [stagingDb, stagingWal, temp]) { try { await unlink(f) } catch { /* ignore */ } }
    }
  } catch (e) {
    lastState.delete('contact.db')
    console.error('[wechat-sync] contact.db', (e as Error).message)
    return []
  }
}


/** Signature of a plain db dir (main + wal by dbName). */
function plainDbSig(dir: string, dbName: string): ShardSig {
  const sig: ShardSig = { main: 0, wal: 0 }
  for (const f of [dbName, dbName + '-wal']) {
    try {
      const ms = statSync(join(dir, f)).mtimeMs
      if (f === dbName) sig.main = ms
      else sig.wal = ms
    } catch { /* skip */ }
  }
  return sig
}

/**
 * Sync any plain "dbName" under rawRoot/<sub> -> decryptedDir/<sub> with the
 * shared full/WAL + 0-frame-upgrade policy (realtime coverage for general /
 * sns / favorite / bizchat / chatbot).
 * @returns descriptions of what was synced (empty when nothing changed).
 */
export async function syncPlainDatabase(
  rawRoot: string,
  decryptedDir: string,
  sub: string,
  dbName: string,
  label: string,
  rawKeyHex: string,
  keyFormat: string,
  lastState: Map<string, ShardSig>,
): Promise<string[]> {
  const rawDir = join(rawRoot, sub)
  const decDir = join(decryptedDir, sub)
  const rawDb = join(rawDir, dbName)
  if (!existsSync(rawDb)) return []
  const sig = plainDbSig(rawDir, dbName)
  const prev = lastState.get(label)
  const target = join(decDir, dbName)
  if (prev !== undefined && prev.main === sig.main && prev.wal === sig.wal && existsSync(target)) return []
  lastState.set(label, sig)
  const mode: 'full' | 'wal' = (prev === undefined || prev.main !== sig.main || !existsSync(target)) ? 'full' : 'wal'
  if (mode === 'full' && !fullDecryptDue(label)) {
    lastState.delete(label)
    return []
  }
  try {
    const encKey = shardEncKey(decryptedDir, sub + '/' + dbName, rawDb, rawKeyHex, keyFormat)
    await mkdir(decDir, { recursive: true })
    const stagingDb = target + '.stage_src'
    const stagingWal = target + '.stage_wal'
    const temp = target + '.decrypt_tmp'
    if (mode === 'wal') {
      if (!(await walFramesPatchable(rawDb + '-wal'))) {
        console.warn('[wechat-sync] ' + label + ' wal salt epoch mismatch, keeping snapshot')
        return []
      }
      await copyFile(target, stagingDb)
      await stageWal(rawDb + '-wal', stagingWal)
      try {
        const walPages = existsSync(stagingWal) ? await decryptWalPatch(stagingWal, stagingDb, encKey) : 0
        if (!looksDecrypted(stagingDb)) throw new Error(label + ' wal patch invalid')
        await atomicReplace(stagingDb, target)
        if (walPages > 0) return [label + ':wal(w' + String(walPages) + ')']
        return []
      } finally {
        for (const f of [stagingWal, temp]) { try { await unlink(f) } catch { /* ignore */ } }
      }
    }
    await copyFile(rawDb, stagingDb)
    await stageWal(rawDb + '-wal', stagingWal)
    try {
      const fullPages = await fullDecryptFile(stagingDb, temp, encKey)
      const walPages = existsSync(stagingWal) ? await decryptWalPatch(stagingWal, temp, encKey) : 0
      if (!looksDecrypted(temp)) throw new Error(label + ' decrypt invalid')
      await atomicReplace(temp, target)
      return [label + ':full(' + String(fullPages) + 'p/w' + String(walPages) + ')']
    } finally {
      for (const f of [stagingDb, stagingWal, temp]) { try { await unlink(f) } catch { /* ignore */ } }
    }
  } catch (e) {
    lastState.delete(label)
    console.error('[wechat-sync]', label, (e as Error).message)
    return []
  }
}

/**
 * Remove stale staging/temp files (`.stage_src`/`.stage_wal`/`.decrypt_tmp`)
 * left by a previously interrupted sync. A killed process can leave a
 * half-written snapshot behind, and a fresh run that reuses it can stall.
 * Real decrypted DB files are never matched.
 * @param root - decrypted snapshot root to sweep.
 */
export async function cleanStaleStagingFiles(root: string): Promise<void> {
  const suffixes = ['.stage_src', '.stage_wal', '.decrypt_tmp']
  async function walk(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(p)
        } else if (suffixes.some(s => entry.name.endsWith(s))) {
          try {
            await unlink(p)
          } catch {
            /* best-effort sweep */
          }
        }
      }
    } catch {
      return
    }
  }
  await walk(root)
}

/**
 * Real-time sync loop: first run immediately, then poll on an interval.
 * @param rawDbDir - provider of the raw db_storage root (re-read per tick).
 * @param decryptedDir - provider of the decrypted snapshot root.
 * @param onSync - called with the shards that changed (empty when nothing new).
 * @returns a disposer that stops the loop.
 */
export function startRealtimeSync(
  rawDbDir: () => string, decryptedDir: () => string,
  onSync?: (shards: string[]) => void,
): () => void {
  const lastState = new Map<string, ShardSig>()
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  let unavailableWarned = false
  let failureLogged = false
  let cleaned = false
  const tick = async (): Promise<void> => {
    if (running) return
    running = true
    try {
      if (!cleaned) {
        cleaned = true
        await cleanStaleStagingFiles(decryptedDir())
      }
      const raw = rawDbDir()
      const dec = decryptedDir()
      if (!raw || !dec || !existsSync(raw)) {
        // Fail loud: a missing raw dir makes every tick a silent no-op, which
        // is indistinguishable from a healthy loop. Warn once per outage and
        // log the recovery when the dir becomes available again.
        if (!unavailableWarned) {
          unavailableWarned = true
          console.warn('[wechat-sync] realtime sync paused: raw db dir unavailable',
            `(raw=${JSON.stringify(raw || '')}, decrypted=${JSON.stringify(dec || '')})`,
            '— set db_dir in config.json, _db_dir in all_keys.json, or DSH_WECHAT_BASE_DIR')
        }
        return
      }
      if (unavailableWarned) {
        unavailableWarned = false
        console.log('[wechat-sync] raw db dir available again:', raw)
      }
      const cfg = getConfig(dec)
      const keyFormat = typeof cfg['key_format'] === 'string' ? cfg['key_format'] : 'wx_key_v4.1'
      const fallbackKey = typeof cfg['db_enc_key'] === 'string' ? cfg['db_enc_key'] : ''
      const synced = await syncChangedShards(raw, dec, lastState)
      synced.push(...await syncSessionDb(raw, dec, lastState, fallbackKey, keyFormat))
      synced.push(...await syncContactDb(raw, dec, lastState, fallbackKey, keyFormat))
      for (const [sub, dbName, label] of [
        ['general', 'general.db', 'general.db'],
        ['sns', 'sns.db', 'sns.db'],
        ['favorite', 'favorite.db', 'favorite.db'],
        ['bizchat', 'bizchat.db', 'bizchat.db'],
        ['chatbot', 'chatbot_message.db', 'chatbot_message.db'],
      ] as const) {
        synced.push(...await syncPlainDatabase(raw, dec, sub, dbName, label, fallbackKey, keyFormat, lastState))
      }
      if (synced.length > 0) onSync?.(synced)
      failureLogged = false
    } catch (e) {
      // An unexpected failure must not kill the loop, but it must stay
      // visible: log the first one per outage, then keep quiet until a clean
      // tick proves the loop recovered.
      if (!failureLogged) {
        failureLogged = true
        console.error('[wechat-sync] tick failed:', e instanceof Error ? e.message : e)
      }
    } finally {
      running = false
    }
  }
  void tick()
  timer = setInterval(() => { void tick() }, SYNC_INTERVAL_MS)
  return () => {
    if (timer !== null) { clearInterval(timer); timer = null }
  }
}
