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
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, findRoot, readText } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const ROOT = findRoot(HERE)
const read = (f: string): string => readText(join(HERE, f))
const annualCss = read('annual.module.css')
const annualTsx = read('Annual.tsx')

/**
 * 从 `<PanelHeader` 的起点找出这个 JSX 元素自己的结尾（自闭合的 `/>`）。
 *
 * 为什么不能直接找「下一个 `/>`」：`title={<>…<span/>…</>}` 这种写法里，
 * **嵌套元素也有自己的 `/>`**，直接找会切在它那里 —— 于是 `desc=` 落在切片之外，
 * 一个明明有 desc 的面板会被报成"缺失"（第一版就是这么误报 4 个文件的）。
 *
 * 规则：以 `{` / `}` 的配对深度为界，**深度为 0 处的 `/>`** 才是本元素的结尾
 * （属性值里的嵌套 JSX 一律包在 `{…}` 里）。找不到就返回 -1，调用方会因此变红 ——
 * 宁可炸，也不要静默切一小段导致误判。
 * @param src - 源文件文本。
 * @param start - `<PanelHeader` 的起始下标。
 * @returns 结尾 `/>` 里那个 `/` 的下标；找不到返回 -1。
 */
function jsxElementEnd(src: string, start: number): number {
  let depth = 0
  for (let i = start; i < src.length; i++) {
    const c = src.charAt(i)
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '/' && src.charAt(i + 1) === '>' && depth === 0) return i
  }
  return -1
}

describe('U12 · 页头口径：有 PanelHeader 就要有 desc', () => {
  it('每个用 PanelHeader 的面板都传了 desc（或显式展开 header 属性）', () => {
    const files = readdirSync(HERE).filter((f) => f.endsWith('.tsx'))
    atLeast(files.length, 25, 'panels 下的 tsx 文件数')
    const missing: string[] = []
    let heads = 0
    for (const f of files) {
      const src = read(f)
      let i = src.indexOf('<PanelHeader')
      while (i >= 0) {
        const slash = jsxElementEnd(src, i)
        expect(slash, `${f}: 找不到 PanelHeader 元素的结尾 —— 写法变了，本用例的扫描规则要跟着改`).toBeGreaterThan(i)
        const seg = src.slice(i, slash)
        if (!/\bdesc=/.test(seg) && !seg.includes('{...')) missing.push(f)
        heads++
        i = src.indexOf('<PanelHeader', slash)
      }
    }
    atLeast(heads, 25, '扫到的 <PanelHeader 用法数（低于下限说明扫描失效，这条守卫是空的）')
    expect(missing, `这些面板的页头缺少 desc：${missing.join(', ')}`).toEqual([])
  })
})

