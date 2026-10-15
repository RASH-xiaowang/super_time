/**
 * 变异登记 · **手机端聊天页**（2026-10-14，M547 起）。
 *
 * 这一批的失效方式全都**只在窄视口 + 触摸上出现**，而仓库的回归测试跑在桌面尺寸、
 * 用鼠标事件 —— 所以每一条都得有专门的判据去咬，否则改了就是静默的。
 * 其中两条还是「构建/typecheck/既有守卫全绿」的死 CSS 型失效：
 *
 *   M547 跨栏开关写成 `.panel[data-has-session] .sidebar` ⇒ CSS Modules 按**文件**打 hash，
 *        `.panel` 住在另一份里 ⇒ 这条规则在手机上选不中任何东西（两栏挤在 375px 里），
 *        而拆分守卫只查「同名类跨份」与「引用悬空」，这两条它都不触犯；
 *   M548 根 div 少写 `data-has-session` ⇒ 开关没有信号源，症状是「点了会话没反应」；
 *   M549 长按没有位移阈值 ⇒ 滚消息列表时手指按住超过 500ms 就弹菜单（触摸滚动必然经过这个时长）；
 *   M550 菜单的 `top: auto` 少了 `!important` ⇒ 内联 style 赢，菜单回到手指那一档，
 *        而面板按 34px/条估高、手机档每条 44px ⇒ 靠下长按时最后几项被挤出屏幕、点不到；
 *   M551 注释收尾后混进字面量反斜杠 ⇒ 选择器编译成 `n._msgHeaderInfo_HASH`，规则永不匹配
 *        （**这一条是真出过的**：2026-10-12 写的「会话名居中」到 2026-10-14 才发现从来没生效过，
 *        因为类名照样导出、成品 CSS 里字面量照样在，既有守卫一条都看不见）；
 *   M552 返回按钮的基础态不再隐藏 ⇒ 桌面端三栏并排时也画出一枚「返回会话列表」；
 *   M553 头部居中的可行性门槛（消息列 ≥960px）被删 ⇒ 中宽窗口标题压动作排（重叠量过约 57px）。
 *
 * @module mutations-registry/batch3w
 */
