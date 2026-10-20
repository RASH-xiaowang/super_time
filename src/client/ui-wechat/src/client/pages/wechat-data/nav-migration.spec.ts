/**
 * 「顶栏四件事迁进导航栏」的接线守卫。
 *
 * 背景：顶栏那条 54px 横条只服务四件事 —— 品牌 / 全局搜索 / 主题 / 数据状态。它永久占掉
 * 首屏高度，于是四件事全部下移到常驻的左侧导航栏：
 *   · 品牌 + 搜索在导航栏顶部；
 *   · 主题切换 + 数据状态在导航栏底部固定区（与「设置」同属全局动作）。
 *
 * 为什么值得源码级锁：这类「搬家」有两个静默失败模式，界面全绿也看不出来 ——
 *   ① 搬了一半：新位置渲染了，旧顶栏没删 → 首屏高度白占一份，且主题按钮出现两个；
 *   ② 落错层：元素写在了 `</aside>` 外面（本轮真实发生过一次），导航栏收起时它不跟着动，
 *      看起来「在导航栏里」但其实是 `.body` 的直接子元素，布局语义全错。
 * 仓库没有 DOM 环境（M13/M14 的既定结论），所以用源码切片 + 样式断言来钉这两点。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根（`HERE` = src/client/ui-wechat/src/client/pages/wechat-data，上 7 层）。 */
const ROOT = join(HERE, '..', '..', '..', '..', '..', '..', '..')

/** 读源码并去掉注释 —— 注释里为「记录历史」提到旧类名会让断言误判。 */
function codeOf(file: string): string {
  const src = readFileSync(join(HERE, file), 'utf8')
  return src.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(l => l.replace(/\/\/.*$/, '')).join('\n')
}

const panel = codeOf('WechatDataPanel.tsx')
const css = readFileSync(join(HERE, 'wechat-data.module.css'), 'utf8')

/** 导航栏（`<aside class="sidebar">`）那一段 JSX —— 迁入的元素必须落在这个区间里。 */
const aside = panel.match(/<aside[\s\S]*?<\/aside>/)?.[0] ?? ''

