/**
 * 撤回记录面板 — React 版，忠实迁移 RevokedMessages.svelte：只读展示被撤回
 * 消息（sender / type_label / content / create_time），类型构成 + 发送者
 * Top5 统计 + 可展开内容列表 + 隐私横幅。走 Remote（getRevoked）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useProgressiveList } from './hooks.tsx'
import { apiGetRevoked } from '../api.ts'
import type { RevokedItem } from '@deepseek-ai/dsh-wechat-data/types'
import { Badge, Card, clickableKey, PanelHeader, SearchInput, Segmented, Toolbar } from '../ui/kit.tsx'
import css from './list-panel.module.css'
import { avatarColors, fmtDateTimeSec } from '../utils/format.ts'
import kitCss from '../ui/kit.module.css'

/**
 * Render the revoked-messages panel.
 * @returns the revoked element tree.
 */
export function RevokedPanel(): React.JSX.Element {
  const [items, setItems] = useState<readonly RevokedItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string | null>(null)

  const pager = usePagedList<RevokedItem>({
    pageSize: 100,
    fetchPage: async (offset, limit) => {
      const env = await apiGetRevoked({ limit, offset })
      return { items: env.items, total: env.total }
    },
  })

  const searching = search.trim() !== ''
  // 普通浏览：分页逐页加载；搜索/类型筛选时一次性拉取 500 条（用户主动操作），保证结果完整。
  useEffect(() => {
    if (searching || typeFilter) {
      let cancelled = false
      setLoading(true)
      setError(null)
      void apiGetRevoked({ limit: 500 })
        .then((env) => {
          if (cancelled) return
          setItems(env.items)
          setTotal(env.total)
        })
        .catch((e: unknown) => { if (!cancelled) setError((e as Error).message) })
        .finally(() => { if (!cancelled) setLoading(false) })
      return () => { cancelled = true }
    }
    pager.reset()
    return undefined
  }, [searching, typeFilter, pager.reset])

  useEffect(() => {
    if (searching || typeFilter) return
    setItems(pager.items)
    setTotal(pager.total)
    setLoading(pager.loading)
    setError(pager.error)
  }, [searching, typeFilter, pager.items, pager.total, pager.loading, pager.error])

  const refresh = useCallback((): void => {
    setError(null)
    if (searching || typeFilter) {
      setLoading(true)
      void apiGetRevoked({ limit: 500 })
        .then((env) => { setItems(env.items); setTotal(env.total) })
        .catch((e: unknown) => { setError((e as Error).message) })
        .finally(() => { setLoading(false) })
    } else {
      pager.reset()
    }
  }, [searching, typeFilter, pager.reset])

  const revokedScrollRef = useRef<HTMLDivElement | null>(null)
  const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore) pager.loadMore() }, '600px 0px', () => revokedScrollRef.current)

  const typeCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const it of items) {
      const k = it.type_label || '未知'
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1])
  }, [items])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return items.filter((it) => {
      if (typeFilter && (it.type_label || '未知') !== typeFilter) return false
      if (!q) return true
      return (it.sender || '').toLowerCase().includes(q) || (it.content || '').toLowerCase().includes(q)
    })
  }, [items, search, typeFilter])

  const senderTop = useMemo(() => {
    const m = new Map<string, number>()
    for (const it of items) {
      const k = it.sender || '未知'
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5)
  }, [items])

  const toggle = (idx: number): void => {
    const next = new Set(expanded)
    if (next.has(idx)) next.delete(idx)
    else next.add(idx)
    setExpanded(next)
  }

  const { count: rvCount, sentinelRef: rvSentinel } = useProgressiveList(filtered.length, 80)

  return (
    <div className={css.panel}>
      <PanelHeader
        title="撤回消息记录"
        desc="微信 4.x 防撤回机制在本机保留的删除缓存 · 只读展示"
        actions={(
          <button type="button" className={css.catBtn} onClick={refresh} disabled={loading}>{loading ? '读取中…' : '刷新'}</button>
        )}
      />
      <div className={`${css.notice} ${css.rvNoticeText}`}>🛡️ 数据仅来自本机微信数据库的解密副本，不联网、不上传。缓存内容与撤回时间由微信客户端写入。</div>
      {error && <div className={kitCss.error} role="alert">⚠️ {error}</div>}
      {!error && loading && items.length === 0 && <ListSkeleton rows={8} />}
      {!error && !loading && items.length === 0 && (
        <div className={css.empty}>
          <p>暂无撤回消息记录</p>
          <p className={kitCss.textMeta}>微信客户端未保留防撤回缓存，或解密库尚未同步最新数据</p>
        </div>
      )}
      {!error && items.length > 0 && (
        <>
          <Toolbar
            left={(
              <SearchInput value={search} onChange={(v) => { setSearch(v) }} placeholder="搜索发送者 / 内容…" ariaLabel="搜索撤回记录" />
            )}
            right={typeCounts.length > 0 ? (
              <Segmented
                options={[{ value: '__all__', label: '全部' }, ...typeCounts.map(([k, n]) => ({ value: k, label: `${k} (${n})` }))]}
                value={typeFilter ?? '__all__'}
                onChange={(v) => { setTypeFilter(v === '__all__' ? null : v) }}
                ariaLabel="类型筛选"
              />
            ) : undefined}
          />
          <div className={css.hd}><span className={kitCss.textMeta}>共 {total} 条被撤回消息（已加载 {items.length}）</span></div>
          {senderTop.length > 0 && (
            <Card title="撤回最多">
              <div className={css.rvFilters}>
                {senderTop.map(([k, n]) => <Badge key={k} tone="cyan" title={`${k} 撤回 ${n} 条`}>{k} {n}</Badge>)}
              </div>
            </Card>
          )}
          <div ref={revokedScrollRef} className={`${css.scroll} ${css.rvScroll}`}>
            {filtered.length === 0 && <div className={css.empty}>无匹配记录</div>}
            {filtered.slice(0, rvCount).map((it, idx) => {
              const open = expanded.has(idx)
              const avatar = avatarColors(it.sender || '?')
              return (
                <div key={`${it.create_time}-${idx}`} className={`${css.row} ${css.rvRow}`} {...clickableKey(() =>{  toggle(idx) })}>
                  <div className={css.rvRowHd}>
                    <span style={{ width: 28, height: 28, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: avatar.color, background: avatar.background }}>{(it.sender || '?').slice(0, 1)}</span>
                    <span className={css.rowName}>{it.sender}</span>
                    <span className={`${css.cite} ${css.rvTypeBadge}`}>{it.type_label}</span>
                    <span className={`${css.rowTime} ${css.rvTimePush}`}>{fmtDateTimeSec(it.create_time)}</span>
                    <span className={css.rowTime}>{open ? '▾' : '▸'}</span>
                  </div>
                  {open && (
                    <div className={css.rvBodyPad}>
                      <div className={css.rvBody}>{it.content}</div>
                      <div className={`${kitCss.textMeta} ${css.rvFootNote}`}>↑ 该内容在微信客户端被撤回，此处为本地缓存副本</div>
                    </div>
                  )}
                </div>
              )
            })}
            {filtered.length > rvCount && <ListSentinel refFn={rvSentinel} />}
            {!searching && !typeFilter && pager.hasMore && <ListSentinel refFn={loadMoreRef} />}
          </div>
        </>
      )}
    </div>
  )
}
