/**
 * 触发记录的服务端搜索与分页状态（2026-10-20）。
 *
 * 这段状态必须和任务列表分开：任务列表一次取全、可在客户端过滤；触发记录可能很多，
 * 搜索与「加载更多」必须使用同一组服务端条件，否则只能搜到当前页。hook 把搜索草稿、
 * 防抖提交、第一页快照和后续游标收在一处，容器只负责把结果交给视图。
 *
 * @module use-task-center-triggers
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { TaskTriggerCursor, TaskTriggerRecord } from '@deepseek-ai/dsh-wechat-data/types'
import { apiListTaskTriggers } from '../api-task-center.ts'
import { useFreshData } from './use-fresh-data.ts'
import {
  appendTriggerPage,
  capTriggerSearchInput,
  needsTriggerPageBackfill,
  normalizeTriggerSearch,
} from './task-center.ts'

/** 与后端默认页大小一致；首屏与后续页必须使用同一个 limit。 */
const TRIGGER_PAGE_SIZE = 100
/** 输入停顿后再查，避免逐字打后端；清空搜索也走同一延迟。 */
const TRIGGER_SEARCH_DEBOUNCE_MS = 250
/**
 * 静默刷新最多补齐多少页。
 *
 * 多页列表刷新必须覆盖原范围，不能缩成一页；但用户手动翻到很深后，宿主每次
 * WAL 推送都串行重取全部页会把后端队列压住。超过该上界时保留旧列表、不刷新，
 * 下一次用户手动刷新或筛选变化仍会正常回源。
 */
const TRIGGER_BACKFILL_MAX_PAGES = 8

/** 容器渲染右栏所需的搜索、分页与取数状态。 */
export interface TaskCenterTriggersState {
  items: readonly TaskTriggerRecord[]
  total: number
  loading: boolean
  error: string | null
  readError: string | null
  stale: boolean
  search: string
  searchDraft: string
  hasMore: boolean
  loadingMore: boolean
  loadMoreError: string | null
  refreshing: boolean
  setSearchDraft: (value: string) => void
  loadMore: () => void
  reload: () => Promise<void>
  /** 静默刷新第一页：保留当前列表，等新快照到达后原位替换。 */
  reloadSilent: () => Promise<void>
}

/** 第一页与后续页共用的原子列表快照；`items` 必须与 `total` / `nextCursor` 同源。 */
interface TriggerListSnapshot {
  items: readonly TaskTriggerRecord[]
  total: number
  nextCursor: TaskTriggerCursor | undefined
}

const EMPTY_TRIGGER_LIST: TriggerListSnapshot = { items: [], total: 0, nextCursor: undefined }

/**
 * 取触发记录第一页并维护后续分页。
 * @param selectedTaskId - 当前任务筛选；null 表示全部任务。
 * @returns 右栏快照、搜索与分页动作。
 */
