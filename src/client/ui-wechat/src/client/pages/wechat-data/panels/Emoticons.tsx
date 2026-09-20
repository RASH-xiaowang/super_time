/**
 * 表情面板 — React 版，忠实迁移 WeChatPanel 的 emoticons 页签：自定义表情 /
 * 表情包 分类标签 + 网格（点击复制 MD5），搜索按名称/MD5 过滤。走 Remote
 * （getEmoticons），无 HTTP 依赖。
 */
import { useEffect, useMemo, useState } from 'react'
import { ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useProgressiveList, useTransientNotice } from './hooks.tsx'
import { apiGetEmoticonDataUrl, apiGetEmoticons } from '../api.ts'
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
 * 表情真图：按 md5（+ 库里带的 CDN 地址）取图。
 *
 * 以前格子里放的是 `😀` 占位符 —— 面板只当「MD5 浏览器」用，从不取图，所以用户看到的是
 * 一片空格子。取图链路：本地解码 → 本地表情缓存（微信 4.x 是**加密**文件，项目里没有
 * 解码器）→ 用 `cdn_url` 下载一次并落进 decoded 缓存（见后端 `fetchEmoticonRemote`），
 * 于是每张图只花一次网络。失败时退回 emoji 占位，并把原因放在 title 里。
 * @param props.md5 - the emoticon md5.
 * @param props.cdnUrl - CDN url from `kNonStoreEmoticonTable.cdn_url`.
 * @param props.caption - optional caption (alt text).
 * @returns the image, or an emoji placeholder while loading/failed.
 */
function EmoThumb({ md5, cdnUrl, caption }: { md5: string; cdnUrl?: string; caption?: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setErr(null)
    apiGetEmoticonDataUrl({ md5: md5.toLowerCase(), ...(cdnUrl ? { emojiUrl: cdnUrl } : {}) })
      .then((r) => {
        if (cancelled) return
        if (r.url) setSrc(r.url)
        else setErr(r.error ?? '表情不可用')
      })
      .catch((e: unknown) => { if (!cancelled) setErr((e as Error).message) })
    return () => { cancelled = true }
  }, [md5, cdnUrl])
  if (src) {
    return <img className={css.emoImg} src={src} alt={caption || '表情'} loading="lazy" decoding="async" />
  }
  return <span className={css.emoPh} title={err ?? '表情加载中…'}>{err ? '🙁' : '😀'}</span>
}

/**
 * 取后端新加的 `cdnUrl`（表情真图的下载地址）。
 *
 * 客户端这份类型来自 `node_modules` 里的**旧副本**（还没有该字段），直接读会过不了 `tsc`，
 * 所以在这里按可选字段取一次。等重跑 `npm install` 同步类型副本后，这个函数可以删掉。
 * @param e - the emoticon item.
 * @returns `{ cdnUrl }` when present, else `{}`.
 */
function cdnUrlOf(e: EmoticonItem): { cdnUrl?: string } {
  const v = (e as EmoticonItem & { cdnUrl?: unknown }).cdnUrl
  return typeof v === 'string' && v ? { cdnUrl: v } : {}
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
  // 提示语自动消失（L20）：原手写的 `setTimeout(…, 3000)` 已由 hook 统一管理。
  const { notice, flash } = useTransientNotice()

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
    flash(text)
  }

  const q = useMemo(() => search.trim().toLowerCase(), [search])
  const filtered = useMemo(() => {
    if (!q) return custom
    return custom.filter(e => e.md5.toLowerCase().includes(q) || (e.caption ?? '').toLowerCase().includes(q))
  }, [custom, q])

  // 表情包此前**完全不参与过滤**：placeholder 写着「搜索表情包名称」，但渲染直接用
  // `packages.slice()` ⇒ 在「表情包」页签下输入任何内容，界面都纹丝不动。
  const filteredPackages = useMemo(() => {
    if (!q) return packages
    return packages.filter(p => p.name.toLowerCase().includes(q))
  }, [packages, q])

  const shownCustom = tab === 'all' || tab === 'custom' ? filtered : []
  const { count: emoCount, sentinelRef: emoSentinel } = useProgressiveList(shownCustom.length, 150)
  const { count: pkgCount, sentinelRef: pkgSentinel } = useProgressiveList(tab === 'packages' ? filteredPackages.length : 0, 150)

  const copyMd5 = (md5: string): void => {
    void navigator.clipboard.writeText(md5).then(() =>{  notify('已复制 MD5: ' + md5.slice(0, 8) + '…') }).catch(() =>{  notify('复制失败') })
  }

  return (
    <div className={css.panel}>
      <PanelHeader
        title="表情"
        // 首次进这个面板要等后端同步窗口（实测冷启动约 20-30 秒），期间计数是 0/0/0、
        // 网格只有骨架 —— 直接显示「共 0」会被当成「没有表情」，这里如实说明在加载。
        desc={loading && custom.length === 0
          ? '正在加载…（后端启动同步期间首次查询约需 20-30 秒）'
          : `自定义 ${custom.length} · 表情包 ${packages.length} · 共 ${total}${orderedBy === 'wechat' ? ' · 顺序与微信一致' : ''}`}
      />
      <Toolbar
        left={(
          <SearchInput value={search} onChange={(v) => { setSearch(v) }} placeholder="搜索表情包名称 / 表情 MD5" ariaLabel="搜索表情" />
        )}
        right={(
          <Segmented
            options={[
              { value: 'all', label: `全部 (${filtered.length + filteredPackages.length})` },
              { value: 'custom', label: `自定义 (${filtered.length})` },
              { value: 'packages', label: `表情包 (${filteredPackages.length})` },
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
            {/* 真图放最上面：格子第一眼要看到表情本身，而不是文字 */}
            <EmoThumb md5={e.md5} caption={e.caption} {...cdnUrlOf(e)} />
            <span className={css.emoName}>{e.caption || '自定义表情'}</span>
            <span className={css.emoMd5}>MD5 · {e.md5.slice(0, 8)}</span>
            <span className={`${css.emoMd5} ${css.emoMd5Cyan}`}>点击复制 MD5</span>
          </div>
        ))}
        {!loading && !error && tab !== 'packages' && shownCustom.length > emoCount && <ListSentinel refFn={emoSentinel} />}
        {!loading && !error && tab !== 'packages' && !searching && pager.hasMore && <ListSentinel refFn={loadMoreRef} />}
        {!loading && !error && tab === 'packages' && filteredPackages.length === 0 && (
          <EmptyMaybeSyncing text={q ? '未找到相关表情包' : '暂无表情包'} />
        )}
        {!loading && !error && tab === 'packages' && filteredPackages.slice(0, pkgCount).map(p => (
          <div key={p.name} className={css.fileCell} title={p.name}>
            <span className={css.fileIcon}>📦</span>
            <span className={css.fileName}>{p.name}</span>
            <span className={css.fileMeta}>{p.count} 个表情</span>
          </div>
        ))}
        {!loading && !error && tab === 'packages' && filteredPackages.length > pkgCount && <ListSentinel refFn={pkgSentinel} />}
      </div>
    </div>
  )
}
