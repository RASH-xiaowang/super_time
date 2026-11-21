/**
 * 年度报告「默认 8 卡 + 更多折叠」的**接线守卫**（2026-10-19 微信化改版）。
 *
 * 演进：
 *  · 2026-09-30 加六块新统计（朋友圈/收藏/资金/撤回/群聊），并迁入一张 12 列网格；
 *  · 2026-10-19 微信化：默认只留 **8 张核心卡**（年度概览/作息/关系/群/媒体/资金/朋友圈/极值），
 *    其余 17 项收进「更多年度数据」原生 `<details>`；7 种语义色收敛为中性 + 1 个强调色。
 *
 * 判据强度不放宽：仍然是「逐行求和必须整除 12」「同一份网格宽度算法」「读不到数据不许显示 0」
 * 「传原始正文而不是剥过的 text」「词云高度封顶」等，只把**卡片数量/顺序/落点**换成新结构的期望。
 *
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CLOUD_FONT_STEPS, cloudFontCap, layoutWordCloud } from './wordcloud-layout.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const read = (...p: string[]): string => readFileSync(join(...p), 'utf8')
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/** 后端年报主查询（扫描 + 组装）。 */
const review = strip(read(HERE, '..', '..', '..', '..', '..', '..', '..', '..', 'src', 'backend', 'wechat-data', 'src', 'query', 'annual-review.ts'))
/** 年报共享类型（2026-10-30 从主查询拆出，守卫必须跟随真实定义位置）。 */
const reviewTypes = strip(read(HERE, '..', '..', '..', '..', '..', '..', '..', '..', 'src', 'backend', 'wechat-data', 'src', 'query', 'annual-review-types.ts'))
/** 年度面板（默认 8 卡 + 一段「更多」的编排）。 */
const panel = read(HERE, 'Annual.tsx')
/** 「更多」段的实现（2026-09-30 从 `Annual.tsx` 拆出，含分区、词云、卡片与画像）。 */
const more = read(HERE, 'annual-more-cards.tsx')
/** 客户端形状镜像（在上一级目录）。 */
const shape = strip(read(HERE, '..', 'api-status.ts'))

