/**
 * N32 后半：两个测试目录的类型错误**棘轮**（只能降，不能升）。
 *
 * 为什么要棘轮而不是一句「以后再说」：`src/backend/tests` 与 `src/backend/wechat-data/tests`
 * 一共 152 个文件从没被类型检查看过 —— vitest 用 esbuild 只剥类型不查类型。本仓库大量守卫是
 * 「读源码做断言」，它们自己的参数形状、被改名后的方法名、`noUncheckedIndexedAccess` 下的
 * 下标取值，全靠跑到运行时才暴露；一条恒真的断言比没有断言更危险，因为它会让人以为那条命题有人守着。
 *
 * 一次性收口 176 处不现实，但**放任它继续长**是更糟的选择，所以这里钉一个只降不升的天花板：
 * 谁新增一个错误，CI 就红，并且报出行号；修掉一批之后把 `BASELINE` 改成新数字（改小）。
 *
 * 降到 0 之后该做什么：把这份配置串进 `npm run typecheck`（`typecheck:tests`），
 * 然后把本文件换成「0 错误」的硬断言 —— 棘轮是过渡手段，不是终点。
 * 参照同族做法：M21 的大文件行数也是棘轮 + 白名单，效果是它没有再反弹过。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '..', '..', '..')
const CFG = join(ROOT, 'src', 'backend', 'tsconfig.tests.json')
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

/**
 * 收口前测得的基线（2026-09-23）：191 处 → 先修掉两类**信号最强**的（5 处 `@ts-expect-error`
 * 已经不再需要、10 处同一模块被 import 两遍）→ 176。
 * 剩下的分布：TS2532 69、TS2345 28、TS7006 20、TS18048 15、TS2339 12、TS2322 10、TS7005 4、TS7034 3、其余 15。
 */
const BASELINE = 176

/** program 里应当出现的测试文件数下限（防空转：把 include 改窄就能"通过"这条守卫）。 */
const MIN_TEST_FILES = 150

function runTsc (args: string[]): string {
  try {
    return execFileSync(process.execPath, [TSC, ...args], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (e) {
    // tsc 有错误时退出码非 0，但 stdout 仍然带着全部诊断 —— 棘轮要的就是那份输出。
    const err = e as { stdout?: string; stderr?: string; message?: string }
    return (err.stdout ?? '') + (err.stderr ?? '')
  }
}

const out = runTsc(['-p', 'src/backend/tsconfig.tests.json', '--noEmit'])
const errorLines = out.split(/\r?\n/).filter((l) => /error TS\d+/.test(l))
const listed = runTsc(['-p', 'src/backend/tsconfig.tests.json', '--noEmit', '--listFilesOnly'])
  .split(/\r?\n/)
  .map((f) => f.replace(/\\/g, '/'))
  .filter((f) => /\.spec\.ts$/.test(f))

describe('N32 后半：测试目录的类型错误只能降不能升', () => {
  it('tsconfig.tests.json 存在，且用的就是后端那份基座（不是客户端的）', () => {
    expect(existsSync(CFG), '缺少 src/backend/tsconfig.tests.json').toBe(true)
    const cfg = JSON.parse(readFileSync(CFG, 'utf8')) as { extends?: string }
    expect(cfg.extends, '测试文件要按后端的严格度查；客户端基座与它无关').toBe('../../tsconfig.base.json')
  })

  it('program 真的覆盖到那 152 个测试文件（不是把 include 改窄来凑数）', () => {
    expect(listed.length, `--listFilesOnly 里只有 ${String(listed.length)} 个 .spec.ts，八成是解析失败`)
      .toBeGreaterThanOrEqual(MIN_TEST_FILES)
  })

  it(`错误数不超过基线 ${String(BASELINE)}（修掉一批就把基线改小）`, () => {
    expect(errorLines.length, '新增的类型错误：\n' + errorLines.slice(0, 12).join('\n'))
      .toBeLessThanOrEqual(BASELINE)
  })

  it('基线本身不许被悄悄抬高（改小可以，改大要在 PR 里说清）', () => {
    // 这条守的是「棘轮只能降」：有人把 BASELINE 改大，就得同时在这里解释为什么。
    expect(BASELINE, 'BASELINE 只能改小；要改大请在 RELEASE-PLAN 台账里写明理由').toBeLessThanOrEqual(191)
  })
})
