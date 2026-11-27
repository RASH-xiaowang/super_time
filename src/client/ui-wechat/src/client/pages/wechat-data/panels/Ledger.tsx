/**
 * 资金往来（月度汇总）— 转账/红包按月汇总：收入/支出/净额、联系人排行、
 * 红包手气、异常清单，支持 CSV 导出。金额来自本机消息解析，全部本地计算。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ListSkeleton, useElapsedSeconds, useProgressiveList, useTransientNotice, useWechatDataUpdated } from './hooks.tsx'
import { apiGetLedger, readRenderCache, writeRenderCache } from '../api.ts'
import type { LedgerSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { CellPrimary, LinkButton, Mono, MonthField, PanelHeader } from '../ui/kit.tsx'
import type { DataColumn } from '../ui/kit.tsx'
import { CACHE_LEDGER } from './overview-cache-keys.ts'
import { AssetKpiBar, AssetMoreMenu } from './files-cell.tsx'
import kitCss from '../ui/kit.module.css'
import css from './ledger.module.css'
import { LedgerChartBoard } from './ledger-charts.tsx'
import { LedgerDetailCards } from './ledger-detail-cards.tsx'
import { withEnterprise } from './enterprise-identity.ts'
import { IdentityName } from './identity.tsx'
import { useKeepAliveActive } from './keep-alive.tsx'
import { ExportProgressStatus } from './ExportProgressStatus.tsx'
import { useExportTask } from './export-task.ts'

const DIR_LABEL: Record<'in' | 'out' | 'unknown', string> = {
  in: '收到',
  out: '发出',
  unknown: '未知',
}

/**
 * 总览已经把「全部月份」的账本快照算过一次并缓存在 localStorage 里
 * （`CACHE_LEDGER`，字段与本页完全同构）。
 * 用户从总览点进来时直接拿它先渲染 —— 不必再等一次全量统计。
 * 读缓存一律容错：结构不对/损坏就当没有。
 */
function readOverviewLedger(): LedgerSnapshot | null {
  try {
    const raw = localStorage.getItem(CACHE_LEDGER)
    if (!raw) return null
    const v = JSON.parse(raw) as Partial<LedgerSnapshot> | null
    if (!v || typeof v !== 'object') return null
    if (!v.summary || !Array.isArray(v.byContact) || !v.redpacket || !Array.isArray(v.warnings)) return null
    return v as LedgerSnapshot
  } catch {
    return null
  }
}

