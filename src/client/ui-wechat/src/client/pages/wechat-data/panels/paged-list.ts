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
export function computeHasMore(progress: PageProgress): boolean {
  const { loaded, total, lastPageCount, pageSize } = progress
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
