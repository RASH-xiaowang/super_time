/**
 * ClawBot 面板布局守卫 · B0（样式地基：单一滚动容器 + 容器查询地基）。
 *
 * 防的三种静默失效（都是 docs/CLAWBOT-REDESIGN.html 记的 P0/P1）：
 *   ① **高度靠猜**：`max-height: calc(100vh - 300px)` 与 kit 的 62vh 把「面板头 +
 *      工具卡 + 发送卡 = 300px」这个假设藏进样式，卡片一换行假设就崩、页脚统计漂移；
 *   ② **多重滚动**：外壳 .content ▸ .tableScroll ▸ .tableWrap 三层同时可滚，双滚动条；
 *   ③ **卡片被 flex 压缩后被自己的 overflow 静默吞掉**（kit .panelShell 的同款事故：
 *      默认 flex-shrink:1 先压子项，Card 自带 overflow:hidden，无滚动条、无报错）。
 *
 * B1 已落地（会话三区化）：筛选条合并统计与导出、发送器下沉为底部发送坞、表格列宽显式 +
 * @container 800/1200 分档显隐；B2 已落地（设置双列 + FAQ 通栏 + kvGrid 分档 +
 * 指挥条绑定态 pill 常驻）。按棘轮纪律逐批强化、不放宽。
 * 按棘轮纪律逐批强化、不放宽。zoom 弹窗的 72vh 是设计稿 G3 的刻意例外（内容最大化语义），
 * 不在禁止之列 —— 禁的只有 100vh 与 62vh 这两个「猜容器高度」的用法。
 *
 * 变异自证：`tools/clawbot-layout-mutation.py`（每条断言都必须能被咬红；
 * 基线 tsc + 本 spec 全绿后才跑变异，逐字节还原后复跑基线）。
 *
 * @vitest-environment node
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { classBlock, jsxCall, readStripped, readText, sliceBetween } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const UI = join(HERE, '..', 'ui')
const CSS = readText(join(HERE, 'clawbot.module.css'))
/** 去注释的 CSS：反向棘轮断言只量**规则**不量散文 —— 反转记录里必然要写出被禁的写法，
 *  若连注释一起量，记录本身就会把断言咬红（2026-10-13 C0 实测踩到）。 */
const CSS_RULES = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
const CHAT = readStripped(join(HERE, 'clawbot-chat.tsx'))
const KIT_TABLE_TSX = readStripped(join(UI, 'kit-table.tsx'))
const KIT_TABLE_CSS = readText(join(UI, 'kit-table.module.css'))
const KIT_FIELDS = readStripped(join(UI, 'kit-fields.tsx'))
const KIT_CSS = readText(join(UI, 'kit.module.css'))
const PANEL = readStripped(join(HERE, 'ClawBotPanel.tsx'))
const SETTINGS = readStripped(join(HERE, 'clawbot-settings.tsx'))
const STATUS = readStripped(join(HERE, 'clawbot-status.ts'))
const INSTANCES = readStripped(join(HERE, 'clawbot-instances.tsx'))
const THREAD = readStripped(join(HERE, 'clawbot-thread.tsx'))
const RAIL = readStripped(join(HERE, 'clawbot-rail.tsx'))

describe('ClawBot B0：高度策略（面板内只准一个滚动容器）', () => {
  it('root 填满内容区并自管滚动，高度不再靠视口单位猜', () => {
    const root = classBlock(CSS, 'root')
    expect(root, 'root 不填满 ⇒ 面板高度由内容决定，flex 分配无从谈起').toMatch(/height:\s*100%/)
    expect(root).toMatch(/min-height:\s*0/)
    expect(root, '面板自管滚动（kit .panelShell 同款契约）：不滚就只能靠外壳 .content，又是双容器')
      .toMatch(/overflow-y:\s*auto/)
  })

  it('消息列表是唯一滚动容器：flex 吃剩余高度 + 自身滚动', () => {
    const list = classBlock(CSS, 'msgList')
    expect(list, '列表不吃剩余高度 ⇒ 表格卡被内容撑开，发送坞被顶出视口').toMatch(/flex:\s*1 1 auto/)
    expect(list).toMatch(/min-height:\s*0/)
    expect(list).toMatch(/overflow:\s*auto/)
  })

  it('会话卡是唯一弹性区；不滚的块不参与压缩', () => {
    // 2026-10-17 重设计：`.tableCard` 改名 `.chatCard`（会话视图从三张卡合并成一张卡 + 三段）。
    expect(classBlock(CSS, 'chatCard'), '会话卡不吃剩余高度 ⇒ 列表没有可分配的空间')
      .toMatch(/flex:\s*1 1 auto/)
    // 2026-10-13 C2 反转记录：原断言守 `.root > *:not(.tableCard) { flex-shrink: 0 }`。
    // 两栏定式落地后 tableCard 不再是 root 的直接子（它在 shell ▸ work 里），root 的弹性子换成
    // .shell；「不滚的块不被压」的纪律改由 `.root > *:not(.shell)` 与 `.workChat > *:not(.chatCard)`
    // 两层共同承担（后者把原命题在 work 层原样复述），故按反转纪律改写而非删除。
    expect(CSS, '不滚的块没禁收缩 ⇒ flex-shrink:1 先把卡片压进容器，Card 的 overflow:hidden 静默吞内容')
      .toMatch(/\.root > \*:not\(\.shell\) \{[^}]*flex-shrink:\s*0/)
    expect(CSS, 'work 层没复述「不滚的块不被压」⇒ 提示条在 work 里被压缩吞掉')
      .toMatch(/\.workChat > \*:not\(\.chatCard\) \{[^}]*flex-shrink:\s*0/)
  })

  it('反向棘轮：面板样式里不许再出现「猜容器高度」的视口单位', () => {
    expect(CSS, '100vh 猜高回归（P2 复活：卡片换行即崩、页脚漂移）').not.toContain('100vh')
    expect(CSS, '62vh 是 kit .tableWrap 的旧上限，clawbot 不该再依赖它').not.toContain('62vh')
  })

  it('Card body 透传：高度链不被 kit 的 body div 打断（P10，2026-10-13 真机实测）', () => {
    // kit Card 在 children 外包一层 body div；它不透传成 flex 列容器时 .msgList 不收缩，
    // 内容被 .chatCard 的 overflow:hidden 裁掉且**无滚动条（不可达）**—— 实测 1839px 裁成 183px。
    expect(CSS_RULES, 'body 不透传 ⇒ 消息被裁且无滚动条（P10 复活）')
      .toMatch(/\.chatCard > div \{[^}]*display:\s*flex/)
    expect(CSS_RULES, 'body 透传没带 min-height: 0 ⇒ flex 链照样断')
      .toMatch(/\.chatCard > div \{[^}]*min-height:\s*0/)
  })

  it('旧类名已退役：.tableScroll / css.tableScroll 都不许回来', () => {
    expect(CSS, '.tableScroll 还留在 clawbot 样式里（旧名 = 视口猜高的载体）').not.toContain('.tableScroll')
    expect(CHAT, '会话视图还在用 css.tableScroll（改名只改了一半）').not.toContain('css.tableScroll')
  })
})

