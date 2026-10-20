/**
 * 操作日志板块：元数据监控 / 筛选 / 导出（独立面板，从设置抽出）。
 * 仅记录操作元数据（时间/类型/动作/对象/结果/上下文），永不保存会话内容。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLazySentinel, usePagedList, ListSentinel } from './hooks.tsx'
import { apiClearOperationLog, apiGetOperationLog } from '../api.ts'
import type { OperationCategory, OperationLogEntry, OperationLogQuery, OperationStatus } from '@deepseek-ai/dsh-wechat-data/types'
import { Card, DataTable, DateRangeField, PanelHeader, SearchInput, Segmented, Select, useDebouncedValue } from '../ui/kit.tsx'
import { useConfirm } from '../ui/confirm.tsx'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import type { DataColumn } from '../ui/kit.tsx'
import css from './oplog.module.css'
import kitCss from '../ui/kit.module.css'

const OP_CATEGORY_LABEL: Record<OperationCategory, string> = {
  settings: '设置', keys: '密钥', sync: '解密/同步', export: '导出', delete: '删除',
  backup: '备份', edit: '编辑', task: '任务', error: '异常', clawbot: 'ClawBot',
}
const OP_STATUS_LABEL: Record<OperationStatus, string> = { ok: '成功', fail: '失败', skip: '跳过' }
const STATUS_FILTERS: ReadonlyArray<{ value: '' | OperationStatus; label: string }> = [
  { value: '', label: '全部' },
  { value: 'ok', label: '成功' },
  { value: 'fail', label: '失败' },
  { value: 'skip', label: '跳过' },
]

function opStamp(): string {
  const d = new Date()
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}
function opTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}
function opDownload(name: string, mime: string, content: string): void {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
function opCsvCell(v: string): string {
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

/**
 * 导出为制表符分隔的 TXT。
 *
 * 为什么放在模块级而不是面板函数里：`OperationLogPanel` 在函数行数棘轮上（上限 250 行），
 * 而这两段是**纯函数**（输入行数据、输出文件），不碰任何状态，没有理由占它的行数。
 * @param rows - 当前已加载的日志行。
 */
function exportOpLogTxt(rows: readonly OperationLogEntry[]): void {
  const header = '微信数据面板 · 操作日志\n时间\t类型\t操作\t对象\t结果\t上下文\n'
  const lines = rows.map(r => [opTime(r.ts), OP_CATEGORY_LABEL[r.category], r.action, r.target || '—', OP_STATUS_LABEL[r.status], r.detail || '—'].join('\t'))
  opDownload(`操作日志_${opStamp()}.txt`, 'text/plain;charset=utf-8', header + lines.join('\n'))
}

/**
 * 导出为 CSV（带 BOM，Excel 打开不乱码）。
 * @param rows - 当前已加载的日志行。
 */
function exportOpLogCsv(rows: readonly OperationLogEntry[]): void {
  const header = '时间,类型,操作,对象,结果,上下文\n'
  const lines = rows.map(r => [opTime(r.ts), OP_CATEGORY_LABEL[r.category], r.action, r.target || '—', OP_STATUS_LABEL[r.status], r.detail || '—'].map(opCsvCell).join(','))
  opDownload(`操作日志_${opStamp()}.csv`, 'text/csv;charset=utf-8', '\ufeff' + header + lines.join('\n'))
}

/** 状态徽标颜色。 */
function statusClass(status: OperationStatus): string {
  return (status === 'ok' ? css.stOk : status === 'fail' ? css.stFail : css.stSkip) ?? ''
}

