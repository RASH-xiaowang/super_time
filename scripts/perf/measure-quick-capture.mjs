#!/usr/bin/env node
/**
 * 跑 `npm run measure:quick` 并把「全部读数」落成可对比的 JSON + 原始日志。
 *
 * 为什么再包一层：`npm run measure:quick` 只把读数打到 stdout，跨运行对比时只能靠人眼；
 * 这里把 stdout 原样存进 `*.log`（唯一的原始读数），再抽一份结构化的
 * `*.json`（每个基准文件的耗时 + 命中 RSS/中位/倍率等关键行），给 02-BASELINE 的
 * 「后端基准」一节引用。
 *
 * 用法：
 *   node scripts/perf/measure-quick-capture.mjs --out=working/perf/baseline/measure-quick.json
 *
 * 说明：跑的是仓库既有 runner（`scripts/run-measures.mjs quick`），不改任何基准；
 * 时长约 27s（本机实测 27.5s，18 文件 21 用例）。
 */

import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, strArg } from './lib/args.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const { values } = parseArgs(process.argv.slice(2))
const outRaw = strArg(values, 'out', join('working', 'perf', 'baseline', 'measure-quick.json'))
const OUT = isAbsolute(outRaw) ? outRaw : join(ROOT, outRaw)
const LOG = OUT.replace(/\.json$/, '') + '.log'
mkdirSync(dirname(OUT), { recursive: true })

/** 去掉 ANSI 颜色控制符（stdout 是 TTY/管道混合时会带）。 */
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '')

/** 把 "10.0s" / "475ms" 换成毫秒数。 */
function toMs (value, unit) {
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return unit === 's' ? Math.round(n * 1000) : n
}

const startedAt = new Date().toISOString()
const t0 = Date.now()
const chunks = []
const proc = spawn(process.execPath, [join(ROOT, 'scripts', 'run-measures.mjs'), 'quick'], {
  cwd: ROOT,
  env: { ...process.env },
  stdio: ['ignore', 'pipe', 'pipe'],
})
proc.stdout.on('data', (d) => chunks.push(d))
proc.stderr.on('data', (d) => chunks.push(d))
const exitCode = await new Promise((resolve) => proc.on('exit', (code) => resolve(code ?? 1)))
const durationMs = Date.now() - t0
const raw = stripAnsi(Buffer.concat(chunks).toString('utf8'))
writeFileSync(LOG, raw, 'utf8')

const lines = raw.split(/\r?\n/)
const text = raw

const summary = {
  schemaVersion: 1,
  tool: 'scripts/perf/measure-quick-capture.mjs',
  command: 'node scripts/run-measures.mjs quick（= npm run measure:quick）',
  startedAt,
  durationMs,
  exitCode,
  rawLog: LOG,
  totals: {
    testFiles: Number((text.match(/Test Files\s+(\d+)\s+passed/) ?? [])[1] ?? 0) || null,
    tests: Number((text.match(/Tests\s+(\d+)\s+passed/) ?? [])[1] ?? 0) || null,
    vitestDuration: (text.match(/Duration\s+([\d.]+)s/) ?? [])[1] != null ? Number((text.match(/Duration\s+([\d.]+)s/) ?? [])[1]) : null,
  },
  /** 每个基准文件的耗时（从 vitest 的"单文件/用例耗时榜"里取，能直接和改动前后比）。 */
  benchmarkFiles: [],
  /** 最慢用例 Top10（仓库 runner 自带的"耗时榜"）。 */
  slowestCases: [],
  /** 关键读数行（中位/RSS/倍率/占比/峰值），JSON 里保留以支持 grep 对比。 */
  readingLines: [],
}

for (const line of lines) {
  const m = line.match(/^\s+(src\/\S+\.spec\.ts)\s+文件\s+([\d.]+)(ms|s)\s+用例合计\s+([\d.]+)(ms|s)/)
  if (m) {
    summary.benchmarkFiles.push({ file: m[1], fileMs: toMs(m[2], m[3]), casesMs: toMs(m[4], m[5]) })
    continue
  }
  const slow = line.match(/^\s*\d+\.\s+([\d.]+)(ms|s)\s+占该文件\s+(\d+)%\s+(src\/\S+\.spec\.ts)\s+›\s+(.+)$/)
  if (slow) {
    summary.slowestCases.push({ file: slow[4], case: slow[5].trim(), ms: toMs(slow[1], slow[2]), pctOfFile: Number(slow[3]) })
    continue
  }
  if (/(中位|RSS|加速|倍率|占比|峰值|耗时|比值|ms|×)/.test(line) && line.trim() !== '') {
    const clean = line.replace(/\s+/g, ' ').trim()
    if (clean.length > 8 && summary.readingLines.length < 500) summary.readingLines.push(clean)
  }
}
summary.benchmarkFiles.sort((a, b) => a.file.localeCompare(b.file))
writeFileSync(OUT, JSON.stringify(summary, null, 2) + '\n', 'utf8')

console.log(`[measure-quick] exit=${exitCode} duration=${(durationMs / 1000).toFixed(1)}s files=${summary.totals.testFiles} tests=${summary.totals.tests}`)
console.log(`[measure-quick] 原始日志：${LOG}`)
console.log(`[measure-quick] 结构化读数：${OUT}（${summary.benchmarkFiles.length} 个基准文件，${summary.readingLines.length} 行读数）`)
for (const b of summary.benchmarkFiles) console.log(`  ${String(b.fileMs).padStart(6)}ms  ${b.file}`)
process.exitCode = exitCode