describe('ClawBot B0：DataTable 退静态（kit 安全边界）', () => {
  it('kit 新 prop 默认值不变：30+ 既有面板零影响', () => {
    expect(KIT_TABLE_TSX, 'scroll 默认值被改 ⇒ 其余面板的表格会突然不滚（静默降级）')
      .toContain('scroll = true')
    expect(KIT_TABLE_TSX, 'minWidth 默认值必须等于 .table 的 CSS 值 640').toContain('minWidth = 640')
    const staticWrap = classBlock(KIT_TABLE_CSS, 'tableWrapStatic')
    expect(staticWrap, '静态包装不退滚 ⇒ clawbot 仍是嵌套滚动').toMatch(/overflow:\s*visible/)
    expect(staticWrap).toMatch(/max-height:\s*none/)
  })

  it('clawbot 显式退静态并接管滚动', () => {
    const call = jsxCall(CHAT, 'DataTable')
    expect(call, 'DataTable 没传 scroll={false} ⇒ kit 的 62vh 上限还在，嵌套滚动')
      .toContain('scroll={false}')
    expect(CHAT, '滚动容器没换成 css.msgList').toContain('className={css.msgList}')
  })
})

describe('ClawBot B0：容器查询地基', () => {
  it('root 是 inline-size 容器（断点基准 = 面板自身宽度）', () => {
    expect(classBlock(CSS, 'root'), '没有 container-type ⇒ 后续 @container 断点全部不生效（P6 原地踏步）')
      .toMatch(/container-type:\s*inline-size/)
  })
})

