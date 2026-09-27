/**
 * 「不许把内容切一半」的几何守卫（口径见 `docs/UI-PANELS-PLAN.md` 的 U4）。
 *
 * 两条都是 2026-09-26 真机审计量出来、再逐层查到根因的：
 *
 * ① **骨架条被自己裁掉 10px**（审计：备份恢复 / 数据库健康 / 原图链路自检 各「裁切 ×4」）
 *    被裁的是 `<div class="nm-skel skelRow">`：`clientHeight=46 px / scrollHeight=56 px`。
 *    56 = 34(头像) + 12(文字行) + 10(时间)，也就是说那一行的三个占位块**竖着堆**了 ——
 *    而它本该是一行（`.skelRow` 要的是 `display: flex`）。为什么会堆？
 *    因为全局 `.nm-skel` 也声明了 `display: block`，两条规则**特异性相同**，
 *    胜负只取决于两个 CSS 文件在产物里的先后 —— 一个纯"上色"的类越权决定了布局。
 *    修法：`.nm-skel` 不再声明 display，display 归还给各自的形状类。
 *
 * ② **卡片被 flex 压缩后再被自己的 overflow 切掉**（审计：转账红包「裁切 ×1」，实测切 85px）
 *    `.panel` 是 `display:flex; column; overflow-y:auto`，卡片是 flex 子项、默认 `flex: 0 1 auto`
 *    ⇒ 内容超高时 **flex 先压子项**而不是让容器滚；卡片从 540px 被压到 457px，
 *    自带的 `overflow: hidden` 吃掉剩下的 85px，用户看到表格从中间断掉、且没有滚动条。
 *
 * 这两条都属于"改了某处一点、结果在别处露出来"的类型，所以这里既锁**结果**（几何不等式），
 * 也锁**结构**（谁负责声明 display / 谁负责不收缩），并各配反例。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classBlock, readText } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const KIT = readText(join(HERE, '..', 'ui', 'kit.module.css'))
const THEME = readText(join(HERE, '..', 'scifi-theme.css'))
const TABLE = readText(join(HERE, '..', 'ui', 'kit-table.module.css'))
const RECORDS_CSS = readText(join(HERE, 'records.module.css'))
const RECORDS_TSX = readText(join(HERE, 'Records.tsx'))

/** 从一段声明里取某个属性的 px 数值（找不到返回 null）。 */
function px(block: string, prop: string): number | null {
  const m = new RegExp(`${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`).exec(block)
  const raw = m?.[1]
  return raw === undefined ? null : Number(raw)
}

/**
 * 取 `padding` 简写的**纵向**值（1 值=四边同，2 值=上下/左右，4 值=上右下左）。
 * 非 px（如 `var(--…)`）按 0 处理 —— 本文件只用在骨架行/形状上，它们都是字面 px。
 */
function padY(block: string): number {
  const m = /padding\s*:\s*([^;]+);/.exec(block)
  const first = m?.[1]?.trim().split(/\s+/)[0]
  const n = first === undefined ? null : /^(-?\d+(?:\.\d+)?)px$/.exec(first)
  const raw = n?.[1]
  return raw === undefined ? 0 : Number(raw)
}

describe('骨架条：配色类不许决定布局', () => {
  it('`.nm-skel` 存在（防空转）且**不再声明 display**', () => {
    const nmSkel = classBlock(THEME, 'nm-skel')
    expect(nmSkel.length, '`.nm-skel` 的规则不见了 —— 换了写法就要同步本用例').toBeGreaterThan(10)
    expect(nmSkel, '配色类一旦声明 display，就会与形状类打"文件顺序战"').not.toMatch(/display\s*:/)
    // 它该干的事还在：底色 + 裁掉微光的 overflow
    expect(nmSkel).toContain('overflow: hidden')
    expect(nmSkel).toContain('background: var(--nm-bg-hover)')
  })

  it('行是 flex 行；三个 span 形状自己声明 display（否则没有高度）', () => {
    expect(classBlock(KIT, 'skelRow'), '行必须是 flex，否则占位块会竖着堆').toMatch(/display:\s*flex/)
    for (const name of ['skelAvatar', 'skelLine', 'skelMeta']) {
      const block = classBlock(KIT, name)
      expect(block, `.${name} 必须自己声明 display（它是个 <span>）`).toMatch(/display\s*:\s*(block|inline-block)/)
    }
    // 表格骨架那一列也是 span
    expect(classBlock(TABLE, 'skelTdLine'), '.skelTdLine 是 span，必须自己声明 display')
      .toMatch(/display\s*:\s*(block|inline-block)/)
  })

  it('几何不等式：行的固定高度装得下最高那个占位块（这就是"被切 10px"的那条）', () => {
    const row = classBlock(KIT, 'skelRow')
    const rowH = px(row, 'height')
    expect(rowH, '.skelRow 没有固定高度 —— 若真的改成自适应，本条要连同上面的机制一起重写').not.toBeNull()
    const childH = ['skelAvatar', 'skelLine', 'skelMeta']
      .map((n) => px(classBlock(KIT, n), 'height') ?? 0)
    const tallest = Math.max(...childH)
    expect(tallest, '三个形状都没量到高度，样本有问题').toBeGreaterThan(0)
    const need = tallest + padY(row) * 2
    expect(rowH!, `行高 ${rowH}px 装不下 ${tallest}px 的占位块 + 上下内边距 ${padY(row) * 2}px ⇒ 会被裁掉`).toBeGreaterThanOrEqual(need)
  })
})

describe('卡片：不许被 flex 压缩后再被自己的 overflow 切掉', () => {
  it('前提仍在：records 面板是「滚动 + flex 列」，卡片才会被压', () => {
    const panel = classBlock(RECORDS_CSS, 'panel')
    expect(panel).toMatch(/display:\s*flex/)
    expect(panel).toMatch(/flex-direction:\s*column/)
    expect(panel).toMatch(/overflow-y:\s*auto/)
  })

  it('卡片声明了 `flex-shrink: 0`，并且真的接到了 JSX 上', () => {
    expect(classBlock(RECORDS_CSS, 'recordsCard'), '卡片没有禁止收缩 ⇒ 内容超高时先压它、再被 overflow 切掉')
      .toMatch(/flex-shrink:\s*0/)
    expect(RECORDS_TSX, '样式写了却没接到卡片上（这类"写了但从未生效"在本仓出现过）')
      .toContain('<Card flush className={css.recordsCard}>')
    // 反例：内层滚动区的自身约束保持不变（长表仍在自己那一格里滚）
    expect(classBlock(RECORDS_CSS, 'tableScroll')).toMatch(/overflow-y:\s*auto/)
  })
})
