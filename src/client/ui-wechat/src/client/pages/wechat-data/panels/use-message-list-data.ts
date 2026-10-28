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
} from '../api.ts'
import { MESSAGE_LIST_UPDATED_EVENT } from '../message-list-events.ts'
import { useDebouncedValue } from '../ui/kit.tsx'
import { countStatus, localImageKey } from './message-list-view.ts'

/** 自动刷新只回查记录；规则/地址由事件和手动刷新更新。 */
export const MESSAGE_LIST_POLL_MS = 5_000

interface RefreshOptions {
  /** 静默刷新不翻加载态、不清旧内容，失败也保留当前视图。 */
  silent?: boolean
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

export function useMessageListData(canWrite: boolean) {
  const [records, setRecords] = useState<MessageListRecord[]>([])
  const [recordTotal, setRecordTotal] = useState(0)
  const [rules, setRules] = useState<MessageListRule[]>([])
  const [rulesTotal, setRulesTotal] = useState(0)
  const [webhookInfo, setWebhookInfo] = useState<MessageListWebhookInfo | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<'' | MessageListStatus>('')
  const [source, setSource] = useState<'' | MessageListSource>('')
  const [loadingRecords, setLoadingRecords] = useState(false)
  const [loadingRules, setLoadingRules] = useState(false)
  const [readError, setReadError] = useState('')
  const [rulesReadError, setRulesReadError] = useState('')
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const recordsSeq = useRef(0)
  const rulesSeq = useRef(0)
  const recordsInFlight = useRef(0)
  const rulesInFlight = useRef(0)
  const query = useDebouncedValue(search, 250).trim()

  const refreshRecords = useCallback(async (options: RefreshOptions = {}): Promise<void> => {
    const silent = options.silent === true
    // 自动/事件触发的静默回源让位给正在进行的请求，避免同一列表请求叠跑。
    if (silent && recordsInFlight.current > 0) return
    const seq = ++recordsSeq.current
    recordsInFlight.current += 1
    if (!silent) {
      setLoadingRecords(true)
      setReadError('')
    }
    try {
      const snap = await apiListMessageListRecords({
        ...(query === '' ? {} : { search: query }),
        ...(status === '' ? {} : { status }),
        ...(source === '' ? {} : { source }),
        limit: 500,
      })
      if (seq !== recordsSeq.current) return
      // 静默回源失败不把用户正在看的列表替换成空态/错误页；手动刷新仍会明确报错。
      if (silent && snap.readError) return
      setRecords((prev) => sameRecords(prev, snap.items) ? prev : snap.items)
      setRecordTotal((prev) => prev === snap.total ? prev : snap.total)
      setReadError(snap.readError ?? '')
    } catch (e) {
      if (seq === recordsSeq.current && !silent) {
        setReadError('消息列表读取失败：' + (e as Error).message)
      }
    } finally {
      recordsInFlight.current = Math.max(0, recordsInFlight.current - 1)
      if (seq === recordsSeq.current) setLoadingRecords(false)
    }
  }, [query, source, status])

  const refreshRules = useCallback(async (options: RefreshOptions = {}): Promise<void> => {
    const silent = options.silent === true
    if (silent && rulesInFlight.current > 0) return
    const seq = ++rulesSeq.current
    rulesInFlight.current += 1
    if (!silent) {
      setLoadingRules(true)
      setRulesReadError('')
    }
    try {
      const snap = await apiListMessageListRules()
      if (seq !== rulesSeq.current) return
      if (silent && snap.readError) return
      setRules((prev) => sameRules(prev, snap.items) ? prev : snap.items)
      setRulesTotal((prev) => prev === snap.total ? prev : snap.total)
      setRulesReadError(snap.readError ?? '')
    } catch (e) {
      if (seq === rulesSeq.current && !silent) {
        setRules([])
        setRulesTotal(0)
        setRulesReadError('规则读取失败：' + (e as Error).message)
      }
    } finally {
      rulesInFlight.current = Math.max(0, rulesInFlight.current - 1)
      if (seq === rulesSeq.current) setLoadingRules(false)
    }
  }, [])

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

  const refreshAll = useCallback(async (): Promise<void> => {
    await Promise.all([refreshRecords(), refreshRules(), refreshWebhookInfo()])
  }, [refreshRecords, refreshRules, refreshWebhookInfo])

  const refreshAllSilent = useCallback(async (): Promise<void> => {
    await Promise.all([
      refreshRecords({ silent: true }),
      refreshRules({ silent: true }),
    ])
  }, [refreshRecords, refreshRules])

  useEffect(() => { void refreshRecords() }, [refreshRecords])
  useEffect(() => { void refreshRules() }, [refreshRules])
  useEffect(() => { void refreshWebhookInfo() }, [refreshWebhookInfo])

  useEffect(() => {
    const refresh = (): void => { void refreshAllSilent() }
    window.addEventListener(MESSAGE_LIST_UPDATED_EVENT, refresh)
    return () => { window.removeEventListener(MESSAGE_LIST_UPDATED_EVENT, refresh) }
  }, [refreshAllSilent])

  // 页面可见时每 5 秒静默回源；切到后台立即停表，回来先补一次再继续。
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null
    const stop = (): void => {
      if (timer !== null) clearInterval(timer)
      timer = null
    }
    const start = (): void => {
      stop()
      if (document.visibilityState !== 'hidden') {
        timer = setInterval(() => { void refreshRecords({ silent: true }) }, MESSAGE_LIST_POLL_MS)
      }
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'hidden') {
        stop()
        return
      }
      void refreshRecords({ silent: true })
      start()
    }
    start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      stop()
    }
  }, [refreshRecords])

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

  const stats = useMemo(() => ({
    success: countStatus(records, 'success'),
    failed: countStatus(records, 'failed'),
    pending: countStatus(records, 'pending'),
  }), [records])

  return {
    records,
    recordTotal,
    rules,
    rulesTotal,
    webhookInfo,
    search,
    setSearch,
    status,
    setStatus,
    source,
    setSource,
    loadingRecords,
    loadingRules,
    readError,
    rulesReadError,
    thumbs,
    stats,
    refreshRecords,
    refreshRules,
    refreshWebhookInfo,
    refreshAll,
  }
}
