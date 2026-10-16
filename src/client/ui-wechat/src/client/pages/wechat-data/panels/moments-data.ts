/**
 * 朋友圈的**取数层**：分页拉列表、渲染缓存秒开、一次性拉全量、数据落地后的静默增量刷新，
 * 以及三份「侧栏要用但和列表不同口径」的附赠数据（自己的 username、全量作者条数、作者版月度分布）。
 *
 * ## 为什么单独成模块（第三批 #18 第五步）
 *
 * 这一族原先是面板开头那 100 多行 state + 四个 effect + 两个 `useCallback`，
 * 它们决定屏幕上有没有东西，却和「怎么画」挤在同一个函数里。搬出来之后面板只剩
 * 「怎么画」＋一小段需要 `scrollRef` 的分页观察器（那个 ref 属于媒体层，见下面的说明）。
 *
 * ## 两条别顺手改掉的约定
 *
 *  · **渲染缓存的键按上下文分开存**（`'moments:' + (author || 'all')`）：
 *    共用一个键会让「从某人的资料页点进 TA 的朋友圈」把上一次的过滤视图当缓存秒开，
 *    于是首屏是别人的动态、后台回来才换成对的。
 *  · **增量刷新只前插新 tid**，不整表替换：全量替换会把用户的滚动位置甩回顶部，
 *    而数据事件每约 10 秒就来一次。
 *
 * @module moments-data
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MomentItem, MomentsMonthlySnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { apiGetMoments, apiGetMomentsAuthors, apiGetMomentsMonthly, apiGetSelfUsername, readRenderCache, writeRenderCache } from '../api.ts'
import { useWechatDataUpdated } from './hooks.tsx'

/** 一页取多少条：后端要解析 XML，页开大一次就把主线程占死。 */
const PAGE = 500
/** 增量刷新那一页取少一点：它跑在「用户正在看」的时候。 */
const REFRESH_PAGE = 200

/** `useMomentsData` 的输入。 */
export interface MomentsDataInput {
  /** 微信用户名（从联系人资料页「TA 的朋友圈」带进来）。 */
  author?: string | null
  /** 作者牌的显示名筛选；选中时月度分布要按该作者另算一份。 */
  authorFilter: string | null
}

/**
 * 列表数据与三个取数动作。
 * @param input - 见 {@link MomentsDataInput}。
 * @returns 列表/总数/加载态/错误，三份侧栏附赠数据，两个游标 ref 与 `load` / `loadAll`。
 */
