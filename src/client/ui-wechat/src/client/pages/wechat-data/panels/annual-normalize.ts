/**
 * 年度回顾载荷的**归一化**（2026-09-30 加「更多」六块之后补的防线）。
 *
 * ## 为什么必须有这一层（黑屏事故的根因）
 *
 * 面板首帧读的是 localStorage 里的渲染缓存（先秒开、后拉真数据）。旧版本写下的那份缓存
 * **没有** `moments` / `assets` / `money` / `revoke` / `groups` 五个字段 ——
 * 而新卡片直接读 `r.money.count`，于是 `undefined.count` 在渲染期抛 TypeError：
 * 没有 error boundary 的整棵面板树直接挂掉，用户看到的就是**整窗黑屏**（只剩标题栏）。
 *
 * 所以：**凡是"新加的字段"，都必须假设"手上的数据可能是上一版写下的"**。归一化放在数据入口
 * （缓存与远端两条路都过），而不是散在每张卡片里判空 —— 后者漏一处就又是一次黑屏。
 *
 * ## 另一个诚实问题：0 到底是"没算"还是"真的是 0"？
 *
 * 旧缓存里缺字段时，我们**无法**区分这两件事。把缺字段一律填 0 再显示「这一年没有转账」，
 * 等于对着旧数据编一个结论。所以这里额外给一个 `extrasPending` 标记：新板块的 0 是"还没算出来"，
 * 卡片据此显示"统计中…"，等后端的真数据回来（`extrasPending:false`）再显示真实结论。
 */
import type { AnnualReviewShape } from '../api.ts'

/** 归一化后的载荷：五个新字段保证存在，并带上"这些数还没算"的标记。 */
export interface NormalizedReview extends Omit<AnnualReviewShape, 'moments' | 'assets' | 'money' | 'revoke' | 'groups'> {
  moments: AnnualReviewShape['moments']
  assets: AnnualReviewShape['assets']
  money: AnnualReviewShape['money']
  revoke: AnnualReviewShape['revoke']
  groups: AnnualReviewShape['groups']
  /** true = 这份数据来自缺字段的旧缓存，新板块的 0 表示"还没算"而不是"真的是 0"。 */
  extrasPending: boolean
}

/**
 * 渲染缓存的键（带**载荷版本**）。
 *
 * 加版本号是第二道防线：字段形状变了就把旧缓存让出去，而不是靠归一化去救一份过期的数据。
 * 读旧键的代码一律不再存在 —— 旧缓存自然过期（`writeRenderCache` 有 TTL）。
 * @param year - 自然年。
 * @returns 缓存键。
 */
export function annualReviewCacheKey(year: number): string {
  return `annual-review:v4:${String(year)}`
}

/**
 * 从可选年份里选出**默认打开**的那一年：最新（最大）的一年。
 *
 * ## 为什么单独抽出来（2026-11-19 修 bug 时抽的）
 *
 * 原来这段逻辑写在 `loadYears` 里，是 `ys.at(-1)` —— 取数组**最后一项**。
 * 而后端返回的是**降序**（`annual.ts` 里 `sort((a, b) => b - a)`），
 * 于是 `at(-1)` 每次选中**最旧**的一年：用户打开年度报告看到的是 2020 年，
 * 而下拉里最新的是 2026 年（截图确认）。
 *
 * 两个教训：
 *   ① **不要依赖后端数组的顺序** —— 顺序不是契约，改了不会有人通知；
 *   ② 这种"只错一次选择"的缺陷，看代码很容易觉得对（`at(-1)` 读起来像"最后一个"），
 *      所以抽成纯函数、用行为级测试钉住（含降序/升序/乱序三种输入）。
 *
 * @param years - 可选年份（任意顺序，可含非整数）。
 * @returns 最大年份；没有可用年份时返回当前年。
 */
export function defaultAnnualYear(years: readonly number[]): number {
  let best: number | null = null
  for (const y of years) {
    if (!Number.isFinite(y)) continue
    if (best === null || y > best) best = y
  }
  return best ?? new Date().getFullYear()
}

/**
 * 把后端给的年份列表归一化成**降序**（最新在前）。
 *
 * 下拉框的顺序也走这里 —— 这样"第一个选项 = 默认年份"成立，
 * 用户点开就能看到最新一年在最上面。
 * @param years - 任意顺序的年份（含脏数据）。
 * @returns 去重后的降序数组。
 */
export function normalizeAnnualYears(years: readonly number[]): number[] {
  const seen = new Set<number>()
  for (const y of years) {
    // 2000 之前基本是脏数据（微信本身还没发布），与面板原有过滤口径一致。
    if (Number.isFinite(y) && y > 2000) seen.add(y)
  }
  return [...seen].sort((a, b) => b - a)
}

/** 五个新字段的空形状（`available:false` 表示"这个库没读到"，不是"是 0"）。 */
function emptyExtras(): Pick<AnnualReviewShape, 'moments' | 'assets' | 'money' | 'revoke' | 'groups'> {
  return {
    moments: { count: 0, topPost: null, topMonth: null, lateNight: 0, available: false },
    assets: { favorites: 0, files: 0, bytes: 0, sentFiles: 0, available: false },
    money: { count: 0, total: 0, topAmount: 0, topPeerName: '', topPeerUsername: '', byPeer: [] },
    revoke: { count: 0, topPeerName: '', topPeerUsername: '', byHour: new Array<number>(24).fill(0) },
    groups: { messages: 0, share: 0, top: [] },
  }
}

/** 某个新字段是否真的在载荷里（不是 undefined/null）。 */
function has<T>(v: T | undefined | null): v is T {
  return v !== undefined && v !== null
}

/**
 * 把任意来源的年度载荷补齐成"五个新字段一定存在"的形状。
 *
 * 五个字段全部存在时原样返回（`extrasPending:false`）；缺任意一个就补空形状并置
 * `extrasPending:true` —— 只影响新板块，**不碰**原有字段（那些字段缺了是另一类问题，
 * 不该被这里悄悄填平）。
 * @param raw - 缓存或远端拿到的载荷。
 * @returns 归一化后的载荷（始终可用）。
 */
export function normalizeReview(raw: AnnualReviewShape): NormalizedReview {
  const ex = emptyExtras()
  const missing = !has(raw.moments) || !has(raw.assets) || !has(raw.money) || !has(raw.revoke) || !has(raw.groups)
  // **逐字段**补：只缺一个就只补那一个。早先写成"缺任意一个就把五个一起换成空形状"，
  // 结果后端只升级一半时，已经到达的字段会被抹成 0（用例当场抓到）。
  return {
    ...raw,
    moments: has(raw.moments) ? raw.moments : ex.moments,
    assets: has(raw.assets) ? raw.assets : ex.assets,
    money: has(raw.money) ? raw.money : ex.money,
    revoke: has(raw.revoke) ? raw.revoke : ex.revoke,
    groups: has(raw.groups) ? raw.groups : ex.groups,
    extrasPending: missing,
  }
}
