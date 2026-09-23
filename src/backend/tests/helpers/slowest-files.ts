/**
 * 「最慢的测试文件榜」——纯函数部分，被 `vitest.config.ts` 的报告器使用。
 *
 * 为什么要单独一个文件并且可单测：这张榜是 N36 的判据面。CI 那条假红的线是
 * vitest 里硬编码的 60 秒（`node_modules/vitest/dist/chunks/index.B521nVV-.js:3` 的
 * `DEFAULT_TIMEOUT = 6e4`，worker 的 rpc 选项不传 `timeout` ⇒ 无配置项可调），
 * 而以前想知道「现在离那条线还有多远」必须去 Actions 下载日志 zip、解压、去 ANSI、再人肉排序。
 * 排序与格式化写成纯函数，才能被单测直接喂数据钉住（榜单本身对不对、并列怎么破、
 * 倍率怎么算 —— 这些都不该依赖真跑一轮测试才知道）。
 *
 * @module tests/helpers/slowest-files
 */

/** 一个测试文件的耗时记录。 */
export type FileTiming = { name: string, ms: number }

/** CI 那条假红的硬编码线（毫秒）。 */
export const RPC_TIMEOUT_MS = 60000

/**
 * 按耗时从大到小取前 `n` 名。
 *
 * 并列时按文件名升序破平 —— 这不是美化：榜单要拿去跨运行比较，
 * 同一批数据两次跑出不同顺序，就会有人以为「变慢了/变快了」。
 * @param files - 未排序的耗时记录。
 * @param n - 取几名。
 * @returns 新数组（不改入参）。
 */
export function topSlowest(files: readonly FileTiming[], n = 10): FileTiming[] {
  return [...files]
    .sort((a, b) => (b.ms - a.ms) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, Math.max(0, n))
}

/**
 * 把一名渲染成一行文本，带上**离 60 秒线还有几倍**的余量。
 * @param rank - 名次（从 1 开始）。
 * @param f - 该名的记录。
 * @param limitMs - 参照的那条线。
 * @returns 一行文本。
 */
export function formatRow(rank: number, f: FileTiming, limitMs = RPC_TIMEOUT_MS): string {
  // 一秒以内用毫秒显示 —— 否则单文件跑量级榜单会出现一排看着像「0.0s」（其实就是没数据）的行。
  const shown = f.ms < 1000 ? `${f.ms.toFixed(0)}ms` : `${(f.ms / 1000).toFixed(1)}s`
  const secs = shown.padStart(7)
  const ratio = (limitMs / Math.max(1, f.ms)).toFixed(2)
  const tail = f.ms >= limitMs ? '  ⚠ 已越过 60 秒线（历史上每次假红都有一个这样的文件）' : `  距线 ${ratio}×`
  return ` ${String(rank).padStart(2)}. ${secs} ${tail}  ${f.name}`
}

/**
 * 整张榜（含表头与「一个文件都没拿到」的警告行）。
 * @param files - 全部文件的耗时记录。
 * @param n - 榜单长度。
 * @param limitMs - 参照的那条线。
 * @returns 要打印的行。
 */
export function formatBoard(files: readonly FileTiming[], n = 10, limitMs = RPC_TIMEOUT_MS): string[] {
  if (files.length === 0) {
    return ['[耗时榜] 一个文件的耗时都没拿到 —— 这张榜此刻是空的，别把它当「没有慢文件」。']
  }
  // 拿到文件、却全是 0 毫秒 —— 那是**取数字的字段错了**（vitest 各版本把 duration 放在
  // task.duration 或 task.result.duration 上，接口一变这里就静默失效）。一张全是 0 的榜比
  // 没有榜更糟：它看着像「没有慢文件」。所以这里必须自己喊出来。
  if (files.every((x) => x.ms === 0)) {
    return [`[耗时榜] ${String(files.length)} 个文件、耗时全部为 0 —— 报告器读错字段了，这张榜不作数。`]
  }
  const rows = topSlowest(files, n).map((f, i) => formatRow(i + 1, f, limitMs))
  return [`[耗时榜] ${String(files.length)} 个测试文件，最慢的前 ${String(rows.length)} 名：`, ...rows]
}
