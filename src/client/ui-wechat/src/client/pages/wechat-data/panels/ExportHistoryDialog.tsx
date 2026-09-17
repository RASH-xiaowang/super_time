/**
 * 导出记录（导出历史）弹窗。
 *
 * 每一条记录都对应一次真实发生过的导出，用户能据此：
 *   · 打开文件 / 在文件夹中显示 / 复制路径  —— 找得到自己导出的东西
 *   · 按原参数重新导出                      —— 重复导出（如每月导出同一会话）不必重走一遍界面
 *   · 删除记录 / 删除记录并删文件            —— 两件事分开，删文件必须显式确认
 *   · 清理失效记录 / 按天数或条数批量清理     —— 历史不会无限增长
 *
 * 两条刻意的安全设计（对应用例）：
 *   ① 删除记录**默认不删文件**（风险差一个量级，必须显式选择）；
 *   ② 「重新导出」会先弹保存对话框让用户选路径，**不覆盖原文件**。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ListSentinel, useLazySentinel, usePagedList, useTransientNotice } from './hooks.tsx'
import {
  apiDeleteExportHistory,
  apiExportAllSessions,
  apiExportAnnualReport,
  apiExportCsv,
  apiExportMoments,
  apiExportSessionMessages,
  apiGetExportHistory,
  apiOpenPath,
  apiPruneExportHistory,
  apiSaveFileDialog,
} from '../api.ts'
import type { ExportHistoryEntry, ExportHistoryQuery, ExportStatus } from '@deepseek-ai/dsh-wechat-data/types'
import { Badge, DataTable, Dialog, SearchInput, Segmented, Select } from '../ui/kit.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import type { DataColumn } from '../ui/kit.tsx'
import css from './export-history.module.css'
import kitCss from '../ui/kit.module.css'

/** 导出种类 → 中文名。未知种类原样显示（后端可能先于前端新增种类）。 */
const KIND_LABEL: Record<string, string> = {
  contacts: '通讯录',
  favorites: '收藏',
  records: '记录',
  moments: '朋友圈',
  privacy: '隐私扫描',
  session: '会话消息',
  annual: '年度报告',
  all_sessions: '全部会话',
  backup: '备份',
}

const STATUS_LABEL: Record<ExportStatus, string> = { ok: '成功', fail: '失败', canceled: '已取消' }

const STATUS_OPTIONS: ReadonlyArray<{ value: '' | ExportStatus; label: string }> = [
  { value: '', label: '全部' },
  { value: 'ok', label: '成功' },
  { value: 'fail', label: '失败' },
  { value: 'canceled', label: '已取消' },
]

const SORT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'ts:desc', label: '最新优先' },
  { value: 'ts:asc', label: '最早优先' },
  { value: 'size:desc', label: '文件最大' },
  { value: 'rows:desc', label: '条数最多' },
  { value: 'name:asc', label: '文件名 A→Z' },
]

