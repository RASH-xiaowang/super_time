/**
 * 总览布局守卫（源码级）—— 2026-10-19 微信化改版。
 *
 * 演进：
 *  · Wave D3（2026-10-18）从「太空舱霓虹皮」改成标准面板容器 + kit `StatCard`/`Card`
 *    + 全局 Bootstrap 栅格（`row g-2` / `col-*`），手机档用 `order-*` 排序。
 *  · 2026-10-19 微信化：KPI 8→4（会话/消息/好友/群聊）、卡片 14→6
 *    （趋势/热度/关系/内容/存储/资金），其余分析收进「更多分析」折叠区；
 *    页头动作 3→2；手机档不再用 `order-*` 重排（DOM 顺序即阅读顺序）。
 *
 * 这条 spec 继续钉住四类"看代码看不出来"的坑（判据强度不放宽，只换期望）：
 *  ① **类名没接到 JSX 上**：CSS 里写了规则、JSX 从不渲染 ⇒ 规则是死的（本仓老坑）。
 *  ② **自造 12 栅格回潮**：`.ovGrid/.ovSpan*` 已删，别再和 Bootstrap 并存。
 *  ③ **首屏信息过载回潮**：KPI 必须正好 4 项、核心卡必须正好 6 张、其余进折叠区。
 *  ④ **KPI 就绪钩子/折叠语义/内容口径**：`data-st-ov-hero`、`hidden`/`aria-expanded`/
 *    localStorage 按标题、三处长条分母取真最大值（后者另有专 spec）。
 *
 * 布局的**真实**效果（空白占比、横向溢出）由 `ui:density-audit` / `ui:responsive-audit`
 * 在真机上量，这里只锁源码形状。
 * @vitest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
const tsxRaw = readdirSync(HERE)
  .filter((f) => /^overview(-[a-z]+)?\.(ts|tsx)$/.test(f))
  .sort()
  .map((f) => readFileSync(join(HERE, f), 'utf8'))
  .join('\n')
const cssRaw = readdirSync(HERE)
  .filter((f) => /^overview(-[a-z]+)?\.module\.css$/.test(f))
  .sort()
  .map((f) => readFileSync(join(HERE, f), 'utf8'))
  .join('\n')
/**
 * **实际参与渲染**的总览样式（overview.module + 手机档 + 地区榜）。
 *
 * `overview-neon.module.css` 已无任何 import，但被
 * `light-theme-coverage.wiring.spec.ts` / `m6-phone.wiring.spec.ts` 直接读文件当夹具；
 * 它保留的是旧霓虹皮（渐变/发光/玻璃），不该被算进"这页还在用装饰"的判据里。
 */
const liveCssRaw = ['overview.module.css', 'overview-phone.module.css', 'overview-region.module.css']
  .map((f) => readFileSync(join(HERE, f), 'utf8'))
  .join('\n')
const panel = readFileSync(join(HERE, 'overview-panel.tsx'), 'utf8')
const sections = readFileSync(join(HERE, 'overview-sections.tsx'), 'utf8')
const board = readFileSync(join(HERE, 'RegionBoard.tsx'), 'utf8')

/** 去掉注释：注释里提到旧做法不该影响断言（本文件自己也提到 `ovSpan`）。 */
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const tsx = strip(tsxRaw)
const css = strip(cssRaw)
const liveCss = strip(liveCssRaw)
const panelCode = strip(panel)
const sectionsCode = strip(sections)
/** 默认可见的 6 张核心卡（从 KpiSection 到 MoreAnalysis 之前）。 */
const coreCode = sectionsCode.slice(sectionsCode.indexOf('export function TrendSection'), sectionsCode.indexOf('export function MoreAnalysis'))
/** 「更多分析」折叠区（MoreAnalysis 之后的其余卡片组件）。 */
const moreCode = sectionsCode.slice(sectionsCode.indexOf('export function WordCloudSection'))

const count = (hay: string, needle: string): number => hay.split(needle).length - 1