export function useTaskCenterTriggers(selectedTaskId: number | null): TaskCenterTriggersState {
  const [searchDraft, setSearchDraftValue] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSearch(normalizeTriggerSearch(searchDraft))
    }, TRIGGER_SEARCH_DEBOUNCE_MS)
    return () => { window.clearTimeout(timer) }
  }, [searchDraft])

  const fetchTriggers = useCallback(
    () => apiListTaskTriggers({
      ...(selectedTaskId !== null ? { taskId: selectedTaskId } : {}),
      search,
      limit: TRIGGER_PAGE_SIZE,
    }),
    [selectedTaskId, search],
  )
  const triggerQueryKey = (selectedTaskId === null ? 'all' : String(selectedTaskId)) + ':' + search
  const fresh = useFreshData(
    'taskCenter:triggers:' + triggerQueryKey,
    fetchTriggers,
    { shouldCache: (d) => !d.readError, liveRefresh: true },
  )

  /**
   * 第一页快照与后续页共用的列表状态。
   *
   * `items` / `total` / `nextCursor` 必须一起替换：拆成三个 `useState` 时，React 会在
   * 同一个事件里分批提交，搜索切换的那一帧可能已经是新列表、旧总数（界面上就是
   * `100 / 118` 配一条命中结果）。一个对象状态把这类中间帧从结构上消掉。
   */
  const [triggerList, setTriggerList] = useState<TriggerListSnapshot>(EMPTY_TRIGGER_LIST)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null)
  const loadingMoreRef = useRef(false)
  const nextTriggerCursorRef = useRef<TaskTriggerCursor | undefined>(undefined)
  const triggerQueryRef = useRef(0)
  const loadedTriggerQueryKeyRef = useRef(triggerQueryKey)
  const observedTriggerPageRef = useRef<{ page: unknown; key: string } | null>(null)
  /** 只标记还没接管的查询键；切换筛选后的第一份快照仍从第一页开始。 */
  const freshQueryKeyRef = useRef(triggerQueryKey)
  /** 本次筛选已加载的条数；同筛选刷新时据此补齐原范围。 */
  const loadedCountRef = useRef(0)
  /** 已接管的第一页对象；避免同一份快照因 effect 依赖重跑而重复补页。 */
  const acceptedPageRef = useRef<unknown>(null)

  if (freshQueryKeyRef.current !== triggerQueryKey) {
    freshQueryKeyRef.current = triggerQueryKey
    loadedCountRef.current = 0
  }

  /**
   * 输入变化时立刻作废在途的分页/补齐请求，避免用户在等防抖的 250ms 内
   * 还看到旧搜索条件的下一页被追加进来。`search` 提交后查询键变化会再重置一次。
   */
  const invalidatePagination = useCallback((): void => {
    triggerQueryRef.current += 1
    loadingMoreRef.current = false
    nextTriggerCursorRef.current = undefined
  }, [])

  /** 受控输入最多保留与后端相同的 100 字，避免用户输入后静默截断查询。 */
  const setSearchDraft = useCallback((value: string): void => {
    invalidatePagination()
    setSearchDraftValue(capTriggerSearchInput(value))
  }, [invalidatePagination])

  /** 第一页之后按游标补齐，确保多页列表刷新后不会缩回一页。 */
  const backfillFirstPage = useCallback(async (
    firstPage: Awaited<ReturnType<typeof fetchTriggers>>,
    query: number,
    target: number,
  ): Promise<TriggerListSnapshot | null> => {
    if (target > TRIGGER_PAGE_SIZE * TRIGGER_BACKFILL_MAX_PAGES) return null
    let snapshot: TriggerListSnapshot = {
      items: firstPage.items,
      total: firstPage.total,
      nextCursor: firstPage.nextCursor,
    }
    let cursor = firstPage.nextCursor
    if (!needsTriggerPageBackfill(target, TRIGGER_PAGE_SIZE) || cursor === undefined) {
      return snapshot
    }
    let fetchedPages = 1
    while (snapshot.items.length < target && cursor !== undefined) {
      // 超过上界时整轮放弃；不要只取前几页再替换，否则列表会缩水。
      if (fetchedPages >= TRIGGER_BACKFILL_MAX_PAGES) return null
      const page = await apiListTaskTriggers({
        ...(selectedTaskId !== null ? { taskId: selectedTaskId } : {}),
        search,
        limit: TRIGGER_PAGE_SIZE,
        cursor,
      })
      if (triggerQueryRef.current !== query) return null
      if (page.readError !== undefined) return null
      snapshot = {
        items: appendTriggerPage(snapshot.items, page.items),
        total: page.total,
        nextCursor: page.nextCursor,
      }
      fetchedPages += 1
      cursor = page.nextCursor
      if (page.items.length === 0) break
    }
    return snapshot
  }, [search, selectedTaskId])

  /**
   * 加载更多。请求期间的 ref 防止连点发起两页请求；失败保留已加载内容，
   * 只在右栏底部显示错误。
   */
  const loadMore = useCallback((): void => {
    const cursor = nextTriggerCursorRef.current
    if (cursor === undefined || loadingMoreRef.current) return
    const query = triggerQueryRef.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    setLoadMoreError(null)
    void (async (): Promise<void> => {
      try {
        const page = await apiListTaskTriggers({
          ...(selectedTaskId !== null ? { taskId: selectedTaskId } : {}),
          search,
          limit: TRIGGER_PAGE_SIZE,
          cursor,
        })
        if (triggerQueryRef.current !== query) return
        if (page.readError !== undefined) {
          setLoadMoreError(page.readError)
          return
        }
        nextTriggerCursorRef.current = page.nextCursor
        setTriggerList((current) => ({
          ...current,
          items: appendTriggerPage(current.items, page.items),
          nextCursor: page.nextCursor,
        }))
        loadedCountRef.current += page.items.length
      } catch (e) {
        if (triggerQueryRef.current !== query) return
        setLoadMoreError((e as Error).message)
      } finally {
        if (triggerQueryRef.current === query) {
          loadingMoreRef.current = false
          setLoadingMore(false)
        }
      }
    })()
  }, [search, selectedTaskId])

  /** 筛选变化时立刻丢弃上一组记录与游标；第一页快照是分页状态的单一入口。 */
  useEffect(() => {
    if (loadedTriggerQueryKeyRef.current === triggerQueryKey) return
    loadedTriggerQueryKeyRef.current = triggerQueryKey
    triggerQueryRef.current += 1
    loadingMoreRef.current = false
    nextTriggerCursorRef.current = undefined
    loadedCountRef.current = 0
    setTriggerList(EMPTY_TRIGGER_LIST)
    setLoadMoreError(null)
    setLoadingMore(false)
  }, [triggerQueryKey])

  useEffect(() => {
    const page = fresh.data
    if (page === null) return
    if (acceptedPageRef.current === page) return
    const observed = observedTriggerPageRef.current
    // 切筛选的那一帧仍可能拿到上一个键的 data；等新请求返回新对象后再接管。
    if (observed?.page === page && observed.key !== triggerQueryKey) return
    observedTriggerPageRef.current = { page, key: triggerQueryKey }
    if (page.readError !== undefined) return
    const previousPage = acceptedPageRef.current
    acceptedPageRef.current = page
    // 同筛选的刷新/推送会换一份第一页快照；在途的旧「加载更多」必须失效。
    const query = triggerQueryRef.current + 1
    triggerQueryRef.current = query
    const backfillTarget = loadedCountRef.current
    loadingMoreRef.current = false
    setLoadingMore(false)
    void (async (): Promise<void> => {
      const snapshot = await backfillFirstPage(page, query, backfillTarget)
      if (snapshot === null || triggerQueryRef.current !== query) {
        if (acceptedPageRef.current === page) acceptedPageRef.current = previousPage
        return
      }
      nextTriggerCursorRef.current = snapshot.nextCursor
      loadedCountRef.current = snapshot.items.length
      setTriggerList(snapshot)
      setLoadMoreError(null)
    })().catch(() => {
      // 静默刷新失败时保留旧列表；下一次事件或手动刷新会再试。
    })
  }, [backfillFirstPage, fresh.data, triggerQueryKey])

  return {
    items: triggerList.items,
    total: triggerList.total,
    loading: fresh.loading,
    error: fresh.error,
    readError: fresh.data?.readError ?? null,
    stale: fresh.stale,
    search,
    searchDraft,
    hasMore: triggerList.nextCursor !== undefined,
    loadingMore,
    loadMoreError,
    refreshing: fresh.refreshing,
    setSearchDraft,
    loadMore,
    reload: fresh.reload,
    reloadSilent: fresh.reloadSilent,
  }
}
