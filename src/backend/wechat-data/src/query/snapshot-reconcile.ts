/**
 * 启动时对解密快照里的 `-wal` 做**安全对账**：能 checkpoint 的就合回主文件，
 * 合不进去的改名隔离 —— 绝不先删。
 *
 * ## 为什么需要它
 *
 * 快照目录归我们自己所有（不是微信源库），但它同样会被上一次进程的异常退出打断在
 * 「写主文件 / checkpoint」中途。此时主文件可能撕裂，而 `-wal` 里正是尚未落进主文件的页：
 * 直接删 WAL 会把可自愈状态变成永久的 `database disk image is malformed`。
 * 所以启动清理（`snapshot-sidecars.ts#cleanStaleSnapshotLeftovers`）只删空 WAL，
 * 非空的交给本模块逐库判断：
 *
 *   · `PRAGMA quick_check` 全部 `'ok'` ⇒ `PRAGMA wal_checkpoint(TRUNCATE)` 合回主文件，
 *     关闭连接后清掉空的 `-wal` 与 `-shm`；
 *   · WAL 头不像 WAL（撕裂 / 垃圾字节） ⇒ 不开连接、直接隔离。SQLite 对无效 WAL 的
 *     处理是**静默按空 WAL 截断并在关闭时删除**，那等于又一次盲删，必须由我们拦住；
 *   · quick_check 因**微信自带 FTS 模块/分词器缺失**而抛错（本机没有那些扩展，不是页损坏）
 *     ⇒ 仍尝试 checkpoint，成功同上；这一支 checkpoint 失败只跳过、保留；
 *   · quick_check 返回非 `'ok'` 行，或打开/查询明确报 `malformed` / `not a database` /
 *     `SQLITE_CORRUPT` / `SQLITE_NOTADB` ⇒ **结构性损坏**，不 checkpoint，把 `-wal`/`-shm`
 *     改名成 `<db>.quarantine-<毫秒时间戳>-wal` / `-shm`，主库原样保留；
 *   · 其余错误（`SQLITE_BUSY` / locked / EPERM / EACCES / 磁盘错误）和 checkpoint 的
 *     `busy≠0` ⇒ **临时状态**，WAL 原样保留、只记日志，等下一轮对账 —— 隔离会丢已提交数据。
 *
 * 所有失败都只记日志，不抛穿整轮（启动路径不能因为一个分片读不了就停摆）。
 *
 * ## Windows 注意
 *
 * 连接必须先关闭再 rename（SQLite 句柄会挡住改名）；`rename` 用 `node:fs/promises` 并
 * try/catch，单个文件失败不影响其余文件。
 * @module query/snapshot-reconcile
 */
