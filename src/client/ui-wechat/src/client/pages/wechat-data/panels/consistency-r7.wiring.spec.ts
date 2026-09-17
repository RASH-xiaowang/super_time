/**
 * R7 收口守卫：页头口径（U12）、落地/空态口径（U14）、年度报告的自适应回退。
 *
 * 三条都来自本轮实测：
 *  ① `朋友圈` 是**唯一**没有 `desc` 的面板 —— 页头三件套（标题 / 一句"这页是什么" / 操作）
 *     在别处都成立，只此一处漏了，界面上一眼看不出"少了什么"；
 *  ② `撤回消息`（574px）与 `周期报告`（515px）的空态只有一两行字，下面整片空白，
 *     而且都没说"下一步做什么"；
 *  ③ 年度报告的回退条件 `@media (max-height:779px)` 看的是**视口**高度（本机 900），
 *     真正被压缩的是**面板**高度（约 700）→ 海报模式照常启用，9 张卡片各把
 *     20–30% 文字切掉。改成按"卡片是否真被切"判定，并复用同一套瀑布流规则。
 * @vitest-environment node
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
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
const read = (f: string): string => readFileSync(join(HERE, f), 'utf8')
const annualCss = read('annual.module.css')
const annualTsx = read('Annual.tsx')

describe('U12 · 页头口径：有 PanelHeader 就要有 desc', () => {
  it('每个用 PanelHeader 的面板都传了 desc（或显式展开 header 属性）', () => {
    const files = readdirSync(HERE).filter((f) => f.endsWith('.tsx'))
    const missing: string[] = []
    for (const f of files) {
      const src = read(f)
      let i = src.indexOf('<PanelHeader')
      while (i >= 0) {
        const seg = src.slice(i, i + 500)
        if (!seg.includes('desc=') && !seg.includes('{...')) missing.push(f)
        i = src.indexOf('<PanelHeader', i + 1)
      }
    }
    expect(missing, `这些面板的页头缺少 desc：${missing.join(', ')}`).toEqual([])
  })
})

describe('U14 · 空态要做成"有信息的落地"，不是一行字', () => {
  it('撤回消息：说明为空的三类原因，并给出下一步动作', () => {
    const src = read('Revoked.tsx')
    expect(src).toContain('rvLand')
    expect(src, '没有区分"为什么为空"').toContain('本机确实没人撤回过')
    expect(src, '缺少下一步动作').toContain('刷新重读')
    expect(src).toContain('去数据配置')
  })

  it('周期报告：未生成时给出三步与"会得到什么"（含模型状态）', () => {
    const src = read('PeriodSummary.tsx')
    expect(src).toContain('psLand')
    expect(src).toContain('还没有这一段的总结')
    expect(src).toContain('会得到什么')
    expect(src, '没有读模型配置').toMatch(/await apiGetLlmConfig\(\)/)
    // 与每日总结同一口径：跳「设置 → AI 大模型」
    expect(src).toMatch(/onOpenSettings\?\.\('ai'\)/)
  })

  it('这两处的设置跳转都要真的接上（renderTab 里传进去）', () => {
    const shell = readFileSync(join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'WechatDataPanel.tsx'), 'utf8')
    expect(shell).toContain('<RevokedPanel onOpenSettings={onOpenSettings} />')
    expect(shell).toContain('<PeriodSummaryPanel onOpenSettings={onOpenSettings} />')
  })
})

describe('年度报告 · 海报装不下时要真的退回瀑布流', () => {
  it('按"卡片是否被切"判定（media query 只看视口，判断不了面板高度）', () => {
    expect(annualTsx, '缺少 compact 状态').toMatch(/const \[compact, setCompact\] = useState\(false\)/)
    expect(annualTsx, '没有检测卡片是否被切').toMatch(/c\.scrollHeight > c\.clientHeight \+ 8/)
    expect(annualTsx, '没有用 ResizeObserver 跟随容器变化').toMatch(/new ResizeObserver\(check\)/)
    expect(annualTsx, 'data-compact 没挂到网格上').toMatch(/data-compact=\{compact \|\| undefined\}/)
  })

  it('样式里有对应的 data-compact 规则，且覆盖"卡片不再裁切"', () => {
    expect(annualCss).toMatch(/\.wrap\[data-compact\]\s*\{/)
    expect(annualCss, 'compact 下卡片仍会裁切').toMatch(/\.wrap\[data-compact\] \.card \{[^}]*overflow:\s*visible/)
    expect(annualCss, 'compact 下滚动容器没有打开').toMatch(/\.scrollBody:has\(\.wrap\[data-compact\]\)\s*\{\s*overflow-y:\s*auto/)
  })

  it('原来的媒体查询仍然保留（窄窗/矮窗照旧退化）', () => {
    expect(annualCss).toMatch(/@media \(max-width: 1200px\), \(max-height: 779px\)/)
  })
})
