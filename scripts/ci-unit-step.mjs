#!/usr/bin/env node
/**
 * CI 的「单元测试」步骤包装器 —— 只做一件事：**已归因的假红允许自动重跑一次，并把记录写进 step summary**。
 *
 * 政策（2026-09-24 用户拍板，见 `docs/RELEASE-PLAN.md` 的 N36）：
 * 允许一次「带记录的重跑」，条件三条同时成立 —— ① 退出码非 0；② 日志里有
 * `Timeout calling "onTaskUpdate"`；③ **没有任何失败的文件或用例**。
 * 判定不在这里，是纯函数 `src/backend/tests/helpers/ci-unit-retry.ts`（有用例喂真日志钉着）。
 *
 * 为什么不是"任何失败都重试"：那正是本项目一直禁止的「重试到绿」。区别在于**先归因**：
 * 分段墙钟已经证明这一族越线不在测试代码里（同一个文件本机 51 毫秒、CI 能在 0.54 秒与 23 秒之间摆）。
 *
 * 为什么要写 `$GITHUB_STEP_SUMMARY`：记在日志文件里等于没记 —— 没人会去翻。
 * step summary 直接显示在 PR 页面上，评审的人一眼看得见「这次红过一次、榜首是谁、重跑结果如何」。
 *
 * 本地怎么验（不跑整套测试）：
 *   SUPERTIME_UNIT_CMD='node -e "…"' node scripts/ci-unit-step.mjs
 * 三种输出形状各跑一次，见本 PR 的台账行。
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'

import { classifyRun, fakeRedRecord } from '../src/backend/tests/helpers/ci-unit-retry.ts'

const CMD = process.env.SUPERTIME_UNIT_CMD ?? 'npm test'

/**
 * 跑一次命令，把输出**原样**再打一遍（CI 日志还是要有的），同时留一份给判定用。
 * @param cmd - 要执行的命令行（走 shell）。
 * @returns 退出码与 stdout+stderr 合并文本。
 */
function run (cmd) {
  const r = spawnSync(cmd, { shell: true, encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`
  process.stdout.write(out)
  if (r.error !== undefined) process.stderr.write(`[单测步] 起进程失败：${String(r.error.message ?? r.error)}\n`)
  return { exitCode: typeof r.status === 'number' ? r.status : 1, output: out }
}

/** 把记录写进 step summary（本地没有这个环境变量时安静跳过）。 */
function record (text) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (!file) {
    process.stdout.write('[单测步] 没有 GITHUB_STEP_SUMMARY（本地运行）⇒ 记录只打在标准输出：\n' + text + '\n')
    return
  }
  try {
    appendFileSync(file, text + '\n', 'utf8')
  } catch (err) {
    // 写不进去也不许把这次重跑变成"看起来没问题"——必须喊。
    process.stderr.write(`[单测步] 写 step summary 失败（这次重跑没有留下记录！）：${String((err && err.message) ?? err)}\n`)
  }
}

const first = run(CMD)
if (first.exitCode === 0) process.exit(0)

const kind = classifyRun(first)
if (kind !== 'retryable-fake-red') {
  process.stderr.write('[单测步] 退出码非 0，但不是「已归因的假红」（缺征兆、或有真失败、或看不清汇总行）⇒ **不重跑**\n')
  process.exit(first.exitCode)
}

/**
 * 重跑次数上限。N36 政策原文是「**一次**带记录的重跑」，所以默认 1。
 *
 * 2026-10-16：发布链（`release.yml`）把它提到 3 —— 因为 tag 推送**不会**自动重跑整条
 * 工作流（不像 PR 门禁可以点 re-run），而这类假红是**环境停顿**（分段墙钟已证明不在
 * 测试代码里），CI 上连续两次撞上并不罕见（v1.0.8 发布实测：两次运行都是
 * `5468 passed` + `Timeout calling "onTaskUpdate"` + 退出码 1）。
 * 判据本身没放宽：每一次重跑前都仍要过 `classifyRun` 的三条（退出码非 0 + 有征兆 +
 * **无失败用例**），任何一次出现真失败就立刻红。所以这不是「重试到绿」——
 * 它只是把「环境停顿」的容忍次数按场景调大，而「真失败」一次都不放过。
 */
const MAX_RETRIES = Number(process.env.SUPERTIME_UNIT_MAX_RETRIES ?? '1')

process.stderr.write(`[单测步] 判定为「已归因的 vitest RPC 假红」⇒ 按 N36 政策自动重跑（上限 ${String(MAX_RETRIES)} 次）\n`)
let last = first
for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
  process.stderr.write(`[单测步] 第 ${String(attempt)} 次重跑…\n`)
  last = run(CMD)
  if (last.exitCode === 0) break
  // 重跑若出现真失败（不再是「已归因的假红」），立刻停 —— 不许拿重跑掩盖真红。
  if (classifyRun(last) !== 'retryable-fake-red') {
    process.stderr.write('[单测步] 重跑出现**真失败**（不再是已归因的假红）⇒ 立即停止重跑\n')
    break
  }
}
record(fakeRedRecord(first, last))
process.exit(last.exitCode)
