/**
 * 消息列表的只读取数与图片缩略图缓存。
 *
 * 写动作在 `use-message-list-actions.ts`，这里只负责记录/规则/Webhook 信息、
 * 筛选条件、竞态序号、更新事件回源与页面可见时的静默轮询。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  MessageListRecord,
  MessageListRule,
  MessageListSource,
  MessageListStatus,
  MessageListWebhookInfo,
} from '@deepseek-ai/dsh-wechat-data/types'
import {
  apiGetImageDataUrlsBatch,
  apiGetMessageListWebhookInfo,
  apiListMessageListRecords,
  apiListMessageListRules,
  apiQueryMessageListWebhookJob,
} from '../api.ts'
import { MESSAGE_LIST_UPDATED_EVENT } from '../message-list-events.ts'
import { useDebouncedValue } from '../ui/kit.tsx'
import {
  EMPTY_MESSAGE_LIST_WINDOW,
  MESSAGE_LIST_PAGE_SIZE,
  appendMessageListWindow,
  countStatus,
  localImageKey,
  mergeMessageListRecordUpdates,
  mergeMessageListRefresh,
  nextMessageListPageSize,
  replaceMessageListWindow,
  type MessageListWindowState,
} from './message-list-view.ts'

/**
 * 自动刷新只作为事件推送丢失时的兜底；正常更新由 `MESSAGE_LIST_UPDATED_EVENT` 立即触发。
 * 5 秒一次会反复读取最多 500 条完整记录（含附件 JSON），与事件通道重复。
 */
export const MESSAGE_LIST_POLL_MS = 30_000
/** 带 jobId 的 queued/running 记录自动查询；单拍最多 10 条，避免长列表出网风暴。 */
export const MESSAGE_LIST_JOB_POLL_MS = 12_000
const MESSAGE_LIST_JOB_POLL_LIMIT = 10

function refreshableRecordIds(records: readonly MessageListRecord[]): number[] {
  const ids: number[] = []
  for (const record of records) {
    if (
      record.status !== 'pending'
      && record.status !== 'dispatching'
      && record.status !== 'queued'
      && record.status !== 'running'
    ) continue
    ids.push(record.id)
  }
  return ids
}

interface MessageListFilters {
  query: string
  status: '' | MessageListStatus
  source: '' | MessageListSource
}

function listMessageListPage(
  filters: MessageListFilters,
  options: { limit: number; ids?: number[]; cursor?: string },
): ReturnType<typeof apiListMessageListRecords> {
  return apiListMessageListRecords({
    ...(filters.query === '' ? {} : { search: filters.query }),
    ...(filters.status === '' ? {} : { status: filters.status }),
    ...(filters.source === '' ? {} : { source: filters.source }),
    ...(options.ids === undefined ? {} : { ids: options.ids }),
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    limit: options.limit,
  })
}

async function refreshDeepMessageListRecords(
  window: MessageListWindowState,
  filters: MessageListFilters,
  shouldContinue: () => boolean,
  readWindow: () => MessageListWindowState,
  commit: (window: MessageListWindowState) => void,
): Promise<void> {
  if (window.items.length <= MESSAGE_LIST_PAGE_SIZE) return
  const ids = refreshableRecordIds(window.items.slice(MESSAGE_LIST_PAGE_SIZE))
  for (let offset = 0; offset < ids.length; offset += MESSAGE_LIST_PAGE_SIZE) {
    if (!shouldContinue()) return
    const batchIds = ids.slice(offset, offset + MESSAGE_LIST_PAGE_SIZE)
    try {
      const refreshed = await listMessageListPage(filters, {
        ids: batchIds,
        limit: batchIds.length,
      })
      if (!shouldContinue()) return
      if (refreshed.readError !== undefined) continue
      commit(mergeMessageListRecordUpdates(readWindow(), refreshed, batchIds))
    } catch {
      // Deep-page status refresh is best-effort; keep the current window.
    }
  }
}

interface RefreshOptions {
  /** 静默刷新不翻加载态、不清旧内容，失败也保留当前视图。 */
  silent?: boolean
  /** 主动刷新/筛选变化必须回第一页；静默回源默认原位合并。 */
  reset?: boolean
}

