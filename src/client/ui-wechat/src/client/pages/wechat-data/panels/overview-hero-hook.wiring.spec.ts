/**
 * 「留白审计的就绪钩子」两端接线判据。
 *
 * ## 为什么值得一条判据
 *
 * 2026-09-27 把指标条换成霓虹牌之后，`ui:overview-audit` 打印「未检测到已加载的总览数据」并**以 0 退出** ——
 * 它查的就绪判据是旧类名，那套类名被删了之后，"没找到"被读成"空库"，留白/网格空洞/内容裁切三项验收一起静默失效。
 * 所以给指标条一个专属属性 `data-st-ov-hero`，并把两端钉在一起：
 * 组件侧（`overview-panel.tsx` 的 KPI 栅格容器）必须有它，脚本侧（`overview-layout-audit.mjs`）必须查它。
 *
 * Wave D3（2026-10-18）把指标条从 NeonHero 换成 kit StatCard + Bootstrap `row g-2`，
 * 钩子跟着搬到新容器，判据同步（属性仍在「指标条」那一行上，脚本侧不用改）。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { findRoot, readStripped, readText } from '../../../test-helpers/wiring-kit.ts'

const ROOT = findRoot(import.meta.dirname)
const HOOK = 'data-st-ov-hero'
// Wave D3：KPI 条（含 data-st-ov-hero）随「卡片区块」一起放进 overview-sections.tsx，
// 面板本体只负责取数与版式编排。
const PANEL = join(import.meta.dirname, 'overview-sections.tsx')
const SCRIPT = join(ROOT, 'scripts', 'overview-layout-audit.mjs')

/** 脚本侧一律**剥注释再断言**：说明里会照抄旧判据的字样，按原文扫必然自伤（本仓的老坑）。 */
const readCode = (p: string): string => readStripped(p)

describe('总览留白审计的就绪钩子（容器侧 + 脚本侧）', () => {
  it('容器上有这个属性，且挂在那张「指标条」上（不是随手加在别的容器上）', () => {
    const code = readText(PANEL)
    // 说明文字里也会提到这个属性 ⇒ 只认 JSX 元素行（`<div … data-st-ov-hero …>`）
    const line = code.split('\n').find((l) => /<[A-Za-z]/.test(l) && l.includes(HOOK))
    expect(line, `overview-panel.tsx 里找不到 ${HOOK} ⇒ 留白审计的就绪判据已经失去靶子`).toBeTruthy()
    expect(line, `${HOOK} 必须与指标条容器同在一行（脚本问的就是这一块）`).toContain('row g-2')
    // 指标条的内容是 kit StatCard（Wave D3 起不再有 NeonHero）
    expect(code, 'KPI 条没用 kit StatCard？').toContain('<StatCard')
    expect(code, '不该再渲染 NeonHero').not.toContain('<NeonHero')
  })

  it('脚本问的就是这个属性（而不是类名或文案）', () => {
    const code = readCode(SCRIPT)
    expect(code, `脚本不再引用 [${HOOK}] ⇒ 它要么改回了类名匹配，要么钩子被删了`).toContain(`[${HOOK}]`)
    expect(code, '脚本改回按类名找指标条 ⇒ 换皮肤那天它会静默把"没找到"当成"空库"（见本文件头）')
      .not.toContain('[class*=ovHero]')
  })

  it('反例自证：两端各自改一处，判据都要报（证明上面两条不是恒真）', () => {
    const panel = readText(PANEL)
    expect(panel.includes(HOOK), '容器侧本来就没有这个属性 ⇒ 第一条是假绿').toBe(true)
    // 用 split/join 构造"改名"，而不是 `HOOK + '-RENAMED'`（新串仍含旧串，自证会变自欺）。
    const renamed = panel.split(HOOK).join('data-st-ov-her0')
    expect(renamed.split('\n').some((l) => l.includes(HOOK)), '改名后仍然命中 ⇒ 反例是自欺').toBe(false)
    const script = readCode(SCRIPT)
    expect(script.includes(`[${HOOK}]`), '脚本侧本来就不引用它 ⇒ 第二条是假绿').toBe(true)
    // 用 split/join **换掉全部**出现：当年加第二条查询时只换第一处，反例当场失效。
    expect(script.split(`[${HOOK}]`).join('[]').includes(`[${HOOK}]`),
      '把查询全换成 [] 之后仍然命中 ⇒ 第二条反例没打到靶子').toBe(false)
  })
})
