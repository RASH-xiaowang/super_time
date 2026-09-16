/**
 * 操作日志板块：元数据监控 / 筛选 / 导出（独立面板，从设置抽出）。
 * 仅记录操作元数据（时间/类型/动作/对象/结果/上下文），永不保存会话内容。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useLazySentinel, usePagedList, ListSentinel } from './hooks.tsx'
import { apiClearOperationLog, apiGetOperationLog } from '../api.ts'
import type { OperationCategory, OperationLogEntry, OperationLogQuery, OperationStatus } from '@deepseek-ai/dsh-wechat-data/types'
import { Badge, Card, DataTable, PanelHeader, SearchInput, Segmented, Select, Toolbar } from '../ui/kit.tsx'
import type { DataColumn } from '../ui/kit.tsx'
import css from './oplog.module.css'
import kitCss from '../ui/kit.module.css'

const OP_CATEGORY_LABEL: Record<OperationCategory, string> = {
  settings: '设置', keys: '密钥', sync: '解密/同步', export: '导出', delete: '删除',
  backup: '备份', edit: '编辑', task: '任务', error: '异常',
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

/** 状态徽标颜色。 */
function statusClass(status: OperationStatus): string {
  return (status === 'ok' ? css.stOk : status === 'fail' ? css.stFail : css.stSkip) ?? ''
}

