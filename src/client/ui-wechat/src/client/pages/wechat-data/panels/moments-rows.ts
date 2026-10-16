/**
 * 朋友圈时间线的「行」算术（#22 最后一处长列表：虚拟化数的是行，而界面按天分组）。
 *
 * 为什么把分组摊平成行：`groupByDate` 给出的是「一天 + 那天的动态」，而虚拟窗口要的是
 * 一个可索引的扁平序列。摊平之后一天里的那条日期标签也是一行 —— 于是"滚到某天"
 * 与"滚到某条"用同一套下标，不需要两套边界（两套边界正是"最后一天的标签不见了"那种错的家）。
 *
 * 顺手把空态那段文案搬进来：它原先是面板 JSX 里的一个 IIFE（八个筛选条件互相咬），
 * 搬出来才可能一条一条喂参数测 —— 而"该说'无匹配动态'还是'当前筛选无匹配动态'"
 * 决定了用户会不会以为自己一条动态都没有。
 */
import type { MomentItem } from '@deepseek-ai/dsh-wechat-data/types'

/** 一天里的动态（`groupByDate` 的输出形状）。 */
export interface MomentDay {
  day: string
  items: readonly MomentItem[]
}

/** 时间线里的一行：日期标签，或一条动态。 */
export type MomentRow = { kind: 'day'; day: string } | { kind: 'moment'; m: MomentItem }

/**
 * 把按天分组的动态摊平成行序列（保持分组顺序与组内顺序）。
 * @param groups - `groupByDate` 的结果。
 * @returns 每行要么是日期标签、要么是一条动态；空组不产出任何行。
 */
export function buildMomentRows(groups: readonly MomentDay[]): MomentRow[] {
  const out: MomentRow[] = []
  for (const g of groups) {
    if (!g || g.items.length === 0) continue
    out.push({ kind: 'day', day: g.day })
    for (const m of g.items) out.push({ kind: 'moment', m })
  }
  return out
}

/** 按 `tid` 找行下标（`tid` 为 0/空时不参与，避免把所有"没有 tid"的都跳过去）。 */
export function momentRowIndex(rows: readonly MomentRow[], tid: string | number): number {
  const want = String(tid ?? '')
  if (!want || want === '0') return -1
  return rows.findIndex((r) => r.kind === 'moment' && String(r.m.tid) === want)
}

/** {@link momentsEmptyText} 的输入：面板上当下那份筛选状态。 */
export interface MomentsEmptyInput {
  search: string
  mediaFilter: string
  monthFilter: string | null
  mineFilter: string
  authorFilter: string | null
  dateFrom: string
  dateTo: string
  loaded: number
  total: number
}

/**
 * 「这一屏为什么是空的」—— 给用户的那句话。
 * 口径与搬出前面板里那个 IIFE **逐字一致**（这条是纯搬家，不改文案）：
 * 只有"搜索 + 其余筛选全是默认"才提"已加载范围"，因为那时"没搜到"最可能是"还没翻到"；
 * 带其它筛选时搜索只说「无匹配动态」（用户已经知道自己在筛）；
 * 没搜索但有筛选 ⇒ 「当前筛选无匹配动态」；什么都没筛才是「暂无朋友圈动态」。
 * @param i - 当下的筛选与加载状态。
 * @returns 空态文案。
 */
export function momentsEmptyText(i: MomentsEmptyInput): string {
  const noOtherFilters = i.mediaFilter === 'all' && i.monthFilter === null && i.mineFilter === 'all' && i.authorFilter === null
  if (i.search && noOtherFilters) {
    return i.loaded < i.total
      ? '已加载范围无匹配（共 ' + String(i.total) + ' 条，当前只加载了 ' + String(i.loaded) + ' 条）'
      : '无匹配动态'
  }
  if (i.search) return '无匹配动态'
  const filtered = i.mediaFilter !== 'all' || i.monthFilter !== null || i.mineFilter !== 'all' || i.authorFilter !== null || !!i.dateFrom || !!i.dateTo
  if (filtered) return '当前筛选无匹配动态'
  return '暂无朋友圈动态'
}
