/**
 * M6（总览 / 问答 / 年报）手机档的接线守卫 —— 判据全部来自 **2026-10-14 真数据实测**：
 *
 *  · 总览核心资产八格在 375px 上四列并排，每格约 80px：真实值「2,359」「11.97 GB」
 *    被裁掉（`plateValue` 的 scrollWidth > clientWidth）⇒ ≤560 改两列；
 *  · 年报卡片头右侧那行补充说明（「全年活跃 206 天 · 最高一天 75 条」）在窄卡里被省略号
 *    吃掉一半（实测 scrollWidth 174 / clientWidth 38）⇒ ≤380 容器档让它独占一行并折行；
 *  · 问答的建议条 `max-height: 40vh` 在手机键盘顶起时不缩（虚拟键盘不算视口缩短）
 *    ⇒ 补一条 dvh（不认 dvh 的老内核落回 vh 那一行）。
 *
 * 为什么用接线判据而不是截图：这三处坏法在桌面尺寸与打桩数据下**一个像素都不变**，
 * 只有「窄视口 × 真实数据」同时成立才露出来；截图又没法进 CI。
 *
 * @vitest-environment node
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, atRuleBlock, readText } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const read = (name: string): string => readText(join(HERE, name))

/** 手机档的视口断点（与 `ui/use-media-query.ts#PHONE_QUERY` 同一个数）。 */
const PHONE = '@media (max-width: 560px)'
/** 年报自己的最窄容器档（卡片宽度，不是视口）。 */
const ANNUAL_NARROW = '@container (max-width: 380px)'

const overview = read('overview-neon.module.css')
const annual = read('annual.module.css')
const ask = read('ask.module.css')

describe('总览手机档：核心资产八格两列', () => {
  it('≤560 把 heroStats 改成两列（四列时每格约 80px，真实值放不下）', () => {
    const phone = atRuleBlock(overview, PHONE)
    atLeast(phone.length, 20, 'overview 的手机档')
    expect(phone, '核心资产格在手机上仍是四列 ⇒ 「2,359」「11.97 GB」会被裁掉')
      .toContain('.heroStats { grid-template-columns: repeat(2, minmax(0, 1fr)); }')
  })
})

describe('年报手机档：卡片头的补充说明不许被省略号吃掉', () => {
  it('≤900 单列档的跨度中和必须与 ≤1400 档同特异性（否则隐式列把卡片压到 85px）', () => {
    const single = atRuleBlock(annual, '@media (max-width: 900px)')
    expect(single, '单列档没有把网格收成一行').toContain('.board { grid-template-columns: minmax(0, 1fr); }')
    expect(single, '跨度中和又写成 `.board > *` ⇒ 特异性输给 ≤1400 档的 `.board > .card`（都带 !important），单列网格里被 span 撑出隐式列')
      .toContain('.board > .card, .board > .moreCard, .board > .span6, .board > .portrait, .board > .footer { grid-column: 1 / -1 !important; }')
    expect(single, '不允许再出现低特异性的 `> *` 中和').not.toContain('.board > * {')
  })

  it('≤380 容器档里 cardExtra 独占一行并允许折行', () => {
    const narrow = atRuleBlock(annual, ANNUAL_NARROW)
    expect(narrow, '卡片头不允许换行 ⇒ cardExtra 独占不了一行').toContain('.cardHead { flex-wrap: wrap')
    expect(narrow, 'cardExtra 没有独占一行 ⇒ 实测 174px 的文字塞进 38px 宽，只剩省略号')
      .toContain('.cardExtra { flex-basis: 100%;')
    // 整行断言：只断 `white-space: normal` 会被同档里 `.sub` 的那一行顶替掉（M556 实测抓到）
    expect(narrow, 'cardExtra 仍是 nowrap ⇒ 折行不生效，补充说明又被省略号吃掉')
      .toContain('.cardExtra { flex-basis: 100%; text-align: left; white-space: normal; }')
    expect(narrow, '头像行小字没有两行封顶').toContain('-webkit-line-clamp: 2')
    expect(narrow, '「还有这些人」芯片仍是 flex:1 1 0 ⇒ 七格平分一行、名字被裁到 23px（真数据实测）')
      .toContain('.moreCell { flex: 1 1 45%; }')
  })
})

describe('问答手机档：建议条高度跟 dvh 走（键盘顶起时 vh 不缩）', () => {
  it('40vh 之后紧跟一条 40dvh（老内核落回 vh，新内核用会缩的 dvh）', () => {
    const atVh = ask.indexOf('max-height: 40vh;')
    const atDvh = ask.indexOf('max-height: 40dvh;')
    expect(atVh, '找不到 40vh 那一行（判据的锚没了）').toBeGreaterThan(-1)
    expect(atDvh, '没有 dvh 兜底行 ⇒ 键盘顶起时建议条按不缩的 vh 算，盖住输入面').toBeGreaterThan(atVh)
  })
})
