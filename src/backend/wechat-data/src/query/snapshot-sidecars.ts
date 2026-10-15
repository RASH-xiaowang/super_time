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
 * ## 为什么可以放心丢
 *
 * 快照里的写者只有两处（懒补排序索引 `message-sort-index.ts`、编辑消息 `edit.ts`），
 * 两者都是**全同步**函数：从拿连接到 `close()` 之间没有任何 await，因此不可能横跨发布路径的
 * await 还活着 —— 发布/启动清理这一刻旁文件里的帧**一定**来自一次没干净收尾的会话
 * （进程被杀、或关连接失败）。干净收尾时 SQLite 会 checkpoint 进主文件并删掉 `-wal`，
 * 所以丢掉它的损失上限是「一次没来得及 checkpoint 的提交」；不丢，赔上的是整个库读不了。
 * （前提是同一个人数据根只有一个后端进程 —— Electron 单实例锁 + 开发版/安装版各自
 * userData 已保证这一点。）
 *
 * ## 丢不掉怎么办
 *
 * Windows 上读者正持有 `-wal` 时 unlink 直接 EBUSY（实测），所以发布路径**宁可不发布**
 * （见 `sync.ts#atomicReplace`）：被挡住的代价是这一轮快照没更新（下一轮重试），
 * 而不是把一份读不了的快照发出去。`-shm` 只是 wal-index 缓存，留着不会让那些帧生效
 * （WAL 的盐一变，SQLite 自己会重建它），所以它清不掉不拦发布。
 *
 * @module query/snapshot-sidecars
 */
import { statSync } from 'node:fs'
import { copyFile, open, readdir, stat, unlink, type FileHandle } from 'node:fs/promises'
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
 * 丢掉**上一代**的 `-wal`（顺手清 `-shm`）。
 * @param target - 快照主文件路径。
 * @returns 是否仍有非空 `-wal` 挡着换代（true = 还没清掉）。
 */
export async function discardSupersededWal(target: string): Promise<boolean> {
  if (strayWalBlocks(target)) {
    try { await unlink(target + '-wal') } catch { /* 读者占用：交给调用方的重试 */ }
  }
  if (strayWalBlocks(target)) return true
  try { await unlink(target + '-shm') } catch { /* 占用或本来就没有：无害 */ }
  return false
}

/**
 * 扫掉上一次中断留下的旁文件/半成品：`.stage_src`/`.stage_wal`/`.decrypt_tmp`
 * 与**非空 `-wal`**（顺手清 `-shm`）。真正的解密产物一个都不匹配。
 *
 * 为什么启动时顺手清 WAL：它的成因是一次没干净收尾的会话（见模块头），而启动这一刻本进程
 * 还没读过任何快照 ⇒ 白捡一次自愈。不清的话，那个库要等到它**下一次换代**才恢复
 * —— 常年不改的分片就一直读不了。
 * @param root - 解密快照根目录。
 */
export async function cleanStaleSnapshotLeftovers(root: string): Promise<void> {
  const suffixes = ['.stage_src', '.stage_wal', '.decrypt_tmp']
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
        if (!suffixes.some(s => entry.name.endsWith(s)) && !isWal && !entry.name.endsWith('.db-shm')) continue
        if (isWal) {
          // ≤32B 的空 WAL 只是个头（SQLite 本来就不认它有帧，读路径自己也会建出来）。
          let size = 0
          try { size = (await stat(p)).size } catch { /* 刚被别处删掉 */ }
          if (size <= WAL_HEADER_SZ) continue
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
