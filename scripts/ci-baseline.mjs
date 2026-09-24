#!/usr/bin/env node
/**
 * 采一份「本机串行基线」到 `src/backend/tests/fixtures/ci/local-baseline.json`。
 *
 * ## 为什么要这份产物
 *
 * N36 的口径 ① 说「**A 类**榜首中位 ≤15 秒」，可 `npm run ci:board-history` 手上只有 CI 的数 ——
 * 它分不清某个文件是「本机就要跑这么久」还是「本机几十毫秒、CI 上被停顿拖长」。
 * 这条区分要本机数才能算，所以有这一个脚本。
 *
 * ## 为什么写死串行
 *
 * CI 的 `maxWorkers: 1`（见 `vitest.config.ts`）。本机并行跑与它**不可比** ——
 * 同一个文件并行 2.4 秒、串行 586 毫秒。所以这里不带 `--no-file-parallelism` 就等于产出一份
 * 会把 B 类误判成 A 类的基线。
 *
 * 用法：`npm run ci:baseline`（手动跑，约两分钟；**不进 CI 门禁** —— 它要在开发者机器上量，
 * 拿共享 runner 的量出来就不是本机基线了）。
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { baselineProblems } from '../src/backend/tests/helpers/local-baseline.ts'

const OUT = 'src/backend/tests/fixtures/ci/local-baseline.json'

const headSha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim()
console.log(`[基线] 本机串行量一遍全套（HEAD=${headSha}）—— 这段时间不要同时跑别的东西，噪声会写进基线里`)

const res = spawnSync('npx vitest run --no-file-parallelism', {
  encoding: 'utf8',
  shell: true,
  maxBuffer: 1 << 29,
  env: { ...process.env, SUPERTIME_BASELINE: '1' },
})
const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
if (res.status !== 0 && /\+ \d+ failed/.test(out)) {
  console.error('[基线] 这一轮有失败用例 ⇒ 不写产物（半份基线比没有基线更坏）')
  process.exit(2)
}

const files = {}
for (const line of out.split(/\r?\n/)) {
  const m = /^(\d+)\t(\S+\.spec\.[cm]?[jt]sx?)$/.exec(line.replace(/\r$/, ''))
  if (m === null) continue
  const ms = Number(m[1])
  const name = m[2].replace(/\\/g, '/')
  // 同一个文件被跑两次（多 test 步）时取**最大**的一次：基线是用来当下界比较的分母，
  // 取小的那次会让倍率虚高。
  if (files[name] === undefined || ms > files[name]) files[name] = ms
}

const made = { headSha, measuredAt: new Date().toISOString(), mode: 'serial', files }
const problems = baselineProblems(made)
if (problems.length > 0) {
  console.error('[基线] 采出来的东西不自洽，不写产物：')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(2)
}

const sorted = Object.fromEntries(Object.entries(files).sort((a, b) => b[1] - a[1]))
// 产物目录是新的；writeFileSync 不会自己建目录（第一次跑就死在这里）。
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, `${JSON.stringify({ ...made, files: sorted }, null, 1)}\n`, 'utf8')
const rows = Object.entries(sorted)
console.log(`[基线] 写了 ${String(rows.length)} 个文件 → ${OUT}`)
console.log(`[基线] 本机最慢的五名：${rows.slice(0, 5).map(([k, v]) => `${k.split('/').pop()} ${(v / 1000).toFixed(1)}s`).join('、')}`)
