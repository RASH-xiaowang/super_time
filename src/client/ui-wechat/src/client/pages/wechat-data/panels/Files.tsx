/**
 * 文件面板 — React 版：图片/视频/文件分类 + 网格预览（图片本地解码缩略图 + 点击放大）
 * + 大小/时间/会话 + 刷新 + 导出。
 *
 * 网格是**虚拟化**的（#22 第三处）：一行 = 横向排开的若干格，列数现测（`auto-fill` 随宽度变），
 * 所以只挂载视口附近那些格。口径与理由写在下面 `fileVirtualizer` 那一格附近。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useWechatDataUpdated } from './hooks.tsx'
import { useGridColumns } from './use-grid-columns.ts'
import { AssetKpiBar, AssetMoreMenu, FileCell } from './files-cell.tsx'
import { CAT_LABEL, fileDisplayName, fileKey, fileSource, fileSourceName, fileSourceUsername } from './files-naming.ts'
import { gridRowCount, gridRowRange } from './files-grid.ts'
import { apiExportCsv, apiGetFiles, apiGetMediaAssets } from '../api.ts'
import { fetchFileFullUrl, prefetchKeys, thumbWidthFor } from './files-thumbs.ts'
import { saveFileOriginal } from './files-original-export.ts'
import { useFileThumbnails } from './use-file-thumbs.ts'
import { duplicateGroups, namesByMd5 } from './files-dup.ts'
import { MediaViewer } from '../media-viewer/MediaViewer.tsx'
import { ActionNoticeLine, useActionNotice } from './use-action-notice.tsx'
import type { FileItem } from '@deepseek-ai/dsh-wechat-data/types'
import type { MediaAssetDuplicate, MediaOriginalExportResult } from '@deepseek-ai/dsh-wechat-data/types'
import { Drawer, EmptyMaybeSyncing, PanelHeader, useDebouncedValue } from '../ui/kit.tsx'
import { desktopAction, desktopActionProps } from '../ui/desktop-only.tsx'
import css from './list-panel.module.css'
import { fmtBytes, fmtDateTimeSec, fmtMonthDaySec } from '../utils/format.ts'
import kitCss from '../ui/kit.module.css'
import { ListFilter, PanelAction } from './asset-ui.tsx'
import { IdentityName } from './identity.tsx'
import { ExportProgressStatus } from './ExportProgressStatus.tsx'
import { useExportTask } from './export-task.ts'
import { useMediaSaveTask } from './media-save-task.ts'

/** 格位最小宽度，与 `.fileGrid` 的 `minmax(200px, 1fr)` 保持一致（改一处不改另一处就会列数算错）。 */
const FILE_MIN_COL_PX = 200
/** 一行格子的水平间距，与 `.grid` 的 `gap: 10px` 同值。 */
const FILE_GRID_GAP_PX = 10
/** 一格的估计高度（图 + 文件名 + 落款）；真实高度由 `measureElement` 回灌。 */
const FILE_ROW_ESTIMATE_PX = 176

/** One detail row with the source conversation avatar when a real username is available. */
function FileSourceRow({ item }: { item: FileItem }): React.JSX.Element {
  const name = fileSourceName(item) || '(未解析到)'
  const username = fileSourceUsername(item)
  return (
    <div className={css.kvRow}>
      <span className={css.kvKey}>来源会话</span>
      <span className={css.kvVal}>
        {username
          ? <IdentityName name={name} username={username} size={22}>{name}</IdentityName>
          : name}
      </span>
    </div>
  )
}

/** Save one detail-drawer item through the original-file RPC, including busy/error state. */
function FileDetailSaveAction({
  item,
  onSaved,
}: {
  item: FileItem
  onSaved: (saved: Awaited<ReturnType<typeof saveFileOriginal>>) => void
}): React.JSX.Element {
  const mediaSave = useMediaSaveTask()
  const save = async (): Promise<void> => {
    const outcome = await mediaSave.save<MediaOriginalExportResult>({
      idPrefix: 'files-original',
      label: '保存文件库原文件',
      successMessage: (r) => `已保存原文件 → ${r.path ?? ''}`,
      run: (jobId) => saveFileOriginal(item, { jobId }),
    })
    if (outcome.ok) onSaved(outcome.result)
  }
  return (
    <>
      <PanelAction disabled={mediaSave.running} {...desktopActionProps()} onClick={() => { void save() }}>
        {mediaSave.finishing ? '完成中…'
          : mediaSave.running ? '保存中…'
          : item.category === 'image' ? '保存原图'
            : item.category === 'video' ? '保存原视频' : '保存原文件'}
      </PanelAction>
      <ExportProgressStatus
        compact
        state={mediaSave.state}
        onCancel={() => { void mediaSave.cancel() }}
      />
    </>
  )
}