describe('顶栏已取消：四件事全部迁入导航栏', () => {
  it('导航栏区间能被切出来（切不到说明结构变了，下面的断言会变成空转）', () => {
    expect(aside).toContain('css.sidebar')
    expect(aside.length).toBeGreaterThan(500)
  })

  /**
   * 侧栏**默认展开**（2026-09-30 用户要求「主界面的导航栏默认为展开」）。
   *
   * 为什么值得一条离线判据：这是**初值**，改回 false 不会有任何类型/构建错误，
   * 症状只是「新用户进来只看到一排图标」。真机几何由 `scripts/nav-shell-e2e.mjs` 验收
   * （默认 176px → 点一下 58px → 再展开），这里守的是「初值没被改回去 + 没有偷偷加持久化」。
   */
  it('navOpen 初值是展开（true），且不做持久化（交给 e2e 量几何）', () => {
    expect(panel, 'navOpen 的初值又被改回收起态了').toMatch(/useState\(true\)[\s\S]{0,40}?navOpen|navOpen[\s\S]{0,40}?useState\(true\)/)
    expect(panel, 'navOpen 不该被持久化：没有记忆就不会「上次收起、这次还收起」')
      .not.toMatch(/localStorage[\s\S]{0,80}navOpen|navOpen[\s\S]{0,80}localStorage/)
  })

  it('品牌在导航栏内，且用的是导航栏版类名（不是顶栏遗留）', () => {
    expect(aside).toContain('css.navBrand')
    expect(aside).toContain('css.navBrandLogo')
    expect(aside).toContain('css.navBrandName')
    // 顶栏那套已删干净：类名留着就有第二套样式在等被误用
    expect(panel).not.toContain('css.topbar')
    expect(panel).not.toContain('css.topbarBrand')
    expect(css).not.toContain('.topbar {')
    expect(css).not.toContain('.topbarSearch')
  })

  it('全局搜索在导航栏内，且走 Portal 版组件（`overflow: hidden` 会裁掉绝对定位的下拉）', () => {
    expect(panel).toContain("from './panels/global-search.tsx'")
    expect(aside).toContain('<GlobalSearch')
    expect(aside).toContain('css.navSearch')
    // 结果面板必须是 Portal：组件源码里得有 createPortal 到 body
    const gs = readFileSync(join(HERE, 'panels', 'global-search.tsx'), 'utf8')
    expect(gs).toContain('createPortal')
    expect(gs).toContain('document.body')
  })

  it('结果面板不得用全屏透明遮罩关闭（会吃掉整个界面的第一次点击）', () => {
    // 真实浏览器实测过的缺陷：`position: fixed; inset: 0` 的遮罩盖住侧栏，
    // 面板开着时点「收起导航」只会关面板、导航不动，必须点第二次。
    // 现在改为 document 上的 mousedown（capture）判外部点击。
    const gs = readFileSync(join(HERE, 'panels', 'global-search.tsx'), 'utf8')
    const gsCss = readFileSync(join(HERE, 'panels', 'global-search.module.css'), 'utf8')
    expect(gs).toContain("document.addEventListener('mousedown'")
    expect(gs).not.toContain('css.overlay')
    // 样式里也不许再留 `inset: 0` 的覆盖层规则
    expect(gsCss).not.toMatch(/\.overlay\s*\{[^}]*inset:\s*0/)
  })

  /**
   * 2026-09-30：底部固定区（设置 / 模型余额 / 数据状态）拆成了 `SidebarFooter`。
   * 判据跟着搬，**但强度不变**：aside 里必须**渲染**这个组件。
   *
   * ⚠️ 2026-10-17：**三块全部迁到标题栏右上角**（窗口控制按钮前）——
   * 主题切换（与最小化/全屏/关闭同属「全局动作」）、模型余额 + 数据就绪
   * （描述的是整个应用的状态，不是当前页签的内容）。
   * 所以侧栏底部固定区**只剩「设置」**，这里改为断言「三块都不在侧栏」
   * （防止有人又加回来变成两处）。
   */
  it('侧栏底部固定区只剩「设置」；余额/状态/主题**都不在**侧栏（已迁到标题栏）', () => {
    expect(aside, 'aside 里没渲染底部固定区组件').toContain('<SidebarFooter')
    const footerFn = panel.slice(panel.indexOf('function SidebarFooter('), panel.indexOf('export function WechatDataPanel'))
    expect(footerFn.length, '切不出 SidebarFooter 的函数体 ⇒ 下面的断言会空转').toBeGreaterThan(200)
    expect(footerFn).toContain('css.sidebarFooter')
    expect(footerFn).toContain('设置')
    // 三块都已迁走：侧栏里**不许**再有它们（两处会分叉）。
    expect(footerFn, '主题按钮又回到侧栏了（已迁到标题栏右上角）').not.toContain('css.themeToggle')
    expect(footerFn, '主题按钮又回到侧栏了（已迁到标题栏右上角）').not.toContain('data-theme-toggle')
    expect(footerFn, '模型余额又回到侧栏了（已迁到标题栏右上角）').not.toContain('<SidebarBalance')
    expect(footerFn, '数据状态又回到侧栏了（已迁到标题栏右上角）').not.toContain('css.apiTag')
    expect(footerFn, '数据状态又回到侧栏了（已迁到标题栏右上角）').not.toContain('css.navFooterRow')
  })

  it('主题按钮在标题栏（`index.html` 的 `#tb-theme`，窗口控制按钮之前）', () => {
    // 迁到标题栏后，判据跟着搬：按钮必须在 `#tb-controls` 里、且在 `#tb-min` **之前**。
    const html = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'index.html'), 'utf8')
    expect(html, '标题栏里没有主题按钮').toContain('id="tb-theme"')
    const controls = html.slice(html.indexOf('class="tb-controls"'), html.indexOf('id="tb-close"'))
    expect(controls, '主题按钮不在 tb-controls 里').toContain('id="tb-theme"')
    expect(
      controls.indexOf('id="tb-theme"') < controls.indexOf('id="tb-min"'),
      '主题按钮必须在最小化按钮**之前**（用户要求「迁移到右上角这三个按钮前」）',
    ).toBe(true)
    // 宿主侧要真的接上（只放个按钮不接线 = 死控件）。
    const entry = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'ui-entry.tsx'), 'utf8')
    expect(entry, '宿主没给主题按钮接线').toContain("byId('tb-theme')")
    expect(entry, '宿主没调 toggleThemeMode').toContain('toggleThemeMode()')
    expect(entry, '宿主没订阅主题变化（别处改了图标不同步）').toContain('subscribeThemeMode(syncTheme)')
  })

  it('模型余额与数据状态在标题栏（`#tb-status` 容器 + 独立 React root）', () => {
    // 两块都是 React 组件（余额要轮询、状态要订阅），而标题栏是静态 HTML ⇒
    // 宿主给 `#tb-status` 挂一个独立 root。
    const html = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'index.html'), 'utf8')
    expect(html, '标题栏里没有状态容器').toContain('id="tb-status"')
    const controls = html.slice(html.indexOf('class="tb-controls"'), html.indexOf('id="tb-close"'))
    expect(controls, '状态容器不在 tb-controls 里').toContain('id="tb-status"')
    expect(
      controls.indexOf('id="tb-status"') < controls.indexOf('id="tb-theme"'),
      '状态区应在主题按钮**之前**（状态在左、动作在右）',
    ).toBe(true)
    // 宿主侧：挂载函数 + 组件 + 状态订阅都要真的接上。
    const entry = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'ui-entry.tsx'), 'utf8')
    expect(entry, '宿主没挂载标题栏状态区').toContain('mountTitlebarStatus()')
    const status = readFileSync(join(ROOT, 'src', 'client', 'ui-app', 'titlebar-status.tsx'), 'utf8')
    expect(status, '状态区没渲染余额').toContain('<SidebarBalance')
    expect(status, '状态区没渲染数据状态').toContain('subscribeApiStatus')
    expect(status, '状态区没挂到 #tb-status').toContain("getElementById('tb-status')")
  })

  it('顶栏折叠条（FoldableBar）不再被主面板使用', () => {
    expect(panel).not.toContain('<FoldableBar')
    expect(panel).not.toContain('FoldableBarHandle')
    expect(panel).not.toContain('topbarFoldRef')
  })
})

