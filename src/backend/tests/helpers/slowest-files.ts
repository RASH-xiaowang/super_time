/**
 * 「最慢的测试文件榜」与「最慢的用例榜」—— 纯函数部分，被 `vitest.config.ts` 的报告器使用。
 *
 * 为什么要单独一个文件并且可单测：这两张榜是 N36 的判据面。CI 那条假红的线是
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

/** 一个用例的耗时记录（`file` 用它所属文件的名字）。 */
export type TestTiming = { file: string, name: string, ms: number }

/** 报告器拿到的任务节点（vitest 结构的子集：文件/套件带 `tasks`，用例是叶子）。 */
export type ReportTask = {
  type?: string
  name?: string
  result?: { duration?: number }
  duration?: number
  tasks?: ReportTask[]
}

/**
 * 把一棵套件树摊平成「用例耗时」列表。
 *
 * 为什么递归而不是只看 `file.tasks`：`describe` 嵌套时第一层全是套件不是用例，只看一层会得出
 * 「一个用例都没拿到」—— 那张榜于是安静地空着，和全 0 是同一种坏法。
 * 用例名带上所属套件链：否则日志里会出现两条都叫「正常路径」的用例，谁占了多少文件都说不清。
 * @param nodes - 某一层的全部任务节点。
 * @param prefix - 到这一层为止的名字链，`prefix[0]` 是文件名。
 * @param out - 收集结果（就地追加，方便一次运行里跨文件复用同一个数组）。
 */
export function collectTestTimings(nodes: readonly ReportTask[], prefix: string[], out: TestTiming[]): void {
  for (const t of nodes) {
    const ms = Math.max(0, t.result?.duration ?? t.duration ?? 0)
    if (Array.isArray(t.tasks)) {
      collectTestTimings(t.tasks, [...prefix, t.name ?? '(未命名套件)'], out)
    } else if (t.type === 'test' || t.result !== undefined) {
      out.push({ file: prefix[0] ?? '(无名文件)', name: prefix.slice(1).concat(t.name ?? '(未命名用例)').join(' › '), ms })
    }
  }
}

/**
 * 按耗时从大到小取前 `n` 个用例；并列时按「文件名 → 用例名」升序破平（理由同 {@link topSlowest}）。
 * @param tests - 未排序的用例耗时。
 * @param n - 取几名。
 * @returns 新数组（不改入参）。
 */
