/**
 * 文件面板 — React 版：图片/视频/文件分类 + 网格预览（图片本地解码缩略图 + 点击放大）
 * + 大小/时间/会话 + 刷新 + 导出。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useProgressiveList } from './hooks.tsx'
import { apiExportCsv, apiGetFileImageDataUrl, apiGetFiles, apiGetMediaAssets } from '../api.ts'
import { useWechatDataUpdated } from './hooks.tsx'
import type { FileItem } from '@deepseek-ai/dsh-wechat-data/types'
import type { MediaAssetDuplicate } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey, Dialog, Drawer, EmptyMaybeSyncing, PanelHeader, SearchInput, Segmented, Toolbar, useEscapeToClose, useDialogFocus } from '../ui/kit.tsx'
import css from './list-panel.module.css'
import { fileIcon, fmtBytes, fmtDateTimeSec, fmtMonthDaySec } from '../utils/format.ts'
import kitCss from '../ui/kit.module.css'

const CAT_LABEL: Record<string, string> = { image: '图片', video: '视频', file: '文件' }

/** 缓存文件名 → 解析键（去掉 .dat / _t/_h/_b 后缀）。 */
function fileKey(f: FileItem): string {
  const base = f.fileName || f.md5
  return base.replace(/\.dat$/i, '').replace(/_(t|h|b|thumb.*)$/i, '')
}

/** Detects a hash-like (unreadable) file name: hex/base32 without a real extension. */
function isHashLike(f: FileItem): boolean {
  const n = (f.fileName || f.md5).replace(/\.dat$/i, '')
  if (/^[0-9a-f]{16,64}$/i.test(n)) return true
  return !n.includes('.') && /^[0-9a-z]{16,}$/i.test(n)
}

/**
 * 来源口径（第 84 轮）：会话名优先用 message_resource 口径（`sessionName`），
 * 缺失时用附件目录口径（`sourceTalker`，由 `dir2id` 的 `md5(username)` 反查得到）；
 * 月份来自 `dir1`/`dir2` → `dir2id`，三个类目 100% 有值。
 * @param f - file item.
 * @returns 形如「黑龙江沃融-燎引擎 · 2026-09」的来源串（可能只有月份，或为空）。
 */
function fileSource(f: FileItem): string {
  const who = f.sessionName || f.sourceTalker || ''
  const month = f.sourceMonth || ''
  return [who, month].filter(Boolean).join(' · ')
}

/** Readable label: uses the original name when readable, else category + date. */
function fileDisplayName(f: FileItem | undefined): string {
  if (!f) return '(未知)'
  if (!isHashLike(f)) return f.fileName || f.md5 || ''
  const label = CAT_LABEL[f.category] || f.category || '文件'
  const src = f.sessionName ? `来自 ${f.sessionName} · ` : ''
  return `${label} · ${src}${fmtMonthDaySec(f.modifyTime)}`
}

/**
 * Hover tooltip for a file cell: full display label plus the raw file name when
 * they differ. 卡片里的可见文本会被 CSS 省略号截断（实测文件名最长 207px 而格位 124px），
 * 所以 title 必须给出**完整**文本，而不是只给原始文件名。
 * 第 84 轮补：来源（会话 / 月份）也写进 title —— 视频与文件没有预览，
 * tooltip 与「详情」抽屉是它们唯一能看到来源的地方。
 * @param f - file item.
 * @returns the tooltip text.
 */
function fileTitle(f: FileItem): string {
  const label = fileDisplayName(f)
  const raw = f.fileName || ''
  const src = fileSource(f)
  const lines = [label]
  if (src) lines.push(`来源：${src}`)
  if (raw && raw !== label) lines.push(raw)
  return lines.join('\n')
}

/**
 * Render the files panel.
 * @returns the files element tree.
 */