describe('ClawBot B1：会话三区化（筛选条 / 底部发送坞 / 列分档）', () => {
  it('筛选条合并了统计与导出；页脚卡已取消', () => {
    expect(CSS, '筛选条行容器不见了（工具与统计又分家）').toMatch(/\.filterRow \{[^}]*display:\s*flex/)
    expect(CSS, '统计/导出没有右端成组（margin-left:auto）').toMatch(/\.filterRightStart \{[^}]*margin-left:\s*auto/)
    expect(classBlock(CSS, 'stats'), '统计没有防换行（nowrap），窄档会被折断').toMatch(/white-space:\s*nowrap/)
    expect(CHAT, '统计没有并进筛选条（共 N · 已加载 M）').toContain('css.stats')
    expect(CHAT, '实时点没有并进筛选条').toContain('css.live')
    // 反向棘轮：页脚卡回归 = 统计又分散回表格底部（P5 复发）
    expect(CSS, '.foot 又回来了（页脚卡回归）').not.toContain('.foot')
    expect(CHAT, '还在用 css.foot / css.footAction').not.toContain('css.foot')
    expect(CSS, '.tools 未退役（旧工具卡类名，留着就是死 CSS）').not.toContain('.tools')
  })

  it('A13 筛选条**一律换行**，任何宽度下都不许藏控件（2026-10-17 四次反转）', () => {
    // 演进记录（**四次**反转，判据跟着走）：
    //   · 初版 `flex-wrap: wrap` —— 宽屏下时间预设与日期区间**上下两行**（`.dateRange` 是 column），
    //     筛选条高度随容器宽度跳，下面的消息列表跟着抖。
    //   · 第二版 `nowrap` + 横滚 —— 高度恒定了，但**窄屏要横滑**才能看到搜索框与导出按钮，
    //     而横滚条被藏掉了 ⇒ 没有任何「右边还有东西」的提示，用户找不到它们。
    //   · 第三版「宽档 nowrap + 横滚 / 窄档 wrap」—— 宽档**仍然藏控件**：实测容器 1054px 时
    //     `scrollWidth 1138 > clientWidth 1054`，「共 22 条 · 已加载 22 条」与「● 实时」被裁掉
    //     41 / 84px，而滚动条被 `scrollbar-width: none` 藏了 ⇒ 用户看到的就是「被遮挡住了」
    //     （2026-10-17 用户第二次报同一现象）。
    //   · 第四版（本版）：**去掉 `.filterLeft` / `.filterRight` 两层容器**，所有控件成为
    //     `.filterRow` 的**直接子元素** ⇒ 只有一个 flex 流，行数由「控件总宽度」决定，最少。
    //     原先两个容器**各自 `wrap` 再叠加** ⇒ 实测 1280px 就 3 行、640px 到 6 行。
    //     同时加「最多两行」的压缩手段（见下方各断言）。
    //
    // 基础规则 = 可换行。
    expect(CSS, '筛选条基础规则不是可换行（窄容器里控件会被压扁或藏起来）')
      .toMatch(/\.filterRow \{[^}]*flex-wrap:\s*wrap/)
    // ⚠️ **任何档位都不许出现横滚 + 藏滚动条** —— 那正是「控件被遮挡」的成因。
    expect(CSS_RULES, '筛选条又出现 overflow-x: auto（横滚 + 藏滚动条 = 控件静默消失）')
      .not.toMatch(/\.filterRow \{[^}]*overflow-x:\s*auto/)
    expect(CSS_RULES, '筛选条又藏横向滚动条').not.toMatch(/\.filterRow::-webkit-scrollbar/)
    expect(CSS_RULES, '筛选条又收紧成 nowrap（放不下的控件会被裁掉）')
      .not.toMatch(/\.filterRow \{[^}]*flex-wrap:\s*nowrap/)
    // ⚠️ 两层容器（`.filterLeft` / `.filterRight`）**必须退役** —— 它们各自 `wrap` 会叠加行数。
    expect(CSS_RULES, '`.filterLeft` 又回来了（两个 flex 容器各自 wrap ⇒ 行数叠加）')
      .not.toMatch(/\.filterLeft\s*\{/)
    expect(CSS_RULES, '`.filterRight` 又回来了（两个 flex 容器各自 wrap ⇒ 行数叠加）')
      .not.toMatch(/\.filterRight\s*\{/)
    // 宽档只保留「叶子控件不被压扁」（否则日期框被挤成一条缝），且**只作用于叶子**。
    expect(CSS, '宽档叶子控件没禁收缩（日期框会被挤成一条缝）')
      .toMatch(/@container \(min-width: 1201px\) \{\s*\.filterRow > \* \{[^}]*flex-shrink:\s*0/)
    // 搜索框：宽档是唯一可伸缩的（且必须写在 `flex-shrink: 0` 之后 —— 同优先级后写的赢）。
    const shrinkAt = CSS.indexOf('.filterRow > *')
    const searchAt = CSS.indexOf('.searchFlex')
    expect(searchAt, '搜索框没有可伸缩定义（宽档一行里没人吃余量）').toBeGreaterThan(-1)
    expect(searchAt, '搜索框写在 flex-shrink:0 之前 ⇒ 被钉死，宽档一行里没人吃余量').toBeGreaterThan(shrinkAt)
    // ⚠️ 窄档搜索框**不许独占整行**（2026-10-17 实测）：`flex: 1 1 100%` 会让它吃掉一整行，
    // 后面的导出按钮 / 统计 / 实时全被挤到第 3 行 ⇒ 筛选条 3 行。
    expect(CSS_RULES, '窄档搜索框又独占整行（后面的控件被挤到第 3 行）')
      .not.toMatch(/@container \(max-width: 1200px\) \{\s*\.searchFlex \{ flex: 1 1 100%/)
    // 窄档右端那组不再吃 `margin-left: auto`（换行后它独占一行，靠左更整齐）。
    expect(CSS, '窄档右端组还在吃 margin-left:auto（换行后会被推到右边）')
      .toMatch(/@container \(max-width: 1200px\) \{\s*\.filterRightStart \{ margin-left:\s*0/)
    // ── 「最多两行」的压缩手段（2026-10-17 实测逐档调出来的）──
    // 窄档（≤1200px）藏掉第 4、5 个预设 chip（近7天 / 近30天）—— 省约 130px。
    expect(CSS, '窄档没藏多余预设 chip（DateRangeField 会独占一行）')
      .toMatch(/@container \(max-width: 1200px\) \{[\s\S]{0,600}?dateRangePresets'\] > :nth-child\(n \+ 4\) \{ display:\s*none/)
    // 窄档统计文案缩短（「共 22 条 · 已加载 22 条」→「22/22」）—— 省 90px。
    expect(CSS, '窄档统计文案没缩短（完整文案 120px 宽，两行放不下）')
      .toMatch(/@container \(max-width: 1200px\) \{[\s\S]{0,600}?\.statsFull \{ display:\s*none/)
    // 极窄档（≤800px）藏掉全部预设 chip + 缩小日期框 + 缩短导出按钮文案。
    expect(CSS, '极窄档没藏全部预设 chip（容器 ~548px 时必然 3 行）')
      .toMatch(/@container \(max-width: 800px\) \{[\s\S]{0,400}?dateRangePresets'\] \{ display:\s*none/)
    expect(CSS, '极窄档没缩小日期框（max-content 314px + 收/发 118px > 容器宽）')
      .toMatch(/@container \(max-width: 800px\) \{[\s\S]{0,900}?dateField'\] \{ padding:\s*0 3px/)
    expect(CSS, '极窄档没缩短导出按钮文案（两个按钮省约 40px）')
      .toMatch(/@container \(max-width: 800px\) \{[\s\S]{0,900}?\.exportFull \{ display:\s*none/)
    // 日期预设与区间并排（`inline` 变体），否则 `.dateRange` 的 column 仍会撑成两行。
    expect(CHAT, 'DateRangeField 没开 inline（预设与区间仍上下两行）').toMatch(/ariaLabel="接入会话时间筛选"\s*\n\s*inline/)
    expect(KIT_FIELDS, 'DateRangeField 没有 inline 变体').toContain('dateRangeInline')
    // ⚠️ inline 变体必须 `wrap` 而不是 `nowrap`（2026-10-17 真机实测踩到）：
    // `nowrap` 下这个组件**不会收缩**（宽度由内容决定），窄容器里它自己溢出父容器 ——
    // 而筛选条是 `overflow: visible` ⇒ 溢出的部分**被裁掉且不可滚**，
    // 用户看不到「近30天」与日期框（实测 1280/1100/760/640px 四档都中招）。
    expect(KIT_CSS, 'inline 变体用了 nowrap ⇒ 窄容器里它自己溢出、控件被裁掉且不可滚')
      .toMatch(/\.dateRangeInline \{[^}]*flex-wrap:\s*wrap/)
    expect(KIT_CSS, 'inline 变体的预设行不能折（窄容器里仍会溢出）')
      .toMatch(/\.dateRangeInline \.dateRangePresets \{[^}]*flex-wrap:\s*wrap/)
    expect(KIT_CSS, '日期区间行不能折（窄容器里「至」与结束日期会被裁掉）')
      .toMatch(/\.dateRangeRow \{[^}]*flex-wrap:\s*wrap/)
  })

  it('发送坞沉底：输入框在消息列表之后，且带「去绑定」入口', () => {
    const listAt = CHAT.indexOf('css.msgList')
    const dockAt = CHAT.indexOf('css.composerInput')
    expect(listAt, '找不到 css.msgList（B0 的改名被回退了？）').toBeGreaterThan(-1)
    expect(dockAt, '找不到 css.composerInput').toBeGreaterThan(-1)
    expect(dockAt, '发送器又漂回表格上方（P5 复发）：输入框必须在消息列表之后').toBeGreaterThan(listAt)
    expect(CHAT, '未绑定态的「去绑定微信」入口不在发送坞里').toContain('css.dockAction')
    expect(classBlock(CSS, 'dockAction')).toMatch(/flex:\s*0 0 auto/)
  })

  it('列隐藏机制已退役：不许用 display:none 藏单元格（colgroup 的 col 宽度移除不掉）', () => {
    // 2026-10-13 C0 反转记录：原断言守「两条 @container 把 .colType/.colChars 隐藏」。
    // 真机实测否证了该机制（960×640、面板 750px 的 N 档下正文列 clientWidth 52 /
    // scrollWidth 7962、表格右半整块空白）：display:none 挂在单元格上不会移除 <colgroup>
    // 的 <col> 宽度，table-layout: fixed 照样为被隐藏的列留位。机制整体退役
    // （docs/CLAWBOT-THREAD-REDESIGN.html §2 P0 / §9 C0），断言按反转纪律改写为反向棘轮。
    expect(CSS_RULES, '列隐藏回归：.colType 又被 display:none 藏掉（P0 复活）')
      .not.toMatch(/\.colType[^}]{0,40}display:\s*none/)
    expect(CSS_RULES, '列隐藏回归：.colChars 又被 display:none 藏掉（P0 复活）')
      .not.toMatch(/\.colChars[^}]{0,40}display:\s*none/)
    expect(CHAT, '列类还接在 JSX 上（隐藏机制只退了一半）').not.toContain('css.colType')
    expect(CHAT, '列类还接在 JSX 上（隐藏机制只退了一半）').not.toContain('css.colChars')
  })

  it('明细表格窄了横滚不藏列：msgList 横纵同容器 + kit 表 min-width 640', () => {
    // 横滚安全网 = .msgList 的 overflow: auto（横纵同一容器，面板级纵向滚动容器仍唯一）；
    // 不另加 overflow-x 包装 —— 那会把表头 sticky 的最近滚动口抢走（吸顶失效）。
    expect(classBlock(CSS, 'msgList'), 'msgList 不横滚 ⇒ 窄面板下表格被裁而不是可滚（G8）')
      .toMatch(/overflow:\s*auto/)
    expect(KIT_TABLE_CSS, '表 min-width 640 被改 ⇒ 横滚下限失效，窄表又会被压塌')
      .toMatch(/\.table \{[\s\S]*?min-width:\s*640px/)
  })

  it('列宽显式：kit 有 width 字段与 colgroup，clawbot 固定列给了宽度、正文列保持弹性', () => {
    expect(KIT_TABLE_TSX, 'DataColumn 没有 width 字段 ⇒ 列宽无法显式化（P3 原地踏步）').toContain('width?: number')
    // 精确计数而非存在性：两条渲染路径（骨架 + 主分支）都必须渲染 colgroup，
    // 只查「有」的话，删掉任一条另一边仍绿（2026-10-12 变异自证实测咬不住）。
    const colgroupCount = (KIT_TABLE_TSX.match(/<colgroup>/g) ?? []).length
    expect(colgroupCount, 'colgroup 必须出现在骨架与主分支两条路径上；少一条 ⇒ 那条路径的列宽不兑现')
      .toBe(2)
    // 门槛条件也要咬：写死 false 时 JSX 文本还在、colgroup 却永远不渲染（断言只看文本会漏）
    expect(KIT_TABLE_TSX, 'colgroup 的门槛条件被写死 ⇒ 有宽度也不渲染').toContain('columns.some((c) => c.width !== undefined)')
    for (const w of ['width: 120', 'width: 64', 'width: 76', 'width: 56']) {
      expect(CHAT, `clawbot 列宽 ${w} 没写上（退回五列均分）`).toContain(w)
    }
    // 正文列必须是弹性列（不设宽度）——「正文吃掉全部余量」的前提
    const contentCol = sliceBetween(CHAT, "id: 'content'", "id: 'chars'", '正文列切片')
    expect(contentCol, '正文列被设了宽度 ⇒ 它不再是弹性列，长文与缩略图又会被压').not.toContain('width:')
  })
})

describe('ClawBot B2：设置双列 + 指挥条状态 pill', () => {
  it('A15 实例轨与工作区**视觉统一**（2026-10-17）', () => {
    // 症状：轨只有 `--nm-r-md` 圆角且**没有阴影**，而工作区是带阴影的 `Card` ⇒
    // 两栏看起来像「一个卡片 + 一块裸区域」，不像同一层级的两个面板。
    // 修复：轨改用与 `Card` 同一套视觉语言（同背景 / 同圆角 `--nm-r-lg` / 同阴影 `--nm-shadow-card`）。
    const rail = classBlock(CSS_RULES, 'rail')
    expect(rail, '轨没有卡片阴影 ⇒ 与工作区不在同一视觉层级').toMatch(/box-shadow:\s*var\(--nm-shadow-card\)/)
    expect(rail, '轨的圆角与 Card 不一致（Card 用 --nm-r-lg）').toMatch(/border-radius:\s*var\(--nm-r-lg\)/)
    expect(rail, '轨的背景与 Card 不一致（Card 用 --nm-bg-card）').toMatch(/background:\s*var\(--nm-bg-card\)/)
    // 与 kit 的 `.card` 对齐（同圆角令牌 + 同阴影令牌）—— 两边各写一套就会漂。
    expect(KIT_CSS, 'kit .card 的圆角令牌变了 ⇒ 本判据的「一致」前提失效')
      .toMatch(/\.card \{[\s\S]{0,200}?border-radius:\s*var\(--nm-r-lg\)/)
    expect(KIT_CSS, 'kit .card 的阴影令牌变了 ⇒ 本判据的「一致」前提失效')
      .toMatch(/\.card \{[\s\S]{0,300}?box-shadow:\s*var\(--nm-shadow-card\)/)
  })

  it('A16 会话视图是**一张卡 + 三段**（2026-10-17 用户要求「不要分块，合并在一起」）', () => {
    // 症状：三张独立卡（筛选条 / 消息列表 / 发送坞）各自带边框、圆角与阴影 ⇒
    // 视觉上像三个互不相干的板块，而它们其实是**同一个会话视图的三个部分**（筛选 → 读 → 发）。
    const cards = CHAT.match(/<Card[\s>]/g) ?? []
    expect(cards.length, `会话视图有 ${String(cards.length)} 张 Card（应只有 1 张）`).toBe(1)
    expect(CHAT, '会话卡没接上 .chatCard').toContain('css.chatCard')
    // 会话卡还要接 `fillCard`：否则全局卡高上界（≈598px）会在最大化窗口下截住它，
    // 卡下方留一大片空白（2026-10-18 用户截图报的 ClawBot 会话视图）。
    expect(CHAT, '会话卡没接上 .fillCard（会被全局卡高上界截住）').toContain('css.fillCard')
    // 三段都在同一张卡里（筛选条 / 消息列表 / 发送坞）。
    for (const cls of ['css.filterRow', 'css.msgList', 'css.composerCol']) {
      expect(CHAT, `缺少 ${cls} 段`).toContain(cls)
    }
    // 段之间用分隔线，不是整圈边框。
    expect(CSS_RULES, '筛选条段没有下分隔线').toMatch(/\.chatCard \.filterRow \{[^}]*border-bottom:\s*1px solid/)
    expect(CSS_RULES, '发送坞段没有上分隔线').toMatch(/\.chatCard \.composerCol \{[^}]*border-top:\s*1px solid/)
    // 提示条夹在段之间：贴边、不额外撑高（否则又像一块独立的小卡）。
    expect(CSS_RULES, '提示条没贴边（又像一块独立小卡）')
      .toMatch(/\.chatCard \.noticeOk, \.chatCard \.noticeErr \{[^}]*border-radius:\s*0/)
    // 旧类名退役。
    // ⚠️ 用 `CSS_RULES`（去注释）—— 说明里必然要写出被禁的旧名，连注释一起量会咬到自己。
    expect(CSS_RULES, '.tableCard 未退役（旧独立卡类名，留着就是死 CSS）').not.toContain('.tableCard')
    expect(CSS_RULES, '.card 未退役（旧独立卡类名）').not.toMatch(/^\.card \{/m)
    expect(CHAT, '还在用 css.tableCard / css.card').not.toMatch(/css\.(tableCard|card)\b/)
  })

  it('R3 反转：设置视图单列通栏；环境自检并进当前实例卡', () => {
    // 2026-10-13 C3 反转记录：原断言守「W/XW 双列（3fr/2fr）+ FAQ 通栏」。实例轨吃掉左栏宽度后
    // 双列的动机（两张矮卡并排填空）不存在，且绑定卡与自检已合并成一张卡 ——
    // 右列四成空白与 kvGrid 孤儿格随之消失（P6）。
    // 2026-10-17 重设计：`css.envHead` 换成 `Section`（卡内分区）—— 断言跟着改。
    expect(SETTINGS, '设置视图没有单列容器（三卡又变成无容器的散件）').toContain('css.settingsCol')
    expect(CSS_RULES, '设置视图又回双列（3fr/2fr 回归）').not.toMatch(/grid-template-columns:\s*minmax\(0, 3fr\)/)
    expect(SETTINGS, '环境自检没有并进当前实例卡（又独占一卡留白）').toMatch(/<Section title="环境自检"/)
  })

  it('A14 设置视图是**一张卡 + 内部分区**（2026-10-17 用户要求「不要分为太多个板块」）', () => {
    // 症状：设置视图三张独立卡（绑定 / 自动回复 / 常见问题）各自带边框、圆角与标题栏 ——
    // 视觉上像三个互不相干的板块，而它们其实是**同一个实例的设置**。
    // 修复：合并成一张 `<Card>` + 内部分区（`Section`，用 `border-top` 分隔线而不是整圈边框）。
    const cards = SETTINGS.match(/<Card[\s>]/g) ?? []
    expect(cards.length, `设置视图有 ${String(cards.length)} 张 Card（应只有 1 张，其余用 Section）`).toBe(1)
    expect(SETTINGS, '没有 Section 组件（分区机制缺失）').toContain('function Section(')
    // 四个分区都要在（当前实例 / 自动回复 / 环境自检 / 常见问题）。
    // ⚠️ 「当前实例」的 title 是模板字符串（带 slot），不是字面量。
    expect(SETTINGS, '缺少「当前实例」分区').toMatch(/<Section title=\{`当前实例 · 实例 \$\{slot \?\? '—'\}`\}/)
    for (const t of ['自动回复', '环境自检', '常见问题']) {
      expect(SETTINGS, `缺少「${t}」分区`).toContain(`title="${t}"`)
    }
    // 低频内容（自检 / FAQ）默认折叠 —— 它们占的纵向空间不小，但日常操作根本用不到。
    expect(SETTINGS, '常见问题没有默认折叠（低频内容占着纵向空间）')
      .toMatch(/<Section title="常见问题" collapsible defaultOpen=\{false\}/)
    expect(SETTINGS, '环境自检没有可折叠（排障时才需要展开）')
      .toMatch(/<Section title="环境自检"[^>]*collapsible/)
    // 自检有异常项时默认展开（用户打开设置多半就是来排障的）。
    expect(SETTINGS, '自检异常时没有默认展开').toMatch(/defaultOpen=\{envHasIssue\}/)
    // 分区用 `border-top` 分隔线，不是整圈边框（整圈会重新变成「多张卡」的观感）。
    expect(CSS_RULES, '分区用了整圈边框 ⇒ 又变回「多张卡」的观感')
      .toMatch(/\.section \{ border-top: 1px dashed var\(--nm-border\)/)
    expect(CSS_RULES, '第一个分区没去掉分隔线（卡片顶部多一条线）')
      .toMatch(/\.section:first-child \{ border-top: 0/)
    // 旧的独立卡类名退役。
    expect(CSS, '.envHead 未退役（旧独立分区标题，留着就是死 CSS）').not.toContain('.envHead')
    expect(CSS, '.bindTitle 未退役（标题已上提到分区标题）').not.toContain('.bindTitle')
    expect(CSS, '.bindDesc 未退役（说明已上提到分区 hint）').not.toContain('.bindDesc')
  })

  it('kvGrid 分档：N 档退 1 列', () => {
    // 2026-10-13 C2 收紧记录：原正则允许跨容器块匹配（C2 在文件前部新增了一个
    // max-width: 800px 的实例轨块后，它能从那个块出发、借 .settingsGrid 基线的
    // `minmax(0, 1fr)` 凑成命中 —— 变异删掉真规则照样绿，变异跑抓到了这次削弱）。
    // 改成块内精确匹配：kvGrid 的 N 档规则必须自己住在一个 max-800 块里。
    expect(CSS, 'N 档 kvGrid 没有退 1 列（750px 窄面板里两列键值对互相挤）')
      .toMatch(/@container \(max-width: 800px\) \{\s*\.kvGrid \{ grid-template-columns: minmax\(0, 1fr\); \}/)
  })

  it('R2 反转：绑定四态 pill 从指挥条下沉到实例轨头部；指挥条不再有 select', () => {
    // 2026-10-13 C2 反转记录：原断言守「指挥条（PanelHeader actions）含绑定四态 pill」。
    // 多实例落地后「切哪个号」收进实例轨，pill 跟着下沉到轨头部（离实例更近、逐行状态可见），
    // P7（绑定态隐身）由「轨常驻」更彻底地解决；指挥条的 <select> 同期退役。
    expect(RAIL, '实例轨头部没有状态 pill（绑定态又隐身了，P7 复发）').toContain('css.statusPill')
    expect(RAIL, 'pill 没有用 StateDot 四态映射').toContain('statusDot(')
    expect(RAIL, 'pill 没有用共享中文标签表 CLAWBOT_STATUS_LABEL').toContain('CLAWBOT_STATUS_LABEL')
    expect(RAIL, 'pill 没有「状态未知」态 ⇒ 会把库读失败显示成未绑定').toContain('状态未知')
    expect(PANEL, '指挥条还有 <select>（切号入口又变成两处）').not.toContain('<select')
    expect(PANEL, '面板还留着 pill 计算（第二份实现，两处漂移的起点）').not.toContain('css.statusPill')
    // 单一事实源（继承原 B2 断言，改钉在轨上）：四态映射只许住在 clawbot-status.ts。
    expect(STATUS, '四态映射没有独立成 clawbot-status.ts（视图互相 import 会成值 import 环）')
      .toContain('export function statusDot')
    expect(SETTINGS, '设置视图又抄了一份四态映射').not.toContain('export function statusDot')
    expect(RAIL, '轨没有从 clawbot-status.ts import 四态映射 ⇒ 存在第二份实现')
      .toMatch(/import \{[^}]*statusDot[^}]*\} from '\.\/clawbot-status\.ts'/)
    expect(classBlock(CSS, 'statusPill')).toMatch(/display:\s*inline-flex/)
    expect(classBlock(CSS, 'stUnknown')).toMatch(/color:\s*var\(--nm-text-3\)/)
  })

  it('A4 实例轨三形态 + 当前行标记 + 破坏性操作不在轨上', () => {
    expect(CSS_RULES, 'shell 没有三档栅格（N 横条 / W 168 / XW 208）')
      .toMatch(/@container \(min-width: 801px\) \{\s*\.shell \{ grid-template-columns: 168px/)
    expect(CSS_RULES, 'XW 档左栏不是 208px')
      .toMatch(/@container \(min-width: 1201px\) \{\s*\.shell \{ grid-template-columns: 208px/)
    expect(CSS_RULES, 'N 档实例轨没有退成横向条（750px 面板会被左栏切走宽度）')
      .toMatch(/@container \(max-width: 800px\) \{[\s\S]*?\.rail \{[^}]*flex-direction:\s*row/)
    expect(RAIL, '轨上没有「当前」标记 ⇒ 用户看不出操作的是哪个号').toContain('css.instCurrent')
    // 2026-10-16：当前行标记改成先算 `current`（同一个值还要驱动色条与「当前」标），
    // 所以断言从「字面比对 slot」改成「`current` 确实由 slot 比对得出」+「data-current 用它」。
    expect(RAIL, '当前行标记没比对 slot（要么一行都不标、要么行行都标）').toMatch(/const current = it\.slot === slot/)
    expect(RAIL, 'data-current 没接上 current').toMatch(/data-current=\{current \? '' : undefined\}/)
    expect(RAIL, '轨上出现了移除按钮（破坏性操作不许放导航，N8）').not.toContain('移除')
    expect(RAIL, '轨上没有新增实例入口').toContain('新增实例')
    expect(RAIL, '未绑定行的绑定入口不在轨上（切号与绑定都该在轨完成）').toContain('apiCreateClawbotBindQr')
  })

  it('A9 实例轨行内重命名（2026-10-16）：就地编辑、Esc 取消、失焦保存', () => {
    // 改名是高频轻操作：弹窗要「打开 → 输入 → 确认」三步，行内编辑只要「双击 → 输入 → 回车」。
    expect(RAIL, '轨上没有重命名入口').toContain('apiRenameClawbotInstance')
    expect(RAIL, '双击名字不能进入编辑').toMatch(/onDoubleClick=\{\(e\) => \{ e\.stopPropagation\(\); setEditing\(it\.slot\) \}\}/)
    expect(RAIL, '没有行内输入框组件').toContain('RailRenameInput')
    expect(RAIL, 'Esc 没取消（会冒泡到面板的关闭逻辑）').toMatch(/e\.key === 'Escape'[\s\S]{0,80}e\.stopPropagation\(\)/)
    expect(RAIL, '失焦没保存').toMatch(/onBlur=\{commit\}/)
    // 别名优先于昵称：用户起别名就是为了「一眼认出哪个号」，昵称压在上面等于改名没发生。
    expect(RAIL, '行标签没把别名排在昵称之前').toMatch(/return it\.label \?\? it\.userName \?\? `实例 \$\{it\.slot\}`/)
  })

  it('A12 整行可点 + 触摸目标 ≥44px（2026-10-17 修「有时候点击没反应」）', () => {
    // 症状：点实例行的**第二行**（`今日 N · 已绑定`）或行内空白毫无反应。
    // 成因：`onClick` 原先只挂在第一行（`.railRowHead`），而整行有 `cursor: pointer` +
    // hover 底色 ⇒ 用户看到的就是「这一整块都能点」。
    // ⚠️ 不能用 `classBlock(CSS_RULES, 'railRow')` —— N 档的 `@container` 里也有一条
    // `.railRow { flex: 0 0 auto; }`，`classBlock` 会先抓到它。直接在主定义上匹配。
    expect(CSS_RULES, '行没有最小高度 ⇒ 触摸目标太小（手机上点不准）')
      .toMatch(/\.railRow \{[^}]*min-height:\s*44px/)
    // 点击挂在行本身（不是只挂第一行）：`role="button"` + `onClick` 都在 `.railRow` 上。
    expect(RAIL, '点击没挂在整行上（第二行与空白处仍然点不动）')
      .toMatch(/className=\{css\.railRow\}[\s\S]{0,900}?onClick=\{\(\) => \{ if \(!isEditing\) onPick\(it\.slot\) \}\}/)
    // 行内按钮必须各自 stopPropagation，否则点「绑定此号」会连带切实例。
    expect(RAIL, '绑定按钮没拦冒泡 ⇒ 点它会连带切实例').toMatch(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); void startBind\(it\.slot\) \}\}/)
    expect(RAIL, '改名按钮没拦冒泡 ⇒ 点它会连带切实例').toMatch(/onClick=\{\(e\) => \{ e\.stopPropagation\(\); setEditing\(it\.slot\) \}\}/)
    // 输入框也要拦双击（否则在输入框里双击会再次触发「进入编辑」）。
    expect(RAIL, '输入框没拦双击').toMatch(/onDoubleClick=\{\(e\) => \{ e\.stopPropagation\(\) \}\}/)
  })

  it('A10 切实例要立刻响应（2026-10-16）：乐观切 slot，不等两次 RPC', () => {
    // 实测 `listClawbotInstances` + `getClawbotBinding` 串行 ≈ 200ms+，后端忙时更久。
    // 等数据回来才切 slot ⇒ 用户点一下要愣一下（轨高亮、会话标签、发送坞归属都读 slot）。
    expect(PANEL, '切实例没有乐观切 slot（点击要等两次 RPC 才响应）')
      .toMatch(/const pickSlot = useCallback\(\(target: number\): void => \{\s*setSlot\(target\)\s*\n\s*void refresh\(target\)/)
    expect(PANEL, '轨的 onPick 没接上 pickSlot').toContain('onPick={pickSlot}')
    // 乐观值必须能被真实结果纠正：refresh 里 resolved 仍以列表为准（目标被删时回落缺省实例）。
    expect(PANEL, '乐观切之后 refresh 不再以列表为准 ⇒ 删掉实例后会停在幽灵 slot 上')
      .toMatch(/const resolved = want !== null && want !== undefined && list\.instances\.some\(i => i\.slot === want\)/)
  })

  it('A11 设置视图取数并行（2026-10-16）：实例列表与知识库列表互不依赖', () => {
    // 两者串行只是白等一个往返，而切实例时这一对会跟着 snapshot 重跑 ⇒ 代价直接落在点击响应上。
    expect(SETTINGS, '实例列表与知识库列表又串行了（切实例时白等一个往返）')
      .toMatch(/const \[s, kb\] = await Promise\.all\(\[\s*\n\s*apiListClawbotInstances\(\),\s*\n\s*apiGetKbs\(\)\.catch\(\(\) => null\),/)
  })
})

describe('ClawBot C1：对话流（默认读法）', () => {
  it('A2 正序渲染 + 贴底/浮标 + 读法切换接上 JSX', () => {
    expect(THREAD, '对话流没有把已加载行反转成正序（后端仍 DESC 分页，零后端改动）')
      .toContain('rows.slice().reverse()')
    expect(THREAD, '贴底逻辑不在（对话从最新一条读起；滚动纪律收在模块级 hook）')
      .toMatch(/scrollTop = el\.scrollHeight/)
    expect(CHAT, '滚动纪律没接模块级 hook（又会把组件撑过棘轮线）').toContain('useConversationScroll(')
    expect(CHAT, '读法切换没接上（对话 | 明细）').toContain('ClawbotThread')
    expect(CHAT, '默认读法不是对话（C1 的语义反转没落地）').toContain("useState<'thread' | 'detail'>('thread')")
    expect(CHAT, '不在底部时的新消息浮标没接上（会打断阅读）').toContain('条新消息')
    expect(CHAT, '对话读法的加载更多哨兵没摆到顶部（更旧的页在上方）')
      .toContain("reading === 'thread' && pager.hasMore && <ListSentinel")
  })

  it('A3 气泡比例护栏：三档上限 + 下限宽；继承的三处比例钉住', () => {
    const bubble = classBlock(CSS, 'bubble')
    expect(bubble, '气泡没有下限宽 ⇒ 长文又会把内容压塌（P0 的对话流复发口）').toMatch(/min-width:\s*120px/)
    expect(bubble, '气泡 N 档上限不是 86%').toMatch(/max-width:\s*86%/)
    expect(CSS_RULES, 'W 档气泡上限不是 72%').toMatch(/@container \(min-width: 801px\) \{\s*\.bubble \{ max-width: 72%/)
    expect(CSS_RULES, 'XW 档气泡上限不是 64%').toMatch(/@container \(min-width: 1201px\) \{\s*\.bubble \{ max-width: 64%/)
    // 继承自上一稿 G1/G3 的三处刻意比例（防「顺手改成百分比」）
    expect(classBlock(CSS, 'thumbImg'), '缩图 84px 定高被改（行高稳定语义丢失）').toMatch(/height:\s*84px/)
    expect(classBlock(CSS, 'thumbImg'), '缩图不再 cover（比例被拉变形）').toMatch(/object-fit:\s*cover/)
    expect(classBlock(CSS, 'qrPaper'), '二维码纸面不再是 188px 方（扫码对比度语义）').toMatch(/width:\s*188px/)
    expect(classBlock(CSS, 'mediaZoom'), '大图 72vh 上限被改（内容最大化语义）').toMatch(/max-height:\s*72vh/)
  })
})

describe('ClawBot C3：实例卡拆解与设置重排（A5–A8）', () => {
  it('A8 设置视图不再挂载实例卡；缺省规则真源仍在', () => {
    // 2026-10-13 C3 反转记录：原 M5 断言守「设置视图把 currentSlot 传给实例卡、实例卡标当前行」。
    // 实例卡整卡拆解（导航进轨、配置进行为卡、删除进危险区）后，「当前实例信息显示两遍」（P3）
    // 与「行内改别的号的配置」的隐患一起消失；当前行标记由 A4 在轨上把守。
    expect(SETTINGS, '实例卡又挂回设置视图（当前实例信息又显示两遍，P3 复发）')
      .not.toContain('ClawbotInstancesCard')
    expect(INSTANCES, '缺省实例规则的实现不见了（前后端会各写一套）').toContain('export function pickDefaultSlot')
    expect(PANEL, '面板没从真源取缺省规则').toContain('pickDefaultSlot')
  })

  it('A5 发送坞带当前实例标签（P9），且在输入框之前', () => {
    const slotAt = CHAT.indexOf('css.dockSlot')
    const inputAt = CHAT.indexOf('css.composerInput')
    expect(slotAt, '发送坞没有实例标签 ⇒ 多实例下不知道消息以哪个号发').toBeGreaterThan(-1)
    expect(slotAt, '实例标签不在输入框之前（标签要先行说明归属）').toBeLessThan(inputAt)
    expect(classBlock(CSS, 'dockSlot'), '实例标签可被压缩换行（归属说明会碎）').toMatch(/flex:\s*0 0 auto/)
  })

  it('A6 行为卡：自动回复是 switch 形态且说清管道与审计（P4）', () => {
    // 精确计数而非存在性：三个开关（自动回复 / 知识库增强 / 长回复分段）都必须是 switch ——
    // 存在性断言在「其中之一退回裸 checkbox」时照样绿（2026-10-13 变异自证实测咬不住）。
    // 2026-10-17：新增「长回复分段发送」⇒ 2 → 3。
    const switchCount = (SETTINGS.match(/role="switch"/g) ?? []).length
    expect(switchCount, '行为卡的 switch 不是三个（其中之一又变回裸 checkbox）').toBe(3)
    expect(SETTINGS, '行为卡没说清审计在哪（开了不知道去哪查）').toContain('操作日志')
    expect(SETTINGS, '行为卡没说清走哪条管道（模型从哪来）').toContain('对话模型')
  })

  it('A17 系统提示词输入块（2026-10-17）：可编辑、可保存、可恢复默认', () => {
    // 用户要求「为实例增加系统提示词的内容输入版块」—— 回复太生硬，要能改人设。
    expect(SETTINGS, '没有系统提示词的输入框').toContain('css.promptInput')
    expect(SETTINGS, '输入框不是 textarea（单行输入写不下人设）').toMatch(/<textarea[\s\S]{0,400}?css\.promptInput/)
    expect(SETTINGS, '没有「保存提示词」按钮（改完没法提交）').toContain('保存提示词')
    expect(SETTINGS, '没有「恢复默认」按钮（写坏了回不去）').toContain('恢复默认')
    // 留空 = 用内置默认值，文案必须说清（否则用户以为「留空 = 没有提示词」）。
    expect(SETTINGS, '没说清「留空用内置默认提示词」').toContain('内置默认提示词')
    // 分段发送开关（长回复切成几条）。
    expect(SETTINGS, '没有「长回复分段发送」开关').toContain('长回复分段发送')
  })

  it('A19 分段与知识库降级文案和实际行为一致（2026-10-20）', () => {
    // 分段实际是每段 30 字、整条最多 300 字；旧文案把 300 字误写成每段上限。
    expect(SETTINGS, '分段文案没同时说明每段 30 字与整条 300 字')
      .toContain('每段不超过 30 字、整条不超过 300 字')
    expect(SETTINGS, '旧文案仍把 300 字说成每段上限').not.toContain('每条不超过 300 字')
    // 知识库增强开启但未选库时，自动回复仍会运行，只是不检索知识库。
    expect(SETTINGS, '知识库说明没讲清未选库时仍会继续自动回复')
      .toContain('开启增强但未选择知识库时，仍会继续自动回复，只是不检索知识库')
    expect(SETTINGS, '知识库未选库警告没讲清自动回复与检索的关系')
      .toContain('已开启知识库增强但未选择知识库 —— 会继续自动回复，但不检索知识库')
    expect(SETTINGS, '又出现了「不会静默降级」的错误承诺').not.toContain('不会静默降级成无库回复')
    expect(SETTINGS, '又出现了「不会检索任何内容」的错误描述').not.toContain('不会检索任何内容')
  })

  it('A7 kvGrid 去掉无信息项；N 档键值行键上值下（P5/P8）', () => {
    expect(SETTINGS, '「微信昵称」又回来了（iLink 不下发，恒为未提供的死字段）').not.toContain('微信昵称')
    expect(SETTINGS, '「实例编号」又回到 kvGrid（卡标题已经写了）').not.toContain('实例编号')
    expect(CSS_RULES, 'N 档键值行没有改键上值下（单列时横跨 750px 拉散）')
      .toMatch(/@container \(max-width: 800px\) \{\s*\.kvItem \{ flex-direction: column/)
  })

  it('A18 设置视图**宽面板两栏 / 窄面板单列**（2026-10-17 第二次布局重设计）', () => {
    /*
     * 症状（上一稿「一张卡 + 五个分区单列通栏」在 1016px 宽面板里）：
     *   ① 键值对（`.kvGrid` 两列）横跨 700px，键在最左、值在最右，中间大片空白；
     *   ② 系统提示词 textarea 占满整宽，但每行文字很短，右侧全是空；
     *   ③ 右半边整体没有内容，纵向被拉得很长（实测 860px）。
     * 修复：左栏（实例信息 + 危险区，固定 320px）+ 右栏（自动回复 + 提示词 + 自检 + FAQ，弹性）。
     */
    // 两栏容器与左右栏都在。
    expect(SETTINGS, '没有两栏容器（又退回单列通栏）').toContain('css.settingsGrid')
    expect(SETTINGS, '没有左栏（实例信息 + 危险区）').toContain('css.settingsAside')
    expect(SETTINGS, '没有右栏（自动回复 + 提示词 + 自检 + FAQ）').toContain('css.settingsMain')
    // 实例信息与危险区在**左栏**里（不是散在卡片里）。
    expect(SETTINGS, '实例信息不在左栏里').toMatch(/settingsAside[\s\S]{0,200}?<InstanceSection/)
    expect(SETTINGS, '危险区不在左栏里').toMatch(/settingsAside[\s\S]{0,2000}?css\.dangerZone/)
    // 自动回复与自检/FAQ 在**右栏**里。
    expect(SETTINGS, '自动回复不在右栏里').toMatch(/settingsMain[\s\S]{0,200}?<AutoReplySection/)
    expect(SETTINGS, '环境自检不在右栏里').toMatch(/settingsMain[\s\S]{0,4000}?<Section title="环境自检"/)
    // 两栏只在 ≥1000px（**面板自身宽度**）生效；窄面板塌成单列。
    // ⚠️ 断点取 1000px 而不是 1201px：`@container` 的基准是面板宽度，1400px 视口下面板只有 982px。
    expect(CSS_RULES, '两栏没有断点（窄面板里两栏会挤成一条缝）')
      .toMatch(/@container \(min-width: 1000px\) \{\s*\.settingsGrid \{ flex-direction: row/)
    expect(CSS_RULES, '左栏没有固定宽度（弹性会让键值对宽度随窗口跳）')
      .toMatch(/\.settingsAside \{ flex: 0 0 320px/)
    // 单列时左栏与右栏之间要有分隔线（两栏时靠栏间距）。
    expect(CSS_RULES, '单列时左右栏之间没有分隔线（两块内容糊在一起）')
      .toMatch(/\.settingsAside \{ border-bottom: 1px dashed var\(--nm-border\)/)
    // 两栏时左栏的键值对退单列 + 键上值下（320px 里两列会把值挤成一条缝）。
    expect(CSS_RULES, '两栏时左栏键值对没退单列')
      .toMatch(/\.settingsAside \.kvGrid \{ grid-template-columns: minmax\(0, 1fr\)/)
    expect(CSS_RULES, '两栏时左栏键值行没改键上值下（320px 里 space-between 仍会拉散）')
      .toMatch(/\.settingsAside \.kvItem \{ flex-direction: column/)
    // 状态行里的 wxid 必须可截断（40+ 字符长串会把「已绑定」挤成竖排）。
    expect(CSS_RULES, '状态行的 wxid 没截断（长 wxid 会把状态文字挤成竖排）')
      .toMatch(/\.bindStatus \.mono \{[^}]*text-overflow: ellipsis/)
    expect(CSS_RULES, '状态文字没 flex-shrink: 0（会被 wxid 压成竖排）')
      .toMatch(/\.bindStatus > span:not\(\.mono\) \{ flex-shrink: 0/)
    // 提示词框限高 + 内部滚动（默认提示词 20+ 行会把卡片撑得很高）。
    expect(CSS_RULES, '提示词框没有限高（默认提示词 20+ 行会把卡片撑爆）')
      .toMatch(/\.promptInput \{[\s\S]{0,600}?max-height: 400px/)
    expect(CSS_RULES, '提示词框限高但没给 overflow（内容会被裁掉）')
      .toMatch(/\.promptInput \{[\s\S]{0,700}?overflow: auto/)
    /*
     * 撑满容器高度（2026-10-17 用户报「下方留有太多空白」）：
     * `.workSettings` 是滚动容器，`.settingsCol` 原先只有内容高 ⇒ 卡片下方留 89px 空白。
     * ⚠️ 用 `flex: 1` 而不是 `min-height: 100%`（百分比高度在 flex item 上退化成 auto）。
     */
    expect(CSS_RULES, '滚动容器不是 flex 列容器（`.settingsCol` 的 flex:1 无从生效）')
      .toMatch(/\.workSettings \{ min-height: 0; overflow-y: auto; display: flex; flex-direction: column; \}/)
    expect(CSS_RULES, '设置列没有吃满容器高度（卡片下方留空白）')
      .toMatch(/\.settingsCol \{[^}]*flex: 1 1 auto/)
    // ⚠️ 卡片用**属性子串选择器**（CSS Modules 跨文件哈希不同，写 `.card` 匹配不到）。
    expect(CSS_RULES, '卡片没有吃满设置列（下方留空白）')
      .toMatch(/\.settingsCol > \[class\*='card'\] \{ flex: 1 1 auto; \}/)
    expect(CSS_RULES, '卡身没有吃满（两栏容器拿不到剩余高度）')
      .toMatch(/\.settingsCol > \[class\*='card'\] > \[class\*='cardBd'\] \{ flex: 1 1 auto/)
    // 两栏时左右栏**等高**（`align-items: stretch`）—— 用 flex-start 时左栏只有内容高。
    expect(CSS_RULES, '两栏时左右栏不等高（左栏底部留空白）')
      .toMatch(/\.settingsGrid \{ flex-direction: row; gap: 24px; align-items: stretch; \}/)
    // 危险区沉到左栏底部（破坏性操作离日常操作远一点，且填掉左栏下半空白）。
    expect(CSS_RULES, '危险区没有沉到左栏底部（左栏下半留空白）')
      .toMatch(/\.settingsAside \.dangerZone \{ margin-top: auto; \}/)
  })
})
