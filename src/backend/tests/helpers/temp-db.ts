/**
 * 临时库夹具（N26）：一个共享助手，把「建临时目录 + 开库 + 用完关干净 + 删目录」收口。
 *
 * ## 实测出来的病因（与 N26 条目原文的推测**不一致**，先看这一段）
 *
 * 条目推测：`DatabaseSync.close()` 是 close_v2 语义，未 finalize 的语句句柄滞留到 GC，
 * 于是 Windows 上 `rmSync` 偶发 `EPERM`，所以「每个语句显式 finalize」或「重试即可」。
 * 本机（Node 24.20.0 / win32）实测：
 *   · `close()` **会** finalize 语句 —— `close()` 之后再 `stmt.all()` 报
 *     `statement has been finalized`；且 `StatementSync` 上根本没有公开的 `finalize()`。
 *     语句句柄因此**不是**病因，「每个语句显式 finalize」这条路在这版 Node 上不存在；
 *   · 真正的病因是**连接没关**：同一个进程里只要有一条 `DatabaseSync` 还开着，
 *     `rmSync(dir, { recursive: true, force: true })` 就**确定性地**报 `EPERM`
 *     （`force` 只忽略 ENOENT，不忽略 EPERM），而且**重试救不了**（连试 3 次仍 EPERM，
 *     句柄全程有效）；
 *   · 所以「偶发」的来源不是 GC 时序，而是**代码路径有没有走到 close**：
 *     断言失败提前返回、`try/catch` 的 catch 分支忘了 close、一个夹具开两条连接只关一条、
 *     实测都能稳定复现残留（本仓 %TEMP% 里成堆的 `wx-n10-*` / `wx-n14-*` 即此）。
 *
 * 由此定了本助手的两条主线（**先关闭，再重试**，顺序不能反）：
 *   ① **连接登记册**（模块级）：凡经本助手打开的库都记下来，收尾时无条件逐个关闭 ——
 *      测试代码即使忘了 close（或 assert 抛错跳过了 close），目录照样能删掉；
 *   ② **带退避的重试**只做兜底：给「别的进程/杀毒/索引器短暂占着」这类真·瞬态留余地。
 *      它**不是**在补「忘了 close」的窟窿（那种情况下重试无效，只会把垃圾推给下一个人）。
 *      重试用尽仍删不掉时，`RemoveResult.ok === false` 会把 **哪个目录、哪个错误码** 说出来，
 *      而不是静默留一堆残留。
 *
 * ## 为什么目录前缀保持 `wx-`
 *
 * 「%TEMP% 里不再新增 `wx-*` 残留」是 N26 的验收口径，前缀保持一致，验收才可比。
 *
 * @module tests/helpers/tmp-db
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/** 临时目录前缀（N26 验收口径：`%TEMP%\wx-*`）。 */
export const TEMP_DIR_PREFIX = 'wx-'

/** 默认重试参数：8 次 × 25ms ≈ 最长 200ms，够兜瞬态，又不会拖慢用例。 */
const DEFAULT_ATTEMPTS = 8
const DEFAULT_DELAY_MS = 25