interface RecordsRefreshFlight {
  queryKey: string
  promise: Promise<void>
  manual: boolean
  reset: boolean
  phase: 'first-page' | 'deep'
}

function sameRecords(prev: MessageListRecord[], next: MessageListRecord[]): boolean {
  if (prev.length !== next.length) return false
  return prev.every((row, i) => {
    const fresh = next[i]
    return fresh !== undefined
      && row.id === fresh.id
      && row.updatedAt === fresh.updatedAt
      && row.replyId === fresh.replyId
      && row.status === fresh.status
      && row.attempts === fresh.attempts
      && row.error === fresh.error
  })
}

function sameRules(prev: MessageListRule[], next: MessageListRule[]): boolean {
  if (prev.length !== next.length) return false
  return prev.every((row, i) => {
    const fresh = next[i]
    return fresh !== undefined
      && row.id === fresh.id
      && row.updatedAt === fresh.updatedAt
      && row.chatName === fresh.chatName
      && row.targetName === fresh.targetName
      && row.webhookUrl === fresh.webhookUrl
      && row.greetingText === fresh.greetingText
      && row.note === fresh.note
      && row.enabled === fresh.enabled
  })
}

function sameWindow(prev: MessageListWindowState, next: MessageListWindowState): boolean {
  return sameRecords(prev.items, next.items)
    && prev.total === next.total
    && prev.nextCursor === next.nextCursor
    && prev.hasMore === next.hasMore
    && prev.truncated === next.truncated
    && prev.windowCapped === next.windowCapped
}

function windowOverlapsSnapshot(
  current: readonly MessageListRecord[],
  snapshot: readonly MessageListRecord[],
): boolean {
  const ids = new Set(current.map((record) => record.id))
  return snapshot.some((record) => ids.has(record.id))
}

interface MessageListRecordsData {
  records: MessageListRecord[]
  recordTotal: number
  hasMore: boolean
  loadingMore: boolean
  loadMoreError: string
  loadMore: () => void
  windowCapped: boolean
  truncated: boolean
  search: string
  setSearch: (value: string) => void
  status: '' | MessageListStatus
  setStatus: (value: '' | MessageListStatus) => void
  source: '' | MessageListSource
  setSource: (value: '' | MessageListSource) => void
  loadingRecords: boolean
  readError: string
  refreshRecords: (options?: RefreshOptions) => Promise<void>
}

