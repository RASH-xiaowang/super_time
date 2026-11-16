/**
 * 解密快照的**旁文件纪律**：`-wal` / `-shm` 的换代与清理。
 *
 * ## 为什么单独一个模块
 *
 * `sync.ts` 已贴着本仓「单文件 1000 行」的硬上限（`sync-source-state-wiring.spec.ts`
 * 守着），而这条纪律的**证据链**（真机读数、为什么可以放心丢、丢不掉怎么办）本身就要写下来
 * 才算数。它的两个消费方都在这份模块之外：发布路径（`sync.ts#atomicReplace`）与修复路径
 * （`db-repair.ts` 的「本地清残留」）。所以：判据只有一份实现，注释与实测数字只留一处。
 *
 * ## 真机现场（2026-10-13，`decrypted/message/message_0.db`）
 *
 * 主文件一个字节都没坏，旁边却躺着一份 **795 帧 / 3.2MB 的上一代 WAL**：
 *   · 主文件 + 残留 WAL ⇒ `PRAGMA page_count` = 20054、`integrity_check` 报
 *     `Tree 29 page 10978 cell 466: 2nd reference to page 19803` / `Rowid … out of order`，
 *     界面上就是那条 `database disk image is malformed`；
 *   · **同一个主文件**、只把 `-wal` 拿走 ⇒ `page_count` = 19930、`integrity_check` = ok。
 *
 * 成因：SQLite 应用 WAL **不校验它属于哪个主文件** —— 只要 `-wal` 里有一套自洽的帧
 * （头盐与帧盐一致、校验和连得上），打开主文件时就会把那些页盖上去。而本仓的发布是
 * 「整文件 rename」（`sync.ts#atomicReplace`）：新一代主文件是**完整**的一代
 * （原始库 + 原始 WAL 帧都已合进去），上一代的 `-wal` 对它就是**另一个库的页**。
 *
 * ## 为什么改成「隔离」而不是「删除」
 *
 * 曾经的口径是「启动/换代时无条件删掉非空 `-wal`」，理由是快照里的写者只有两处
 * （懒补排序索引 `message-sort-index.ts`、编辑消息 `edit.ts`），两者都是**全同步**函数，
 * 不可能横跨发布路径的 await 还活着 —— 旁文件里的帧一定来自一次没干净收尾的会话。
 *
 * 真机教训推翻了这个「放心丢」：进程若在**写入/checkpoint 中途**被杀，主文件本身可能
 * 已经撕裂，而 `-wal` 里正是尚未落进主文件的页。先删 WAL 就等于把「还能自愈」的状态
 * 变成永久的 `database disk image is malformed`。所以现在：
 *   · 换代时把旧 `-wal` **rename** 到 `<target>.superseded-wal`（可回滚、可隔离），
 *     不再先删（见 {@link discardSupersededWal} / {@link restoreSupersededWal}）；
 *   · 启动清理只删空 WAL（≤32B，无帧）、`-shm` 与真正的一次性 staging 文件，
 *     非空 `-wal` 留给 `snapshot-reconcile.ts` 在快照目录内做 quick_check + checkpoint。
 *
 * ## 挡着换代怎么办
 *
 * Windows 上读者正持有 `-wal` 时 unlink/rename 都会失败（实测），所以发布路径**宁可不发布**
 * （见 `sync.ts#atomicReplace`）：被挡住的代价是这一轮快照没更新（下一轮重试），
 * 而不是把一份读不了的快照发出去；调用方彻底放弃这一轮时可用
 * {@link restoreSupersededWal} 把隔离的 WAL 放回原位。`-shm` 只是 wal-index 缓存，
 * 留着不会让那些帧生效（WAL 的盐一变，SQLite 自己会重建它），所以清不掉不拦发布。
 *
 * @module query/snapshot-sidecars
 */
