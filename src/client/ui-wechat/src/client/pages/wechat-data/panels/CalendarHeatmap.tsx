/**
 * ECharts `calendar` heatmap for the Overview message-heat pod. Renders the
 * 90-day per-day message counts as a calendar heatmap.
 *
 * 微信化（2026-10-19）：色阶收敛为主色（微信绿）单色阶 + 中性灰；
 * 不再用「青→紫」双色渐变，也不给 hover 加发光阴影。
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
        borderColor: tokenColor('--nm-border-hover'),
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
        // 5 段图例在窄容器里会折成两行（实测 425px 宽时），`itemGap` 收小 + 字号收一档
        // 让它尽量一行放下；放不下时下面的 `calendar.top` 已经留了两行的位。
        itemGap: 8,
        textStyle: { color: tokenColor('--nm-text-3'), fontSize: 10 },
        // ECharts 画在 canvas 上，颜色必须由 JS 给出具体值（不能写 var()）。
        // 单色阶：主色透明度递增（0.12 → 0.55 → 0.95），不再混紫色。
        inRange: { color: [tokenColor('--nm-cyan', 0.12), tokenColor('--nm-cyan', 0.55), tokenColor('--nm-cyan', 0.95)] },
      },
      /*
       * 日历铺满容器（2026-10-16 重设计）。
       *
       * 原先 `top: 80` + 格子高度写死 13px：visualMap 占掉顶部 80px（其实一行
       * 14px 的色块 + 文字只要 ~40px），格子高度写死 ⇒ 90 天 = 13 周 × 13px = 169px，
       * 而容器只有 150px ⇒ 纵向被压、横向只用了 260/271px。用户报「留有太多空白」。
       *
       * 现在：`top: 56`（visualMap 最多两行 ≈ 48px + 8px 间隙 —— 5 段图例在窄容器里
       * 会折行，40px 会让第二行压到日历上，实测踩过），`cellSize: 'auto'` 让 ECharts
       * 按可用宽高**双向**算格子边长（取较小者，保证正方形），`left/right/bottom` 收到 8px
       * 把边距让给格子。容器变高时（`.calendarHeatmap` 是 `flex: 1 1 auto`）格子跟着变大。
       */
      calendar: {
        top: 56,
        left: 8,
        right: 8,
        bottom: 8,
        cellSize: 'auto',
        range: [start, end],
        splitLine: { show: false },
        itemStyle: { borderWidth: 0.5, borderColor: tokenColor('--nm-border-hover') },
        yearLabel: { show: false },
        dayLabel: { color: tokenColor('--nm-text-3'), fontSize: 10, nameMap: 'zh' },
        monthLabel: { color: tokenColor('--nm-text-2'), fontSize: 11 },
      },
      series: [{
        type: 'heatmap',
        coordinateSystem: 'calendar',
        data: data.map(h => [h.d, h.count]),
        emphasis: { itemStyle: { borderWidth: 1, borderColor: tokenColor('--nm-text-1') } },
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