function useMessageListRecordsData(): MessageListRecordsData {
  // 记录、总数、游标和窗口边界必须同源更新，避免分页中间帧出现
  // “新列表 + 旧 total/游标”的双份状态。
  const [recordWindow, setRecordWindow] = useState<MessageListWindowState>(EMPTY_MESSAGE_LIST_WINDOW)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'' | MessageListStatus>('')
  const [source, setSource] = useState<'' | MessageListSource>('')
  const [loadingRecords, setLoadingRecords] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [readError, setReadError] = useState('')
  const [loadMoreError, setLoadMoreError] = useState('')
  const recordsSeq = useRef(0)
  const recordsRefreshQueued = useRef(false)
  const refreshFlightRef = useRef<RecordsRefreshFlight | null>(null)
  const loadingMoreRef = useRef(false)
  const loadMoreTokenRef = useRef(0)
  const recordWindowRef = useRef<MessageListWindowState>(EMPTY_MESSAGE_LIST_WINDOW)
  const mountedRef = useRef(true)
  const refreshRecordsLatestRef = useRef<((options?: RefreshOptions) => Promise<void>) | null>(null)
  const query = useDebouncedValue(search, 250).trim()
  const queryKey = query + '\u0000' + status + '\u0000' + source
  const queryKeyRef = useRef(queryKey)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      recordsSeq.current += 1
      loadMoreTokenRef.current += 1
      loadingMoreRef.current = false
      recordsRefreshQueued.current = false
      refreshFlightRef.current = null
    }
  }, [])

  const commitRecordWindow = useCallback((next: MessageListWindowState): void => {
    if (!mountedRef.current) return
    recordWindowRef.current = next
    setRecordWindow((prev) => (sameWindow(prev, next) ? prev : next))
  }, [])

  /** 取消在途续页；筛选、刷新或新查询都不能让旧游标追加进新结果。 */
  const invalidateLoadMore = useCallback((): void => {
    loadMoreTokenRef.current += 1
    loadingMoreRef.current = false
    if (mountedRef.current) setLoadingMore(false)
  }, [])

  // 搜索/筛选一旦变化，旧窗口立即失效；不能在新筛选下短暂显示旧数据。
  useEffect(() => {
    if (queryKeyRef.current === queryKey) return
    queryKeyRef.current = queryKey
    recordsSeq.current += 1
    recordsRefreshQueued.current = false
    refreshFlightRef.current = null
    invalidateLoadMore()
    commitRecordWindow(EMPTY_MESSAGE_LIST_WINDOW)
    setReadError('')
    setLoadMoreError('')
  }, [commitRecordWindow, invalidateLoadMore, queryKey])

  const scheduleQueuedRefresh = useCallback((): void => {
    if (!mountedRef.current || !recordsRefreshQueued.current) return
    recordsRefreshQueued.current = false
    queueMicrotask(() => {
      if (!mountedRef.current) return
      void refreshRecordsLatestRef.current?.({ silent: true })
    })
  }, [])

  const refreshRecords = useCallback((options: RefreshOptions = {}): Promise<void> => {
    const silent = options.silent === true
    if (!mountedRef.current) return Promise.resolve()

    const currentFlight = refreshFlightRef.current
    if (currentFlight?.queryKey === queryKey) {
      if (silent) {
        // 事件发生在当前请求开始之后，完成后补一拍，避免丢失最后一次更新。
        recordsRefreshQueued.current = true
        return currentFlight.promise
      }
      if (currentFlight.phase === 'first-page') {
        // 写操作通常先广播事件、再显式刷新；复用同一首屏请求，避免双读。
        if (!currentFlight.manual) {
          currentFlight.manual = true
          if (mountedRef.current) {
            setLoadingRecords(true)
            setReadError('')
          }
        }
        // 手动刷新复用首屏请求时仍保留“回到最新一页”的语义。
        currentFlight.reset = true
        invalidateLoadMore()
        return currentFlight.promise
      }
      // 深页批次已开始：手动刷新必须立即建立新代次，不能等旧批次跑完。
    }

    // 后台刷新让位给用户续页；结束后由 loadMore 的 finally 触发一次尾部补刷。
    if (silent && loadingMoreRef.current) {
      recordsRefreshQueued.current = true
      return Promise.resolve()
    }

    const seq = ++recordsSeq.current
    if (!silent) {
      recordsRefreshQueued.current = false
      invalidateLoadMore()
    }
    if (!silent) {
      setLoadingRecords(true)
      setReadError('')
      setLoadMoreError('')
    }

    const flight: RecordsRefreshFlight = {
      queryKey,
      promise: Promise.resolve(),
      manual: !silent,
      reset: !silent || options.reset === true,
      phase: 'first-page',
    }
    const promise = (async (): Promise<void> => {
      try {
        const snap = await listMessageListPage({ query, status, source }, {
          limit: MESSAGE_LIST_PAGE_SIZE,
        })
        if (!mountedRef.current || seq !== recordsSeq.current) return
        // 静默回源失败不把用户正在看的列表替换成空态/错误页；手动刷新仍会明确报错。
        if (snap.readError) {
          if (flight.manual) setReadError(snap.readError)
          return
        }

        const current = recordWindowRef.current
        // 深页窗口与最新第一页完全脱节时，继续保留旧窗口会永久显示陈旧数据。
        // 此时安全退回最新一页，让用户从稳定游标重新加载更早记录。
        const merge = !flight.reset
          && current.items.length > MESSAGE_LIST_PAGE_SIZE
          && windowOverlapsSnapshot(current.items, snap.items)
        const nextWindow = merge
          ? mergeMessageListRefresh(current, snap)
          : replaceMessageListWindow(snap)
        commitRecordWindow(nextWindow)
        setReadError('')

        // 第一页刷新只能覆盖最新记录。深页里仍在 pending/dispatching 的少量记录
        // 必须按 id 定向回源，否则投递完成事件到达后状态会一直停留在旧值。
        if (!flight.reset && nextWindow.items.length > MESSAGE_LIST_PAGE_SIZE) {
          flight.phase = 'deep'
          await refreshDeepMessageListRecords(
            nextWindow,
            { query, status, source },
            () => mountedRef.current && seq === recordsSeq.current,
            () => recordWindowRef.current,
            commitRecordWindow,
          )
        }
      } catch (e) {
        if (mountedRef.current && seq === recordsSeq.current && flight.manual) {
          setReadError('消息列表读取失败：' + (e as Error).message)
        }
      }
    })()
    flight.promise = promise
    refreshFlightRef.current = flight
    void promise.finally(() => {
      if (refreshFlightRef.current !== flight) return
      refreshFlightRef.current = null
      if (mountedRef.current) setLoadingRecords(false)
      scheduleQueuedRefresh()
    })
    return promise
  }, [
    commitRecordWindow,
    invalidateLoadMore,
    query,
    queryKey,
    scheduleQueuedRefresh,
    source,
    status,
  ])
  refreshRecordsLatestRef.current = refreshRecords

  /**
   * 只取游标之后的下一页。请求期间用 ref 防止连点；筛选/刷新会换 token，
   * 旧请求即使晚到也不能把旧筛选结果拼到新窗口里。
  */
  const loadMore = useCallback((): void => {
    if (!mountedRef.current) return
    const current = recordWindowRef.current
    const cursor = current.nextCursor
    if (cursor === undefined || current.windowCapped || loadingMoreRef.current) return
    const limit = nextMessageListPageSize(current.items.length)
    if (limit <= 0) return
    const seq = recordsSeq.current
    const token = ++loadMoreTokenRef.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    setLoadMoreError('')
    void (async (): Promise<void> => {
      try {
        const page = await listMessageListPage({ query, status, source }, {
          limit,
          cursor,
        })
        if (seq !== recordsSeq.current || token !== loadMoreTokenRef.current) return
        if (page.readError !== undefined) {
          if (mountedRef.current) setLoadMoreError(page.readError)
          return
        }
        commitRecordWindow(appendMessageListWindow(recordWindowRef.current, page))
      } catch (e) {
        if (mountedRef.current && seq === recordsSeq.current && token === loadMoreTokenRef.current) {
          setLoadMoreError('加载更多失败：' + (e as Error).message)
        }
      } finally {
        if (token === loadMoreTokenRef.current) {
          loadingMoreRef.current = false
          if (mountedRef.current) setLoadingMore(false)
          scheduleQueuedRefresh()
        }
      }
    })()
  }, [commitRecordWindow, query, scheduleQueuedRefresh, source, status])

  useEffect(() => { void refreshRecords() }, [refreshRecords])

  return {
    records: recordWindow.items,
    recordTotal: recordWindow.total,
    hasMore: recordWindow.hasMore,
    loadingMore,
    loadMoreError,
    loadMore,
    windowCapped: recordWindow.windowCapped,
    truncated: recordWindow.truncated,
    search,
    setSearch,
    status,
    setStatus,
    source,
    setSource,
    loadingRecords,
    readError,
    refreshRecords,
  }
}

