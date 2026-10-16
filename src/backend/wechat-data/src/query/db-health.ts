/**
 * Data health view: walks the decrypted tree for SQLite files/WAL/SHM sizes,
 * reads the search-index status, and reports plugin store files plus the
 * decoded-image cache footprint.
 *
 * 本文件还住着**逐库完整性体检**（`checkDecryptedIntegrity`）—— 「数据库健康」面板
 * 原先只报文件大小/数量，损坏的库与健康的库在这里长得一模一样，而
 * `wechat-host.js` 的处方（「库文件已损坏 ⇒ 到数据库健康体检，必要时重新解密」）
 * 指的正是这个面板。没有这一层体检，那条处方就是死胡同：用户照着走到面板，
 * 看到一片 ✅，什么也修不了。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DbHealthSnapshot, DbHealthStore, DbIntegrityIssue, DbIntegrityResult } from '../types.ts'
import { withDb } from './db-open.ts'
import { getSearchIndexStatus } from './search.ts'
import { cachedBySig, dataGenerationSig } from './meta.ts'

/** Recursively list .db files under a directory (depth 4) as rel paths. */
function walkDbFiles(dir: string, depth: number): string[] {
  if (depth > 4 || !existsSync(dir)) return []
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      for (const sub of walkDbFiles(p, depth + 1)) out.push(join(e.name, sub))
    } else if (e.name.endsWith('.db')) {
      out.push(e.name)
    }
  }
  return out
}

/** Recursively count .db/-wal/-shm sizes under a directory (depth 4). */
function walkSqlite(dir: string, depth: number): { dbCount: number; dbBytes: number; walCount: number; shmCount: number } {
  let dbCount = 0
  let dbBytes = 0
  let walCount = 0
  let shmCount = 0
  if (depth > 4 || !existsSync(dir)) return { dbCount, dbBytes, walCount, shmCount }
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const sub = walkSqlite(p, depth + 1)
      dbCount += sub.dbCount
      dbBytes += sub.dbBytes
      walCount += sub.walCount
      shmCount += sub.shmCount
    } else {
      try {
        const size = statSync(p).size
        if (e.name.endsWith('.db')) { dbCount += 1; dbBytes += size }
        else if (e.name.endsWith('-wal') || e.name.endsWith('.db-wal')) walCount += 1
        else if (e.name.endsWith('-shm') || e.name.endsWith('.db-shm')) shmCount += 1
      } catch { /* skip unreadable */ }
    }
  }
  return { dbCount, dbBytes, walCount, shmCount }
}

