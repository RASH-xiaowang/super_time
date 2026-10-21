/**
 * 收藏面板 — React 版：列表 + 搜索 + 类型分类 + 多选删除 + 导出 + 详情。
 * 后端已解析时直接用后端字段；后端字段缺失时客户端完整兜底解析 XML，
 * 保证不显示原始 XML / undefined。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useTransientNotice } from './hooks.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import {
  apiDeleteFavoriteItems,
  apiExportCsv,
  apiGetFavoriteMediaDataUrl,
  apiGetFavorites,
  apiGetSnsImageDataUrl,
} from '../api.ts'
import type { FavorItem } from '@deepseek-ai/dsh-wechat-data/types'
import { Drawer, EmptyState, PanelHeader, useDebouncedValue } from '../ui/kit.tsx'
import { desktopAction, desktopActionProps } from '../ui/desktop-only.tsx'
import kitCss from '../ui/kit.module.css'
import css from './list-panel.module.css'
import { favTypeLabel, parseFavItem } from './favorites-parse.ts'
import { FavCard } from './favorites-card.tsx'
import { FavoritesChatlogPreview } from './favorites-chatlog-preview.tsx'
import { FavoriteDetail } from './favorites-detail.tsx'
import { ListFilter, PanelAction } from './asset-ui.tsx'
import { rememberThumb } from '../utils/thumb-cache.ts'

/** 卡片高度的初值（真实高度由 `measureElement` 回灌）：独立卡片 + 两行摘要 + 底栏。 */
const FAV_CARD_ESTIMATE_PX = 114

/**
 * Render the favorites panel.
 * @returns the favorites element tree.
 */