export const MUTATIONS_BATCH3W = [
  {
    id: 'M547-cross-part-selector-is-dead-css',
    why: '跨栏开关写成 `.panel[data-has-session] .sidebar`：`.panel` 住在 chats-rows 那份里，CSS Modules 会给出另一个 hash ⇒ 手机上这条规则选不中任何元素（开会话后列表不让位、两栏挤在 375px 里），而构建、typecheck、拆分守卫①②全部绿。判据：chats-mobile.wiring.spec.ts 的「跨栏开关必须是纯属性选择器」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-cards.module.css',
    from: '  [data-has-session] .sidebar { display: none; }',
    to: '  .panel[data-has-session] .sidebar { display: none; }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-mobile.wiring.spec.ts',
  },
  {
    id: 'M548-stack-switch-loses-its-signal',
    why: '根 div 不再写 data-has-session ⇒ CSS 那两条开关没有信号源：手机上点了会话，消息流不出现、列表也不让位（体感是「点了没反应」），桌面端三栏照常、毫无异常。判据：chats-mobile.wiring.spec.ts 的「根 div 上写了 data-has-session」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-view.tsx',
    from: '    <div className={cssrows.panel} data-ai-full={(aiOpen && aiFull) || undefined} data-has-session={curSession !== null || undefined}>',
    to: '    <div className={cssrows.panel} data-ai-full={(aiOpen && aiFull) || undefined}>',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-mobile.wiring.spec.ts',
  },
  {
    id: 'M549-long-press-fires-while-scrolling',
    why: '长按的位移阈值失效 ⇒ 滚动消息列表时只要手指按住超过 500ms 就弹菜单（触摸滚动一定会经过这个时长），用户看到的是「一滑就弹菜单」；桌面端用鼠标，走的是 pointerType === mouse 的早退分支，永远看不到。判据：chats-msg-row.spec.ts 的「按住后移动超过 10px ⇒ 取消」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-msg-row.tsx',
    from: '          if (pressTimer !== null && Math.hypot(ev.clientX - pressX, ev.clientY - pressY) > LONG_PRESS_SLOP_PX) cancelLongPress()',
    to: '          if (false) cancelLongPress()',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-msg-row.spec.ts',
  },
  {
    id: 'M550-menu-keeps-finger-y-and-overflows',
    why: '菜单的 `top: auto` 少了 !important ⇒ 内联 style（桌面端「点哪儿出哪儿」的 top）赢回来，菜单不再贴底；而面板按 34px/条估高、手机档每条 44px（触摸目标下限）⇒ 估小约 10px/条，靠下长按时最后几项被挤出屏幕、点不到。判据：chats-mobile.wiring.spec.ts 的「left/top 是内联 style ⇒ 覆盖必须带 !important」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-cards.module.css',
    from: '    top: auto !important;',
    to: '    top: auto;',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-mobile.wiring.spec.ts',
  },
  {
    id: 'M551-selector-escape-eats-the-rule',
    why: '块注释收尾后混进字面量反斜杠 + n ⇒ 选择器编译成 `n._msgHeaderActions_HASH`（「`<n>` 元素且带该类」），整条规则永不匹配，而类名照样从 CSS Modules 导出、成品 CSS 里类名字面量照样在 ⇒ 拆分守卫与 check-wx-tokens 都绿。这一条是**真出过的事故**（2026-10-12 写在 `.msgHeaderInfo` 上的「会话名居中」到 2026-10-14 才发现从来没生效）；锚点选在 `.msgHeaderActions` 那一行，是因为 `.msgHeaderInfo {` 现在有基础档与手机档两处（锚点必须唯一），而坏法完全同形。判据：css-selector-escape.spec.ts 的「全仓 .css 的选择器与 at-rule 条件都是干净文本」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-shell.module.css',
    from: '.msgHeaderActions { display: flex; align-items: center; gap: 6px; min-width: 0; flex-shrink: 1; flex-wrap: wrap; }',
    to: '\\n.msgHeaderActions { display: flex; align-items: center; gap: 6px; min-width: 0; flex-shrink: 1; flex-wrap: wrap; }',
    spec: 'src/client/ui-wechat/src/client/css-selector-escape.spec.ts',
  },
  {
    id: 'M552-back-button-on-desktop',
    why: '返回按钮的基础态不再 display:none ⇒ 桌面端三栏并排时也画出一枚「返回会话列表」，而桌面上这个动作不成立（点它会关掉当前会话、右侧变回空态），头部还因此多出一个绝对定位的元素压在标题上。判据：chats-mobile.wiring.spec.ts 的「基础态 display:none，手机档才出现」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-shell.module.css',
    from: '.msgBackBtn { display: none; }',
    to: '.msgBackBtn { display: inline-flex; }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-mobile.wiring.spec.ts',
  },
  {
    id: 'M553-centering-gate-removed',
    why: '把「标题绝对居中」的可行性门槛（消息列 ≥960px）删掉 ⇒ 居中回到无条件：中宽窗口（如 1280px，消息列约 740px）下居中标题与约 350px 宽的动作排**必然重叠约 57px**，标题 z-index 更高、压在按钮上。门槛的数是量出来的（2×350 动作排 + 240 标题上界 ≈ 940），改它必须是有意识的动作。判据：chats-wx-geometry.wiring.spec.ts 的 ④（atRuleBlock 找不到这个门槛头会直接红）。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-shell.module.css',
    from: '@container (min-width: 960px) {',
    to: '@container (min-width: 0px) {',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/chats-wx-geometry.wiring.spec.ts',
  },
  {
    id: 'M554-overview-bar-denominator-back-to-first-item',
    why: '存储构成长条的分母变回「原数组第 0 项」：后端按条数排序、渲染前重排的只是副本，分母读的原数组第 0 项未必最大 —— 真实数据里实测填充宽度算到 1297%（4216px 塞进 325px 的槽被裁掉），界面上只是「每条都顶满」、比例信息整个丢失，且不报任何错。打桩数据第 0 项恰是最大，永远看不见。判据：overview-bars-max-denominator.wiring.spec.ts。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/overview-panel.tsx',
    from: 'Math.max(1, ...data.storage.categories.map(x => x.size))',
    to: 'Math.max(1, data.storage.categories[0]?.size ?? 1)',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/overview-bars-max-denominator.wiring.spec.ts',
  },
  {
    id: 'M555-overview-plates-stay-four-across-on-phone',
    why: '核心资产八格在手机上退回四列：每格约 80px，真实值「2,359」「11.97 GB」被裁成「2,3…」「11.…」(实测 plateValue scrollWidth > clientWidth)。桌面尺寸一个像素都不变，只有 375px × 真数据才露出来。判据：m6-phone.wiring.spec.ts。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/overview-neon.module.css',
    from: '  .heroStats { grid-template-columns: repeat(2, minmax(0, 1fr)); }',
    to: '  .heroStats { grid-template-columns: repeat(4, minmax(0, 1fr)); }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/m6-phone.wiring.spec.ts',
  },
  {
    id: 'M556-annual-card-extra-stays-nowrap',
    why: '年报卡片头的补充说明（「全年活跃 206 天 · 最高一天 75 条」）在窄卡里回到 nowrap：实测 174px 的文字塞进 38px 宽的格子，只剩一个省略号，一半信息没了。判据：m6-phone.wiring.spec.ts。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/annual.module.css',
    from: '  .cardExtra { flex-basis: 100%; text-align: left; white-space: normal; }',
    to: '  .cardExtra { flex-basis: 100%; text-align: left; white-space: nowrap; }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/m6-phone.wiring.spec.ts',
  },
  {
    id: 'M557-annual-single-column-span-neutralizer-too-weak',
    why: '年报 ≤900 单列档的跨度中和退回 `.board > *`：它与 ≤1400 档的 `.board > .card { span 2 }` 都带 !important，比的是特异性（0,1,0 < 0,2,0）⇒ 单列网格里被 span 2/3/6 撑出 6 条隐式列，卡片压到 85px、卡内 hero/主演格全被压成 0 宽（2026-10-14 真数据实测：heroCellV clientWidth 0）。窄于 900px 的桌面窗口同样坏。判据：m6-phone.wiring.spec.ts。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/annual.module.css',
    from: '  .board > .card, .board > .moreCard, .board > .span6, .board > .portrait, .board > .footer { grid-column: 1 / -1 !important; }',
    to: '  .board > * { grid-column: 1 / -1 !important; }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/m6-phone.wiring.spec.ts',
  },
  {
    id: 'M558-annual-more-cells-stay-seven-across',
    why: '「还有这些人」芯片在手机档退回 `flex: 1 1 0`：七格平分 333px 的一行、每格 47px，名字被裁到 23px（2026-10-14 真数据实测「南宁房东群95-零中介」只剩两个字符宽）。桌面档不受影响（这条只在 ≤380 容器档里）。判据：m6-phone.wiring.spec.ts。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/annual.module.css',
    from: '  .moreCell { flex: 1 1 45%; }',
    to: '  .moreCell { flex: 1 1 0; }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/panels/m6-phone.wiring.spec.ts',
  },
]
