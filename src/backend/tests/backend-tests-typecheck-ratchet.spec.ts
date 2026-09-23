/**
 * N32 后半：两个测试目录的类型错误**棘轮**（只能降，不能升）。
 *
 * 为什么要棘轮而不是一句「以后再说」：`src/backend/tests` 与 `src/backend/wechat-data/tests`
 * 一共 152 个文件从没被类型检查看过 —— vitest 用 esbuild 只剥类型不查类型。本仓库大量守卫是
 * 「读源码做断言」，它们自己的参数形状、被改名后的方法名、`noUncheckedIndexedAccess` 下的
 * 下标取值，全靠跑到运行时才暴露；一条恒真的断言比没有断言更危险，因为它会让人以为那条命题有人守着。
 *
 * 一次性收口 191 处不现实，但**放任它继续长**是更糟的选择，所以这里钉一个只降不升的天花板：
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
 * 基线的来历（2026-09-23）：第一次量到 **191** 处；先修掉两类信号最强的 → **176**
 * （5 处 `@ts-expect-error` 已经不再需要、`retrieval.spec.ts` 把 `node:fs`/`node:os` 各 import 两遍）；
 * 再修掉一批「推断出来的类型太窄」的 → **162**：
 *   · `diag-log.spec.ts` 的循环引用夹具（`{ a: 1 }` 上没有 `self`）；
 *   · `kb-parse-pdf-env.spec.ts` 直接写 `process.type`（Electron 才有这个字段，@types/node 里没有）；
 *   · `llm-profiles.spec.ts` 里 `store.profiles` 的每一行都被宿主层 JSDoc 写成 `object` ⇒ 给一个行形状别名；
 *   · `llm-retry.spec.ts` 的 `let thrown = null` / `let captured`（推成 `null`/`never`，读字段就撞墙）。
 * 第三步再收 17 处「下标取值可能为 undefined 就直接用」→ **145**：
 * `atomic-json.spec.ts` 四处 `backups[0]`、`ci-script-isolation.spec.ts` 的 `lines[i]` / `m[1]` / `pkg.scripts[m[1]]`。
 * 手法统一为**先判空再往下走**（fail-closed：判不出来就直接抛「这条用例的前提不成立」），
 * 不用 `!` 断言、也不用 `String()` 把 undefined 混成字符串 —— 那两种写法都会让一条本该红的用例继续绿。
 * 第四步把 `llm-retry.spec.ts` 整份收干净（28 处 → 0）→ **117**：假 fetch 的脚本/URL/响应夹具、
 * `RetryInfo[]`、`recorder` 的 `slept`、`signals`、`captured`，以及一个真实的形状不匹配 ——
 * `RetryFetch` 的 `init` 是**可选**参数，把假 fetch 写成 `init: RequestInit`（必填）就不匹配了。
 * 第五步收掉 `llm-rerank.spec.ts` 的 11 处 → **106**：那份文件里 `seen[0].body.model` 一类的下标直取有 10 处，
 * 补了一个 `at(seen, n)` 访问器（没捕到就抛「这条用例的前提不成立」）。这类断言一旦拿到 `undefined`，
 * `expect(undefined?.x).toBe(...)` 会红得莫名其妙，而 `at()` 直接说出是第几次请求没捕到。
 * 第六步清长尾：把每文件只剩 1~2 处的 21 份文件一次收干净 → **79**。
 * 手法是把第五步那个只存在于 `llm-rerank.spec.ts` 里的 `at()` 提成 `tests/helpers/strict-index.ts`
 * （`at()` 取元素、`grp()` 取捕获组，越界/缺组都抛「前提不成立」），于是 `bad[0].rule`、
 * `median: sorted[k]`、`m[1].trim()` 这类一律换成访问器 —— 与其在 20 个文件里各写一遍 `?? ''`，
 * 不如让「前提塌了」在原地就说出自己是谁。两个访问器自带自检（`strict-index.spec.ts`）：
 * 它们是别的应用例的守卫，自己不抛的话整条链就退化成往下读 undefined。
 * 顺带查出两处真的：`search-scope.spec.ts` 把说明文字当第二个实参传给 `.toBe()`（vitest 只认
 * 一个，那条「被吞掉的 int64 异常」的提示从来没显示过 —— 挪到 `expect(值, 说明)` 上）；
 * `kb-eval.spec.ts` 用 `BufferEncoding` 标注一张喂给 `TextDecoder` 的编码表，而 `gb18030`
 * 恰恰不在 `BufferEncoding` 里（Node 的字符串编码是小集合，完整表在 TextDecoder 上），编译器直接判死。
 * 试过给这份配置开 `allowJs`（让 TS 直接读宿主 JS）—— 结果是 162 → 228：它把 JS 源文件本身拉进 program
 * 报出一批与测试无关的错，所以回退了。**别再来试这条路**，要收紧就给具体模块写 `.d.ts`（同 `llm-retry.d.ts`）。
 */
const BASELINE = 51

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
