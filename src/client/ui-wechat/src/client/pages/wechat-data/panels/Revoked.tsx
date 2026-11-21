/**
 * 撤回记录面板 — React 版，忠实迁移 RevokedMessages.svelte：只读展示被撤回
 * 消息（sender / type_label / content / create_time），类型构成 + 发送者
 * Top5 统计 + 可展开内容列表 + 隐私横幅。走 Remote（getRevoked）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ListSentinel, ListSkeleton, ProgressiveListSpacer, useLazySentinel, usePagedList, useProgressiveList } from './hooks.tsx'
import { apiGetRevoked } from '../api.ts'
import type { RevokedItem } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey, PanelHeader, SearchInput, Segmented, Toolbar, useDebouncedValue } from '../ui/kit.tsx'
import css from './list-panel.module.css'
import { fmtDateTimeSec } from '../utils/format.ts'
import kitCss from '../ui/kit.module.css'
import { Avatar } from './chats-support.tsx'
import { IdentityName } from './identity.tsx'
import { RevokedContent } from './revoked-content.tsx'
import { withEnterprise } from './enterprise-identity.ts'

/**
 * 空态：说清「为空」的三种可能，而不是只说"没有"。
 *
 * 抽成组件只为让 `RevokedPanel` 留在函数尺寸棘轮（250 行）以内。
 * 最关键的是第二条 —— 微信撤回是**就地改写**，刚发出就撤回的消息可能在归档前已被抹掉。
 */
function RevokedLanding({ loading, onRefresh, onOpenSettings }: {
  loading: boolean
  onRefresh: () => void
  onOpenSettings?: (section?: string) => void
}): React.JSX.Element {
  return (
    <div className={css.rvLand}>
      <div className={css.rvLandTitle}>暂无撤回消息记录</div>
      <div className={css.rvLandDesc}>本页读的是本地归档：同步时先存一份原文，微信把消息改写成提示时原文仍在。为空通常是三种情况之一：</div>
      <ul className={css.rvLandList}>
        <li><b>本机确实没人撤回过</b> —— 那就没什么可看的</li>
        <li><b>归档没赶上</b> —— 刚发出就撤回的消息，可能在归档前已被改写成提示</li>
        <li><b>解密库还没同步</b> —— 去「设置 → 数据配置」重新解密后再回来刷新</li>
      </ul>
      <div className={css.rvLandActions}>
        <button type="button" className={css.catBtn} data-active="true" onClick={onRefresh} disabled={loading}>刷新重读</button>
        <button type="button" className={css.catBtn} onClick={() => { onOpenSettings?.('detect') }}>去数据配置</button>
      </div>
      <div className={kitCss.textMeta}>有数据时这里会按发送者/类型/时间列出每条撤回记录，可展开看原文，并给出「撤回最多」排行。</div>
    </div>
  )
}

/**
 * Render the revoked-messages panel.
 * @returns the revoked element tree.
 */