describe('总览 KPI 条：4 项 kit StatCard + Bootstrap 栅格', () => {
  it('4 个指标卡用 row g-2 + col-6 col-sm-3 铺（手机 2 列 / ≥sm 4 列一行）', () => {
    expect(sectionsCode, '找不到 KPI 栅格行（row g-2）').toContain('row g-2')
    expect(count(sectionsCode, 'className="col-6 col-sm-3"'), 'KPI 卡的列类不是 col-6 col-sm-3')
      .toBe(count(sectionsCode, '{CARDS.map'))
    expect(sectionsCode, 'KPI 没用 kit StatCard').toContain('<StatCard')
    expect(tsx, 'KPI 仍在用霓虹牌 NeonHero').not.toContain('NeonHero')
    expect(sectionsCode, '4 张指标卡应由 CARDS 驱动').toContain('CARDS.map')
    // 4 项口径：会话 / 消息 / 好友 / 群聊（消息取自 insights，其余取自 snapshot）
    for (const label of ["label: '会话'", "label: '消息'", "label: '好友'", "label: '群聊'"]) {
      expect(tsx, `KPI 少了 ${label}`).toContain(label)
    }
    // 旧 8 项里被并进卡片的那几个不再出现在 KPI 清单里
    for (const gone of ["label: '公众号/服务号'", "label: '朋友圈'", "label: '收藏'", "label: '自定义表情'", "label: '媒体占用'"]) {
      expect(tsx, `KPI 仍在堆旧指标 ${gone}`).not.toContain(gone)
    }
  })

  it('留白审计就绪钩子挂在指标条容器上，且与 row g-2 同一行', () => {
    const line = sectionsCode.split('\n').find((l) => l.includes('data-st-ov-hero'))
    expect(line, 'data-st-ov-hero 不见了').toBeTruthy()
    expect(line).toContain('row g-2')
  })

  it('消息构成不再是页头下的独立横条，而是并进「内容构成与资产」卡（同页只统计一次）', () => {
    // 旧 `.ovMixBar` 整块删除（页头 KPI 下再铺一条 8 项统计属于重复内容）
    expect(tsx, '旧的 ovMixBar 消息构成条又回来了').not.toContain('ovMixBar')
    expect(css, 'CSS 里还留着 ovMixBar 规则').not.toMatch(/\.ovMixBar\b/)
    // 收发/类型统计只有一处：内容卡里的 mixLine + MSG_BUCKETS 条形
    expect(sectionsCode).toContain('css.mixLine')
    expect(sectionsCode, '内容卡不再展示收发').toContain('ins.messages.sent.toLocaleString()')
    expect(sectionsCode, '内容卡不再展示消息总量').toContain('ins.messages.total.toLocaleString()')
    expect(sectionsCode).toContain('MSG_BUCKETS.map')
  })
})

