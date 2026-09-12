/**
 * 资金账本面板 — 转账/红包按月汇总：收入/支出/净额、联系人排行、红包手气、
 * 异常清单，支持 CSV 导出。金额来自本机消息解析，全部本地计算。
 */
import { useCallback, useEffect, useState } from 'react'
import { ListSentinel, useProgressiveList } from './hooks.tsx'
import { apiGetLedger, readRenderCache, writeRenderCache } from '../api.ts'
import type { LedgerSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Button, Card, CellPrimary, DataTable, Mono, PanelHeader, StatCard, StatGrid } from '../ui/kit.tsx'
import type { DataColumn } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './ledger.module.css'

const DIR_LABEL: Record<'in' | 'out' | 'unknown', string> = {
  in: '收到',
  out: '发出',
  unknown: '未知',
}

function fmtMoney(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/**
 * Render the funds ledger panel.
 * @param props - optional chat navigation callback.
 * @returns the ledger element tree.
 */
export function LedgerPanel({ onOpenChat }: { onOpenChat?: (username: string) => void } = {}): React.JSX.Element {
  const [month, setMonth] = useState('')
  const [data, setData] = useState<LedgerSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async (m: string): Promise<void> => {
    setLoading(true)
    setError(null)
    const key = 'ledger:' + (m || 'all')
    const cached = readRenderCache<LedgerSnapshot>(key)
    if (cached) setData(cached)
    try {
      const r = await apiGetLedger(m ? { month: m } : undefined)
      setData(r)
      writeRenderCache(key, r)
    } catch (e) {
      if (!cached) setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load(month) }, [month, load])

  const exportCsv = useCallback((): void => {
    if (!data) return
    const lines = ['联系人,方向,笔数,金额']
    for (const r of data.byContact) {
      lines.push(`${r.name},${DIR_LABEL[r.direction]},${r.count},${r.amount.toFixed(2)}`)
    }
    const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `微信资金账本_${data.month || '全部'}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
    setNotice('已导出 CSV')
    window.setTimeout(() => { setNotice(null) }, 3000)
  }, [data])

  const net = data ? data.summary.totalAmountIn - data.summary.totalAmountOut : 0
  const { count: contactCount, sentinelRef } = useProgressiveList(data?.byContact.length ?? 0, 80)

  /** 联系人资金排行列（本页排序）。 */
  const contactCols: ReadonlyArray<DataColumn<NonNullable<LedgerSnapshot['byContact']>[number]>> = [
    {
      id: 'name',
      header: '联系人',
      cell: r => (r.username
        ? <button type="button" className={css.link} onClick={() => { onOpenChat?.(r.username) }} title={r.username}>{r.name}</button>
        : <CellPrimary>{r.name}</CellPrimary>),
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
    <div className={kitCss.panelShell}>
      <PanelHeader
        title="资金账本"
        desc="转账/红包按月汇总 · 金额来自本机消息解析 · 仅本地计算"
        actions={(
          <>
            <input
              type="month"
              className={css.input}
              value={month}
              onChange={(e) => { setMonth(e.target.value) }}
              aria-label="账本月份"
            />
            <Button variant="pill" onClick={() => { setMonth('') }} data-active={month === '' || undefined}>全部</Button>
            <Button variant="pill" onClick={exportCsv} disabled={!data}>导出 CSV</Button>
          </>
        )}
      />

      {notice && <div className={css.notice}>{notice}</div>}
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {loading && !data && <div className={kitCss.emptyInline}>正在统计资金账本…</div>}

      {data && (
        <>
          <StatGrid>
            <StatCard icon="💰" value={`¥ ${fmtMoney(data.summary.totalAmountIn)}`} label="总收入" tone="green" />
            <StatCard icon="💸" value={`¥ ${fmtMoney(data.summary.totalAmountOut)}`} label="总支出" tone="red" />
            <StatCard icon="🧮" value={`¥ ${fmtMoney(net)}`} label="净额" tone={net >= 0 ? 'green' : 'red'} />
            <StatCard icon="🔁" value={`${data.summary.transfers} 笔`} label="转账" />
            <StatCard icon="🧧" value={`${data.summary.redpacketsReceived} 个 · ¥ ${fmtMoney(data.summary.redpacketAmountReceived)}`} label="红包收到" tone="purple" />
            <StatCard icon="📤" value={`${data.summary.redpacketsSent} 个 · ¥ ${fmtMoney(data.summary.redpacketAmountSent)}`} label="红包发出" tone="blue" />
          </StatGrid>

          <div className={kitCss.cardGrid}>
            <Card title={`联系人资金排行 Top ${data.byContact.length}`} flush>
              {data.byContact.length === 0 ? (
                <div className={kitCss.emptyInline}>暂无转账/红包资金往来</div>
              ) : (
                <>
                  <DataTable
                    columns={contactCols}
                    rows={data.byContact.slice(0, contactCount)}
                    getRowId={(r, i) => `${r.username}:${r.direction}:${i}`}
                  />
                  {data.byContact.length > contactCount && <ListSentinel refFn={sentinelRef} />}
                </>
              )}
            </Card>

            <Card title="红包手气">
              <div className={css.rpStats}>
                <div className={css.rpRow}><span>收到</span><b>{data.redpacket.receivedCount} 个</b></div>
                <div className={css.rpRow}><span>收到金额</span><b>¥ {fmtMoney(data.redpacket.receivedAmount)}</b></div>
                <div className={css.rpRow}><span>最佳手气</span><b>¥ {fmtMoney(data.redpacket.bestAmount)}</b></div>
                <div className={css.rpRow}><span>平均每个</span><b>¥ {fmtMoney(data.redpacket.avgAmount)}</b></div>
                <div className={css.rpRow}><span>发出</span><b>{data.redpacket.sentCount} 个</b></div>
                <div className={css.rpRow}><span>发出金额</span><b>¥ {fmtMoney(data.redpacket.sentAmount)}</b></div>
              </div>
            </Card>
          </div>

          <Card title="异常提醒">
            {data.warnings.length === 0 ? (
              <div className={kitCss.emptyInline}>暂无异常（转账超时/红包退回）</div>
            ) : (
              <div className={css.warnList}>
                {data.warnings.map((w, i) => (
                  <div key={`${w.kind}:${i}`} className={css.warn}>
                    <span className={css.warnIcon}>⚠️</span>
                    <div className={css.warnBody}>
                      <div className={css.warnTitle}>{w.label} · {w.name || w.username || '—'}</div>
                      <div className={css.warnMeta}>¥ {fmtMoney(w.amount ?? 0)}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  )
}
