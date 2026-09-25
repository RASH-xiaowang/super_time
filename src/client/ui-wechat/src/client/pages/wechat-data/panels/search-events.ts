
/**
 * 「把某个词送进全局搜索」事件（词云等分析面板 → WechatDataPanel 顶栏搜索，R11）。
 *
 * 与 `notes-events.ts` 同一套 window 事件面：面板之间不引全局状态库 ——
 * 派发方（词云）只管喊一声，订阅方（唯一：WechatDataPanel）负责开导航条、聚焦输入框、
 * 种入关键词，剩下交给既有的 debounce 搜索 effect（它只认 `searchQuery` 的变化）。
 *
 * 为什么不给词云传 `onNavigate` 回调：词云挂在三个不同面板里（群聊分析/朋友圈洞察/总览），
 * 逐层把回调穿过面板到 WechatDataPanel 要改四处签名；而「按词搜索」是全局动作、
 * 与挂载点无关，事件总线是形态最轻的那个解。接线由 `wordcloud.wiring.spec.ts` 钉住。
 */

/** 事件名。派发到 window，与宿主/笔记事件同一订阅面。 */
export const SEARCH_QUERY_EVENT = 'dsh-wechat-search-query'

/** 广播「查这个词」。空串忽略（开了搜索却什么都不查没有意义）。 */
export function openGlobalSearch(query: string): void {
  if (typeof window === 'undefined') return
  const q = query.trim()
  if (!q) return
  window.dispatchEvent(new CustomEvent(SEARCH_QUERY_EVENT, { detail: { query: q } }))
}

/** 订阅侧读 detail 的类型守卫（`CustomEvent.detail` 是 any，不能让任意值泄进 state）。 */
export function searchQueryFromEvent(e: Event): string | null {
  const d = (e as CustomEvent<{ query?: unknown }>).detail
  const q = d && typeof d.query === 'string' ? d.query.trim() : ''
  return q || null
}