export function FavoritesPanel({ seedQuery }: { seedQuery?: { q: string; nonce: number } } = {}): React.JSX.Element {
  /** 应用内确认框（替代原生 window.confirm）。 */
  const confirm = useConfirm()
  const [items, setItems] = useState<readonly FavorItem[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [type, setType] = useState('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  // 提示语自动消失（L20）：原手写的 `setTimeout(…, 4000)` 已由 hook 统一管理。
  const { notice, flash } = useTransientNotice(4000)
  const [exporting, setExporting] = useState(false)
  const [detail, setDetail] = useState<FavorItem | null>(null)
  const [favImgs, setFavImgs] = useState<Record<string, string>>({})
  const favImgFetched = useRef(new Set<string>())
  const favThumbOrder = useRef<string[]>([])
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // 类型仍在本端筛（后端没有该参数）；关键字已由服务端过滤，这里不再重复做一遍 ——
  // 本端重复过滤只会作用在「已加载的那一页」上，正是之前漏结果的根因。
  const filtered = useMemo(() => {
    if (type === 'all') return items
    return items.filter((f) => String(f.type) === type)
  }, [items, type])

  /** 虚拟化消息流（口径与理由见文件头的注释块）；行高由 `measureElement` 动态回灌。 */
  const favVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => FAV_CARD_ESTIMATE_PX,
    overscan: 6,
    getItemKey: (i) => filtered[i]?.localId ?? i,
  })

  const notify = (text: string): void => {
    flash(text)
  }

  // 全局搜索的命中直接跳到本面板时，把关键词一起带过来。
  // 此前是「只切页签」—— 用户落到一份未筛选的列表上，必须把刚才输的词再打一遍。
  useEffect(() => {
    if (!seedQuery) return
    setSearch(seedQuery.q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedQuery?.nonce])

  // 关键词交给**服务端**（收藏条目的 XML 里就含标题/描述/来源，后端按同一口径 LIKE）。
  // 此前是「拉 500 条再本地过滤」—— 收藏超过 500 条后就会静默漏结果，且界面不提示。
  const kw = useDebouncedValue(search, 250).trim()
  const searching = kw !== ''

  const pager = usePagedList<FavorItem>({
    pageSize: 120,
    fetchPage: async (offset, limit) => {
      const env = await apiGetFavorites({ limit, offset, ...(kw ? { q: kw } : {}) })
      return { items: env.favorites, total: env.total }
    },
  })

  useEffect(() => {
    pager.reset()
  }, [kw, pager.reset])

  useEffect(() => {
    setItems(pager.items)
    setTotal(pager.total)
    setLoading(pager.loading)
    setError(pager.error)
  }, [pager.items, pager.total, pager.loading, pager.error])

  const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore) pager.loadMore() }, '600px 0px', () => scrollRef.current, pager.items.length)

  /** 缓存的当前快照（异步回调要读最新值，见文件头注释）；渲染用的是 `favImgs` 那份 state。 */
  const favThumbsRef = useRef<Record<string, string>>({})
  const decodeFavImg = useCallback((md5: string): void => {
    if (!md5 || favImgFetched.current.has(md5)) return
    favImgFetched.current.add(md5)
    void (async () => {
      let url = ''
      try {
        const local = await apiGetFavoriteMediaDataUrl({ md5, kind: 'image' })
        url = typeof local.url === 'string' ? local.url : ''
      } catch {
        // 本地收藏缓存未命中时继续走旧的 SNS 图片链。
      }
      if (url === '') {
        try {
          const sns = await apiGetSnsImageDataUrl({ md5 })
          url = typeof sns.url === 'string' ? sns.url : ''
        } catch {
          // 两条链都失败时撤掉“已请求”标记，下次重新挂载可重试。
        }
      }
      if (url === '') {
        favImgFetched.current.delete(md5)
        return
      }
      const next = rememberThumb(
        { thumbs: favThumbsRef.current, order: favThumbOrder.current, fetched: favImgFetched.current },
        md5,
        url,
      )
      favThumbsRef.current = next.thumbs
      favThumbOrder.current = next.order
      favImgFetched.current = next.fetched
      setFavImgs(next.thumbs)
    })()
  }, [])

  // 打开收藏详情时按需解码该条目的封面/缩略图（图片、视频、小程序等都共用）。
  useEffect(() => {
    if (!detail) return
    const d = parseFavItem(detail)
    for (const it of d.items) {
      for (const md5 of [it.thumbMd5, it.fullMd5, it.md5]) {
        if (md5) decodeFavImg(md5)
      }
    }
  }, [detail, decodeFavImg])

  const types = useMemo(() => {
    const map = new Map<string, { label: string; count: number }>()
    for (const f of items) {
      const key = String(f.type)
      const cur = map.get(key)
      if (cur) cur.count += 1
      else map.set(key, { label: f.typeLabel || favTypeLabel(f.type), count: 1 })
    }
    return Array.from(map.entries()).map(([type, v]) => ({ type, label: v.label, count: v.count }))
  }, [items])

  const doExport = async (): Promise<void> => {
    setExporting(true)
    try {
      const r = await apiExportCsv({ kind: 'favorites' })
      notify(`已导出 ${r.count} 项收藏 → ${r.path}`)
    } catch (e) {
      notify('导出失败: ' + (e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  const doDelete = async (): Promise<void> => {
    const ids = [...selected]
    if (ids.length === 0) return
    const ok = await confirm({
      title: `删除所选 ${ids.length} 项收藏？`,
      message: '删除的是本地解密副本，不影响微信里的原始收藏。',
      tone: 'danger',
    })
    if (!ok) return
    try {
      const r = await apiDeleteFavoriteItems({ ids })
      notify(`已删除 ${r.deleted} 项收藏`)
      pager.reset()
      setSelected(new Set())
      setSelectMode(false)
    } catch (e) {
      notify('删除失败: ' + (e as Error).message)
    }
  }

  const toggleSelect = (id: number): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className={css.panel}>
      <PanelHeader
        title="收藏"
        desc={`${filtered.length} 项 · 共 ${total}`}
        actions={(
          <>
            <PanelAction active={selectMode} onClick={() => { setSelectMode(v => !v); setSelected(new Set()) }}>{selectMode ? '退出批量' : '批量'}</PanelAction>
            <PanelAction onClick={() => { void doExport() }} disabled={exporting} {...desktopActionProps()}>{exporting ? '导出中…' : desktopAction() ? '导出（仅电脑）' : '导出'}</PanelAction>
            {selectMode && <PanelAction active onClick={() => { void doDelete() }} disabled={selected.size === 0}>删除所选 ({selected.size})</PanelAction>}
          </>
        )}
      />
      <ListFilter
        searchValue={search}
        onSearch={setSearch}
        searchPlaceholder="搜索标题 / 描述 / 来源"
        searchAriaLabel="搜索收藏"
        segments={[{ value: 'all', label: `全部 (${items.length})` }, ...types.map(t => ({ value: t.type, label: `${t.label} (${t.count})` }))]}
        value={type}
        onChange={setType}
        ariaLabel="收藏分类"
      />
      {notice && <div className={css.notice}>{notice}</div>}
      <div className={css.scroll + ' ' + css.favScroll} ref={scrollRef}>
        {loading && <ListSkeleton rows={8} />}
        {error && <div className={kitCss.error} role="alert">收藏数据接口尚未就绪（{error}）</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className={css.empty}>
            <EmptyState
              icon={null}
              title={search || type !== 'all' ? '没有匹配的收藏' : '暂无收藏'}
              desc={search || type !== 'all'
                ? '换个关键词，或把类型筛选切回「全部」再试。'
                : '这里读的是微信本机的收藏夹；在微信里收藏过的图文会自动出现在这里。若刚启动，后台可能仍在同步。'}
            />
          </div>
        )}
        {/* 外层按总高度撑开滚动条，卡片按偏移绝对定位；「加载更多」哨兵排在这段之后，滚到底照样触发分页 */}
        {!loading && !error && filtered.length > 0 && (
          <div style={{ height: favVirtualizer.getTotalSize(), position: 'relative' }}>
            {favVirtualizer.getVirtualItems().map((vi) => {
              const f = filtered[vi.index]
              if (!f) return null
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={favVirtualizer.measureElement}
                  className={css.favVirtualRow}
                  style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                >
                  <FavCard
                    f={f}
                    selectMode={selectMode}
                    checked={selected.has(f.localId)}
                    thumbs={favImgs}
                    onMounted={decodeFavImg}
                    onActivate={(item) => { if (selectMode) toggleSelect(item.localId); else setDetail(item) }}
                  />
                </div>
              )
            })}
          </div>
        )}
        {!loading && !error && !searching && pager.hasMore && <ListSentinel refFn={loadMoreRef} />}
      </div>
      <Drawer
        open={detail !== null && detail.type !== 14}
        onClose={() => { setDetail(null) }}
        title={detail ? parseFavItem(detail).title : '收藏详情'}
        width={520}
      >
        {detail && detail.type !== 14 && <FavoriteDetail item={detail} thumbs={favImgs} />}
      </Drawer>
      <FavoritesChatlogPreview
        item={detail?.type === 14 ? detail : null}
        thumbs={favImgs}
        onClose={() => { setDetail(null) }}
      />
    </div>
  )
}
