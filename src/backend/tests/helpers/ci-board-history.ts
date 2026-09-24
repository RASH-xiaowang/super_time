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
import { B_RATIO, classifyFile } from './local-baseline.ts'
import { at, grp } from './strict-index.ts'

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
  /**
   * **整份**榜（前 10 名，按名次升序）。
   *
   * 以前这里只留榜首一名，于是「第 ⑫ 步那一刀有没有让 `search-cursor` 变快」根本答不出来：
   * 它没当上榜首的那几次，读数里就没有它。跨运行比单个文件必须有整份榜。
   */
  rows: BoardRow[]
  /** 这次运行的提交短 sha（由调用方给；离线 `--from-file` 时没有）。 */
  sha?: string
  /** 这次运行的分支名（同上）。 */
  branch?: string
}

/** 榜上的一行。 */
export type BoardRow = { rank: number, file: string, ms: number, crossed: boolean }

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

/** 榜上的一行：`  1.  104.5s   ⚠ 已越过 60 秒线…  路径` 或 `  2.   20.8s   距线 2.88×  路径`。 */
const RANKED_ROW = /^\s*(\d+)\.\s+([0-9.]+)(ms|s)\s+(.+?)\s{2,}(\S+\.[cm]?[jt]sx?)\s*$/

/** 假红的症状行（两种写法都见过：带 `[vitest-worker]` 前缀与只带超时常量那一行）。 */
const RPC_TIMEOUT = /Timeout calling "onTaskUpdate"|vitest-worker/

/** 把 `12.3s` / `940ms` 这种写法换成毫秒。 */
function msOf (value: number, unit: string): number {
  return unit === 's' ? value * 1000 : value
}

/**
 * 从一份日志里解出**最后一张** `[耗时榜]` 的全部行。
 *
 * 为什么是「最后一张」：一次运行里可能打好几回榜（多个 test 步），只有最后一次是终值。
 * 为什么在「遇到非榜行」就收尾：紧跟其后还有一张 `[用例榜]`，把它的行也算进来的话，
 * 「榜首」就会被用例数字顶掉 —— 那是一张会给出荒谬结论的榜。
 * @param text - 去过噪的日志全文。
 * @returns 按名次升序的行；一张榜都没有时为空数组。
 */
function lastBoardRows(text: string): BoardRow[] {
  const lines = text.split('\n')
  let start = -1
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^\s*\[耗时榜\]/.test(at(lines, i, '日志行'))) { start = i; break }
  }
  if (start === -1) return []
  const rows: BoardRow[] = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = at(lines, i, '日志行')
    if (line.trim() === '') continue
    const m = RANKED_ROW.exec(line)
    if (m === null) break
    rows.push({
      rank: Number(grp(m, 1, '榜行名次')),
      ms: msOf(Number(grp(m, 2, '榜行耗时')), grp(m, 3, '榜行单位')),
      crossed: grp(m, 4, '榜行余量段').includes('已越过'),
      file: grp(m, 5, '榜行文件名'),
    })
  }
  return rows.sort((a, b) => a.rank - b.rank)
}

/**
 * 从一份运行日志里解出这一次的榜。
 *
 * 解不出来时返回 `null` 而不是 0 —— `[耗时榜]` 是 2026-09-24 才上的（PR #97），
 * 更早的运行根本没有这张榜；把「没有榜」算成「榜是 0 秒」会把最差值谎报成「很安全」。
 * @param rawLog - 未去噪也行（内部会去）。
 * @param label - 这次运行的标识。
 * @param meta - 这次运行的提交短 sha 与分支（可选，只为打印）。
 * @returns 读数，或 `null`（这份日志里没有可用的榜首行）。
 */
