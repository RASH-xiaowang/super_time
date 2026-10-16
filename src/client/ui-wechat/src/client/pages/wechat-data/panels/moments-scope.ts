/**
 * 朋友圈列表的**筛选与派生**：把「一数组 + 一组条件」变成「要画的那几组 + 侧栏要的几张统计表」。
 *
 * ## 为什么单独成模块（第三批 #18）
 *
 * 这七段原先是 `moments-panel.tsx` 里连着七个 `useMemo`，每个都依赖上一个的**数组身份**。
 * 那种形状已经真出过一次事故：`scoped` 的函数体读 `dateScoped`，依赖数组却写
 * `[monthFiltered, sortOrder]` ⇒ 选日期范围时列表**不动**（`moments.tsx:371`，改前）。
 * 链条越长越容易漏一环，而漏掉的那一环没有 lint 会拦（本仓至今没装 eslint）。
 *
 * 现在分成两层：
 *  · **纯函数**（本文件上半）：输入全部显式列在参数里，可查表验证，不碰 React；
 *  · **`useMomentsScope`**（本文件下半）：唯一一处写依赖数组的地方，
 *    由 `moments-scope.spec.ts` 的 AST 判据钉住「criteria 里每个字段都必须在依赖里」。
 *
 * 时间/月份的格式化**不放这里**：`fmt*` / `format*` 前缀 + 单位换算会被
 * `src/backend/tests/format-single-source.spec.ts` 判成第二份实现，
 * 所以下面月份键那个帮手刻意叫 `monthKeyOfSec`（名字里没有 fmt/format）。
 *
 * @module moments-scope
 */