import { open, readdir, rename, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { withWritableDb } from './db-open.ts'
import type { DatabaseSync } from '../sqlite-connection.ts'

/** `-wal` 头长度：≤32B 的 WAL 只有个头，SQLite 当它没有帧（无需对账）。 */
const WAL_HEADER_SZ = 32

/** 递归深度上限（根目录本身算第 0 层；最多再往下 4 层）。 */
const MAX_DEPTH = 4

/**
 * 本机缺少微信自带 FTS 模块/分词器时的错误文案。
 *
 * 这类失败说明 schema 里有本机不认识的虚拟表，而不是页面树损坏 —— 不能据此隔离 WAL。
 */
const FTS_MODULE_MISSING_RE = /no such (module|tokenizer|function)|not authorized/i

/**
 * 「结构性损坏」的错误文案。只有这一类才允许隔离 WAL；
 * busy/locked/EPERM/EACCES/磁盘错误都是临时状态，隔离会丢掉已提交的数据。
 */
const STRUCTURAL_CORRUPTION_RE = /malformed|not a database|SQLITE_CORRUPT|SQLITE_NOTADB/i

/** 单轮对账计数（`checked` = 实际带非空 WAL、进入判断的库数）。 */
interface ReconcileCounts {
  checked: number
  checkpointed: number
  quarantined: number
}

/**
 * 一个库的检查结论：
 *   · checkpoint —— 合回主文件；
 *   · quarantine —— 结构性损坏，改名隔离；
 *   · skip —— 临时失败（busy/locked/权限/磁盘），原样保留，等下一轮。
 */
type CheckAction =
  | { action: 'checkpoint' }
  | { action: 'quarantine'; reason: string }
  | { action: 'skip'; reason: string }

/** 异常转一行日志文案。 */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** WAL 头检查结论（读不到 ≠ 头损坏：前者只能跳过）。 */
type WalHeaderState = 'ok' | 'invalid' | 'unreadable'

/**
 * WAL 头结构是否可信（magic + 页大小）。
 *
 * 为什么必须在打开连接**之前**判：SQLite 遇到无效 WAL 头不会报错，而是把它当成空 WAL，
 * 在第一次 checkpoint 时截断、关闭连接时删除 —— 又变成一次静默盲删。头都不像 WAL 的
 * 文件（撕裂在头、或被替换成垃圾字节）留给隔离位，至少还能事后取证。
 * @param walPath - WAL 文件路径（调用方已确认存在且非空）。
 * @returns `'ok'` = 头可信；`'invalid'` = 结构性损坏；`'unreadable'` = 暂时读不到（如被占用）。
 */
async function inspectWalHeader(walPath: string): Promise<WalHeaderState> {
  let fh
  try {
    fh = await open(walPath, 'r')
  } catch {
    return 'unreadable'
  }
  try {
    const head = Buffer.alloc(WAL_HEADER_SZ)
    const { bytesRead } = await fh.read(head, 0, WAL_HEADER_SZ, 0)
    if (bytesRead < WAL_HEADER_SZ) return 'invalid'
    // WAL 头按大端存储：magic 0x377f0682（小端校验和）或 0x377f0683（大端校验和）。
    const magic = head.readUInt32BE(0)
    if (magic !== 0x377f0682 && magic !== 0x377f0683) return 'invalid'
    const pageSize = head.readUInt32BE(8)
    const sane = pageSize >= 512 && pageSize <= 65536 && (pageSize & (pageSize - 1)) === 0
    return sane ? 'ok' : 'invalid'
  } catch {
    return 'unreadable'
  } finally {
    try { await fh.close() } catch { /* 关闭失败不影响结论 */ }
  }
}

/**
 * 跑一次 `PRAGMA wal_checkpoint(TRUNCATE)`，并读懂返回行里的 `busy`：
 * busy≠0 表示读者/写者占着，WAL 里的帧没完全合回 —— 这轮只能跳过，**不能隔离**。
 * @param db - 已打开的可写连接。
 * @param lenient - true 时任何异常都按「临时失败」跳过（用于缺 FTS 模块的降级分支）。
 * @returns checkpoint 成功 / 结构性损坏（隔离）/ 临时失败（保留）。
 */
function runCheckpoint(db: DatabaseSync, lenient: boolean): CheckAction {
  try {
    const rows = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all()
    const first = rows[0]
    const busy = first ? Number(first.busy ?? 0) : 0
    if (busy !== 0) {
      return { action: 'skip', reason: `checkpoint 忙（busy=${busy}，连接占用中），保留 WAL 待下次对账` }
    }
    return { action: 'checkpoint' }
  } catch (e) {
    const text = errorText(e)
    if (!lenient && STRUCTURAL_CORRUPTION_RE.test(text)) {
      return { action: 'quarantine', reason: `checkpoint 报告结构损坏：${text}` }
    }
    return { action: 'skip', reason: `checkpoint 暂时失败（${text}），保留 WAL 待下次对账` }
  }
}

/**
 * 在一个已打开的**可写**连接上做 quick_check，并按结论决定是否 checkpoint。
 *
 * 必须同步执行：连接由 `withWritableDb` 在回调返回后关闭，rename/删除要在那之后做。
 * @param db - 已打开的可写连接。
 * @returns 合回主文件 / 隔离 / 本轮跳过（原因）。
 */
function probeAndCheckpoint(db: DatabaseSync): CheckAction {
  let verdicts: string[]
  try {
    verdicts = db.prepare('PRAGMA quick_check').all()
      .map((row) => String(Object.values(row)[0] ?? ''))
  } catch (e) {
    const text = errorText(e)
    if (FTS_MODULE_MISSING_RE.test(text)) {
      // 缺少微信自带的 FTS 模块：quick_check 无从判断页面树，但仍尝试把 WAL 合回去；
      // 这一支的 checkpoint 失败一律按临时状态保留（不是损坏证据）。
      return runCheckpoint(db, true)
    }
    if (STRUCTURAL_CORRUPTION_RE.test(text)) {
      return { action: 'quarantine', reason: `quick_check 报告结构损坏：${text}` }
    }
    return { action: 'skip', reason: `quick_check 暂时失败（${text}），保留 WAL 待下次对账` }
  }

  // quick_check 明确返回了非 ok 行：这是结构性损坏的唯一可靠判据。
  if (verdicts.length === 0 || verdicts.some((v) => v !== 'ok')) {
    return {
      action: 'quarantine',
      reason: `quick_check 未通过：${verdicts.slice(0, 2).join('；') || '无结果'}`,
    }
  }

  return runCheckpoint(db, false)
}

/**
 * checkpoint 成功、连接已关闭之后的清理：删 `-shm`；`-wal` 已归零（≤32B）就删掉。
 * @param dbFile - 数据库主文件路径。
 */
async function cleanupAfterCheckpoint(dbFile: string): Promise<void> {
  try { await unlink(dbFile + '-shm') } catch { /* 本来就没有 / 被占用：无害 */ }
  let size = Number.POSITIVE_INFINITY
  try {
    size = (await stat(dbFile + '-wal')).size
  } catch {
    return // WAL 已经不在了
  }
  if (size <= WAL_HEADER_SZ) {
    try { await unlink(dbFile + '-wal') } catch { /* 被占用：下一次对账会再看到它 */ }
  }
}

/**
 * 把带帧的 `-wal` / `-shm` 改名到隔离位，**保留主库**。
 *
 * rename 失败会向上抛（由单库的外层 try/catch 记日志），这样下一轮对账还能重试；
 * 不把失败谎报成「已隔离」。
 * @param dbFile - 数据库主文件路径。
 * @param reason - 隔离原因（写进日志）。
 * @returns `'quarantined'`（给调用方计数）。
 */
async function quarantineWal(dbFile: string, reason: string): Promise<'quarantined'> {
  const stamp = Date.now()
  const target = `${dbFile}.quarantine-${stamp}-wal`
  await rename(dbFile + '-wal', target)
  try {
    await rename(dbFile + '-shm', `${dbFile}.quarantine-${stamp}-shm`)
  } catch { /* -shm 可能不存在：只是 wal-index 缓存，丢了 SQLite 自己会重建 */ }
  console.warn(`[snapshot-reconcile] 已隔离 WAL：${dbFile} → ${target}（原因：${reason}）`)
  return 'quarantined'
}

/**
 * 对**单个**库做对账（调用方已确认旁边有非空 `-wal`）。
 *
 * 判定顺序：先看 WAL 头（坏了才是结构性损坏）→ quick_check → checkpoint。
 * 任何「临时失败」都原样保留 WAL 并跳过；只有结构性损坏才隔离。
 * @param dbFile - 数据库主文件路径。
 * @returns `'checkpointed'` / `'quarantined'` / `'skipped'`。
 */
async function reconcileOne(dbFile: string): Promise<'checkpointed' | 'quarantined' | 'skipped'> {
  const walPath = dbFile + '-wal'
  const header = await inspectWalHeader(walPath)
  if (header === 'invalid') {
    return quarantineWal(dbFile, 'WAL 头不像 WAL（撕裂或垃圾字节）')
  }
  if (header === 'unreadable') {
    // 读不到（被占用 / 权限）不是损坏证据：保留，下一轮再看。
    console.warn(`[snapshot-reconcile] 暂时读不到 WAL 头，保留待下次对账：${walPath}`)
    return 'skipped'
  }

  let verdict: CheckAction
  try {
    verdict = withWritableDb(dbFile, probeAndCheckpoint)
  } catch (e) {
    const text = errorText(e)
    if (FTS_MODULE_MISSING_RE.test(text)) {
      // 打开阶段就撞上缺 FTS 模块：单独尝试一次 checkpoint；
      // 这一支无论 checkpoint 忙还是抛错都保留 WAL（不是损坏证据）。
      try {
        const retry = withWritableDb(dbFile, (db) => runCheckpoint(db, true))
        if (retry.action === 'checkpoint') {
          await cleanupAfterCheckpoint(dbFile)
          return 'checkpointed'
        }
        console.warn(
          `[snapshot-reconcile] 缺少微信 FTS 模块且 checkpoint 未成功，保留 WAL：${dbFile}` +
          `（${retry.action === 'skip' ? retry.reason : '未知原因'}）`,
        )
        return 'skipped'
      } catch (e2) {
        console.warn(`[snapshot-reconcile] 缺少微信 FTS 模块且 checkpoint 抛错，保留 WAL：${dbFile}（${errorText(e2)}）`)
        return 'skipped'
      }
    }
    if (STRUCTURAL_CORRUPTION_RE.test(text)) {
      return quarantineWal(dbFile, `打开数据库报告结构损坏：${text}`)
    }
    // busy / locked / EPERM / EACCES / 磁盘错误：临时状态，不隔离、不删除。
    console.warn(`[snapshot-reconcile] 打开数据库暂时失败，保留 WAL：${dbFile}（${text}）`)
    return 'skipped'
  }

  if (verdict.action === 'checkpoint') {
    await cleanupAfterCheckpoint(dbFile)
    return 'checkpointed'
  }
  if (verdict.action === 'quarantine') return quarantineWal(dbFile, verdict.reason)
  console.warn(`[snapshot-reconcile] 本轮跳过，保留 WAL：${dbFile}（${verdict.reason}）`)
  return 'skipped'
}

/** 递归收集 `*.db` 与 `.superseded-wal` 残留（深度见 {@link MAX_DEPTH}）。 */
async function collectSnapshotFiles(
  dir: string,
  depth: number,
  out: { dbs: string[]; superseded: string[] },
): Promise<void> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // 目录不可读（不存在 / 被占用）：本轮跳过，不打断整轮
  }
  for (const entry of entries) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) await collectSnapshotFiles(p, depth + 1, out)
      continue
    }
    if (entry.name.endsWith('.superseded-wal')) out.superseded.push(p)
    else if (entry.name.endsWith('.db')) out.dbs.push(p)
  }
}

