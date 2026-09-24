/**
 * 「本机基线」—— 同一个测试文件在**这台机器、串行口径**下要跑多久。
 *
 * ## 为什么需要它
 *
 * N36 的口径 ① 要的是「**(A) 类**榜首中位 ≤15 秒」，而 `npm run ci:board-history` 拿到的
 * 只有 CI 的数。同一份代码在本机与 CI 上的比（倍率）是**分类的唯一依据**：
 * 本机 3.7 秒的文件在 CI 上 15 秒是「活真多」，本机 0.7 秒的文件在 CI 上 17 秒就得怀疑是机器停顿。
 * 问题是倍率本身就分不出两类 —— 2026-09-24 实测：`kb-files-store` 本机 834ms / CI 10.0s（×12），
 * `gateway-export-stream-progress` 本机 711ms / CI 8.6~35.8s（×12~50）—— 同一个数量级里
 * 既有真活也有停顿。所以基线不是「锦上添花」，它是 ① 能不能算出来的前提。
 *
 * ## 为什么必须串行量
 *
 * CI 的 `maxWorkers: 1`（见 `vitest.config.ts`）。本机并行跑出来的数与它**不可比** ——
 * 同一个文件并行 2.4 秒、串行 586 毫秒（见记忆里那条 ㊳）。所以生成基线的那个脚本写死串行，
 * 这份产物也把自己的量法记在 `mode` 字段里，读的人不用猜。
 *
 * @module tests/helpers/local-baseline
 */

import { at } from './strict-index.ts'

/** 基线产物的形状。`mode` 只有 `'serial'` 一种合法值 —— 别的口径与 CI 不可比。 */
export interface LocalBaseline {
  /** 量它的时候的提交（短 sha）。没有它就无法回答「这份基线是改动前还是改动后」。 */
  headSha: string
  /** ISO 时间。 */
  measuredAt: string
  /** 量法。只认 `'serial'`。 */
  mode: string
  /** 文件名（仓库相对路径，与 CI 榜上的路径同一口径）→ 毫秒。 */
  files: Record<string, number>
}

/** 只有这一种量法与 CI 可比（CI 是 `maxWorkers: 1`）。产物的 `mode` 不等于它就不该被读。 */
export const SAFE_MODE = 'serial'

/**
 * 校验一份基线读起来可不可信。
 *
 * 返回问题清单（空 = 可信）。为什么不抛错：这份产物是**判据的输入**，判据要能在数据坏掉时
 * 明说「我判不了」，而不是让整条命令 stack trace 退出。
 * @param raw - 从 JSON 里读出来的任意对象。
 * @returns 每一条问题的说明。
 */
export function baselineProblems(raw: unknown): string[] {
  const out: string[] = []
  if (typeof raw !== 'object' || raw === null) return ['基线文件不是一份对象 —— 读不了。']
  const b = raw as Partial<LocalBaseline>
  if (b.mode !== SAFE_MODE) out.push(`量法是 ${String(b.mode)}，而 CI 是 maxWorkers: 1 ⇒ 只有串行口径可比。`)
  if (typeof b.headSha !== 'string' || b.headSha.length < 7) out.push('缺 headSha（或太短）—— 无法说明这份基线是改动前还是改动后量的。')
  if (typeof b.measuredAt !== 'string' || Number.isNaN(Date.parse(b.measuredAt))) out.push('measuredAt 不是可读的时间 —— 无法判断基线旧到什么程度。')
  const files = b.files
  if (typeof files !== 'object' || files === null) { out.push('没有 files 这张表。'); return out }
  const entries = Object.entries(files)
  if (entries.length < 50) out.push(`只记了 ${String(entries.length)} 个文件 —— 全量套件有 230 多个，多半是中途失败产生的半份产物。`)
  for (const [name, ms] of entries) {
    if (!/\.spec\.[cm]?[jt]sx?$/.test(name)) { out.push(`键不像测试文件路径：${name}`); continue }
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) out.push(`${name} 的毫秒数不可用：${String(ms)}`)
  }
  if (entries.some(([, ms]) => typeof ms === 'number' && ms >= 1000) === false) {
    out.push('一个 ≥1 秒的文件都没有 —— 八成是读错了字段（全 0 的基线比没有基线更坏：它会让每个文件都看着像「本机很快」。）')
  }
  return out
}

/**
 * 查一个文件在基线里的毫秒数。
 * @param b - 已校验过的基线。
 * @param file - CI 榜上的文件路径。
 * @returns 毫秒；**没量到时返回 `null`**（不是 0 —— 0 会让倍率变成除零或「本机零秒」）。
 */
export function baselineMs(b: LocalBaseline, file: string): number | null {
  const usable = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
  const exact = b.files[file]
  if (usable(exact)) return exact
  // CI 榜上的路径与本机的记录偶尔会差一层目录（比如重命名过目录）。
  // 只在「同名且只有一条可用的」时才认这一层宽松匹配；两条以上就没法选，宁可返回 null 让调用方明说。
  const base = file.split('/').pop() ?? file
  const sameName = Object.entries(b.files).filter(([k, v]) => usable(v) && (k.split('/').pop() ?? k) === base)
  return sameName.length === 1 ? at(sameName, 0, '同名基线条目')[1] : null
}

/** 一条基线记录里的文件数。 */
export function baselineCount(b: LocalBaseline): number {
  return Object.keys(b.files).length
}

/** 一个文件按「本机基线 + CI 读数」分到的类。`unknown` = 基线里没有它。 */
export type FileClass = 'A' | 'B' | 'unknown'

/** 本机就要跑这么久的，时间确有出处 —— 归 A（真活）。 */
export const A_LOCAL_MS = 1000

/**
 * 本机几乎不花时间、CI 却要慢这么多倍 ⇒ 归 B（机器停顿）。
 *
 * 为什么是 20：2026-09-24 实测的两种病各自落在 `5.5~11 倍`（真活被慢机器放大）与
 * `450~1537 倍`（本机几十毫秒、CI 几十秒）两端，中间最密的一簇是 ×12~×28
 * （`kb-files-store` 834ms→10.0s 是 ×12）。取 20 是把「放大后仍然算真活」的那一侧
 * 全划进 A —— 也就是说这条线**偏保守**：被误判成 A 的只会是倍率刚好过线的文件，
 * 而被漏判成 B 的（本来是慢代码）不会发生。线本身是工程选择，不是量出来的常数。
 */
export const B_RATIO = 20

/**
 * 分一个文件属于 A 还是 B。
 * @param localMs - 基线里的本机毫秒（`null` = 没量到）。
 * @param ciMs - 某次 CI 运行里这个文件的毫秒数。
 * @returns `'A'` / `'B'` / `'unknown'`。
 */
export function classifyFile(localMs: number | null, ciMs: number): FileClass {
  if (localMs === null || !Number.isFinite(localMs) || localMs < 0) return 'unknown'
  if (localMs >= A_LOCAL_MS) return 'A'
  return ciMs / Math.max(1, localMs) >= B_RATIO ? 'B' : 'A'
}
