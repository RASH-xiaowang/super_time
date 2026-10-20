/**
 * 「总结」工作台的空态落地 + 模型依赖接线守卫。
 *
 * ## 背景（2026-10-17 重做）
 *
 * 改前是两个面板（每日总结 / 周期总结），每日总结内部还有 3 个 tab —— 用户要在
 * **5 个视图**之间跳才能完成"生成一份总结并回看"。两者本质是同一件事（按时间范围
 * 总结聊天），只是粒度不同，所以合并成一个 `SummaryWorkbench`，用一个时间范围
 * 选择器驱动。
 *
 * 这里钉五件事：
 *  ① 空态必须给出"三步开始"（选范围 / 生成 / 回看），而不是只留一张空卡；
 *  ② 模型状态要真的读一次配置（`apiGetLlmConfig`），未配置时给"去配置"；
 *  ③ "去配置"跳的节 key 必须**真实存在于 Settings.tsx**（否则点了打开一个空节，静默失效）；
 *  ④ 外层必须把 `onOpenSettings` 传进来（不传就只有按钮没动作）；
 *  ⑤ 单日走每日链路、多日走周期链路 —— 两条都要落库（否则刷新就没了）。
 * @vitest-environment node
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readSettingsSource } from '../../../test-helpers/settings-source.ts'

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
const panel = readFileSync(join(HERE, 'SummaryWorkbench.tsx'), 'utf8')
// 2026-10-17：空态 / 统计卡 / 历史列表已拆到 `SummaryParts.tsx`（单函数 250 行棘轮）。
// 断言跟着内容走 —— 拆文件不该让守卫失效。
const parts = readFileSync(join(HERE, 'SummaryParts.tsx'), 'utf8')
const drawer = readFileSync(join(HERE, 'SummaryTaskDrawer.tsx'), 'utf8')
const panelCss = readFileSync(join(HERE, 'summary-workbench.module.css'), 'utf8')
const shell = readFileSync(join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'WechatDataPanel.tsx'), 'utf8')
// M21：设置面板已拆成多份 ⇒ 节定义读联合（断言未改）
const settings = readSettingsSource()

describe('总结工作台：空态把"怎么开始"说清楚', () => {
  it('没有结果时渲染三步落地卡，而不是只留一张空卡', () => {
    expect(panel).toMatch(/!result && !loading && \(/)
    expect(panel, '缺少三步组件').toContain('<SummaryEmpty')
    expect(parts, '缺少三步说明').toContain('emptySteps')
    // 三步都要在：选时间范围 / 生成总结 / 回看与复制
    expect(parts).toContain('选时间范围')
    expect(parts).toContain('生成总结')
    expect(parts).toContain('回看与复制')
  })

  it('把"没配模型就生成不了"提前说出来，并给出模型状态', () => {
    expect(panel, '没有读模型配置').toContain('apiGetLlmConfig')
    expect(panel).toMatch(/const modelReady = !!llm && llm\.model\.trim\(\) !== ''/)
    expect(parts, '缺少未配置时的出口').toContain('模型未配置 · 去配置')
  })

  it('「去配置」跳的设置节 key 必须在 Settings.tsx 里真实存在', () => {
    const section = parts.match(/onOpenSettings\?\.\('([a-z]+)'\)/)?.[1]
    expect(section, '落地卡里没有跳设置的动作').toBeTruthy()
    // 与 Settings.tsx 的节定义对齐（跨文件一致性：写错 key 会打开一个空节）
    expect(settings, `设置里没有 key 为 '${section}' 的节`).toContain(`key: '${section}'`)
  })

  it('外层把 onOpenSettings 接进来（否则按钮只有样子没有动作）', () => {
    expect(panel).toMatch(/export function SummaryWorkbench\(\{ onOpenSettings \}/)
    expect(shell, 'WechatDataPanel 没有把 openSettings 传给工作台').toContain('<SummaryWorkbench onOpenSettings={onOpenSettings} />')
    // renderTab 的形参里要有它，并且在调用处传进来
    expect(shell).toMatch(/clearMomentAuthor: \(\) => void,\s*\n\s*onOpenSettings: \(section\?: string\) => void,/)
    // 末尾三个形参是后续轮次加的，调用处必须逐个传 —— 漏传的表现是「点了没反应」，不报错：
    //   · `seed`        —— 全局搜索命中带关键词跳转
    //   · `openKbFile`  —— 知识库引用点开跳「知识库 · 文件」分段
    //   · `kbFocus`     —— 跳过去之后要高亮的那个文件（含 nonce，便于同文件再点一次也能触发）
    expect(shell).toMatch(/renderTab\(active, navigate, openChat, chatTarget, openMoments, momentAuthor, \(\) => \{ setMomentAuthor\(null\) \}, openSettings, seed, openKbFile, kbFocus\)/)
  })

  it('历史侧栏空态给一个出口（不是"还没有历史总结"就结束）', () => {
    expect(parts).toContain('生成过的总结会自动出现在这里')
    expect(panel).toMatch(/<HistoryPanel/)
  })

  it('空态卡吃掉剩余高度：空白落在卡片里居中，而不是堆在卡片下方', () => {
    expect(panelCss).toMatch(/\.main > \.card:only-child \{ flex: 1 1 auto;/)
  })
})

describe('总结工作台：两条生成链路都落库', () => {
  it('单日走每日链路、多日走周期链路', () => {
    expect(panel, '缺少单日/多日的分支').toMatch(/if \(from === to\) \{/)
    expect(panel).toContain('apiGenerateDailySummary')
    expect(panel).toContain('apiGeneratePeriodSummary')
  })

  it('后端两条链路都调 saveSummaryRecord（否则刷新就没了）', () => {
    const backend = readFileSync(
      join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'remotes', 'summaryrec.ts'),
      'utf8',
    )
    // 手动生成的每日总结与周期总结都必须落库（`taskId: 0` 表示手动）
    const saves = [...backend.matchAll(/saveRec\(rc\.dirs\(\)\.decrypted, \{[\s\S]{0,400}?taskId: 0,/g)]
    expect(saves.length, '手动生成的总结没有落库（每日 + 周期应各一处）').toBeGreaterThanOrEqual(2)
  })

  it('周期总结的 summaryDate 存区间（带 ~），每日存单日 —— 历史列表靠它区分类型', () => {
    expect(parts, '缺少类型判定').toMatch(/export function recordKind\(r: SummaryRecord\)/)
    expect(parts).toContain("r.summaryDate.includes('~')")
  })
})

describe('定时任务收进抽屉', () => {
  it('任务管理不在主区，而是抽屉', () => {
    expect(panel, '主区不该直接渲染任务列表').toContain('<TaskDrawer')
    expect(drawer).toContain('export function TaskDrawer')
    expect(panelCss).toMatch(/\.drawer \{[\s\S]{0,200}position: absolute/)
  })

  it('抽屉支持 Esc 关闭（表单开着先退表单）', () => {
    expect(drawer).toMatch(/e\.key === 'Escape'/)
    expect(drawer).toMatch(/if \(form\) setForm\(null\); else onClose\(\)/)
  })
})