describe('后端：六块新统计都接上了', () => {
  it('AnnualReview 里有 moments / assets / money / revoke / groups 五个字段', () => {
    for (const f of ['moments: AnnualMoments', 'assets: AnnualAssets', 'money: AnnualMoney', 'revoke: AnnualRevoke', 'groups: AnnualGroups']) {
      expect(reviewTypes, `AnnualReview 缺字段 ${f}`).toContain(f)
    }
  })

  it('朋友圈与收藏是**另外的库**：扫描后并行查，再合并进结果', () => {
    expect(review).toContain('queryAnnualMoments(decryptedDir, year)')
    expect(review).toContain('queryAnnualAssets(decryptedDir, selfUsername)')
    expect(review).toMatch(/await Promise\.all\(\[/)
    expect(review).toMatch(/return \{ \.\.\.review, moments, assets \}/)
  })

  it('🔴 行累加器收到的是 body0（原始正文），**不是** text（XML 已剥）', () => {
    expect(review, '传给 extras.onRow 的正文必须是 body0').toMatch(/extras\.onRow\(\s*\{\s*type:\s*lt,\s*ts,\s*text:\s*body0/)
    expect(review, '不许再把 readableText 的结果喂给累加器').not.toMatch(/extras\.onRow\(\s*\{\s*type:\s*lt,\s*ts,\s*text,/)
  })

  it('assemble 的返回类型排除那两个跨库字段（它算不出来，就不该假装有）', () => {
    expect(review).toMatch(/function assemble\(b: Bucket\): Omit<AnnualReview, 'moments' \| 'assets'>/)
  })
})

/** 从一段 TSX 里解析「函数名 → span/tone」。 */
function cardMeta (src: string): { spans: Map<string, number>; tones: Map<string, string> } {
  const spans = new Map<string, number>()
  const tones = new Map<string, string>()
  const lines = src.split('\n')
  const starts: Array<{ name: string; at: number }> = []
  lines.forEach((ln, i) => {
    const m = /^(?:export )?function (\w+)\(/.exec(ln)
    if (m?.[1]) starts.push({ name: m[1], at: i })
  })
  starts.forEach((s, k) => {
    const end = k + 1 < starts.length ? (starts[k + 1]?.at ?? lines.length) - 1 : lines.length - 1
    const body = lines.slice(s.at, end + 1).join('\n')
    // YearPortrait 没有 span 字面量 —— 跨度来自 CSS `.portrait { grid-column: span 6 }`。
    if (/\bcss\.portrait\b/.test(body)) spans.set(s.name, 6)
    else {
      const m = /span=\{(\d+)\}/.exec(body)
      spans.set(s.name, m?.[1] ? Number(m[1]) : 3)
    }
    const t = /tone="(\w+)"/.exec(body)
    if (t?.[1]) tones.set(s.name, t[1])
  })
  return { spans, tones }
}

const annualMeta = cardMeta(panel)
const moreMeta = cardMeta(more)
const spanOf = (name: string): number => annualMeta.spans.get(name) ?? moreMeta.spans.get(name) ?? 6
const toneOf = (name: string): string => annualMeta.tones.get(name) ?? moreMeta.tones.get(name) ?? 'cyan'

/**
 * 解析一个网格块里的「格子名序列」。
 * @param block - 网格内部源码。
 * @returns `{ name, span }[]`（footer/词云也作为格子）。
 */
function gridCells (block: string): Array<{ name: string; span: number }> {
  const out: Array<{ name: string; span: number }> = []
  for (const ln of block.split('\n')) {
    const t = ln.trim()
    const comp = /^<([A-Z]\w*)\s/.exec(t)
    if (comp?.[1]) { out.push({ name: comp[1], span: spanOf(comp[1]) }); continue }
    if (t.startsWith('<div className={css.span6}')) out.push({ name: 'WordCloud', span: 6 })
    else if (t.startsWith('<div className={css.footer}')) out.push({ name: 'footer', span: 12 })
  }
  return out
}

/** 逐行累加：每一行必须正好落在 12 上，且末尾不留空行。 */
function expectRowsFill12 (cells: Array<{ name: string; span: number }>, label: string): void {
  let acc = 0
  const rows: number[][] = []
  for (const c of cells) {
    if (acc + c.span > 12) { rows.push([acc]); acc = 0 }
    acc += c.span
    if (acc === 12) { acc = 0 }
  }
  expect(rows, `${label}：有行没填满 12 列（顺序没排好）`).toEqual([])
  expect(acc, `${label}：最后一行没有填满 12 列`).toBe(0)
}

describe('界面：默认 8 张核心卡 + 「更多年度数据」折叠', () => {
  /**
   * 首屏区块：2026-11-19 起是 `<CardCanvas>`（自由画布），不再是 `<MasonryGrid>`。
   * 页面上有两个画布（首屏 + 折叠区），首屏那个**不带** `scope="more"`，用它区分。
   */
  const mainGrid = /<CardCanvas(?![^>]*scope="more")[^>]*>([\s\S]*?)<\/CardCanvas>/.exec(panel)?.[1] ?? ''
  /** 折叠区画布：按 `scope="more"` 精确定位。 */
  const moreGrid = /<CardCanvas[^>]*scope="more"[^>]*>([\s\S]*?)<\/CardCanvas>/.exec(panel)?.[1] ?? ''

  it('默认可见：**8 张核心卡放在自由画布**（2026-11-19 起不再用 12 列网格）', () => {
    // 首屏从 `<MasonryGrid>` 换成 `<CardCanvas>`：宽度按内容分档、高度随内容、可拖动。
    expect(panel, '首屏应改用 CardCanvas').toContain('<CardCanvas')
    expect(panel, '首屏不该再包在 MasonryGrid 里').not.toMatch(/<MasonryGrid>\s*<HeroCard/)
    // 8 张卡的**顺序**仍然要钉住 —— 它决定初始排布（也是拖动前的阅读顺序）。
    const order = [...mainGrid.matchAll(/<(\w+Card)\s/g)].map((m) => m[1])
    expect(order, '8 张核心卡的组件/顺序').toEqual([
      'HeroCard', 'RhythmCard', 'RankingCard', 'GroupsCard',
      'MoneyCard', 'MomentsCard', 'MediaCallCard', 'ExtremesCard',
    ])
    // 每张卡都必须带 canvasId（位置存储的键）。
    // ⚠️ 5 张卡（groups/money/moments/media/extremes）定义在 annual-more-cards.tsx 里，
    // 所以两处源码都要查。
    for (const id of ['hero', 'rhythm', 'ranking', 'groups', 'money', 'moments', 'media', 'extremes']) {
      expect(panel + more, `缺少 canvasId="${id}"`).toContain(`canvasId="${id}"`)
    }
    // 等宽瀑布流：卡片不再声明宽度档（宽度由容器统一给）。
    expect(panel + more, '还在传 width 档 ⇒ 不是等宽瀑布流').not.toMatch(/canvasId="[\w-]+"\s+width="/)
    expect(mainGrid, '页脚已移出画布（它是一整行文字，没有摆放的意义）').not.toContain('css.footer')
  })

  it('整页只有**一块**画布：25 张卡都在同一条瀑布流里', () => {
    // 2026-11-19 用户要求「不要分为两个分割的画布板块，都在一个画布上显示」。
    // 改前是「首屏画布 + 折叠区画布」两块，中间夹一条折叠标题 —— 读起来像两篇文章。
    const canvases = [...panel.matchAll(/<CardCanvas[\s\S]*?<\/CardCanvas>/g)]
    expect(canvases.length, '页面上出现了多块画布').toBe(1)
    expect(panel, '折叠区（details）已取消').not.toContain('<details className={css.moreSection}>')
    expect(panel, '不该再有第二块画布的作用域').not.toContain('scope="more"')
    // 17 项仍在同一个画布里（顺序也要一致）。
    expect(canvases[0]?.[0], '17 项没进主画布').toContain('<MoreCards data={data} av={av} />')
    expect(panel, '17 项应抽成 MoreCards 组件').toContain('function MoreCards(')
    // 两个词云各是一个画布格子（不再用 `.span6` 的网格 div）。
    expect(panel, '年度热词没进画布').toContain('id="more-wordcloud-global"')
    expect(panel, '朋友圈热词没进画布').toContain('id="more-wordcloud-moments"')
    expect(panel, '还有 `.span6` 网格 div 残留').not.toContain('css.span6')
  })

  it('任何卡片组件都不许绕开外壳自己写卡片类（2026-11-19 遮挡事故）', () => {
    /**
     * 事故现场：`YearPortrait` 原先自己写
     * `<div className={`${css.moreCard} ${css.portrait}`}>`，绕过了 `MoreCard` 外壳 ——
     * 于是它**没有 `data-canvas-id`**，不参与画布布局、留在文档流里撑满整行，
     * 把绝对定位的其它卡片全压住了（用户：「年度画像将后面的内容卡片挡住了」）。
     *
     * 判据：`css.card` / `css.moreCard` 只允许出现在两个外壳的 JSX 里
     * （`Annual.tsx` 的 `Card`、`annual-more-cards.tsx` 的 `MoreCard`），
     * 其它卡片组件一律通过外壳渲染。这样"忘了走外壳"就红在源码上，而不是等用户看见遮挡。
     */
    const bypass = (src: string): string[] => {
      const out: string[] = []
      // 逐个函数体检查：`export function XxxCard(...)` 到下一个函数/文件尾。
      const fnRe = /(?:export )?function (\w+)\([\s\S]*?(?=\n(?:export )?function |\n\/\*\*|$)/g
      for (const m of src.matchAll(fnRe)) {
        const name = m[1] ?? ''
        const body = m[0]
        if (name === 'Card' || name === 'MoreCard') continue
        if (/className=\{[^}]*css\.(?:card|moreCard)\b/.test(body)) out.push(name)
      }
      return out
    }
    const offenders = [...bypass(panel), ...bypass(more)]
    expect(offenders, `这些卡片绕过了外壳（不会有 data-canvas-id ⇒ 会遮挡别人）：${offenders.join('、')}`)
      .toEqual([])
  })

  it('画像卡走外壳、且带 canvasId（本次遮挡的直接修复）', () => {
    const portrait = /export function YearPortrait[\s\S]*?\n\}/.exec(more)?.[0] ?? ''
    expect(portrait, '找不到 YearPortrait').not.toBe('')
    expect(portrait, '画像卡没走 MoreCard 外壳').toContain('<MoreCard')
    expect(portrait, '画像卡缺少 canvasId').toContain('canvasId="more-portrait"')
    expect(portrait, '画像卡还在自己写卡片类').not.toMatch(/css\.moreCard/)
  })

  it('每个 Card / MoreCard 调用都传了 canvasId（没传就退回网格模式 ⇒ 又会遮挡）', () => {
    /**
     * 只"走外壳"还不够：`Card` / `MoreCard` 在**没传 canvasId 时退回网格模式**
     * （渲染 `css.card` / `css.moreCard` 的普通 div）。在画布里那仍是一个文档流元素，
     * 会撑满整行、被绝对定位的卡片压住 —— 和 `YearPortrait` 那次是同一个病。
     *
     * 所以逐个调用检查：开标签里必须有 `canvasId=`。
     */
    const missing: string[] = []
    for (const [file, src] of [['Annual.tsx', panel], ['annual-more-cards.tsx', more]] as const) {
      // 标签名后必须是空白、`/` 或 `>` —— 否则 `<MoreCards>` 会被当成 `<MoreCard>` 误报。
      for (const m of src.matchAll(/<(Card|MoreCard)(?=[\s/>])([\s\S]*?)\/?>/g)) {
        const attrs = m[2] ?? ''
        // 外壳自身的定义处（`function Card({ canvasId, ...`）不会被这个正则命中，
        // 但 `MoreCard` 内部那次 `<CanvasCard` 也不会 —— 这里只匹配 Card / MoreCard 标签。
        if (!attrs.includes('canvasId=')) {
          const title = /title="([^"]*)"/.exec(attrs)?.[1] ?? /title=\{[^}]*\}/.exec(attrs)?.[0] ?? '(无标题)'
          missing.push(`${file}: ${m[1]} ${title}`)
        }
      }
    }
    expect(missing, `这些卡片没传 canvasId，会退回网格模式并被别的卡压住：\n  ${missing.join('\n  ')}`)
      .toEqual([])
  })

  it('默认不再渲染旧的一屏 27 卡（卡片墙已收敛）', () => {
    // 首屏 8 张卡里不该混进明细卡（它们由 `MoreCards` 排在后面）。
    expect(panel, '17 项应抽成 MoreCards 组件').toContain('<MoreCards data={data} av={av} />')
    // 旧注释里的「26 张卡」网格已不存在
    expect(panel, '旧的 moreItems 块必须已消失').not.toContain('moreItems(data, av)')
  })

  it('「更多」卡都还在（功能不减，只是折叠）：资金/撤回/群聊/朋友圈/收藏/词云', () => {
    for (const c of ['<CalendarCard r={data} />', '<MonthlyTrendCard r={data} />', '<MonthlyStarCard r={data} av={av} />',
      '<BuddyCard r={data} av={av} />', '<NightCard r={data} av={av} />', '<YearPortrait r={data} />',
      '<WordsCard r={data} />', '<CatchphraseCard r={data} />', '<ReplyCard r={data} />', '<OpenerCard r={data} />',
      '<EmojiCard r={data} />', '<CatchphraseTopCard r={data} />', '<RevokeCard r={data} />',
      '<AssetsCard r={data} />', '<HighlightsCard r={data} av={av} />',
      '<WordCloudCard scope="global" year={data.year}', '<WordCloudCard scope="moments" year={data.year}']) {
      expect(panel, `折叠区缺板块 ${c}`).toContain(c)
    }
  })

  it('「还有这些人」的小卡按容器宽度自动换列（不再写死三列）', () => {
    expect(panel, '容器没换成可换行的 .hlRow').toContain('css.hlRow')
    expect(styleCode, '.hlRow 必须是网格').toMatch(/\.hlRow \{[^}]*display: grid/)
    /**
     * 2026-11-19：从固定 3 列改成 **auto-fit**。
     * 3 列的前提是"卡片 6 列宽≈750px"，等宽瀑布流下只有约 300px ⇒ 每格 90px，
     * 名字被截成「a憨 2958...」。auto-fit 让列数随宽度变，这就是"自动换行"。
     */
    expect(styleCode, '.hlRow 必须 auto-fit').toMatch(/\.hlRow \{[^}]*repeat\(auto-fit, minmax\(/)
    expect(styleCode, '.hlRow 又写死 3 列了').not.toMatch(/\.hlRow \{[^}]*repeat\(3, minmax/)
    for (const cls of ['\\.moreCell \\{', '\\.moreInfo \\{', '\\.moreLabel \\{', '\\.moreVal \\{']) {
      expect(styleCode, `缺样式：${cls}`).toMatch(new RegExp(cls))
    }
    // 2026-11-19：芯片里的名字允许折两行（原先 nowrap + ellipsis，窄格子里必然截断）。
    expect(styleCode, '.moreCell .name 必须允许折行').toMatch(/\.moreCell \.name \{[^}]*-webkit-line-clamp: 2/)
    expect(styleCode, '.moreCell .name 又回到 nowrap 了').not.toMatch(/\.moreCell \.name \{[^}]*white-space: nowrap/)
  })

  it('同一套内容类不许被重复定义（重复定义会让换行改进静默失效）', () => {
    /**
     * 事故现场（2026-11-19）：`.moreCell` / `.moreInfo` / `.moreLabel` / `.moreVal` /
     * `.moreCell .name` 在 CSS 里被定义了**两遍** —— 前一组允许换行、后一组是旧版的
     * `white-space: nowrap`。后定义的覆盖前者，于是"允许换行"从来没生效过，
     * 且没有任何测试能发现（两处都"存在"，只是后者赢了）。
     *
     * 判据：这几个内容类在剥注释后的样式表里只允许出现一次。
     */
    for (const cls of ['.moreCell', '.moreInfo', '.moreLabel', '.moreVal', '.moreCell .name']) {
      const re = new RegExp(`(^|\\n)${cls.replace('.', '\\.')}\\s*\\{`, 'g')
      const hits = [...styleCode.matchAll(re)]
      expect(hits.length, `${cls} 被定义了 ${String(hits.length)} 次 ⇒ 后者会覆盖前者，改前一处等于白改`)
        .toBe(1)
    }
  })

  it('两块词云给了**高度上限**（自适应公式有 200px 下限，靠做窄压不下去）', () => {
    expect(panel, '年度热词没给高度上限').toMatch(/<WordCloudCard scope="global"[^>]*height=\{120\}/)
    expect(panel, '朋友圈热词没给高度上限').toMatch(/<WordCloudCard scope="moments"[^>]*height=\{120\}/)
    expect(panel).toMatch(/<WordCloudCard scope="global"[^>]*limit=\{56\}/)
    const card = read(HERE, 'WordCloudCard.tsx')
    expect(card, 'WordCloudCard 没有 height 参数').toMatch(/height\?: number/)
    expect(card, '传进来的 height 没被用上').toMatch(/const stageHeight = fill && stageH > 0 \? stageH : \(height \?\? cloudStageHeight\(stageW\)\)/)
  })

  it('整页顺序：一块画布（首屏 8 卡 + 17 项明细）在前，页脚收尾', () => {
    const bodyStart = panel.indexOf('export function AnnualPanel')
    expect(bodyStart, '找不到 AnnualPanel').toBeGreaterThan(0)
    const body = panel.slice(bodyStart)
    const at = (s: string): number => body.indexOf(s)
    // 页脚不在画布里（一整行文字，没有摆放的意义），排在整条瀑布流之后收尾。
    const order = ['<CardCanvas', '<HeroCard r={data} />', '<MoreCards data={data} av={av} />', '</CardCanvas>', '<div className={css.footer}>']
    const idx = order.map(at)
    expect(idx.every((n) => n > 0), '有环节没找到').toBe(true)
    expect(idx, '画布 / 8 卡 / 17 项 / 页脚的顺序变了').toEqual([...idx].sort((a, b) => a - b))
    // 分区标签仍在（挂在卡上）
    for (const z of ['zone="社交互动"', 'zone="作息与习惯"', 'zone="财务与资产"']) {
      expect(more, `缺分区标签 ${z}`).toContain(z)
    }
  })

  it('默认年份走纯函数，不再依赖数组顺序（2026-11-19 修复）', () => {
    /**
     * 事故：`setYear(prev => prev ?? ys.at(-1) ?? …)` —— 后端返回降序，
     * `at(-1)` 每次选中**最旧**的一年（用户打开看到 2020，而最新的是 2026）。
     *
     * 这条守**接线**：面板必须调 `defaultAnnualYear` / `normalizeAnnualYears`，
     * 不许再就地写"取某个位置"的表达式。选值正确性由
     * `annual-default-year.spec.ts` 用降序/升序/乱序三种输入覆盖。
     *
     * ⚠️ 断言前必须先剥注释：本文件的说明里**引用**了旧写法，裸词匹配会被自己骗到
     * （仓库里这类"被注释骗红"已发生多次，见 `outbound-site-coverage.spec.ts` 的 `codeOf`）。
     */
    const code = panel.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
    expect(code, '默认年份应走 defaultAnnualYear').toContain('defaultAnnualYear(')
    expect(code, '年份列表应走 normalizeAnnualYears').toContain('normalizeAnnualYears(')
    expect(code, '不许再用 at(-1) 取年份').not.toMatch(/at\(-1\)/)
    expect(code, '不许再用 ys[ys.length - 1]').not.toMatch(/ys\[ys\.length\s*-\s*1\]/)
  })

  it('读不到数据时说「未读取到」，不许把 0 当真实值', () => {
    expect(more).toMatch(/!m\.available \? \([\s\S]{0,140}未读取到朋友圈数据/)
    expect(more).toMatch(/!a\.available \? \([\s\S]{0,140}未读取到收藏/)
  })

  it('收藏/文件那块标题写明「总量盘点」，并解释为什么不按年', () => {
    expect(more).toContain('收藏与文件 · 总量盘点')
    expect(more).toMatch(/没有可靠的按年时间列/)
  })

  it('资金卡片写清"读不出金额的那笔不计入"（否则会被当成漏统计）', () => {
    expect(more).toMatch(/读不出金额的那笔不计入/)
  })
})

/** 年度面板样式：自适应与"内容溢出容器"的判据都在这里。 */
const styleText = read(HERE, 'annual.module.css')
/** 剥掉注释后的样式 —— 注释里会引用"旧写法"做说明，不剥就会误判（负向断言尤其容易栽）。 */
const styleCode = styleText.replace(/\/\*[\s\S]*?\*\//g, '')

describe('低分辨率适配：内容不许溢出容器', () => {
  it('卡片宽度**跟着内容走**：12 列网格 + dense（不是等宽多列，也不是 JS 测高分列）', () => {
    expect(styleCode).toMatch(/\.board \{[^}]*display: grid/)
    expect(styleCode).toMatch(/\.board \{[^}]*grid-template-columns: repeat\(12, minmax\(0, 1fr\)\)/)
    expect(styleCode, 'dense 才能让小卡回头补空').toMatch(/\.board \{[^}]*grid-auto-flow: dense/)
    // 不同内容给不同跨度：普通卡 1/3、宽内容（词云/画像）半行、页脚整行
    expect(styleCode).toMatch(/\.moreCard \{[^}]*grid-column: span 4/)
    expect(styleCode).toMatch(/\.span6 \{ grid-column: span 6; \}/)
    expect(styleCode).toMatch(/\.footer \{ grid-column: span 12; \}/)
    // 反例：不许再退回"自己测高分列"或多列
    const js = read(HERE, 'annual-masonry.tsx')
    expect(js, '又回去自己测高分列了').not.toContain('getBoundingClientRect')
    expect(js, '又出现了 ResizeObserver 分列').not.toContain('ResizeObserver')
    expect(styleCode, '又出现了等宽多列').not.toMatch(/column-width:\s/)
  })

  it('卡片与行允许长串换行（用户名、群名、连排表情都没有空格可断）', () => {
    expect(styleText).toMatch(/\.moreCard \{[\s\S]{0,900}overflow-wrap: anywhere/)
    expect(styleText).toMatch(/\.moreCard \{[\s\S]{0,300}min-width: 0/)
    /**
     * 2026-11-19：两侧都改成**允许折行**（`overflow-wrap: anywhere`）。
     * 原先标签侧是 `nowrap + ellipsis` —— 等宽瀑布流下卡只有约 300px，
     * 「金额读不出来的那笔不计入合计」被截成「金额读不出...」。
     * 用户要求「不行就自动换行」，所以这里守的是"两侧都能断行、不许再 nowrap"。
     */
    expect(styleText).toMatch(/\.moreRow > span \{[^}]*overflow-wrap: anywhere/)
    expect(styleText, '`.moreRow` 的标签侧又回到 nowrap 了').not.toMatch(/\.moreRow > span:first-child \{[^}]*white-space: nowrap/)
    const moreRowRules = [...styleCode.matchAll(/\.moreRow\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '')
    expect(moreRowRules.length, '`.moreRow` 的基础样式丢了').toBeGreaterThan(0)
    for (const rule of moreRowRules) {
      expect(rule, '身份行不能被 overflow:hidden 裁掉上下边缘').not.toContain('overflow: hidden')
      // 纵向排（≤380px 容器查询）本来就不需要 wrap；横向排的必须允许 wrap。
      if (rule.includes('flex-direction: column')) continue
      expect(rule, '`.moreRow` 必须 flex-wrap: wrap（否则值不肯折行）').toContain('flex-wrap: wrap')
    }
  })

  it('月度趋势的柱子用 flex 等分 + 百分比高度（不写死宽度，任何宽度都不溢出）', () => {
    expect(styleText).toMatch(/\.moreBars \{[^}]*display: flex/)
    expect(styleText).toMatch(/\.moreBarCol \{[^}]*flex: 1 1 0/)
  })

  it('海报卡本身也允许长串换行（紧凑回退下卡片 `overflow:visible`，长串会顶出去）', () => {
    expect(styleText).toMatch(/\.card \{[\s\S]{0,260}overflow-wrap: anywhere/)
  })

  it('整页随面板滚动（默认 8 卡 + 展开更多都走同一个滚动容器）', () => {
    expect(styleCode, '滚动容器必须常开').toMatch(/\.scrollBody \{[^}]*overflow-y: auto/)
    expect(panel).not.toContain('data-compact')
  })
})

describe('间隙与卡内留白：走全站刻度，板块之间要接上', () => {
  /**
   * 2026-11-19 舒适化重做后，这里的判据从「写死的旧数值」改成**跨段一致性**。
   *
   * 原来它钉的是 `.board gap: var(--nm-dense-g4)`、`.moreCard padding: 10px 12px`、
   * `.heroNum 28px` 这些具体值 —— 但舒适化本来就要改这些值，钉死只会让每次调间距
   * 都得改测试数字（那测试就退化成"抄一遍 CSS"）。
   *
   * 这条规则**真正要守的**是：上下两段（海报卡 / 更多卡）用同一套刻度，
   * 不许一段 8px 一段 16px 各说各话。所以改成：
   *   · 间距必须由刻度令牌推导（`var(--nm-dense-g*)` 或 `calc(...g4 * N)`）；
   *   · 两段的 padding / 标题色 / 附注字号 / 主数字 必须**逐字相同**。
   */
  it('间距由刻度令牌推导，不是裸 px', () => {
    expect(styleCode, '网格间距要由刻度推导').toMatch(/\.board \{[^}]*gap: (?:calc\()?var\(--nm-dense-g/)
    expect(styleCode, 'moreList 间距要由刻度推导').toMatch(/\.moreList \{[^}]*gap: var\(--nm-dense-g/)
    expect(styleCode, 'moreCard 又加回竖向 margin 了').not.toMatch(/\.moreCard \{[^}]*margin: 0 0/)
  })

  it('上下两段是**同一套设计语言**：内边距/标题/附注/主数字逐字对齐', () => {
    /** 取一条规则里某个声明的值（声明顺序无关）。 */
    const declOf = (selector: string, prop: string): string | null => {
      const block = new RegExp(`\\${selector} \\{([^}]*)\\}`.replace('\\' + selector, selector)).exec(styleCode)
      if (!block?.[1]) return null
      const m = new RegExp(`${prop}:\\s*([^;]+);`).exec(block[1])
      return m?.[1]?.trim() ?? null
    }
    // 海报卡与更多卡内边距必须相同（骨架卡也照抄）—— 不一致会在加载完成时"长高几像素"。
    expect(declOf('.card', 'padding'), '海报卡缺 padding').not.toBeNull()
    expect(declOf('.moreCard', 'padding'), '两段内边距不一致').toBe(declOf('.card', 'padding'))
    expect(declOf('.skelCard', 'padding'), '骨架与真实卡片内边距不一致').toBe(declOf('.card', 'padding'))
    // 标题色 / 附注字号：两段同值（层级怎么定都行，但不能一段一个样）。
    expect(declOf('.moreCardTitle', 'color')).toBe(declOf('.cardTitle', 'color'))
    expect(declOf('.moreCardExtra', 'font-size')).toBe(declOf('.cardExtra', 'font-size'))
    // 分区标签必须是中性小字（任何彩色都属于另一套视觉语言）
    expect(styleCode).toMatch(/\.zoneTag \{[^}]*color: var\(--nm-text-3\)/)
    expect(styleCode).not.toMatch(/\.zoneTag \{[^}]*var\(--nm-cyan\)/)
  })

  it('宽度自适应：窄面板退列（12 → 8 → 6 → 1），跨度等比例减半', () => {
    expect(styleCode, '缺少 1440px 退列（12 → 8）').toMatch(/@media \(max-width: 1440px\)/)
    expect(styleCode, '缺少 1100px 退列（8 → 6）').toMatch(/@media \(max-width: 1100px\)/)
    expect(styleCode, '缺少 760px 单列').toMatch(/@media \(max-width: 760px\)/)
    expect(styleCode, '退列后要等比例改跨度').toMatch(/\.board > \.card, \.board > \.moreCard \{ grid-column: span 3 !important; \}/)
    expect(styleCode, '窄屏要退成整页单列').toMatch(/\.board \{[^}]*grid-template-columns: minmax\(0, 1fr\)/)
    expect(styleCode, '单列档的跨度中和特异性不够 ⇒ 会被上面两档的 span 盖掉')
      .toMatch(/\.board > \.card, \.board > \.moreCard, \.board > \.span6, \.board > \.portrait, \.board > \.footer \{ grid-column: 1 \/ -1 !important; \}/)
    const js = read(HERE, 'annual-masonry.tsx')
    expect(js).not.toContain('ResizeObserver')
    expect(js).not.toContain('getBoundingClientRect')
  })

  it('横向行统一换行：标签←→数值 式的行在窄卡里都要能换行', () => {
    const rule = [...styleCode.matchAll(/@container \(max-width: 620px\) \{[\s\S]*?\}/g)].map((m) => m[0]).join(String())
    expect(rule, '缺少 620px 的换行规则').toBeTruthy()
    for (const cls of ['.kv', '.row', '.rankRow', '.nightTop', '.calFoot', '.moreRow']) {
      expect(rule, `${cls} 没有加进换行规则`).toContain(cls)
    }
    expect(styleCode, '换行后数值要改成左对齐').toContain('text-align: left')
    /**
     * 2026-11-19 反转：`.hlRow` 从**固定 3 列**改成 **auto-fit**。
     *
     * 3 列的前提是"卡片占 6 列≈750px"，而等宽瀑布流下整张卡只有约 300px ⇒
     * 每格约 90px，名字被截成「a憨 2958...」。auto-fit 让列数随宽度自己变
     * （这是用户说的「不行就自动换行」）。这里守的就是"不许再写死列数"。
     */
    expect(styleCode, '.hlRow 必须用 auto-fit（写死列数会在窄卡里挤爆）')
      .toMatch(/\.hlRow \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(/)
    expect(styleCode, '.hlRow 又写死列数了').not.toMatch(/\.hlRow \{[^}]*repeat\(3, minmax/)
  })

  it('卡片内部适配：按**卡片宽度**（容器查询）而不是窗口宽度退形态', () => {
    expect(styleCode, '.card 没有声明为容器').toMatch(/\.card \{[^}]*container-type: inline-size/)
    expect(styleCode, '.moreCard 没有声明为容器').toMatch(/\.moreCard \{[^}]*container-type: inline-size/)
    for (const w of [620, 520, 380]) {
      expect(styleCode, `缺少 @container (max-width: ${String(w)}px)`).toContain(`@container (max-width: ${String(w)}px)`)
    }
    expect(styleCode).toMatch(/@container \(max-width: 520px\) \{[\s\S]*?starGrid \{ grid-template-columns: repeat\(6,/)
    expect(styleCode).toMatch(/@container \(max-width: 380px\) \{[\s\S]*?heroGrid \{ grid-template-columns: minmax\(0, 1fr\)/)
    const js = read(HERE, 'annual-masonry.tsx')
    expect(js).not.toContain('ResizeObserver')
  })

  it('海报卡的内容竖直分散 → 顶部对齐（`space-between` 会把内容拉散）', () => {
    expect(styleCode).toMatch(/\.cardBody \{[^}]*justify-content: flex-start/)
    expect(styleCode, '又退回 space-between 了（会把内容拉散）').not.toMatch(/\.cardBody \{[^}]*justify-content: space-between/)
  })
})

describe('微信化：中性 + 1 强调色、去渐变/emoji/大阴影', () => {
  it('7 个语义 tone 保留在数据里，但视觉只留中性线 + 1 个主色强调（green）', () => {
    // 中性是**默认**：所有 tone 共用一条分隔线色
    expect(styleCode).toMatch(/\.card\[data-tone\][\s\S]{0,160}--tone-line: var\(--nm-border-hover\)/)
    // 唯一强调：green（资金/资产）用主色
    expect(styleCode).toMatch(/\.card\[data-tone='green'\][\s\S]{0,160}--tone-line: var\(--nm-cyan\)/)
    // 其余 6 个语义色不得再出现在 tone 规则里
    const toneBlock = styleCode.slice(styleCode.indexOf('语义色调'), styleCode.indexOf('.cardHead'))
    for (const c of ['purple', 'pink', 'amber', 'blue', 'red']) {
      expect(toneBlock, `tone 规则里还留着 ${c} 语义色`).not.toContain(`--nm-${c}`)
    }
    // 卡片标题不再按 tone 染色（全部走 --nm-text-2）
    expect(styleCode, '又出现按 tone 染标题的规则').not.toMatch(/\[data-tone='(purple|pink|amber|blue|red|cyan)'\][^{]*\.cardTitle/)
  })

  it('去装饰：无渐变、无毛玻璃、无发光/大阴影、无装饰动画', () => {
    expect(styleCode, '还有渐变').not.toMatch(/(linear|radial)-gradient/)
    expect(styleCode, '还有毛玻璃').not.toMatch(/backdrop-filter/)
    expect(styleCode, '还有发光/大阴影').not.toMatch(/box-shadow:/)
    expect(styleCode, '还有装饰动画').not.toMatch(/animation:/)
    expect(styleCode, '还有 keyframes').not.toMatch(/@keyframes/)
  })

  it('去 emoji 图标记号', () => {
    // 只看代码：注释里的「⚠️」等提醒符号不算 UI 图标记号。
    expect(strip(panel), 'Annual.tsx 里还有 emoji').not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
    expect(strip(more), 'annual-more-cards.tsx 里还有 emoji').not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u)
  })
})

describe('客户端形状：与后端接口对齐', () => {
  it('AnnualReviewShape 有五个新字段与对应形状', () => {
    expect(shape, '客户端主形状必须转发共享 AnnualReview，而不是再镜像一份').toContain('export type AnnualReviewShape = AnnualReview')
    for (const line of ['export interface AnnualMoments', 'export interface AnnualAssets', 'export interface AnnualMoney',
      'export interface AnnualRevoke', 'export interface AnnualGroups']) {
      expect(shape, `api-status.ts 缺 ${line}`).toContain(line)
    }
  })

  it('可空性口径跟着后端：available 是必需字段（不是可选）', () => {
    expect(shape).toMatch(/available: boolean/)
    expect(shape, 'available 不该是可选 —— 可选会让界面漏判"没读到"').not.toMatch(/available\?: boolean/)
  })
})

describe('词云字号：跟着舞台高度封顶（用户："字体整体过大"）', () => {
  it('小舞台按更陡的系数封顶：120px → 14px；200px 及以上仍是阶梯顶档 48px（主词云面板不变）', () => {
    expect(cloudFontCap(120)).toBe(14)
    expect(cloudFontCap(160)).toBe(19)
    expect(cloudFontCap(200)).toBe(CLOUD_FONT_STEPS[CLOUD_FONT_STEPS.length - 1])
    expect(cloudFontCap(420)).toBe(CLOUD_FONT_STEPS[CLOUD_FONT_STEPS.length - 1])
    expect(cloudFontCap(0)).toBeGreaterThan(0)
    expect(cloudFontCap(Number.NaN)).toBeGreaterThan(0)
  })

  it('真跑一次小舞台布局：**没有任何一个词的最终字号超过上限**', () => {
    const words = Array.from({ length: 30 }, (_, i) => ({
      text: '测试词' + String(i), count: 100 - i, size: CLOUD_FONT_STEPS[CLOUD_FONT_STEPS.length - 1]!, tone: 'top' as const,
    }))
    const small = layoutWordCloud(words, { width: 490, height: 120 })
    expect(small.placed.length).toBeGreaterThan(0)
    expect(Math.max(...small.placed.map((w) => w.size)), '小舞台里出现了超过封顶的字号').toBeLessThanOrEqual(cloudFontCap(120))
    const big = layoutWordCloud(words, { width: 900, height: 300 })
    expect(Math.max(...big.placed.map((w) => w.size))).toBeLessThanOrEqual(CLOUD_FONT_STEPS[CLOUD_FONT_STEPS.length - 1]!)
  })
})

describe('规格统一：头像 / 字号令牌', () => {
  it('头像规格只定义一次（AVATAR_SIZE），所有调用点都引用它', () => {
    expect(commonSrc, '缺 AVATAR_SIZE 常量').toMatch(/export const AVATAR_SIZE = \d+/)
    for (const [name, src] of [['Annual.tsx', panel], ['annual-more-cards.tsx', more]] as const) {
      expect(src, name + ' 里还有写死的头像尺寸').not.toMatch(/<Avatar[^>]*size=\{\d+\}/)
    }
    const uses = (panel.match(/size=\{AVATAR_SIZE\}/g) ?? []).length + (more.match(/size=\{AVATAR_SIZE\}/g) ?? []).length
    expect(uses, '引用 AVATAR_SIZE 的地方太少，像是漏改了').toBeGreaterThanOrEqual(6)
  })

  it('年报样式里的字号一律走 dense 令牌（不许混半档 --nm-fs-xs, 11px）', () => {
    expect(styleCode, '残留了非 dense 字号令牌').not.toMatch(/--nm-fs-/)
    expect(styleCode).toMatch(/var\(--nm-dense-fs\)/)
  })
})

/** 年报里两个会渲染卡片/头像的文件。 */
const moreCards = read(HERE, 'annual-more-cards.tsx')
const commonSrc = read(HERE, 'annual-common.tsx')
