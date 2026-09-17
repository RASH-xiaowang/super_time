/**
 * 「非破坏性重新取数」的分页循环（纯逻辑，不依赖 React）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────
 * `usePagedList` 的后台刷新（`dsh-wechat-data-updated`，实时同步活跃期约每 10 秒一次）
 * 原先走 `reset()`，而 `reset()` 会**同步** `setItems([])`：列表瞬间被换成骨架屏，
 * 内容高度从「已加载的 N 条」塌到 12 行，浏览器随即把 `scrollTop` 钳到 0 ——
 * 用户往下翻之后会被反复**弹回列表顶部**。
 *
 * 修法是让后台刷新不碰当前列表内容，直到新数据到达才原位替换。但只重取第一页是不够的：
 * 列表会从 N 条缩回一页，高度骤降同样会把滚动位置钳掉。所以必须按**已加载条数**
 * （`want`）把同样的范围重新取一遍。
 *
 * ── 上界 ─────────────────────────────────────────────────────
 * 单次请求仍以 `pageSize` 为上限（不放大 IPC 负载与后端单次切片），因此最多发
 * `maxPages` 个请求；超过就只交回已收集的部分 —— 宁可少刷一点，也不让「后台刷新」
 * 退化成无界拉取。
 *
 * 抽成本模块的唯一目的是**可测**：本仓库没有 hook/DOM 测试环境（见 M13/M14 的结论），
 * 循环写死在 `hooks.tsx` 里就等于零回归信号。
 */

/** `collectPageRange` 的输入。 */
export interface PageRangePlan {
  /** 想要重新覆盖的条数（= 当前已加载条数）。 */
  want: number
  /** 单次请求上限。 */
  pageSize: number
  /** 最多发多少个请求。 */
  maxPages: number
  /** 取一页。 */
  fetchPage: (offset: number, limit: number) => Promise<{ items: readonly unknown[]; total: number }>
  /**
   * 每取到一页时回调（用于把 `total` 等顺带更新到界面）。
   * 返回 `false` 表示调用方已作废这一轮（例如期间发生了切换分类），循环立即停止。
   */
  onPage?: (info: { offset: number; count: number; total: number; collected: number }) => boolean | void
}

/** `collectPageRange` 的结果。 */
export interface PageRangeResult<T> {
  /** 收集到的条目（按 offset 顺序拼接）。 */
  items: T[]
  /** 最后一次成功请求报告的 total。 */
  total: number
  /** 是否因为上界/耗尽而提前停下（诊断用）。 */
  stopped: 'done' | 'covered' | 'exhausted' | 'empty-page' | 'max-pages' | 'cancelled' | 'invalid'
}

/**
 * 按 `want` 条把范围重新取一遍。
 * @param plan - 取数计划（见 `PageRangePlan`）。
 * @returns 收集结果与停止原因。
 */
export async function collectPageRange<T>(plan: PageRangePlan): Promise<PageRangeResult<T>> {
  const { want, pageSize, maxPages, fetchPage, onPage } = plan
  const items: T[] = []
  let total = 0
  // 非法输入一律按「无事可做」处理，不抛错（与 N8/H9 对非法上限的口径一致）。
  if (!Number.isFinite(pageSize) || pageSize <= 0 || !Number.isFinite(maxPages) || maxPages <= 0) {
    return { items, total, stopped: 'invalid' }
  }
  const target = Number.isFinite(want) && want > 0 ? Math.floor(want) : 0
  if (target === 0) return { items, total, stopped: 'done' }

  for (let i = 0; i < maxPages; i++) {
    const offset = i * pageSize
    if (offset >= target) return { items, total, stopped: 'covered' }
    const r = await fetchPage(offset, pageSize)
    total = r.total
    // 空页是「真的到底」的唯一硬证据。返回 false 表示这一轮已被作废，必须丢弃已收集内容。
    if (onPage && onPage({ offset, count: r.items.length, total, collected: items.length + r.items.length }) === false) {
      return { items, total, stopped: 'cancelled' }
    }
    if (r.items.length === 0) return { items, total, stopped: 'empty-page' }
    items.push(...(r.items as readonly T[]))
    // 已取到后端报告的全部条数（或列表被别的路径清空后 total 变得不可信）就收工。
    if (items.length >= total) return { items, total, stopped: 'exhausted' }
  }
  return { items, total, stopped: 'max-pages' }
}
