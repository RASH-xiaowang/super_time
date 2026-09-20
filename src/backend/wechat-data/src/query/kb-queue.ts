/**
 * 知识库「解析任务队列」与它的执行器（阶段 D · G-05）。
 *
 * ── 它存在的唯一理由：把「几秒的活」从 `@Remote` 的调用栈里挪走 ──────────
 * `registerKbFile` 是同步的（它是 `@Remote('addKbFiles')` 的实现），而 PDF / Word /
 * Excel 的解析要几百毫秒到几秒。同步做完的话，用户点「确定」后界面冻住，且 IPC 期间
 * **所有**其它接口一起被挡住 —— 计划 H4 的验收正是这条：「解析一份大 PDF 期间，
 * `listKbFiles` 仍在 200ms 内返回」。
 *
 * 于是 B 档只落一行 `parse_state='queued'`，真正解它的是这里。
 *
 * ── 状态机（四个态各自代表一件**已发生**的事，不是进度条刻度）────────────
 * ```
 *   queued ──claim──> parsing ──解析完──> chunking ──同事务──> ready
 *      │                 │                   │
 *      │                 └──── 读不动 ────> failed          （抛出：密码 / 不是那种格式 / 损坏）
 *      └── 抽不出文字 ──> unsupported                        （扫描件式 PDF、空工作簿）
 * ```
 *   · `parsing` 在 **claim 的那一刻**就写（而不是解析完才写）：否则「正在解析」这个
 *     用户看得见的状态永远不会出现，而崩溃恢复也就无从知道该救谁；
 *   · `chunking` 是**真的一段时间**（20MB 正文分块要几百毫秒），不是装饰；
 *   · `ready` 与它的 chunk 行**必须同事务**（`kb-files.ts` 不变量 ②）——
 *     所以 `ready` 这一步不是 UPDATE，见 `commitReady`。
 *
 * ── 为什么**没有** `embedding` 这一步 ─────────────────────────────────
 * 计划的推进序列里列了它，但本仓的向量是**提问时**按需建的（`buildKbVectorIndex`），
 * 且它是纯派生数据。把它塞进队列有两个坏处：① 登记文件变成依赖网络（嵌入要端点），
 * 断网时连登记都做不成；② 与 H7 冲突 —— 「无 Key / 断网仍可用」的前提正是
 * 「没有向量也算 ready，关键词照样搜得到」。所以执行器停在 `ready`，
 * `INTERRUPTED_STATES` 里仍然留着 `embedding`（别的路径将来要用，且让它保持
 * 「进程死了要救」的语义）。
 *
 * ── 不持有跨 `await` 的数据库句柄 ─────────────────────────────────────
 * 解析要几百毫秒到几秒，而 sqlite 的连接持有写锁。若把连接开着去解析，这期间用户
 * 删一个文件、切一次 RAG 开关，全都会撞在 `database is locked` 上 —— 表现为
 * 「点删除没反应」，和解析八竿子打不着，极难归因。所以每次读写都是
 * 「开 → 一条语句 → 关」，解析期间一个句柄都不留。
 *
 * ── 撞锁是可重试的，不是「这份文件坏了」────────────────────────────────
 * 上一条只挡得住**本进程**自己：`node:sqlite` 是同步 API，同一线程里的两条语句
 * 不可能真正交错（`gateway.ts` 里对这一点有 500 次交叉写的实测）。它挡不住
 * **别的进程**握着读锁 —— 而本库是 rollback journal，写侧要排他锁才能 `COMMIT`。
 *
 * 后果严重得不成比例：`runJob` 里这一步失败 = 「**已经解析成功**的正文被整份丢掉，
 * 该行判 `failed`」，用户得先把它从库里移掉、再重新添加才能恢复。真机实测这一格
 * 真的会走到（`working/cdp-kb-files-b.json` 里 `季度报告.pdf` 的
 * `parse_error = 'database is locked'`，而它同一轮的 `中文地层报告.pdf` 是 `ready`）。
 *
 * 所以每个写库步骤都包一层 `withBusyRetry` —— **只重试写，不重跑解析**：解析是
 * 几百毫秒到几秒的那一半，而争用窗口只有毫秒级。
 *
 * 为什么**不**用 `PRAGMA busy_timeout`：`node:sqlite` 是同步 API，忙等会把整个
 * worker 冻住（`search.ts` 里对同一个取舍有实测记录，那边也是「快速失败 + 让出事件循环」）。
 * 这里的等法是 `await sleep(...)`，与 `yieldToLoop()` 同一条纪律。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { KbFileParseState } from '../types.ts'
import { chunkBlocks } from './kb/chunk.ts'
import { parseFileByExtAsync } from './kb/parse-async.ts'
import { cellStr, composeParseNote, errorText, inTransaction, insertChunks, isBusyError, openStore } from './kb-files.ts'
import { kbBlobsDir, kbFilesDbPath } from './kb-paths.ts'
import { yieldToLoop } from './search.ts'

/**
 * 单轮扫描上限。
 *
 * 不是吞吐调优，而是**不让一次 SELECT 把上万行读进内存**：每轮重新查「下一行是谁」，
 * 所以新登记的文件在下一轮就会被看到（旗标 `rerun` 会在本轮结束时再跑一轮）。
 * 上限取 200 只是让这里的循环有一个明确的形状，正常库远到不了。
 */
