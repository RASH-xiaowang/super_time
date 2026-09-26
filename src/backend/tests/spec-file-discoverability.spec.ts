/**
 * 「写了用例」不等于「用例会跑」：测试文件的扩展名必须落在 runner 的 include 名单里。
 *
 * ## 起因（本轮真实踩到）
 *
 * 给文本气泡补可点性守卫时，先写成了 `message-text-clickable.spec.tsx`（含 JSX 的组件用例
 * 很自然会想到 `.tsx`）。`npx vitest run <该文件>` 的输出是
 * **`No test files found` + 退出码 1** —— 手工指名还能看见；
 * 而 `npm test` 全量跑的时候它只是**安静地不存在**，绿照给。
 * 根 `vitest.config.ts` 的 include 只列了 `.spec.ts`。
 *
 * ## 判据
 *
 * 不 hardcode 名单，而是**从配置里读 include** 再把每个测试命名文件拿去匹配：
 * 将来加了 `.spec.tsx` 的支持（改配置），这里自动放宽；反过来加了新目录却忘了扩 include，
 * 这里立刻指出「这个文件 runner 看不见」。
 * @vitest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CONFIG = 'vitest.config.ts'

/**
 * 不纳入判据的目录。
 *
 * `src/backend/deps/` 是随包签进来的**上游/自有依赖副本**（cordis、zod、koffi、dsh-*…），
 * 那里也有 `tests/*.spec.ts`，但 `vitest.config.ts` 的口径写得很明白：本项目的单测范围是
 * 「后端包 + 宿主层 + 前端纯逻辑」，依赖自带用例不在其中（它们跟着依赖版本走，不是本仓库的契约）。
 * 这个豁免是**有意的边界**，不是把问题扫到地毯下：判据要盯的是「我们自己写的用例没人跑」。
 */
const EXCLUDED_DIRS = ['deps', 'node_modules', 'ui-dist', 'dist', 'fixtures', 'native']

/** 看起来像测试文件的命名（不限扩展名）—— 判据要能认出 `.spec.tsx` 这种跑不起来的写法。 */
function testNamedFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      if (EXCLUDED_DIRS.includes(e.name)) continue
      const rel = `${dir}/${e.name}`
      if (e.isDirectory()) { walk(rel); continue }
      if (/\.spec\.(ts|tsx|js|jsx|mjs|cjs)$/.test(e.name)) out.push(rel)
    }
  }
  walk('src')
  walk('scripts')
  return out.sort()
}

/** 从 vitest 配置里读出 include 的 glob 名单。 */
function includeGlobs(): string[] {
  const src = readFileSync(join(ROOT, CONFIG), 'utf8')
  const block = /include:\s*\[([\s\S]*?)\]/.exec(src)
  const body = block?.[1]
  if (body === undefined) throw new Error(`${CONFIG} 里找不到 include:[...] —— 判据需要先更新`)
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]).filter((g): g is string => typeof g === 'string')
}

/** 只支持这份配置实际用到的语法：`**\/`、`**`、`*`。 */
function globToRe(glob: string): RegExp {
  const body = glob
    // 先转掉正则元字符（`*` 与 `/` 留给下面按 glob 语义处理）
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // **一趟**替换：分三次 replace 的话，后一次会把前一次插进去的 `[^/]*` 再替换一遍
    .replace(/\*\*\/|\*\*|\*/g, (m) => (m === '**/' ? '(?:[^/]*/)*' : m === '**' ? '.*' : '[^/]*'))
  return new RegExp('^' + body + '$')
}

function runnableByRunner(rel: string, globs: string[]): boolean {
  return globs.some((g) => globToRe(g).test(rel))
}

const files = testNamedFiles()
const globs = includeGlobs()

describe('测试文件必须真的被 runner 收集', () => {
  it('解析有效：扫到了测试文件、也读到了 include 名单（防空转）', () => {
    expect(files.length, '一个测试文件都没扫到 ⇒ 判据恒真').toBeGreaterThan(200)
    expect(globs.length).toBeGreaterThan(2)
    // 反例自证：同一目录、只差扩展名，一个可见一个不可见
    expect(runnableByRunner('src/client/ui-wechat/src/client/pages/x.spec.ts', globs), '匹配器把 .spec.ts 判成不可见').toBe(true)
    expect(runnableByRunner('src/client/ui-wechat/src/client/pages/x.spec.tsx', globs), '.spec.tsx 竟然算可见 ⇒ include 名单变了，判据要跟着改').toBe(false)
    // `**/` 必须允许「零层目录」（`src/backend/tests/x.spec.ts` 就是直接住在目录下）：
    // glob→正则的第一版就是把三次 replace 分开做，结果这条匹配不上，200+ 个文件一起被报瞎。
    expect(runnableByRunner('src/backend/tests/x.spec.ts', globs), '**/ 不接受零层目录 ⇒ 判据会全员误报').toBe(true)
    expect(runnableByRunner('src/backend/wechat-data/tests/a/b/x.spec.ts', globs)).toBe(true)
  })

  it('每个测试文件都在 include 名单覆盖范围内', () => {
    const blind = files.filter((f) => !runnableByRunner(f, globs))
    expect(
      blind,
      `这些文件匹配不上 ${CONFIG} 的 include ⇒ \`npm test\` 永远不会跑它们（写了 = 没写）：\n  `
      + blind.join('\n  ') + '\n  修法：改成 .spec.ts（用 createElement 代替 JSX），或把目录/扩展名加进 include。',
    ).toEqual([])
  })
})