export function FilesPanel(): React.JSX.Element {
  const [files, setFiles] = useState<readonly FileItem[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [cat, setCat] = useState('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fileImgs, setFileImgs] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<FileItem | null>(null)
  // 视频/文件没有预览（后端只提供图片解码），点开的是**详情抽屉**而不是死点击。
  const [detail, setDetail] = useState<FileItem | null>(null)
  const [dupOpen, setDupOpen] = useState(false)
  // 手写灯箱的 Esc 关闭（kit 的 Drawer/Dialog 由 Radix 提供）
  useEscapeToClose(preview !== null, () => { setPreview(null) })
  // 焦点管理：进入移入、Tab 循环、关闭还原
  useDialogFocus(preview !== null, '[data-st-dialog="files-lightbox"]')
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const dragRef = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null)
  const [dragging, setDragging] = useState(false)
  const imgFetched = useRef(new Set<string>())
  const imgOrder = useRef<string[]>([])
  const gridRef = useRef<HTMLDivElement | null>(null)

  const resetView = (): void => { setZoom(1); setPan({ x: 0, y: 0 }) }

  const pager = usePagedList<FileItem>({
    pageSize: 30,
    fetchPage: async (offset, limit) => {
      // 第 83 轮：类目过滤交给后端（分页在 SQL 里做 UNION ALL + ORDER BY + LIMIT/OFFSET），
      // 否则「每页取前 30 条再本地过滤」永远翻不到视频/文件（图片 2717 行占满所有页）。
      const env = await apiGetFiles({ limit, offset, category: cat })
      setCounts(env.counts ?? {})
      return { items: env.files, total: env.total }
    },
  })

  const searching = search.trim() !== ''
  // 普通浏览：分页逐页加载；搜索时一次性拉取 500 条（用户主动操作），保证跨页搜索结果完整。
  useEffect(() => {
    if (searching) {
      let cancelled = false
      setLoading(true)
      setError(null)
      void apiGetFiles({ limit: 500, category: cat })
        .then((env) => {
          if (cancelled) return
          setFiles(env.files)
          setTotal(env.total)
          setCounts(env.counts ?? {})
        })
        .catch((e: unknown) => { if (!cancelled) setError((e as Error).message) })
        .finally(() => { if (!cancelled) setLoading(false) })
      return () => { cancelled = true }
    }
    pager.reset()
    return undefined
  }, [searching, cat, pager.reset])

  useEffect(() => {
    if (searching) return
    setFiles(pager.items)
    setTotal(pager.total)
    setLoading(pager.loading)
    setError(pager.error)
  }, [searching, pager.items, pager.total, pager.loading, pager.error])

  const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore) pager.loadMore() }, '600px 0px', () => gridRef.current)

  const refresh = useCallback((): void => {
    setError(null)
    if (searching) {
      setLoading(true)
      void apiGetFiles({ limit: 500, category: cat })
        .then((env) => { setFiles(env.files); setTotal(env.total); setCounts(env.counts ?? {}) })
        .catch((e: unknown) => { setError((e as Error).message) })
        .finally(() => { setLoading(false) })
    } else {
      pager.reset()
    }
  }, [searching, cat, pager.reset])

  // 数据落地后按需安静刷新（不打断用户滚动位置）。
  // 「查找重复」标签上的数字必须用**服务端全量**统计。
  // 本面板的 dupGroups 只对**已加载的那一页**分组（懒加载 30–60 条时全为唯一 md5，显示 0），
  // 而「媒体资产」面板是全量口径（实测 200 组 / 574 个文件）—— 两者并存会让用户误以为没有重复。
  // 全量数字来自 getMediaAssets().duplicateFiles（对 hardlink 三表全量按 md5 分组）。
  const [dupTotal, setDupTotal] = useState(0)
  const [dupReclaim, setDupReclaim] = useState(0)
  const [dupGroupsServer, setDupGroupsServer] = useState<readonly MediaAssetDuplicate[]>([])
  const loadDupTotal = useCallback((): void => {
    void apiGetMediaAssets()
      .then((m) => { setDupTotal(m.duplicateFiles); setDupReclaim(m.reclaimBytes); setDupGroupsServer(m.duplicates) })
      .catch(() => { /* 统计失败不阻塞列表 */ })
  }, [])
  useEffect(() => { loadDupTotal() }, [loadDupTotal])
  useWechatDataUpdated(loadDupTotal)

  useWechatDataUpdated(() => { if (!searching) pager.reset() })

  const searched = useMemo(() => {
    const list = files
    const q = search.trim().toLowerCase()
    if (!q) return list
    return list.filter(f => (f.fileName || f.md5).toLowerCase().includes(q))
  }, [files, search])

  // 第 83 轮：不再在客户端硬过滤成 image —— 类目过滤由后端完成，
  // 「全部 / 图片 / 视频 / 文件」四个入口都能真正列出条目（此前视频 131、文件 579 全库打不开）。
  const visible = searched

  const countOf = (c: string): number => counts[c] ?? 0
  const countAll = countOf('image') + countOf('file') + countOf('video')

  const { count: fileCount, sentinelRef: fileSentinel } = useProgressiveList(visible.length, 30)

  // 图片资源懒加载：仅当图片格子接近视口时才离线解码（IntersectionObserver），
  // 避免一次性解码数百张图片导致卡顿；进入视口的才请求数据，已取到的用 fileImgs 缓存。
  useEffect(() => {
    const root = gridRef.current
    const list = files
    if (!root || list.length === 0) return
    const md5ByKey = new Map<string, string>()
    for (const f of list) {
      if (f.category !== 'image') continue
      const key = fileKey(f)
      if (key) md5ByKey.set(key, key)
    }
    const applyImage = (key: string, url: string): void => {
      setFileImgs(prev => {
        const next = { ...prev, [key]: url }
        if (!imgOrder.current.includes(key)) imgOrder.current.push(key)
        // 只保留最近 60 张解码图片，避免长时间滚动内存无限增长。
        while (imgOrder.current.length > 60) {
          const old = imgOrder.current.shift()
          if (old !== undefined && old !== key) {
            delete next[old]
            imgFetched.current.delete(old)
          }
        }
        return next
      })
    }
    const decode = (key: string, md5: string): void => {
      // 异常/缺失 md5 的图片直接跳过加载，保持占位图标。
      if (!key || !/^[0-9a-f]{32}$/i.test(md5) || imgFetched.current.has(key)) return
      imgFetched.current.add(key)
      void apiGetFileImageDataUrl({ md5 })
        .then((r) => { if (r.url) applyImage(key, r.url as string) })
        .catch(() => { /* 失败后不再重试，保留图标兜底 */ })
    }
    if (typeof IntersectionObserver === 'undefined') {
      // 无 IO 支持时兜底全部解码，保证图片可见。
      for (const [key, md5] of md5ByKey) decode(key, md5)
      return
    }
    const ob = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue
        const key = (e.target as HTMLElement).dataset.mediaKey || ''
        const md5 = md5ByKey.get(key)
        if (key && md5) decode(key, md5)
      }
    }, { root, rootMargin: '500px 0px' })
    // 观察当前已渲染的图片格子；随渐进渲染增加时本 effect 会随 fileCount 重跑。
    root.querySelectorAll<HTMLElement>('[data-media-key]').forEach((el) => { ob.observe(el) })
    return () => { ob.disconnect() }
  }, [files, fileCount])

  // 服务端的重复组只给 md5 / 份数 / 字节；文件名用**已加载**的文件补齐，
  // 没加载到的就显示 md5 前 12 位（不影响分组与统计的准确性）。
  const nameByMd5 = useMemo(() => {
    const m = new Map<string, string>()
    for (const f of visible) if (f.md5 && !m.has(f.md5)) m.set(f.md5, fileDisplayName(f))
    return m
  }, [visible])

  const dupGroups = useMemo(() => {    const byKey = new Map<string, FileItem[]>()
    for (const f of visible) {
      const k = fileKey(f)
      const arr = byKey.get(k) ?? []
      arr.push(f)
      byKey.set(k, arr)
    }
    return [...byKey.values()]
      .filter(g => g.length > 1)
      .map(g => ({ key: g[0]?.md5 ?? '', items: g, total: g.reduce((a, f) => a + (f.fileSize || 0), 0) }))
      .sort((a, b) => b.items.length * b.total - a.items.length * a.total)
  }, [visible])

  const doExport = async (): Promise<void> => {
    try {
      const r = await apiExportCsv({ kind: 'files' })
      window.alert(`已导出 ${r.count} 个文件 → ${r.path}`)
    } catch (e) {
      window.alert('导出失败: ' + (e as Error).message)
    }
  }

  return (
    <div className={css.panel}>
      {/* 首屏加载期间**不能**把计数写成 0：实测（真实 4305 个文件）进入本页后前 3–6 秒
          头部会显示「共 0 项 · 图片 0 / 视频 0 / 文件 0」，用户会以为自己的文件不见了。
          加载中就明确说"正在统计"，计数等到了再显示；分类标签同理不写 (0)。 */}
      <PanelHeader
        title="文件管理"
        desc={loading && total === 0
          ? '正在统计本机文件索引…'
          : `共 ${total} 项 · 图片 ${countOf('image')} / 视频 ${countOf('video')} / 文件 ${countOf('file')}`}
        actions={(
          <>
            <button type="button" className={css.catBtn} onClick={refresh}>刷新</button>
            <button type="button" className={css.catBtn} onClick={() => { void doExport() }}>导出</button>
            <button type="button" className={css.catBtn} data-active={dupOpen || undefined} onClick={() => { setDupOpen(v => !v) }}>查找重复 ({dupTotal > 0 ? dupTotal : dupGroups.length})</button>
          </>
        )}
      />
      <Toolbar
        left={(
          <SearchInput value={search} onChange={(v) => { setSearch(v) }} placeholder="搜索文件名 / MD5" ariaLabel="搜索文件" />
        )}
        right={(
          <Segmented
            options={[
              { value: 'all', label: `全部 (${countAll})` },
              { value: 'image', label: `图片 (${countOf('image')})` },
              { value: 'video', label: `视频 (${countOf('video')})` },
              { value: 'file', label: `文件 (${countOf('file')})` },
            ].map((o) => (loading && countAll === 0 ? { ...o, label: o.label.replace(/\s*\(\d+\)$/, '') } : o))}
            value={cat}
            onChange={(v) => { setCat(v) }}
            ariaLabel="文件分类"
          />
        )}
      />
      <div className={`${css.grid} ${css.fileGrid}`} ref={gridRef}>
        {/* 骨架的列宽与真实 .fileGrid 一致（200px）：120px 的默认值会排成 10 列，
            数据到了之后突然变成 6 列，像是"布局跳了一下"。 */}
        {loading && <ListSkeleton rows={10} grid minCol={200} />}
        {error && <div className={kitCss.error} role="alert">⚠️ 文件数据接口尚未就绪（{error}）</div>}
        {/* 0 项要能自证：说明索引来自哪、以及"没配好数据源"这种情况该去哪配。
            否则用户看到"暂无文件"没法判断是"真没有"还是"没配对"。 */}
        {!loading && !error && visible.length === 0 && (
          <EmptyMaybeSyncing
            text="暂无文件"
            note="文件索引来自本机解密库的 hardlink 记录（图片 / 视频 / 文件三类）。若刚换过数据源，请先在「设置 → 数据配置」完成解密与保存配置，再回到本页刷新。"
          />
        )}
        {!loading && !error && visible.slice(0, fileCount).map((f, i) => {
          const fk = fileKey(f)
          const imgSrc = f.category === 'image' ? fileImgs[fk] || '' : ''
          const iconHtml = fileIcon(((f.fileName || '').split('.').pop() ?? '').slice(0, 8))
          // 图片开灯箱；视频/文件开**详情抽屉**（没有预览，但要看名称/来源/月份/md5）。
          // 第 83 轮曾把视频/文件做成不可点，第 84 轮改成「可点且有真实动作」——
          // 死控件与假控件都不该存在，二者取「给它一个有意义的目标」。
          const canPreview = f.category === 'image'
          return (
            <div
              key={`${i}:${f.category}:${f.md5}`}
              className={css.fileCell}
              title={fileTitle(f)}
              data-media-key={canPreview ? fileKey(f) : undefined}
              {...clickableKey(() => { if (canPreview) setPreview(f); else setDetail(f) })}
            >
              {imgSrc ? (
                <img className={css.fileThumb} src={imgSrc} alt="" loading="lazy" referrerPolicy="no-referrer" />
              ) : (
                <span className={css.fileIcon} dangerouslySetInnerHTML={{ __html: iconHtml }} />
              )}
              {/* 不在这里 slice：让 CSS 省略号负责视觉截断，title 里始终有全文 */}
              <span className={css.fileName}>{fileDisplayName(f)}</span>
              <span className={css.fileMeta}>
                {CAT_LABEL[f.category] || f.category} · {fmtBytes(f.fileSize || 0)} · {fmtMonthDaySec(f.modifyTime)}
              </span>
            </div>
          )
        })}
        {!loading && !error && visible.length > fileCount && <ListSentinel refFn={fileSentinel} />}
        {!loading && !error && !searching && pager.hasMore && <ListSentinel refFn={loadMoreRef} />}
      </div>
      <Drawer open={dupOpen} onClose={() => { setDupOpen(false) }} title="重复文件预览">
        <div className={kitCss.textCaption}>“去重”为只读建议，不在本机删除数据。下列为<strong>全库</strong>按内容（md5）归并的重复组，取前 {dupGroupsServer.length} 组（共 {dupTotal} 个重复文件、可回收约 {fmtBytes(dupReclaim)}）。</div>
        {dupGroupsServer.length === 0 && <div className={css.empty}>未发现重复文件</div>}
        {dupGroupsServer.map(g => (
          <div key={g.md5} className={css.dupRow}>
            <span className={css.dupName}>{nameByMd5.get(g.md5) ?? `${g.md5.slice(0, 12)}…`}</span>
            <span className={css.dupMeta}>同内容 ×{g.count} · 共 {fmtBytes(g.size)}</span>
            <span className={css.dupKeep}>可回收 {fmtBytes(g.reclaimBytes)}</span>
          </div>
        ))}
      </Drawer>
      {/* 详情抽屉（第 84 轮）：视频/文件没有预览，这里给出全部可读字段与来源口径 */}
      <Drawer open={detail !== null} onClose={() => { setDetail(null) }} title="文件详情">
        {detail && (
          <div className={css.kvList}>
            <div className={css.kvRow}><span className={css.kvKey}>名称</span><span className={css.kvVal}>{detail.fileName || '(无原始文件名)'}</span></div>
            <div className={css.kvRow}><span className={css.kvKey}>类目</span><span className={css.kvVal}>{CAT_LABEL[detail.category] || detail.category}</span></div>
            <div className={css.kvRow}><span className={css.kvKey}>大小</span><span className={css.kvVal}>{fmtBytes(detail.fileSize || 0)}</span></div>
            <div className={css.kvRow}><span className={css.kvKey}>修改时间</span><span className={css.kvVal}>{fmtDateTimeSec(detail.modifyTime)}</span></div>
            <div className={css.kvRow}><span className={css.kvKey}>来源会话</span><span className={css.kvVal}>{detail.sessionName || detail.sourceTalker || '(未解析到)'}</span></div>
            <div className={css.kvRow}><span className={css.kvKey}>来源月份</span><span className={css.kvVal}>{detail.sourceMonth || '(未解析到)'}</span></div>
            <div className={css.kvRow}><span className={css.kvKey}>MD5</span><span className={`${css.kvVal} ${css.kvMono}`}>{detail.md5 || '(空)'}</span></div>
            <div className={kitCss.textCaption}>
              来源会话来自附件目录（`dir1`/`dir2` → `dir2id`，其值是 md5(会话名)），
              与「消息资源」口径互为独立来源；本机数据两口径在图片上 200/200 一致。
              视频与文件当前不提供在线预览（只读清单）。
            </div>
          </div>
        )}
      </Drawer>
      {preview && (
        <div className={css.lightbox} data-st-dialog="files-lightbox" role="dialog" aria-modal="true" onClick={() => { setPreview(null) }}>
          <div className={css.lightboxCard} onClick={(e) => { e.stopPropagation() }}>
            <header className={css.lightboxHd}>
              <div className={css.lightboxTitle}>
                <span className={css.lightboxName}>{fileDisplayName(preview)}</span>
                <span className={kitCss.textCaption}>
                  {CAT_LABEL[preview.category] || preview.category} · {fmtBytes(preview.fileSize || 0)} · {fmtMonthDaySec(preview.modifyTime)}
                  {fileSource(preview) ? ` · 来源 ${fileSource(preview)}` : ''}
                </span>
              </div>
              <span className={css.lightboxBadge}>JPG</span>
              <button type="button" className={css.lightboxClose} aria-label="关闭预览" onClick={() => { setPreview(null) }}>×</button>
            </header>
            <div className={css.lightboxBody}>
              {fileImgs[fileKey(preview)] ? (
                <div
                  className={dragging ? `${css.lightboxStage} ${css.lightboxDragging}` : css.lightboxStage}
                  onWheel={(e) => {
                    const d = e.deltaY < 0 ? 0.15 : -0.15
                    setZoom(z => Math.min(5, Math.max(0.5, Math.round((z + d) * 100) / 100)))
                  }}
                  onPointerDown={(e) => {
                    dragRef.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y }
                    setDragging(true)
                    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
                  }}
                  onPointerMove={(e) => {
                    const d = dragRef.current
                    if (d) setPan({ x: d.px + (e.clientX - d.sx), y: d.py + (e.clientY - d.sy) })
                  }}
                  onPointerUp={() => { dragRef.current = null; setDragging(false) }}
                  onPointerCancel={() => { dragRef.current = null; setDragging(false) }}
                >
                  <img
                    className={css.lightboxImg}
                    src={fileImgs[fileKey(preview)] ?? ''}
                    alt={preview.fileName || preview.md5}
                    referrerPolicy="no-referrer"
                    draggable={false}
                    style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
                  />
                </div>
              ) : (
                <div className={css.lightboxEmpty}>
                  <span className={css.lightboxEmptyTitle}>未找到已解密图片</span>
                  <span className={css.lightboxEmptyNote}>decoded_images/{fileKey(preview)}.jpg 不存在</span>
                </div>
              )}
            </div>
            <div className={css.lightboxZoom}>
              <button type="button" className={css.lightboxZoomBtn} onClick={() => { setZoom(z => Math.max(0.5, Math.round((z - 0.15) * 100) / 100)) }} aria-label="缩小">−</button>
              <span className={css.lightboxZoomText}>{Math.round(zoom * 100)}%</span>
              <button type="button" className={css.lightboxZoomBtn} onClick={() => { setZoom(z => Math.min(5, Math.round((z + 0.15) * 100) / 100)) }} aria-label="放大">＋</button>
              <button type="button" className={css.lightboxZoomBtn} onClick={resetView} aria-label="重置视图">重置</button>
            </div>
            <footer className={css.lightboxFt}>
              <span className={css.lightboxMd5}>{preview.md5 || fileKey(preview)}</span>
              <button type="button" className={css.catBtn} onClick={() => {
                const src = fileImgs[fileKey(preview)]
                if (!src) return
                const a = document.createElement('a')
                a.href = src
                a.download = `${fileKey(preview)}.jpg`
                document.body.appendChild(a)
                a.click()
                document.body.removeChild(a)
              }} disabled={!fileImgs[fileKey(preview)]}>下载图片</button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
