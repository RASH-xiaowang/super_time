/**
 * 分页列表「还有下一页」的判定（L7）。
 *
 * 为什么从 `hooks.tsx` 里抽出来：这是**唯一**需要判断「到底了没有」的地方，而
 * `usePagedList` 是 React hook —— 仓库没有 DOM/hook 测试环境，判定写死在 hook 里就
 * 等于零回归信号。判定本身是纯逻辑，抽出来后可以用假数据把每种边界钉住。
 *
 * ── 旧写法为什么错 ────────────────────────────────────────────────
 * 旧判据是 `items.length < total && lastCount === pageSize`：
 * 把 `total` 当成了「还有更多」的**必要条件**，而 total 至少有三种不可信形态：
 *   ① 后端压根没统计（返回 0）；
 *   ② 与分页口径不一致（按另一张表 / 筛选前的集合计数）；
 *   ③ 被上限截断（COUNT 有 cap，或总数只统计到某一批）。
 * 一旦 total 偏小，`items.length < total` 会**在一次「刚取满一整页」之后先变假** ——
 * 用户滚到底，列表停在半路，剩下的数据再也取不到，而且界面没有任何提示（静默截断）。
 * 「整页末页」正是这个情形的表现：末页刚好取满 ⇒ `items.length === total`，
 * 而「真的到底」与「total 被截断」在客户端无法区分，旧写法等于赌 total 可信。
 *
 * ── 新判据：只让「能证明到底」的信号收敛 ──────────────────────────
 *   · 本页为空      → 到底（唯一确定的证据）；
 *   · 本页取满      → 可能还有，继续（**即使 total 说已到末尾**）；
 *   · 本页不满      → 通常到底，但 total 明确说还有更多时以 total 为准
 *                     （后端按 limit 截断、或跳过了无法解析的行 ⇒ 不满页也不是末页）。
 * 代价：列表长度刚好是 pageSize 整数倍时会多发一次探测请求（该页返回空 ⇒ 立刻到底），
 * 换来的是不会静默截断数据。
 */

/** `computeHasMore` 的输入。 */
export interface PageProgress {
  /** 已加载条数。 */
  loaded: number
  /** 后端报告的「总数」；可能不可信（0 / 口径不一致 / 被截断）。 */
  total: number
  /** 最后一次请求**实际返回**的条数。 */
  lastPageCount: number
  /** 本次请求的页大小。 */
  pageSize: number
}

/**
 * 判断是否还有下一页。
 * @param progress - 当前分页进度。
 * @returns 需要继续加载下一页则为 true。
 */
export function computeHasMore(progress: PageProgress): boolean {  const { loaded, total, lastPageCount, pageSize } = progress
  // 空页（0 条）是「到底」的唯一硬证据；负数/NaN 一律按 0 处理（与 N8 对非法上限的口径一致，
  // 不沿用 `slice(0, -n)` 那种笔误语义）。
  if (!Number.isFinite(lastPageCount) || lastPageCount <= 0) return false
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 0
  // 页大小非法时退回「只有 total 说还有才继续」：此时不能按「取满」判，否则 hasMore
  // 会恒真、哨兵无限触发加载。
  if (size === 0) return Number.isFinite(total) && loaded < total
  if (lastPageCount >= size) return true
  return Number.isFinite(total) && loaded < total
}

/**
 * ── 后台刷新的节流与上界（P2-8 / CODE-AUDIT-2026-09-26 第二批 #17）──────────
 *
 * 实时同步活跃期宿主约每 10 秒派发一次 `dsh-wechat-data-updated`，而用 `usePagedList`
 * 的面板每一个都会 `refresh()` —— 一次 refresh 是 `ceil(已加载条数 / pageSize)` 个请求
 * （旧上界 16 页 × 200 条）。后端只有一条调用队列，于是「翻到底的长列表 + 同步中」
 * 的组合会把十几个重读请求每 10 秒压进去一次，正是 PERF-BASELINE 那类「13ms 的请求
 * 排到 17 秒后」的放大器。面板在**后台页签/隐藏窗口**时这些请求尤其没有意义。
 */

/** 两轮后台刷新之间的最短间隔（毫秒）；期间到达的事件会被合并成一次「尾部刷新」。 */
export const REFRESH_MIN_INTERVAL_MS = 30_000
/** 一轮后台刷新最多发多少页；不够就把这一轮**整体跳过**（绝不截断已加载的列表）。 */
export const REFRESH_MAX_PAGES = 8

/** {@link refreshGate} 的输入。 */
export interface RefreshGateInput {
  /** 现在（毫秒 epoch）。 */
  now: number
  /** 上一轮真正开始的时刻；0 = 从未刷过。 */
  lastStartedAt: number
  /** 页面是否不可见（`document.hidden`）。 */
  hidden: boolean
  /** 最短间隔，默认 {@link REFRESH_MIN_INTERVAL_MS}。 */
  minIntervalMs?: number
}

/**
 * 这一轮后台刷新该不该现在发。
 * @returns `go` 是否立刻发；`waitMs` 是「稍后再发」要等多久（不可见时为 0 = 根本不发，
 *          可见性恢复时由调用方补一次）。
 */
export function refreshGate(input: RefreshGateInput): { go: boolean; waitMs: number } {
  const min = Number.isFinite(input.minIntervalMs) ? (input.minIntervalMs ?? REFRESH_MIN_INTERVAL_MS) : REFRESH_MIN_INTERVAL_MS
  // 不可见：不发，也不排尾部 —— 窗口重新可见时调用方自己会补一次（见 hooks 里的 visibilitychange）
  if (input.hidden) return { go: false, waitMs: 0 }
  if (!Number.isFinite(input.lastStartedAt) || input.lastStartedAt <= 0) return { go: true, waitMs: 0 }
  const elapsed = input.now - input.lastStartedAt
  // 时钟回拨（NTP / 休眠唤醒）时 elapsed 会是负的：这时必须**放行**，
  // 否则 `min - elapsed` 是个比 min 还大的等待，极端情况下把后台刷新长期锁死。
  if (elapsed < 0 || elapsed >= min) return { go: true, waitMs: 0 }
  // 关键：**合并而不是丢弃**。只丢事件会让面板一直停在旧数据上（没人再触发刷新），
  // 那就把「省请求」换成了「看不见的过期」。
  return { go: false, waitMs: min - elapsed }
}

/**
 * 一轮刷新需要多少页；超过上界时判「不可行」。
 *
 * 不可行时调用方必须**整轮跳过**，而不是发前 N 页然后把列表截短 ——
 * `refresh()` 的存在理由就是「非破坏性」（见 hooks 里那段长注释：截短会塌高度、
 * 把用户弹回顶部）。宁可这一轮不刷，也不破坏视图。
 */
export function refreshPagesFor(loaded: number, pageSize: number, maxPages = REFRESH_MAX_PAGES): { pages: number; feasible: boolean } {
  const size = Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : 0
  const want = Number.isFinite(loaded) && loaded > 0 ? Math.floor(loaded) : 0
  if (size === 0 || want === 0) return { pages: 0, feasible: true }
  const pages = Math.ceil(want / size)
  if (pages > maxPages) return { pages: maxPages, feasible: false }
  return { pages, feasible: true }
}