/** 操作日志板块。 */
export function OperationLogPanel(): React.JSX.Element {
  /** 应用内确认框（替代原生 window.confirm）。 */
  const confirm = useConfirm()
  const [opRows, setOpRows] = useState<readonly OperationLogEntry[]>([])
  const [opTotal, setOpTotal] = useState(0)
  const [opLoading, setOpLoading] = useState(false)
  const [opMsg, setOpMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [opFrom, setOpFrom] = useState('')
  const [opTo, setOpTo] = useState('')
  const [opCat, setOpCat] = useState('')
  const [opStatus, setOpStatus] = useState<'' | OperationStatus>('')
  const [opSearch, setOpSearch] = useState('')
  /** 读失败与「确无记录」分开（W3-11.4）。 */
  const [opReadError, setOpReadError] = useState('')
  const opScrollRef = useRef<HTMLDivElement | null>(null)

  // 关键词现在由**服务端**过滤（后端原本只有时间 / 分类 / 状态三个条件）。
  // 这是必须的：日志只能按「最新 N 条」取一页，本端过滤等于**只搜最新那一页**
  // —— 实测 2144 条里只能搜到最新 500 条（覆盖率 23%），而按时间往回翻
  // 恰恰是审计场景最常见的动作。
  const opKw = useDebouncedValue(opSearch, 250).trim()

  const buildQuery = useCallback((offset: number, limit: number): OperationLogQuery => {
    const q: OperationLogQuery = { limit, offset }
    if (opFrom !== '') q.from = new Date(`${opFrom}T00:00:00`).getTime()
    if (opTo !== '') q.to = new Date(`${opTo}T23:59:59`).getTime()
    if (opCat !== '') q.categories = [opCat]
    if (opStatus !== '') q.status = opStatus
    if (opKw !== '') q.q = opKw
    return q
  }, [opFrom, opTo, opCat, opStatus, opKw])

  const pager = usePagedList<OperationLogEntry>({
    pageSize: 100,
    // 500 条 ≈ 3000 个单元格。上限的理由与实测数据见 `usePagedList` 的 `maxItems` 注释：
    // 无上限时哨兵会反复触发 loadMore，实测累积到 91,028 个节点、滚动 p90 837ms。
    // 审计要翻更早的记录用时间/分类/关键词筛选 —— 那本来也比滚 900 页更快。
    maxItems: 500,
    fetchPage: async (offset, limit) => {
      const snap = await apiGetOperationLog(buildQuery(offset, limit))
      // W3-11.4：「审计库打不开」与「没有操作记录」分开说。
      setOpReadError(snap.readError ?? '')
      return { items: snap.items, total: snap.total }
    },
  })

  useEffect(() => {
    setOpMsg(null)
    pager.reset()
  }, [buildQuery, pager.reset])

  useEffect(() => {
    setOpRows(pager.items)
    setOpTotal(pager.total)
    setOpLoading(pager.loading)
    if (pager.error) setOpMsg({ kind: 'err', text: '✗ 读取操作日志失败：' + pager.error })
  }, [pager.items, pager.total, pager.loading, pager.error])

  const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore) pager.loadMore() }, '600px 0px', () => opScrollRef.current, pager.items.length)

  const refresh = useCallback((): void => {
    setOpMsg(null)
    pager.reset()
  }, [pager.reset])

  const summary = useMemo(() => {
    let ok = 0; let fail = 0; let skip = 0
    for (const r of opRows) { if (r.status === 'ok') ok++; else if (r.status === 'fail') fail++; else skip++ }
    return { ok, fail, skip }
  }, [opRows])

  // 关键字已在服务端过滤（见 buildQuery 的 q）；这里刻意不再过滤一遍 ——
  // 本端过滤只会作用在「已加载的那一页」上，是此前覆盖率只有 23% 的根因。
  const rows = opRows

  const clearOpLog = async (): Promise<void> => {
    const ok = await confirm({
      title: '清空全部操作日志？',
      message: '审计记录会被全部删除，该操作不可恢复。',
      tone: 'danger',
      confirmText: '清空',
    })
    if (!ok) return
    setOpLoading(true)
    try {
      const r = await apiClearOperationLog()
      if (r.ok) { setOpRows([]); setOpTotal(0); setOpMsg({ kind: 'ok', text: `✓ 已清空 ${r.removed} 条` }) }
      else setOpMsg({ kind: 'err', text: '✗ 清空失败' })
    } catch (e) {
      setOpMsg({ kind: 'err', text: '✗ ' + (e as Error).message })
    } finally {
      setOpLoading(false)
    }
  }
  const opCols: ReadonlyArray<DataColumn<OperationLogEntry>> = [
    {
      id: 'time',
      header: '时间',
      className: css.tdTime,
      cell: r => <span className={css.tdTime}>{opTime(r.ts)}</span>,
      sortValue: r => r.ts,
    },
    {
      id: 'category',
      header: '类型',
      className: css.tdType,
      cell: r => <span className={css.tdType}>{OP_CATEGORY_LABEL[r.category]}</span>,
      sortValue: r => OP_CATEGORY_LABEL[r.category],
    },
    {
      id: 'action',
      header: '操作',
      className: css.tdAction,
      cell: r => <span className={css.tdAction}>{r.action}</span>,
      sortValue: r => r.action,
    },
    {
      id: 'target',
      header: '对象',
      className: css.tdTarget,
      cell: r => <span title={r.target}>{r.target || '—'}</span>,
      sortValue: r => r.target || '',
    },
    {
      id: 'status',
      header: '结果',
      className: css.tdStatus,
      cell: r => <span className={clsx(css.st, statusClass(r.status))}>{OP_STATUS_LABEL[r.status]}</span>,
      sortValue: r => OP_STATUS_LABEL[r.status],
    },
    {
      id: 'detail',
      header: '上下文',
      cell: r => <span title={r.detail}>{r.detail || '—'}</span>,
      sortValue: r => r.detail || '',
    },
  ]


  return (
    <section className={css.root}>
      <PanelHeader
        title="操作日志"
        desc="仅记录操作元数据（时间/类型/动作/对象/结果/上下文），不保存会话内容 · 最多 500 条"
        actions={(
          <ActionMenu
            busy={opLoading}
            canExport={rows.length > 0}
            canClear={!opLoading && opTotal > 0}
            onRefresh={refresh}
            onExportTxt={() => { exportOpLogTxt(rows) }}
            onExportCsv={() => { exportOpLogCsv(rows) }}
            onClear={() => { void clearOpLog() }}
          />
        )}
      />

      {/* 微信化：筛选区不再套 Card 外壳（一层容器包一层）；统计改筛选行右侧的灰字。 */}
      <div className={css.filterWrap}>
        <div className={css.filterRow}>
          <DateRangeField
            from={opFrom}
            to={opTo}
            onFrom={setOpFrom}
            onTo={setOpTo}
            onClear={() => { setOpFrom(''); setOpTo('') }}
            presets={['today', 'week', 'month', 'last-7', 'last-30']}
            ariaLabel="操作日志时间筛选"
            /* Wave D1：inline = 预设与起止日期同一行（原来默认是上下两行 62px，
               把筛选区从 62 压到 36 → toolbarH 进 ≤48 目标）。窄窗口仍由 flex-wrap 折行。 */
            inline
          />
          <Select
            value={opCat}
            onChange={(v) => { setOpCat(v) }}
            options={[{ value: '', label: '全部分类' }, ...(Object.keys(OP_CATEGORY_LABEL) as OperationCategory[]).map(c => ({ value: c, label: OP_CATEGORY_LABEL[c] }))]}
            ariaLabel="分类筛选"
          />
          <Segmented
            options={STATUS_FILTERS.map(f => ({ value: f.value, label: f.label }))}
            value={opStatus}
            onChange={(v) => { setOpStatus(v as '' | OperationStatus) }}
            ariaLabel="结果筛选"
          />
          <span className={css.statText}>
            成功 {summary.ok} · 失败 {summary.fail} · 跳过 {summary.skip} · 共 {opTotal} 条
          </span>
        </div>
        <div className={css.filterSearchRow}>
          <SearchInput className={css.searchFlex} value={opSearch} onChange={(v) => { setOpSearch(v) }} placeholder="搜索操作/对象/上下文" ariaLabel="搜索操作日志" />
        </div>
      </div>

      {opMsg && <div className={clsx(css.notice, opMsg.kind === 'ok' ? css.noticeOk : css.noticeErr)}>{opMsg.text}</div>}

      <Card className={css.tableCard} flush>
        {opReadError && <div className={kitCss.error} role="alert">⚠️ {opReadError}</div>}
        <DataTable
          columns={opCols}
          rows={rows}
          getRowId={r => String(r.id)}
          loading={opLoading && rows.length === 0}
          emptyTitle={opLoading ? '加载中…' : opReadError ? '操作日志读不出来' : '暂无操作日志，点击「刷新」后分页显示'}
        />
        {/* 触到 500 条上界时明说，而不是让用户以为「下面没有了」。 */}
        {pager.capped && (
          <div className={css.capNote} role="status">
            已加载最近 {rows.length} 条（共 {opTotal} 条）。要查更早的记录，请用上方的时间 / 分类 / 关键词筛选缩小范围。
          </div>
        )}
        {pager.hasMore && <ListSentinel refFn={loadMoreRef} />}
      </Card>
    </section>
  )
}