function fmtMoney(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Render the funds ledger panel.
 * @param props - optional chat navigation callback.
 * @returns the ledger element tree.
 */
export function LedgerPanel({ onOpenChat, onOpenRecords }: { onOpenChat?: (username: string) => void; onOpenRecords?: () => void } = {}): React.JSX.Element {
  const [month, setMonth] = useState('')
  const [data, setData] = useState<LedgerSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const requestSeqRef = useRef(0)
  const active = useKeepAliveActive()
  // 首次统计的走秒（`loading && !data` 才计时：有缓存的后台静默刷新不该白闪）。
  // 2026-09-26 抽成 hooks.tsx 的 useElapsedSeconds，媒体资产/存储/群聊分析共用同一套。
  const elapsed = useElapsedSeconds(loading && data === null)
  // 提示语自动消失（L20）：原手写的 `window.setTimeout(…, 3000)` 已由 hook 统一管理。
  const { notice, flash } = useTransientNotice()
  const exportTask = useExportTask()

  const load = useCallback(async (m: string): Promise<void> => {
    const requestSeq = ++requestSeqRef.current
    setLoading(true)
    setError(null)
    const key = 'ledger:v2:' + (m || 'all')
    // 本页自己的渲染缓存 → 总览算过的同构快照（只在"全部"口径下同构）
    const cached = readRenderCache<LedgerSnapshot>(key) ?? (m === '' ? readOverviewLedger() : null)
    if (cached) setData(cached)
    try {
      const r = await apiGetLedger(m ? { month: m } : undefined)
      if (requestSeq !== requestSeqRef.current) return
      setData(r)
      if (!r.readError) writeRenderCache(key, r)
    } catch (e) {
      if (requestSeq === requestSeqRef.current && !cached) setError((e as Error).message)
    } finally {
      if (requestSeq === requestSeqRef.current) setLoading(false)
    }
  }, [])

  useWechatDataUpdated(() => { if (active) void load(month) })

  useEffect(() => {
    if (active) void load(month)
  }, [active, month, load])

  useEffect(() => () => { requestSeqRef.current += 1 }, [])

  const exportCsv = useCallback(async (): Promise<void> => {
    if (!data || exportTask.running) return
    const cell = (value: string): string => `"${value.replace(/"/g, '""')}"`
    const lines = ['联系人,企业名称,方向,笔数,金额']
    for (const r of data.byContact) {
      lines.push([
        cell(r.name),
        cell(r.enterpriseName ?? ''),
        cell(DIR_LABEL[r.direction]),
        String(r.count),
        r.amount.toFixed(2),
      ].join(','))
    }
    const outcome = await exportTask.run(async () => {
      const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `微信资金往来_${data.month || '全部'}.csv`
      a.click()
      URL.revokeObjectURL(a.href)
      return data.byContact.length
    }, {
      idPrefix: 'ledger-csv',
      label: '导出资金往来 CSV',
      progress: { phase: 'local', done: 0, total: 0 },
      cancelable: false,
      successMessage: (count) => `已导出 ${count} 位联系人的资金往来 CSV`,
    })
    if (outcome.ok) flash(outcome.message)
    else if (!outcome.canceled) flash('导出失败: ' + outcome.error)
  }, [data, exportTask, flash])

  const net = data ? data.summary.totalAmountIn - data.summary.totalAmountOut : 0
  const { count: contactCount, sentinelRef } = useProgressiveList(data?.byContact.length ?? 0, 80)

  /** 联系人资金排行列（本页排序）。 */
  const contactCols: ReadonlyArray<DataColumn<NonNullable<LedgerSnapshot['byContact']>[number]>> = [
    {
      id: 'name',
      header: '联系人',
      cell: r => (r.username
        ? <LinkButton className={css.contactLink} onClick={() => { onOpenChat?.(r.username) }} title={r.username}>
            <IdentityName name={r.name} username={r.username} size={22}>{withEnterprise(r.name, r.enterpriseName)}</IdentityName>
          </LinkButton>
        : <CellPrimary>{withEnterprise(r.name, r.enterpriseName)}</CellPrimary>),
      sortValue: r => r.name,
    },
    {
      id: 'direction',
      header: '方向',
      cell: r => <span className={css.dirBadge} data-kind={r.direction}>{DIR_LABEL[r.direction]}</span>,
      sortValue: r => DIR_LABEL[r.direction],
    },
    {
      id: 'count',
      header: '笔数',
      cell: r => r.count,
      sortValue: r => r.count,
      align: 'right',
    },
    {
      id: 'amount',
      header: '金额',
      cell: r => <Mono>¥ {fmtMoney(r.amount)}</Mono>,
      sortValue: r => r.amount,
      align: 'right',
    },
  ]

  return (
    <div className={css.root}>
      {/* 页头紧凑化：选择器见 ledger.module.css 的 `.root > div:first-child`，
          不额外包一层（作用域内收 h2/p 外边距）。 */}
      <PanelHeader
        title="资金往来"
        actions={(
          <>
            <button type="button" className={css.detailOpen} onClick={() => { onOpenRecords?.() }}>逐笔明细</button>
            <MonthField
              value={month}
              onChange={setMonth}
              ariaLabel="账本月份"
            />
            <AssetMoreMenu items={[
              { key: 'all', label: '全部月份', onSelect: () => { setMonth('') }, disabled: month === '' },
              { key: 'export', label: exportTask.running ? '导出中…' : '导出 CSV', onSelect: () => { void exportCsv() }, disabled: exportTask.running },
            ]} />
          </>
        )}
      />

      <ExportProgressStatus state={exportTask.state} />
      {notice && <div className={css.notice}>{notice}</div>}
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {data?.readError && <div className={kitCss.error} role="alert">数据读取不完整：{data.readError}</div>}
      {/* 首次统计：给出阶段、已用时间和"为什么可能偏慢"。 */}
      {loading && !data && (
        <div className={css.loadingWrap}>
          <div className={css.loadingBar}>
            <span className={css.loadingText}>正在统计资金账本…已用 {elapsed}s</span>
            <span className={css.loadingHint}>
              首次统计会核对 general.db 资金表及其对应消息卡；若刚打开总览，后台可能仍在统计，请稍候。
            </span>
          </div>
          <ListSkeleton rows={6} grid minCol={180} />
          <ListSkeleton rows={4} />
        </div>
      )}

      {data && (
        <>
          {/* 收入 / 支出 / 净额：语义色只染小面积数值。 */}
          <AssetKpiBar items={[
            { label: '已知总收入', value: `¥ ${fmtMoney(data.summary.totalAmountIn)}`, tone: 'success' },
            { label: '已知总支出', value: `¥ ${fmtMoney(data.summary.totalAmountOut)}`, tone: 'danger' },
            { label: '已知净额', value: `¥ ${fmtMoney(net)}`, tone: net >= 0 ? 'success' : 'danger' },
          ]} />
          {(data.summary.amountUnknownCount ?? 0) > 0 && (
            <div className={kitCss.emptyInline}>
              另有 {data.summary.amountUnknownCount} 笔资金记录已核实存在，但本地卡片没有可解析的人民币金额，未计入以上合计。
            </div>
          )}
          <LedgerChartBoard data={data}>
            <LedgerDetailCards
              data={data}
              columns={contactCols}
              visibleCount={contactCount}
              sentinelRef={sentinelRef}
            />
          </LedgerChartBoard>
        </>
      )}
    </div>
  )
}
