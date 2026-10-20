/**
 * 「图谱参数」与「节点详情」分栏（2026-10-18 用户反馈）：
 * 旧版把点选节点后的详情卡直接塞进「图谱参数」抽屉的同一个列表里，调参与看节点信息混在一起。
 * 现在抽屉有两个明确页签：图谱参数 / 节点详情；选中节点时自动切到详情，点页签可随时回参数。
 *
 * 抽屉是 JSX，node 环境跑不了渲染 → 按仓库既有做法（graph-canvas-style.spec.ts）
 * 用源码断言锁定结构。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const rail = readFileSync(join(HERE, 'GraphRail.tsx'), 'utf8')

describe('图谱侧栏：参数与节点详情分栏', () => {
  it('抽屉有两个页签（role=tablist / aria-selected），详情页签未选中时禁用', () => {
    expect(rail).toMatch(/role="tablist"/)
    expect(rail).toMatch(/aria-selected=\{view === 'params'\}/)
    expect(rail).toMatch(/aria-selected=\{view === 'detail'\}/)
    expect(rail).toMatch(/disabled=\{!selected\}/)
  })

  it('选中节点自动切到详情；清空选中自动回参数', () => {
    expect(rail).toMatch(/const \[view, setView\] = useState<'params' \| 'detail'>/)
    expect(rail).toMatch(/setView\(selected \? 'detail' : 'params'\)/)
    expect(rail).toMatch(/\[selected\?\.id\]/)
  })

  it('标题随页签切换（不再是固定「图谱参数」）', () => {
    expect(rail).toMatch(/view === 'detail' \? '节点详情' : '图谱参数'/)
  })

  it('详情卡只在「详情」分支渲染，且不再被旧的 `{selected && ...}` 包在参数列表里', () => {
    expect(rail, '旧的「参数列表里塞详情」写法还在').not.toMatch(/\{selected && \(\s*<GraphSelectionDetail/)
    const switchAt = rail.indexOf("view === 'detail' ? (")
    const detailAt = rail.indexOf('<GraphSelectionDetail')
    const paramsHintAt = rail.indexOf('点击节点选中并高亮相邻节点与连线')
    expect(switchAt, '找不到视图条件渲染').toBeGreaterThan(-1)
    expect(detailAt, '找不到详情卡').toBeGreaterThan(switchAt)
    // 参数区在 else 分支里（在详情卡之后、收尾 </> 之前）
    expect(paramsHintAt, '参数区提示不在参数分支里').toBeGreaterThan(detailAt)
  })

  it('「图谱参数」页签按钮文案与标题一致；详情空态有引导文案', () => {
    expect(rail).toContain('>图谱参数</button>')
    expect(rail).toContain('>节点详情{selected ? ')
    expect(rail).toMatch(/未选中节点/)
    expect(rail).toMatch(/调参请切「图谱参数」/)
  })
})
