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
import {
  SYNC_INTERVAL_MS,
  failingTargets,
  noteSyncFailure,
  noteSyncSuccess,
  syncFailureBackoffActive,
  takeSyncSuccesses,
} from './sync-pacing.ts'
import { flushSyncSourceState, loadSyncSourceState, noteSyncSourceState } from './sync-state.ts'

const PAGE_SZ = 4096
const SALT_SZ = 16
const IV_SZ = 16
const RESERVE_SZ = 80
const PBKDF2_ITERS = 256000
const SQLITE_HDR = Buffer.from('SQLite format 3\x00')
const WAL_HEADER_SZ = 32
const WAL_FRAME_HEADER_SZ = 24
const FULL_DECRYPT_COOLDOWN_MS = 6_000

/**
 * Cached raw-dir entries; refreshed when the directory signature changes.
 *
 * P1-1：这里原先 `catch { return [] }` —— 目录读不动（被占用 / 权限 / 网络盘断了 / 它是
 * 个文件）与「目录真的是空的」压成同一个值。后果不是少几行日志：`syncChangedShards`
 * 拿到空列表就是「所有分片都没变」，于是**实时同步静默停摆**，界面上的表现是
 * 「新消息永远不出现」，而原因完全查不到（第 47 轮那条「读失败不许当没有数据」的同族）。
 */