/** 打开连接的可选项（只暴露用得到的两个，避免跟着 Node 类型版本漂）。 */
export interface OpenDbOptions {
  readOnly?: boolean
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * 模块级登记册：经本助手打开、尚未关闭的连接。
 *
 * 为什么要模块级而不是挂在每个工作区上：真实用例里连接常常**按路径**开在辅助函数里
 * （例如某个 `oracleStatus(dec)` 只拿到目录字符串），拿不到工作区句柄。登记册按「谁开的」
 * 收口，才能兜住「辅助函数里提前 return 忘了 close」这类最隐蔽的漏法。
 */
const REGISTRY = new Set<DatabaseSync>()

/**
 * 打开一个库并登记在册（调用方**不需要**自己 close）。
 * @param file - 数据库文件路径（只读时文件必须已存在）。
 * @param opts - `{ readOnly }`。
 * @returns 连接。
 */
export function openTrackedDb(file: string, opts: OpenDbOptions = {}): DatabaseSync {
  const conn = new DatabaseSync(file, opts.readOnly ? { readOnly: true } : {})
  REGISTRY.add(conn)
  return conn
}

/**
 * 关闭登记册里的全部连接。
 *
 * 幂等：已关闭的连接（`isOpen === false`）跳过，重复调用返回 0。
 * @returns 本次真正关闭的条数。
 */
export function closeAllTrackedDbs(): number {
  let closed = 0
  for (const conn of REGISTRY) {
    try {
      if (conn.isOpen) { conn.close(); closed += 1 }
    } catch {
      /* 连接已失效：收尾阶段不因它变红（真正该关心的是目录删不掉） */
    }
  }
  REGISTRY.clear()
  return closed
}

/** 删除结果：失败时必须能说出「哪个目录 + 什么错」，这是把残留变成可追查的前提。 */
export interface RemoveResult {
  /** 目录已不存在（含「本来就不存在」）。 */
  ok: boolean
  attempts: number
  /** 最后一次失败的 `err.code`（成功时 undefined）。 */
  code?: string
}

/** 可注入的缝合点：单测用假的删除实现确定性地验证「退避重试」本身。 */
export interface RemoveOptions {
  attempts?: number
  delayMs?: number
  /** 注入的删除实现，默认 `fs.rmSync(dir, { recursive: true, force: true })`。 */
  rm?: (dir: string) => void
  /** 等待实现，默认 `setTimeout`（单测可注入即时版本）。 */
  wait?: (ms: number) => Promise<void>
}

/**
 * 删除目录，带**有界**退避重试。
 *
 * 只对 `EPERM`/`EBUSY`/`ENOTEMPTY` 这类「有别人占着」的错误码重试；其余错误码直接结算
 * （目录名写错、权限策略禁止等，重试一万次也不会变好）。
 *
 * 每次失败之间会调一次 `globalThis.gc?.()`：它只在 `--expose-gc` 下存在，是给
 * 「句柄悬在一个已不可达的连接上、等 GC 回收」留的一线机会，**不作为正确性依赖**。
 *
 * @param dir - 待删目录。
 * @param opts - 重试次数/间隔/注入的删除实现。
 * @returns 删除结果（失败时 `code` 是最后一次的错误码）。
 */
export async function removeDirWithRetry(dir: string, opts: RemoveOptions = {}): Promise<RemoveResult> {
  const attempts = Math.max(1, opts.attempts ?? DEFAULT_ATTEMPTS)
  const delayMs = Math.max(0, opts.delayMs ?? DEFAULT_DELAY_MS)
  const wait = opts.wait ?? sleep
  const rm = opts.rm ?? ((d: string): void => { rmSync(d, { recursive: true, force: true }) })
  let code: string | undefined
  for (let i = 1; i <= attempts; i += 1) {
    try {
      rm(dir)
      return { ok: true, attempts: i }
    } catch (err) {
      code = (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN'
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'ENOTEMPTY') return { ok: false, attempts: i, code }
      if (i === attempts) break
      // 见模块头：这是最后一线机会，不是正确性依赖（正常路径由连接登记册保证）
      ;(globalThis as { gc?: () => void }).gc?.()
      await wait(delayMs)
    }
  }
  return { ok: false, attempts, code }
}

/** 一处临时工作区：一个临时目录 + 用它可以开库/删库。 */
export interface TempWorkspace {
  /** 临时目录绝对路径。 */
  readonly dir: string
  /** 目录内的路径（`decrypted/wechat_rag_vectors.db` 这类嵌套路径也可以传）。 */
  path(rel: string): string
  /** 打开（必要时创建）目录内的一个库，并登记在册 —— 不需要调用方记得 close。 */
  db(rel: string, opts?: OpenDbOptions): DatabaseSync
  /** 关闭登记册里全部连接，返回成功关闭的条数（见 `closeAllTrackedDbs` 的幂等说明）。 */
  closeAll(): number
  /** 幂等收尾：先关连接，再删目录（带退避重试）。 */
  cleanup(opts?: RemoveOptions): Promise<RemoveResult>
}

/** 把标签清洗成安全的目录名片段（用例里常传 `wx-n10` 这种带连字符的）。 */
function sanitizeTag(tag: string): string {
  const cleaned = String(tag).replace(/[^A-Za-z0-9_-]/g, '')
  return cleaned || 'tmp'
}

/**
 * 建一个临时工作区。
 * @param tag - 目录名标签（会清洗；最终形如 `wx-<tag>-XXXXXX`）。
 * @returns 工作区句柄（用完调 `cleanup()`；或用 `withTempWorkspace` 自动收尾）。
 */
export function createTempWorkspace(tag: string): TempWorkspace {
  const dir = mkdtempSync(join(tmpdir(), `${TEMP_DIR_PREFIX}${sanitizeTag(tag)}-`))
  const path = (rel: string): string => join(dir, rel)
  return {
    dir,
    path,
    db: (rel, opts) => openTrackedDb(path(rel), opts),
    closeAll: () => closeAllTrackedDbs(),
    async cleanup(opts) {
      closeAllTrackedDbs()
      return removeDirWithRetry(dir, opts)
    },
  }
}

/**
 * 建临时工作区 → 跑用例 → **无论成败**都关连接并删目录。
 *
 * 为什么用 `finally` 收尾而不是 `afterEach`：`afterEach` 在「用例中途抛错」时仍会跑，
 * 但**前一个 afterEach 抛错/超时**就会打破这条链；`finally` 把收尾和用例体绑在同一个栈上，
 * 是最不容易漏的那一种写法。
 *
 * @param tag - 目录名标签。
 * @param fn - 用例体，收到工作区句柄。
 * @returns `fn` 的返回值。
 * @throws 用例体抛出的异常照原样抛出（收尾失败只记录，不掩盖原始失败）。
 */
export async function withTempWorkspace<T>(
  tag: string,
  fn: (ws: TempWorkspace) => Promise<T> | T,
): Promise<T> {
  const ws = createTempWorkspace(tag)
  try {
    return await fn(ws)
  } finally {
    const r = await ws.cleanup()
    if (!r.ok) {
      // 不 throw：最常见的调用方是「用例本来就失败了」的路径，抛出去会盖掉真正的病因。
      // 但必须留下可追查的痕迹 —— 静默残留正是 N26 最想消灭的东西。
      console.warn(`[tmp-db] 临时目录未能删除（${r.code ?? '?'}，试了 ${r.attempts} 次）：${ws.dir}`)
    }
  }
}
