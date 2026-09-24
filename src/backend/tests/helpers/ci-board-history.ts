/**
 * 「最近若干次 CI 运行的耗时榜历史」—— 纯解析与汇总，被 `scripts/ci-board-history.mjs` 使用。
 *
 * ## 为什么需要它
 *
 * N36 的验收口径原本是「最大单文件 ≤30 秒」，2026-09-24 被事实改成
 * 「**最慢文件的距线倍数 ≥ 4×**」，同一天又被第二件事改了第二次：同一个提交（#98 的 `d5d1808`）
 * 两次运行给出的榜首分别是 **104.5 秒**与 **20.8 秒** —— 也就是说**一张绿榜不构成验收**，
 * 要看的是**若干次运行里的最差值**。而「最差值」如果不落到一个能一条命令查出来的东西上，
 * 就等于没有这条判据（本仓库为此已经加过 N37/N38 那两条机检）。
 *
 * ## 为什么解析要单独成文件并且可单测
 *
 * 拉日志那一半只能在有人盯着的时候手动跑（要 token、要打 GitHub API，**不能进 CI 门禁** ——
 * 拿共享 runner 的心情去拦合并是另一种假红）。所以能钉住的部分（脏日志 → 结构化读数）
 * 全放在这里，喂真日志片段直接测。
 *
 * @module tests/helpers/ci-board-history
 */
import { at } from './strict-index.ts'

/** 一次运行的榜读数。 */
export interface RunBoard {
  /** 这次运行的标识（由调用方给：run 号、提交短 sha 之类）。 */
  label: string
  /** 榜首文件的耗时（毫秒）。 */
  topMs: number
  /** 榜首文件名。 */
  topFile: string
  /** 榜首自己有没有喊「已越过 60 秒线」（榜的越线分支与倍率分支互斥）。 */
  crossed: boolean
  /** 距 60 秒线的倍数；越线时 <1。 */
  ratio: number
  /** 这次运行是否真的出现了那条假红症状。 */
  sawRpcTimeout: boolean
}

/** vitest 里那条硬编码的 RPC 超时（毫秒），与 `slowest-files.ts` 的 `RPC_TIMEOUT_MS` 同值。 */
export const LINE_MS = 60000

/**
 * 去掉 Actions 日志的两层噪声：ANSI 颜色序列与每行开头的 ISO 时间戳。
 * @param raw - 原始日志文本。
 * @returns 逐行干净后的文本（仍保留缩进 —— 榜的 rank 靠它）。
 */
export function stripLogNoise(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .split(/\r?\n/)
    // 只吃掉时间戳后面那**一个**空格：日志里的榜靠行首缩进表达「第几名」，
    // 用 `\s+` 会把缩进一起吃掉（这条判据就是这么抓到的）。
    .map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z ?/, ''))
    .join('\n')
}

/** 榜首那一行：`  1.  104.5s   ⚠ 已越过 60 秒线…  路径` 或 `  1.   20.8s   距线 2.88×  路径`。 */
const TOP_ROW = /^\s*1\.\s+([0-9.]+)(ms|s)\s+(.+?)\s{2,}(\S+\.[cm]?[jt]sx?)\s*$/

/** 假红的症状行（两种写法都见过：带 `[vitest-worker]` 前缀与只带超时常量那一行）。 */
const RPC_TIMEOUT = /Timeout calling "onTaskUpdate"|vitest-worker/

/**
 * 从一份运行日志里解出「这一次的最慢文件」。
 *
 * 解不出来时返回 `null` 而不是 0 —— `[耗时榜]` 是 2026-09-24 才上的（PR #97），
 * 更早的运行根本没有这张榜；把「没有榜」算成「榜是 0 秒」会把最差值谎报成「很安全」。
 * @param rawLog - 未去噪也行（内部会去）。
 * @param label - 这次运行的标识。
 * @returns 读数，或 `null`（这份日志里没有可用的榜首行）。
 */
