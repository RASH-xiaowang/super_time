// @vitest-environment node
/**
 * W2-9.3 接线守卫：记录表（Records）必须是虚拟化的，且**五张表一个都不能漏**。
 *
 * ## 为什么需要它
 *
 * `longlist-dom-cost.measure.spec.ts` 只证明「等价表格行的节点数能压到 515」
 * —— 那是对**形状**的观测，证明不了「面板真的用了虚拟器」。这里的失败方式是
 * 「看起来还在虚拟化、其实某一张表漏了」：五张表（转账 / 红包 / 删除 / 撤回 /
 * 迷你程序 + 好友验证）各写一遍 `<tbody>`，漏一处就那张表全量渲染，
 * 而界面上完全看不出区别（只有滚到几百行才卡）。
 *
 * 行为侧由 `longlist-dom-cost.measure.spec.ts` 的验收段量（节点数上界 + 省 ≥10×）。
 * @module panels/records-virtual.wiring
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const stripComments = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const panel = stripComments(readFileSync(join(HERE, 'Records.tsx'), 'utf8'))
const mod = readFileSync(join(HERE, 'records-virtual.ts'), 'utf8')
// 仓库根：panels → wechat-data → pages → client → src → ui-wechat → client → src（8 层）。
const ROOT = join(HERE, '..', '..', '..', '..', '..', '..', '..', '..')
const measure = readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'tests', 'longlist-dom-cost.measure.spec.ts'), 'utf8')

describe('W2-9.3：记录表虚拟化的接线', () => {
  it('面板用 useVirtualizer（零件在 records-virtual.ts，面板只接线）', () => {
    expect(panel, 'Records.tsx 没有接虚拟器').toContain('useRecordRowVirtualizer(')
    expect(panel, '面板没有从零件模块 import').toContain("from './records-virtual.ts'")
    expect(mod, '零件模块里没有 useVirtualizer').toContain('useVirtualizer({')
    expect(mod, '零件模块里没有 getItemKey').toContain('getItemKey:')
    expect(mod, '零件模块里没有 measureElement 的挂点说明').toContain('estimateSize')
  })

  it('overscan 保持小值（调大就等于不虚拟化）', () => {
    const m = /overscan:\s*(\d+)/.exec(mod)
    expect(m, '找不到 overscan ⇒ 前提不成立').not.toBeNull()
    expect(Number(m?.[1] ?? '0'), 'overscan 过大 ⇒ 首屏就会挂载大量行').toBeLessThanOrEqual(50)
  })

  it('**五张表一个都不能漏**：每张表的 tbody 都走视口切片 + 首尾撑杆', () => {
    const bodies = panel.split('<tbody>').length - 1
    expect(bodies, '记录表的张数变了（五张：转账/红包/删除/撤回/迷你程序+好友验证）').toBe(6)
    const sliced = panel.split('visibleRecordRows(rowVirtualizer, items).map(').length - 1
    expect(sliced, '有表还在整表 map ⇒ 那张表会全量渲染（滚到几百行就卡）').toBe(bodies)
    const pads = panel.split('pads.top > 0 && <tr').length - 1
    expect(pads, '有表没插首撑杆 ⇒ 滚过一屏之后行会错位').toBe(bodies)
    const padsB = panel.split('pads.bottom > 0 && <tr').length - 1
    expect(padsB, '有表没插尾撑杆 ⇒ 列表滚不到底').toBe(bodies)
  })

  it('每一行都挂了 measureElement（不挂就不会回灌真实行高，撑杆高度全错）', () => {
    const mapped = panel.split('visibleRecordRows(rowVirtualizer, items).map(').length - 1
    const measured = panel.split('ref={rowVirtualizer.measureElement}').length - 1
    expect(measured, '有分支的行没挂 measureElement').toBeGreaterThanOrEqual(mapped)
  })

  it('滚动容器接上了 ref（不接的话虚拟器算不出视口，整表会一次性全挂）', () => {
    expect(panel).toMatch(/ref=\{tableScrollRef\}/)
    expect(mod, '零件模块没把 scrollRef 交给虚拟器').toContain('getScrollElement: () => scrollRef.current')
  })

  it('行键带分类前缀（换分类时下标会复用，不带前缀 React 会把旧行实体复用到新表）', () => {
    expect(/getItemKey:[\s\S]{0,80}keyPrefix/.test(mod), 'getItemKey 没带 keyPrefix ⇒ 切分类时行内容会闪一下才变').toBe(true)
  })

  it('行为侧的验收在册，且量的是**节点数上界 + 省多少倍**', () => {
    expect(measure).toContain('LONGLIST')
    expect(measure, '少了「虚拟化后节点数上界」那条').toContain('toBeLessThan(2000)')
    expect(measure, '少了「省 ≥10×」那条').toContain('toBeGreaterThanOrEqual(10)')
  })

  it('反例自证：整表 map 的形状能被分出来（判据不是恒真）', () => {
    const whole = '<tbody>{items.map((it, i) => (<tr key={i}></tr>))}</tbody>'
    expect(whole.split('visibleRecordRows(rowVirtualizer, items).map(').length - 1, '整表 map 被误算成切片').toBe(0)
    expect(whole.split('<tbody>').length - 1).toBe(1)
  })
})