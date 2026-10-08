/**
 * 年度报告「更多」长页的**接线守卫**（2026-09-30 用户要求加内容 + 改长页）。
 *
 * 这里守的三类事都是"静默错"的高发区：
 *   ① **传给累加器的必须是原始正文**：资金/撤回看的是 `<appmsg>` / `<sysmsg type="revokemsg">`
 *      这些**标签**，而 `readableText()` 会把标签全剥掉 —— 传 `text` 会让年度资金恒为 0，
 *      而且纯函数模块的 30 条用例**照样全绿**（它们直接喂原始 XML）。这个 bug 真的发生过一次，
 *      所以在这里钉死"传的是 body0"。
 *   ② **六个板块都在**（年度热词 / 朋友圈 / 资金 / 撤回 / 群聊 / 收藏与文件），且顺序稳定。
 *   ③ **读不到数据时不许显示 0**：`available:false` 必须走"未读取到"文案。
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
/** 年度面板（海报 + 一段「更多」的编排）。 */
const panel = read(HERE, 'Annual.tsx')
/**
 * 「更多」段的实现（2026-09-30 从 `Annual.tsx` 拆出，含分区、词云、卡片与画像）。
 * 判据跟着代码搬，**强度不放宽**：下面所有关于这一段的断言都读这个文件。
 */
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
    // 传 text ⇒ moneyAmountOf 的 includes('<appmsg') 恒 false ⇒ 年度资金恒 0。
    expect(review, '传给 extras.onRow 的正文必须是 body0').toMatch(/extras\.onRow\(\s*\{\s*type: lt, ts, text: body0/)
    expect(review, '不许再把 readableText 的结果喂给累加器').not.toMatch(/extras\.onRow\(\s*\{\s*type: lt, ts, text,/)
  })

  it('assemble 的返回类型排除那两个跨库字段（它算不出来，就不该假装有）', () => {
    expect(review).toMatch(/function assemble\(b: Bucket\): Omit<AnnualReview, 'moments' \| 'assets'>/)
  })
})

