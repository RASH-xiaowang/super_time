/**
 * 变异登记 · **手机端外壳**（2026-10-14，M544 起）。
 *
 * 手机外壳的失效方式很特别：它**只在窄视口上出现**，而仓库的回归测试全跑在桌面尺寸 ——
 * 所以这里每一条都必须有「窄视口」的判据去咬，否则改了就是静默的。
 *
 *   M544 底部栏在桌面也渲染 ⇒ 桌面窗口底边多出一条 48px 的栏，盖住内容、像界面坏了；
 *   M545 从「更多」里选完不关 sheet ⇒ sheet 盖在新页面上，用户看到「点了没反应」；
 *   M546 侧栏不再只留搜索框 ⇒ 手机上要么整块侧栏回来（375px 放不下），
 *        要么搜索框跟着一起没了（全局搜索在手机上彻底不可达）。
 *
 * @module mutations-registry/batch3v
 */
export const MUTATIONS_BATCH3V = [
  {
    id: 'M544-mobile-bar-on-desktop',
    why: 'MobileNavHost 的窄视口判定失效 ⇒ 桌面窗口里也渲染出底部标签栏（48px 高、fixed 在底边），盖住内容且与侧栏导航重复。判据：mobile-nav.spec.ts 的「不匹配手机档时什么都不渲染」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/ui/mobile-nav.tsx',
    from: '  if (!isPhone) return <React.Fragment />',
    to: '  if (false) return <React.Fragment />',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/ui/mobile-nav.spec.ts',
  },
  {
    id: 'M545-sheet-stays-open-after-pick',
    why: '从「更多」sheet 里选完 tab 不关 sheet ⇒ sheet 盖在新页面上，用户的体感是「点了没反应」，只能再点一次遮罩。判据：mobile-nav.spec.ts 的「打开后每个桌面可见 tab 都在里面，且点它会选中并关 sheet」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/ui/mobile-nav.tsx',
    from: '    onSelect(tab)',
    to: '    if (false) onSelect(tab)',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/ui/mobile-nav.spec.ts',
  },
  {
    id: 'M546-sidebar-search-strip-broken',
    why: '手机档不再「侧栏只留搜索框」⇒ 要么整块侧栏回来（375px 上占掉大半屏），要么搜索框被一起藏掉（全局搜索在手机上彻底不可达 —— 它只住在侧栏里）。判据：mobile-shell.spec.ts 的「侧栏塌成顶部搜索条，而不是整块隐藏」。',
    file: 'src/client/ui-wechat/src/client/pages/wechat-data/wechat-data.module.css',
    from: '  .sidebar > *:not(.navSearch) { display: none; }',
    to: '  .sidebar > *:not(.navSearch) { display: block; }',
    spec: 'src/client/ui-wechat/src/client/pages/wechat-data/ui/mobile-shell.spec.ts',
  },
]
