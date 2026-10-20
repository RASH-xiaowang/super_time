/**
 * 「同备注编号边」的**接线**守卫（源码级）。
 *
 * 为什么这类断言必须看源码：本仓库没有 DOM/React 测试环境（vitest 只跑纯逻辑模块），
 * 图例、开关、详情区块都渲染不起来。而这四处的退化**界面照样能用**，只是少一层信息：
 *   ① 图例少了金色虚线 —— 用户看到一批金线却不知道是什么，只会当成画错；
 *   ② 设置里漏了 `remarkClass` 开关 —— 这一层推断关系再也关不掉；
 *   ③ `useMemo` 依赖漏掉 `settings.remarkClass` —— 开关点了没反应（滑杆/开关静默失效，
 *      本项目在「外观参数 vs 结构参数」上已经踩过一次，见 graph-canvas.wiring.spec.ts 的说明）；
 *   ④ 主题里少定义一套 `edgeClass` —— 浅色/深色其中一边的线会退化成 `undefined`（画不出线），
 *      构建与既有用例都不报错。
 *
 * 另附一条**通用**守卫：Graph.tsx 里引用的每个 `css.X` 都要在 graph.module.css 里存在
 * （`className={undefined}` 会静默退化成无样式）。单独一个 `it`，出问题能一眼看出是哪一类。
 * @vitest-environment node
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { atLeast, atRuleBlock } from '../../../test-helpers/wiring-kit.ts'

const HERE = dirname(fileURLToPath(import.meta.url))

function findRoot(start: string): string {
  let d = start
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(d, 'main.js')) && existsSync(join(d, 'package.json'))) return d
    d = dirname(d)
  }
  throw new Error('找不到仓库根')
}
const ROOT = findRoot(HERE)

const panel = readFileSync(join(HERE, 'Graph.tsx'), 'utf8')
const css = readFileSync(join(HERE, 'graph.module.css'), 'utf8')
const model = readFileSync(join(HERE, 'graph-model.ts'), 'utf8')
const canvas = readdirSync(HERE).filter((f) => /^graph-canvas(-[a-z]+)?\.ts$/.test(f)).sort().map((f) => readFileSync(join(HERE, f), 'utf8')).join('\n')
const backendGraph = readFileSync(join(ROOT, 'src', 'backend', 'wechat-data', 'src', 'query', 'graph.ts'), 'utf8')

/**
 * 「图谱面板」的**全部源码**：`Graph.tsx` + 2026-10-16 抽出的两个子件。
 *
 * 这些守卫问的是「这个功能还在不在」，不是「它在哪个文件里」—— 拆文件（`GraphPanel` 撞
 * 250 行函数棘轮）不该让它们变红。所以按**语义**合并：`GraphRail.tsx`（参数面板）与
 * `GraphSelectionDetail.tsx`（选中详情卡）都是图谱面板的一部分。
 */
const panelAll = [
  panel,
  readFileSync(join(HERE, 'GraphRail.tsx'), 'utf8'),
  readFileSync(join(HERE, 'GraphSelectionDetail.tsx'), 'utf8'),
].join('\n')