export function useMomentsData(input: MomentsDataInput): {
  moments: readonly MomentItem[]
  loading: boolean
  loadingAll: boolean
  error: string | null
  total: number
  monthlySnap: MomentsMonthlySnapshot
  monthlySnapForAuthor: MomentsMonthlySnapshot
  selfUsername: string | null
  fullAuthors: Array<{ name: string; count: number }> | null
  countRef: React.MutableRefObject<number>
  totalRef: React.MutableRefObject<number>
  moreInFlight: React.MutableRefObject<boolean>
  load: (reset?: boolean) => Promise<void>
  loadAll: () => Promise<void>
} {
  const { author, authorFilter } = input
  const [moments, setMoments] = useState<readonly MomentItem[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [monthlySnap, setMonthlySnap] = useState<MomentsMonthlySnapshot>({ months: [] })
  const [selfUsername, setSelfUsername] = useState<string | null>(null)
  const [fullAuthors, setFullAuthors] = useState<Array<{ name: string; count: number }> | null>(null)
  const [monthlySnapForAuthor, setMonthlySnapForAuthor] = useState<MomentsMonthlySnapshot>({ months: [] })
  const countRef = useRef(0)
  const totalRef = useRef(0)
  const [loadingAll, setLoadingAll] = useState(false)
  /** 分页观察器的重入闸门：一次Intersection 回调可能连着触发多次 `load(false)`。 */
  const moreInFlight = useRef(false)

  const load = useCallback(async (reset = true): Promise<void> => {
    setError(null)
    // 渲染缓存按“全量/该作者”上下文分开存储，避免刷新后串用上次过滤视图的缓存。
    const cacheKey = 'moments:' + (author || 'all')
    /* 2026-10-03 用户要求："朋友圈的数据改为每次打开都会直接请求获取，不需要本地缓存了，
       只有在（后端不可用的）时候才使用本地缓存"。
       ⚠️ 注意：朋友圈数据来自**本机库**（sns.db），不是网络 —— 所以"无网"不该阻止查库，
       打开时**无条件直接查**；缓存只在**查询失败**时兜底（见下面的 catch）。
       于是这里删掉了原先"先用上次渲染的列表秒开"的预填：首屏不再可能是旧数据。 */
    if (reset) setLoading(true)
    try {
      const opts: { limit: number; offset?: number; author?: string } = { limit: PAGE }
      if (!reset) opts.offset = countRef.current
      if (author) opts.author = author
      const env = await apiGetMoments(opts)
      setMoments(prev => (reset ? env.moments : [...prev, ...env.moments]))
      countRef.current = reset ? env.moments.length : countRef.current + env.moments.length
      setTotal(env.total)
      totalRef.current = env.total
      if (reset) writeRenderCache(cacheKey, env.moments.slice(0, 200))
      // Full-history monthly distribution only on (re)load — not per page.
      if (reset) {
        void apiGetMomentsMonthly(author ? { author } : undefined)
          .then((snap) => { setMonthlySnap(snap) })
          .catch(() => { setMonthlySnap({ months: [], readError: '月度分布请求失败（已退回按已加载部分统计）' }) })
      }
    } catch (e) {
      // 查询失败（后端不可用 / 库被锁 / 真离线）⇒ **回退缓存并明确标注**，而不是只留一行报错。
      const cached = readRenderCache<readonly MomentItem[]>(cacheKey)
      if (cached && cached.length > 0) { setMoments(cached); countRef.current = cached.length; setTotal(cached.length); setError('查询失败，以下为本地缓存（可能不是最新）：' + (e as Error).message) } else setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [author])

  useEffect(() => { void load() }, [load])

  // 拉取当前账号自己的 username，用于「仅看我的回复」。
  useEffect(() => {
    void apiGetSelfUsername().then((u) => { setSelfUsername(u || null) }).catch(() => { /* ignore */ })
  }, [])

  // 拉取全量作者条数（反映全量排名）。
  useEffect(() => {
    void apiGetMomentsAuthors().then((list) => { setFullAuthors(list) }).catch(() => { /* 回退已加载统计 */ })
  }, [])

  // 选中某作者（作者牌）时，按该作者重算「全部月份动态」；清除后回退到全量月度数据。
  useEffect(() => {
    if (!authorFilter) { setMonthlySnapForAuthor({ months: [] }); return }
    let cancelled = false
    setMonthlySnapForAuthor({ months: [] }) // 先清空，避免显示上一个作者的数据
    void apiGetMomentsMonthly({ authorName: authorFilter })
      .then((snap) => { if (!cancelled) setMonthlySnapForAuthor(snap) })
      // 失败时也要留一句原因：空数组会被读成「这个作者一条都没有」，而那通常不是事实。
      .catch(() => { if (!cancelled) setMonthlySnapForAuthor({ months: [], readError: '该作者的月度分布请求失败（已退回按已加载部分统计）' }) })
    return () => { cancelled = true }
  }, [authorFilter])

  /** 一次性拉取剩余全部朋友圈（每页 500 串行，避免压垮后端 XML 解析）。 */
  const loadAll = useCallback(async (): Promise<void> => {
    if (loadingAll) return
    setLoadingAll(true)
    setError(null)
    moreInFlight.current = true
    try {
      while (countRef.current < totalRef.current) {
        const opts: { limit: number; offset: number; author?: string } = { limit: PAGE, offset: countRef.current }
        if (author) opts.author = author
        const env = await apiGetMoments(opts)
        if (env.moments.length === 0) break
        setMoments(prev => [...prev, ...env.moments])
        countRef.current += env.moments.length
        totalRef.current = env.total
        setTotal(env.total)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      moreInFlight.current = false
      setLoadingAll(false)
    }
  }, [author, loadingAll])

  // 数据落地后安静刷新：空列表时全量加载；已加载时做「增量刷新」——拉取最新一页，
  // 只把尚未出现过的新动态前插，不折叠已有列表（避免滚动大跳动）。
  useWechatDataUpdated(() => {
    if (moments.length === 0) { void load(); return }
    void (async () => {
      try {
        const env = await apiGetMoments({ limit: REFRESH_PAGE, author: author || undefined })
        const existing = new Set(moments.map(m => m.tid))
        const fresh = env.moments.filter(m => !existing.has(m.tid))
        if (fresh.length > 0) {
          setMoments(prev => [...fresh, ...prev])
          writeRenderCache('moments:' + (author || 'all'), [...fresh, ...moments].slice(0, 200))
        }
        setTotal(env.total)
        totalRef.current = env.total
      } catch { /* 增量刷新失败时静默，保持当前列表 */ }
    })()
  })

  return {
    moments, loading, loadingAll, error, total,
    monthlySnap, monthlySnapForAuthor, selfUsername, fullAuthors,
    countRef, totalRef, moreInFlight, load, loadAll,
  }
}