import { statSync } from 'node:fs'
import { copyFile, open, readdir, rename, stat, unlink, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'

/** staging 拷贝/打开的重试次数与间隔（真机 EBUSY 实测，见 stageCopyRetry 头注）。 */
export const STAGE_COPY_ATTEMPTS = 3
export const STAGE_COPY_RETRY_DELAY_MS = 150

/** 测试注入点：缺省走真 copyFile / 真 sleep。 */
export interface StageCopyDeps {
  copy?: (src: string, dst: string) => Promise<void>
  sleep?: (ms: number) => Promise<void>
}

/**
 * 带**有界重试**的 staging 打开（与 stageCopyRetry 同一根因：刚被写过的
 * staging 文件会被 Defender/索引器瞬时独占，实测 `open stage_wal 'r+'` 撞
 * `EBUSY` —— 一撞就 10s 退避）。重试口径同 stageCopyRetry。
 * @param path - 要打开的文件。
 * @param flags - open 标志（'r' / 'w' / 'r+'）。
 * @param deps - 测试注入点（缺省走真 open / 真 sleep）。
 */
export async function stageOpenRetry(path: string, flags: string, deps?: { open?: (p: string, f: string) => Promise<FileHandle>; sleep?: (ms: number) => Promise<void> }): Promise<FileHandle> {
  const openFn = deps?.open ?? open
  const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= STAGE_COPY_ATTEMPTS; attempt += 1) {
    try {
      return await openFn(path, flags)
    } catch (e) {
      lastErr = e
      if (attempt < STAGE_COPY_ATTEMPTS) await sleep(STAGE_COPY_RETRY_DELAY_MS)
    }
  }
  throw lastErr
}

/**
 * 带**有界重试**的 staging 拷贝（2026-10-13，真机 EBUSY 实测）。
 *
 * 真机 75 秒观察（`.tmp-e2e/sync-live-observe.mjs`）抓到两次
 * `EBUSY: copyfile '<decrypted>/message_0.db' -> '...stage_src'`：staging 拷贝
 * 要复制的**解密快照**此刻正被在途查询的连接握着（worker 单线程上，同步节拍与
 * 查询在 await 之间交错 —— 这正是 yieldToLoop 让出事件循环的代价）。旧路径一撞
 * 上就 `noteSyncFailure` 退避 10s：一次毫秒级的握手竞争，赔上 10 秒的新鲜度。
 * 查询连接毫秒内就会 close，所以**重试 3 次 × 150ms** 足以吞掉绝大多数这类竞争；
 * 真撞上持续占用（读者一直不退）才走退避，退避口径不变。
 * @param src - 源文件（快照目标或原始库文件）。
 * @param dst - staging 路径。
 * @param deps - 测试注入点。
 */
export async function stageCopyRetry(src: string, dst: string, deps: StageCopyDeps = {}): Promise<void> {
  const copy = deps.copy ?? copyFile
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms) }))
  let lastErr: unknown = null
  for (let attempt = 1; attempt <= STAGE_COPY_ATTEMPTS; attempt += 1) {
    try {
      await copy(src, dst)
      return
    } catch (e) {
      lastErr = e
      if (attempt < STAGE_COPY_ATTEMPTS) await sleep(STAGE_COPY_RETRY_DELAY_MS)
    }
  }
  throw lastErr
}

/** `-wal` 头长度：≤32B 的 WAL 只有个头，SQLite 当它没有帧（无害）。 */
const WAL_HEADER_SZ = 32

/**
 * 目标旁边是否躺着一个**非空** `-wal`。
 *
 * 同步实现（不是懒）：判据与紧随其后的 `unlink` 必须同拍，异步化只会把「判完到动手之间」
 * 那个窗口拉长 —— 而窗口里正好可能来一次读者。
 * @param target - 快照主文件路径。
 * @returns true = 有帧，换代前必须处理掉。
 */
export function strayWalBlocks(target: string): boolean {
  try {
    return statSync(target + '-wal').size > WAL_HEADER_SZ
  } catch {
    return false
  }
}

/**
 * 把**上一代**的 `-wal` 挪到隔离位（`<target>.superseded-wal`），而不是直接删除。
 *
 * 为什么改成 rename：主文件可能在上一次进程写入/checkpoint 中途被杀而撕裂，`-wal` 里
 * 正是尚未落进主文件的页 —— 先删 WAL 会把「还能自愈」变成永久
 * `database disk image is malformed`。隔离后主文件仍是旧代；读者占用时 rename 同样会失败，
 * 所以保留原有判据：挡着就返回 true、由调用方重试。彻底放弃换代时，调用方可用
 * {@link restoreSupersededWal} 把它放回去。
 * @param target - 快照主文件路径。
 * @returns 是否仍有非空 `-wal` 挡着换代（true = 还没挪走）。
 */
