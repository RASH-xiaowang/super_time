/**
 * 版本号只有一个来源：`package.json` 的 `version`。
 *
 * `CHANGELOG.md` 的「版本策略」把这条写成了纪律 —— 发版时「先改 package.json」。
 * 但纪律靠人记就会漏：2026-09-20 发 1.0.5 时发现 `OnboardingShell.tsx` 里还写着
 * `'1.0.4'`，那条纪律本身没坏、漏的是「改完 package.json 之后还有哪里要跟」。
 *
 * 所以这里钉住两件事：
 *   · 启动页显示的版本必须等于 `package.json` 的版本（它是用户唯一能看到的版本号）；
 *   · `main.js` 不许写死版本字面量（它按策略从 package.json 读，写死就等于有了第二个源）。
 *
 * 标注：根治做法是让渲染层从主进程拿版本（现在 `app:versions` 只回 Electron/Chrome/Node，
 * 不含应用版本），但那要改启动页的渲染逻辑，而 `ui-app/**` 不在类型检查内、首启页又无法
 * 在本机做真机验收 —— 留到能验证时再动，这里先用守卫保证「不漏跟」。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8')

const pkgVersion = (JSON.parse(read('package.json')) as { version: string }).version

describe('版本号一致性', () => {
  /**
   * 2026-10-12：`APP_VERSION` 从 `OnboardingShell.tsx` 搬到了 `onboarding/runtime.ts`
   * （拆屏时四页与壳都要用它，放壳里会变成「壳 → 页 → 壳」的循环导入）。
   * 判据跟着搬，**语义没变**：那仍然是「关于」页显示的兜底版本，仍必须等于 package.json。
   */
  const APP_VERSION_FILE = 'src/client/ui-app/onboarding/runtime.ts'
  const appVersionSrc = read(APP_VERSION_FILE)

  it('启动页显示的版本等于 package.json 的版本', () => {
    const m = /const APP_VERSION = '([^']+)'/.exec(appVersionSrc)
    // 防空转：正则没匹配到时，下面的断言会变成「undefined === 1.0.x」这种看不懂的失败。
    expect(m, `${APP_VERSION_FILE} 里找不到 APP_VERSION 字面量（改名后请同步本用例）`).not.toBeNull()
    expect(m![1], '启动页版本落后于 package.json —— 用户会在首启页看到旧版本号').toBe(pkgVersion)
  })

  /**
   * 兜底之外还有一条**真路径**：主进程 `app:versions` 现在下发 `app.getVersion()`
   * （2026-10-12 补，正是本文件头注释里「根治做法是让渲染层从主进程拿版本」那笔欠账）。
   * 要求两件事同时成立，缺一件就是「要么永远显示兜底值、要么主进程没这个字段」：
   *   ① 主进程真把 app 版本放进 `app:versions`；
   *   ② 界面优先用它，而不是把下发值丢掉。
   */
  it('主进程下发应用版本，且界面优先用它而不是兜底字面量', () => {
    const ipc = read('src/backend/ipc-misc.js')
    expect(ipc, 'app:versions 没有下发 app 版本').toMatch(/app:\s*app\.getVersion\(\)/)
    const about = read('src/client/ui-app/onboarding/pages/AboutPage.tsx')
    expect(about, '关于页没有优先用主进程下发的版本').toContain('versions?.app ?? APP_VERSION')
  })

  it('main.js 不写死版本号，而是从 package.json 读', () => {
    const src = read('main.js')
    expect(src, 'main.js 应当 require package.json 取版本').toContain("require('./package.json').version")
    const hardcoded = /APP_VERSION\s*=\s*['"]\d+\.\d+\.\d+/.exec(src)
    expect(hardcoded?.[0] ?? null, 'main.js 里出现了写死的版本字面量').toBeNull()
  })

  it('版本号是合法 semver（防空转：读到的确实是版本号）', () => {
    expect(pkgVersion).toMatch(/^\d+\.\d+\.\d+$/)
  })
})