import { useMemo } from 'react'
import type { MomentItem, MomentsMonthlySnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import type { MediaFilter } from './moments-support.tsx'

/** 面板上那八个会影响列表的输入（每一个都必须进依赖数组，见模块头）。 */
export interface MomentsCriteria {
  /** 搜索框（已去空白并转小写由函数内部负责）。 */
  search: string
  media: MediaFilter
  /** 作者 chips 选中的显示名（null = 不限）。 */
  author: string | null
  mine: 'all' | 'mine' | 'others'
  /** 月度导航选中的 `YYYY-MM`（null = 不限）。 */
  month: string | null
  dateFrom: string
  dateTo: string
  order: 'desc' | 'asc'
}

/** 侧栏「内容构成」那张表的形状。 */
export interface MomentsInsight {
  withImages: number
  withVideos: number
  withLocation: number
  withLink: number
}

/** 月度分布的一根柱子。 */
export interface MonthlyRow {
  key: string
  label: string
  count: number
}

/**
 * 秒级时间戳 → `YYYY-MM`（月度导航与月度分布回退用的同一把键）。
 * @param ts - unix **秒**（不是毫秒）。
 * @returns 形如 `2026-09`。
 */
export function monthKeyOfSec(ts: number): string {
  const d = new Date(ts * 1000)
  return String(d.getFullYear()) + '-' + String(d.getMonth() + 1).padStart(2, '0')
}

/** 搜索命中：刻意比「作者/正文/地点」宽 —— 链接标题与 URL、公众号来源、点赞与评论的人都算。 */
function matchesSearch(m: MomentItem, q: string): boolean {
  return m.author.toLowerCase().includes(q)
    || m.text.toLowerCase().includes(q)
    || m.location.toLowerCase().includes(q)
    || m.link_title.toLowerCase().includes(q)
    || (m.link_url ?? '').toLowerCase().includes(q)
    || (m.sourceNickName ?? '').toLowerCase().includes(q)
    || (m.publicUserName ?? '').toLowerCase().includes(q)
    || m.likes.some((l) => (l.nickname || l.username).toLowerCase().includes(q))
    || m.comments.some((c) => (c.nickname || c.username).toLowerCase().includes(q) || c.content.toLowerCase().includes(q))
}

/** 媒体类型那一档；`text` 是「 neither 图 nor 视频 nor 链接」的补集。 */
function matchesMedia(m: MomentItem, media: MediaFilter): boolean {
  switch (media) {
    case 'image': return m.images.length > 0
    case 'video': return m.videos.length > 0
    case 'link': return !!m.link_title || m.contentType === 3 || m.contentType === 28
    case 'location': return !!m.location
    case 'text': return m.images.length === 0 && m.videos.length === 0 && !m.link_title
    default: return true
  }
}

/** `YYYY-MM-DD` → 当天 00:00:00 的秒（空串 = 0 = 不设界）。 */
function dayStartSec(date: string): number {
  return date ? Math.floor(new Date(date + 'T00:00:00').getTime() / 1000) : 0
}

/** `YYYY-MM-DD` → 当天 23:59:59 的秒（空串 = 0 = 不设界）。 */
function dayEndSec(date: string): number {
  return date ? Math.floor(new Date(date + 'T23:59:59').getTime() / 1000) : 0
}

/**
 * 按八个条件筛一遍并排序。**纯函数**：同样的输入永远给同样的数组。
 * @param moments - 已加载的全量列表。
 * @param c - 当前生效的条件。
 * @returns 筛选 + 排序后的新数组（不改入参）。
 */
export function scopeMoments(moments: readonly MomentItem[], c: MomentsCriteria): MomentItem[] {
  const q = c.search.trim().toLowerCase()
  const from = dayStartSec(c.dateFrom)
  const to = dayEndSec(c.dateTo)
  const out = moments.filter((m) =>
    (!q || matchesSearch(m, q))
    && (c.media === 'all' || matchesMedia(m, c.media))
    && (!c.author || m.author === c.author)
    && (c.mine === 'all' || (c.mine === 'mine' ? m.is_self : !m.is_self))
    && (!c.month || (m.ts && monthKeyOfSec(m.ts) === c.month))
    && (from <= 0 || m.ts >= from)
    && (to <= 0 || m.ts <= to))
  // 排序前拷贝：入参可能是别处的 memo 结果，原地 sort 会改动别人手里的数组。
  const arr = [...out]
  if (c.order === 'asc') arr.sort((a, b) => (a.ts || 0) - (b.ts || 0))
  else arr.sort((a, b) => (b.ts || 0) - (a.ts || 0))
  return arr
}

/**
 * 侧栏「内容构成」：四张计数，**基于全量 `moments`**（不是筛后的列表）。
 * @param moments - 已加载的全量列表。
 * @returns 四类各有多少条。
 */
export function insightCounts(moments: readonly MomentItem[]): MomentsInsight {
  const count = (p: (m: MomentItem) => boolean): number => moments.filter(p).length
  return {
    withImages: count((m) => m.images.length > 0),
    withVideos: count((m) => m.videos.length > 0),
    withLocation: count((m) => !!m.location),
    withLink: count((m) => !!m.link_title),
  }
}

/**
 * 作者 chips 的前 20 名。
 * @param full - 后端 SQL 聚合出的全量作者条数（失败或为空时 null）。
 * @param moments - 已加载的列表（全量聚合不可用时的回退口径）。
 * @returns `[显示名, 条数]`，按条数降序。
 */
export function topAuthorRows(
  full: Array<{ name: string; count: number }> | null,
  moments: readonly MomentItem[],
): Array<[string, number]> {
  // 优先全量聚合：它反映真实排名，而「已加载子集」只反映翻到的那几页。
  if (full && full.length > 0) return full.slice(0, 20).map((a) => [a.name, a.count])
  const map = new Map<string, number>()
  for (const m of moments) map.set(m.author, (map.get(m.author) ?? 0) + 1)
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
}

/**
 * 月度分布柱子图。后端快照为空时**退回按已加载部分统计**（并让面板有机会说明这是回退）。
 * @param snap - 当前生效的月度快照（选中作者时是作者那份）。
 * @param author - 作者筛选（回退统计也要按它收窄，否则柱子与列表口径不一致）。
 * @param moments - 已加载的列表。
 * @returns 按月份升序的柱子。
 */
export function monthlyRows(
  snap: MomentsMonthlySnapshot,
  author: string | null,
  moments: readonly MomentItem[],
): MonthlyRow[] {
  const raw = snap.months
  if (raw.length > 0) {
    return [...raw]
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((m) => ({ key: m.month, label: m.month, count: m.count }))
  }
  const map = new Map<string, number>()
  const scope = author ? moments.filter((m) => m.author === author) : moments
  for (const m of scope) {
    if (!m.ts) continue
    const k = monthKeyOfSec(m.ts)
    map.set(k, (map.get(k) ?? 0) + 1)
  }
  return [...map.keys()].sort().map((k) => ({ key: k, label: k, count: map.get(k) ?? 0 }))
}

/** `useMomentsScope` 的输入：列表 + 条件 + 两份侧栏要用的原始数据。 */
export interface MomentsScopeInput {
  moments: readonly MomentItem[]
  criteria: MomentsCriteria
  fullAuthors: Array<{ name: string; count: number }> | null
  monthlySnap: MomentsMonthlySnapshot
  monthlySnapForAuthor: MomentsMonthlySnapshot
}

/**
 * 面板用的那层 memo 包装：条件对象里写了哪些字段，依赖里就必须有哪些字段
 * （这条由 `moments-scope.spec.ts` 的 AST 判据把守，漏一个就红）。
 * @param input - 见 {@link MomentsScopeInput}。
 * @returns 列表与三张派生表，外加「当前生效的是哪份月度快照」的读失败原因。
 */
export function useMomentsScope(input: MomentsScopeInput): {
  scoped: MomentItem[]
  insight: MomentsInsight
  topAuthors: Array<[string, number]>
  monthly: MonthlyRow[]
  monthMax: number
  monthlyReadError: string
} {
  const { moments, criteria, fullAuthors, monthlySnap, monthlySnapForAuthor } = input
  const scoped = useMemo(
    () => scopeMoments(moments, criteria),
    [moments, criteria.search, criteria.media, criteria.author, criteria.mine, criteria.month,
      criteria.dateFrom, criteria.dateTo, criteria.order],
  )
  const insight = useMemo(() => insightCounts(moments), [moments])
  const topAuthors = useMemo(() => topAuthorRows(fullAuthors, moments), [fullAuthors, moments])
  /** 当前生效的那份月度快照（选中作者时换成作者版）。 */
  const monthlySnapActive = criteria.author ? monthlySnapForAuthor : monthlySnap
  const monthly = useMemo(
    () => monthlyRows(monthlySnapActive, criteria.author, moments),
    [monthlySnapActive, criteria.author, moments],
  )
  return {
    scoped,
    insight,
    topAuthors,
    monthly,
    monthMax: Math.max(1, ...monthly.map((m) => m.count)),
    monthlyReadError: monthlySnapActive.readError ?? '',
  }
}