function useMessageListRulesData(): {
  rules: MessageListRule[]
  rulesTotal: number
  loadingRules: boolean
  rulesReadError: string
  refreshRules: (options?: RefreshOptions) => Promise<void>
} {
  const [rules, setRules] = useState<MessageListRule[]>([])
  const [rulesTotal, setRulesTotal] = useState(0)
  const [loadingRules, setLoadingRules] = useState(false)
  const [rulesReadError, setRulesReadError] = useState('')
  const rulesSeq = useRef(0)
  const rulesInFlight = useRef(0)
  const rulesRefreshQueued = useRef(false)
  const mountedRef = useRef(true)
  const refreshRulesLatestRef = useRef<((options?: RefreshOptions) => Promise<void>) | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      rulesSeq.current += 1
      rulesRefreshQueued.current = false
    }
  }, [])

  const refreshRules = useCallback(async (options: RefreshOptions = {}): Promise<void> => {
    if (!mountedRef.current) return
    const silent = options.silent === true
    if (silent && rulesInFlight.current > 0) {
      rulesRefreshQueued.current = true
      return
    }
    const seq = ++rulesSeq.current
    rulesInFlight.current += 1
    if (!silent) {
      setLoadingRules(true)
      setRulesReadError('')
    }
    try {
      const snap = await apiListMessageListRules()
      if (!mountedRef.current || seq !== rulesSeq.current) return
      if (silent && snap.readError) return
      setRules((prev) => sameRules(prev, snap.items) ? prev : snap.items)
      setRulesTotal((prev) => prev === snap.total ? prev : snap.total)
      setRulesReadError(snap.readError ?? '')
    } catch (e) {
      if (mountedRef.current && seq === rulesSeq.current && !silent) {
        setRules([])
        setRulesTotal(0)
        setRulesReadError('规则读取失败：' + (e as Error).message)
      }
    } finally {
      rulesInFlight.current = Math.max(0, rulesInFlight.current - 1)
      if (mountedRef.current && seq === rulesSeq.current) setLoadingRules(false)
      if (rulesRefreshQueued.current && mountedRef.current) {
        rulesRefreshQueued.current = false
        queueMicrotask(() => {
          if (!mountedRef.current) return
          void refreshRulesLatestRef.current?.({ silent: true })
        })
      }
    }
  }, [])
  refreshRulesLatestRef.current = refreshRules

  useEffect(() => { void refreshRules() }, [refreshRules])

  return { rules, rulesTotal, loadingRules, rulesReadError, refreshRules }
}

