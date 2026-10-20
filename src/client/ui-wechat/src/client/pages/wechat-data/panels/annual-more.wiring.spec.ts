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
/** 年度面板（默认 8 卡 + 一段「更多」的编排）。 */
const panel = read(HERE, 'Annual.tsx')
/** 「更多」段的实现（2026-09-30 从 `Annual.tsx` 拆出，含分区、词云、卡片与画像）。 */
const more = read(HERE, 'annual-more-cards.tsx')
/** 客户端形状镜像（在上一级目录）。 */
const shape = strip(read(HERE, '..', 'api-status.ts'))

describe('后端：六块新统计都接上了', () => {
  it('AnnualReview 里有 moments / assets / money / revoke / groups 五个字段', () => {
    for (const f of ['moments: AnnualMoments', 'assets: AnnualAssets', 'money: AnnualMoney', 'revoke: AnnualRevoke', 'groups: AnnualGroups']) {
      expect(review, `AnnualReview 缺字段 ${f}`).toContain(f)
    }
  })

  it('朋友圈与收藏是**另外的库**：扫描后并行查，再合并进结果', () => {
    expect(review).toContain('queryAnnualMoments(decryptedDir, year)')
    expect(review).toContain('queryAnnualAssets(decryptedDir, selfUsername)')
    expect(review).toMatch(/await Promise\.all\(\[/)
    expect(review).toMatch(/return \{ \.\.\.review, moments, assets \}/)
  })

  it('🔴 行累加器收到的是 body0（原始正文），**不是** text（XML 已剥）', () => {
    expect(review, '传给 extras.onRow 的正文必须是 body0').toMatch(/extras\.onRow\(\s*\{\s*type: lt, ts, text: body0/)
    expect(review, '不许再把 readableText 的结果喂给累加器').not.toMatch(/extras\.onRow\(\s*\{\s*type: lt, ts, text,/)
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
  const mainGrid = /<MasonryGrid>([\s\S]*?)<\/MasonryGrid>/.exec(panel)?.[1] ?? ''
  const moreGrid = /<div className=\{`\$\{css\.board\} \$\{css\.boardMore\}`\}>([\s\S]*?)<\/div>\s*<\/details>/.exec(panel)?.[1] ?? ''
  const mainCells = gridCells(mainGrid)
  const moreCells = gridCells(moreGrid)

  it('默认可见：**8 张卡 + 页脚**，合计 48 列 = 12×4，每行正好 12', () => {
    expect(mainGrid, 'Annual.tsx 里应有 <MasonryGrid> 块').not.toBe('')
    expect(mainCells.map(c => c.name).filter(n => n !== 'footer'), '默认可见卡片数不对').toHaveLength(8)
    expect(mainCells.map(c => c.name), '8 张核心卡的组件/顺序').toEqual([
      'HeroCard', 'RhythmCard', 'GroupsCard', 'ExtremesCard', 'RankingCard', 'MoneyCard', 'MomentsCard', 'MediaCallCard', 'footer',
    ])
    const sum = mainCells.reduce((a, b) => a + b.span, 0)
    expect(sum, '默认网格总列数必须是 12 的整数倍').toBe(48)
    expectRowsFill12(mainCells, '默认 8 卡')
  })

  it('「更多年度数据」是原生 details：17 项，合计 84 列 = 12×7，每行正好 12', () => {
    expect(panel, '缺少「更多年度数据」折叠区').toContain('<details className={css.moreSection}>')
    expect(panel, '缺少折叠标题').toContain('更多年度数据（17 项）')
    expect(panel, '缺少更多网格').toContain('css.boardMore')
    expect(moreCells.map(c => c.name).filter(n => n !== 'footer'), '折叠区项数不对').toHaveLength(17)
    expect(moreCells.map(c => c.name), '折叠区的卡片顺序').toEqual([
      'CalendarCard', 'MonthlyTrendCard', 'MonthlyStarCard', 'BuddyCard', 'NightCard', 'YearPortrait',
      'WordsCard', 'CatchphraseCard', 'ReplyCard', 'OpenerCard', 'EmojiCard',
      'CatchphraseTopCard', 'RevokeCard', 'AssetsCard', 'HighlightsCard', 'WordCloud', 'WordCloud',
    ])
    const sum = moreCells.reduce((a, b) => a + b.span, 0)
    expect(sum, '折叠网格总列数必须是 12 的整数倍').toBe(84)
    expectRowsFill12(moreCells, '更多 17 项')
  })

  it('默认不再渲染旧的一屏 27 卡（卡片墙已收敛）', () => {
    expect(mainGrid, '默认网格里还塞着旧卡片').not.toContain('<CalendarCard')
    expect(mainGrid, '默认网格里还塞着旧卡片').not.toContain('<YearPortrait')
    expect(mainGrid, '默认网格里还塞着旧卡片').not.toContain('<BuddyCard')
    // 旧注释里的「26 张卡」网格已不存在
    expect(panel, '旧的 moreItems 块必须已消失').not.toContain('moreItems(data, av)')
    expect(panel, '还留着 MoreSection 段容器').not.toContain('MoreSection')
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

  it('「还有这些人」的小卡放不下要换行（.hlRow 三列网格）', () => {
    expect(panel, '容器没换成可换行的 .hlRow').toContain('css.hlRow')
    expect(styleCode, '.hlRow 必须是网格').toMatch(/\.hlRow \{[^}]*display: grid/)
    expect(styleCode, '.hlRow 必须是三列').toMatch(/\.hlRow \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/)
    for (const cls of ['\\.moreCell \\{', '\\.moreInfo \\{', '\\.moreLabel \\{', '\\.moreVal \\{']) {
      expect(styleCode, `缺样式：${cls}`).toMatch(new RegExp(cls))
    }
    expect(styleCode).toMatch(/\.moreCell \.name \{[^}]*text-overflow: ellipsis/)
  })

  it('两块词云给了**高度上限**（自适应公式有 200px 下限，靠做窄压不下去）', () => {
    expect(panel, '年度热词没给高度上限').toMatch(/<WordCloudCard scope="global"[^>]*height=\{120\}/)
    expect(panel, '朋友圈热词没给高度上限').toMatch(/<WordCloudCard scope="moments"[^>]*height=\{120\}/)
    expect(panel).toMatch(/<WordCloudCard scope="global"[^>]*limit=\{56\}/)
    const card = read(HERE, 'WordCloudCard.tsx')
    expect(card, 'WordCloudCard 没有 height 参数').toMatch(/height\?: number/)
    expect(card, '传进来的 height 没被用上').toMatch(/const stageHeight = fill && stageH > 0 \? stageH : \(height \?\? cloudStageHeight\(stageW\)\)/)
  })

  it('整页顺序：默认网格在前，「更多年度数据」在其后', () => {
    const at = (s: string): number => panel.indexOf(s)
    const order = ['<MasonryGrid>', '<HeroCard r={data} />', '<div className={css.footer}>', '</MasonryGrid>', '<details className={css.moreSection}>']
    const idx = order.map(at)
    expect(idx.every((n) => n > 0), '有环节没找到').toBe(true)
    expect(idx, '分区/卡片顺序变了').toEqual([...idx].sort((a, b) => a - b))
    // 分区标签仍在（挂在卡上）
    for (const z of ['zone="社交互动"', 'zone="作息与习惯"', 'zone="财务与资产"']) {
      expect(more, `缺分区标签 ${z}`).toContain(z)
    }
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

  it('卡片与行允许长串换行 / 省略（用户名、群名、连排表情都没有空格可断）', () => {
    expect(styleText).toMatch(/\.moreCard \{[\s\S]{0,900}overflow-wrap: anywhere/)
    expect(styleText).toMatch(/\.moreCard \{[\s\S]{0,300}min-width: 0/)
    expect(styleText).toMatch(/\.moreRow > span:first-child \{[^}]*text-overflow: ellipsis/)
    expect(styleText).toMatch(/\.moreRow > span:last-child \{[^}]*overflow-wrap: anywhere/)
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
  it('间距走 `--nm-dense-g*` 刻度，不再是裸 px 各说各话', () => {
    expect(styleCode).toMatch(/\.moreList \{[^}]*gap: var\(--nm-dense-g1\)/)
    expect(styleCode).toMatch(/\.moreCard \{[\s\S]{0,260}padding: 10px 12px/)
    expect(styleCode, '网格间距：与海报卡同刻度').toMatch(/\.board \{[^}]*gap: var\(--nm-dense-g4\)/)
    expect(styleCode, 'moreCard 又加回竖向 margin 了').not.toMatch(/\.moreCard \{[^}]*margin: 0 0/)
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

  it('上下两段是**同一套设计语言**：间隙、卡片标题、数字逐字对齐', () => {
    expect(styleCode, '间距只由 .board 的 gap 给').toMatch(/\.board \{[^}]*gap: var\(--nm-dense-g4\)/)
    expect(styleCode).toMatch(/\.moreCardTitle \{[^}]*color: var\(--nm-text-2\)/)
    expect(styleCode).toMatch(/\.moreCardExtra \{[^}]*font-size: var\(--nm-dense-fs-sm\)[^}]*color: var\(--nm-text-3\)/)
    expect(styleCode).toMatch(/\.moreNum \{[^}]*font-size: 24px/)
    expect(styleCode).toMatch(/\.cardTitle \{[^}]*color: var\(--nm-text-2\)/)
    expect(styleCode).toMatch(/\.heroNum \{[^}]*font-size: 28px/)
    // 分区标签必须是中性小字（任何彩色都属于另一套视觉语言）
    expect(styleCode).toMatch(/\.zoneTag \{[^}]*color: var\(--nm-text-3\)/)
    expect(styleCode).not.toMatch(/\.zoneTag \{[^}]*var\(--nm-cyan\)/)
  })

  it('横向行统一换行：标签←→数值 式的行在窄卡里都要能换行', () => {
    const rule = [...styleCode.matchAll(/@container \(max-width: 620px\) \{[\s\S]*?\}/g)].map((m) => m[0]).join(String())
    expect(rule, '缺少 620px 的换行规则').toBeTruthy()
    for (const cls of ['.kv', '.row', '.rankRow', '.nightTop', '.calFoot', '.moreRow']) {
      expect(rule, `${cls} 没有加进换行规则`).toContain(cls)
    }
    expect(styleCode, '换行后数值要改成左对齐').toContain('text-align: left')
    expect(styleCode, '.hlRow 必须是三列网格').toMatch(/\.hlRow \{[^}]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/)
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