/** Lightbox wrapper keeps its media-save lifecycle out of the already-ratcheted FilesPanel body. */
function FilesLightbox({
  preview,
  imageItems,
  fileImgs,
  onIndexChange,
  onClose,
  onSaved,
}: {
  preview: FileItem
  imageItems: readonly FileItem[]
  fileImgs: Readonly<Record<string, string>>
  onIndexChange: (index: number) => void
  onClose: () => void
  onSaved: (path: string) => void
}): React.JSX.Element {
  const mediaSave = useMediaSaveTask()
  const sources = useMemo(() => imageItems.map((f) => {
    const key = fileKey(f)
    const caption = [CAT_LABEL[f.category] || f.category, fmtBytes(f.fileSize || 0), fmtMonthDaySec(f.modifyTime)]
    if (fileSource(f)) caption.push(`来源 ${fileSource(f)}`)
    return {
      key,
      thumb: fileImgs[key],
      title: fileDisplayName(f),
      subtitle: caption.join(' · '),
      load: () => fetchFileFullUrl(key),
      onDownload: async () => {
        const outcome = await mediaSave.save<MediaOriginalExportResult>({
          idPrefix: 'files-original',
          label: '保存文件库原文件',
          successMessage: (r) => `已保存原文件 → ${r.path ?? ''}`,
          run: (jobId) => saveFileOriginal(f, { jobId }),
        })
        if (outcome.ok) onSaved(outcome.result.path ?? '')
      },
      downloadDisabled: desktopAction(),
      downloadDisabledReason: '原文件保存仅支持电脑端',
    }
  }), [fileImgs, imageItems, mediaSave.save, onSaved])
  const index = imageItems.findIndex((f) => fileKey(f) === fileKey(preview))
  return (
    <MediaViewer
      sources={sources}
      index={index}
      onIndexChange={onIndexChange}
      onClose={onClose}
      dialogName="files-lightbox"
      statusOverlay={(
        <ExportProgressStatus
          compact
          state={mediaSave.state}
          onCancel={() => { void mediaSave.cancel() }}
        />
      )}
    />
  )
}

/**
 * Render the files panel.
 * @returns the files element tree.
 */