function useMessageListWebhookInfo(canWrite: boolean): {
  webhookInfo: MessageListWebhookInfo | null
  refreshWebhookInfo: () => Promise<void>
} {
  const [webhookInfo, setWebhookInfo] = useState<MessageListWebhookInfo | null>(null)
  const refreshWebhookInfo = useCallback(async (): Promise<void> => {
    if (!canWrite) {
      setWebhookInfo(null)
      return
    }
    try {
      setWebhookInfo(await apiGetMessageListWebhookInfo())
    } catch (e) {
      setWebhookInfo({
        enabled: false,
        url: '',
        getExample: '',
        postExample: '',
        version: '',
        error: (e as Error).message,
      })
    }
  }, [canWrite])

  useEffect(() => { void refreshWebhookInfo() }, [refreshWebhookInfo])
  return { webhookInfo, refreshWebhookInfo }
}

function useMessageListThumbnails(records: MessageListRecord[]): Record<string, string> {
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const localImageItems = useMemo(() => {
    const seen = new Set<string>()
    const out: Array<{ username: string; localId: number }> = []
    for (const record of records) {
      for (const image of record.images) {
        if (image.localId === undefined || image.localId <= 0 || record.chatUsername === '') continue
        const key = localImageKey(record.chatUsername, image.localId)
        if (seen.has(key)) continue
        seen.add(key)
        out.push({ username: record.chatUsername, localId: image.localId })
        if (out.length >= 120) return out
      }
    }
    return out
  }, [records])
  const localImageSignature = localImageItems.map((item) => localImageKey(item.username, item.localId)).join('|')

  useEffect(() => {
    if (localImageItems.length === 0) {
      setThumbs({})
      return
    }
    let alive = true
    void apiGetImageDataUrlsBatch(localImageItems).then((items) => {
      if (!alive) return
      const next: Record<string, string> = {}
      for (const item of items) {
        if (item.url) next[localImageKey(item.username, item.localId)] = item.url
      }
      setThumbs(next)
    }).catch(() => {
      if (alive) setThumbs({})
    })
    return () => { alive = false }
  // 用签名字符串而不是数组引用，避免每次 refresh 生成新数组导致重复取图。
  }, [localImageSignature])

  return thumbs
}

