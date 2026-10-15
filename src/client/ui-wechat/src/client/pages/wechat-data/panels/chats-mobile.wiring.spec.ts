/**
 * 聊天面板**手机档**（≤560）的接线守卫：三栏 → 单栏栈、返回按钮、长按菜单。
 *
 * ## 为什么这一批必须有接线判据（而不是"构建过了就行"）
 *
 * 这一批的每一种坏法都**不报错、不变红、桌面端完全正常**：
 *
 *  1. **跨份选择器 = 死 CSS**。CSS Modules 按**文件**给类名打 hash：`.panel` / `.messages` 住在
 *     `chats-rows.module.css`，`.sidebar` 住在 `chats-cards.module.css`。在 cards 里写
 *     `.panel[data-has-session] .sidebar` 会拿到**两个不同的 hash** ⇒ 一条都选不中，
 *     而构建、typecheck、拆分守卫②（引用悬空）全绿。所以跨栏开关只能写成
 *     **纯属性选择器** `[data-has-session] .sidebar`（属性不产类名、也不加 hash）。
 *     这条判据就是把「谁都不许把 `.panel` 写进 cards 的手机块」钉住。
 *  2. **容器查询选不到容器自己**。`.messages` 自身就是 `container-type: inline-size`，
 *     所以现成的 `@container (max-width: 560px)` 只管它的**后代**；三栏重排要改的恰恰是
 *     `.panel` / `.messages` 这两级 ⇒ 必须用视口 `@media`。写错的症状与 1 一模一样：静默不生效。
 *  3. **`data-has-session` 与 CSS 是一对**。JSX 少写这个属性、或 CSS 少写那两条开关，
 *     手机上就是「点了会话没反应」或「返回列表后消息流还盖在上面」，桌面端看不出任何异常。
 *  4. **消息流在手机档是隐藏，不是卸载**。`display: none` 保留了虚拟化列表的挂载与滚动位置；
 *     若改成条件渲染（`curSession !== null && <div className={messages}>`），每次进出会话都要
 *     重取一页、丢掉滚动位置，而"少挂载一个组件"不会让任何测试变红。
 *  5. **返回按钮必须是 `closeCurrentSession`**，不是随手一个 `setCurSession(null)`：前者还会把
 *     归属令牌（sessionEpoch）作废，否则切换公众号/服务号/客服这三个互斥类目后，
 *     右侧会留着上一个类目的会话 —— 就是「别人的信息出现在这个界面」。
 *  6. **菜单在手机档是贴底 sheet**：`left` / `top` 是内联 style（桌面端「点哪儿出哪儿」），
 *     不用 `!important` 压不掉（与 M4 抽屉同一条教训）；而按 34px/条估的高度在 44px 触摸目标下
 *     会**估小**，菜单溢出屏幕底部、最后几项点不到 —— 贴底 + dvh 上界把这笔账整个绕开。
 *
 * 长按本身的**行为**（阈值、位移取消、鼠标不触发、抬手 preventDefault）在
 * `chats-msg-row.spec.ts` 里用 jsdom + 假定时器逐条跑；这一份只管「接线与 CSS 档位」。
 *
 * @vitest-environment node
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, atRuleBlock, classBlock, jsxCall, readStripped, readText, sliceBetween } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const read = (name: string): string => readText(join(HERE, name))

/** 手机档的 at-rule 头（与 `ui/use-media-query.ts#PHONE_QUERY` 同一个数）。 */
const PHONE = '@media (max-width: 560px)'
/** 消息列自己那档容器查询（只管后代，见头注第 2 条）。 */
const CONTAINER = '@container (max-width: 560px)'

const view = readStripped(join(HERE, 'chats-view.tsx'))
const panel = readStripped(join(HERE, 'Chats.tsx'))
const headActions = readStripped(join(HERE, 'chats-head-actions.tsx'))
const msgRow = readStripped(join(HERE, 'chats-msg-row.tsx'))
const rowsCss = read('chats-rows.module.css')
const cardsCss = read('chats-cards.module.css')
const shellCss = read('chats-shell.module.css')

const phoneRows = atRuleBlock(rowsCss, PHONE)
const phoneCards = atRuleBlock(cardsCss, PHONE)
const phoneShell = atRuleBlock(shellCss, PHONE)

