/**
 * 表情面板 — React 版，忠实迁移 WeChatPanel 的 emoticons 页签：自定义表情 /
 * 表情包 分类标签 + 网格（点击复制 MD5），搜索按名称/MD5 过滤。走 Remote
 * （getEmoticons），无 HTTP 依赖。
 */
import { useEffect, useMemo, useState } from 'react'
import { ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useProgressiveList } from './hooks.tsx'
import { apiGetEmoticons } from '../api.ts'
import type { EmoticonsSnapshot, EmoticonItem } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey, EmptyMaybeSyncing, PanelHeader, SearchInput, Segmented, Toolbar } from '../ui/kit.tsx'
import css from './list-panel.module.css'
import kitCss from '../ui/kit.module.css'

/** 表情类型 → 中文标签（1=图片 2=GIF 3=动图）。 */
function typeLabel(t: number | undefined): string {
  if (t === 1) return '图片'
  if (t === 2) return 'GIF'
  if (t === 3) return '动图'
  return ''
}

/**
 * Render the emoticons panel.
 * @returns the emoticons element tree.
 */
export function EmoticonsPanel(): React.JSX.Element {
  const [custom, setCustom] = useState<readonly EmoticonItem[]>([])
  const [packages, setPackages] = useState<EmoticonsSnapshot['packages']>([])
  const [total, setTotal] = useState(0)
  // 自定义表情的顺序来源：'wechat' = 按 kFavEmoticonOrderTable（微信里的自定义排序），
  // 'builtin' = 该表缺失/失败时退化为收藏表内置行序。只在确有其事时才在前端声明。
  const [orderedBy, setOrderedBy] = useState<EmoticonsSnapshot['orderedBy']>(undefined)
  const [tab, setTab] = useState<'all' | 'custom' | 'packages'>('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const pager = usePagedList<EmoticonItem>({
    pageSize: 200,
    fetchPage: async (offset, limit) => {
      const env = await apiGetEmoticons({ limit, offset })
      setPackages(env.packages)
      setTotal(env.total)
      setOrderedBy(env.orderedBy)
      return { items: env.custom, total: env.total }
    },
  })

  const searching = search.trim() !== ''
  // 普通浏览：分页逐页加载；搜索时一次性拉取 2000 条（用户主动操作），保证跨页搜索结果完整。
  useEffect(() => {
    if (searching) {
      let cancelled = false
      setLoading(true)
      setError(null)
      void apiGetEmoticons({ limit: 2000 })
        .then((env) => {
          if (cancelled) return
          setCustom(env.custom)
          setPackages(env.packages)
          setTotal(env.total)
          setOrderedBy(env.orderedBy)
        })
        .catch((e: unknown) => { if (!cancelled) setError((e as Error).message) })
        .finally(() => { if (!cancelled) setLoading(false) })
      return () => { cancelled = true }
    }
    pager.reset()
    return undefined
  }, [searching, pager.reset])

  useEffect(() => {
    if (searching) return
    setCustom(pager.items)
    setTotal(pager.total)
    setLoading(pager.loading)
    setError(pager.error)
  }, [searching, pager.items, pager.total, pager.loading, pager.error])

  const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore) pager.loadMore() })

  const notify = (text: string): void => {
    setNotice(text)
    setTimeout(() =>{  setNotice(null) }, 3000)
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return custom
    return custom.filter(e => e.md5.toLowerCase().includes(q) || (e.caption ?? '').toLowerCase().includes(q))
  }, [custom, search])

  const shownCustom = tab === 'all' || tab === 'custom' ? filtered : []
  const { count: emoCount, sentinelRef: emoSentinel } = useProgressiveList(shownCustom.length, 150)
  const { count: pkgCount, sentinelRef: pkgSentinel } = useProgressiveList(tab === 'packages' ? packages.length : 0, 150)

  const copyMd5 = (md5: string): void => {
    void navigator.clipboard.writeText(md5).then(() =>{  notify('已复制 MD5: ' + md5.slice(0, 8) + '…') }).catch(() =>{  notify('复制失败') })
  }

  return (
    <div className={css.panel}>
      <PanelHeader
        title="表情"
        desc={`自定义 ${custom.length} · 表情包 ${packages.length} · 共 ${total}${orderedBy === 'wechat' ? ' · 顺序与微信一致' : ''}`}
      />
      <Toolbar
        left={(
          <SearchInput value={search} onChange={(v) => { setSearch(v) }} placeholder="搜索表情包名称 / 表情 MD5" ariaLabel="搜索表情" />
        )}
        right={(
          <Segmented
            options={[
              { value: 'all', label: `全部 (${custom.length + packages.length})` },
              { value: 'custom', label: `自定义 (${custom.length})` },
              { value: 'packages', label: `表情包 (${packages.length})` },
            ]}
            value={tab}
            onChange={(v) => { setTab(v as 'all' | 'custom' | 'packages') }}
            ariaLabel="表情分类"
          />
        )}
      />
      {notice && <div className={css.notice}>{notice}</div>}
      <div className={css.grid}>
        {loading && <ListSkeleton rows={10} grid />}
        {error && <div className={kitCss.error} role="alert">⚠️ 表情数据加载失败（{error}）</div>}
        {!loading && !error && tab !== 'packages' && shownCustom.length === 0 && <EmptyMaybeSyncing text={`暂无${tab === 'custom' ? '自定义' : ''}表情`} />}
        {!loading && !error && tab !== 'packages' && shownCustom.slice(0, emoCount).map((e: EmoticonItem) => (
          <div key={e.md5} className={css.emoCell} title={`${e.md5}${e.caption ? ` · ${e.caption}` : ''}${typeLabel(e.item_type) ? ` · ${typeLabel(e.item_type)}` : ''}`} {...clickableKey(() => { copyMd5(e.md5) })}>
            <span className={css.emoName}>{e.caption || '自定义表情'}</span>
            <span className={css.emoMd5}>MD5 · {e.md5.slice(0, 8)}</span>
            <span className={css.emoPh}>😀</span>
            <span className={`${css.emoMd5} ${css.emoMd5Cyan}`}>点击复制 MD5</span>
          </div>
        ))}
        {!loading && !error && tab !== 'packages' && shownCustom.length > emoCount && <ListSentinel refFn={emoSentinel} />}
        {!loading && !error && tab !== 'packages' && !searching && pager.hasMore && <ListSentinel refFn={loadMoreRef} />}
        {!loading && !error && tab === 'packages' && packages.length === 0 && <EmptyMaybeSyncing text="暂无表情包" />}
        {!loading && !error && tab === 'packages' && packages.slice(0, pkgCount).map(p => (
          <div key={p.name} className={css.fileCell} title={p.name}>
            <span className={css.fileIcon}>📦</span>
            <span className={css.fileName}>{p.name}</span>
            <span className={css.fileMeta}>{p.count} 个表情</span>
          </div>
        ))}
        {!loading && !error && tab === 'packages' && packages.length > pkgCount && <ListSentinel refFn={pkgSentinel} />}
      </div>
    </div>
  )
}