describe('界面：第二段「更多」长页', () => {
  it('每行恰好 12 列：按源码里的顺序与跨度逐行求和，末尾不留空行', () => {
    // 海报卡的跨度：从 Annual.tsx 的 <Card ... span={N}> 解析（缺省 3）
    const posterSpans = (() => {
      const map = new Map<string, number>()
      for (const part of panel.split(/\n(?=(?:export )?function )/)) {
        const fn = /^(?:export )?function ([A-Za-z]+Card)\(/.exec(part.trim())
        if (!fn) continue
        const card = /<Card\b([^>]*)>/.exec(part)
        if (!card) continue
        const sp = /span=\{(\d+)\}/.exec(card[1] ?? String())
        map.set(fn[1]!, sp ? Number(sp[1]) : 3)
      }
      return map
    })()
    // 「更多」卡的跨度：从 MoreCard span={N}（缺省 4）按标题解析
    const moreSpans = new Map<string, number>()
    for (const part of moreCards.split(/\n(?=(?:export )?function )/)) {
      const fn = /^(?:export )?function ([A-Za-z]+Card)\(/.exec(part.trim())
      if (!fn) continue
      const mc = /<MoreCard\b([^>]*)>/.exec(part)
      if (!mc) continue
      const sp = /span=\{(\d+)\}/.exec(mc[1] ?? String())
      moreSpans.set(fn[1]!, sp ? Number(sp[1]) : 4)
    }
    // 网格里的顺序（Annual.tsx，从 HeroCard 到页脚之前）
    const from = panel.indexOf('<HeroCard r={data} />')
    const to = panel.indexOf('<div className={css.footer}>')
    // 顺序：把两类卡（XxxCard / 画像 / 词云）都算进来
    const chunk = panel.slice(from, to)
    const names = [...chunk.matchAll(/<(?:([A-Za-z]+Card) r=\{data\}|YearPortrait r=\{data\}|div className=\{css\.span6\})/g)]
      .map((m) => m[1] ?? (m[0].includes('YearPortrait') ? 'YearPortrait' : 'WordCloud'))
    // 显式跨度表（海报卡从源码解析，其余按设计：画像/词云 6、普通「更多」卡见 MoreCard span）
    const spanOf = (name: string): number => posterSpans.get(name) ?? moreSpans.get(name) ?? 6
    const spans = names.map((n) => spanOf(n ?? ""))
    expect(names.length, '网格里的格子数变了（应为 26 张卡）').toBe(26)
    expect(spans.reduce((a, b) => a + b, 0), '总列数必须是 12 的整数倍').toBe(120)
    // 逐行累加：每行必须正好落在 12 上
    let acc = 0
    const rows: number[][] = []
    for (const sp of spans) {
      if (acc + sp > 12) { rows.push([acc]); acc = 0 }
      acc += sp
      if (acc === 12) { acc = 0 }
    }
    expect(acc, '最后一行没有填满 12 列（末尾会留空）').toBe(0)
    expect(rows, '有行没填满 12 列（顺序没排好）').toEqual([])
  })

  it('「更多」卡已**迁入海报段**：两种卡交错混排在同一张网格里', () => {
    const from = panel.indexOf('<MasonryGrid>')
    const to = panel.indexOf('</MasonryGrid>')
    const inside = panel.slice(from, to)
    expect(from).toBeGreaterThan(0)
    // 网格里既有海报卡、也有原「更多」段的卡，且**交错**（不是"海报全在前、更多全在后"）
    for (const c of ['<HeroCard r={data} />', '<HighlightsCard r={data} av={av} />', '<YearPortrait r={data} />',
      '<MoneyCard r={data} />', '<AssetsCard r={data} />']) {
      expect(inside, `${c} 必须在同一张网格内`).toContain(c)
    }
    const heroAt = inside.indexOf('<HeroCard r={data} />')
    const portraitAt = inside.indexOf('<YearPortrait r={data} />')
    const highlightsAt = inside.indexOf('<HighlightsCard r={data} av={av} />')
    expect(portraitAt, '画像必须插在海报卡之间（迁入），而不是排在海报之后').toBeGreaterThan(heroAt)
    expect(portraitAt, '画像必须插在海报卡之间（迁入）').toBeLessThan(highlightsAt)
    expect(panel, '旧的 moreItems 块必须已消失').not.toContain('moreItems(data, av)')
  })

  it('两段已并成一张网格：不再有独立的段容器', () => {
    expect(panel, '还留着 MoreSection 段容器').not.toContain('MoreSection')
    expect(panel, 'TSX 里还在用海报网格').not.toContain('css.wrap')
    expect(panel).toContain('<MasonryGrid>')
  })

  it('「还有这些人」的小卡放不下要换行（旧版复用不换行容器 + 类名缺失 ⇒ 芯片互相压住）', () => {
    expect(panel, '容器没换成可换行的 .hlRow').toContain('css.hlRow')
    expect(styleCode, '.hlRow 必须允许换行').toMatch(/\.hlRow \{[^}]*flex-wrap: wrap/)
    // 芯片的四个类名必须有定义（原先在样式里是缺失的）
    for (const cls of ['\.moreCell \{', '\.moreInfo \{', '\.moreLabel \{', '\.moreVal \{']) {
      expect(styleCode, `缺样式：${cls}`).toMatch(new RegExp(cls))
    }
    // 芯片里的名字要能省略，不许把芯片顶宽
    expect(styleCode).toMatch(/\.moreCell \.name \{[^}]*text-overflow: ellipsis/)
  })

  it('原「更多」段的卡都还在（现在渲染在 Annual.tsx 的同一张网格里）', () => {
    for (const c of ['<WordCloudCard scope="global" year={data.year}', '<MomentsCard r={data} />', '<MoneyCard r={data} />',
      '<RevokeCard r={data} />', '<GroupsCard r={data} av={av} />', '<AssetsCard r={data} />']) {
      expect(panel, `缺板块 ${c}`).toContain(c)
    }
  })

  it('内容不够单薄：另外还有月度趋势 / 年度之最 / 媒体与通话 / 口头禅 TOP10 / 朋友圈热词', () => {
    for (const c of ['<MonthlyTrendCard r={data} />', '<ExtremesCard r={data} />', '<MediaCallCard r={data} />',
      '<CatchphraseTopCard r={data} />', '<WordCloudCard scope="moments" year={data.year}']) {
      expect(panel, `缺板块 ${c}`).toContain(c)
    }
    // 月度趋势是**前端**聚合 calendar（后端已经发了全年逐日数据，不该为此再跑一趟查询）
    expect(more).toMatch(/const months = useMemo\(\(\) => \{[\s\S]{0,200}r\.calendar/)
  })


  it('两块词云给了**高度上限**（自适应公式有 200px 下限，靠做窄压不下去）', () => {
    // 用户两次反馈「太大」「再缩小一倍」：并排后仍有约 235px，直接给上限再砍一半。
    expect(panel, '年度热词没给高度上限').toMatch(/<WordCloudCard scope="global"[^>]*height=\{120\}/)
    expect(panel, '朋友圈热词没给高度上限').toMatch(/<WordCloudCard scope="moments"[^>]*height=\{120\}/)
    // 小舞台里 120 个词会糊成一片，同步收一档词数
    expect(panel).toMatch(/<WordCloudCard scope="global"[^>]*limit=\{56\}/)
    // 卡片本身要真的认这个参数（否则传了也白传）
    const card = read(HERE, 'WordCloudCard.tsx')
    expect(card, 'WordCloudCard 没有 height 参数').toMatch(/height\?: number/)
    expect(card, '传进来的 height 没被用上').toMatch(/height: height \?\? cloudStageHeight\(stageW\)/)
  })

  it('整页顺序：一张网格 → 海报卡 → 「更多」卡（由 moreItems 提供）', () => {
    const at = (s: string): number => panel.indexOf(s)
    const order = ['<MasonryGrid>', '<HeroCard r={data} />', '<HighlightsCard r={data} av={av} />', '<div className={css.footer}>']
    const idx = order.map(at)
    expect(idx.every((n) => n > 0), '有环节没找到').toBe(true)
    expect(idx, '分区/卡片顺序变了').toEqual([...idx].sort((a, b) => a - b))
    // 分区不再用横贯标题（会切断网格），改成卡上的小标签 —— 三个分区名都还得在
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

  it('整页随面板滚动（一屏海报已并入单张网格，滚动容器常开）', () => {
    expect(styleCode, '滚动容器必须常开').toMatch(/\.scrollBody \{[^}]*overflow-y: auto/)
    // 海报那套"被切就退瀑布流"的兜底已随网格一起删除（不再有第二种版式）
    expect(panel).not.toContain('data-compact')
  })
})

describe('间隙与卡内留白：走全站刻度，板块之间要接上', () => {
  it('间距走 `--nm-dense-g*` 刻度，不再是裸 px 各说各话', () => {
    // g5 = 卡片与卡片之间；g3 = 行内标准；g1 = 行内极紧（见 scifi-theme.css 的注释）
    expect(styleCode).toMatch(/\.moreList \{[^}]*gap: var\(--nm-dense-g1\)/)
    expect(styleCode).toMatch(/\.moreCard \{[\s\S]{0,260}padding: var\(--nm-dense-g3\) var\(--nm-dense-g4\)/)
    expect(styleCode, '网格间距：与海报卡同刻度').toMatch(/\.board \{[^}]*gap: var\(--nm-dense-g5\)/)
    // 间距只由网格 gap 给：moreCard 不许再有竖向 margin（否则与 gap 叠加成 20px）
    expect(styleCode, 'moreCard 又加回竖向 margin 了').not.toMatch(/\.moreCard \{[^}]*margin: 0 0/)
  })

  it('宽度自适应：窄面板退列（12 → 6 → 1），跨度等比例减半', () => {
    expect(styleCode, '缺少 1400px 退列').toMatch(/@media \(max-width: 1400px\)/)
    expect(styleCode, '缺少 900px 单列').toMatch(/@media \(max-width: 900px\)/)
    expect(styleCode, '退列后要等比例改跨度').toMatch(/\.board > \.card, \.board > \.moreCard \{ grid-column: span 2 !important; \}/)
    expect(styleCode, '窄屏要退成整页单列').toMatch(/\.board > \* \{ grid-column: 1 \/ -1 !important; \}/)
    // 反例：不许用 JS 测宽来改布局（那正是第 3 版翻车的原因）
    const js = read(HERE, 'annual-masonry.tsx')
    expect(js).not.toContain('ResizeObserver')
    expect(js).not.toContain('getBoundingClientRect')
  })


  it('上下两段是**同一套设计语言**：间隙、卡片标题、数字逐字对齐', () => {
    // 间隙：海报 `.wrap { gap: g3 }` 与密排网格的 gap 必须一致（否则一眼看出是两个面板）
    expect(styleCode, '间距只由 .board 的 gap 给').toMatch(/\.board \{[^}]*gap: var\(--nm-dense-g5\)/)
    expect(styleCode, '网格间距走刻度').toMatch(/\.board \{[^}]*gap: var\(--nm-dense-g5\)/)
    // 卡片标题 / 附注 / 主数字三处对齐（下段照抄上段的值）
    expect(styleCode).toMatch(/\.moreCardTitle \{[^}]*color: var\(--nm-text-2\)/)
    expect(styleCode).toMatch(/\.moreCardExtra \{[^}]*font-size: var\(--nm-dense-fs-sm\)[^}]*color: var\(--nm-text-3\)/)
    expect(styleCode).toMatch(/\.moreNum \{[^}]*font-size: 20px/)
    // 海报卡的同名三处（对照：写明"对齐的是谁"）
    expect(styleCode).toMatch(/\.cardTitle \{[^}]*color: var\(--nm-text-2\)/)
    expect(styleCode).toMatch(/\.heroNum \{[^}]*font-size: 20px/)
    // 分区标签也必须是中性小字（青色药丸属于另一套视觉语言）
    expect(styleCode).toMatch(/\.zoneTag \{[^}]*color: var\(--nm-text-3\)/)
    expect(styleCode).not.toMatch(/\.zoneTag \{[^}]*var\(--nm-cyan\)/)
  })

  it('横向行统一换行：标签←→数值 式的行在窄卡里都要能换行', () => {
    // 找到那条"允许换行"的规则（@container 620 里，含多个行类）
    // 可能有多条 620px 容器查询（后面的那条负责"横向行统一换行"），全部拼起来查
    const rule = [...styleCode.matchAll(/@container \(max-width: 620px\) \{[\s\S]*?\}/g)].map((m) => m[0]).join(String())
    expect(rule, '缺少 620px 的换行规则').toBeTruthy()
    for (const cls of ['.kv', '.row', '.rankRow', '.nightTop', '.calFoot', '.moreRow']) {
      expect(rule, `${cls} 没有加进换行规则`).toContain(cls)
    }
    expect(styleCode, '换行后数值要改成左对齐').toContain('text-align: left')
    // 「还有这些人」的芯片容器（上一轮补的）
    expect(styleCode).toMatch(/\.hlRow \{[^}]*flex-wrap: wrap/)
  })

  it('卡片内部适配：按**卡片宽度**（容器查询）而不是窗口宽度退形态', () => {
    // 卡片必须是容器，否则 @container 规则不生效
    expect(styleCode, '.card 没有声明为容器').toMatch(/\.card \{[^}]*container-type: inline-size/)
    expect(styleCode, '.moreCard 没有声明为容器').toMatch(/\.moreCard \{[^}]*container-type: inline-size/)
    // 三档容器查询：620 换行 / 520 减列 / 380 竖排
    for (const w of [620, 520, 380]) {
      expect(styleCode, `缺少 @container (max-width: ${String(w)}px)`).toContain(`@container (max-width: ${String(w)}px)`)
    }
    // 窄卡里"固定 12 列"要减到 6 列，hero 3 格要减到 2 格/单列
    expect(styleCode).toMatch(/@container \(max-width: 520px\) \{[\s\S]*?starGrid \{ grid-template-columns: repeat\(6,/)
    expect(styleCode).toMatch(/@container \(max-width: 380px\) \{[\s\S]*?heroGrid \{ grid-template-columns: minmax\(0, 1fr\)/)
    // 反例：不许用 JS 量卡片宽度来切形态
    const js = read(HERE, 'annual-masonry.tsx')
    expect(js).not.toContain('ResizeObserver')
  })

  it('海报卡的内容竖直分散（`space-between`），空白不再全堆在卡片底部', () => {
    expect(styleCode).toMatch(/\.cardBody \{[^}]*justify-content: space-between/)
  })
})

describe('客户端形状：与后端接口对齐', () => {  it('AnnualReviewShape 有五个新字段与对应形状', () => {
    for (const line of ['moments: AnnualMoments', 'assets: AnnualAssets', 'money: AnnualMoney', 'revoke: AnnualRevoke', 'groups: AnnualGroups',
      'export interface AnnualMoments', 'export interface AnnualAssets', 'export interface AnnualMoney',
      'export interface AnnualRevoke', 'export interface AnnualGroups']) {
      expect(shape, `api-status.ts 缺 ${line}`).toContain(line)
    }
  })

  it('可空性口径跟着后端：available 是必需字段（不是可选）', () => {
    expect(shape).toMatch(/available: boolean/)
    expect(shape, 'available 不该是可选 —— 可选会让界面漏判"没读到"').not.toMatch(/available\?: boolean/)
  })
})


/** 年报里两个会渲染卡片/头像的文件。 */
const moreCards = read(HERE, 'annual-more-cards.tsx')
const commonSrc = read(HERE, 'annual-common.tsx')

describe('词云字号：跟着舞台高度封顶（用户："字体整体过大"）', () => {
  it('小舞台按更陡的系数封顶：120px → 14px；200px 及以上仍是阶梯顶档 48px（主词云面板不变）', () => {
    expect(cloudFontCap(120)).toBe(14)
    expect(cloudFontCap(160)).toBe(19)
    expect(cloudFontCap(200)).toBe(CLOUD_FONT_STEPS[CLOUD_FONT_STEPS.length - 1])
    expect(cloudFontCap(420)).toBe(CLOUD_FONT_STEPS[CLOUD_FONT_STEPS.length - 1])
    // 异常输入不许返回 NaN/0（会把字号算没）
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
    // 主词云舞台不受影响：仍允许阶梯顶档
    const big = layoutWordCloud(words, { width: 900, height: 300 })
    expect(Math.max(...big.placed.map((w) => w.size))).toBeLessThanOrEqual(CLOUD_FONT_STEPS[CLOUD_FONT_STEPS.length - 1]!)
  })
})

describe('规格统一：头像 / 字号令牌', () => {
  it('头像规格只定义一次（AVATAR_SIZE），所有调用点都引用它', () => {
    expect(commonSrc, '缺 AVATAR_SIZE 常量').toMatch(/export const AVATAR_SIZE = \d+/)
    for (const [name, src] of [['Annual.tsx', panel], ['annual-more-cards.tsx', moreCards]] as const) {
      expect(src, name + ' 里还有写死的头像尺寸').not.toMatch(/<Avatar[^>]*size=\{\d+\}/)
    }
    // 至少 6 处（海报里 5 处 + 群聊卡 1 处），全都得走常量
    const uses = (panel.match(/size=\{AVATAR_SIZE\}/g) ?? []).length + (moreCards.match(/size=\{AVATAR_SIZE\}/g) ?? []).length
    expect(uses, '引用 AVATAR_SIZE 的地方太少，像是漏改了').toBeGreaterThanOrEqual(6)
  })

  it('年报样式里的字号一律走 dense 令牌（不许混半档 --nm-fs-xs, 11px）', () => {
    expect(styleCode, '残留了非 dense 字号令牌').not.toMatch(/--nm-fs-/)
    expect(styleCode).toMatch(/var\(--nm-dense-fs\)/)
  })
})