export interface DirListing { files: string[]; error?: string }
const dirEntryCache = new Map<string, { sig: string; files: string[] }>()
function cachedDirEntries(dir: string): DirListing {
  try {
    const st = statSync(dir)
    const sig = `${st.mtimeMs}:${st.size}`
    const hit = dirEntryCache.get(dir)
    if (hit && hit.sig === sig) return { files: hit.files }
    const files = readdirSync(dir)
    dirEntryCache.set(dir, { sig, files })
    return { files }
  } catch (e) {
    return { files: [], error: `目录不可读 ${dir}：${e instanceof Error ? e.message : String(e)}` }
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
/**
 * 源库签名。**用字符串而不是毫秒数**（2026-09-29 第 47 轮对齐缓存层口径）：
 * 缓存侧早已是 `mtimeNs + size`（`meta.ts` 的 `fileSig`，见 docs/CACHE-INVALIDATION.md 通道①），
 * 而这里一直只比 `mtimeMs` —— 同毫秒内的写入它**看不见**，`mode` 会误判成 `wal`，
 * 于是那个分片的改动要等下一次变得更多才会被同步到。
 * 现在改成纳秒 + 大小（NTFS 100ns 精度，实测 `statSync(...,{bigint:true})` 与普通 stat 开销无差别）。
 */
interface ShardSig { main: string; wal: string }

/**
 * 「这页解对了没有」的判据 —— 只看 SQLite 页 1 头部里**不能被合成**的字段。
 *
 * 为什么必须有：`decryptPage` 给页 1 无条件贴上 `SQLite format 3\0`（磁盘上那 16 字节是
 * salt，明文里本来就该有魔数），所以**魔数不构成证据** —— 旧实现拿前 15 字节比对魔数，
 * 密钥错也永远为真，于是「解密结果无效」这道闸门（本文件 9 处 + 全量解密 1 处）形同虚设：
 * 错密钥会把一坨乱码发布成快照，面板读到的是「库打不开/查无数据」，而日志一片绿。
 * 真正的证据是加密区里的头部字段：偏移 16-17 的页大小必须是 `[512, 65536]` 内的 2 的幂
 * （`65536` 编码成 1），随机明文撞上它的概率约 16/65536 ≈ 0.02%。
 *
 * 为什么还要再看 18/19/21/22/23：**0.02% 不是抽象风险** —— 全量解密一次要判几百个库，
 * 每轮同步都在判，跑得够久就一定撞得上一次，而撞上的表现是「一个错密钥的乱码库被发布成
 * 快照」（正是这条判据要防的事）。SQLite 规范写死这三个字段：读/写格式只能是 1 或 2，
 * 三个 payload fraction 必须是 64/32/32。加上它们，随机撞过的概率降到约 10⁻¹²。
 * 刻意**不**校验偏移 20 的 reserved（微信那类库这里是 80，不是 0）与偏移 40 的 encoding
 * （要为此多读文件头，收益一样、风险更大）。
 * @param head - 解密产物的前若干字节（至少 24 个）。
 * @returns 是否像一个真库。
 */
export function plausibleSqliteHeader(head: Buffer): boolean {
  if (head.length < 24) return false
  if (!head.subarray(0, 15).equals(SQLITE_HDR.subarray(0, 15))) return false
  const pageSize = head.readUInt16BE(16)
  const sizeOk = pageSize === 1 || (pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0)
  if (!sizeOk) return false
  // 读/写格式：SQLite 只认 1（回滚日志）与 2（WAL / 增量 vacuum）。
  if (head[18] !== 1 && head[18] !== 2) return false
  if (head[19] !== 1 && head[19] !== 2) return false
  // 三个 payload fraction 是规范里写死的常数（任何真库都是 64/32/32）。
  return head[21] === 64 && head[22] === 32 && head[23] === 32
}

/**
 * True when the target exists and its data (not mtime) is usable.
 * 导出是为了让「全量解密」与「实时同步」共用同一个判据（两处各写一份就等于没写）。
 */
export function looksDecrypted(dbPath: string): boolean {
  try {
    return plausibleSqliteHeader(readPrefix(dbPath, 24))
  } catch { return false }
}

/**
 * Atomically replace target with a fully-decrypted temp file (async retries).
 *
 * **不要**先 `unlink(target)`（旧实现如此）：那会在「删掉」与「改名」之间留出一个
 * 「目标不存在」的窗口，并发只读查询正好落在里面就是 ENOENT。
 * Windows 实测：rename 覆盖一个**已存在但未被打开**的文件是允许的
 * （MOVEFILE_REPLACE_EXISTING），所以正常路径下不需要删除；而目标被 SQLite 句柄
 * 打开时两种做法都会失败（rename → EPERM，unlink → EBUSY），真正让同步成功的是
 * 这里的重试等待。导出仅为让回归用例直接验证「替换期间目标始终存在」。
 * @param temp - 已解密好的临时文件。
 * @param target - 目标快照文件。
 */
export async function atomicReplace(temp: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  let lastErr: unknown = null
  for (let i = 0; i < 8; i += 1) {
    try {
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

/**
 * **失败退避 + 日志节流**见 `./sync-pacing.ts`（2026-09-29 从本文件外提：本文件已贴着
 * 单文件 1000 行的硬上限，而那套状态与注释有 100 多行）。这里只留两件事：
 *   ① `sigKeyOf`：把签名压成一行字符串喂给日志（便于对照"是不是同一份数据"）；
 *   ② `forgetFullDecryptCooldown`：测试要能把"退避"与"6 秒 full-decrypt 冷却"分开证伪。
 */
function sigKeyOf(sig: ShardSig): string {
  return `${String(sig.main)}:${String(sig.wal)}`
}

/**
 * 只清空 full-decrypt 冷却（测试用）。
 *
 * 为什么要与上面的退避分开：`syncPlainDatabase` 这类路径上"没有重试"可能来自**两个**原因
 * （退避，或 6 秒的 full-decrypt 冷却）。测试要能**分别**把这两个原因钉住 ——
 * 只清冷却、保留退避，若仍然没有重试，那就是退避在起作用（见
 * `tests/sync-failure-backoff.spec.ts` 的集成用例）。
 */
export function forgetFullDecryptCooldown(): void {
  lastFullAt.clear()
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
/** 源库签名片段：纳秒 + 大小（与缓存层 meta.ts 的 fileSig 同口径，见 docs/CACHE-INVALIDATION.md 通道①）。 */
function statSigStr (path: string): string {
  try {
    const st = statSync(path, { bigint: true })
    return String(st.mtimeNs) + ':' + String(st.size)
  } catch {
    return ''
  }
}
function shardSig(msgDir: string, file: string): ShardSig {
  const sig: ShardSig = { main: '', wal: '' }
  for (const f of [file, file + '-wal']) {
    try {
      const ms = statSigStr(join(msgDir, f))
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
 * @returns `synced` = 同步了什么；`errors` = 哪些读取失败了（**空数组才是「真的没变化」**）。
 */
export async function syncChangedShards(
  rawDbDir: string, decryptedDir: string, lastState: Map<string, ShardSig>,
): Promise<{ synced: string[]; errors: string[] }> {
  const msgDir = join(rawDbDir, 'message')
  const decMsgDir = join(decryptedDir, 'message')
  if (!existsSync(msgDir)) return { synced: [], errors: [] }
  const cfg = getConfig(decryptedDir)
  const keyFormat = typeof cfg['key_format'] === 'string' ? cfg['key_format'] : 'wx_key_v4.1'
  const fallbackKey = typeof cfg['db_enc_key'] === 'string' ? cfg['db_enc_key'] : ''
  const synced: string[] = []
  const errors: string[] = []
  const listing = cachedDirEntries(msgDir)
  if (listing.error !== undefined) errors.push(listing.error)
  for (const f of listing.files) {
    if (!/^(biz_)?message_\d+\.db$/.test(f)) continue
    const sig = shardSig(msgDir, f)
    const prev = lastState.get(f)
    const target = join(decMsgDir, f)
    if (prev !== undefined && prev.main === sig.main && prev.wal === sig.wal && existsSync(target)) continue
    if (syncFailureBackoffActive(f)) continue
    lastState.set(f, sig)
    const mode: 'full' | 'wal' = (prev === undefined || prev.main !== sig.main || !existsSync(target)) ? 'full' : 'wal'
    // 诊断（2026-09-29 第 45 轮）：`full` 会整库重解密（message_1 一次 ≈147MB），
    // 而它每 6 秒冷却一过就可能重来一次。这里把**到底哪个条件**触发了 full 打出来，
    // 免得继续靠推断（前两轮已经推错过一次：源库其实在长）。
    if (mode === 'full' && process.env.SUPERTIME_SYNC_TRACE === '1') {
      const why = prev === undefined ? 'prev=undefined(首次)' : prev.main !== sig.main ? 'main变了' : '产物不存在'
      console.log(`[sync-trace] ${f} → full 原因=${why} prev.main=${prev === undefined ? '-' : String(prev.main)} sig.main=${String(sig.main)} 产物存在=${String(existsSync(target))}`)
    }
    if (mode === 'full' && !fullDecryptDue(f)) {
      // Rate-limit full re-decrypts: a checkpoint can grow the main DB on every
      // message. Defer (do not record the signature) so it retries after the
      // cooldown; the WAL patch path still applies incremental frames meanwhile.
      lastState.delete(f)
      continue
    }
    try {
      const r = await syncMessageShard(msgDir, decMsgDir, f, fallbackKey, keyFormat, mode)
      noteSyncSuccess(f)
      if (mode === 'full' || r.walPages > 0) synced.push(`${f}:${mode}(${r.fullPages}p/w${r.walPages})`)
    } catch (e) {
      // 保留已记录的签名 + 退避：不再"下一轮立刻重解密整库"（见 noteSyncFailure 的注释）。
      noteSyncFailure(f, sigKeyOf(sig), (e as Error).message)
      errors.push(`${f}同步失败：${(e as Error).message}`)
    }
  }
  return { synced, errors }
}

/** Session-db signature (main + wal). */
function sessionSig(sessionDir: string): ShardSig {
  const sig: ShardSig = { main: '', wal: '' }
  for (const f of ['session.db', 'session.db-wal']) {
    try {
      const ms = statSigStr(join(sessionDir, f))
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
  if (syncFailureBackoffActive('session.db')) return []
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
        noteSyncSuccess('session.db')
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
      noteSyncSuccess('session.db')
      return [`session.db:full(${fullPages}p/w${walPages})`]
    } finally {
      for (const f of [stagingDb, stagingWal, temp]) { try { await unlink(f) } catch { /* ignore */ } }
    }
  } catch (e) {
    noteSyncFailure('session.db', sigKeyOf(sig), (e as Error).message)
    return []
  }
}

/** Contact-db signature (main + wal). */
function contactSig(contactDir: string): ShardSig {
  const sig: ShardSig = { main: '', wal: '' }
  for (const f of ['contact.db', 'contact.db-wal']) {
    try {
      const ms = statSigStr(join(contactDir, f))
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
  if (syncFailureBackoffActive('contact.db')) return []
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
        noteSyncSuccess('contact.db')
        if (walPages > 0) return [`contact.db:wal(w${walPages})`]
        return []
      } finally {
        // stagingDb 也要清：正常路径它被 atomicReplace 消费掉了，但 atomicReplace
        // 抛错时（目标被读者占用超过重试窗口）它会以一份**完整快照副本**留在盘上。
        for (const f of [stagingDb, stagingWal, temp]) { try { await unlink(f) } catch { /* ignore */ } }
      }
    }
    await copyFile(rawDb, stagingDb)
    await stageWal(rawDb + '-wal', stagingWal)
    try {
      const fullPages = await fullDecryptFile(stagingDb, temp, encKey)
      const walPages = existsSync(stagingWal) ? await decryptWalPatch(stagingWal, temp, encKey) : 0
      if (!looksDecrypted(temp)) throw new Error('contact decrypt invalid')
      await atomicReplace(temp, target)
      noteSyncSuccess('contact.db')
      return [`contact.db:full(${fullPages}p/w${walPages})`]
    } finally {
      for (const f of [stagingDb, stagingWal, temp]) { try { await unlink(f) } catch { /* ignore */ } }
    }
  } catch (e) {
    noteSyncFailure('contact.db', sigKeyOf(sig), (e as Error).message)
    return []
  }
}


/** Signature of a plain db dir (main + wal by dbName). */
function plainDbSig(dir: string, dbName: string): ShardSig {
  const sig: ShardSig = { main: '', wal: '' }
  for (const f of [dbName, dbName + '-wal']) {
    try {
      const ms = statSigStr(join(dir, f))
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
  if (syncFailureBackoffActive(label)) return []
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
        noteSyncSuccess(label)
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
      noteSyncSuccess(label)
      return [label + ':full(' + String(fullPages) + 'p/w' + String(walPages) + ')']
    } finally {
      for (const f of [stagingDb, stagingWal, temp]) { try { await unlink(f) } catch { /* ignore */ } }
    }
  } catch (e) {
    noteSyncFailure(label, sigKeyOf(sig), (e as Error).message)
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
  // 测量开关（2026-09-29 第 49 轮）：置 1 时**完全不启动**实时同步。
  // 默认不设 ⇒ 行为与现在**完全一致**；用途是 A/B 量"启动瞬间的整库解密占了多少启动延迟"
  //（第 48 轮发现首 tick 的 ~374ms 全量解密正好与"窗口 → 导航壳"那 476ms 重叠）。
  if (process.env.SUPERTIME_SYNC_OFF === '1') return () => { /* 未启动 */ }
  const lastState = new Map<string, ShardSig>()
  /**
   * 跨进程签名账只在本进程**首 tick** 播种一次（`dec` 是动态 provider，启动时可能还没配好数据根）。
   * 播种后「源没变」命中下面既有的 `continue`（零工作量）、「只有 WAL 变」命中既有的 `'wal'` 增量
   * —— 判定逻辑一行没改，实时同步的新鲜度不受影响的只有「启动不必白解一遍」。见 `sync-state.ts`。
   */
  let stateSeeded = false
  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  let unavailableWarned = false
  let dirFailureWarned = false
  let unconfiguredNoted = false
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
      if (!raw || !dec) {
        // "No data source configured" is a *normal* state (fresh install, before any import),
        // not a fault. Warning on stderr here means every launch looks broken: it pollutes
        // smoke output, and PowerShell promotes stderr lines to NativeCommandError. Keep it
        // visible (diagnosability: the loop really is idle) but informational and off stderr.
        if (!unconfiguredNoted) {
          unconfiguredNoted = true
          console.log('[wechat-sync] realtime sync idle: no data source configured',
            '— set db_dir in config.json, _db_dir in all_keys.json, or DSH_WECHAT_BASE_DIR')
        }
        return
      }
      if (!existsSync(raw)) {
        // A *configured* source we cannot read is the real anomaly: a missing raw dir makes
        // every tick a silent no-op, which is indistinguishable from a healthy loop.
        // Warn once per outage and log the recovery when the dir becomes available again.
        if (!unavailableWarned) {
          unavailableWarned = true
          console.warn('[wechat-sync] realtime sync paused: raw db dir unavailable',
            `(raw=${JSON.stringify(raw)}, decrypted=${JSON.stringify(dec)})`)
        }
        return
      }
      if (unavailableWarned) {
        unavailableWarned = false
        console.log('[wechat-sync] raw db dir available again:', raw)
      }
      if (!stateSeeded) {
        stateSeeded = true
        for (const [key, sig] of loadSyncSourceState(dec)) {
          lastState.set(key, { main: sig.main, wal: sig.wal })
        }
      }
      const cfg = getConfig(dec)
      const keyFormat = typeof cfg['key_format'] === 'string' ? cfg['key_format'] : 'wx_key_v4.1'
      const fallbackKey = typeof cfg['db_enc_key'] === 'string' ? cfg['db_enc_key'] : ''
      const shardRes = await syncChangedShards(raw, dec, lastState)
      const synced = shardRes.synced
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
      /** 把「本轮真正解成功」的目标签名记进跨进程账本，然后一次落盘。
       * 只取**成功子集**而不是直接写 `lastState`：后者是乐观记录的（动手前就 `set`、失败那条路还
       * 保留签名）⇒ 会把没解成功的目标也标成「已解密」，下次启动跳过它 ⇒ 永久旧数据。成功集合从
       * `noteSyncSuccess` 那个唯一收口点取（见 `sync-pacing.ts`），不靠 8 个调用点自觉。 */
      for (const key of takeSyncSuccesses()) {
        const sig = lastState.get(key)
        if (sig !== undefined) noteSyncSourceState(key, sig)
      }
      flushSyncSourceState(dec)
      /**
       * 失败的**成因判读放在这里**，而不是写在单个目标那一行里。
       *
       * 为什么：`decrypt invalid` 至少对应两种完全不同的原因 ——
       *   ① **密钥问题**（这个数据根没有密钥文件 / 密钥映射过期）：**所有**目标都解不开；
       *   ② **读到撕裂副本**（微信正独占或正在写那几个大库）：**只有被写的那几个**解不开，
       *      同一轮里别的目标照样成功。
       * 只有把"本轮成功了几项"和"还在失败哪些目标"放在一起看，才分得出是①还是② ——
       * 而这决定了要不要让用户去「设置 → 密钥」重新获取一次。
       * （2026-09-29 实测两次都撞上了：一次是数据根里根本没有密钥文件 ⇒ ①，
       *   修好之后 message 分片仍失败、而 7 个小库同一轮成功 ⇒ ②。）
       */
      const failing = failingTargets()
      if (failing.length > 0) {
        if (!dirFailureWarned) {
          dirFailureWarned = true
          console.warn('[wechat-sync] 同步可能有缺口：' + String(failing.length) + ' 个目标解不开（'
            + failing.join('、') + '）'
            + (synced.length > 0
              ? '；**同一轮里另有 ' + String(synced.length) + ' 项正常取到** ⇒ 更像「微信正独占/正在写这些库」'
                + '（读到撕裂副本），不是密钥问题，等它写完会自愈'
              : '；**本轮没有任何目标取到** ⇒ 更像密钥或密钥映射的问题，'
                + '到「设置 → 密钥」点一次「一键获取数据库密钥」'))
        }
      } else if (dirFailureWarned) {
        dirFailureWarned = false
        console.log('[wechat-sync] 同步已恢复正常（本轮没有解不开的目标）')
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
