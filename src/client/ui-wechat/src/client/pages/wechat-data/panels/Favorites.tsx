/**
 * 收藏面板 — React 版：列表 + 搜索 + 类型分类 + 多选删除 + 导出 + 详情。
 * 后端已解析时直接用后端字段；后端字段缺失时客户端完整兜底解析 XML，
 * 保证不显示原始 XML / undefined。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useProgressiveList, useTransientNotice } from './hooks.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import { apiDeleteFavoriteItems, apiExportCsv, apiGetFavorites, apiGetSnsImageDataUrl } from '../api.ts'
import type { FavItemPart, FavorItem } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey, Dialog, PanelHeader, SearchInput, Segmented, Toolbar, useDebouncedValue } from '../ui/kit.tsx'
import { fmtBytes, fmtDateTimeSec } from '../utils/format.ts'
import kitCss from '../ui/kit.module.css'
import css from './list-panel.module.css'

/** 收藏类型 → 中文标签（微信 fav type）。 */
function favTypeLabel(type: number): string {
  switch (type) {
    case 1: return '文本'
    case 2: return '图片'
    case 3: return '语音'
    case 4: return '视频'
    case 5: return '链接'
    case 6: return '位置'
    case 7: return '音乐'
    case 8: return '文件'
    case 14: return '聊天记录'
    case 16: return '商品'
    case 18: return '笔记'
    case 19: return '小程序'
    case 20: return '视频号'
    default: return '其他'
  }
}

/** Unescape XML/HTML entities (keep newlines). */
function decodeFavText(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x0A;/gi, '\n')
    .replace(/&#10;/g, '\n')
}

/** Extract text between <tag ...> and </tag> (first occurrence). */
function xmlTagText(xml: string, tag: string): string | null {
  const openExact = '<' + tag + '>'
  const openAttr = '<' + tag + ' '
  const start = xml.indexOf(openExact) >= 0 ? xml.indexOf(openExact) : xml.indexOf(openAttr)
  if (start < 0) return null
  const contentStart = xml.startsWith(openExact, start) ? start + openExact.length : (xml.indexOf('>', start) + 1)
  const close = xml.indexOf('</' + tag + '>', contentStart)
  if (close < 0) return null
  return xml.slice(contentStart, close)
}

/** Extract an attribute value from a tag open (first occurrence). */
function xmlTagAttr(xml: string, tag: string, attr: string): string | null {
  const openExact = '<' + tag + '>'
  const openAttr = '<' + tag + ' '
  const start = xml.indexOf(openExact) >= 0 ? xml.indexOf(openExact) : xml.indexOf(openAttr)
  if (start < 0) return null
  const tagStr = xml.slice(start, xml.indexOf('>', start))
  const search = attr + '="'
  const a = tagStr.indexOf(search)
  if (a < 0) return null
  const v = a + search.length
  const e = tagStr.indexOf('"', v)
  if (e < 0) return null
  return tagStr.slice(v, e)
}

/** 客户端兜底解析收藏 XML 的标题/描述/来源。 */
function parseFavXml(content: string): { title: string; desc: string; fromUsr: string; srcName: string } {
  if (!content || !content.includes('<')) return { title: '', desc: content || '', fromUsr: '', srcName: '' }
  const title = (content.match(/<title>([^<]*)<\/title>/) || [])[1] || ''
  const raw = (content.match(/<desc>([\s\S]*?)<\/desc>/) || [])[1] || ''
  const fromUsr = (content.match(/<fromusr>([^<]*)<\/fromusr>/) || [])[1] || ''
  const srcName = (content.match(/<datasrcname>([^<]*)<\/datasrcname>/) || [])[1] || ''
  return { title, desc: decodeFavText(raw), fromUsr, srcName }
}