export function topSlowestTests(tests: readonly TestTiming[], n = 10): TestTiming[] {
  return [...tests]
    .sort((a, b) => (b.ms - a.ms)
      || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
      || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .slice(0, Math.max(0, n))
}

/**
 * 用例榜的一行，带上「占它所属文件多少」—— 这一列才是这张榜存在的理由。
 *
 * 为什么要占比而不是只列秒数：文件榜只能说到「`overview.spec.ts` 104.5 秒」，
 * 而「一个文件慢」有两种完全不同的病 —— 3 个用例各 35 秒（整个文件都在做的事，减夹具才有用）
 * 与 1 个用例 104 秒（单一处的事，直接去看那一条）。占比把这两种分开。
 * @param rank - 名次（从 1 开始）。
 * @param t - 该名的用例。
 * @param fileMs - 它所属文件的总耗时；拿不到（0 或缺失）时这一列写「占比未知」。
 * @returns 一行文本。
 */
export function formatTestRow(rank: number, t: TestTiming, fileMs: number): string {
  const shown = t.ms < 1000 ? `${t.ms.toFixed(0)}ms` : `${(t.ms / 1000).toFixed(1)}s`
  const share = fileMs > 0 ? `占该文件 ${(100 * t.ms / fileMs).toFixed(0)}%` : '占比未知'
  return ` ${String(rank).padStart(2)}. ${shown.padStart(7)}  ${share.padStart(12)}  ${t.file} › ${t.name}`
}

/**
 * 「最慢用例榜」整张表（含自我声明的失效分支，口径同 {@link formatBoard}）。
 * @param tests - 全部用例的耗时。
 * @param fileMs - 文件名 → 该文件总耗时，用来算占比。
 * @param n - 榜单长度。
 * @returns 要打印的行。
 */
export function formatTestBoard(
  tests: readonly TestTiming[],
  fileMs: ReadonlyMap<string, number>,
  n = 10,
): string[] {
  if (tests.length === 0) {
    return ['[用例榜] 一个用例的耗时都没拿到 —— 这张榜此刻是空的，别把它当「没有慢用例」。']
  }
  if (tests.every((x) => x.ms === 0)) {
    return [`[用例榜] ${String(tests.length)} 个用例、耗时全部为 0 —— 报告器读错字段了，这张榜不作数。`]
  }
  const rows = topSlowestTests(tests, n).map((t, i) => formatTestRow(i + 1, t, fileMs.get(t.file) ?? 0))
  return [`[用例榜] ${String(tests.length)} 个用例，最慢的前 ${String(rows.length)} 名：`, ...rows]
}

/** 一个慢文件的「内账」：文件总时长与落在用例上的时长各多少。 */
export type FileAccount = { file: string, fileMs: number, caseMs: number, cases: number }

/**
 * 按文件汇总用例耗时。
 * @param tests - 摊平后的用例耗时。
 * @returns 文件名 → `{ 合计毫秒, 条数 }`。
 */
export function sumCasesByFile(tests: readonly TestTiming[]): Map<string, { ms: number, n: number }> {
  const out = new Map<string, { ms: number, n: number }>()
  for (const t of tests) {
    const cur = out.get(t.file)
    if (cur === undefined) out.set(t.file, { ms: t.ms, n: 1 })
    else { cur.ms += t.ms; cur.n += 1 }
  }
  return out
}

/**
 * 前 `n` 名慢文件的「文件总时长 vs 用例合计」。
 * @param files - 全部文件的耗时记录。
 * @param tests - 摊平后的用例耗时。
 * @param n - 算几名（榜尾那些几百毫秒的文件没必要打）。
 * @param floorMs - 低于这个总时长的文件跳过。
 * @returns 按文件总时长降序的内账。
 */
export function fileAccounts(
  files: readonly FileTiming[],
  tests: readonly TestTiming[],
  n = 3,
  floorMs = 1000,
): FileAccount[] {
  const byFile = sumCasesByFile(tests)
  return topSlowest(files, n)
    .filter((f) => f.ms >= floorMs)
    .map((f) => {
      const s = byFile.get(f.name)
      return { file: f.name, fileMs: f.ms, caseMs: s?.ms ?? 0, cases: s?.n ?? 0 }
    })
}

/** 毫秒的展示口径：一秒以内用毫秒，否则一位小数（与 {@link formatRow} 一致）。 */
function msText(ms: number): string {
  return ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/**
 * `[文件内账]` —— 对**任意**一个慢文件都能说出的那句「时间在不在这次的代码里」。
 *
 * 为什么单独要这张小表：N36 的口径 ② 说「B 类越线必须能自证」，而自证以前只有一处 ——
 * `image-path-batch.spec.ts` 里手写的「分段墙钟」（它打的是 `[阶段…]` 那几行）。别的产品文件一旦越线，日志里
 * 没有任何东西能说明「这段时间不在用例里」。这张表是**通用**的那一半：用例合计明显小于文件
 * 总时长 ⇒ 时间落在收集/夹具/收尾或 runner 停顿上；两者接近 ⇒ 就是这个文件自己在做事。
 *
 * 它不能替代本机基线（口径 ② 的另一半）：如果停顿正好落在**某条用例的函数体内部**，
 * 那条用例的耗时会把停顿一起吃进去，比值照样接近 1 —— 那时只有「同一份代码本机多少毫秒」
 * 能说清是机器慢还是活真多。所以两个数都要有，缺一个就只能猜。
 * @param accounts - {@link fileAccounts} 的结果。
 * @returns 要打印的行（一条都没有时也要说明为什么没有）。
 */
export function formatFileAccounts(accounts: readonly FileAccount[]): string[] {
  if (accounts.length === 0) {
    return ['[文件内账] 没有 ≥1 秒的慢文件（或一个文件都没拿到）—— 这张表此刻是空的。']
  }
  const head = `[文件内账] 时间落在哪：把「文件总时长 − 用例合计」当成「不在用例里的那段」的量级`
  const width = Math.min(80, Math.max(...accounts.map((a) => a.file.length)) + 2)
  const rows = accounts.map((a) => {
    const pad = a.file.padEnd(width)
    if (a.cases === 0) {
      return `  ${pad} 文件 ${msText(a.fileMs).padStart(7)}  用例 0 条 —— 收集口径没拿到，这一行不作数（别读成「全在文件壳里」）`
    }
    const gap = a.fileMs - a.caseMs
    if (gap < 0) {
      return `  ${pad} 文件 ${msText(a.fileMs).padStart(7)}  用例合计 ${msText(a.caseMs)}（${String(a.cases)} 条）**比文件还长** ⇒ 有并发或重复计数，只能看量级`
    }
    const share = a.fileMs > 0 ? a.caseMs / a.fileMs : 0
    const verdict = share >= 0.9
      ? '⇒ 时间几乎都在用例里（这个文件自己的活，减夹具才有用）'
      : `⇒ ${(100 * gap / a.fileMs).toFixed(0)}% 不在任何用例里（收集/夹具/收尾/runner 停顿）`
    return `  ${pad} 文件 ${msText(a.fileMs).padStart(7)}  用例合计 ${msText(a.caseMs).padStart(7)}（${String(a.cases)} 条，占 ${(100 * share).toFixed(0)}%）  ${verdict}`
  })
  return [head, ...rows]
}
