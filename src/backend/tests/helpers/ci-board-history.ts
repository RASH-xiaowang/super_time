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
 * 历史报告：每次运行一行 + 最差值 + 「多少次拿不到榜」的明说。
 *
 * 拿不到榜的次数一定要印出来：否则「最近 12 次最差值 2.9×」会被读成「覆盖了 12 次」，
 * 而实际可能只有 3 次有榜、其余都是 #97 之前的运行。
 * @param boards - 有榜的那些次。
 * @param missing - 拉到了日志但没有榜的那些次的标识。
 * @param required - 验收要求的倍数（默认 4×）。
 * @returns 要打印的行。
 */
export function formatHistory(boards: readonly RunBoard[], missing: readonly string[] = [], required = 4): string[] {
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
    out.push(`[榜历史] ${String(boards.length + missing.length)} 次运行里没有一次拿得到榜 —— 这个「最差值」不存在，别当成「都很快」。`)
    return out
  }
  const ratio = LINE_MS / Math.max(1, w.topMs)
  const verdict = ratio >= required
    ? `满足「≥${String(required)}×」`
    : `不满足「≥${String(required)}×」（还差 ${(required / Math.max(0.01, ratio)).toFixed(2)} 倍）`
  out.push(`[榜历史] ${String(boards.length)} 次有榜的运行里最差的一次：榜首 ${w.topFile} ${(w.topMs / 1000).toFixed(1)}s = 距线 ${ratio.toFixed(2)}× ⇒ ${verdict}`)
  const reds = boards.filter((b) => b.sawRpcTimeout).map((b) => b.label)
  out.push(reds.length === 0
    ? '  这些运行里没有一次出现 [vitest-worker] 超时。'
    : `  出现假红的运行：${reds.join(', ')}`)
  return out
}
