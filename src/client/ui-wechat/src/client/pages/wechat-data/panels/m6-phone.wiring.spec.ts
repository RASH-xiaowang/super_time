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

/**
 * 霓虹牌内容水平居中（2026-10-16 用户要求「里面的内容要水平居中」）。
 *
 * 原先 `.plate` 是 `align-items: flex-start` + `text-align: left` ⇒ 图标/数字/标签
 * 全部靠左，在**对称的八边形**牌面里看起来"没摆正"。改成居中后三者共用一条中轴
 * （实测各元素中心相对牌面中心的偏移 = 0）。
 */
describe('霓虹牌内容水平居中', () => {
  it('.plate 与 .plateBody 都居中（只改一层会让图标与文字错开）', () => {
    expect(overview, '.plate 又靠左了 ⇒ 八边形牌面里的内容看起来没摆正')
      .toMatch(/\.plate \{[^}]*align-items: center/s)
    expect(overview, '.plate 的 text-align 没跟着改 ⇒ 多行文字仍靠左')
      .toMatch(/\.plate \{[^}]*text-align: center/s)
    expect(overview, '.plateBody 没居中 ⇒ 图标/数字/标签各靠各的左')
      .toMatch(/\.plateBody \{[^}]*align-items: center/s)
    // 反向：不该再有靠左的残留（`flex-start` / `text-align: left`）
    expect(overview, '.plate 里还留着 align-items: flex-start').not.toMatch(/\.plate \{[^}]*align-items: flex-start/s)
    expect(overview, '.plate 里还留着 text-align: left').not.toMatch(/\.plate \{[^}]*text-align: left/s)
  })
})

describe('年报手机档：卡片头的补充说明不许被省略号吃掉', () => {
  it('≤760 单列档的跨度中和必须与上面两档同特异性（否则隐式列把卡片压到 85px）', () => {
    // 2026-10-17 断点从 900 收到 760（同时新增 1440 / 1100 两档，见 annual-more.wiring.spec.ts）。
    const single = atRuleBlock(annual, '@media (max-width: 760px)')
    // 2026-10-17 起 `.board` 块里多了 `--annual-row`（固定行高），所以用正则而不是整串匹配。
    expect(single, '单列档没有把网格收成一行').toMatch(/\.board \{[\s\S]{0,200}grid-template-columns: minmax\(0, 1fr\)/)
    expect(single, '跨度中和又写成 `.board > *` ⇒ 特异性输给上面两档的 `.board > .card`（都带 !important），单列网格里被 span 撑出隐式列')
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

/**
 * 总览页手机档的**栅格塌陷**（2026-10-16 真机实测，437px 视口）。
 *
 * ## 为什么必须有这一条
 *
 * 桌面版是 **12 栅格**（`.ovGrid` 的 `repeat(12, …)`）。手机档此前**没有**覆盖它，
 * 于是 `.ovSpan5` 只剩 **131px** 宽、`.ovTrend .trendGrid` 只剩 **105px** ——
 * 卡片被压成一条，数字与标签互相挤（用户报「组件大小要重新考虑」）。
 *
 * ## 两个必须钉住的坑（都实测踩过）
 *
 *  ① **span 类必须用属性子串覆盖**：逐个列举会漏（实测漏了 `.ovSpan4` / `.ovSpan8`），
 *     漏掉的那个会在 1 列网格里创建**隐式轨道** ⇒ 表现为「写了单列，实际还是 8 列」。
 *  ② **跨模块覆盖必须用属性子串选择器**：CSS Modules 给每个文件独立哈希，
 *     `overview-phone.css` 里写 `.ovGrid` 会编译成另一个类名，**匹配不到** JSX 上的
 *     `css.ovGrid`（实测：手机上仍是 12 栅格）。
 */
describe('总览手机档：12 栅格塌成单列（否则卡片被压成 131px）', () => {
  const phone = read('overview-phone.css')

  it('手机档文件存在且用属性子串选择器（跨模块覆盖的唯一可行写法）', () => {
    atLeast(phone.length, 200, 'overview-phone.css')
    expect(phone, '没有用属性子串选择器 ⇒ CSS Modules 的哈希对不上，规则不生效')
      .toContain("[class*='ovGrid']")
  })

  it('栅格塌成单列，且 span 类用属性子串**一次覆盖全部**（逐个列举会漏）', () => {
    const block = atRuleBlock(phone, PHONE)
    atLeast(block.length, 100, 'overview-phone.css 的手机档')
    expect(block, '12 栅格没有塌成单列 ⇒ 卡片被压成 131px').toContain('grid-template-columns: minmax(0, 1fr)')
    expect(block, 'span 类没有用属性子串覆盖 ⇒ 漏掉的那个会创建隐式轨道，单列失效')
      .toContain("[class*='ovGrid'] > [class*='ovSpan']")
    expect(block, 'regionSpan 也要一起中和').toContain("[class*='regionSpan']")
  })

  it('趋势格与指标格用**两段**选择器（单段优先级输给 overview.module.css 里的同形状规则）', () => {
    const block = atRuleBlock(phone, PHONE)
    expect(block, '趋势格写成单段 ⇒ 优先级输给 `.ovTrend .trendGrid`，仍是 3 列 78px')
      .toContain("[class*='ovTrend'] [class*='trendGrid']")
    expect(block, '指标格写成单段 ⇒ 优先级输给 `.ovTall .metricGrid`')
      .toContain("[class*='ovTall'] [class*='metricGrid']")
  })

  it('固定宽度改弹性（`.topName` 的 130px 在 387px 卡身里占掉 1/3）', () => {
    const block = atRuleBlock(phone, PHONE)
    expect(block, 'topName 仍是固定 130px ⇒ 名字被截断').toContain("[class*='topName'] { width: auto; flex: 1 1 auto; }")
  })
})
