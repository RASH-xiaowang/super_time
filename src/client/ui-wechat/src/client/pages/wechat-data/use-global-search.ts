/**
 * 全局搜索的请求状态机。
 *
 * 单独成 hook 是为了能直接验证两条竞态约束：
 *  - 每次查询有独立序号，晚到的旧响应不能覆盖新响应；
 *  - 每个在飞请求有独立 jobId，换词/清空/卸载时只取消自己那一轮。
 *
 * 搜索框、键盘快捷键与导航栏展开逻辑仍放在面板外壳里，这里只负责请求生命周期。
 */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { UnifiedSearchSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { apiCancelSearch, apiGetSessions, apiSearchUnified } from './api.ts'
import type { GlobalSearchResultsState } from './panels/global-search-results.tsx'
import { SEARCH_QUERY_EVENT, searchQueryFromEvent } from './panels/search-events.ts'

const EMPTY_RESULTS: GlobalSearchResultsState = {
  sessions: [],
  hits: [],
  contacts: [],
  moments: [],
  favorites: [],
  files: [],
  records: [],
}

export function useGlobalSearchState(
  navOpen: boolean,
  setNavOpen: Dispatch<SetStateAction<boolean>>,
) {
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const searchSeqRef = useRef(0)
  const [searchResults, setSearchResults] = useState<GlobalSearchResultsState>(EMPTY_RESULTS)
  const gsQuery = searchQuery.trim()

  useEffect(() => {
    const query = searchQuery.trim()
    let activeJobId = ''
    let activeSessionJobId = ''
    const cancelActiveJob = (): void => {
      // 会话关键词和统一搜索并行；两者各自持有 jobId，避免同一 jobId 在搜索槽里
      // 互相顶掉。取消时两把令牌都收回。
      const jobIds = [activeJobId, activeSessionJobId].filter((jobId) => jobId !== '')
      activeJobId = ''
      activeSessionJobId = ''
      for (const jobId of jobIds) {
        void apiCancelSearch({ jobId }).catch(() => undefined)
      }
    }
    if (!query) {
      searchSeqRef.current += 1
      setSearchResults(EMPTY_RESULTS)
      setSearchLoading(false)
      return cancelActiveJob
    }
    setSearchLoading(true)
    const sequence = ++searchSeqRef.current
    const timer = window.setTimeout(() => {
      activeJobId = 'global-search-' + (globalThis.crypto?.randomUUID?.() ?? `${String(Date.now())}-${String(sequence)}`)
      activeSessionJobId = activeJobId + '-sessions'
      void Promise.all([
        apiGetSessions({
          keyword: query,
          limit: 8,
          jobId: activeSessionJobId,
        }).catch((): { sessions: never[]; total: number } => ({ sessions: [], total: 0 })),
        apiSearchUnified({ query, limit: 8, jobId: activeJobId }).catch((error): UnifiedSearchSnapshot => ({
          query,
          messages: [],
          contacts: [],
          moments: [],
          favorites: [],
          files: [],
          records: [],
          readError: `搜索请求失败（${(error as Error).message}）—— 这不是「没有结果」`,
        })),
      ]).then(([sessionResponse, unified]) => {
        activeJobId = ''
        activeSessionJobId = ''
        if (sequence !== searchSeqRef.current) return
        setSearchResults({
          sessions: sessionResponse.sessions,
          hits: unified.messages,
          contacts: unified.contacts,
          moments: unified.moments,
          favorites: unified.favorites,
          files: unified.files,
          records: unified.records,
          readError: unified.readError,
        })
        setSearchLoading(false)
      })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      searchSeqRef.current += 1
      cancelActiveJob()
    }
  }, [searchQuery])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setNavOpen(true)
        window.requestAnimationFrame(() => { searchInputRef.current?.focus() })
        setSearchOpen(true)
      } else if (event.key === 'Escape') {
        setSearchOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [setNavOpen])

  useEffect(() => {
    const onSearchQuery = (event: Event): void => {
      const query = searchQueryFromEvent(event)
      if (!query) return
      setSearchQuery(query)
      setNavOpen(true)
      window.requestAnimationFrame(() => { searchInputRef.current?.focus() })
      setSearchOpen(true)
    }
    window.addEventListener(SEARCH_QUERY_EVENT, onSearchQuery)
    return () => { window.removeEventListener(SEARCH_QUERY_EVENT, onSearchQuery) }
  }, [setNavOpen])

  useEffect(() => {
    if (!navOpen) setSearchOpen(false)
  }, [navOpen])

  return {
    searchQuery,
    setSearchQuery,
    searchOpen,
    setSearchOpen,
    searchLoading,
    searchInputRef,
    searchResults,
    gsQuery,
  }
}
