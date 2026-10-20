/**
 * 面板懒加载入口的源码守卫（panel-loaders.tsx ↔ WechatDataPanel.tsx）。
 *
 * 这条边界只有一种“看着正常、其实退化”的方式：某个页签被改回静态 import，
 * 构建仍然成功、面板仍然能打开，只是首屏又把整块面板代码拉了回来。typecheck
 * 和普通 build 都抓不到这一点，所以把三件事钉在源码上：
 *  ① loader 里的每个面板必须仍是 `lazy(() => import(...))`，且目标文件存在；
 *  ② renderTab 里出现的面板集合必须恰好等于 loader 的集合（外加常驻 MergedSections）；
 *  ③ WechatDataPanel 不能从 `./panels/*` 做值导入 —— 类型导入允许，不参与运行图。
 * @vitest-environment node
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, findRoot, readStripped, sliceBetween } from '../../test-helpers/wiring-kit.ts'

const ROOT = findRoot(import.meta.dirname)
const DATA_DIR = join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data')
const LOADERS = readStripped(join(DATA_DIR, 'panel-loaders.tsx'))
const SHELL = readStripped(join(DATA_DIR, 'WechatDataPanel.tsx'))

/** loader 中 `名字 -> 相对 import 目标` 的登记项。 */
function loaderEntries(src: string): Array<{ name: string; target: string }> {
  return [...src.matchAll(/^export const ([A-Za-z0-9_]+) = lazy\(\(\) => import\('([^']+)'\)/gm)]
    .map((m) => ({ name: m[1] ?? '', target: m[2] ?? '' }))
}

/** WechatDataPanel 对指定面板文件的所有值导入（类型导入不算，它不参与运行图）。 */
function valuePanelImports(shell: string, targets: readonly string[]): string[] {
  const out: string[] = []
  for (const target of targets) {
    const file = target.split('/').pop() ?? ''
    if (!file) continue
    const re = new RegExp(`(import\\s+[^'"]*?)from\\s+'${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'g')
    for (const m of shell.matchAll(re)) {
      if (!/^import\s+type\b/.test(m[1] ?? '')) out.push(file)
    }
  }
  return out
}

describe('panel-loaders：按 tab 懒加载不能被重新长回静态入口', () => {
  it('哨兵：loader 与主容器都真的读到了', () => {
    expect(LOADERS.length, 'panel-loaders.tsx 读不到或剥没了').toBeGreaterThan(2000)
    expect(SHELL.length, 'WechatDataPanel.tsx 读不到或剥没了').toBeGreaterThan(20000)
  })

  it('29 个面板入口都存在，且每一个仍是动态 import', () => {
    const entries = loaderEntries(LOADERS)
    atLeast(entries.length, 29, 'loader 登记数')
    for (const { name, target } of entries) {
      expect(name, 'loader 名字为空').not.toBe('')
      expect(target, `${name} 的 import 目标为空`).toMatch(/^\.\/panels\/[^']+\.tsx$/)
      expect(existsSync(join(DATA_DIR, target.replace('./', ''))), `${target} 不存在`).toBe(true)
      expect(LOADERS, `${name} 改成静态 import 后不再走懒加载`).toContain(`lazy(() => import('${target}')`)
    }
    expect(LOADERS, 'loader 自己出现了面板目录的值导入（那会重新并进主包）').not.toMatch(/from '\.\/panels\//)
  })

  it('renderTab 的面板集合与 loader 一一对应，只有 MergedSections 是常驻壳', () => {
    const entries = loaderEntries(LOADERS)
    const render = sliceBetween(SHELL, 'function renderTab(', '\nconst DIALOG_SECTION_OF:', 'renderTab 函数')
    const used = [...new Set([...render.matchAll(/<([A-Z][A-Za-z0-9]*)(?=[\s/])/g)].map((m) => m[1] ?? ''))].sort()
    /*
     * ⚠️ 2026-10-17：`PrivacyPanel` 从 renderTab 移出（隐私体检迁进「设置」弹窗，
     * 改由 `Settings.tsx` 消费）。它仍在 loader 里（懒加载边界不变），但不再出现在
     * renderTab 的组件集合里 —— 所以要从 expected 里排除。
     * 这类「由别的面板消费的 loader」都记在这里，别逐个写 if。
     *
     * ⚠️ 2026-10-17 同日：`DailySummaryPanel` / `PeriodSummaryPanel` 合并成
     * `SummaryWorkbench`（一个时间范围驱动的工作台）。两个旧 loader 保留导出
     * （删导出会连带改一堆守卫断言），但 renderTab 里只剩 `SummaryWorkbench`。
     */
    const CONSUMED_ELSEWHERE = new Set(['SettingsPanel', 'PrivacyPanel', 'DailySummaryPanel', 'PeriodSummaryPanel'])
    const expected = [...new Set(entries.map((e) => e.name).filter((n) => !CONSUMED_ELSEWHERE.has(n))), 'MergedSections'].sort()
    // 27 = 合并前 28 个面板 − 2 个旧总结面板 + 1 个 SummaryWorkbench。
    atLeast(used.length, 27, 'renderTab 的面板调用数')
    expect(used, 'renderTab 的面板集合与 loader 不一致：少接的会落占位页，多出的会被静态打包').toEqual(expected)
  })

  it('设置面板独立懒加载，并自带 Suspense 边界', () => {
    expect(LOADERS).toContain("export const SettingsPanel = lazy(() => import('./panels/Settings.tsx')")
    expect(LOADERS).toContain('export function SettingsPanelGate')
    expect(LOADERS).toMatch(/<Suspense[\s\S]*<SettingsPanel \{\.\.\.props\} \/>[\s\S]*<\/Suspense>/)
    expect(SHELL, '设置弹窗没有经过 SettingsPanelGate').toContain('<SettingsPanelGate')
  })

  it('主容器不把 lazy 目标面板做成值导入（类型导入可以保留）', () => {
    const targets = loaderEntries(LOADERS).map((e) => e.target)
    expect(valuePanelImports(SHELL, targets), '这些面板被直接值导入，不再走 lazy 边界').toEqual([])
  })

  it('反例自证：把 OverviewPanel 改回静态导入会被同一条判据抓住', () => {
    const targets = loaderEntries(LOADERS).map((e) => e.target)
    const fake = SHELL.replace(
      "} from './panel-loaders.tsx'",
      "} from './panel-loaders.tsx'\nimport { OverviewPanel } from './panels/Overview.tsx'",
    )
    expect(valuePanelImports(fake, targets), '合成静态导入没被抓住 ⇒ 这条守卫是空的').toContain('Overview.tsx')
    expect(valuePanelImports(SHELL, targets), '现仓本来就命中静态导入 ⇒ 上面那条是假绿').toEqual([])
  })
})