export function parseRunLog(rawLog: string, label: string, meta: { sha?: string, branch?: string } = {}): RunBoard | null {
  const text = stripLogNoise(rawLog)
  const rows = lastBoardRows(text)
  const top = rows.length > 0 ? at(rows, 0, '榜的第一行') : null
  if (top === null) return null
  return {
    label,
    topMs: top.ms,
    topFile: top.file,
    crossed: top.crossed,
    ratio: LINE_MS / Math.max(1, top.ms),
    sawRpcTimeout: RPC_TIMEOUT.test(text),
    rows,
    ...(meta.sha === undefined ? {} : { sha: meta.sha }),
    ...(meta.branch === undefined ? {} : { branch: meta.branch }),
  }
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
 * 一组数的中位数；空集返回 `null`（**不是 0** —— 拿不到数不许当「很快」）。
 * @param xs - 参与统计的数。
 * @returns 中位数，或 `null`。
 */
export function medianOf(xs: readonly number[]): number | null {
  if (xs.length === 0) return null
  const ms = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(ms.length / 2)
  if (ms.length % 2 === 1) return at(ms, mid, '中位序列')
  return (at(ms, mid - 1, '中位序列') + at(ms, mid, '中位序列')) / 2
}

/**
 * 榜首耗时的中位数（毫秒）—— 口径 ① 目前读这个数。
 *
 * **它还不是「A 类」的中位数**：`topMs` 是那一次**整张榜的第一名**，而第一名今天常常是
 * B 类文件（`gateway-export-stream-progress.spec.ts` 本机 4 条用例 574 毫秒，CI 上摆到 23~36 秒）。
 * A 类 ⊆ 全体 ⇒ 这个中位数只会**偏高**：读到 `≤` 预算时「满足」是可信的，
 * 读到 `>` 预算时**还不能判「不满足」** —— 要等第 ⑯ 步（本机基线）把两类分开。
 * @param boards - 有榜的那些次运行。
 * @returns 中位数；一次都没有时为 `null`（不是 0）。
 */
export function medianTopMs(boards: readonly RunBoard[]): number | null {
  return medianOf(boards.map((b) => b.topMs))
}

/** 某一个文件在历次运行里的读数。 */
export interface FileHistoryPoint {
  /** 那次运行的标识。 */
  label: string
  /** 该文件那次在榜上的名次；没上榜时为 `undefined`。 */
  rank?: number
  /** 毫秒；**`null` 表示那次它没进前十**（不是 0 秒）。 */
  ms: number | null
  /** 那次运行的提交短 sha。 */
  sha?: string
}

/**
 * 按文件名关键字把整份榜横过来看：这个文件每次多少毫秒。
 *
 * 为什么需要：只有榜首的历史会漏掉**所有没当上榜首的运行**，于是「第 ⑫ 步那一刀有没有让
 * `search-cursor` 变快」在数据上无法回答 —— 它那几次多半根本不是榜首。
 * @param boards - 有整份榜的那些次运行。
 * @param needle - 文件名子串（大小写不敏感）。
 * @returns 与 `boards` 同序的点；没上榜的那些次是 `ms: null`。
 */
export function fileHistory(boards: readonly RunBoard[], needle: string): FileHistoryPoint[] {
  const key = needle.toLowerCase()
  return boards.map((b) => {
    const row = b.rows.find((r) => r.file.toLowerCase().includes(key))
    return {
      label: b.label,
      ...(row === undefined ? { ms: null as number | null } : { ms: row.ms, rank: row.rank }),
      ...(b.sha === undefined ? {} : { sha: b.sha }),
    }
  })
}

/**
 * `[单文件历史]` —— 一个文件跨运行的读数与中位数。
 * @param points - {@link fileHistory} 的结果。
 * @param needle - 用的关键字（原样印回去，读日志的人知道筛了什么）。
 * @param budgetMs - 参照的预算（口径 ① 的 15 秒）。
 * @returns 要打印的行。
 */
export function formatFileHistory(points: readonly FileHistoryPoint[], needle: string, budgetMs = TOP_BUDGET_MS): string[] {
  if (points.length === 0) return [`[单文件历史] 关键字「${needle}」：一次有榜的运行都没拿到 —— 这什么都不说明。`]
  const hit = points.filter((p) => p.ms !== null)
  const out = [`[单文件历史] 关键字「${needle}」：${String(points.length)} 次运行里上榜 ${String(hit.length)} 次`
    + (hit.length === points.length ? '' : `（其余 ${String(points.length - hit.length)} 次它没进前十 —— 没上榜**不是 0 秒**）`)]
  for (const p of points) {
    const tag = p.sha === undefined ? '' : ` @${p.sha}`
    out.push(p.ms === null
      ? `  run ${p.label.padEnd(8)}${tag}      未上榜`
      : `  run ${p.label.padEnd(8)}${tag}  ${(p.ms / 1000).toFixed(1).padStart(6)}s  第 ${String(p.rank ?? 0)} 名`)
  }
  const med = medianOf(hit.map((p) => p.ms ?? 0))
  if (med === null) {
    out.push(`[单文件历史] 「${needle}」一次都没上榜 ⇒ 没有中位数可算（别当它是 0 秒）。`)
    return out
  }
  const ok = med <= budgetMs
  out.push([
    `[单文件历史] 上榜那 ${String(hit.length)} 次的中位 ${(med / 1000).toFixed(1)}s`,
    `⇒ 相对 ${(budgetMs / 1000).toFixed(1)}s 预算 ${ok ? '**达标**' : '**超了**'}`,
    '（它算 A 类还是 B 类要本机基线才能定，见第 ⑯ 步；这张表只保证「同一个文件跨运行能排在一起比」）',
  ].join(' '))
  return out
}

/**
 * 少于此样本数就不给噪声带 —— MAD 本身在这种规模上就是猜的，
 * 拿一个猜出来的带去判另一个数「算不算动了」是双重冒充精确。
 */
export const MIN_FOR_BAND = 6

/** 一个窗口的判决包：中位、噪声带（± 毫秒）、样本数。 */
export interface WindowVerdict { median: number, band: number, n: number }

/**
 * 稳健标准差：`1.4826 × MAD`。
 *
 * 为什么不用样本标准差：A 榜首的分布是**长尾**的（同一份代码 12.0~20.4 秒，偶发还有 100+ 秒的停顿），
 * 用 σ 会被那几次离群撑大，然后任何一刀都「落在噪声带里」—— 判据就成了永远不动。
 * @param xs - 样本。
 * @returns σ̂，或 `null`（样本太少 / 算不出）。
 */
export function robustSigma (xs: readonly number[]): number | null {
  if (xs.length < MIN_FOR_BAND) return null
  const med = medianOf(xs)
  if (med === null) return null
  const mad = medianOf(xs.map((x) => Math.abs(x - med)))
  return mad === null ? null : 1.4826 * mad
}

/**
 * 一个窗口的中位数 + 噪声带（± 95% 置信，`z × σ̂ / √n`）。
 * @param xs - 那个窗口的 A 榜首毫秒数。
 * @param z - 分位数（默认 1.96 ≈ 95%）。
 * @returns 判决包，或 `null`（样本太少 ⇒ 不给带）。
 */
export function verdictOf (xs: readonly number[], z = 1.96): WindowVerdict | null {
  if (xs.length < MIN_FOR_BAND) return null
  const median = medianOf(xs)
  const sigma = robustSigma(xs)
  if (median === null || sigma === null) return null
  return { median, band: z * sigma / Math.sqrt(xs.length), n: xs.length }
}

/**
 * 两个窗口比较：差值要**超过两边噪声带之和**才算真的动了。
 *
 * 这是用户 2026-09-24 对 ① 的追加口径：预算仍是 15 秒不动，但「我减下来了」这句话
 * 必须能被验证 —— 否则一次 runner 心情好就能伪造出一刀收益（第 ⑮ 步刚被这件事教育过：
 * #105 的两次读数与改前中位差 0.2 秒）。
 */
export function compareWindows (now: WindowVerdict, before: WindowVerdict): { delta: number, mustExceed: number, real: boolean } {
  const delta = now.median - before.median
  const mustExceed = now.band + before.band
  return { delta, mustExceed, real: Math.abs(delta) > mustExceed }
}

/**
 * 比较两窗口的那几行输出。
 * @param now - 最近那个窗口。
 * @param before - 前一个窗口。
 * @param labelNow - 最近窗口的说法（含它的 A 榜首是什么文件）。
 * @param labelBefore - 前窗口的说法。
 * @returns 要打印的行。
 */
export function formatCompare (now: WindowVerdict, before: WindowVerdict, labelNow = '最近这一半', labelBefore = '前一半'): string[] {
  const c = compareWindows(now, before)
  const s = (x: number): string => (x / 1000).toFixed(1)
  return [
    `[对比] ${labelNow}：n=${String(now.n)} 中位 ${s(now.median)}s（带 ±${s(now.band)}s）｜${labelBefore}：n=${String(before.n)} 中位 ${s(before.median)}s（带 ±${s(before.band)}s）`,
    c.real
      ? `[对比] 差 ${c.delta >= 0 ? '+' : '-'}${s(Math.abs(c.delta))}s > 要超过的 ${s(c.mustExceed)}s ⇒ **这一步真的动了**${c.delta < 0 ? '（变快）' : '（变慢）'}`
      : `[对比] 差 ${c.delta >= 0 ? '+' : '-'}${s(Math.abs(c.delta))}s ≤ 要超过的 ${s(c.mustExceed)}s ⇒ **落在噪声带里，不能算效果**（要嘛再减，要嘛多跑几次把带收窄）`,
  ]
}

/**
 * 口径 ① 的一句话判决（带噪声带的版本）。
 * @param v - 这个窗口的判决包（`null` = 样本太少）。
 * @param budgetMs - 预算。
 * @param topFile - 中位那次附近的榜首文件名（只为让读的人知道在说谁）。
 * @returns 一行文本。
 */
export function formatVerdict (v: WindowVerdict | null, budgetMs: number, topFile = ''): string {
  const s = (x: number): string => (x / 1000).toFixed(1)
  const who = topFile === '' ? '' : `（多为 ${topFile.split('/').pop()}）`
  if (v === null) return `[榜历史] ① A 类榜首中位 ≤ ${s(budgetMs)}s ⇒ **判不了** —— 可判的样本不足 ${String(MIN_FOR_BAND)} 个，给不出噪声带${who}`
  const margin = v.median - budgetMs
  if (Math.abs(margin) <= v.band) {
    return `[榜历史] ① A 类榜首中位 ≤ ${s(budgetMs)}s ⇒ 中位 ${s(v.median)}s **判不准**：与预算只差 ${s(Math.abs(margin))}s，而噪声带是 ±${s(v.band)}s（n=${String(v.n)}）${who} —— 这句话的意思是「现在还没资格说达没标」`
  }
  return margin > 0
    ? `[榜历史] ① A 类榜首中位 ≤ ${s(budgetMs)}s ⇒ 中位 ${s(v.median)}s **不满足**：超出 ${s(margin)}s，大于 ±${s(v.band)}s 的带（n=${String(v.n)}）${who}`
    : `[榜历史] ① A 类榜首中位 ≤ ${s(budgetMs)}s ⇒ 中位 ${s(v.median)}s **满足**：低于预算 ${s(-margin)}s，大于 ±${s(v.band)}s 的带（n=${String(v.n)}）${who}`
}
/**
 * 某个文件在基线里的毫秒数（`null` = 没量到）。分类器的输入形状。
 */
export type LocalLookup = (file: string) => number | null

/** 一次运行按 A/B 分过之后的样子。 */
export interface RunClasses {
  /** 那次运行的标识。 */
  label: string
  /** 判成 A 的最慢那个文件；一次 A 都没有时为 `null`。 */
  aTop: { file: string, ms: number } | null
  /**
   * 榜上有没有「基线认不出、但比已判出的 A 榜首更慢」的文件。
   *
   * 为什么单独记这个：基线缺一条，那个文件就只能算 unknown、不会进 A 的候选集 ——
   * 于是「A 类榜首」会被**低估**，而低估会让 ① 假绿。含糊的那一次**不参与中位数**。
   */
  ambiguous: boolean
  /** 判成 B（本机几乎不花时间、CI 却慢过线）的文件。 */
  bFiles: string[]
  /** 榜上基线认不出的行数。 */
  unknown: number
}

/**
 * 把一次运行的整份榜按「本机基线」分成 A / B / 认不出。
 * @param board - 那次运行的整份榜。
 * @param local - 查本机毫秒的函数（通常绑到基线产物上）。
 * @returns 分类结果。
 */
export function classifyRun(board: RunBoard, local: LocalLookup): RunClasses {
  const cls = board.rows.map((r) => classifyFile(local(r.file), r.ms))
  let aTop: RunClasses['aTop'] = null
  const bFiles: string[] = []
  let unknown = 0
  // 用普通 for 而不是 `forEach`：闭包里的赋值 TS 不参与收窄，`aTop` 会一直被认为是 `null`
  // （第一次就报在 `aTop?.ms` 上：Property 'ms' does not exist on type 'never'）。
  for (let i = 0; i < board.rows.length; i += 1) {
    const r = at(board.rows, i, '榜上的一行')
    const c = at(cls, i, '对应的那一列')
    if (c === 'A') { if (aTop === null || r.ms > aTop.ms) aTop = { file: r.file, ms: r.ms } }
    else if (c === 'B') bFiles.push(r.file)
    else unknown += 1
  }
  // 认不出的行**排得比已判出的 A 榜首还靠前** ⇒ 这次的 A 榜首数不可信（真正最慢的 A 可能是它）。
  const best = aTop?.ms ?? 0
  const ambiguous = board.rows.some((r, i) => cls[i] === 'unknown' && r.ms > best)
  return { label: board.label, aTop, ambiguous, bFiles, unknown }
}

/**
 * A 类榜首的中位数 —— 口径 ① 真正要的那个数。
 *
 * 只算「不含糊、且确实有 A 读数」的那些次；含糊的那次**不参与**（把它算进去就是拿
 * 一个已知会偏低的数冒充中位数）。
 * @param runs - 各次运行的分类结果。
 * @returns `median` 中位数（一次都不符合时 `null`）、`used`/`skipped` 计数，
 *          以及 `values`（那 `used` 个原始读数 —— 算噪声带要用，别让调用方自己再捞一遍）。
 */
export function medianATop(runs: readonly RunClasses[]): { median: number | null, used: number, skipped: number, values: number[] } {
  const usable = runs.filter((r) => !r.ambiguous && r.aTop !== null)
  // 过滤之后 TS 不知道 `aTop` 一定在（闭包里不保留收窄），所以再判一次而不是 `!`。
  const values = usable.flatMap((r) => (r.aTop === null ? [] : [r.aTop.ms]))
  return { median: medianOf(values), used: usable.length, skipped: runs.length - usable.length, values }
}

/**
 * 历史报告：每次运行一行 + 两条新口径的判决 + 「多少次拿不到榜」的明说。
 *
 * 拿不到榜的次数一定要印出来：否则「最近 12 次中位 12 秒」会被读成「覆盖了 12 次」，
 * 而实际可能只有 3 次有榜、其余都是 #97 之前的运行。
 * @param boards - 有榜的那些次。
 * @param missing - 拉到了日志但没有榜的那些次的标识。
 * @param budgetMs - A 类榜首的预算（默认 {@link TOP_BUDGET_MS}）。
 * @param local - 查本机基线的函数（{@link baselineMs} 绑到产物上）。**给了**就按 A/B 分类判 ①，
 *                不给就只给那条上界判决 —— 少一份输入就多一句自我声明，这是有意的。
 * @returns 要打印的行。
 */
export function formatHistory(
  boards: readonly RunBoard[],
  missing: readonly string[] = [],
  budgetMs = TOP_BUDGET_MS,
  local: LocalLookup | null = null,
): string[] {
  const out: string[] = []
  for (const b of boards) {
    const secs = (b.topMs / 1000).toFixed(1)
    out.push([
      '  run ', b.label.padEnd(6),
      (b.sha === undefined ? '' : `@${b.sha}`.padEnd(9)),
      `${secs.padStart(7)}s`,
      (b.crossed ? '  ⚠ 越线' : `  距线 ${(LINE_MS / Math.max(1, b.topMs)).toFixed(2)}×`),
      b.sawRpcTimeout ? ' 有假红' : '',
      `  ${b.topFile}（榜上 ${String(b.rows.length)} 行）`,
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
  const classes = local === undefined || local === null ? [] : boards.map((b) => classifyRun(b, local))
  const a = classes.length > 0 ? medianATop(classes) : null
  const unknownRows = classes.reduce((n, r) => n + r.unknown, 0)
  if (a !== null && a.median !== null) {
    out.push(formatVerdict(verdictOf(a.values), budgetMs, at(classes, 0, '最近那次')?.aTop?.file ?? ''))
    out.push(`  ① 这一条按**本机基线**分的类：榜首里判成 A 的最慢那个才进中位数，判成 B 的（本机几乎不花时间、`
      + `CI 慢过 ${String(B_RATIO)} 倍）不当 ① 的账。`
      + (unknownRows > 0
        ? `榜上另有 ${String(unknownRows)} 行基线里查不到（那些次要么跳过、要么只数得着已认出的部分）—— 基线过期就重跑 \`npm run ci:baseline\`。`
        : '基线覆盖了榜上每一行，没有被漏掉的候选。'))
    out.push(`  ① 的口径（用户 2026-09-24 追加）：预算 15 秒不动，但**与预算的差要超过噪声带**才算数；`
      + `判「这一刀有没有效」用 \`--compare\`（两半窗口的中位差要超过两边带之和）。`)
  } else {
    const okA = median <= budgetMs
    out.push([
      '[榜历史] 口径（2026-09-24 改定）：① A 类榜首中位 ≤',
      `${(budgetMs / 1000).toFixed(1)}s`,
      `⇒ 实测「整张榜第一名」的中位 ${(median / 1000).toFixed(1)}s`,
      okA ? '**满足**（上界都达标 ⇒ A 类必然达标）' : `**判不了**（是预算的 ${(median / budgetMs).toFixed(2)} 倍，但这只是**上界**）`,
      `（${String(boards.length)} 次有榜的运行）`,
    ].join(' '))
    out.push('  ⚠ 这一条**没有本机基线**，只能给上界：中位量的是全体榜首而不是 A 类榜首，'
      + '今天的榜首常常正是本机只有几百毫秒的文件（`gateway-export-stream-progress.spec.ts` 本机串行 605 毫秒，'
      + 'CI 上摆到 8.6~35.8 秒），混进来只会把这个数**抬高** ⇒ 「判不了」不等于「不满足」，反过来「满足」是可信的。'
      + (a !== null ? ` 有基线但每次的榜首都在基线之外（跳过 ${String(a.skipped)} 次）—— 重新 \`npm run ci:baseline\`。` : ' 要它变成可判：`npm run ci:baseline` 采一份基线。'))
  }
  out.push([
    '  ② B 类越线（≥60 秒）要可自证：这批运行里越线',
    `${String(over.length)} 次`,
    over.length === 0 ? '（这一次覆盖内没有越线）' : `（${over.map((b) => `${b.label} ${(b.topMs / 1000).toFixed(1)}s`).join('、')}）`,
    `，其中出现过假红的 ${String(reds.length)} 次 —— 工具只能数次数，`,
    '「能不能自证」优先看那一次日志里的 `[文件内账]`（第 ⑭ 步起对任何文件都有），手写的分段墙钟是它的特例。',
  ].join(' '))
  out.push(`  参考：最差的一次是 ${w.topFile} ${(w.topMs / 1000).toFixed(1)}s = 距线 ${(LINE_MS / Math.max(1, w.topMs)).toFixed(2)}×（B 类抬的是这个数，所以它不再是验收条件）`)
  out.push(reds.length === 0
    ? '  这些运行里没有一次出现 [vitest-worker] 超时。'
    : `  出现假红的运行：${reds.map((b) => b.label).join(', ')}`)
  return out
}
