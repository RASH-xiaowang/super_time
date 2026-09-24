/**
 * 「CI 单测步的假红要不要重跑」—— 判定与记录文案，纯函数。
 *
 * ## 为什么存在
 *
 * N36 那条红长这样：`Test Files/Tests 全部 passed` + 只有 `Errors 1 error` +
 * `Error: [vitest-worker]: Timeout calling "onTaskUpdate"` + 退出码 1。
 * 2026-09-24 用分段墙钟（第 ⑩ 步）证明这类越线**不在测试代码里**（同一个文件本机 51 毫秒，
 * CI 能在 0.54 秒与 23.0 秒之间摆），于是它变成了「环境停顿」而不是「代码缺陷」。
 *
 * 用户据此定的政策是：**有条件重跑一次并留记录**。这个文件就是那条政策里"条件"与"记录"的实现，
 * 把它写成纯函数是为了能被真日志喂着测 —— 判定错方向的代价是让真失败悄悄变绿，那是本项目
 * 最不能接受的一种错。
 *
 * ## 边界（三条必须同时成立才允许重跑）
 *
 * ① 退出码非 0；② 日志里有那条 RPC 超时征兆；③ **没有任何失败的文件或用例**。
 * 任何一条不成立都判 `failure` —— 特别是"既有真红用例、又有超时"的那次，宁可让它红着。
 *
 * @module tests/helpers/ci-unit-retry
 */

import { stripLogNoise } from './ci-board-history.ts'

/** 一次单测步运行的分类结果。 */
export type RunOutcome = 'pass' | 'retryable-fake-red' | 'failure'

/** 一次运行的原始材料。 */
export interface RunResult {
  /** 进程退出码。 */
  exitCode: number
  /** stdout + stderr 合在一起的全文（未去 ANSI 也行，本模块自己会去）。 */
  output: string
}

const RPC_TIMEOUT = /Timeout calling "onTaskUpdate"|\[vitest-worker\]:/

/**
 * 去噪：ANSI + 行首 ISO 时间戳。
 *
 * 复用 {@link module:tests/helpers/ci-board-history} 里那一份（同一个坑不必修两次：
 * 时间戳后只能吃掉**一个**空格，否则会把靠缩进对齐的行吃坏）。
 */
function clean (raw: string): string {
  return stripLogNoise(raw)
}

/** 一行汇总里的 passed / failed 计数；vitest 打的是 `Test Files␣␣223 passed`（两个空格），所以 `\s+`。 */
function countsOf (output: string, label: string): { passed: number, failed: number } {
  const line = output.split(/\r?\n/).find(l => new RegExp(`^\\s*${label}\\s+\\d`).test(l))
  if (line === undefined) return { passed: -1, failed: -1 }
  // 传进来的文本已经过 {@link clean}，这里只按字段抓（两种顺序都见过：`1 failed | 222 passed`）。
  const passed = /(\d+) passed/.exec(line)?.[1]
  const failed = /(\d+) failed/.exec(line)?.[1]
  return { passed: Number(passed ?? -1), failed: Number(failed ?? 0) }
}

/**
 * 分类这一次运行。
 * @param r - 退出码与日志全文。
 * @returns `pass`（退出码 0）/ `retryable-fake-red`（三条边界全过）/ `failure`（别碰）。
 */
export function classifyRun (r: RunResult): RunOutcome {
  const text = clean(r.output)
  if (r.exitCode === 0) return 'pass'
  if (!RPC_TIMEOUT.test(text)) return 'failure'
  const files = countsOf(text, 'Test Files')
  const tests = countsOf(text, 'Tests')
  // `-1` 意味着连汇总行都没找到 —— 那就不是「大家都过了只是超时」，别猜。
  if (files.passed < 0 || tests.passed < 0) return 'failure'
  if (files.failed > 0 || tests.failed > 0) return 'failure'
  return 'retryable-fake-red'
}

/** 从日志里摘出那几条汇总，供记录文案用。 */
export function summarizeRun (r: RunResult): string {
  const text = clean(r.output)
  const grab = (label: string): string => {
    const l = text.split(/\r?\n/).find(x => new RegExp(`^\\s*${label}\\s+\\d`).test(x))
    return l === undefined ? `${label}：没找到汇总行` : l.trim()
  }
  const top = /^\s*1\.\s+([0-9.]+\s*(?:ms|s)).*?\s{2,}(\S+\.[cm]?[jt]sx?)/m.exec(text)
  return [
    `· ${grab('Test Files')}`,
    `· ${grab('Tests')}`,
    top === null ? '· 这份日志里没有 `[耗时榜]`（榜是 #97 才上的），榜首无从引用' : `· 那一次的榜首：\`${top[2]}\` **${top[1]}**`,
  ].join('\n')
}

/**
 * 写进 `$GITHUB_STEP_SUMMARY` 的那段记录（PR 页面直接看得见 —— 政策要求"留记录"，
 * 记在没人会看的日志文件里等于没记）。
 * @param first - 第一次运行的原始材料。
 * @param second - 重跑的结果（可能还没跑完时为 `null`）。
 * @returns markdown 文本。
 */
export function fakeRedRecord (first: RunResult, second: RunResult | null): string {
  const lines = [
    '### 单测步出现过一次「已归因的 vitest RPC 假红」，本步自动重跑了一次',
    '',
    '判据（三条同时成立才允许，见 `src/backend/tests/helpers/ci-unit-retry.ts`）：'
    + '退出码非 0 + 日志里有 `Timeout calling "onTaskUpdate"` + **没有任何失败的文件或用例**。',
    '政策出处：`docs/RELEASE-PLAN.md` 的 N36（2026-09-24 用户拍板「有条件重跑一次并留记录」）；'
    + '为什么这类越线不是代码缺陷：第 ⑩ 步的分段墙钟（同一个文件本机 51 毫秒、CI 能在 0.54 秒与 23 秒之间摆）。',
    '',
    '**第一次运行的读数：**',
    summarizeRun(first),
  ]
  if (second !== null) {
    lines.push('', `**重跑结果：退出码 ${String(second.exitCode)}**`)
    lines.push(summarizeRun(second))
    if (second.exitCode !== 0) {
      lines.push('', '重跑仍然非 0 ⇒ **这一步就是红的**，政策只允许一次带记录的重试，没有第二次。')
    }
  }
  return lines.join('\n')
}