export async function discardSupersededWal(target: string): Promise<boolean> {
  if (strayWalBlocks(target)) {
    // 同名隔离位可能是更早一轮留下的：先尽力清掉，给这次 rename 让位。
    try { await unlink(target + '.superseded-wal') } catch { /* 不存在或被占用：下面 rename 会给出结论 */ }
    try {
      await rename(target + '-wal', target + '.superseded-wal')
    } catch { /* 读者占用等：由下面的判据决定是否让调用方重试 */ }
  }
  if (strayWalBlocks(target)) return true
  try { await unlink(target + '-shm') } catch { /* 占用或本来就没有：无害 */ }
  return false
}

/**
 * 把隔离的上一代 WAL 放回原位（换代彻底失败时的回滚口）。
 *
 * 只在目标位置没有**非空** `-wal` 时动手：新 WAL 一旦有帧就代表新一代已经开始写，
 * 覆盖回去只会制造第二个「配错主文件」的现场。空壳 `-wal`（≤32B、无帧）先删掉再 rename
 * （Windows 的 rename 不允许覆盖已存在的文件）。整体 best-effort，不抛错 ——
 * 回滚失败不该掩盖调用方的原始错误。
 * @param target - 快照主文件路径。
 */
export async function restoreSupersededWal(target: string): Promise<void> {
  const stash = target + '.superseded-wal'
  try {
    if (strayWalBlocks(target)) return
    try { await unlink(target + '-wal') } catch { /* 空壳或不存在 */ }
    await rename(stash, target + '-wal')
  } catch { /* 隔离位不存在 / 被占用：回滚是尽力而为 */ }
}

/**
 * 删除隔离位（`<target>.superseded-wal` / `<target>.superseded-shm`），best-effort。
 *
 * 用在确认新快照已稳定、上一代不再需要回滚之后；当前由对账/维护路径按需调用。
 * @param target - 快照主文件路径。
 */
export async function clearSupersededWal(target: string): Promise<void> {
  try { await unlink(target + '.superseded-wal') } catch { /* 不存在或被占用 */ }
  try { await unlink(target + '.superseded-shm') } catch { /* 不存在或被占用 */ }
}

/**
 * 扫掉上一次中断留下的旁文件/半成品：`.stage_src`/`.stage_wal`/`.decrypt_tmp`/
 * `.decrypt_src`/`.decrypt_wal`、**≤32B 的空 `-wal`** 与所有 `-shm`。
 * 真正的解密产物一个都不匹配。
 *
 * **非空 `-wal` 一律保留**：它可能是主文件撕裂时唯一能自愈的页来源（见模块头），
 * 交给 `snapshot-reconcile.ts` 做 quick_check + checkpoint / 隔离。
 * `.superseded-wal` 同样不在这里删 —— 它是换代时的回滚位，由对账路径负责隔离或
 * `clearSupersededWal` 在确认稳定后清理。
 * @param root - 解密快照根目录。
 */
export async function cleanStaleSnapshotLeftovers(root: string): Promise<void> {
  const suffixes = ['.stage_src', '.stage_wal', '.decrypt_tmp', '.decrypt_src', '.decrypt_wal']
  async function walk(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) {
          await walk(p)
          continue
        }
        const isWal = entry.name.endsWith('.db-wal')
        const isShm = entry.name.endsWith('.db-shm')
        if (!suffixes.some(s => entry.name.endsWith(s)) && !isWal && !isShm) continue
        if (isWal) {
          // ≤32B 的空 WAL 只是个头（SQLite 本来就不认它有帧，读路径自己也会建出来）。
          // 非空 WAL 里可能有主文件缺失的页 —— 这里绝不删，留给 reconcile。
          let size = 0
          try { size = (await stat(p)).size } catch { /* 刚被别处删掉 */ }
          if (size > WAL_HEADER_SZ) continue
        }
        try {
          await unlink(p)
        } catch {
          /* best-effort sweep */
        }
      }
    } catch {
      return
    }
  }
  await walk(root)
}
