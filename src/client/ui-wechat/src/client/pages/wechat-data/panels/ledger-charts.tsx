/**
 * 资金往来的图表区。统计地图没有地区字段，不画。
 * 线图是联系人金额的累计占比，不是月份趋势。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { LedgerContactRow, LedgerSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { clearTokenColorCache } from '../utils/theme-color.ts'
import { useThemeMode } from '../theme.ts'
import { layoutWordCloud, toCloudWords, type CloudTone } from './wordcloud-layout.ts'
import { CardCanvas } from './card-canvas.tsx'
import { CanvasCard } from './card-canvas-card.tsx'
import { ledgerChartSpecs } from './ledger-chart-options.ts'
import { LedgerEChart } from './ledger-echart.tsx'
import { contactLabel, yuan } from './ledger-chart-model.ts'
import css from './ledger.module.css'

export function LedgerChartBoard({ data, children }: { data: LedgerSnapshot; children?: React.ReactNode }): React.JSX.Element {
  const theme = useThemeMode()
  const cards = useMemo(() => {
    clearTokenColorCache()
    return ledgerChartSpecs(data)
  }, [data, theme])
  return (
    <div className={css.chartBoard}>
      <CardCanvas year={0} scope="ledger">
        {cards.map((card) => (
          <CanvasCard key={card.key} id={`ledger-${card.key}`} title={card.title} extra={card.meta} {...(card.cloud ? { cols: 2 } : {})}>
            {card.cloud
              ? <ContactCloud rows={data.byContact} />
              : card.option
                ? <LedgerEChart option={card.option} />
                : <div className={css.chartEmpty}>暂无已知金额</div>}
          </CanvasCard>
        ))}
        {children}
      </CardCanvas>
    </div>
  )
}

function ContactCloud({ rows }: { rows: readonly LedgerContactRow[] }): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const watch = new ResizeObserver(() => { setBox({ width: el.clientWidth, height: el.clientHeight }) })
    watch.observe(el)
    setBox({ width: el.clientWidth, height: el.clientHeight })
    return () => { watch.disconnect() }
  }, [])
  const hasMoney = rows.some((row) => row.amount > 0)
  const placed = useMemo(() => {
    if (box.width < 120 || box.height < 120) return []
    const picked = [...rows]
      .filter((row) => row.amount > 0)
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 24)
      .map((row) => ({ text: contactLabel(row), count: Math.max(1, Math.round(row.amount)), tone: row.direction === 'out' ? 'out' as const : 'in' as const }))
    const words = toCloudWords(picked.map((word) => ({ text: word.text, count: word.count })))
      .map((word) => ({ ...word, size: Math.max(10, Math.round(word.size * 0.62)) }))
    const toneByText = new Map(picked.map((word) => [word.text, word.tone]))
    const laid = layoutWordCloud(words.map((word) => ({ ...word, tone: 'mid' as CloudTone })), { width: box.width, height: box.height })
    return laid.placed.map((word) => ({ ...word, flow: toneByText.get(word.text) ?? 'in' }))
  }, [rows, box])
  return (
    <div ref={ref} className={css.cloudStage}>
      {!hasMoney
        ? <div className={css.chartEmpty}>暂无已知金额</div>
        : placed.map((word) => (
          <span
            key={word.text}
            className={css.cloudWord}
            data-flow={word.flow}
            data-vertical={word.vertical ? '' : undefined}
            title={`${word.text} ${yuan(word.count)}`}
            style={{ left: word.x, top: word.y, width: word.width, height: word.height, fontSize: word.size }}
          >{word.text}</span>
        ))}
    </div>
  )
}
