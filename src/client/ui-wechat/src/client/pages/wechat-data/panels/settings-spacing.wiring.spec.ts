/**
 * 「设置」弹窗右区（`.mainScroll`）的**纵向间距口径**守卫（2026-10-17）。
 *
 * ## 为什么值得钉
 *
 * 这一块曾经是「三种间距混在一起」的典型：`.mainScroll` 写 `gap: 12px`，
 * 而 `.sectionGroupTitle` 又带 `margin: 6px 2px -2px` —— 两者叠加后实测出现
 * **10 / 12 / 17 / 18** 四种间距（同一份文档里）。用户看到的是「有的地方挤、
 * 有的地方松」，而组与组之间的分隔感不稳定。
 *
 * 更隐蔽的是：**flex 容器的子项 margin 不折叠**（与普通块级流不同）。
 * 所以「标题 margin-bottom + 卡片 margin-top 取较大值」那套直觉在这里是错的 ——
 * 两者会**相加**。第一版修复就踩了这个坑：标题 `mb: 8px` + 卡片 `mt: 12px`
 * 实测出 20px，与「组间 20px」撞成同一个值，层次全没了。
 *
 * ## 现在的口径（三种间距，各自只有一个来源）
 *
 *   · 同组内相邻卡片：**12px**（`.mainScroll > * + *` 的 margin-top）
 *   · 分组标题 → 它下面第一项：**8px**（标题的 margin-bottom，卡片不再加 12px）
 *   · 上一组最后一项 → 下一组标题：**20px**（标题的 margin-top，压过 `+ *` 的 12px）
 *
 * 组间（20）明显大于组内（12），「读到哪一组了」一眼能看出来。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const RAW = readFileSync(join(HERE, 'settings.module.css'), 'utf8')
/**
 * 剥掉注释再断言。
 *
 * ⚠️ 必须剥：本文件的注释里**故意**写了历史值（`gap: 12px`、`margin: 6px 2px -2px`），
 * 那是给下一个人看「为什么改成现在这样」的。不剥的话 `not.toMatch(/gap:\s*[1-9]/)`
 * 会被自己的注释咬到（本仓踩过多次）。
 */
const CSS = RAW.replace(/\/\*[\s\S]*?\*\//g, '')

/** 取某条规则的规则体（选择器必须精确匹配，避免抓到 `@media` 里的同名覆盖）。 */
function rule(selector: string): string {
  const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`)
  return re.exec(CSS)?.[1] ?? ''
}

describe('设置弹窗右区：纵向间距只有三种，且各自只有一个来源', () => {
  it('`.mainScroll` 不再用 `gap`（gap 与子项 margin 会叠加，是上一版四种间距的根因）', () => {
    const body = rule('.mainScroll')
    expect(body, '切不出 .mainScroll 的规则体 ⇒ 下面的断言会空转').toBeTruthy()
    expect(body, '`.mainScroll` 又用回 gap 了 —— 它会与子项 margin 叠加').toMatch(/gap:\s*0\b/)
    expect(body, '`.mainScroll` 的 gap 必须是 0').not.toMatch(/gap:\s*[1-9]/)
  })

  it('同组内相邻卡片：12px（`.mainScroll > * + *`）', () => {
    expect(rule('.mainScroll > * + *'), '同组内相邻卡片的间距规则不见了').toMatch(/margin-top:\s*12px/)
  })

  it('分组标题后面紧跟的那一项不再叠加 12px（否则 8 + 12 = 20，与组间撞值）', () => {
    const body = rule('.mainScroll > .sectionGroupTitle + *')
    expect(body, '缺「标题后一项清零」这条 —— 标题的 8px 会与卡片的 12px 相加成 20px').toBeTruthy()
    expect(body).toMatch(/margin-top:\s*0\b/)
  })

  it('分组标题的上边距压过 `+ *` 的 12px（组间 20px）', () => {
    const body = rule('.mainScroll > .sectionGroupTitle')
    expect(body, '缺「标题上边距覆盖」这条 —— 组间会变成 12 + 20 = 32px').toBeTruthy()
    expect(body).toMatch(/margin-top:\s*20px/)
  })

  it('分组标题自身：上 20 / 下 8（组间 > 组内，标题与内容更紧）', () => {
    const body = rule('.sectionGroupTitle')
    expect(body, '切不出 .sectionGroupTitle 的规则体').toBeTruthy()
    expect(body, '标题的 margin 简写必须是 `20px … 8px`（上 20 / 下 8）').toMatch(/margin:\s*20px\s+\S+\s+8px/)
  })

  it('三种间距的层次：组间(20) > 组内(12) > 标题下(8)', () => {
    // 从源码里把三个数字取出来比大小，而不是各写一遍常量 —— 改任一处都会在这里体现。
    const between = Number(/margin-top:\s*(\d+)px/.exec(rule('.mainScroll > .sectionGroupTitle'))?.[1] ?? 0)
    const inner = Number(/margin-top:\s*(\d+)px/.exec(rule('.mainScroll > * + *'))?.[1] ?? 0)
    const underTitle = Number(/margin:\s*\d+px\s+\S+\s+(\d+)px/.exec(rule('.sectionGroupTitle'))?.[1] ?? 0)
    expect(between, '组间间距读不到').toBeGreaterThan(0)
    expect(inner, '组内间距读不到').toBeGreaterThan(0)
    expect(underTitle, '标题下间距读不到').toBeGreaterThan(0)
    expect(between, `组间(${String(between)}) 必须大于组内(${String(inner)})，否则分组看不出来`).toBeGreaterThan(inner)
    expect(inner, `组内(${String(inner)}) 必须大于标题下(${String(underTitle)})，否则标题与内容脱节`).toBeGreaterThan(underTitle)
  })
})
