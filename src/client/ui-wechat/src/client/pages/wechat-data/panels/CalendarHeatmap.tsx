/**
 * ECharts `calendar` heatmap for the Overview message-heat pod. Renders the
 * 90-day per-day message counts as a calendar heatmap, using the same
 * space-capsule palette as the geography maps. The chart owns its canvas and
 * disposes it on unmount; it also responds to container reflow via ResizeObserver.
 */
import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { HeatmapChart } from 'echarts/charts'
import { CalendarComponent, TooltipComponent, VisualMapComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { tokenColor } from '../utils/theme-color.ts'
import { useThemeMode } from '../theme.ts'
import css from './overview.module.css'

echarts.use([HeatmapChart, CalendarComponent, TooltipComponent, VisualMapComponent, CanvasRenderer])

/** One day of the 90-day message heat series. */
export interface HeatmapDatum {
  /** ISO date string, e.g. `2025-06-01`. */
  d: string
  /** Messages sent/received that day. */
  count: number
}

interface CalendarHeatmapProps {
  /** Ascending 90-day per-day message counts; empty renders nothing. */
  data: HeatmapDatum[]
}

/**
 * Render the calendar heatmap.
 * @param props - heat data.
 * @returns the chart container element.
 */
export function CalendarHeatmap({ data }: CalendarHeatmapProps): React.JSX.Element {
  const elRef = useRef<HTMLDivElement | null>(null)
  // 图表配色取自主题令牌，切换主题后必须重建 option 才会换色。
  const themeMode = useThemeMode()

  useEffect(() => {
    const el = elRef.current
    if (!el || data.length === 0) return
    const first = data[0]
    const last = data[data.length - 1]
    if (!first || !last) return
    const start = first.d
    const end = last.d
    const max = Math.max(1, ...data.map(h => h.count))
    const chart = echarts.init(el)
    chart.setOption({
      tooltip: {
        trigger: 'item',
        formatter: (params: { value: [string, number] }) => `${params.value[0]}<br/>${params.value[1]} 条消息`,
        backgroundColor: tokenColor('--dsw-alias-tooltip-bg'),
        borderColor: tokenColor('--nm-cyan', 0.4),
        textStyle: { color: tokenColor('--nm-text-1') },
      },
      visualMap: {
        min: 0,
        max,
        type: 'piecewise',
        orient: 'horizontal',
        left: 'center',
        top: 0,
        itemWidth: 14,
        itemHeight: 12,
        textStyle: { color: tokenColor('--nm-text-3') },
        // ECharts 画在 canvas 上，颜色必须由 JS 给出具体值（不能写 var()）。
        inRange: { color: [tokenColor('--nm-cyan', 0.12), tokenColor('--nm-cyan', 0.55), tokenColor('--nm-purple', 0.95)] },
      },
      calendar: {
        top: 80,
        left: 18,
        right: 18,
        bottom: 6,
        cellSize: ['auto', 13],
        range: [start, end],
        splitLine: { show: false },
        itemStyle: { borderWidth: 0.5, borderColor: tokenColor('--nm-cyan', 0.18) },
        yearLabel: { show: false },
        dayLabel: { color: tokenColor('--nm-text-3'), fontSize: 10, nameMap: 'zh' },
        monthLabel: { color: tokenColor('--nm-purple', 0.85), fontSize: 11 },
      },
      series: [{
        type: 'heatmap',
        coordinateSystem: 'calendar',
        data: data.map(h => [h.d, h.count]),
        emphasis: { itemStyle: { shadowBlur: 8, shadowColor: tokenColor('--nm-cyan', 0.6) } },
      }],
    } as unknown as echarts.EChartsCoreOption)
    const ro = new ResizeObserver(() => { chart.resize() })
    ro.observe(el)
    return () => {
      ro.disconnect()
      chart.dispose()
    }
  }, [data, themeMode])

  return <div ref={elRef} className={css.calendarHeatmap} />
}