/**
 * 启动时对快照根目录做一轮 WAL 对账：有效的合回主文件，无效的改名隔离，绝不盲删。
 *
 * 幂等：合回去/隔离掉的文件下一轮不再出现；单文件失败只记日志，不抛穿整轮。
 * @param root - 解密快照根目录（不存在或不可读时返回全 0，不抛错）。
 * @returns `checked` = 带非空 WAL、真正进入判断的库数；`checkpointed` = 成功合回主文件的库数；
 *   `quarantined` = WAL 被改名隔离的库数（`.superseded-wal` 的隔离不计入）。
 */
export async function reconcileSnapshotWal(root: string): Promise<{ checked: number; checkpointed: number; quarantined: number }> {
  const counts: ReconcileCounts = { checked: 0, checkpointed: 0, quarantined: 0 }
  const found = { dbs: [] as string[], superseded: [] as string[] }
  await collectSnapshotFiles(root, 0, found)
  found.dbs.sort()
  found.superseded.sort()

  for (const dbFile of found.dbs) {
    try {
      let size: number
      try {
        size = (await stat(dbFile + '-wal')).size
      } catch {
        continue // 没有 -wal：已干净收尾的正常快照
      }
      if (size <= WAL_HEADER_SZ) continue // 空 WAL 无帧，无需对账
      counts.checked += 1
      const outcome = await reconcileOne(dbFile)
      if (outcome === 'checkpointed') counts.checkpointed += 1
      else if (outcome === 'quarantined') counts.quarantined += 1
      // skipped（busy/locked/权限/磁盘）：WAL 原样保留，不计入两个动作计数。
    } catch (e) {
      console.warn(`[snapshot-reconcile] 对账 ${dbFile} 失败，已跳过：${errorText(e)}`)
    }
  }

  // 上一代 WAL 的隔离位：只改名留档，不删除（可能含主文件缺失的页，留给人工/修复路径）。
  for (const superseded of found.superseded) {
    try {
      const stamp = Date.now()
      const target = superseded.replace(/\.superseded-wal$/, `.quarantine-${stamp}-superseded-wal`)
      await rename(superseded, target)
      console.warn(`[snapshot-reconcile] 发现上一代 WAL 残留，已隔离留档：${superseded} → ${target}`)
    } catch (e) {
      console.warn(`[snapshot-reconcile] 隔离上一代 WAL 残留失败 ${superseded}：${errorText(e)}`)
    }
  }

  return counts
}
