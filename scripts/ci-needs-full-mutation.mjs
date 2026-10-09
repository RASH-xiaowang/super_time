#!/usr/bin/env node
/**
 * 供 GitHub Actions 的 job 级条件用：这次改动**要不要**跑全量变异反证？
 *
 * ## 为什么需要一个脚本
 *
 * Actions 的 job 级 `if:` 表达式**做不了文件匹配**（不能「改动里有没有某个路径」），
 * 而「变异登记表本身被动」正是必须跑全量的那种情况 ——
 * `scripts/mutation-scope.mjs` 的逻辑是：登记表一改，筛选基准就变了，按文件筛没有意义。
 *
 * 所以按 Actions 的标准写法：先跑一个极快的探针步骤，把结论写成 step output，
 * 后面那个重 job 用 `if: steps.x.outputs.y == 'true'` 决定要不要起。
 *
 * ## 为什么不直接让增量脚本自己扛
 *
 * 全量 408 条按每条约 4 秒估是 25~30 分钟，而 `verify` 那条 job 的单测已占 26 分钟、
 * 上限 45 分钟 —— 塞进去会整条被杀掉。那种失败信号（「作业超时」）比「用例失败」更难查，
 * 所以宁可多一个只在需要时才起的 job。
 *
 * ## 拿不到 diff 时输出什么
 *
 * 输出 `true`（= 要跑全量）。理由与增量脚本一致：**静默跳过是最坏的结果** ——
 * 看起来门禁是绿的，实际什么都没验。宁可多跑一次。
 *
 * 用法：`node scripts/ci-needs-full-mutation.mjs <git ref>`（默认 `HEAD~1`）
 */
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { REGISTRY_PATH_RE } from './mutation-scope.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ref = process.argv[2] || process.env.SUPERTIME_MUTATION_BASE || 'HEAD~1'

/** Actions 的 step output 用 `$GITHUB_OUTPUT` 收集；不在 Actions 里时只打印。 */
const emit = (k, v) => {
  if (process.env.GITHUB_OUTPUT) process.stdout.write(k + '=' + v + '\n')
  else process.stdout.write(k + '=' + v + '\n')
}

let files = []
let ok = true
try {
  files = execFileSync('git', ['diff', '--name-only', ref + '...HEAD'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter((s) => s !== '')
} catch {
  ok = false
}

const touched = files.filter((f) => REGISTRY_PATH_RE.test(f.replace(/\\/g, '/')))
const need = ok && touched.length === 0 ? 'false' : 'true'
emit('needs_full_mutation', need)
emit('reason', ok
  ? (touched.length > 0 ? '登记表被改动：' + touched.join(', ') : '登记表未被动 ⇒ 增量档足够')
  : '取 ' + ref + '...HEAD 失败 ⇒ 按「宁可多跑」处理，跑全量')