export function parseRunLog(rawLog: string, label: string): RunBoard | null {
  const text = stripLogNoise(rawLog)
  const boardStart = text.indexOf('[耗时榜]')
  if (boardStart === -1) return null
  // 只看榜之后紧邻的那一段：一份日志里可能出现不止一次榜（一次跑多个 test 步），
  // 取**最后一次**出现的那份才是这次运行最终的榜。
  const after = text.slice(boardStart)
  const lines = after.split('\n')
  let top: RunBoard | null = null
  for (const l of lines) {
    const m = TOP_ROW.exec(l)
    if (m === null) continue
    const value = Number(m[1])
    const ms = m[2] === 's' ? value * 1000 : value
    top = {
      label,
      topMs: ms,
      topFile: m[4] ?? '(无名)',
      crossed: (m[3] ?? '').includes('已越过'),
      ratio: LINE_MS / Math.max(1, ms),
      sawRpcTimeout: RPC_TIMEOUT.test(text),
    }
  }
  return top
}

/**
 * 最差的那一次：榜首耗时最长 = 距线倍数最小。
 * @param boards - 已解出的读数（`null` 应在调用前就滤掉）。
 * @returns 最差那次，或 `null`（一条读数都没有）。
 */
export function worstOf(boards: readonly RunBoard[]): RunBoard | null {
  if (boards.length === 0) return null
  return boards.reduce((a, b) => (b.topMs > a.topMs ? b : a))
}

/**
 * A 类榜首的预算（毫秒）。
 *
 * 2026-09-24 用户改定 N36 的验收：不再写「最慢文件距线倍数 ≥4×、按最差值判」——
 * 分段墙钟证明那些越线不在代码里（本机几十毫秒的文件能在 CI 上摆到 23~104 秒），
 * 按最差值判等于把 runner 的心情挂成永久欠账。新的两条是：
 * ① **(A) 类榜首 ≤15 秒**（真在算东西的那类，用**中位数**读 —— 偶发的 B 类停顿抬的是最大值）；
 * ② **B 类越线必须可自证**（同一次日志里有 `[耗时榜]`/`[用例榜]`/`[阶段|…]` 能说出「哪段都不在代码里」，
 *    并按第 ⑪ 步的政策允许一次带记录重跑）。这条工具只能数出「有几次越线」，自证与否看日志。
 */
export const TOP_BUDGET_MS = 15000

/**
 * 榜首耗时的中位数（毫秒）—— 口径 ① 目前读这个数。
 *
 * **它还不是「A 类」的中位数**：`topMs` 是那一次**整张榜的第一名**，而第一名今天常常是
 * B 类文件（`gateway-export-stream-progress.spec.ts` 本机 4 条用例 574 毫秒，CI 上摆到 23~36 秒）。
 * A 类 ⊆ 全体 ⇒ 这个中位数只会**偏高**：读到 `≤` 预算时「满足」是可信的，
 * 读到 `>` 预算时**还不能判「不满足」** —— 要等第 ⑭ 步（本机基线 + 整份榜）把两类分开。
 * @param boards - 有榜的那些次运行。
 * @returns 中位数；一次都没有时为 `null`（不是 0）。
 */
export function medianTopMs(boards: readonly RunBoard[]): number | null {
  if (boards.length === 0) return null
  const ms = boards.map((b) => b.topMs).sort((a, b) => a - b)
  const mid = Math.floor(ms.length / 2)
  if (ms.length % 2 === 1) return at(ms, mid, '榜首耗时序列')
  return (at(ms, mid - 1, '榜首耗时序列') + at(ms, mid, '榜首耗时序列')) / 2
}