export function RevokedPanel({ onOpenSettings }: { onOpenSettings?: (section?: string) => void } = {}): React.JSX.Element {
  const [items, setItems] = useState<readonly RevokedItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  /** 读失败与「确无撤回消息」分开（W3-11.4）。 */
  const [readError, setReadError] = useState('')
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<string | null>(null)

  // 关键词交给**服务端**（类型筛选后端没有参数，仍走「一次性取回后本端筛」那条路）。
  const kw = useDebouncedValue(search, 250).trim()
  const searching = kw !== ''
  const kwOpt = kw ? { q: kw } : {}

  const pager = usePagedList<RevokedItem>({
    pageSize: 100,
    /*
     * 撤回要"刚发生就能看见"：默认 30s 的刷新节流太长，而每次查询本身很便宜
     * （归档按分片签名跳过、提示行按目录签名缓存，真机一次十来毫秒）。
     * 5s 足够让新撤回在两次同步节拍内出现，又不会把 SQLite 拖满。
     */
    refreshMinIntervalMs: 5_000,
    fetchPage: async (offset, limit) => {
      /*
       * 第一页走 `fresh`：绕过「先画旧值、后台复验」的快照缓存。
       * 那条路径的复验结果只通知 `subscribeSnapshot` 的订阅者，分页列表不订阅，
       * 于是新撤回要等下一次数据事件才上屏（实测 10–40s）。翻页仍用缓存。
       */
      const env = await apiGetRevoked({ limit, offset, ...kwOpt, ...(offset === 0 ? { fresh: true } : {}) })
      // W3-11.4：「归档库还没建」与「没有撤回消息」分开说。
      setReadError(env.readError ?? '')
      return { items: env.items, total: env.total }
    },
  })

  useEffect(() => {
    if (typeFilter) {
      let cancelled = false
      setLoading(true)
      setError(null)
      void apiGetRevoked({ limit: 500, ...kwOpt, fresh: true })
        .then((env) => {
          if (cancelled) return
          setItems(env.items)
          setTotal(env.total)
          setReadError(env.readError ?? '')
        })
        .catch((e: unknown) => { if (!cancelled) setError((e as Error).message) })
        .finally(() => { if (!cancelled) setLoading(false) })
      return () => { cancelled = true }
    }
    pager.reset()
    return undefined
  }, [kw, kwOpt.q, typeFilter, pager.reset])

  useEffect(() => {
    if (typeFilter) return
    setItems(pager.items)
    setTotal(pager.total)
    setLoading(pager.loading)
    setError(pager.error)
  }, [typeFilter, pager.items, pager.total, pager.loading, pager.error])

  const refresh = useCallback((): void => {
    setError(null)
    if (typeFilter) {
      setLoading(true)
      void apiGetRevoked({ limit: 500, ...kwOpt, fresh: true })
        .then((env) => { setItems(env.items); setTotal(env.total); setReadError(env.readError ?? '') })
        .catch((e: unknown) => { setError((e as Error).message) })
        .finally(() => { setLoading(false) })
    } else {
      pager.reset()
    }
  }, [typeFilter, kwOpt.q, pager.reset])

  const revokedScrollRef = useRef<HTMLDivElement | null>(null)
  const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore) pager.loadMore() }, '600px 0px', () => revokedScrollRef.current, pager.items.length)

  const typeCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const it of items) {
      const k = it.type_label || '未知'
      m.set(k, (m.get(k) ?? 0) + 1)
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1])
  }, [items])

  // 关键字已由服务端过滤；这里只保留类型筛选。
  const filtered = useMemo(() => {
    if (!typeFilter) return items
    return items.filter((it) => (it.type_label || '未知') === typeFilter)
  }, [items, typeFilter])

  const senderTop = useMemo(() => {
    const m = new Map<string, { username: string; name: string; label: string; count: number }>()
    for (const it of items) {
      const username = it.sender_username ?? ''
      const name = it.sender || '未知'
      const key = username || name
      const current = m.get(key)
      const label = withEnterprise(name, it.senderEnterpriseName)
      m.set(key, {
        username,
        name,
        label: current?.label || label,
        count: (current?.count ?? 0) + 1,
      })
    }
    return Array.from(m.values()).sort((a, b) => b.count - a.count).slice(0, 5)
  }, [items])

  /** 展开状态用稳定记录键，不能跟着筛选后的数组下标走。 */
  const recordKey = (it: RevokedItem): string => [
    it.session_username ?? '',
    it.local_id ?? '',
    it.server_id ?? '',
    it.create_time,
    it.type_label,
    it.content.slice(0, 80),
  ].join('\u0000')

  const toggle = (key: string): void => {
    const next = new Set(expanded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setExpanded(next)
  }

  const {
    start: rvStart,
    count: rvCount,
    beforeHeight: rvBeforeHeight,
    sentinelRef: rvSentinel,
    topSentinelRef: rvTopSentinel,
  } = useProgressiveList(filtered.length, 80, {
    maxCount: 240,
    resetKey: `${search}\u0000${typeFilter ?? ''}`,
    listRef: revokedScrollRef,
  })

  return (
    <div className={css.panel}>
      <PanelHeader
        title="撤回"
        desc="本地归档 · 只读"
        actions={(
          <button type="button" className={css.catBtn} onClick={refresh} disabled={loading}>{loading ? '读取中…' : '刷新'}</button>
        )}
      />
      {/* 隐私口径降为一行灰字（NV-09）：不再是一块与全站多处重复的横幅。 */}
      <div className={`${kitCss.textMeta} ${css.rvNoticeText}`}>数据仅来自本机解密副本，不联网、不上传。</div>
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {readError && <div className={kitCss.error} role="alert">{readError}</div>}
      {!error && !readError && loading && items.length === 0 && <ListSkeleton rows={8} />}
      {!error && !readError && !loading && items.length === 0 && (
        <RevokedLanding
          loading={loading}
          onRefresh={refresh}
          {...(onOpenSettings === undefined ? {} : { onOpenSettings })}
        />
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
          <div className={css.hd}>
            <span className={kitCss.textMeta}>共 {total} 条被撤回消息（已加载 {items.length}）</span>
            {senderTop.length > 0 && (
              <span className={`${kitCss.textMeta} ${css.rvTopList}`}>
                <span>撤回最多：</span>
                {senderTop.map((it, idx) => (
                  <span key={`${it.username}-${it.name}-${String(idx)}`} className={css.rvTopItem}>
                    <IdentityName
                      className={css.rvTopIdentity}
                      name={it.name}
                      username={it.username}
                      size={16}
                    >
                      {it.label}
                    </IdentityName>
                    <span className={css.rvTopCount}>{it.count}</span>
                  </span>
                ))}
              </span>
            )}
          </div>
          <div ref={revokedScrollRef} className={`${css.scroll} ${css.rvScroll}`}>
            {filtered.length === 0 && <div className={css.empty}>无匹配记录</div>}
            <ProgressiveListSpacer height={rvBeforeHeight} topSentinelRef={rvTopSentinel} />
            {filtered.slice(rvStart, rvCount).map((it, idx) => {
              const itemIndex = rvStart + idx
              const key = recordKey(it)
              const open = expanded.has(key)
              const senderLabel = withEnterprise(it.sender || '未知', it.senderEnterpriseName)
              const sessionLabel = it.session_name
                ? withEnterprise(it.session_name, it.enterpriseName)
                : ''
              const rowLabel = `${senderLabel} · ${it.type_label}，${open ? '收起' : '展开'}详情`
              return (
                <div
                  key={`${key}-${itemIndex}`}
                  className={`${css.row} ${css.rvRow}`}
                  data-progressive-item={itemIndex}
                  aria-expanded={open}
                  {...clickableKey(() => { toggle(key) }, { label: rowLabel })}
                >
                  <div className={css.rvRowHd}>
                    <Avatar name={it.sender || '未知'} username={it.sender_username ?? ''} size={28} />
                    <span className={css.rowName}>{senderLabel}</span>
                    <span className={css.cite}>{it.type_label}</span>
                    {it.session_is_group && sessionLabel && (
                      <IdentityName
                        className={css.rvSessionIdentity}
                        textClassName={css.rvSession}
                        name={it.session_name ?? ''}
                        username={it.session_username ?? ''}
                        size={16}
                      >
                        {sessionLabel}
                      </IdentityName>
                    )}
                    <span className={`${css.rowTime} ${css.rvTimePush}`}>{fmtDateTimeSec(it.create_time)}</span>
                    <span className={css.rvChevron} aria-hidden="true">{open ? '▾' : '▸'}</span>
                  </div>
                  <RevokedContent item={it} open={open} />
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