/** 客户端兜底解析 `<datalist><dataitem>` 资源条目。 */
function parseFavParts(content: string): FavItemPart[] {
  if (!content || !content.includes('<dataitem')) return []
  const out: FavItemPart[] = []
  let pos = 0
  for (;;) {
    const start = content.indexOf('<dataitem', pos)
    if (start < 0) break
    const end = content.indexOf('</dataitem>', start)
    const body = end >= 0 ? content.slice(start, end) : content.slice(start)
    const datatype = Number.parseInt(xmlTagAttr(body, 'dataitem', 'datatype') ?? '0', 10) || 0
    const dataid = (xmlTagAttr(body, 'dataitem', 'dataid') ?? '').trim().toLowerCase()
    const fullmd5 = (xmlTagText(body, 'fullmd5') ?? '').trim().toLowerCase()
    const thumbmd5 = (xmlTagText(body, 'thumbfullmd5') ?? '').trim().toLowerCase()
    const text = decodeFavText(xmlTagText(body, 'datadesc') ?? '') || decodeFavText(xmlTagText(body, 'datatitle') ?? '')
    const sourceName = xmlTagText(body, 'datasrcname') ?? ''
    const sourceTime = xmlTagText(body, 'datasrctime') ?? ''
    const base = (): FavItemPart => {
      const p: FavItemPart = { kind: 'text' }
      if (sourceName) p.sourceName = sourceName
      if (sourceTime) p.sourceTime = sourceTime
      return p
    }
    if (datatype === 1) {
      if (text) { const p = base(); p.text = text; out.push(p) }
    } else if (datatype === 2) {
      const p = base()
      p.kind = 'image'
      const m = thumbmd5 || fullmd5 || dataid
      if (m) p.md5 = m
      if (text) p.text = text
      out.push(p)
    } else if (datatype === 3) {
      const p = base()
      p.kind = 'voice'
      const m = fullmd5 || dataid
      if (m) p.md5 = m
      out.push(p)
    } else if (datatype === 4) {
      const p = base()
      p.kind = 'video'
      const m = fullmd5 || dataid
      if (m) p.md5 = m
      const dur = Number.parseFloat(xmlTagText(body, 'duration') ?? '0')
      if (dur > 0) p.duration = dur
      out.push(p)
    } else if (datatype === 5 || datatype === 19 || datatype === 36) {
      const p = base()
      p.kind = 'link'
      if (text) p.text = text
      const u = (xmlTagText(body, 'stream_weburl') ?? xmlTagText(body, 'url') ?? '').replace(/&amp;/g, '&')
      if (u) p.url = u
      out.push(p)
    } else if (datatype === 8) {
      const p = base()
      p.kind = 'file'
      const n = xmlTagText(body, 'datatitle') ?? ''
      if (n) p.name = n
      const e = xmlTagText(body, 'datafmt') ?? ''
      if (e) p.ext = e
      const sz = Number.parseInt(xmlTagText(body, 'fullsize') ?? '0', 10)
      if (sz > 0) p.size = sz
      out.push(p)
    }
    pos = end >= 0 ? end + 10 : content.length
  }
  return out
}