const SCAN_LIMIT = 200

/** 日志前缀，与 `kb-files.ts` 保持同一种可 grep 的形状。 */
function warn(msg: string): void {
  console.warn('[kb-queue] ' + msg)
}

/**
 * 撞锁重试的次数与退避步长。
 *
 * 5 次 + 40ms 起步的线性退避 ⇒ 累计等到约 400ms。够长：对端的一次读事务是毫秒级
 * （真机上探针 5ms 一次的轮询就是最坏的那类对端）；又短到不会被用户察觉成卡住。
 */
const BUSY_ATTEMPTS = 5
const BUSY_BACKOFF_MS = 40

/** 让出事件循环等一会儿 —— **不许**写成同步忙等（`node:sqlite` 是同步的，忙等会冻住整个 worker）。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * 把「撞锁」这一类暂态失败重试掉，其他错误原样抛（该判死的还是要判死）。
 * @param label - 出问题时写进日志的步骤名（好区分是认领撞的锁还是落库撞的）。
 * @param fn - 一段同步的写库操作。重试的就是它，**不含**解析。
 * @returns fn 的返回值。
 */
async function withBusyRetry<T>(label: string, fn: () => T): Promise<T> {
  let last: unknown
  for (let i = 0; i < BUSY_ATTEMPTS; i += 1) {
    try {
      return fn()
    } catch (e) {
      if (!isBusyError(e)) throw e
      last = e
      if (i < BUSY_ATTEMPTS - 1) {
        warn(label + '：数据文件被占用，等 ' + String(BUSY_BACKOFF_MS * (i + 1)) + 'ms 再试（第 '
          + String(i + 2) + '/' + String(BUSY_ATTEMPTS) + ' 次）')
        await sleep(BUSY_BACKOFF_MS * (i + 1))
      }
    }
  }
  warn(label + '：重试 ' + String(BUSY_ATTEMPTS) + ' 次仍被占用，这一次放弃')
  throw last
}

/** 执行器需要的一行（只取它用得上的列）。 */
interface QueuedRow {
  id: number
  kbId: number
  name: string
  ext: string
  srcPath: string
  sha256: string
  blobName: string
}

/** 一次 drain 的结果。 */
export interface KbQueueReport {
  /** 本轮真正处理过的文件数。 */
  processed: number
  ready: number
  unsupported: number
  failed: number
  /**
   * 已有执行器在跑，本次**没有**另起一个（不是失败，也不需要调用方重试）：
   * 正在跑的那一个会在本轮结束时再跑一轮，因此一定看得到这次新入队的行。
   */
  skipped: boolean
}