describe('收起态（58px 轨）不能出现半截元素', () => {
  /**
   * 口径：基线规则 = **收起态**（58px），`.sidebar[data-open]` 覆盖 = **展开态**（176px）。
   * `data-open` 表示导航「已展开」（宽度规则就是这么写的），所以「收起时隐藏」必须落在
   * **不带 data-open 的那条**上。本轮实现一度写反（把隐藏写进了 data-open 分支）：
   * 结果是展开时搜索框消失、收起时反而挤在 42px 轨道里 —— 纯靠肉眼看样式很难发现，
   * 所以这里逐条按语义断言，而不是只断言「某条规则里有个 display: none」。
   */
  const rule = (selector: string): string => {
    const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}')
    return re.exec(css)?.[1] ?? ''
  }

  it('搜索框：收起态整块不显示，展开态才显示', () => {
    expect(rule('.navSearch'), '基线（收起态）应隐藏搜索框').toMatch(/display:\s*none/)
    expect(rule('.sidebar[data-open] .navSearch'), '展开态应显示搜索框').toMatch(/display:\s*block/)
  })

  it('品牌文字：收起态擦除，展开态露出', () => {
    expect(rule('.navBrandText'), '基线（收起态）应把文字收掉').toMatch(/max-width:\s*0/)
    expect(rule('.sidebar[data-open] .navBrandText'), '展开态应露出文字').toMatch(/max-width:\s*120px/)
  })

  /**
   * ⚠️ 2026-10-17：状态文案 / 底部固定区 / 主题按钮**全部迁到标题栏**，
   * 侧栏里已无这些规则 —— 所以这里改为断言「这些类名在侧栏 CSS 里已退役」
   * （防止有人把旧规则又加回来，与标题栏那套分叉）。
   */
  it('已迁走的类名在侧栏 CSS 里退役（状态文案 / 底部固定区 / 主题按钮）', () => {
    expect(css, '状态文案类名又回到侧栏 CSS 了（已迁到标题栏）').not.toContain('.apiTagText')
    expect(css, '底部固定区类名又回到侧栏 CSS 了（已迁到标题栏）').not.toContain('.navFooterRow')
    expect(css, '主题按钮类名又回到侧栏 CSS 了（已迁到标题栏）').not.toContain('.themeToggle')
    expect(css, '状态胶囊类名又回到侧栏 CSS 了（已迁到标题栏）').not.toContain('.apiTag')
  })
})

describe('Ctrl+K 与展开态的联动', () => {
  it('快捷键先把导航展开再聚焦（收起态搜索框是 display:none，直接 focus 会静默失败）', () => {
    expect(panel).toMatch(/setNavOpen\(true\)[\s\S]{0,200}requestAnimationFrame[\s\S]{0,80}searchInputRef\.current\?\.focus\(\)/)
  })

  it('导航收起时一并关掉结果面板（否则会拿全零矩形定位，飘到左上角）', () => {
    expect(panel).toMatch(/if\s*\(!navOpen\)\s*setSearchOpen\(false\)/)
  })
})