describe('同备注编号边：图例 / 开关 / 名册三处都在', () => {
  it('图例里给这类线一个名字（金虚线 = 同备注编号）', () => {
    expect(panelAll).toContain('css.legendLineGold')
    expect(panelAll).toContain('金虚线 = 同备注编号')
    expect(css, '.legendLineGold 没定义').toMatch(/\.legendLineGold\s*\{/)
    // 图例本身也画成虚线，否则「设成实线的图例 + 虚线画布」对不上
    expect(css).toMatch(/\.legendLineGold\s*\{[^}]*repeating-linear-gradient/)
  })

  it('设置里有独立的开关，并且它是「结构参数」要进 useMemo 依赖', () => {
    expect(panelAll).toContain('同备注编号连边')
    expect(panelAll).toMatch(/patch\(\{\s*remarkClass:\s*v\s*\}\)/)
    expect(model).toMatch(/remarkClass:\s*true/)
    // 依赖漏了 → 开关点了不重建图（静默失效）
    const deps = panel.match(/const graph = useMemo<BuiltGraph>\([\s\S]*?\n {4}\[[^\]]*\]/)
    expect(deps, '找不到 graph 的 useMemo').not.toBeNull()
    expect(deps?.[0]).toContain('settings.remarkClass')
  })

  it('详情面板列出同班名册，并标出「被挡在图外」的人', () => {
    expect(panelAll).toContain('remark_groups')
    expect(panelAll).toContain('同班级 · ')
    // 「全库 N 人 · 本视图 M 人」——这句正是「同前缀却没有连线」的答案
    expect(panelAll).toMatch(/全库 \$\{selectedClass\.total\} 人 · 本视图 \$\{selectedClass\.visibleCount\} 人/)
    // 挡在图外的人渲染成不可点（点了跳不到节点，会让人以为是坏了）
    expect(panelAll).toMatch(/disabled=\{!m\.visible\}/)
    expect(css, '.detailChip[data-dim] 没定义').toMatch(/\.detailChip\[data-dim\]/)
  })
})

describe('同备注编号边：画布与数据源接线', () => {
  it('主题两套（深/浅）都定义了 edgeClass，且 class 边画虚线', () => {
    // 接口字段 1 处 + 深色 1 处 + 浅色 1 处
    expect((canvas.match(/edgeClass:/g) ?? []).length).toBeGreaterThanOrEqual(3)
    expect(canvas).toMatch(/theme\.edgeClass/)
    // 虚线 = 「从备注结构推断」的自解释标记（不是微信数据里观测到的共处）。
    // 断言分两步：①「推断层」这个集合包含 class；② dashed 用的是这个集合。
    // 不直接钉 `|| isClass` 字面量 —— 首字层(initial)加入后它变成了 `isClass || isInitial`，
    // 钉字面量会把一次等价重构判成失败（本轮实际发生）。
    expect(canvas).toMatch(/const isInferred = isClass \|\| isInitial/)
    expect(canvas).toMatch(/dashed:\s*\(isWiki && stubIds\.has\(edge\.target\)\) \|\| isInferred/)
  })

  it('后端把 remark 读出来、把 remark_group 写进节点、名册独立返回', () => {
    expect(backendGraph).toContain('remarkClassKey')
    expect(backendGraph).toMatch(/remark:\s*cellString\(r\.rm\)\.trim\(\)/)
    expect(backendGraph).toContain('node.remark_group = classKey')
    expect(backendGraph).toContain('remark_groups: remarkGroups')
    // 名册要在**好友过滤之前**收集：注释掉这行的改动会让「全库 43 人」变成「视图里的 12 人」
    expect(backendGraph).toMatch(/classRoster/)
  })

  it('共同成员上限已经从 8 放开（否则群节点依然看不到共同成员）', () => {
    expect(backendGraph).toMatch(/shared_members:\s*shared\.slice\(0,\s*GROUP_MEMBER_CAP\)/)
    expect(backendGraph).not.toMatch(/shared_members:\s*shared\.slice\(0,\s*8\)/)
    expect(backendGraph).toMatch(/const GROUP_MEMBER_CAP = \d+/)
  })
})

describe('Graph.tsx 引用的 CSS 类都能在 graph.module.css 找到', () => {
  it('没有「拼错类名 → 静默无样式」的形状', () => {
    const used = new Set<string>()
    for (const m of panelAll.matchAll(/css\.([A-Za-z_][A-Za-z0-9_]*)/g)) used.add(m[1] as string)
    const missing = [...used].filter(c => !new RegExp('\\.' + c + '(?![A-Za-z0-9_-])').test(css))
    expect(missing, `graph.module.css 里缺少：${missing.join(', ')}`).toEqual([])
  })
})

/**
 * 手机档：统计条压成一行 + 右侧控制栏的重复统计隐藏（2026-10-16 实测）。
 *
 * ## 为什么必须有
 *
 * `.statBar` 在 `≤1100px` 档是 **2 列**，而手机档此前**没有**覆盖它 ⇒
 * 5 个计数排成「2 列 × 3 行、每格 247×83px」，整条占 **249px 高**（实测），
 * 而它们只是「节点 / 连线 / 圈子 / 联系人 / 群聊」五个数字 —— 信息密度极低，
 * 把图谱画布挤到屏幕外。用户报「这块里面的组件太大了」。
 *
 * 另外右侧控制栏的 `.statRow`（节点/连线/圈子）与顶部 `.statBar` **完全重复**
 * （同一份 `graph.nodes.length` / `edges.length` / `communityCount`），手机上白占 30px。
 */
describe('手机档：统计条压成一行、重复统计隐藏', () => {
  const phone = atRuleBlock(css, '@media (max-width: 560px)')

  it('统计条在手机上是自适应多列（不是 1100px 档的 2 列）', () => {
    atLeast(phone.length, 50, 'graph.module.css 的手机档')
    // 2026-10-17：从「写死 5 列」改成 `auto-fit` —— 知识图谱模式有 **8 格**
    // （多出 笔记/待补笔记/文件/章节/模型实体），写死 5 列会折成 5+3 两行、
    // 第二行右边空一大片（用户截图实测）。`auto-fit` 让每行都填满。
    expect(phone, '手机档没有把 .statBar 改成自适应列 ⇒ 仍是 2 列 × 3 行、占 249px 高')
      .toMatch(/\.statBar \{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(\d+px, 1fr\)\)/)
  })

  it('统计格去掉边框与卡片底、字号收一档（一行小格不需要每格一个框）', () => {
    expect(phone, '统计格仍带边框 ⇒ 一行 5 个框看起来像 5 张卡片').toMatch(/\.statBox \{[^}]*border: none/)
    expect(phone, '统计格仍有卡片底色').toMatch(/\.statBox \{[^}]*background: transparent/)
    expect(phone, '数字字号没收 ⇒ 15px 以上在 97px 宽的格子里会挤').toMatch(/\.statNum \{ font-size: 15px; \}/)
  })

  it('右侧控制栏的重复统计在手机上隐藏（与顶部同一份数据）', () => {
    expect(phone, '右侧 .statRow 没隐藏 ⇒ 与顶部统计条重复显示同一份数据')
      .toMatch(/\.statRow \{ display: none; \}/)
  })
})

/* ── 模型实体层（2026-09-20，P4）的接线 ────────────────────────────────
 * 与上面几组同一个理由：没有 DOM 环境，这四处漏一处**页面照样跑得动**，
 * 只是图上多了一批没人能解释的琥珀色点，或者反过来说 —— 模型推断的关系
 * 与文档里写着的引用关系在屏幕上长得一样，用户把它当原文引用了。
 */
describe('模型实体层：图例 / 统计 / 详情 / 头像挡位', () => {
  /** 去注释后的源码：守卫只能被代码满足，注释里提一句不算。 */
  const code = (src: string): string => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n')
  const panelCode = code(panelAll)
  const modelCode = code(model)

  it('知识侧五类节点收进一份名单，两处判定共用（加一类不会只改一处）', () => {
    const m = /const KNOWLEDGE_KINDS = new Set<GNode\['kind']>\(\[([^\]]*)\]\)/.exec(panelCode)
    expect(m, 'KNOWLEDGE_KINDS 的定义形状变了').not.toBeNull()
    const kinds = (m?.[1] ?? '').split(',').map(s => s.trim().replace(/^'|'$/g, ''))
    expect([...kinds].sort()).toEqual(['entity', 'file', 'note', 'section', 'stub'])
    // 头像挡位与「查看聊天」按钮都走它
    expect(panelCode).toContain('KNOWLEDGE_KINDS.has(selected.kind)')
    expect(panelCode).toContain('!KNOWLEDGE_KINDS.has(selected.kind)')
    // 不许再残留手写的 kind 串：那正是「加一类漏一处」的来源
    const inline = (panelCode.match(/selected\.kind !== '/g) ?? []).length
    expect(inline, `还有 ${inline} 处手写的 selected.kind !== 判定没收进名单`).toBe(0)
  })

  it('图例把「琥珀 = 模型抽出的实体」「虚线 = 推断的关系」写出来', () => {
    expect(panelCode).toContain('css.legendDotEntity')
    expect(panelCode).toContain('css.legendLineAmberDash')
    expect(panelCode).toContain('模型抽出的实体')
    // 文案必须点明「文档里没写着」：只说「虚线 = 推断」，用户不知道推断的是什么
    expect(panelCode).toMatch(/虚线[\s\S]{0,40}文档里没写着/)
    // 文件与章节两类也在图例里 —— 三者同是小圆点，缺一个就会互相误读
    for (const c of ['css.legendDotFile', 'css.legendDotSection']) expect(panelCode).toContain(c)
    // 琥珀色真的来自一个已定义的颜色（`var(--nm-*)` 写错会整条声明失效，且不报错）
    expect(css).toMatch(/\.legendDotEntity\s*\{[^}]*background:\s*var\(--nm-amber\)/)
  })

  it('统计条有「模型实体」这一格，读的是 summary.entityCount', () => {
    expect(panelCode).toContain('模型实体')
    // P3-14 之后这一格的回退不再是"每渲染一遍扫一次节点数组"，而是图上那份计数
    expect(panelCode).toMatch(/summary\.entityCount \?\? \(graph\.kindCounts\.entity \?\? 0\)/)
  })

  it('详情行给 entity 单独一支，且取的是自报身份的那句 excerpt', () => {
    expect(panelCode).toMatch(/selected\.kind === 'entity'[\s\S]{0,120}selected\.excerpt/)
  })

  it('实体节点的两个文案分支都以「模型推断」开头（跨文件那一支最容易漏）', () => {
    const branch = /excerpt: \((en\.files\.length > 1[\s\S]*?)\n\s*x: 0/.exec(modelCode)
    expect(branch, 'entityNodes 的 excerpt 分支形状变了').not.toBeNull()
    const body = branch?.[1] ?? ''
    expect((body.match(/模型推断/g) ?? []).length).toBe(2)
  })

  it('docEntities 有运行期兜底（旧渲染缓存里根本没这个字段）', () => {
    expect(modelCode).toContain('knowledge.docEntities ?? []')
  })

  it('观测/推断两池的分类只认 mention+suggest 这一组（suggest 漏进观测层就是白吃额度）', () => {
    // 刻意写成源码形状断言而不是行为断言：两者只在「预算正好卡死」的窄区间里表现不同，
    // 而那个区间的差异是「哪条推断边活下来」，没有产品含义。分类本身才是纪律。
    expect(modelCode).toMatch(/const observed = edges\.filter\(e => e\.kind !== 'mention' && e\.kind !== 'suggest'\)/)
    expect(modelCode).toMatch(/const inferred = edges\.filter\(e => e\.kind === 'mention' \|\| e\.kind === 'suggest'\)/)
  })
})

/**
 * 参数面板改成**悬浮弹层**（2026-10-16）。
 *
 * ## 为什么必须有
 *
 * 原先 `.rail` 是 `flex-shrink: 0` 的**固定 252px 右栏**：窗口一窄就把画布压成一条缝，
 * 而节点半径是绝对值 ⇒ 全挤成一团。改成 `position: absolute` 后它**不占布局宽度**，
 * 画布永远独占整宽。代价是「面板会盖住画布」，所以必须有一个**始终可见**的折叠按钮 ——
 * 收起时它是唯一入口，漏渲染就等于功能消失（本轮真机实测踩到过：面板能收起、但收不回来）。
 */
describe('参数面板：悬浮弹层 + 折叠按钮', () => {
  const rail = readFileSync(join(HERE, 'GraphRail.tsx'), 'utf8')

  it('.rail 是绝对定位的浮层（不占布局宽度 ⇒ 画布不被压窄）', () => {
    expect(css, '.rail 不是绝对定位 ⇒ 又变回占宽度的固定右栏').toMatch(/\.rail \{[^}]*position: absolute/)
    expect(css, '浮层缺 z-index ⇒ 会被画布内的图例/小地图盖住').toMatch(/\.rail \{[^}]*z-index: 20/)
    // 宽度必须带 `min(...)` 兜底：窄屏上 300px 固定宽会溢出容器
    expect(css, '浮层宽度没有窄屏兜底').toMatch(/\.rail \{[^}]*width: min\(300px, calc\(100% - 20px\)\)/)
  })

  it('折叠按钮始终渲染，且展开时由 CSS 让位（不是条件渲染）', () => {
    // 条件渲染 `{!railOpen && <button>}` 也能跑，但「展开时按钮消失」会让位置跳动；
    // 这里钉的是「按钮在 DOM 里恒在、靠 data-open 隐藏」这个形状。
    expect(panel, '折叠按钮没渲染 ⇒ 面板收起后收不回来').toContain('css.railToggle')
    expect(panel, '折叠按钮缺 aria-label ⇒ 读屏与自动化都找不到它').toMatch(/aria-label=\{railOpen \? '收起参数面板' : '展开参数面板'\}/)
    expect(css, '展开时按钮没让位 ⇒ 与浮层标题栏的「收起」叠在一起').toMatch(/\.railToggle\[data-open\] \{ display: none; \}/)
  })

  it('手机端默认收起（浮层会盖住画布，小屏上必须让用户主动打开）', () => {
    expect(panel, '手机端没有默认收起 ⇒ 一进图谱就被浮层盖住').toMatch(/useState\(\(\) => !isPhone\)/)
    expect(panel, '没有用手机断点判定').toContain('useMediaQuery(PHONE_QUERY)')
  })

  it('浮层有标题栏与收起按钮（否则只能靠点画布外关闭，手机上很难点准）', () => {
    expect(rail).toContain('css.railHd')
    expect(rail).toContain('css.railClose')
    expect(rail).toMatch(/aria-label="收起参数面板"/)
  })

  it('折叠按钮与浮层都在 .stage 内（否则 absolute 会一路找到视口、飘到屏幕顶部）', () => {
    // 2026-10-16 实测踩到：`.railToggle` 原先放在 `.stage` **外面**（`.body` 的直接子元素），
    // 而 `.body` / `.panel` 都没有 `position: relative` ⇒ `position: absolute` 一路往上找到
    // 视口 ⇒ 按钮落在 `top:10px`（屏幕顶部），正好压住手机档的全局搜索条（用户报「这一块放在
    // 这里合理吗？」）。`.stage` 是最近的定位祖先，两者都必须挂在它下面。
    const stageAt = panel.indexOf('<div className={css.stage}>')
    expect(stageAt, '找不到 .stage 的开标签').toBeGreaterThan(-1)
    const toggleAt = panel.indexOf('css.railToggle')
    const railAt = panel.indexOf('<GraphRail')
    expect(toggleAt, '找不到折叠按钮').toBeGreaterThan(-1)
    expect(railAt, '找不到 <GraphRail>').toBeGreaterThan(-1)
    expect(toggleAt, '折叠按钮必须在 .stage 之后（即挂在它里面）').toBeGreaterThan(stageAt)
    expect(railAt, '浮层必须在 .stage 之后（即挂在它里面）').toBeGreaterThan(stageAt)
    // 反向：`.stage` 的闭合 `</div>` 必须在两者之后 —— 否则它们其实还在外面
    const stageClose = panel.indexOf('</div>\n      </div>', railAt)
    expect(stageClose, '.stage 的闭合标签找不到（结构变了）').toBeGreaterThan(railAt)
  })

  it('跨断点时同步展开态（桌面缩到手机宽不该继续展开、盖住画布）', () => {
    // `useState` 的惰性初值只在首次挂载求值 ⇒ 桌面打开图谱后缩窗口，浮层会继续展开。
    expect(panel, '没有跨断点同步 ⇒ 桌面缩到手机宽后浮层仍展开').toMatch(/prevPhoneRef\.current === isPhone/)
    expect(panel, '跨断点同步没把 railOpen 设成 !isPhone').toMatch(/setRailOpen\(!isPhone\)/)
  })
})