/**
 * 正在跑的 drain（键 = 库文件路径）；值是「期间又有人要求跑一轮」的旗标。
 *
 * 为什么需要 `rerun` 而不是简单地「已在跑就忽略」：注册一个 PDF 时若恰有一个 drain
 * 在跑（用户在连着拖文件），被忽略的那次请求会让这一行**永远停在 `queued`** ——
 * 界面上是「等待解析」永远不动，只能重启应用。所以「忽略」必须配一面旗：
 * 跑着的那个在退出前会再扫一轮，把漏掉的行捡回来。
 */
const drains = new Map<string, { rerun: boolean }>()

/** 仅供用例清掉「正在跑」的进程内记忆。 */
export function resetQueueGuardForTest(): void {
  drains.clear()
}

/** 该数据根当下是否有执行器在跑（诊断与用例用）。 */
export function isQueueRunning(decryptedDir: string): boolean {
  return drains.has(kbFilesDbPath(decryptedDir))
}

/**
 * 认领下一个待解析的文件：把它从 `queued` 推进到 `parsing` 并返回它的元数据。
 *
 * 两步（先读后改）而不是一条 `UPDATE ... RETURNING`：`RETURNING` 拿到的是**改完之后**的行，
 * 而这里要的是「改之前就知道要解哪个文件」—— 顺序反了会先改状态再读字段，
 * 中间失败就留下一行没人认领的 `parsing`。
 *
 * 改状态时**带上 `parse_state = 'queued'` 这个条件**：万一有两个执行器同时看到同一行
 * （将来真加了第二个入口、或用户开了两个窗口），`changes === 0` 的那个会安静退让，
 * 而不是两份结果互相覆盖。
 * @param decryptedDir - 解密数据根。
 * @returns 认领到的行；没有待解析的（或被别人抢走）时为 null。
 */
function claimNext(decryptedDir: string): QueuedRow | null {
  const db: DatabaseSync = openStore(decryptedDir)
  try {
    const r = db.prepare(
      "SELECT id, kb_id, name, ext, src_path, sha256, blob_name FROM kb_files WHERE parse_state = 'queued' ORDER BY id LIMIT 1",
    ).get() as Record<string, unknown> | undefined
    if (r === undefined) return null
    const id = Number(r['id'] ?? 0)
    if (id <= 0) return null
    const res = db.prepare("UPDATE kb_files SET parse_state = 'parsing', updated_at = ? WHERE id = ? AND parse_state = 'queued'")
      .run(Date.now(), id)
    if (Number(res.changes ?? 0) === 0) return null
    return {
      id,
      kbId: Number(r['kb_id'] ?? 0),
      name: cellStr(r['name']),
      ext: cellStr(r['ext']),
      srcPath: cellStr(r['src_path']),
      sha256: cellStr(r['sha256']),
      blobName: cellStr(r['blob_name']),
    }
  } finally {
    try {
      db.close()
    } catch {
      /* 已关闭 */
    }
  }
}

/**
 * 取回这份文件的字节。
 *
 * 优先内容副本（blob）：登记之后原文件可能被改名 / 移动 / 删除，副本是登记那一刻的字节
 * （`kb-files.ts` 不变量 ①）。
 *
 * **副本不在时退回原文件，但必须核对指纹。** 退回是必要的：登记时副本写入可能失败
 * （磁盘满 / 权限），`parse_error` 里当时就告过警；不退回的话这份文件注定解析失败，
 * 而它此刻明明还躺在原处。核对指纹让这条回退**在可证的意义上是安全的**：
 * 内容一致才用，不一致就报错 —— 否则会用「用户改过之后的新内容」建索引、挂在旧登记行下，
 * 界面上一模一样，用户以为搜到的是当初上传的那一份。
 * @param decryptedDir - 解密数据根。
 * @param job - 认领到的行。
 * @returns 文件字节。
 */
