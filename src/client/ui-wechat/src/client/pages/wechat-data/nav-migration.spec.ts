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

  it('主题切换与数据状态都落在 `</aside>` 之内（落在外面就说明写错了层）', () => {
    expect(aside).toContain('css.navFooterRow')
    expect(aside).toContain('css.themeToggle')
    expect(aside).toContain('css.apiTag')
    expect(aside).toContain('data-theme-toggle')
    // 两个都在底部固定区这一个容器里
    const footer = aside.match(/css\.navFooterRow[\s\S]*?<\/div>/)?.[0] ?? ''
    expect(footer).toContain('css.themeToggle')
    expect(footer).toContain('css.apiTag')
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

  it('状态文案：收起态只留状态点，展开态显示文字', () => {
    expect(rule('.apiTagText'), '基线（收起态）应隐藏状态文案').toMatch(/display:\s*none/)
    expect(rule('.sidebar[data-open] .apiTagText'), '展开态应显示状态文案').toMatch(/display:\s*inline/)
  })

  it('底部固定区：收起态纵向堆叠（42px 放不下一行），展开态改回一行', () => {
    expect(rule('.navFooterRow'), '基线（收起态）应纵向堆叠').toMatch(/flex-direction:\s*column/)
    expect(rule('.sidebar[data-open] .navFooterRow'), '展开态应为一行').toMatch(/flex-direction:\s*row/)
  })

  it('底部固定区自带下内边距（`.sidebar` 的 padding-bottom 是 0，不补就贴窗口下沿）', () => {
    expect(rule('.navFooterRow')).toMatch(/padding:\s*8px 0 10px/)
    expect(rule('.sidebar[data-open] .navFooterRow')).toMatch(/padding:\s*8px 6px 10px/)
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