function fmtTime(ts: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

/** 字节数 → 人类可读。null 表示目录型导出或文件已不存在。 */
function fmtSize(n: number | null): string {
  if (n === null) return '—'
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}

function statusClass(status: ExportStatus): string {
  return status === 'ok' ? css.stOk : status === 'fail' ? css.stFail : css.stSkip
}

/** 把 params JSON 解析成对象；坏数据返回 null（「重新导出」按钮据此置灰）。 */
function parseParams(raw: string): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * 导出记录弹窗。
 * @param props.open - 是否显示。
 * @param props.onClose - 关闭回调。
 * @param props.initialKind - 打开时默认选中的导出种类（从某个面板进来时按上下文预筛，
 *   例如通讯录打开就只看通讯录导出）。用户可在下拉里改回「全部」。
 * @returns 弹窗元素。
 */
export function ExportHistoryDialog({ open, onClose, initialKind = '' }: {
  open: boolean
  onClose: () => void
  initialKind?: string
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const [kind, setKind] = useState(initialKind)
  const [status, setStatus] = useState<'' | ExportStatus>('')
  const [sortKey, setSortKey] = useState('ts:desc')
  const [onlyMissing, setOnlyMissing] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set())
  const [busy, setBusy] = useState(false)
  const { notice, flash, hold } = useTransientNotice(4000)
  /** 应用内确认框（替代原生 window.confirm）。 */
  const confirm = useConfirm()
  const [counts, setCounts] = useState<{ total: number; bytes: number; missing: number; fail: number; kindCounts: Record<string, number> }>({
    total: 0, bytes: 0, missing: 0, fail: 0, kindCounts: {},
  })

  // 每次**打开**都重置到调用方给的上下文筛选（并清掉上一次的搜索/勾选）。
  // 只在 open 变 true 时执行，避免弹窗开着时被外部 props 变化打断用户操作。
  useEffect(() => {
    if (!open) return
    setKind(initialKind)
    setQ('')
    setStatus('')
    setOnlyMissing(false)
    setSelected(new Set())
  }, [open, initialKind])

  const buildQuery = useCallback((offset: number, limit: number): ExportHistoryQuery => {
    const [sort, order] = sortKey.split(':')
    const query: ExportHistoryQuery = {
      limit,
      offset,
      sort: (sort ?? 'ts') as ExportHistoryQuery['sort'],
      order: (order === 'asc' ? 'asc' : 'desc'),
    }
    if (q.trim() !== '') query.q = q.trim()
    if (kind !== '') query.kinds = [kind]
    if (status !== '') query.status = status
    return query
  }, [q, kind, status, sortKey])

  const pager = usePagedList<ExportHistoryEntry>({
    pageSize: 100,
    fetchPage: async (offset, limit) => {
      const snap = await apiGetExportHistory(buildQuery(offset, limit))
      // 聚合计数每次都用**当前筛选**的结果刷新（后端按未分页的命中集合算）
      setCounts({
        total: snap.total,
        bytes: snap.totalBytes,
        missing: snap.missingCount,
        fail: snap.statusCounts['fail'] ?? 0,
        kindCounts: snap.kindCounts,
      })
      return { items: snap.items, total: snap.total }
    },
  })

  // 筛选条件变化 → 回到第一页重取（并把勾选清掉：跨筛选保留勾选会让「批量删除」
  // 删掉用户当前看不到的行）。
  useEffect(() => {
    setSelected(new Set())
    pager.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, kind, status, sortKey])

  const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore) pager.loadMore() }, '400px 0px')

  /** 只看失效记录：这是**客户端**筛选（文件在不在磁盘上只有本地知道），
   *  所以只在已加载的页里过滤，并在界面上说明「仅当前已加载」。 */
  const rows = useMemo(() => {
    if (!onlyMissing) return pager.items
    return pager.items.filter(r => !r.existsNow)
  }, [pager.items, onlyMissing])

  const refresh = useCallback((): void => { pager.reset() }, [pager])

  const toggleOne = useCallback((id: number): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  const toggleAllLoaded = useCallback((): void => {
    setSelected((prev) => {
      const ids = rows.map(r => r.id)
      const allIn = ids.length > 0 && ids.every(id => prev.has(id))
      const next = new Set(prev)
      if (allIn) for (const id of ids) next.delete(id)
      else for (const id of ids) next.add(id)
      return next
    })
  }, [rows])

  /** 打开文件。文件已被外部删除时**明确告知**，而不是静默失败。 */
  const openFile = useCallback(async (r: ExportHistoryEntry): Promise<void> => {
    if (!r.existsNow) { hold('文件已不在原位置（可能被移动或删除）'); return }
    try {
      await apiOpenPath(r.path)
    } catch (e) {
      hold('打开失败：' + (e as Error).message)
    }
  }, [hold])

  /** 在资源管理器中定位。走 preload 的 `showInFolder`（与「诊断日志 → 打开所在目录」同一个）。 */
  const revealFile = useCallback(async (r: ExportHistoryEntry): Promise<void> => {
    if (!r.existsNow) { hold('文件已不在原位置（可能被移动或删除）'); return }
    try {
      const api = (window as unknown as { electronAPI?: { showInFolder?: (p: string) => Promise<unknown> } }).electronAPI
      if (!api?.showInFolder) { hold('当前环境不支持「在文件夹中显示」'); return }
      await api.showInFolder(r.path)
    } catch (e) {
      hold('定位失败：' + (e as Error).message)
    }
  }, [hold])

  const copyPath = useCallback(async (r: ExportHistoryEntry): Promise<void> => {
    try {
      await navigator.clipboard.writeText(r.path)
      flash('已复制路径')
    } catch {
      hold('复制失败')
    }
  }, [flash, hold])

  /**
   * 按原参数重新导出。
   *
   * 刻意**先弹保存对话框**：直接写回原路径会静默覆盖用户上一次的导出物，
   * 而「重新导出」的语义是「再来一份」，不是「覆盖」。
   */
  const reExport = useCallback(async (r: ExportHistoryEntry): Promise<void> => {
    const params = parseParams(r.params)
    if (!params) { hold('这条记录缺少可重跑的参数'); return }
    const ext = r.format || 'csv'
    const picked = await apiSaveFileDialog({
      defaultName: r.filename || `export.${ext}`,
      title: '重新导出到…',
    })
    if (picked.canceled || !picked.path) return
    setBusy(true)
    try {
      // 每种导出把自己的参数与「新目标路径」拼起来；种类不匹配时明确报错，
      // 不猜测用户意图。
      if (r.kind === 'contacts' || r.kind === 'favorites' || r.kind === 'records' || r.kind === 'moments' || r.kind === 'privacy') {
        const res = await apiExportCsv({ ...(params as { kind: string; recordsKind?: string; category?: string }), dest: picked.path })
        flash(`已重新导出 ${res.count} 行`)
      } else if (r.kind === 'annual') {
        const res = await apiExportAnnualReport({ ...(params as { year: number; format: string }), dir: undefined, filename: picked.path })
        flash(`已重新导出 ${res.count} 条`)
      } else if (r.kind === 'session') {
        const res = await apiExportSessionMessages({ ...(params as { username: string; format: string }), dir: undefined, filename: picked.path })
        flash(`已重新导出 ${res.count} 条`)
      } else if (r.kind === 'all_sessions') {
        const res = await apiExportAllSessions({ filename: picked.path })
        flash(`已重新导出 ${res.count} 条`)
      } else if (r.kind === 'backup') {
        hold('备份请在「备份管家」里重新创建（备份包含加密口令，不能从历史重放）')
      } else {
        hold(`暂不支持重新导出「${KIND_LABEL[r.kind] ?? r.kind}」`)
      }
      refresh()
    } catch (e) {
      hold('重新导出失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [flash, hold, refresh])

  const deleteSelected = useCallback(async (alsoFiles: boolean): Promise<void> => {
    const ids = [...selected]
    if (ids.length === 0) return
    const ok = await confirm({
      title: alsoFiles ? `删除 ${ids.length} 条记录及其文件？` : `删除 ${ids.length} 条导出记录？`,
      message: alsoFiles
        ? '记录与磁盘上的导出文件都会被删除，该操作不可恢复。'
        : '只删除历史记录，磁盘上的导出文件会保留。',
      tone: 'danger',
      confirmText: alsoFiles ? '删除记录与文件' : '删除记录',
      // 批量删文件不可逆：要求逐字输入以确认（与 GitHub 删除仓库同一套保护）。
      ...(alsoFiles && ids.length >= 5 ? { requireText: `删除 ${ids.length} 条` } : {}),
    })
    if (!ok) return
    setBusy(true)
    try {
      const res = await apiDeleteExportHistory({ ids, deleteFiles: alsoFiles })
      const extra = alsoFiles ? `，删除 ${res.filesDeleted} 个文件` : ''
      const errs = res.fileErrors.length > 0 ? `；${res.fileErrors.length} 个文件删除失败` : ''
      flash(`已删除 ${res.removed} 条记录${extra}${errs}`)
      setSelected(new Set())
      refresh()
    } catch (e) {
      hold('删除失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [selected, confirm, flash, hold, refresh])

  const deleteOne = useCallback(async (r: ExportHistoryEntry): Promise<void> => {
    const ok = await confirm({
      title: '删除这条导出记录？',
      message: (
        <>
          <code>{r.filename}</code>
          <br />
          只删除历史记录，**不会**删除文件本身。
        </>
      ),
      tone: 'danger',
      confirmText: '删除记录',
    })
    if (!ok) return
    try {
      await apiDeleteExportHistory({ ids: [r.id] })
      flash('已删除记录（文件保留）')
      refresh()
    } catch (e) {
      hold('删除失败：' + (e as Error).message)
    }
  }, [confirm, flash, hold, refresh])

  const prune = useCallback(async (mode: 'missing' | '30d' | 'keep50', deleteFiles: boolean): Promise<void> => {
    const title = mode === 'missing' ? '清理所有失效记录？'
      : mode === '30d' ? '清理 30 天前的记录？' : '只保留最近 50 条记录？'
    const message = mode === 'missing'
      ? '这些记录指向的文件在磁盘上已不存在，清理后不再出现在列表里。'
      : mode === '30d' ? '30 天前的导出记录会被删除，该操作不可恢复。'
        : '除最近 50 条外的导出记录都会被删除，该操作不可恢复。'
    const ok = await confirm({
      title,
      message: deleteFiles ? `${message}\n（同时会删除对应文件）` : message,
      tone: 'danger',
      confirmText: '清理',
    })
    if (!ok) return
    setBusy(true)
    try {
      const opts = mode === 'missing' ? { onlyMissing: true, deleteFiles }
        : mode === '30d' ? { olderThanDays: 30, deleteFiles }
          : { keepLatest: 50, deleteFiles }
      const res = await apiPruneExportHistory(opts)
      flash(res.removed > 0 ? `已清理 ${res.removed} 条记录${deleteFiles ? `，${res.filesDeleted} 个文件` : ''}` : '没有需要清理的记录')
      setSelected(new Set())
      refresh()
    } catch (e) {
      hold('清理失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [confirm, flash, hold, refresh])

  const columns: ReadonlyArray<DataColumn<ExportHistoryEntry>> = useMemo(() => [
    {
      id: 'pick',
      header: (
        <label className={css.pickCell} title="选择本页全部">
          <input
            type="checkbox"
            className={css.pick}
            aria-label="选择本页全部"
            checked={rows.length > 0 && rows.every(r => selected.has(r.id))}
            onChange={toggleAllLoaded}
          />
        </label>
      ),
      className: css.tdPick,
      cell: r => (
        <label className={css.pickCell} title={selected.has(r.id) ? '取消选择' : '选择这一行'}>
          <input
            type="checkbox"
            className={css.pick}
            aria-label={`选择 ${r.filename}`}
            checked={selected.has(r.id)}
            onChange={() => { toggleOne(r.id) }}
          />
        </label>
      ),
    },
    {
      id: 'time',
      header: '时间',
      className: css.tdTime,
      cell: r => <span className={css.tdTime}>{fmtTime(r.ts)}</span>,
      sortValue: r => r.ts,
    },
    {
      id: 'kind',
      header: '类型',
      className: css.tdKind,
      cell: r => <span className={css.kindChip}>{KIND_LABEL[r.kind] ?? r.kind}</span>,
      sortValue: r => KIND_LABEL[r.kind] ?? r.kind,
    },
    {
      id: 'label',
      header: '说明',
      cell: r => <span title={r.label}>{r.label || '—'}</span>,
      sortValue: r => r.label,
    },
    {
      id: 'file',
      header: '文件',
      cell: r => (
        <span className={clsx(css.fileCell, !r.existsNow && css.fileGone)} title={r.path}>
          {r.existsNow ? r.filename : `${r.filename}（已不在原位置）`}
        </span>
      ),
      sortValue: r => r.filename,
    },
    {
      id: 'size',
      header: '大小',
      align: 'right',
      className: css.tdNum,
      cell: r => <span className={css.tdNum}>{fmtSize(r.sizeBytes)}</span>,
      sortValue: r => r.sizeBytes ?? -1,
    },
    {
      id: 'rows',
      header: '条数',
      align: 'right',
      className: css.tdNum,
      cell: r => <span className={css.tdNum}>{r.rows > 0 ? r.rows.toLocaleString() : '—'}</span>,
      sortValue: r => r.rows,
    },
    {
      id: 'status',
      header: '结果',
      className: css.tdStatus,
      cell: r => <span className={clsx(css.st, statusClass(r.status))} title={r.error}>{STATUS_LABEL[r.status]}</span>,
      sortValue: r => r.status,
    },
    {
      id: 'ops',
      header: '操作',
      className: css.tdOps,
      cell: r => (
        <span className={css.ops}>
          <button type="button" className={css.opBtn} disabled={!r.existsNow} onClick={() => { void openFile(r) }} title={r.existsNow ? '用系统默认程序打开' : '文件已不在原位置'}>打开</button>
          <button type="button" className={css.opBtn} disabled={!r.existsNow} onClick={() => { void revealFile(r) }} title="在资源管理器中定位">定位</button>
          <button type="button" className={css.opBtn} onClick={() => { void copyPath(r) }} title="复制完整路径">复制路径</button>
          <button
            type="button"
            className={css.opBtn}
            disabled={busy || parseParams(r.params) === null}
            onClick={() => { void reExport(r) }}
            title={parseParams(r.params) === null ? '这条记录缺少可重跑的参数' : '按原参数重新导出（会让你选新路径）'}
          >重新导出</button>
          <button type="button" className={clsx(css.opBtn, css.opDanger)} onClick={() => { void deleteOne(r) }} title="删除这条记录（文件保留）">删除</button>
        </span>
      ),
    },
  ], [rows, selected, busy, toggleAllLoaded, toggleOne, openFile, revealFile, copyPath, reExport, deleteOne])

  const kindOptions = useMemo(() => {
    const keys = Object.keys(counts.kindCounts).sort()
    return [
      { value: '', label: `全部${counts.total > 0 ? ` (${counts.total})` : ''}` },
      ...keys.map(k => ({ value: k, label: `${KIND_LABEL[k] ?? k} (${counts.kindCounts[k] ?? 0})` })),
    ]
  }, [counts])

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className={css.dialogWide}
      title={(
        <span className={css.titleBox}>
          <span className={css.titleMain}>
            <StateDot state={counts.fail > 0 ? 'warning' : 'done'} />
            导出记录
            {counts.missing > 0 && <Badge tone="amber">{counts.missing} 条文件已不在原位置</Badge>}
            {counts.fail > 0 && <Badge tone="red">{counts.fail} 条失败</Badge>}
          </span>
          <span className={css.titleMeta}>
            {counts.total} 条记录 · 合计 {fmtSize(counts.bytes)}
            {selected.size > 0 ? ` · 已选 ${selected.size} 条` : ''}
          </span>
        </span>
      )}
      footer={(
        <div className={css.footerRow}>
          <div className={css.footerGroup}>
            <Button size="sm" variant="outline" disabled={busy || selected.size === 0} onClick={() => { void deleteSelected(false) }}>
              删除选中记录
            </Button>
            <Button size="sm" variant="outline" disabled={busy || selected.size === 0} onClick={() => { void deleteSelected(true) }}>
              删除并删文件
            </Button>
          </div>
          <div className={css.footerGroup}>
            <span className={css.footerHint}>清理：</span>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void prune('missing', false) }}>失效记录</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void prune('30d', false) }}>30 天前</Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void prune('keep50', false) }}>只留最近 50 条</Button>
            <Button size="sm" variant="outline" onClick={onClose}>关闭</Button>
          </div>
        </div>
      )}
    >
      {notice && <div className={css.notice}>{notice}</div>}
      {/* 筛选行：不用 kit 的 Toolbar（它内部套了一个面板盒子，悬在表格上方像一块
          漂浮的卡片）。这里排成一行，与表格连成一体。 */}
      <div className={css.filterRow}>
        <SearchInput
          className={css.searchFlex}
          value={q}
          onChange={setQ}
          placeholder="搜索文件名 / 说明 / 路径"
          ariaLabel="搜索导出记录"
        />
        <Select value={kind} onChange={setKind} options={kindOptions} ariaLabel="导出类型筛选" />
        <Segmented
          options={STATUS_OPTIONS.map(o => ({ value: o.value, label: o.label }))}
          value={status}
          onChange={(v) => { setStatus(v as '' | ExportStatus) }}
          ariaLabel="结果筛选"
        />
        <Select value={sortKey} onChange={setSortKey} options={SORT_OPTIONS.map(o => ({ value: o.value, label: o.label }))} ariaLabel="排序" />
        <Button
          size="sm"
          variant={onlyMissing ? 'primary' : 'outline'}
          onClick={() => { setOnlyMissing(v => !v) }}
          title="只显示文件已不在原位置的记录（仅筛选当前已加载的记录）"
        >只看失效</Button>
        <Button size="sm" variant="outline" disabled={pager.loading} onClick={refresh}>刷新</Button>
      </div>
      {/*
        只有一个滚动容器：外层 `.dialogBd`（见 export-history.module.css 里对
        `.tableWrap` 取消 max-height 的说明）。所以这里**不套**滚动 div，续页哨兵
        直接跟在表格后面 —— 它以视口为 root，滚到可见即加载下一页。
      */}
      <div className={css.tableHost}>
        <DataTable
          columns={columns}
          rows={rows}
          getRowId={r => String(r.id)}
          loading={pager.loading}
          skeletonRows={6}
          emptyTitle={pager.loading ? '正在读取…' : (onlyMissing ? '没有失效记录' : '还没有导出记录')}
          emptyDesc={onlyMissing
            ? '所有记录的导出文件都还在原位置。'
            : '在通讯录、聊天、朋友圈等面板点「导出」后，这里会出现记录，可打开文件、复制路径或按原参数重新导出。'}
        />
        {!pager.loading && pager.hasMore && <ListSentinel refFn={loadMoreRef} />}
      </div>
      {pager.error && <div className={kitCss.error} role="alert">读取导出记录失败：{pager.error}</div>}
      {onlyMissing && !pager.loading && rows.length === 0 && pager.items.length > 0 && (
        <div className={kitCss.textMeta}>当前已加载的 {pager.items.length} 条里没有失效记录；继续向下滚动可加载更多。</div>
      )}
    </Dialog>
  )
}