function readJobBytes(decryptedDir: string, job: QueuedRow): Uint8Array {
  if (job.blobName !== '') {
    const blobPath = join(kbBlobsDir(decryptedDir), job.blobName)
    if (existsSync(blobPath)) return new Uint8Array(readFileSync(blobPath))
  }

  if (job.srcPath === '') throw new Error('内容副本与原始路径都已失效，请重新添加这个文件')
  let raw: Buffer
  try {
    raw = readFileSync(job.srcPath)
  } catch (e) {
    throw new Error('内容副本不在了，原文件也读不到（可能已被移动或删除）：' + errorText(e))
  }
  if (job.sha256 !== '') {
    const actual = createHash('sha256').update(raw).digest('hex')
    if (actual !== job.sha256) {
      throw new Error('内容副本不在了，而原文件的内容已经被改动过 —— 为避免把另一份内容当成这个文件，请重新添加')
    }
  }
  return new Uint8Array(raw)
}

/** 单条 UPDATE，失败**抛出**给调用方 —— 「重试」与「只留痕」的分工都在 `markState` 里。 */
function markStateOnce(
  decryptedDir: string,
  id: number,
  state: KbFileParseState,
  parser: string,
  note: string,
  chunkCount: number,
  charCount: number,
): void {
  const db: DatabaseSync = openStore(decryptedDir)
  try {
    db.prepare(
      'UPDATE kb_files SET parse_state = ?, parser = ?, parse_error = ?, chunk_count = ?, char_count = ?, updated_at = ? WHERE id = ?',
    ).run(state, parser, note, chunkCount, charCount, Date.now(), id)
  } finally {
    try {
      db.close()
    } catch {
      /* 已关闭 */
    }
  }
}

/**
 * 记状态：**宽容**（写不进去只留痕，不让「记账失败」盖掉真正的失败原因），但撞锁先重试。
 *
 * 两者不矛盾 —— 重试是针对「一会儿就好」的暂态，留痕是针对「真的写不进去」。
 * 而这里尤其不能一撞锁就放弃：留下的会是一行 `chunking`，那是「说在分块、其实永远
 * 分不完」的假状态，比报一句错更坏（用户看到的是一个永远不动的进度）。
 * @param decryptedDir - 解密数据根。
 * @param id - `kb_files` 行 id。
 * @param state - 要写的状态。
 * @param parser - 解析器名。
 * @param note - 解析说明。
 * @param chunkCount - 块数。
 * @param charCount - 字符数。
 */
async function markState(
  decryptedDir: string,
  id: number,
  state: KbFileParseState,
  parser: string,
  note: string,
  chunkCount: number,
  charCount: number,
): Promise<void> {
  try {
    await withBusyRetry(
      '状态写回（id=' + String(id) + ' → ' + state + '）',
      () => markStateOnce(decryptedDir, id, state, parser, note, chunkCount, charCount),
    )
  } catch (e) {
    warn('状态写回失败（id=' + id + ' → ' + state + '）：' + errorText(e))
  }
}

/**
 * `chunking → ready` 的那一步：写块行与状态，**同一个事务**（不变量 ②）。
 *
 * 不做「先删旧块」：能走到这里的行**不可能已经有块** —— `ready` 与它的块同事务，
 * 而所有会退回 `queued` 的中间态（`recoverInterrupted` 打回的 parsing / chunking /
 * embedding）都发生在那个事务**之前**。真加了删除反而会掩盖「有人绕过了这条路径」。
 *
 * 失败**向上抛**（与 `markState` 相反）：这一步写不进去就必须让调用方看见 ——
 * 吞掉它就会留下一行 `chunking`，那是「说在分块、其实永远分不完」的假状态。
 * @param decryptedDir - 解密数据根。
 * @param job - 认领到的行。
 * @param parser - 实际使用的解析器名。
 * @param note - 解析说明（截断 / 跳过的工作表等）。
 * @param truncated - 是否因超出 `MAX_CHUNKS_PER_FILE` 被截断。
 * @param blocks - 解析出的段。
 */
