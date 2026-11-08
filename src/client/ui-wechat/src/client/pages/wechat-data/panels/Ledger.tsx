/**
 * 资金往来（月度汇总）— 转账/红包按月汇总：收入/支出/净额、联系人排行、
 * 红包手气、异常清单，支持 CSV 导出。金额来自本机消息解析，全部本地计算。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ListSentinel, ListSkeleton, useElapsedSeconds, useProgressiveList, useTransientNotice, useWechatDataUpdated } from './hooks.tsx'
import { apiGetLedger, readRenderCache, writeRenderCache } from '../api.ts'
import type { LedgerSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { CellPrimary, DataTable, LinkButton, Mono, MonthField, PanelHeader } from '../ui/kit.tsx'
import type { DataColumn } from '../ui/kit.tsx'
import { CACHE_LEDGER } from './overview-cache-keys.ts'
import { AssetKpiBar, AssetMoreMenu } from './files-cell.tsx'
import kitCss from '../ui/kit.module.css'
import css from './ledger.module.css'
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

/** Keep a malformed snapshot from turning the warning rail into an unbounded DOM tree. */
const WARNING_RENDER_LIMIT = 24

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

function fmtKnownMoney(n: number, unknownCount: number): string {
  if (n === 0 && unknownCount > 0) return `金额未知（${unknownCount} 笔未计入）`
  const known = `¥ ${fmtMoney(n)}`
  return unknownCount > 0 ? `${known}（另 ${unknownCount} 笔金额未知）` : known
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

  /*
   * 2026-10-18 布局重设计（用户：「固定的内容不要占用太多空间」）。
   * 2026-10-19 微信化：汇总数字从「6 项」收成「收入 / 支出 / 净额」3 项内联 KPI 条；
   * 转账笔数移到「红包手气」卡头；页头动作只留月份选择 + 更多（全部月份 / 导出 CSV）。
   */
  return (
    <div className={css.root}>
      {/* 页头紧凑化：选择器见 ledger.module.css 的 `.root > div:first-child`，
          不额外包一层（作用域内收 h2/p 外边距）。 */}
      <PanelHeader
        title="资金往来"
        desc="基于微信 general.db 资金表 · 金额按真实卡片解析 · 状态仅在本地证据充分时展示"
        actions={(
          <>
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

          <div className={css.body}>
            <section className={css.rankCard}>
              <div className={css.cardHd}>
                <span>联系人资金排行</span>
                <span className={css.cardMeta}>Top {data.byContact.length}</span>
              </div>
              {data.byContact.length === 0 ? (
                <div className={kitCss.emptyInline}>暂无转账/红包资金往来</div>
              ) : (
                <div className={css.rankScroll}>
                  <DataTable
                    columns={contactCols}
                    rows={data.byContact.slice(0, contactCount)}
                    getRowId={(r, i) => `${r.username}:${r.direction}:${i}`}
                    /* 单一滚动容器：本卡片自己滚，表格不再套 62vh 的第二层滚动条。 */
                    scroll={false}
                    minWidth={520}
                  />
                  {data.byContact.length > contactCount && <ListSentinel refFn={sentinelRef} />}
                </div>
              )}
            </section>

            <div className={css.rail}>
              <section className={css.miniCard}>
                <div className={css.cardHd}>
                  <span>红包手气</span>
                  <span className={css.cardMeta}>转账 {data.summary.transfers} 笔</span>
                </div>
                <div className={css.rpGrid}>
                  <div className={css.rpItem}><span>有领取证据</span><b>{data.redpacket.receivedCount} 个</b></div>
                  <div className={css.rpItem}><span>已知领取金额</span><b>{fmtKnownMoney(data.redpacket.receivedAmount, data.redpacket.amountUnknownCount ?? 0)}</b></div>
                  <div className={css.rpItem}><span>最佳手气</span><b>{data.redpacket.amountUnknownCount && data.redpacket.bestAmount === 0 ? '金额未知' : `¥ ${fmtMoney(data.redpacket.bestAmount)}`}</b></div>
                  <div className={css.rpItem}><span>平均每个</span><b>{data.redpacket.amountUnknownCount && data.redpacket.avgAmount === 0 ? '金额未知' : `¥ ${fmtMoney(data.redpacket.avgAmount)}`}</b></div>
                  <div className={css.rpItem}><span>状态待核实</span><b>{data.redpacket.statusUnknownCount ?? 0} 个</b></div>
                  <div className={css.rpItem}><span>发出</span><b>{data.redpacket.sentCount} 个</b></div>
                  <div className={css.rpItem}><span>已知发出金额</span><b>{fmtKnownMoney(data.redpacket.sentAmount, data.redpacket.amountUnknownCount ?? 0)}</b></div>
                </div>
              </section>

              <section className={`${css.miniCard} ${css.warnCard}`}>
                <div className={css.cardHd}>
                  <span>异常提醒</span>
                  <span className={css.cardMeta}>{data.warnings.length}</span>
                </div>
                {data.warnings.length === 0 ? (
                  <div className={kitCss.emptyInline}>暂无本地证据明确的红包退回异常</div>
                ) : (
                  <div className={css.warnList}>
                    {data.warnings.slice(0, WARNING_RENDER_LIMIT).map((w, i) => (
                      <div key={`${w.kind}:${i}`} className={css.warn}>
                        <span className={css.warnDot} aria-hidden="true" />
                        <div className={css.warnBody}>
                          <div className={css.warnTitle}>
                            <IdentityName name={w.name || w.username || '—'} username={w.username || ''} size={18}>
                              {w.label} · {withEnterprise(w.name || w.username || '—', w.enterpriseName)}
                            </IdentityName>
                          </div>
                          <div className={css.warnMeta}>{w.amount === undefined ? '金额未知' : `¥ ${fmtMoney(w.amount)}`}</div>
                        </div>
                      </div>
                    ))}
                    {data.warnings.length > WARNING_RENDER_LIMIT && (
                      <div className={kitCss.emptyInline}>
                        还有 {data.warnings.length - WARNING_RENDER_LIMIT} 条异常未展开，避免一次性渲染过大。
                      </div>
                    )}
                  </div>
                )}
              </section>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