/**
 * 历史报告：每次运行一行 + 两条新口径的判决 + 「多少次拿不到榜」的明说。
 *
 * 拿不到榜的次数一定要印出来：否则「最近 12 次中位 12 秒」会被读成「覆盖了 12 次」，
 * 而实际可能只有 3 次有榜、其余都是 #97 之前的运行。
 * @param boards - 有榜的那些次。
 * @param missing - 拉到了日志但没有榜的那些次的标识。
 * @param budgetMs - A 类榜首的预算（默认 {@link TOP_BUDGET_MS}）。
 * @returns 要打印的行。
 */
export function formatHistory(
  boards: readonly RunBoard[],
  missing: readonly string[] = [],
  budgetMs = TOP_BUDGET_MS,
): string[] {
  const out: string[] = []
  for (const b of boards) {
    const secs = (b.topMs / 1000).toFixed(1)
    out.push([
      '  run ', b.label.padEnd(12),
      `${secs.padStart(7)}s`,
      (b.crossed ? '  ⚠ 越线' : `  距线 ${(LINE_MS / Math.max(1, b.topMs)).toFixed(2)}×`),
      b.sawRpcTimeout ? ' 有假红' : '',
      `  ${b.topFile}`,
    ].join(''))
  }
  if (missing.length > 0) {
    out.push(`  —— 另有 ${String(missing.length)} 次运行拉到了日志却没有 [耗时榜]（榜是 #97 才上的）：${missing.join(', ')}`)
  }
  const w = worstOf(boards)
  if (w === null) {
    out.push(`[榜历史] ${String(boards.length + missing.length)} 次运行里没有一次拿得到榜 —— 这两条口径都判不了，别当成「都很快」。`)
    return out
  }
  const median = medianTopMs(boards) ?? 0
  const over = boards.filter((b) => b.crossed)
  const reds = boards.filter((b) => b.sawRpcTimeout)
  const okA = median <= budgetMs
  out.push([
    '[榜历史] 口径（2026-09-24 改定）：① A 类榜首中位 ≤',
    `${(budgetMs / 1000).toFixed(1)}s`,
    `⇒ 实测「整张榜第一名」的中位 ${(median / 1000).toFixed(1)}s`,
    okA ? '**满足**（上界都达标 ⇒ A 类必然达标）' : `**判不了**（是预算的 ${(median / budgetMs).toFixed(2)} 倍，但这只是**上界**）`,
    `（${String(boards.length)} 次有榜的运行）`,
  ].join(' '))
  out.push('  ⚠ ① 这个中位量的是**全体榜首**，不是 A 类榜首：今天的榜首常常正是 B 类文件'
    + '（`gateway-export-stream-progress.spec.ts` 本机 4 条用例 574 毫秒，CI 上摆到 23~36 秒），'
    + '混进来只会把这个数**抬高** ⇒ 「判不了」不等于「不满足」，反过来「满足」是可信的。'
    + '两类要真分开，得先有本机基线 + 整份榜（第 ⑭ 步）。')
  out.push([
    '  ② B 类越线（≥60 秒）要可自证：这批运行里越线',
    `${String(over.length)} 次`,
    over.length === 0 ? '（这一次覆盖内没有越线）' : `（${over.map((b) => `${b.label} ${(b.topMs / 1000).toFixed(1)}s`).join('、')}）`,
    `，其中出现过假红的 ${String(reds.length)} 次 —— 工具只能数次数，`,
    '「能不能自证」要看那一次的日志里有没有 `[耗时榜]`/`[用例榜]`/`[阶段|…]` 说出「哪段都不在代码里」。',
  ].join(' '))
  out.push(`  参考：最差的一次是 ${w.topFile} ${(w.topMs / 1000).toFixed(1)}s = 距线 ${(LINE_MS / Math.max(1, w.topMs)).toFixed(2)}×（B 类抬的是这个数，所以它不再是验收条件）`)
  out.push(reds.length === 0
    ? '  这些运行里没有一次出现 [vitest-worker] 超时。'
    : `  出现假红的运行：${reds.map((b) => b.label).join(', ')}`)
  return out
}
