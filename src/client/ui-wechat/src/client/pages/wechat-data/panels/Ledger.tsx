/**
 * 资金账本面板 — 转账/红包按月汇总：收入/支出/净额、联系人排行、红包手气、
 * 异常清单，支持 CSV 导出。金额来自本机消息解析，全部本地计算。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ListSentinel, ListSkeleton, useProgressiveList, useTransientNotice } from './hooks.tsx'
import { apiGetLedger, readRenderCache, writeRenderCache } from '../api.ts'
import type { LedgerSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { Button, Card, CellPrimary, DataTable, Mono, MonthField, PanelHeader, StatCard, StatGrid } from '../ui/kit.tsx'
import type { DataColumn } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './ledger.module.css'

const DIR_LABEL: Record<'in' | 'out' | 'unknown', string> = {
  in: '收到',
  out: '发出',
  unknown: '未知',
}

/**
 * 总览已经把「全部月份」的账本快照算过一次并缓存在 localStorage 里
 * （`dsh-wechat-overview-ledger-v1`，字段与本页完全同构）。
 * 用户从总览点进来时直接拿它先渲染 —— 不必再等一次全量统计。
 * 读缓存一律容错：结构不对/损坏就当没有。
 */
function readOverviewLedger(): LedgerSnapshot | null {
  try {
    const raw = localStorage.getItem('dsh-wechat-overview-ledger-v1')
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
export function LedgerPanel({ onOpenChat }: { onOpenChat?: (username: string) => void } = {}): React.JSX.Element {
  const [month, setMonth] = useState('')
  const [data, setData] = useState<LedgerSnapshot | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 统计耗时（秒）：给"正在统计"一个可见的进度感。
  // 后端单次 getLedger 实测 400–550ms，但它是**同步 SQLite**，会排在其它重查询后面 ——
  // 刚打开总览时（getOverviewInsights 要扫 21 万条消息）本页可能要等十几秒，
  // 只写一句"正在统计资金账本…"用户无从判断是卡了还是在跑。
  const [elapsed, setElapsed] = useState(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // 提示语自动消失（L20）：原手写的 `window.setTimeout(…, 3000)` 已由 hook 统一管理。
  const { notice, flash } = useTransientNotice()

  const load = useCallback(async (m: string): Promise<void> => {
    setLoading(true)
    setError(null)
    const key = 'ledger:' + (m || 'all')
    // 本页自己的渲染缓存 → 总览算过的同构快照（只在"全部"口径下同构）
    const cached = readRenderCache<LedgerSnapshot>(key) ?? (m === '' ? readOverviewLedger() : null)
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

  // 统计计时：加载开始走秒，结束清零
  useEffect(() => {
    if (loading) {
      const t0 = Date.now()
      setElapsed(0)
      timerRef.current = setInterval(() => { setElapsed(Math.round((Date.now() - t0) / 1000)) }, 1000)
    } else if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null } }
  }, [loading])

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
    flash('已导出 CSV')
  }, [data, flash])

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
            <MonthField
              value={month}
              onChange={setMonth}
              ariaLabel="账本月份"
            />
            <Button variant="pill" onClick={() => { setMonth('') }} data-active={month === '' || undefined}>全部</Button>
            <Button variant="pill" onClick={exportCsv} disabled={!data}>导出 CSV</Button>
          </>
        )}
      />

      {notice && <div className={css.notice}>{notice}</div>}
      {error && <div className={kitCss.error} role="alert">{error}</div>}
      {/* 首次统计：给出阶段、已用时间和"为什么可能偏慢"，并用与真实布局同形的骨架占位
          （6 张指标卡 + 两张卡片的行）。此前这里只有一行字，实测在 802px 的内容区里留 608px 空白。 */}
      {loading && !data && (
        <div className={kitCss.panelShell}>
          <div className={css.loadingBar}>
            <span className={css.loadingSpin} aria-hidden="true" />
            <span className={css.loadingText}>正在统计资金账本…已用 {elapsed}s</span>
            <span className={css.loadingHint}>
              首次统计要解析本机全部消息里的转账/红包记录；若刚打开总览，后台可能仍在统计，请稍候。
            </span>
          </div>
          <ListSkeleton rows={6} grid minCol={180} />
          <ListSkeleton rows={4} />
        </div>
      )}

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