function commitReady(
  decryptedDir: string,
  job: QueuedRow,
  parser: string,
  note: string,
  truncated: boolean,
  blocks: Parameters<typeof chunkBlocks>[0],
): void {
  const chunked = chunkBlocks(blocks)
  const db: DatabaseSync = openStore(decryptedDir)
  try {
    inTransaction(db, () => {
      insertChunks(db, job.id, job.kbId, chunked.chunks)
      db.prepare(
        'UPDATE kb_files SET parse_state = ?, parser = ?, parse_error = ?, chunk_count = ?, char_count = ?, updated_at = ? WHERE id = ?',
      ).run('ready', parser, composeParseNote(note, truncated), chunked.chunkCount, chunked.charCount, Date.now(), job.id)
    })
  } finally {
    try {
      db.close()
    } catch {
      /* 已关闭 */
    }
  }
}

/** 一个文件的完整解析流程（已认领，状态是 `parsing`）。**不抛**。 */
async function runJob(decryptedDir: string, job: QueuedRow): Promise<'ready' | 'unsupported' | 'failed'> {
  let outcome: Awaited<ReturnType<typeof parseFileByExtAsync>>
  try {
    const bytes = readJobBytes(decryptedDir, job)
    outcome = await parseFileByExtAsync(job.ext, bytes)
  } catch (e) {
    await markState(decryptedDir, job.id, 'failed', '', errorText(e), 0, 0)
    return 'failed'
  }

  // 抽不出正文不是「读不动」：扫描件式的 PDF、没有任何单元格的工作簿都走这里。
  // 记 `unsupported` 而不是 `failed` —— 两者的用户动作不同（一个换文件、一个重装）。
  if (outcome.state !== 'ready') {
    await markState(decryptedDir, job.id, 'unsupported', outcome.parser, composeParseNote(outcome.note, false), 0, 0)
    return 'unsupported'
  }

  await markState(decryptedDir, job.id, 'chunking', outcome.parser, '', 0, 0)
  try {
    await withBusyRetry(
      '写入分块与就绪状态',
      () => commitReady(decryptedDir, job, outcome.parser, outcome.note, false, outcome.blocks),
    )
    return 'ready'
  } catch (e) {
    await markState(decryptedDir, job.id, 'failed', outcome.parser, errorText(e), 0, 0)
    return 'failed'
  }
}

/**
 * 把队列里所有 `queued` 的文件解完。
 *
 * **重复调用是安全的**：已在跑时只挂一面旗并返回 `skipped: true`（见 `drains` 的说明）。
 *
 * 调用点只有两个，都在 `gateway.ts`：启动时扫一次（把上个进程留下的行捡回来），
 * 以及 `addKbFiles` 真正入队了 B 档文件时。存储层不触发它 —— 那会让 `kb-files.ts`
 * 反向依赖本模块，而「谁在什么时候启动后台活」本来就该在网关那一层一眼看全。
 * @param decryptedDir - 解密数据根。
 * @returns 本轮的处理统计。
 */
export async function drainKbQueue(decryptedDir: string): Promise<KbQueueReport> {
  const key = kbFilesDbPath(decryptedDir)
  const running = drains.get(key)
  if (running !== undefined) {
    running.rerun = true
    return { processed: 0, ready: 0, unsupported: 0, failed: 0, skipped: true }
  }

  const state = { rerun: false }
  drains.set(key, state)
  const report: KbQueueReport = { processed: 0, ready: 0, unsupported: 0, failed: 0, skipped: false }
  try {
    do {
      state.rerun = false
      for (let i = 0; i < SCAN_LIMIT; i += 1) {
        const job = await withBusyRetry('认领下一份', () => claimNext(decryptedDir))
        if (job === null) break
        report.processed += 1
        const st = await runJob(decryptedDir, job)
        if (st === 'ready') report.ready += 1
        else if (st === 'unsupported') report.unsupported += 1
        else report.failed += 1
        // 每个文件之间让出事件循环：不留这一步，连着解几十份 PDF 时
        // 「claim → 解析 → 落库」的循环之间没有任何间隙，界面会一顿一顿的。
        await yieldToLoop()
      }
    } while (state.rerun)
    return report
  } finally {
    drains.delete(key)
  }
}
