/**
 * 资金页的 ECharts 容器。窗口变了就 resize，避免画布停在旧尺寸上把字裁掉。
 */
import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import type { EChartsCoreOption } from 'echarts/core'
import {
  BarChart, FunnelChart, HeatmapChart, LineChart, ParallelChart, PieChart,
  RadarChart, SankeyChart, ScatterChart, SunburstChart, TreemapChart,
} from 'echarts/charts'
import {
  GridComponent, LegendComponent, ParallelComponent, RadarComponent, TooltipComponent, VisualMapComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import css from './ledger.module.css'

echarts.use([
  BarChart, LineChart, PieChart, ScatterChart, RadarChart, HeatmapChart,
  TreemapChart, SunburstChart, SankeyChart, FunnelChart, ParallelChart,
  GridComponent, LegendComponent, TooltipComponent, VisualMapComponent,
  RadarComponent, ParallelComponent, CanvasRenderer,
])

export function LedgerEChart({ option }: { option: EChartsCoreOption }): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const chart = echarts.init(el)
    chart.setOption(option, true)
    const watch = new ResizeObserver(() => { chart.resize() })
    watch.observe(el)
    return () => {
      watch.disconnect()
      chart.dispose()
    }
  }, [option])
  return <div ref={ref} className={css.chartCanvas} />
}