describe('单栏栈：JSX 与 CSS 必须成对', () => {
  it('哨兵：三份 CSS 与四份 TSX 都真读到了、手机档不是空的', () => {
    for (const [name, src] of [['chats-view.tsx', view], ['Chats.tsx', panel], ['chats-head-actions.tsx', headActions], ['chats-msg-row.tsx', msgRow]] as const) {
      atLeast(src.length, 2000, `${name} 读到的内容`)
    }
    atLeast(phoneRows.length, 40, 'chats-rows 的手机档')
    atLeast(phoneCards.length, 40, 'chats-cards 的手机档')
    atLeast(phoneShell.length, 40, 'chats-shell 的手机档')
  })

  it('根 div 上写了 data-has-session（CSS 那两条开关全靠它；漏写就是「点了会话没反应」）', () => {
    const root = sliceBetween(view, '<div className={cssrows.panel}', '>', 'panel 根 div')
    expect(root, '根 div 上没有 data-has-session ⇒ 手机档的显隐开关没有信号源')
      .toContain('data-has-session={curSession !== null || undefined}')
    expect(root, '切栏信号必须与 data-ai-full 一样是「有值才写属性」（false 会被渲染成字符串）')
      .toContain('data-ai-full=')
  })

  it('两份 CSS 各读一次同一个属性：列表让位、消息流上场', () => {
    expect(phoneCards, '开会话后列表没有让位 ⇒ 手机上两栏挤在 375px 里')
      .toContain('[data-has-session] .sidebar { display: none; }')
    expect(phoneRows, '开会话后消息流没有出现 ⇒ 「点了会话没反应」')
      .toContain('[data-has-session] .messages { display: flex; }')
    expect(phoneRows, '没开会话时消息流没有隐藏 ⇒ 手机上会看到一块空的「从左侧选择一个会话」')
      .toContain('.messages { display: none;')
    expect(phoneCards, '会话列表没有占满整栏（桌面那 304px 在 375px 上会挤掉消息流）')
      .toContain('.sidebar { width: 100%;')
    expect(phoneRows, '三栏没有改成竖排（右栏那块 AI/分析面板在 375px 上会挤到消息流旁边）')
      .toContain('.panel { flex-direction: column;')
  })

  it('跨栏开关必须是**纯属性选择器**：把 .panel / .sidebar 写进对方那份就是死 CSS', () => {
    expect(phoneCards, 'chats-cards 的手机档里出现了 .panel —— 它住在 chats-rows 那份，hash 不同 ⇒ 选不中')
      .not.toContain('.panel')
    expect(phoneRows, 'chats-rows 的手机档里出现了 .sidebar —— 它住在 chats-cards 那份，hash 不同 ⇒ 选不中')
      .not.toContain('.sidebar')
    // 反向哨兵：上面两条 not.toContain 只有在「块里确实有内容」时才有意义
    expect(phoneCards, '手机档空了 ⇒ 上面两条 not.toContain 是假绿').toContain('[data-has-session]')
    expect(phoneRows, '手机档空了 ⇒ 上面两条 not.toContain 是假绿').toContain('[data-has-session]')
  })

  it('三栏重排走视口 @media，不是 @container（容器查询选不到容器自己）', () => {
    // 前提哨兵：消息列仍然是容器查询的宿主（这条没了，下面那条就失去意义）
    expect(classBlock(rowsCss, 'messages'), '.messages 不再是容器宿主 ⇒ 本条判据的前提变了，请重新核对')
      .toContain('container-type: inline-size')
    const container = atRuleBlock(rowsCss, CONTAINER)
    expect(container, '把三栏重排写进了 @container ⇒ 静默不生效（症状与跨份选择器一样）')
      .not.toContain('.panel')
    expect(phoneRows, '手机档的三栏重排不在视口 @media 里').toContain('flex-direction')
  })
})

describe('消息流在手机档是**隐藏**，不是卸载', () => {
  it('虚拟化列表始终挂在 JSX 里（条件渲染掉就会每次进出会话都重取一页、丢滚动位置）', () => {
    const messagesCol = sliceBetween(view, '<div className={cssrows.messages}>', '<ChatsGroupInfoView', '消息列')
    expect(messagesCol, '消息列里没有虚拟化列表 ⇒ 这一格被搬走或改写了，请重新核对本判据')
      .toContain('msgVirtualizer.getVirtualItems()')
    expect(messagesCol, '消息列的总高度撑开没了（长列表会退化成一次性渲染）')
      .toContain('msgVirtualizer.getTotalSize()')
    // 从根 div 到消息列之间不许出现「有会话才渲染」的条件：手机档靠 CSS 显隐，
    // 一旦改成条件渲染，进出会话就会重挂载虚拟化列表（重取一页 + 丢滚动位置）。
    const beforeMessages = sliceBetween(view, '<div className={cssrows.panel}', '<div className={cssrows.messages}>', '根 div → 消息列')
    expect(beforeMessages, '消息列（或它前面的会话列表）被改成了条件渲染 ⇒ 手机上进出会话会丢虚拟化状态')
      .not.toContain('curSession !== null &&')
    expect(phoneRows, '手机档不是用 display:none 隐藏消息列').toContain('display: none')
  })
})