describe('总览卡片区：默认 6 张核心卡 + 「更多分析」折叠区', () => {
  it('默认只渲染 6 张核心卡（趋势/热度/关系/内容/存储/资金）', () => {
    for (const comp of [
      '<TrendSection extras={extras} />',
      '<HeatmapSection heatmap={extras.heatmap} />',
      '<RelationSection ins={ins} onOpenChat={openChat} />',
      '<ContentAssetsSection ins={ins} official={data.official} />',
      '<StorageCompositionSection categories={data.storage.categories} stor={stor} largeFileCount={largeFiles.length} onGo={go} />',
      '<LedgerSection ledger={ledger} onGo={go} />',
    ]) {
      expect(panelCode, `核心卡少了 ${comp}`).toContain(comp)
    }
    // 核心区只有 3 个栅格行（趋势+热力 / 关系+内容 / 存储+资金）；KPI 行在 KpiSection 里
    expect(count(panelCode, 'className="row g-2"'), '核心卡栅格行数不对').toBe(3)
  })

  it('其余分析收进 MoreAnalysis 折叠区（不再铺成 14 张卡片墙）', () => {
    expect(panelCode, '缺少「更多分析」折叠区').toContain('<MoreAnalysis count={6}>')
    for (const comp of [
      '<InteractionSection ins={ins} />',
      '<WordCloudSection />',
      '<RegionBoard />',
      '<MomentsAuthorsSection authors={data.moments_authors} onOpenMoments={openMoments} onGo={go} />',
      '<RevokedSection revoked={data.revoked} warnCount={warnCount} onGo={go} />',
      '<HealthSection ins={ins} extras={extras} />',
    ]) {
      expect(panelCode, `「更多分析」里少了 ${comp}`).toContain(comp)
    }
    // 折叠语义：默认收起（无 open 初值），按钮 aria-expanded 跟随状态
    expect(sectionsCode).toContain('useState(false)')
    expect(sectionsCode).toContain('aria-expanded={open}')
  })

  it('行的列宽分工：KPI 4 列 + 卡片 4/8 与 6/6（成对）', () => {
    for (const cls of ['className="col-6 col-sm-3"', 'className="col-12 col-xl-4"', 'className="col-12 col-xl-8"', 'className="col-12 col-xl-6"']) {
      expect(tsx, `缺少列类 ${cls}`).toContain(cls)
    }
    // 默认可见的核心卡里 col-xl-6：关系/内容/存储/资金 = 4 张（成对，不会独占一行留空 6 栅格）
    const six = count(coreCode, 'className="col-12 col-xl-6"')
    expect(six, `核心区 col-xl-6 卡片 ${six} 张，必须成对`).toBe(4)
    expect(six % 2, 'col-xl-6 卡片为奇数 ⇒ 会有一行只放一张卡').toBe(0)
    // 趋势 4 / 热度 8 同处一行
    expect(coreCode).toContain('className="col-12 col-xl-4"')
    expect(coreCode).toContain('className="col-12 col-xl-8"')
    // 折叠区里的词云是整行
    expect(moreCode).toContain('className="col-12" icon="content" title="全局热词"')
  })

  it('手机档不再用 order-* 重排（DOM 顺序即阅读顺序）', () => {
    expect(panelCode, '还在用 order-* 重排？').not.toContain('order-1 order-xl-2')
    expect(panelCode, '还在用 order-* 重排？').not.toContain('order-2 order-xl-1')
    expect(tsx, '还在用 JS phone 分支重排？').not.toContain('useMediaQuery')
    expect(tsx, '还在用 PHONE_QUERY 重排？').not.toContain('PHONE_QUERY')
  })

  it('好友地区：世界地图并入「关系与地区」卡；省份/城市榜在更多分析里', () => {
    // 地图与关系指标同卡：关系卡里出现 WorldMapBody，且地图盒仍是 .worldMapBox 高度链
    const rel = sectionsCode.slice(sectionsCode.indexOf('export function RelationSection'), sectionsCode.indexOf('export function ContentAssetsSection'))
    expect(rel, '关系卡里没有世界地图').toContain('<WorldMapBody />')
    expect(rel).toContain('Math.max(1, ...ins.relations.top.map(x => x.count))')
    expect(sectionsCode).toContain('function WorldMapBody')
    expect(sectionsCode, '地图盒丢了').toContain('css.worldMapBox')
    expect(sectionsCode, '地图懒加载占位丢了').toContain('地图进入可视区后加载')
    expect(css).toContain('.worldMapBox')
    // 省份/城市榜仍由 RegionBoard 提供（数据源不新增），只是挪进折叠区
    expect(board).toContain('apiGetRegionMap')
    expect(board).toContain('<RankCard title="省份 Top 10">')
    expect(board).toContain('<RankCard title="城市 Top 12">')
    expect(board, '省份榜/城市榜还在用旧 regionSpan').not.toContain('regionSpan')
  })
})

