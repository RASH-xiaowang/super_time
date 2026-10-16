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

  it('表格卡是唯一弹性区；不滚的块不参与压缩', () => {
    expect(classBlock(CSS, 'tableCard'), '表格卡不吃剩余高度 ⇒ 列表没有可分配的空间')
      .toMatch(/flex:\s*1 1 auto/)
    // 2026-10-13 C2 反转记录：原断言守 `.root > *:not(.tableCard) { flex-shrink: 0 }`。
    // 两栏定式落地后 tableCard 不再是 root 的直接子（它在 shell ▸ work 里），root 的弹性子换成
    // .shell；「不滚的块不被压」的纪律改由 `.root > *:not(.shell)` 与 `.workChat > *:not(.tableCard)`
    // 两层共同承担（后者把原命题在 work 层原样复述），故按反转纪律改写而非删除。
    expect(CSS, '不滚的块没禁收缩 ⇒ flex-shrink:1 先把卡片压进容器，Card 的 overflow:hidden 静默吞内容')
      .toMatch(/\.root > \*:not\(\.shell\) \{[^}]*flex-shrink:\s*0/)
    expect(CSS, 'work 层没复述「不滚的块不被压」⇒ 筛选条/发送坞在 work 里被压缩吞掉')
      .toMatch(/\.workChat > \*:not\(\.tableCard\) \{[^}]*flex-shrink:\s*0/)
  })

  it('反向棘轮：面板样式里不许再出现「猜容器高度」的视口单位', () => {
    expect(CSS, '100vh 猜高回归（P2 复活：卡片换行即崩、页脚漂移）').not.toContain('100vh')
    expect(CSS, '62vh 是 kit .tableWrap 的旧上限，clawbot 不该再依赖它').not.toContain('62vh')
  })

  it('Card body 透传：高度链不被 kit 的 body div 打断（P10，2026-10-13 真机实测）', () => {
    // kit Card 在 children 外包一层 body div；它不透传成 flex 列容器时 .msgList 不收缩，
    // 内容被 .tableCard 的 overflow:hidden 裁掉且**无滚动条（不可达）**—— 实测 1839px 裁成 183px。
    expect(CSS_RULES, 'body 不透传 ⇒ 消息被裁且无滚动条（P10 复活）')
      .toMatch(/\.tableCard > div \{[^}]*display:\s*flex/)
    expect(CSS_RULES, 'body 透传没带 min-height: 0 ⇒ flex 链照样断')
      .toMatch(/\.tableCard > div \{[^}]*min-height:\s*0/)
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
    expect(CSS, '统计/导出没有右端成组（margin-left:auto）').toMatch(/\.filterRight \{[^}]*margin-left:\s*auto/)
    expect(classBlock(CSS, 'stats'), '统计没有防换行（nowrap），窄档会被折断').toMatch(/white-space:\s*nowrap/)
    expect(CHAT, '统计没有并进筛选条（共 N · 已加载 M）').toContain('css.stats')
    expect(CHAT, '实时点没有并进筛选条').toContain('css.live')
    // 反向棘轮：页脚卡回归 = 统计又分散回表格底部（P5 复发）
    expect(CSS, '.foot 又回来了（页脚卡回归）').not.toContain('.foot')
    expect(CHAT, '还在用 css.foot / css.footAction').not.toContain('css.foot')
    expect(CSS, '.tools 未退役（旧工具卡类名，留着就是死 CSS）').not.toContain('.tools')
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
  it('R3 反转：设置视图单列通栏；环境自检并进当前实例卡', () => {
    // 2026-10-13 C3 反转记录：原断言守「W/XW 双列（3fr/2fr）+ FAQ 通栏」。实例轨吃掉左栏宽度后
    // 双列的动机（两张矮卡并排填空）不存在，且绑定卡与自检已合并成一张卡 ——
    // 右列四成空白与 kvGrid 孤儿格随之消失（P6）。
    expect(SETTINGS, '设置视图没有单列容器（三卡又变成无容器的散件）').toContain('css.settingsCol')
    expect(CSS_RULES, '设置视图又回双列（3fr/2fr 回归）').not.toMatch(/grid-template-columns:\s*minmax\(0, 3fr\)/)
    expect(SETTINGS, '环境自检没有并进当前实例卡（又独占一卡留白）').toContain('css.envHead')
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
    expect(RAIL, '当前行标记没比对 slot（要么一行都不标、要么行行都标）').toMatch(/data-current=\{it\.slot === slot/)
    expect(RAIL, '轨上出现了移除按钮（破坏性操作不许放导航，N8）').not.toContain('移除')
    expect(RAIL, '轨上没有新增实例入口').toContain('新增实例')
    expect(RAIL, '未绑定行的绑定入口不在轨上（切号与绑定都该在轨完成）').toContain('apiCreateClawbotBindQr')
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
    // 精确计数而非存在性：两个开关（自动回复 / 知识库增强）都必须是 switch ——
    // 存在性断言在「其中之一退回裸 checkbox」时照样绿（2026-10-13 变异自证实测咬不住）。
    const switchCount = (SETTINGS.match(/role="switch"/g) ?? []).length
    expect(switchCount, '行为卡的 switch 不是两个（其中之一又变回裸 checkbox）').toBe(2)
    expect(SETTINGS, '行为卡没说清审计在哪（开了不知道去哪查）').toContain('操作日志')
    expect(SETTINGS, '行为卡没说清走哪条管道（模型从哪来）').toContain('对话模型')
  })

  it('A7 kvGrid 去掉无信息项；N 档键值行键上值下（P5/P8）', () => {
    expect(SETTINGS, '「微信昵称」又回来了（iLink 不下发，恒为未提供的死字段）').not.toContain('微信昵称')
    expect(SETTINGS, '「实例编号」又回到 kvGrid（卡标题已经写了）').not.toContain('实例编号')
    expect(CSS_RULES, 'N 档键值行没有改键上值下（单列时横跨 750px 拉散）')
      .toMatch(/@container \(max-width: 800px\) \{\s*\.kvItem \{ flex-direction: column/)
  })
})