/** 操作日志板块。 */
export function OperationLogPanel(): React.JSX.Element {
  const [opRows, setOpRows] = useState<readonly OperationLogEntry[]>([])
  const [opTotal, setOpTotal] = useState(0)
  const [opLoading, setOpLoading] = useState(false)
  const [opMsg, setOpMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [opFrom, setOpFrom] = useState('')
  const [opTo, setOpTo] = useState('')
  const [opCat, setOpCat] = useState('')
  const [opStatus, setOpStatus] = useState<'' | OperationStatus>('')
  const [opSearch, setOpSearch] = useState('')
  const opScrollRef = useRef<HTMLDivElement | null>(null)

  const buildQuery = useCallback((offset: number, limit: number): OperationLogQuery => {
    const q: OperationLogQuery = { limit, offset }
    if (opFrom !== '') q.from = new Date(`${opFrom}T00:00:00`).getTime()
    if (opTo !== '') q.to = new Date(`${opTo}T23:59:59`).getTime()
    if (opCat !== '') q.categories = [opCat]
    if (opStatus !== '') q.status = opStatus
    return q
  }, [opFrom, opTo, opCat, opStatus])

  const pager = usePagedList<OperationLogEntry>({
    pageSize: 100,
    fetchPage: async (offset, limit) => {
      const snap = await apiGetOperationLog(buildQuery(offset, limit))
      return { items: snap.items, total: snap.total }
    },
  })

  const searching = opSearch.trim() !== ''
  useEffect(() => {
    setOpMsg(null)
    if (searching) {
      let cancelled = false
      setOpLoading(true)
      void apiGetOperationLog(buildQuery(0, 500))
        .then((snap) => {
          if (cancelled) return
          setOpRows(snap.items)
          setOpTotal(snap.total)
        })
        .catch((e: unknown) => { if (!cancelled) setOpMsg({ kind: 'err', text: '✗ 读取操作日志失败：' + (e as Error).message }) })
        .finally(() => { if (!cancelled) setOpLoading(false) })
      return () => { cancelled = true }
    }
    pager.reset()
    return undefined
  }, [searching, buildQuery, pager.reset])

  useEffect(() => {
    if (searching) return
    setOpRows(pager.items)
    setOpTotal(pager.total)
    setOpLoading(pager.loading)
    if (pager.error) setOpMsg({ kind: 'err', text: '✗ 读取操作日志失败：' + pager.error })
  }, [searching, pager.items, pager.total, pager.loading, pager.error])

  const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore) pager.loadMore() }, '600px 0px', () => opScrollRef.current)

  const refresh = useCallback((): void => {
    setOpMsg(null)
    if (searching) {
      setOpLoading(true)
      void apiGetOperationLog(buildQuery(0, 500))
        .then((snap) => { setOpRows(snap.items); setOpTotal(snap.total) })
        .catch((e: unknown) => { setOpMsg({ kind: 'err', text: '✗ 读取操作日志失败：' + (e as Error).message }) })
        .finally(() => { setOpLoading(false) })
    } else {
      pager.reset()
    }
  }, [searching, buildQuery, pager.reset])

  const summary = useMemo(() => {
    let ok = 0; let fail = 0; let skip = 0
    for (const r of opRows) { if (r.status === 'ok') ok++; else if (r.status === 'fail') fail++; else skip++ }
    return { ok, fail, skip }
  }, [opRows])

  // client-side keyword filter on the loaded page (action / target / detail)
  const rows = useMemo(() => {
    const kw = opSearch.trim().toLowerCase()
    if (!kw) return opRows
    return opRows.filter(r => [r.action, r.target, r.detail].some(v => v.toLowerCase().includes(kw)))
  }, [opRows, opSearch])

  const exportOpTxt = (): void => {
    const header = '微信数据面板 · 操作日志\n时间\t类型\t操作\t对象\t结果\t上下文\n'
    const lines = rows.map(r => [opTime(r.ts), OP_CATEGORY_LABEL[r.category], r.action, r.target || '—', OP_STATUS_LABEL[r.status], r.detail || '—'].join('\t'))
    opDownload(`操作日志_${opStamp()}.txt`, 'text/plain;charset=utf-8', header + lines.join('\n'))
  }
  const exportOpCsv = (): void => {
    const header = '时间,类型,操作,对象,结果,上下文\n'
    const lines = rows.map(r => [opTime(r.ts), OP_CATEGORY_LABEL[r.category], r.action, r.target || '—', OP_STATUS_LABEL[r.status], r.detail || '—'].map(opCsvCell).join(','))
    opDownload(`操作日志_${opStamp()}.csv`, 'text/csv;charset=utf-8', '\ufeff' + header + lines.join('\n'))
  }
  const clearOpLog = async (): Promise<void> => {
    if (!window.confirm('确定清空全部操作日志？该操作不可恢复。')) return
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
        title={(
          <>
            <span className={css.hdIcon}>{'⚙'}</span>
            操作日志
            <span className={css.hdBadge}>
              <StateDot state={opTotal > 0 ? 'done' : 'warning'} />
              {opTotal} 条
            </span>
          </>
        )}
        desc="仅记录操作元数据（时间/类型/动作/对象/结果/上下文），永不保存会话内容；最多显示 500 条。"
        actions={(
          <>
            <Badge tone="green">成功 {summary.ok}</Badge>
            <Badge tone="red">失败 {summary.fail}</Badge>
            <Badge tone="amber">跳过 {summary.skip}</Badge>
          </>
        )}
      />

      <div className={css.statRow}>
        <div className={`${css.statCard} ${css.statOk}`}>
          <span className={css.statValue}>{summary.ok}</span>
          <span className={clsx(kitCss.textMeta, css.statLabel)}>成功</span>
          <span className={css.statHint}>正常完成的日志</span>
        </div>
        <div className={`${css.statCard} ${css.statFail}`}>
          <span className={css.statValue}>{summary.fail}</span>
          <span className={clsx(kitCss.textMeta, css.statLabel)}>失败</span>
          <span className={css.statHint}>需要关注的异常</span>
        </div>
        <div className={`${css.statCard} ${css.statSkip}`}>
          <span className={css.statValue}>{summary.skip}</span>
          <span className={clsx(kitCss.textMeta, css.statLabel)}>跳过</span>
          <span className={css.statHint}>自动跳过或无意义</span>
        </div>
        <div className={css.statCard}>
          <span className={css.statValue}>{opTotal}</span>
          <span className={clsx(kitCss.textMeta, css.statLabel)}>总记录</span>
          <span className={css.statHint}>最多保留 500 条</span>
        </div>
      </div>

      <Card className={css.filterCard}>
        {/* 整条筛选栏排成一行：日期区间 / 分类 / 状态 / 搜索 / 动作按钮。
            搜索框（kit 的 .searchBox）原本 flex-basis 320px 且 min-width 220px，不参与收缩，
            于是它后面的按钮一定被挤到第二行 —— 这里给它挂 .searchFlex 改成「吃掉剩余空间」。
            窗口窄到装不下时仍会按 flex-wrap 折行（不硬挤坏控件）。 */}
        <div className={css.filterRow}>
          <div className={css.range}>
            <input className={css.dateInput} type="date" value={opFrom} onChange={(e) => { setOpFrom(e.target.value) }} aria-label="起始日期" />
            <span className={kitCss.textMeta}>至</span>
            <input className={css.dateInput} type="date" value={opTo} onChange={(e) => { setOpTo(e.target.value) }} aria-label="结束日期" />
          </div>
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
          <SearchInput className={css.searchFlex} value={opSearch} onChange={(v) => { setOpSearch(v) }} placeholder="搜索操作/对象/上下文" ariaLabel="搜索操作日志" />
          <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} icon={opLoading ? <span className={css.spin} /> : undefined} onClick={refresh} disabled={opLoading}>{opLoading ? '加载中…' : '刷新'}</Button>
          <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} onClick={exportOpTxt} disabled={rows.length === 0}>导出 TXT</Button>
          <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} onClick={exportOpCsv} disabled={rows.length === 0}>导出 CSV</Button>
          <Button size="sm" variant="outline" className={clsx(css.btnFx, css.btnFixedSm)} onClick={() => { void clearOpLog() }} disabled={opLoading || opTotal === 0}>清空</Button>
        </div>
      </Card>

      {opMsg && <div className={clsx(css.notice, opMsg.kind === 'ok' ? css.noticeOk : css.noticeErr)}>{opMsg.text}</div>}

      <Card className={css.tableCard} flush>
        <DataTable
          columns={opCols}
          rows={rows}
          getRowId={r => String(r.id)}
          loading={opLoading && rows.length === 0}
          emptyTitle={opLoading ? '加载中…' : '暂无操作日志，点击「刷新」后分页显示'}
        />
        {!searching && pager.hasMore && <ListSentinel refFn={loadMoreRef} />}
      </Card>
    </section>
  )
}