/** 规范化一条收藏：后端字段优先，缺失时客户端兜底解析。 */
function parseFavItem(f: FavorItem): {
  title: string
  desc: string
  url: string
  source: string
  time: string
  typeLabel: string
  items: FavItemPart[]
} {
  const info = parseFavXml(f.content)
  const typeLabel = f.typeLabel || favTypeLabel(f.type)
  const items = f.items ?? parseFavParts(f.content)
  const source = f.source || f.chatName || info.srcName || info.fromUsr || f.fromUsr || ''
  // 占位符传空串：这里与 `f.time ||` 配合，空值必须仍是空串而不是 '—'。
  const time = f.time || fmtDateTimeSec(f.updateTime, '')
  return {
    title: f.title || info.title || typeLabel,
    desc: f.desc || info.desc || '',
    url: f.url || '',
    source,
    time,
    typeLabel,
    items,
  }
}


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
  const scrollRef = useRef<HTMLDivElement | null>(null)

  // 类型仍在本端筛（后端没有该参数）；关键字已由服务端过滤，这里不再重复做一遍 ——
  // 本端重复过滤只会作用在「已加载的那一页」上，正是之前漏结果的根因。
  const filtered = useMemo(() => {
    if (type === 'all') return items
    return items.filter((f) => String(f.type) === type)
  }, [items, type])

  const { count: favCount, sentinelRef: favSentinel } = useProgressiveList(filtered.length, 120)

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

  const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore) pager.loadMore() }, '600px 0px', () => scrollRef.current)

  // 收藏内图片离线解析（懒加载）：仅当卡片接近视口时才解码对应媒体，避免一次性
  // 解码大量收藏图片导致卡顿；已取到的用 favImgs 缓存，不会重复请求。
  const decodeFavImg = useCallback((md5: string): void => {
    if (!md5 || favImgFetched.current.has(md5)) return
    favImgFetched.current.add(md5)
    void apiGetSnsImageDataUrl({ md5 })
      .then((r) => { if (r.url) setFavImgs(prev => ({ ...prev, [md5]: r.url as string })) })
      .catch(() => { /* keep placeholder */ })
  }, [])

  useEffect(() => {
    const root = scrollRef.current
    if (!root || filtered.length === 0) return
    const md5ByKey = new Map<string, string>()
    for (const f of filtered.slice(0, favCount)) {
      const it = parseFavItem(f).items.find(p => p.kind === 'image' && p.md5)
      if (it?.md5) md5ByKey.set(String(f.localId), it.md5)
    }
    if (typeof IntersectionObserver === 'undefined') {
      // 无 IO 支持时兜底解码当前渲染卡片，保证图片可见。
      for (const md5 of md5ByKey.values()) decodeFavImg(md5)
      return
    }
    const ob = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const key = (e.target as HTMLElement).dataset.mediaKey || ''
        const md5 = md5ByKey.get(key)
        if (md5) decodeFavImg(md5)
      }
    }, { root, rootMargin: '500px 0px' })
    root.querySelectorAll<HTMLElement>('[data-media-key]').forEach((el) => { ob.observe(el) })
    return () => { ob.disconnect() }
  }, [filtered, favCount, decodeFavImg])

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
        {!loading && !error && filtered.length === 0 && <div className={css.empty}>{search || type !== 'all' ? '无匹配收藏' : '暂无收藏'}</div>}
        {!loading && !error && filtered.slice(0, favCount).map((f) => {
          const info = parseFavItem(f)
          const preview = info.items.length > 0 ? info.items.filter(p => p.kind === 'text').map(p => p.text || '').join('\n') : info.desc
          const cardImg = info.items.find(it => it.kind === 'image' && it.md5)
          const imgPart = info.items.find(it => it.kind === 'image' && it.md5 && favImgs[it.md5])
          return (
            <div
              key={f.localId}
              className={css.favCard}
              data-media-key={cardImg?.md5 ? String(f.localId) : undefined}
              {...clickableKey(() => { if (selectMode) toggleSelect(f.localId); else setDetail(f) })}
              // 卡片在「批量选择」模式下其实是复选框语义，不能一律声明成按钮；
              // 后写的属性覆盖 clickableKey 的默认值，键盘与读屏两边都准确。
              role={selectMode ? 'checkbox' : 'button'}
              aria-checked={selectMode ? selected.has(f.localId) : undefined}
              aria-label={info.title}
            >
              {selectMode && (
                <span className={kitCss.batchCheck} data-checked={selected.has(f.localId) || undefined}>
                  {selected.has(f.localId) ? '✓' : ''}
                </span>
              )}
              <div className={css.favCardBody}>
                <div className={css.favCardTitle}>{info.title}</div>
                {preview && <div className={css.favCardDesc}>{preview}</div>}
                <div className={kitCss.textCaption}>{info.typeLabel + (info.source ? ' · ' + info.source : '') + ' · ' + info.time}</div>
              </div>
              {imgPart && <img className={css.favCardThumb} src={favImgs[imgPart.md5 ?? '']} alt="" loading="lazy" referrerPolicy="no-referrer" />}
            </div>
          )
        })}
        {!loading && !error && filtered.length > favCount && <ListSentinel refFn={favSentinel} />}
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
