/**
 * Full SQLCipher decyption of the WeChat raw db_storage tree into the
 * decrypted snapshot (one-call "立即解密"). Per database: stage-copy the raw
 * main DB + WAL (the source may be written concurrently) → page-1 salt →
 * PBKDF2-HMAC-SHA512(256000) derive (wx_key_v4.1) → AES-256-CBC page stream
 * decrypt → merge patchable WAL frames → SQLite-header check + full
 * `PRAGMA quick_check` (corrupt results are never published) → atomic publish
 * at `<decrypted>/<rel>`. Reuses the same layout as sync.ts so the realtime
 * watchers keep working.
 */
import { pbkdf2Sync } from 'node:crypto'
import {
  closeSync, existsSync, mkdirSync, openSync, readSync, statSync, unlinkSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { atomicReplace, fullDecryptFile, looksDecrypted } from './sync.ts'
import { getConfig, scanDbFiles } from './config.ts'
import { stageCopyRetry } from './snapshot-sidecars.ts'
import { WAL_HEADER_SZ, decryptWalPatch, walFramesPatchable } from './sqlcipher-wal.ts'
import { assertPublishable } from './snapshot-verify.ts'

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
 * @param onlyRel - **只解密这些 rel 路径**（`message/message_0.db` 这种键，与
 *   {@link checkDecryptedIntegrity} 出来的 `file` 同构）。修复链路用它实现
 *   「损坏哪个解哪个」：不传 = 全量解密（`立即解密` 原行为，逐字节不变）；
 *   传了 = 别的库连读都不读，`total` 计数也随过滤后的集合走 —— 修复进度条
 *   说的是「要修的这几个」，不是「全部 22 个库」。
 * @returns ok + success/failure counts (per-db failures never abort the run).
 */
export async function decryptAllDbs(
  rawDbDir: string,
  decryptedDir: string,
  onProgress?: (done: number, total: number, failed: number, message: string) => void,
  onlyRel?: readonly string[],
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

  // ⚠️ 这里**故意没有**加 `yieldToLoop`，虽然 `scanDbFiles`（`detect.ts:165`）是同步递归遍历。
  // 第 73 轮核实过：本机 `db_dir` 未配置 ⇒ 函数在上面第 68 行就提前 return 了，
  // 加在遍历前后的两行**根本执行不到**，改与不改完全一样（探针里 `decryptAllDatabases`
  // 的「让出」前后都是 0）。**没有证据支持的改动不留。**
  // 真要判断这里是否需要让出，前提是先把探针那一行的读数修好 —— 它现在报
  // `total(ms)=4077/4175 秒、让出 0`，而 4.08e9/4.18e9 ≈ **2³²**，
  // 是 **32 位溢出**的读数，不是真实耗时（整轮墙钟上限才 180s）。
  const dbs = scanDbFiles(rawDbDir)
  // 修复模式：只解损坏的那几个（键是 rel 路径，与 checkDecryptedIntegrity 的输出同构）。
  // 过滤放在扫描之后而不是重新实现一遍遍历 —— 「解哪些文件」只许有一个遍历实现。
  const wanted = onlyRel === undefined ? null : new Set(onlyRel)
  const scope = wanted === null ? dbs : dbs.filter((db) => wanted.has(relative(rawDbDir, db).replace(/\\/g, '/')))
  const failed: Array<{ db: string; error: string }> = []
  let okCount = 0
  let done = 0
  for (const db of scope) {
    const rel = relative(rawDbDir, db).replace(/\\/g, '/')
    const target = join(decryptedDir, rel)
    const staged = target + '.decrypt_tmp'
    // 源侧 staging：微信可能正写着原始主库/WAL，边读边解会读出撕裂页。先整文件复制
    // 一份（带 EBUSY 有界重试，与实时同步共用 `snapshot-sidecars.ts#stageCopyRetry`），
    // 后续解密只碰副本。三个后缀都放在目标旁边，失败/成功都由 finally 清掉。
    const stagedSrc = target + '.decrypt_src'
    const stagedWal = target + '.decrypt_wal'
    try {
      mkdirSync(dirname(target), { recursive: true })
      await stageCopyRetry(db, stagedSrc)
      const salt = readPrefix(stagedSrc, 16)
      if (salt.length < 16) throw new Error('文件过小')
      const keyHex = rawKeyHexFor(decryptedDir, rel, rawKeyHex)
      if (keyHex.length !== 64) throw new Error('db_enc_key 缺失')
      const encKey = deriveEncKey(Buffer.from(keyHex, 'hex'), salt, keyFormat)
      // 原始主库只含**已 checkpoint** 的页；微信最新写入可能还躺在旁边的 `-wal` 里。
      // 不合并它，修复会静默丢掉最新消息；而源主库签名没变，实时同步之后也不会再补。
      // 口径与 sync.ts 的整库路径一致：主库副本 + WAL 副本 + 帧补丁（salt 换代则跳过）。
      const rawWal = db + '-wal'
      let walPatchable = false
      if (existsSync(rawWal) && statSync(rawWal).size > WAL_HEADER_SZ) {
        await stageCopyRetry(rawWal, stagedWal)
        // 复制后先判「这批帧还属于当前 salt 世代吗」：不可补说明是陈旧 WAL，
        // 对应的页早已 checkpoint 进主库（详见 sqlcipher-wal.ts#walFramesPatchable）。
        walPatchable = await walFramesPatchable(stagedWal)
        if (!walPatchable) {
          console.warn('[wechat-decrypt]', rel,
            '源 -wal 的帧与 WAL 头 salt 世代不一致（陈旧 WAL），主库已含对应页，跳过帧补丁')
        }
      }
      await fullDecryptFile(stagedSrc, staged, encKey)
      if (walPatchable) await decryptWalPatch(stagedWal, staged, encKey)
      // 判据与实时同步共用同一个主人 `sync.ts#looksDecrypted`：`decryptPage` 给页 1 无条件
      // 贴上魔数，所以「比对魔数」等于没比，必须看头部里不能被合成的字段（页大小）。
      if (!looksDecrypted(staged)) throw new Error('解密结果校验失败（密钥不匹配？）')
      // 头部只覆盖页 1；页 2 起的损坏（撕裂读、补丁打错页）必须让 SQLite 自己扫一遍。
      // corrupt ⇒ 抛错，atomicReplace 不会执行，旧目标原样保留；uncheckable ⇒ 告警放行。
      assertPublishable(staged)
      // 发布走 `sync.ts` 的 `atomicReplace`，**不要**改回「先 unlink 再 rename」：
      // 那会在「删掉」与「改名」之间留出一个「目标不存在」的窗口，并发只读查询正好落在
      // 里面就是 ENOENT；而 Windows 上目标被 SQLite 打开时 unlink 直接 EBUSY，整库解密被记成失败。
      // 这条不变量在 `sync.ts#atomicReplace` 里有同名注释，实时同步与全量解密必须是同一份实现。
      await atomicReplace(staged, target)
      okCount += 1
    } catch (e) {
      failed.push({ db: rel, error: (e as Error).message })
    } finally {
      // 成功失败都清：半截 `.decrypt_tmp` 与源侧 `.decrypt_src/.decrypt_wal` 都不该
      // 留给下一次运行或面板；失败时旧目标仍由 catch 语义保留（这里只动临时文件）。
      for (const f of [staged, stagedSrc, stagedWal]) {
        try { unlinkSync(f) } catch { /* best effort cleanup */ }
      }
    }
    done += 1
    onProgress?.(done, scope.length, failed.length, rel)
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
  return { ok: failed.length === 0, total: scope.length, okCount, failed }
}