export function useMessageListData(canWrite: boolean) {
  const recordsState = useMessageListRecordsData()
  const rulesState = useMessageListRulesData()
  const { webhookInfo, refreshWebhookInfo } = useMessageListWebhookInfo(canWrite)
  const thumbs = useMessageListThumbnails(recordsState.records)

  const refreshAll = useCallback(async (): Promise<void> => {
    await Promise.all([
      recordsState.refreshRecords(),
      rulesState.refreshRules(),
      refreshWebhookInfo(),
    ])
  }, [recordsState.refreshRecords, refreshWebhookInfo, rulesState.refreshRules])

  const refreshAllSilent = useCallback(async (): Promise<void> => {
    await Promise.all([
      recordsState.refreshRecords({ silent: true }),
      rulesState.refreshRules({ silent: true }),
    ])
  }, [recordsState.refreshRecords, rulesState.refreshRules])

  useEffect(() => {
    const refresh = (): void => { void refreshAllSilent() }
    window.addEventListener(MESSAGE_LIST_UPDATED_EVENT, refresh)
    return () => { window.removeEventListener(MESSAGE_LIST_UPDATED_EVENT, refresh) }
  }, [refreshAllSilent])

  // 页面可见时每 30 秒兜底静默回源；事件仍会立即刷新。切到后台停表，回来先补一次。
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    const stop = (): void => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }
    const start = (): void => {
      stop()
      if (document.visibilityState !== 'hidden') {
        timer = setInterval(() => { void refreshAllSilent() }, MESSAGE_LIST_POLL_MS)
      }
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        stop()
        return
      }
      void refreshAllSilent()
      start()
    }
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [refreshAllSilent])

  const downstreamPollKey = useMemo(
    () => recordsState.records
      .filter((record) => (
        (record.status === 'queued' || record.status === 'running')
        && record.jobId !== undefined
        && record.jobId !== ''
      ))
      .slice(0, MESSAGE_LIST_JOB_POLL_LIMIT)
      .map((record) => record.id)
      .join(','),
    [recordsState.records],
  )

  useEffect(() => {
    if (!canWrite || downstreamPollKey === '') return
    let stopped = false
    let busy = false
    const tick = async (): Promise<void> => {
      if (stopped || busy) return
      busy = true
      let refreshed = false
      try {
        for (const rawId of downstreamPollKey.split(',')) {
          if (stopped) return
          const id = Number(rawId)
          if (!Number.isSafeInteger(id) || id <= 0) continue
          try {
            const result = await apiQueryMessageListWebhookJob({ recordId: id })
            if (result.ok) refreshed = true
          } catch {
            // 单条失败不阻断其它任务；下一拍再试，人工“查任务”仍可立即重试。
          }
        }
        if (refreshed && !stopped) void recordsState.refreshRecords({ silent: true })
      } finally {
        busy = false
      }
    }
    const first = setTimeout(() => { void tick() }, 1_500)
    const timer = setInterval(() => { void tick() }, MESSAGE_LIST_JOB_POLL_MS)
    return () => {
      stopped = true
      clearTimeout(first)
      clearInterval(timer)
    }
  }, [canWrite, downstreamPollKey, recordsState.refreshRecords])

  const stats = useMemo(() => ({
    success: countStatus(recordsState.records, 'success'),
    failed: countStatus(recordsState.records, 'failed'),
    pending: countStatus(recordsState.records, 'pending'),
    queued: countStatus(recordsState.records, 'queued'),
    running: countStatus(recordsState.records, 'running'),
  }), [recordsState.records])

  return {
    ...recordsState,
    rules: rulesState.rules,
    rulesTotal: rulesState.rulesTotal,
    webhookInfo,
    loadingRules: rulesState.loadingRules,
    rulesReadError: rulesState.rulesReadError,
    thumbs,
    stats,
    refreshRecords: recordsState.refreshRecords,
    refreshRules: rulesState.refreshRules,
    refreshWebhookInfo,
    refreshAll,
  }
}