/** Count/size of a directory (decoded image cache). */
function dirStats(dir: string): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  if (!existsSync(dir)) return { count: 0, bytes: 0 }
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      try {
        if (e.isDirectory()) {
          const sub = dirStats(join(dir, e.name))
          count += sub.count
          bytes += sub.bytes
        } else {
          count += 1
          bytes += statSync(join(dir, e.name)).size
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return { count, bytes }
}

/**
 * Compute the data-health snapshot (cached ~5s so repeated open/close does
 * not rescan the whole decrypted tree).
 * @param decryptedDir - decrypted data root.
 * @returns the health snapshot.
 */
export function queryDbHealth(decryptedDir: string): DbHealthSnapshot {
  const key = 'db-health:' + decryptedDir
  // 健康快照扫描**整棵** decrypted 树（外加 root store / decoded_images / 搜索索引），
  // 用数据世代签名失效。见 status.ts 里关于「为什么不用整树签名」的说明。
  return cachedBySig(key, dataGenerationSig(), () => computeDbHealth(decryptedDir))
}

function computeDbHealth(decryptedDir: string): DbHealthSnapshot {
  const sqlite = walkSqlite(decryptedDir, 0)
  const root = dirname(decryptedDir)
  const stores: DbHealthStore[] = []
  for (const name of ['wechat_tasks.db', 'daily_summary.db', 'message_edits.db', 'wechat_search.db', 'config.json', 'all_keys.json']) {
    const p = join(root, name)
    try {
      if (existsSync(p)) stores.push({ name, size: statSync(p).size })
    } catch { /* skip */ }
  }
  const images = dirStats(join(root, 'decoded_images'))
  return {
    dbFiles: sqlite.dbCount,
    dbBytes: sqlite.dbBytes,
    walFiles: sqlite.walCount,
    shmFiles: sqlite.shmCount,
    searchIndex: getSearchIndexStatus(decryptedDir),
    stores,
    decodedImagesCount: images.count,
    decodedImagesBytes: images.bytes,
    updatedAt: Math.floor(Date.now() / 1000),
  }
}

/**
 * 「这条错误消息是不是真的说明文件坏了」的判据 —— 窄正则，口径与
 * `src/backend/wechat-host.js` 的 `READABLE_ERRORS` 第 2 条**逐字一致**。
 *
 * 为什么值得照抄而不是另写一组：那边是「英文原文 ⇒ 给用户的处方」，这边是
 * 「英文原文 ⇒ 要不要重解密」—— 同一类错误、两个判断，正则一旦漂移，
 * 就会出现「界面说坏了、体检说没坏」这种自相矛盾。改一处必须改两处
 * （`host-error-message.spec.ts` 守表不缩水，这条注释守两处同源）。
 */
const CORRUPTION_RE = /file is not a database|SQLITE_NOTADB|SQLITE_CORRUPT|database disk image is malformed/i

/**
 * 本机 SQLite（node:sqlite）**自带**的 FTS5 分词器白名单。
 *
 * 为什么要有它：微信的 `*_fts.db` 里是 `CREATE VIRTUAL TABLE … USING fts5(tokenize='MMFtsTokenizer …')`——
 * 那个分词器编在微信里，本机 SQLite 装不上。而 `PRAGMA integrity_check` 会去实例化虚拟表，
 * 于是必然抛 SQLITE_ERROR（node:sqlite 给的就是那句没信息量的 `SQL logic error`），
 * **与库坏没坏毫无关系**（2026-10-13 实测：三个 `*_fts.db` 全被判成「没能体检」，面板还让
 * 用户去退微信 —— 那是错的下一步）。
 */
const BUILTIN_FTS_TOKENIZERS = new Set(['unicode61', 'ascii', 'porter', 'trigram'])

/** 从虚拟表 DDL 里取 `tokenize=` 的第一个词（引号可有可无；后面那些是它自己的参数）。 */
const TOKENIZE_RE = /tokenize\s*=\s*["']?([A-Za-z_][A-Za-z0-9_]*)/i

/** 「本机没有这个模块/分词器」的原话 —— 万一 DDL 里没写出来，还能按这句把类判对。 */
const MISSING_MODULE_RE = /no such (module|tokenizer|function)|not authorized/i

/**
 * 这个库**本机体检不了**的原因（`null` = 能体检）。
 *
 * 判据只看 `sqlite_master` 里的虚拟表 DDL，**不看错误文案**：错误文案是
 * `SQL logic error` 这种通用句，拿它当判据等于没判。看得到分词器名字，才说得清
 * 「为什么检不了、为什么退出微信也没用」。
 * @param abs - 库的绝对路径。
 * @returns 说清原因的一句话，或 null。
 */
function uncheckableReason(abs: string): string | null {
  try {
    return withDb(abs, (db) => {
      const rows = db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'",
      ).all() as Array<Record<string, unknown>>
      for (const r of rows) {
        const tokenizer = TOKENIZE_RE.exec(String(r['sql'] ?? ''))
        if (tokenizer === null) continue
        const name = tokenizer[1] ?? ''
        if (BUILTIN_FTS_TOKENIZERS.has(name.toLowerCase())) continue
        return `含虚拟表 ${String(r['name'] ?? '')}，它用的是本机 SQLite 没有的 FTS 分词器 ${name}`
          + '（编在微信里）—— `PRAGMA integrity_check` 要实例化它，所以这个库本机体检不了；与损坏无关，退出微信也没用'
      }
      return null
    })
  } catch {
    return null
  }
}

/**
 * 逐库跑 `PRAGMA integrity_check`（**按需显式动作**，不在健康快照里）。
 *
 * 三件必须说清的事：
 *   ① **为什么不在 `queryDbHealth` 的快照里**：那张快照被「原图链路自检」等面板
 *      启动时顺带读取（`Hook.tsx`），把几十万页的完整性扫描挂上去等于给每次挂载
 *      加几秒阻塞；体检是用户点「重新检查 / 修复」时才做的显式动作。
 *   ② **让出的粒度是「一个库」**：`node:sqlite` 全是同步 API，单个库的
 *      integrity_check 是一次性同步扫描（本机最大的 message 分片要论秒），
 *      这一步躲不掉；库与库之间让出，别的请求才插得进 gap。
 *   ③ **成败分类**（见 {@link DbIntegrityResult}）：查不了 ≠ 坏了 ≠ 本机检不了。
 *      三类分开报 —— 上一版只有前两类，于是三个「本机检不了」的 FTS 库被说成
 *      「多半被微信独占」，用户去退微信只会白等（见 {@link uncheckableReason}）。
 * @param decryptedDir - decrypted data root.
 * @returns 每个库的结论：损坏（本地清残留 / 重解密可修）/ 查不了（占用等）/ 本机检不了。
 */
export async function checkDecryptedIntegrity(decryptedDir: string): Promise<DbIntegrityResult> {
  const files = walkDbFiles(decryptedDir, 0)
  const corrupted: DbIntegrityIssue[] = []
  const unreadable: DbIntegrityIssue[] = []
  const uncheckable: DbIntegrityIssue[] = []
  for (const rel of files) {
    const abs = join(decryptedDir, rel)
    const file = rel.replace(/\\/g, '/')
    // 本机装不上的模块/分词器 ⇒ integrity_check 注定报错，**不必扫**（省掉整库一遍）。
    const reason = uncheckableReason(abs)
    if (reason !== null) {
      uncheckable.push({ file, error: reason })
      await new Promise<void>((resolve) => { setImmediate(resolve) })
      continue
    }
    try {
      const verdicts = withDb(abs, (db) => {
        const rows = db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>
        return rows.map((r) => String(Object.values(r)[0] ?? ''))
      })
      const bad = verdicts.filter((v) => v !== 'ok')
      if (bad.length > 0) corrupted.push({ file, error: bad.slice(0, 3).join('；') })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      const issue: DbIntegrityIssue = { file, error: msg }
      // 一打开就 NOTADB/CORRUPT 的（头部就被写坏、或压根不是解密产物）也归「损坏」——
      // 它同样能靠重新解密修好。其余打开失败（占用 / 权限）不冒充损坏；
      // 「缺模块」这类按缺失类归（DDL 里没写出来的那些，靠 SQLite 的原话兜底）。
      if (CORRUPTION_RE.test(msg)) corrupted.push(issue)
      else if (MISSING_MODULE_RE.test(msg)) uncheckable.push(issue)
      else unreadable.push(issue)
    }
    await new Promise<void>((resolve) => { setImmediate(resolve) })
  }
  return { checked: files.length, corrupted, unreadable, uncheckable }
}