/**
 * 页头「更多 ▾」动作菜单（Wave D2）。
 *
 * 为什么单独成组件、而不是塞在 `OperationLogPanel` 里：
 *   ① 面板函数在**函数行数棘轮（≤250 行）**上，动作菜单的开关态与 4 个按钮会把它顶过线；
 *   ② 菜单开合用**条件渲染**而不是 `<details>`：关闭的 `<details>` 内容仍在 DOM 里，
 *      会被响应式审计判成「业务文本被隐藏」（实测 `_morePanel_` 6 条 × 70 格），
 *      也违反「别用隐藏元素装内容」的纪律。
 * 动作一个不少：刷新 / 导出 TXT / 导出 CSV / 清空（清空仍受桌面动作门控）。
 */
function ActionMenu({ busy, canExport, canClear, onRefresh, onExportTxt, onExportCsv, onClear }: {
  busy: boolean
  canExport: boolean
  canClear: boolean
  onRefresh: () => void
  onExportTxt: () => void
  onExportCsv: () => void
  onClear: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div className={css.moreMenu}>
      <button
        type="button"
        className={css.moreBtn}
        aria-label="更多操作"
        aria-expanded={open}
        onClick={() => { setOpen(v => !v) }}
      >
        更多 ▾
      </button>
      {open && (
        <div className={css.morePanel} onMouseLeave={() => { setOpen(false) }}>
          <Button size="sm" variant="outline" icon={busy ? <span className={css.spin} /> : undefined} onClick={() => { setOpen(false); onRefresh() }} disabled={busy}>{busy ? '加载中…' : '刷新'}</Button>
          <Button size="sm" variant="outline" onClick={() => { setOpen(false); onExportTxt() }} disabled={!canExport}>导出 TXT</Button>
          <Button size="sm" variant="outline" onClick={() => { setOpen(false); onExportCsv() }} disabled={!canExport}>导出 CSV</Button>
          <Button size="sm" variant="outline" onClick={() => { setOpen(false); onClear() }} disabled={!canClear} {...desktopActionProps()}>清空</Button>
        </div>
      )}
    </div>
  )
}