export function FilesPanel({ seedQuery }: { seedQuery?: { q: string; nonce: number } } = {}): React.JSX.Element {
  const [files, setFiles] = useState<readonly FileItem[]>([])
  const [total, setTotal] = useState(0)
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [cat, setCat] = useState('all')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [preview, setPreview] = useState<FileItem | null>(null)
  // 视频/文件没有预览（后端只提供图片解码），点开的是**详情抽屉**而不是死点击。
  const [detail, setDetail] = useState<FileItem | null>(null)
  const [dupOpen, setDupOpen] = useState(false)
  const gridRef = useRef<HTMLDivElement | null>(null)

  // 全局搜索的命中直接跳到本面板时，把关键词一起带过来。
  // 此前是「只切页签」—— 用户落到一份未筛选的列表上，必须把刚才输的词再打一遍。
  useEffect(() => {
    if (!seedQuery) return
    setSearch(seedQuery.q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedQuery?.nonce])

  // 关键词交给**服务端**：此前「搜索时拉 500 条再本地过滤」只覆盖 4305 个文件里的 11.6%，
  // 且界面完全不提示 —— 用户会以为「这个文件不存在」。现在分页与搜索都在服务端完成。
  const kw = useDebouncedValue(search, 250).trim()
  const searching = kw !== ''

  const pager = usePagedList<FileItem>({
    pageSize: 30,
    fetchPage: async (offset, limit) => {
      // 第 83 轮：类目过滤交给后端（分页在 SQL 里做 UNION ALL + ORDER BY + LIMIT/OFFSET），
      // 否则「每页取前 30 条再本地过滤」永远翻不到视频/文件（图片 2717 行占满所有页）。
      const env = await apiGetFiles({ limit, offset, category: cat, ...(kw ? { q: kw } : {}) })
      setCounts(env.counts ?? {})
      return { items: env.files, total: env.total }
    },
  })

  useEffect(() => {
    pager.reset()
  }, [kw, cat, pager.reset])

  useEffect(() => {
    setFiles(pager.items)
    setTotal(pager.total)
    setLoading(pager.loading)
    setError(pager.error)
  }, [pager.items, pager.total, pager.loading, pager.error])

  const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore) pager.loadMore() }, '600px 0px', () => gridRef.current, pager.items.length)

  const refresh = useCallback((): void => {
    setError(null)
    pager.reset()
  }, [pager.reset])

  // 数据落地后按需安静刷新（不打断用户滚动位置）。
  // 「查找重复」标签上的数字必须用**服务端全量**统计。
  // 本面板的 dupGroups 只对**已加载的那一页**分组（懒加载 30–60 条时全为唯一 md5，显示 0），
  // 而「媒体资产」面板是全量口径（实测 200 组 / 574 个文件）—— 两者并存会让用户误以为没有重复。
  // 全量数字来自 getMediaAssets().duplicateFiles（对 hardlink 三表全量按 md5 分组）。
  const [dupTotal, setDupTotal] = useState(0)
  const [dupReclaim, setDupReclaim] = useState(0)
  const [dupGroupsServer, setDupGroupsServer] = useState<readonly MediaAssetDuplicate[]>([])
  const [dupError, setDupError] = useState<string | null>(null)
  const loadDupTotal = useCallback((): void => {
    void apiGetMediaAssets()
      .then((m) => {
        setDupTotal(m.duplicateFiles)
        setDupReclaim(m.reclaimBytes)
        setDupGroupsServer(m.duplicates)
        setDupError(null)
      })
      .catch((error: unknown) => {
        setDupError(error instanceof Error ? error.message : String(error ?? '未知错误'))
      })
  }, [])
  useEffect(() => { if (dupOpen) loadDupTotal() }, [dupOpen, loadDupTotal])
  useWechatDataUpdated(() => { if (dupOpen) loadDupTotal() })

  useWechatDataUpdated(() => { pager.reset() })

  // 关键词已在服务端过滤；这里只保留「类目由后端过滤」的结论（不再做客户端关键字过滤）。
  //
  // 此前这行是 `(f.fileName || f.md5)`：`||` 短路让 md5 **永远不参与比较**，
  // 所以「按 MD5 搜」在这个面板从来没有生效过 —— 现在由后端 `file_name LIKE ? OR md5 LIKE ?` 承担。
  const searched = files

  // 第 83 轮：不再在客户端硬过滤成 image —— 类目过滤由后端完成，
  // 「全部 / 图片 / 视频 / 文件」四个入口都能真正列出条目（此前视频 131、文件 579 全库打不开）。
  const visible = searched

  const countOf = (c: string): number => counts[c] ?? 0
  const countAll = countOf('image') + countOf('file') + countOf('video')

  /**
   * 网格虚拟化（#22 第三处）。列数**现测**（`repeat(auto-fill, minmax(200px,1fr))` 随容器宽度变）
   * 写死就会"最后一行被截掉"或"格子重叠"），而虚拟器数的是**行**；一行用内联
   * `repeat(cols, 1fr)` 还原网格排列，间距与数据外层的 `.grid` 相同。
   */
  /** 列数与**实测格宽**（缩略图宽度按格子实际宽度自适应，不再写死 320）。 */
  const { cols: fileCols, cellWidth } = useGridColumns(gridRef, FILE_MIN_COL_PX)
  const fileVirtualizer = useVirtualizer({
    count: gridRowCount(visible.length, fileCols),
    getScrollElement: () => gridRef.current,
    estimateSize: () => FILE_ROW_ESTIMATE_PX,
    overscan: 3,
  })
  /**
   * 缩略图宽度：按**实测格宽 × 设备像素比**取档（窄格/2x 屏不糊，也不会每拖一次窗口就多一份缓存）。
   */
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio
  const thumbWidth = useMemo(() => thumbWidthFor(cellWidth, dpr), [cellWidth, dpr])
  /** 可视优先 + 视区外预取两条 lane；LRU 上界按列数放大，预取不会挤掉屏上的图。 */
  const { thumbs: fileImgs, request: decodeThumb, prefetch: prefetchThumbs } = useFileThumbnails({ width: thumbWidth, cols: fileCols })

  // 视区外预取：虚拟器 range 每次滚动都会触发本组件重渲染，所以这里无依赖跑一遍；
  // 重复 key 由 hook 内的 fetched/queued 集合去重，不会重复发 RPC。
  useEffect(() => {
    prefetchThumbs(prefetchKeys(visible, fileCols, fileVirtualizer.range))
  })
  /** 图片开灯箱；视频/文件开**详情抽屉**（没有预览，但要看名称/来源/月份/md5）。 */
  const openFileCell = useCallback((f: FileItem): void => {
    if (f.category !== 'image') { setDetail(f); return }
    setPreview(f)
  }, [])

  // 重复组/名称补全的逻辑在 files-dup.ts（纯函数，受单函数行数棘轮约束）。
  const { nameByMd5, dupGroups } = useMemo(() => ({
    nameByMd5: namesByMd5(visible),
    dupGroups: duplicateGroups(visible),
  }), [visible])

  const { notice: exportNotice, flash: flashExport } = useActionNotice()
  const exportTask = useExportTask()
  const [refreshPending, setRefreshPending] = useState(false)

  useEffect(() => {
    if (!refreshPending || pager.loading) return
    setRefreshPending(false)
    if (pager.error) flashExport('刷新失败：' + pager.error)
    else flashExport('文件列表已刷新')
  }, [flashExport, pager.error, pager.loading, refreshPending])

  const doExport = async (): Promise<void> => {
    if (exportTask.running) return
    const outcome = await exportTask.run(async ({ jobId }) => apiExportCsv({ kind: 'files', jobId }), {
      idPrefix: 'files-export',
      label: '导出文件清单',
      successMessage: (r) => `已导出 ${r.count} 条文件清单（不含媒体本体）→ ${r.path}`,
    })
    if (outcome.ok) flashExport(outcome.message)
    else if (!outcome.canceled) flashExport('导出失败: ' + outcome.error)
  }

  /** 灯箱的翻页范围：已加载的图片，顺序与网格一致。 */
  const imageItems = useMemo(() => visible.filter((f) => f.category === 'image'), [visible])
  const viewerIndex = preview ? imageItems.findIndex((f) => fileKey(f) === fileKey(preview)) : -1

  return (
    <div className={css.panel}>
      {/* 首屏加载期间**不能**把计数写成 0：实测（真实 4305 个文件）进入本页后前 3–5 秒
          头部会显示「共 0 项 · 图片 0 / 视频 0 / 文件 0」，用户会以为自己的文件不见了。
          加载中就明确说「正在统计」，计数等到了再显示；分类标签同理不写 (0)。 */}
      <PanelHeader
        title="文件"
        desc={loading && total === 0 ? '正在统计本机文件索引…' : undefined}
        actions={(
          <>
            <PanelAction
              onClick={() => { setRefreshPending(true); refresh() }}
              disabled={refreshPending || pager.loading}
            >
              {refreshPending || pager.loading ? '刷新中…' : '刷新'}
            </PanelAction>
            <AssetMoreMenu items={[
              {
                key: 'export',
                label: exportTask.finishing ? '完成中…'
                  : exportTask.running ? '导出中…'
                    : desktopAction() ? '导出清单 CSV（仅电脑）' : '导出清单 CSV',
                onSelect: () => { void doExport() },
                disabled: exportTask.running,
                ...desktopActionProps(),
              },
              {
                key: 'dup',
                label: dupError ? '查找重复（统计失败）' : dupOpen || dupTotal > 0 ? `查找重复 (${dupTotal})` : '查找重复',
                onSelect: () => { setDupOpen(v => !v) },
              },
            ]} />
          </>
        )}
      />
      <ActionNoticeLine notice={exportNotice} />
      <ExportProgressStatus state={exportTask.state} onCancel={() => { void exportTask.cancel() }} />
      <FilesKpis total={total} counts={counts} loading={loading} />
      <ListFilter
        searchValue={search}
        onSearch={setSearch}
        searchPlaceholder="搜索文件名 / MD5"
        searchAriaLabel="搜索文件"
        segments={[
          { value: 'all', label: `全部 (${countAll})` },
          { value: 'image', label: `图片 (${countOf('image')})` },
          { value: 'video', label: `视频 (${countOf('video')})` },
          { value: 'file', label: `文件 (${countOf('file')})` },
        ].map((o) => (loading && countAll === 0 ? { ...o, label: o.label.replace(/\s*\(\d+\)$/, '') } : o))}
        value={cat}
        onChange={setCat}
        ariaLabel="文件分类"
      />
      <div className={`${css.grid} ${css.fileGrid}`} ref={gridRef}>
        {/* 骨架的列宽与真实 .fileGrid 一致（200px）：120px 的默认值会排成 10 列，
            数据到了之后突然变成 6 列，像是"布局跳了一下"。 */}
        {loading && <ListSkeleton rows={10} grid minCol={200} />}
        {error && <div className={kitCss.error} role="alert">文件数据接口尚未就绪（{error}）</div>}
        {/* 0 项要能自证：说明索引来自哪、以及"没配好数据源"这种情况该去哪配。
            否则用户看到"暂无文件"没法判断是"真没有"还是"没配对"。 */}
        {!loading && !error && visible.length === 0 && (
          <EmptyMaybeSyncing
            text="暂无文件"
            note="文件索引来自本机解密库的 hardlink 记录（图片 / 视频 / 文件三类）。若刚换过数据源，请先在「设置 → 数据配置」完成解密与保存配置，再回到本页刷新。"
          />
        )}
        {!loading && !error && visible.length > 0 && (
          /*
           * 外层这一格用 `gridColumn: 1 / -1` 横跨整个网格容器（容器仍是 `.grid`，
           * 所以骨架与空态的排列一个字没动），行在里面按测到的列数排。
           */
          <div style={{ gridColumn: '1 / -1', position: 'relative', height: fileVirtualizer.getTotalSize() }}>
            {fileVirtualizer.getVirtualItems().map((vi) => {
              const { start, end } = gridRowRange(vi.index, visible.length, fileCols)
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={fileVirtualizer.measureElement}
                  style={{
                    position: 'absolute', top: 0, left: 0, width: '100%',
                    transform: `translateY(${vi.start}px)`,
                    display: 'grid',
                    gridTemplateColumns: `repeat(${fileCols}, 1fr)`,
                    gap: FILE_GRID_GAP_PX,
                  }}
                >
                  {visible.slice(start, end).map((f) => (
                    <FileCell
                      key={`${f.category}:${f.md5}:${start}` + String(f.fileName ?? '')}
                      f={f}
                      imgSrc={f.category === 'image' ? fileImgs[fileKey(f)] || '' : ''}
                      onOpen={openFileCell}
                      onMounted={decodeThumb}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        )}
        {!loading && !error && pager.hasMore && <ListSentinel refFn={loadMoreRef} />}
      </div>
      <Drawer open={dupOpen} onClose={() => { setDupOpen(false) }} title="重复文件预览">
        {dupError
          ? <div className={kitCss.error} role="alert">重复文件统计失败：{dupError}</div>
          : <div className={kitCss.textCaption}>「去重」为只读建议，不在本机删除数据。下列为<strong>全库</strong>按内容（md5）归并的重复组，取前 {dupGroupsServer.length} 组（共 {dupTotal} 个重复文件、可回收约 {fmtBytes(dupReclaim)}）。</div>}
        {!dupError && dupGroupsServer.length === 0 && <div className={css.empty}>未发现重复文件</div>}
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
            <FileSourceRow item={detail} />
            <div className={css.kvRow}><span className={css.kvKey}>来源月份</span><span className={css.kvVal}>{detail.sourceMonth || '(未解析到)'}</span></div>
            <div className={css.kvRow}><span className={css.kvKey}>MD5</span><span className={`${css.kvVal} ${css.kvMono}`}>{detail.md5 || '(空)'}</span></div>
            <FileDetailSaveAction
              item={detail}
              onSaved={(saved) => {
                if (saved) flashExport(`已保存原文件 → ${saved.path ?? ''}`)
              }}
            />
            <div className={kitCss.textCaption}>
              来源会话来自附件目录（`dir1`/`dir2` → `dir2id`，其值是 md5(会话名)），
              与「消息资源」口径互为独立来源；本机数据两口径在图片上 200/200 一致。
              视频与文件不提供在线预览；可在此保存原文件，CSV 导出仍只含清单。
            </div>
          </div>
        )}
      </Drawer>
      {preview && viewerIndex >= 0 && (
        <FilesLightbox
          preview={preview}
          imageItems={imageItems}
          fileImgs={fileImgs}
          onIndexChange={(i) => { const next = imageItems[i]; if (next) setPreview(next) }}
          onClose={() => { setPreview(null) }}
          onSaved={(path) => { flashExport(`已保存原文件 → ${path}`) }}
        />
      )}
    </div>
  )
}

/**
 * 文件页的内联 KPI 条：首屏统计中不显示 0，避免被误读成「文件不见了」。
 * @param props.total - 全库文件数。
 * @param props.counts - 按类目的计数（来自服务端）。
 * @param props.loading - 首屏是否仍在统计。
 * @returns KPI 条（统计中不渲染）。
 */
function FilesKpis({ total, counts, loading }: {
  total: number
  counts: Record<string, number>
  loading: boolean
}): React.JSX.Element | null {
  if (loading && total === 0) return null
  const countOf = (c: string): number => counts[c] ?? 0
  return (
    <AssetKpiBar items={[
      { label: '文件总数', value: total.toLocaleString() },
      { label: '图片', value: countOf('image').toLocaleString() },
      { label: '视频', value: countOf('video').toLocaleString() },
      { label: '文件', value: countOf('file').toLocaleString() },
    ]} />
  )
}
