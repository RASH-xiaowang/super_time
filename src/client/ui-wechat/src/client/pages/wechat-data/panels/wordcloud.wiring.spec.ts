/**
 * 词云（getWordCloud 三处落位 + 点击跳全局搜索 R11）的接线守卫。
 *
 * 为什么值得钉：
 *   ① 三处落位各接一个 scope（chat/moments/global）——scope 写错不会报错，
 *      只会「群里显示朋友圈热词」这种静默串台；
 *   ② 点击跳搜索是一次跨面板事件（词云 → WechatDataPanel），两端靠**同一个事件名常量**
 *      连接：任一端退回字符串字面量，改名时就会一端改一端忘，炸在运行时而不是构建期；
 *   ③ 订阅端要三步做齐（种词 / 开导航条 / 聚焦）——少任一步的表现是「点了没反应」，
 *      而「没反应」在自动测试里是最难发现的那类。
 * 源码锚点断言 + 先剥注释（本仓既有做法）；纯逻辑（searchQueryFromEvent）直接调用。
 * @vitest-environment node
 */
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SEARCH_QUERY_EVENT, openGlobalSearch, searchQueryFromEvent } from './search-events.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const read = (...p: string[]): string => readFileSync(join(HERE, ...p), 'utf8')

const card = read('WordCloudCard.tsx')
const groupInsights = read('GroupInsights.tsx')
const momentsInsights = read('MomentsInsights.tsx')
// M22 把词云卡拆进 `overview-sections.tsx#WordCloudSection`，读取面改成全部 overview* 源码的联合。
const overview = readdirSync(HERE)
  .filter((f) => /^overview(-[a-z]+)?\.(ts|tsx)$/.test(f))
  .sort()
  .map((f) => read(f))
  .join('\n')
const panel = strip(read('..', 'WechatDataPanel.tsx'))
/** 搜索事件订阅与 Ctrl+K 共用 `use-global-search` 状态机；守卫直接核订阅实现。 */
const searchState = strip(read('..', 'use-global-search.ts'))

describe('词云三处落位', () => {
  it('群聊分析页：scope=chat 且绑定当前选中的群（username 随选择器走）', () => {
    expect(groupInsights).toContain('<WordCloudCard scope="chat" username={data.username} fill />')
  })
  it('朋友圈洞察页：scope=moments，且卡片在画布里（2026-11-19 起不再用两行栅格）', () => {
    // 2026-10-17 曾用 `fill`：当时卡片高度由 `gridTop/gridBottom` 的固定行高决定，
    // `fill` 让舞台高度跟着卡片走。
    // 2026-11-19 改用等宽瀑布流画布后，卡片高度**反过来**由内容决定 ——
    // `fill` 是「量卡片根高度」反推舞台高度，而画布卡的高度又是量 `offsetHeight`
    // 得来的，两者互为因果（循环依赖）。所以画布场景必须用显式 `height`。
    const at = momentsInsights.indexOf('<WordCloudCard scope="moments"')
    expect(at, '找不到朋友圈词云').toBeGreaterThan(-1)
    const tag = momentsInsights.slice(at, momentsInsights.indexOf('/>', at))
    expect(tag).toContain('canvasId="moments-words"')
    expect(tag).toContain('height={320}')
    expect(tag, '画布场景不能用 fill（与卡片高度循环依赖）').not.toContain('fill')
  })
  it('数据总览：scope=global，且卡片在画布里（2026-11-19 起不再用 Bootstrap 栅格）', () => {
    expect(overview).toContain('<WordCloudCard scope="global"')
    // 总览卡片区改成等宽瀑布流画布后，词云和其他卡一样由画布排版（等宽、可拖动），
    // 不再需要 `col-12`。守的是它**带 canvasId**，即真的进了画布。
    const at = overview.indexOf('<WordCloudCard scope="global"')
    const before = overview.slice(Math.max(0, at - 200), at)
    expect(before.includes('canvasId="ov-wordcloud"'), '词云卡必须带 canvasId（真的进画布）').toBe(true)
    expect(before.includes('className="col-12"'), '词云卡还在用 Bootstrap 栅格').toBe(false)
  })
})

describe('词云点击跳全局搜索（R11）', () => {
  it('词元素是 button 且点击调 openGlobalSearch（键盘可达：60 个交互目标不能是裸 span）', () => {
    expect(card).toContain("import { openGlobalSearch } from './search-events.ts'")
    expect(card).toContain('openGlobalSearch(w.text)')
    expect(/<button[\s\S]{0,300}onClick=\{\(\) => \{ openGlobalSearch\(w\.text\) \}\}/.test(card)).toBe(true)
  })

  it('订阅端监听 SEARCH_QUERY_EVENT，且三步做齐（种词 / 开导航条 / rAF 聚焦）', () => {
    expect(searchState).toContain('SEARCH_QUERY_EVENT, searchQueryFromEvent')
    // 精确取「回调体」：从 onSearchQuery 声明到 addEventListener 之间。
    // 为什么不用「addEventListener 往前 N 字符」的窗口——变异测试实录：那个窗口把**邻近的
    // Ctrl+K effect** 里的 setNavOpen(true) 也圈进来了，删掉订阅里的那一步断言照样绿（假阳性）。
    const s = searchState.indexOf('const onSearchQuery = (event: Event)')
    const e = searchState.indexOf('window.addEventListener(SEARCH_QUERY_EVENT')
    expect(s, '找不到订阅回调 —— 改名后请同步本用例').toBeGreaterThan(-1)
    expect(e, '找不到事件监听 —— 改名后请同步本用例').toBeGreaterThan(s)
    const body = searchState.slice(s, e)
    expect(body.includes('setSearchQuery(query)'), '必须把词种进 searchQuery（debounce 搜索只认它）').toBe(true)
    expect(body.includes('setNavOpen(true)'), '必须开导航条（搜索框在里头，收起时被 display:none）').toBe(true)
    expect(body.includes('requestAnimationFrame'), '聚焦要等这一帧渲染出输入框（与 Ctrl+K 同款）').toBe(true)
    expect(body.includes('setSearchOpen(true)'), '必须打开结果面板（否则词搜了但看不到）').toBe(true)
  })

  it('事件名两端同源：都从 search-events.ts 导入，不许各写字符串字面量', () => {
    expect(card).not.toContain("'dsh-wechat-search-query'")
    expect(panel + searchState).not.toContain("'dsh-wechat-search-query'")
    expect(read('search-events.ts')).toContain("export const SEARCH_QUERY_EVENT = 'dsh-wechat-search-query'")
  })
})

describe('search-events 的纯逻辑', () => {
  it('searchQueryFromEvent：trim 取值、无 detail / 非字符串一律 null（不让任意值泄进 state）', () => {
    const ok = new CustomEvent(SEARCH_QUERY_EVENT, { detail: { query: '  项目  ' } })
    expect(searchQueryFromEvent(ok)).toBe('项目')
    expect(searchQueryFromEvent(new Event(SEARCH_QUERY_EVENT))).toBeNull()
    const bad = new CustomEvent(SEARCH_QUERY_EVENT, { detail: { query: 42 } })
    expect(searchQueryFromEvent(bad)).toBeNull()
    const blank = new CustomEvent(SEARCH_QUERY_EVENT, { detail: { query: '   ' } })
    expect(searchQueryFromEvent(blank)).toBeNull()
  })

  it('openGlobalSearch 在无 window 环境静默返回（SSR/node 下不抛）', () => {
    expect(() => { openGlobalSearch('项目') }).not.toThrow()
  })
})
