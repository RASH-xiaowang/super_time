#!/usr/bin/env node
/**
 * 受影响测试（pre-push / 本地快速反馈）。
 *
 * 为什么要有：全量单测约 26 分钟，`check:mutation` 全量更久；而大多数改动只影响少量
 * spec。`vitest related` 能按 import 关系挑出受影响测试，但前提是**把工作树里未提交的
 * 改动也算进去** —— 否则本地改完直接 pre-push，门禁只看到已提交部分，正好漏掉当前改动。
 *
 * 这里复用 `mutation-scope.changedFilesForGate`（ref...HEAD + unstaged + staged +
 * untracked），过滤掉非源码/临时目录，再交给 `vitest related --run`。
 *
 * 用法：
 *   node scripts/affected-tests.mjs --list          # 只列将跑的输入文件
 *   node scripts/affected-tests.mjs                 # 跑相关 spec
 *   node scripts/affected-tests.mjs --base HEAD~3   # 指定基线
 *
 * 注意：`related` 只按 import 关系，不覆盖“文本判据读源码”的守卫；后者仍由
 * `npm test` / CI 全量兜底。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { changedFilesForGate } from './mutation-scope.mjs'

const ROOT = join(import.meta.dirname, '..')
const VITEST = join(ROOT, 'node_modules', 'vitest', 'vitest.mjs')
const argv = process.argv.slice(2)
const listOnly = argv.includes('--list')
const base = argv.includes('--base') ? argv[argv.indexOf('--base') + 1] : 'HEAD'

const EXCLUDED = [/^working\//, /^\.tmp/, /^node_modules\//, /^src\/backend\/wechat-data\/lib\//, /^src\/client\/ui-dist\//]

const changed = changedFilesForGate(base, ROOT)
if (!changed.ok) {
  process.stderr.write(`取 ${base} 之后的改动失败：${changed.detail}\n`)
  process.exit(1)
}
const files = changed.files.filter((file) => (
  !EXCLUDED.some((re) => re.test(file)) && existsSync(join(ROOT, file))
))

process.stdout.write(`[affected] ${base}...HEAD + 工作树：${String(changed.detail)}；可测源码 ${String(files.length)} 个\n`)
if (listOnly) {
  for (const file of files) process.stdout.write(`  ${file}\n`)
  process.exit(0)
}
if (files.length === 0) {
  process.stdout.write('[affected] 没有可测源码改动，跳过\n')
  process.exit(0)
}

const result = spawnSync(process.execPath, [VITEST, 'related', '--run', '--passWithNoTests', ...files], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
})
process.exit(result.status ?? 1)
