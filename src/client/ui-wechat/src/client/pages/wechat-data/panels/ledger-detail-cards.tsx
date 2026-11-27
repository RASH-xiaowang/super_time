/**
 * 联系人排行、红包手气、异常提醒。和图表放在同一块画布里，可以一起拖。
 */
import type { LedgerSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { DataTable } from '../ui/kit.tsx'
import type { DataColumn } from '../ui/kit.tsx'
import { ListSentinel } from './hooks.tsx'
import { CanvasCard } from './card-canvas-card.tsx'
import { IdentityName } from './identity.tsx'
import { withEnterprise } from './enterprise-identity.ts'
import kitCss from '../ui/kit.module.css'
import css from './ledger.module.css'

const WARNING_RENDER_LIMIT = 24

type ContactRow = LedgerSnapshot['byContact'][number]

function fmtMoney(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtKnownMoney(n: number, unknownCount: number): string {
  if (n === 0 && unknownCount > 0) return `金额未知（${unknownCount} 笔未计入）`
  const known = `¥ ${fmtMoney(n)}`
  return unknownCount > 0 ? `${known}（另 ${unknownCount} 笔金额未知）` : known
}

export function LedgerDetailCards({
  data,
  columns,
  visibleCount,
  sentinelRef,
}: {
  data: LedgerSnapshot
  columns: ReadonlyArray<DataColumn<ContactRow>>
  visibleCount: number
  sentinelRef: (el: HTMLDivElement | null) => void
}): React.JSX.Element {
  const unknown = data.redpacket.amountUnknownCount ?? 0
  return (
    <>
      <CanvasCard id="ledger-rank" title="联系人资金排行" extra={`Top ${data.byContact.length}`} cols={2}>
        {data.byContact.length === 0 ? (
          <div className={kitCss.emptyInline}>暂无转账/红包资金往来</div>
        ) : (
          <div className={css.rankScroll}>
            <DataTable
              columns={columns}
              rows={data.byContact.slice(0, visibleCount)}
              getRowId={(r, i) => `${r.username}:${r.direction}:${i}`}
              scroll={false}
              minWidth={0}
            />
            {data.byContact.length > visibleCount && <ListSentinel refFn={sentinelRef} />}
          </div>
        )}
      </CanvasCard>
      <CanvasCard id="ledger-redpacket" title="红包手气" extra={`转账 ${data.summary.transfers} 笔`}>
        <div className={css.rpGrid}>
          <div className={css.rpItem}><span>有领取证据</span><b>{data.redpacket.receivedCount} 个</b></div>
          <div className={css.rpItem}><span>已知领取金额</span><b>{fmtKnownMoney(data.redpacket.receivedAmount, unknown)}</b></div>
          <div className={css.rpItem}><span>最佳手气</span><b>{unknown && data.redpacket.bestAmount === 0 ? '金额未知' : `¥ ${fmtMoney(data.redpacket.bestAmount)}`}</b></div>
          <div className={css.rpItem}><span>平均每个</span><b>{unknown && data.redpacket.avgAmount === 0 ? '金额未知' : `¥ ${fmtMoney(data.redpacket.avgAmount)}`}</b></div>
          <div className={css.rpItem}><span>状态待核实</span><b>{data.redpacket.statusUnknownCount ?? 0} 个</b></div>
          <div className={css.rpItem}><span>发出</span><b>{data.redpacket.sentCount} 个</b></div>
          <div className={css.rpItem}><span>已知发出金额</span><b>{fmtKnownMoney(data.redpacket.sentAmount, unknown)}</b></div>
        </div>
      </CanvasCard>
      <CanvasCard id="ledger-warnings" title="异常提醒" extra={String(data.warnings.length)}>
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
      </CanvasCard>
    </>
  )
}