describe('U3 · 骨架与真实栅格同形（列宽下限必须逐字对齐）', () => {
  /**
   * 骨架的列宽下限与真实网格不一致时，数据到了会"跳一下"：
   * 骨架按 120px 排 10 列、真实是 minmax(200px) 排 6 列。这一条用一张表把两处绑起来 ——
   * 加新面板时照着加一行即可，不用再各写一条断言。
   */
  const PAIRS: ReadonlyArray<{ panel: string, tsx: string, css: string, cls: string, minCol: number }> = [
    { panel: '文件与存储', tsx: 'Files.tsx', css: 'list-panel.module.css', cls: 'fileGrid', minCol: 200 },
    { panel: '通讯录', tsx: 'Contacts.tsx', css: 'contacts.module.css', cls: 'list', minCol: 240 },
  ]

  for (const { panel, tsx, css, cls, minCol } of PAIRS) {
    it(`${panel}：骨架用网格模式，且 minCol 等于 .${cls} 的 minmax 下限`, () => {
      expect(read(tsx), `${panel} 的骨架还在用单列行模式`).toContain(`<ListSkeleton rows={`)
      expect(read(tsx), '骨架没有开网格模式').toMatch(new RegExp(`<ListSkeleton rows=\\{\\d+\\} grid minCol=\\{${minCol}\\} />`))
      expect(read(css), `.${cls} 的列宽下限改了就要同步会话骨架的 minCol`).toMatch(new RegExp(`\\.${cls}\\s*\\{[^}]*minmax\\(${minCol}px`))
    })
  }

  it('收藏与表情**不该**跟着改成网格（它的真实布局就是单列卡片）', () => {
    // 写下来免得后人"顺手统一"：`.favCard` 是 `display: flex` 的单列卡片行，
    // 在 `.scroll` 里竖着排。给它套网格骨架反而是错的。
    expect(read('list-panel.module.css'), '.favCard 是单列卡片行').toMatch(/\.favCard\s*\{[^}]*display:\s*flex/)
    expect(read('Favorites.tsx'), '收藏的骨架应保持行模式').toMatch(/<ListSkeleton rows=\{8\} \/>/)
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

  it('总结工作台：未生成时给出三步与"会得到什么"（含模型状态）', () => {
    // 2026-10-17：`PeriodSummary.tsx` 与 `DailySummary.tsx` 已合并成 `SummaryWorkbench.tsx`，
    // 空态 / 统计卡 / 历史列表又拆到 `SummaryParts.tsx`（单函数 250 行棘轮）。
    // 空态口径不变（三步 + 模型状态 + 去配置出口），只是换了文件。
    const src = read('SummaryWorkbench.tsx')
    const parts = read('SummaryParts.tsx')
    expect(parts).toContain('emptySteps')
    expect(parts).toContain('还没有这一段的总结')
    expect(src, '没有读模型配置').toMatch(/await apiGetLlmConfig\(\)/)
    // 与每日总结同一口径：跳「设置 → AI 大模型」
    expect(parts).toMatch(/onOpenSettings\?\.\('ai'\)/)
  })

  it('这两处的设置跳转都要真的接上（renderTab 里传进去）', () => {
    const shell = readText(join(ROOT, 'src', 'client', 'ui-wechat', 'src', 'client', 'pages', 'wechat-data', 'WechatDataPanel.tsx'))
    expect(shell).toContain('<RevokedPanel onOpenSettings={onOpenSettings} />')
    // 2026-10-17：周期总结并入 `SummaryWorkbench`，跳转出口跟着搬过去。
    expect(shell).toContain('<SummaryWorkbench onOpenSettings={onOpenSettings} />')
  })

  it('群聊公告：空态要说明"为什么可能为空"（公告本来就不是每个群都有）', () => {
    const src = read('GroupInsights.tsx')
    expect(src).toContain('暂无群公告')
    // 只写「暂无群公告」会让人以为是数据丢了 —— 实测本机 53 个群里只有 8 个有公告
    expect(src, '没有说明覆盖率').toContain('六分之一')
    expect(src, '没有给出另一种可能（入群前的公告未同步）').toContain('入群之前')
    // ⚠️ JSX 文本里不能出现 markdown 强调符，否则会原样渲染成星号
    expect(src, 'JSX 文案里混进了 markdown 星号').not.toContain('**六分之一**')
  })

  it('表情包：空态要给出归因，而不是只写「暂无表情包」', () => {
    const src = read('Emoticons.tsx')
    expect(src, '没有说明数据来自哪里').toContain('表情包来自微信「表情商店」的本地缓存')
    expect(src, '没有区分"筛选无匹配"与"确实没有"').toMatch(/q\s*\?\s*'换个关键词/)
  })
})

describe('年度报告 · 整页一张网格（2026-09-30 用户要求把下段卡片并进上段）', () => {
  it('海报的 12 列固定网格与"被切检测"都已移除（整页只有一张密排网格）', () => {
    expect(annualTsx, '旧的 12 列海报网格又回来了').not.toContain('css.wrap')
    expect(annualTsx, '被切检测（compact）又回来了').not.toContain('data-compact')
    expect(annualTsx, '没有用密排网格').toContain('<MasonryGrid>')
  })

  it('样式层面确认密排网格在位（`.wrap` / 被切标记的旧规则留着不删：删它们的风险更大）', () => {
    expect(annualCss, '看板网格的样式必须在').toContain('.board {')
    expect(annualCss, '滚动容器必须常开').toMatch(/\.scrollBody \{[^}]*overflow-y: auto/)
  })
})