describe('返回按钮：只在手机档出现，且接的是 closeCurrentSession', () => {
  it('基础态 display:none，手机档才出现（桌面三栏并排，「返回」不成立）', () => {
    expect(classBlock(shellCss, 'msgBackBtn'), '返回按钮在桌面端也显示 ⇒ 三栏并排时它是个死按钮')
      .toContain('display: none')
    expect(phoneShell, '手机档没有把返回按钮放出来').toContain('.msgBackBtn')
    expect(phoneShell, '返回按钮在手机档没有显示出来').toContain('display: inline-flex')
    expect(phoneShell, '返回按钮没有绝对定位到左上角（会和居中标题叠在一起）').toContain('position: absolute')
  })

  it('手机档头部改成「返回 + 左对齐标题 + 动作换行」（375px 上一行放不下）', () => {
    expect(phoneShell, '标题没有左对齐 ⇒ 与返回按钮叠在一起').toContain('text-align: left')
    expect(phoneShell, '标题没有给返回按钮让位（padding-left）').toContain('padding-left')
    expect(phoneShell, '动作排没有整行换到第二行 ⇒ 六个按钮会把标题挤出屏幕')
      .toContain('.msgHeaderActions { flex: 1 1 100%;')
  })

  it('按钮由 onBackToList 守卫：不给就不画（这一份不在函数行数棘轮上，所以按钮住这里）', () => {
    expect(headActions, '返回按钮没有「不给回调就不画」的守卫').toContain('{onBackToList && (')
    expect(headActions, '按钮没有可访问名（纯图标按钮必须有 aria-label）').toContain('aria-label="返回会话列表"')
    expect(headActions, '按钮没有接上回调').toContain('onClick={onBackToList}')
    expect(headActions, 'props 里没有 onBackToList（可选：桌面端不传就不画）').toContain('onBackToList?: () => void')
  })

  it('桌面档标题留在文档流（2026-10-14 实测：绝对居中与动作排必然重叠约 57px）', () => {
    expect(classBlock(shellCss, 'msgHeaderInfo'), '标题又变成绝对定位 ⇒ 与动作排重叠（量过的几何不成立）')
      .toContain('flex: 1')
    expect(classBlock(shellCss, 'msgHeaderInfo'), '标题不该是绝对居中').not.toContain('position: absolute')
  })

  it('一路接到面板的 closeCurrentSession —— 不是随手一个 setCurSession(null)', () => {
    expect(jsxCall(view, 'ChatsHeadActions', '头部动作排'), '渲染树没把 onBackToList 透传下去')
      .toContain('onBackToList={onBackToList}')
    expect(jsxCall(panel, 'ChatsView', 'ChatsView 调用点'), '面板没把关闭会话的回调交给渲染树')
      .toContain('onBackToList={closeCurrentSession}')
    // 为什么必须是它：这个回调还作废归属令牌，否则切类目后右侧留着上一个类目的会话
    const closer = sliceBetween(panel, 'const closeCurrentSession', 'watermarkRef.current = 0', 'closeCurrentSession')
    expect(closer, 'closeCurrentSession 不再作废归属令牌 ⇒ 返回按钮会把「别人的会话」留在屏幕上')
      .toContain('sessionEpochRef.current += 1')
  })
})

describe('长按菜单：手机档是贴底 sheet，且与右键共用同一个入口', () => {
  it('left/top 是内联 style ⇒ 覆盖必须带 !important（压不住就白写，与 M4 抽屉同一条教训）', () => {
    expect(phoneCards, '菜单没有贴到左边（内联 left 压不掉 ⇒ 手机上菜单出在手指底下）')
      .toContain('left: 8px !important')
    expect(phoneCards, '没有把内联 top 作废 ⇒ 靠下长按时菜单会溢出屏幕底部')
      .toContain('top: auto !important')
    expect(phoneCards, '没有贴底').toContain('bottom:')
    expect(phoneCards, '高度上界没有用 dvh（键盘顶起时 100vh 那套会把菜单顶出屏幕）').toContain('dvh')
    expect(phoneCards, '菜单项低于 44px 的触摸目标下限').toContain('min-height: 44px')
  })

  it('长按只在非鼠标上启动（桌面端保留右键这一套口径）', () => {
    for (const h of ['onPointerDown', 'onPointerMove', 'onPointerUp', 'onPointerCancel']) {
      expect(msgRow, `消息行没有 ${h} ⇒ 长按会在滚动/系统手势下误弹或弹不出来`).toContain(h)
    }
    expect(msgRow, '没有排除鼠标 ⇒ 桌面端会同时有右键与长按两套手势').toContain("ev.pointerType === 'mouse'")
    expect(msgRow, '没有位移阈值 ⇒ 滚消息列表时每一下都弹菜单').toContain('LONG_PRESS_SLOP_PX')
  })

  it('两个入口共用 MsgMenuAnchor（长按那一侧不伪造 MouseEvent）', () => {
    expect(msgRow, '长按入口自己造了一套签名').toContain('openMsgMenu: (ev: MsgMenuAnchor')
    expect(readStripped(join(HERE, 'chats-thread.tsx')), 'useChatsThread 的入参类型没跟上')
      .toContain('openMsgMenu: (ev: MsgMenuAnchor')
    expect(panel, '面板那头的 openMsgMenu 没跟上（右键与长按会分成两个入口）')
      .toContain('const openMsgMenu = useCallback((ev: MsgMenuAnchor')
  })
})
