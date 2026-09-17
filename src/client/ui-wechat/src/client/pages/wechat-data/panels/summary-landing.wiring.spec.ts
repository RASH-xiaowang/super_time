/**
 * 「每日总结」空态落地 + 模型依赖的接线守卫。
 *
 * 背景：这一页在全新用户（0 任务 0 记录）时只有一张空卡 + 一句"还没有定时任务"，
 * 下方 470px 空白；而**最关键的一件事一个字都没说**：总结是由模型生成的，
 * 没配模型时点"生成"必然失败 —— 用户只能靠试错发现。
 *
 * 这里钉四件事：
 *  ① 空态必须给出"三步开始"（配置模型 / 手动生成 / 定时任务）与"总结长什么样"；
 *  ② 模型状态要真的读一次配置（`apiGetLlmConfig`），未配置时给"去配置"；
 *  ③ "去配置"跳的节 key 必须**真实存在于 Settings.tsx**（否则点了打开一个空节，静默失效）；
 *  ④ 外层必须把 `onOpenSettings` 传进来（不传就只有按钮没动作）。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

function findRoot(start: string): string {
  let d = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, 'main.js')) && existsSync(join(d, 'package.json'))) return d
    d = dirname(d)
  }
  throw new Error('找不到仓库根')
}
const ROOT = findRoot(HERE)
const panel = readFileSync(join(HERE, 'DailySummary.tsx'), 'utf8')
const panelCss = readFileSync(join(HERE, 'daily-summary.module.css'), 'utf8')
const shell = readFileSync(join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'WechatDataPanel.tsx'), 'utf8')
const settings = readFileSync(join(HERE, 'Settings.tsx'), 'utf8')

describe('每日总结：空态把"怎么开始"说清楚', () => {
  it('0 任务 0 记录时渲染落地卡，而不是只留一张空卡', () => {
    expect(panel).toMatch(/view === 'tasks' && tasks\.length === 0 && records\.length === 0 && \(/)
    expect(panel).toContain('三步拿到第一份总结')
    expect(panel).toContain('总结长什么样')
    // 三步都要在：配置模型 / 手动生成 / 定时任务
    expect(panel).toContain('配置模型')
    expect(panel).toContain('手动生成一天')
    expect(panel).toContain('需要每天自动跑？')
  })

  it('把"没配模型就生成不了"提前说出来，并给出模型状态', () => {
    expect(panel, '没有读模型配置').toContain('apiGetLlmConfig')
    expect(panel).toMatch(/const modelReady = !!llm && llm\.model\.trim\(\) !== ''/)
    expect(panel, '缺少未配置时的提示').toContain('尚未配置 —— 总结由模型生成，没配模型无法产出')
    expect(panel, '缺少已配置时的展示').toMatch(/已配置：\{llm\?\.provider\} · \{llm\?\.model\}/)
  })

  it('「去配置」跳的设置节 key 必须在 Settings.tsx 里真实存在', () => {
    const section = panel.match(/onOpenSettings\?\.\('([a-z]+)'\)/)?.[1]
    expect(section, '落地卡里没有跳设置的动作').toBeTruthy()
    // 与 Settings.tsx 的节定义对齐（跨文件一致性：写错 key 会打开一个空节）
    expect(settings, `设置里没有 key 为 '${section}' 的节`).toContain(`key: '${section}'`)
  })

  it('外层把 onOpenSettings 接进来（否则按钮只有样子没有动作）', () => {
    expect(panel).toMatch(/export function DailySummaryPanel\(\{ onOpenSettings \}/)
    expect(shell, 'WechatDataPanel 没有把 openSettings 传给面板').toContain('<DailySummaryPanel onOpenSettings={onOpenSettings} />')
    // renderTab 的形参里要有它，并且在调用处传进来
    expect(shell).toMatch(/clearMomentAuthor: \(\) => void,\s*\n\s*onOpenSettings: \(section\?: string\) => void,/)
    expect(shell).toMatch(/renderTab\(active, navigate, openChat, chatTarget, openMoments, momentAuthor, \(\) => \{ setMomentAuthor\(null\) \}, openSettings\)/)
  })

  it('阅览页空态给一个出口（不是"还没有历史总结"就结束）', () => {
    expect(panel).toContain('去手动生成一份')
    expect(panel).toMatch(/records\.length === 0 && \(/)
  })

  it('任务卡吃掉剩余高度：空白落在卡片里居中，而不是堆在卡片下方', () => {
    expect(panelCss).toMatch(/\.scroll > \.sideCard \{ flex: 1 1 auto; \}/)
  })
})