describe('卡片外观统一：OvSection 基于 kit Card', () => {
  it('OvSection 用 kit Card（title=图标+标题，extra=折叠按钮），不再自造 section/header', () => {
    expect(tsx, 'OvSection 没用 kit Card').toContain('<Card')
    expect(tsx, 'OvSection 还在自己写 section').not.toContain('css.ovCard')
    expect(tsx, '折叠按钮缺 aria-expanded').toContain('aria-expanded={!collapsed}')
    expect(tsx, '折叠体缺 hidden 属性').toContain('hidden={collapsed}')
    expect(tsx, '折叠位置类 ovSectionBd 丢了').toContain('css.ovSectionBd')
    expect(css, 'hidden 的 display:none 兜底规则丢了').toMatch(/\.ovSectionBd\[hidden\]\s*\{\s*display:\s*none\s*;?\s*\}/)
    // 卡片头压到 36px（与全站「卡头 36」一致）
    expect(css, '卡片头没有压到 36px').toMatch(/\.ovSectionCard > \[class\*='_cardHd_'\]\s*\{[^}]*min-height:\s*36px/s)
  })

  it('卡片间距：栅格列与卡片本体分离，横纵间距都由 Bootstrap g-2 提供', () => {
    expect(tsx, 'OvSection 没把栅格列包在卡片外层').toMatch(/<div className=\{\[css\.ovCol, className\]/)
    expect(tsx, '卡片根又挂回了 col-*').toMatch(/<Card\s+className=\{css\.ovSectionCard\}/)
    expect(css, '缺少 .ovCol 承载 gutter').toMatch(/\.ovCol\s*\{[^}]*display:\s*flex/s)
    expect(css, '缺少 .ovSectionCard 铺满列内容盒').toMatch(/\.ovSectionCard\s*\{[^}]*width:\s*100%/s)
  })

  it('折叠语义：按标题存 localStorage，坏记录当全展开', () => {
    expect(tsx).toContain("OV_COLLAPSED_KEY = 'dsh-wechat-ov-collapsed-v1'")
    expect(tsx).toContain('readCollapsed().has(key)')
    expect(tsx).toContain('Array.isArray(raw) ? raw.filter')
  })

  it('旧的霓虹卡片类已彻底删除（避免「JSX 用了 / 样式没有」互查失败）', () => {
    for (const cls of ['ovCard', 'ovCardHd', 'ovCardBd', 'ovGrid', 'ovGroupTitle', 'ovSpan', 'ovTall', 'ovTrend', 'ovHeat', 'regionSpan', 'ovMixBar']) {
      // 词边界：`ovHeatBody` 是热力容器类，不该被 `ovHeat` 误伤
      expect(tsx, `TSX 仍在引用 ${cls}`).not.toMatch(new RegExp(`\\b${cls}\\b`))
      expect(css, `CSS 仍在定义 ${cls}`).not.toMatch(new RegExp(`\\.${cls}\\b`))
    }
  })

  it('JSX 上写了的布局/内容类，样式里必须有对应规则（防规则变死）', () => {
    const used = [...new Set([...tsx.matchAll(/css\.([A-Za-z0-9_]+)/g)].map((m) => m[1]))]
    expect(used.length).toBeGreaterThan(20)
    for (const cls of used) {
      expect(liveCss, `JSX 用了 css.${cls}，但 overview CSS 没有定义 .${cls}`).toContain(`.${cls}`)
    }
  })

  it('全仓实际参与渲染的 overview CSS 不得用 :global( 覆盖别的 CSS Module', () => {
    expect(liveCss, '不得再用 :global( 覆盖别的 CSS Module').not.toMatch(/:global\(/)
  })

  it('去装饰：不得再出现 backdrop-filter / 扫描条 / 呼吸动画 / 青紫渐变', () => {
    expect(liveCss, '还有毛玻璃 backdrop-filter').not.toMatch(/backdrop-filter/)
    expect(liveCss, '还有扫描条 scanbar').not.toMatch(/\.scanbar\b/)
    expect(liveCss, '还有呼吸/扫描动画').not.toMatch(/@keyframes\s+ov-(scan|update)\b/)
    expect(tsx, '还在渲染 scanbar').not.toContain('css.scanbar')
    // 装饰性渐变一律删除；进度/占比条也改纯色（颜色不承担信息，长度承担）
    expect(liveCss, '还有 linear-gradient 装饰').not.toMatch(/linear-gradient/)
    expect(liveCss, '还有发光 box-shadow').not.toMatch(/box-shadow:\s*0\s+0\s+\d/)
  })
})

describe('热力/地图/日历：既有能力一项不少', () => {
  it('日历热力按需加载（echarts 不进总览首屏），容器吃掉卡身剩余高度', () => {
    expect(tsx).toContain("export const CalendarHeatmapPanel = lazy(() => import('./CalendarHeatmap.tsx')")
    expect(tsx).toContain('<CalendarHeatmapGate data={heatmap} />')
    expect(tsx, '总览面板又把 CalendarHeatmap 改成静态 import 了').not.toMatch(/import\s+\{\s*CalendarHeatmap\s*\}\s+from\s+'\.\/CalendarHeatmap\.tsx'/)
    expect(css, '热力容器又写死高度 ⇒ 卡片底部会留空白').toMatch(/\.ovHeatBody \.calendarHeatmap\s*\{[^}]*flex:\s*1 1 auto/s)
    expect(css).toMatch(/\.ovHeatBody \.calendarHeatmap\s*\{[^}]*min-height:\s*\d+px/s)
    expect(css).toMatch(/\.ovHeatBody \.calendarHeatmap\s*\{[^}]*max-height:\s*none/s)
  })

  it('ECharts 日历双向自适应（cellSize auto），且给 visualMap 留够两行；色阶单色化', () => {
    const heat = readFileSync(join(HERE, 'CalendarHeatmap.tsx'), 'utf8')
    expect(heat, 'cellSize 写死高度 ⇒ 格子不随容器变大').toMatch(/cellSize:\s*'auto'/)
    expect(heat, 'cellSize 不该再是 [auto, 13] 这种写死高度的形状').not.toMatch(/cellSize:\s*\['auto',\s*\d+\]/)
    const top = /calendar:\s*\{[^}]*top:\s*(\d+)/s.exec(heat)
    expect(top, '找不到 calendar.top').not.toBeNull()
    expect(Number(top?.[1]), 'calendar.top 太小 ⇒ visualMap 第二行会压到日历上').toBeGreaterThanOrEqual(48)
    // 微信化：热力色阶只用主色单色阶，不再青→紫双色
    expect(heat, '热力色阶又混进紫色').not.toMatch(/visualMap[\s\S]{0,600}--nm-purple/)
    expect(heat, 'hover 又加发光阴影').not.toMatch(/emphasis:\s*\{\s*itemStyle:\s*\{\s*shadowBlur/)
  })

  it('跨模块覆盖必须能命中：走属性子串选择器覆盖地图高度链/头像栏，不用 :global', () => {
    for (const k of ['stage', 'mapFrame', 'china3d', 'avatarRail']) {
      expect(css, `缺少 [class*='${k}'] 覆盖`).toContain(`[class*='${k}']`)
    }
    expect(css).toMatch(/\.worldMapBox canvas/)
    expect(css, '地图没有 flex 自适应（会留大块空白）').toMatch(/\.worldMapFlex\s*\{[^}]*flex:\s*1 1 auto/s)
  })
})

describe('总览内容：标题与实际条目一致', () => {
  it('「存储构成 Top N」要把 N 条都渲染出来（此前标题写 Top 7、只渲染 4 条）', () => {
    expect(sectionsCode).toMatch(/存储构成 Top \$\{categories\.length\}/)
    expect(sectionsCode, '不应再对分类做 slice(0, 4)').not.toMatch(/storage\.categories\.slice\(/)
    expect(sectionsCode).toMatch(/sort\(\(a, b\) => b\.size - a\.size\)/)
  })

  it('资金快照标题在缺月份时不留一个孤零零的分隔点', () => {
    expect(sectionsCode).toContain("资金快照${ledger?.month ? ` · ${ledger.month}` : ''}")
  })

  it('页头动作 3→2：刷新 + 更多▾，导出/归档都进「更多」菜单', () => {
    // 页头只有 2 个动作（都用 .refresh 样式）；归档不再是页头按钮
    expect(count(panelCode, 'className={css.refresh}'), '页头动作不是 2 个').toBe(2)
    expect(panelCode, '页头缺刷新').toContain(": done ? '✓ 已更新' : '刷新'")
    expect(panelCode, '页头缺更多菜单').toContain('更多 ▾')
    expect(panelCode, '旧的页头归档按钮文案还在').not.toContain('导出全部会话 ZIP')
    for (const item of ['导出报告 · Markdown', '导出数据 · JSON', '导出图片 · PNG', '导出图片 · JPG', '归档全部会话 ZIP']) {
      expect(panelCode, `更多菜单少了「${item}」`).toContain(item)
    }
  })
})
