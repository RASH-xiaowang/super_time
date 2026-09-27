/**
 * 收藏面板 — React 版：列表 + 搜索 + 类型分类 + 多选删除 + 导出 + 详情。
 * 后端已解析时直接用后端字段；后端字段缺失时客户端完整兜底解析 XML，
 * 保证不显示原始 XML / undefined。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useTransientNotice } from './hooks.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import { apiDeleteFavoriteItems, apiExportCsv, apiGetFavorites, apiGetSnsImageDataUrl } from '../api.ts'
import type { FavorItem } from '@deepseek-ai/dsh-wechat-data/types'
import { Dialog, EmptyState, PanelHeader, SearchInput, Segmented, Toolbar, useDebouncedValue } from '../ui/kit.tsx'
import { fmtBytes } from '../utils/format.ts'
import kitCss from '../ui/kit.module.css'
import css from './list-panel.module.css'
import { favTypeLabel, parseFavItem } from './favorites-parse.ts'
import { FavCard } from './favorites-card.tsx'
import { rememberThumb } from '../utils/thumb-cache.ts'

/** 卡片高度的初值（真实高度由 `measureElement` 回灌）：摘要最多三行，88 是"标题 + 一行摘要 + 落款"的量级。 */
const FAV_CARD_ESTIMATE_PX = 88

/*
 * 虚拟化（#22 推广：把消息流那一套搬到第二处长列表）—— 两处口径记在这里，函数里只留一行注释。
 *
 * **为什么原来那套不够**：`useProgressiveList` 是"渐进窗口"，首屏 120 条、滚到底再增，**只增不减**。
 * 把五千条收藏滚一遍，DOM 里就留下五千张卡片（每张三层 div 加一段文本），内存与重排成本都跟着
 * 历史长度走。虚拟化之后只挂载视口 + `overscan`，节点数与长度解耦 —— 消息流那侧实测：
 * 一万条从 9,700 个节点降到几十个（`scripts/longlist-virtualization-e2e.mjs` 量的）。
 *
 * **缩略图为什么改成"挂载即解码"**：原来是给整段列表挂 IntersectionObserver、观察 `data-media-key`。
 * 虚拟化之后行会不断挂载/卸载，观察器每帧都要重挂一遍元素，反而更贵、也更容易漏；而"这一行挂上了"
 * 本来就等价于"它接近视口"。淘汰那半边收在 `../utils/thumb-cache.ts#rememberThumb` 里（写值、记顺序、
 * 淘汰时连"已请求过"的标记一起清 —— 少清一半就是「滚远再滚回来，图永远是个占位」那种不报错的坏法）。
 * 解码回调要跨异步读最新状态，所以缓存与顺序用 ref 兜着、`useCallback(…, [])` 保持稳定，
 * 不然每次渲染都会重新发起一轮请求。
 */



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
    void apiGetSnsImageDataUrl({ md5 })
      .then((r) => {
        const url = r.url as string | undefined
        if (!url) return
        const next = rememberThumb(
          { thumbs: favThumbsRef.current, order: favThumbOrder.current, fetched: favImgFetched.current },
          md5,
          url,
        )
        favThumbsRef.current = next.thumbs
        favThumbOrder.current = next.order
        favImgFetched.current = next.fetched
        setFavImgs(next.thumbs)
      })
      .catch(() => { /* 解码失败保留占位图标 */ })
  }, [])

  // 打开收藏详情时按需解码该条目的图片（点 3c：详情查看时才读取）。
  useEffect(() => {
    if (!detail) return
    const d = parseFavItem(detail)
    for (const it of d.items) if (it.kind === 'image' && it.md5) decodeFavImg(it.md5)
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
            <button type="button" className={css.catBtn} data-active={selectMode || undefined} onClick={() => { setSelectMode(v => !v); setSelected(new Set()) }}>{selectMode ? '退出批量' : '批量'}</button>
            <button type="button" className={css.catBtn} onClick={() => { void doExport() }} disabled={exporting}>{exporting ? '导出中…' : '导出'}</button>
            {selectMode && <button type="button" className={css.catBtn} data-active="true" onClick={() => { void doDelete() }} disabled={selected.size === 0}>删除所选 ({selected.size})</button>}
          </>
        )}
      />
      <Toolbar
        left={(
          <SearchInput value={search} onChange={(v) => { setSearch(v) }} placeholder="搜索标题 / 描述 / 来源" ariaLabel="搜索收藏" />
        )}
        right={(
          <Segmented
            options={[{ value: 'all', label: `全部 (${items.length})` }, ...types.map(t => ({ value: t.type, label: `${t.label} (${t.count})` }))]}
            value={type}
            onChange={(v) => { setType(v) }}
            ariaLabel="收藏分类"
          />
        )}
      />
      {notice && <div className={css.notice}>{notice}</div>}
      <div className={css.scroll} ref={scrollRef}>
        {loading && <ListSkeleton rows={8} />}
        {error && <div className={kitCss.error} role="alert">⚠️ 收藏数据接口尚未就绪（{error}）</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className={css.empty}>
            <EmptyState
              icon="⭐"
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
      <Dialog open={detail !== null} onClose={() => { setDetail(null) }} title={detail ? parseFavItem(detail).title : '收藏详情'}>
        {detail && (() => {
          const d = parseFavItem(detail)
          return (
            <div className={css.formBody}>
              <div className={kitCss.textMeta}>{d.typeLabel + (d.source ? ' · ' + d.source : '') + ' · ' + d.time}</div>
              <div className={css.favDetail}>
                {d.items.length > 0 ? d.items.map((it, idx) => (
                  <div key={idx} className={css.favPart}>
                    {(it.sourceName || it.sourceTime) && <div className={css.favPartMeta}>{[it.sourceName, it.sourceTime].filter(Boolean).join(' · ')}</div>}
                    {it.kind === 'image' ? (
                      (it.md5 && favImgs[it.md5]) ? <img className={css.favPartImg} src={favImgs[it.md5]} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <div className={kitCss.textMeta}>[图片]</div>
                    ) : it.kind === 'link' ? (
                      it.url ? <a className={css.favPartText} href={it.url} target="_blank" rel="noopener noreferrer">{it.text || it.url}</a> : <div className={css.favPartText}>{it.text || '[链接]'}</div>
                    ) : it.kind === 'file' ? (
                      <div className={css.favPartText}>{it.name || '[文件]'}{it.ext ? ' (' + it.ext + ')' : ''}{it.size ? ` · ${fmtBytes(it.size)}` : ''}</div>
                    ) : it.kind === 'video' ? (
                      <div className={css.favPartText}>[视频]{it.duration ? ` · ${Math.round(it.duration)}s` : ''}</div>
                    ) : it.kind === 'voice' ? (
                      <div className={css.favPartText}>[语音]</div>
                    ) : (
                      <div className={css.favPartText}>{it.text || ''}</div>
                    )}
                  </div>
                )) : <div className={css.favPartText}>{d.desc || ''}</div>}
              </div>
              {d.url && <a href={d.url} target="_blank" rel="noopener noreferrer" className={css.rowName}>打开链接</a>}
            </div>
          )
        })()}
      </Dialog>
    </div>
  )
}
