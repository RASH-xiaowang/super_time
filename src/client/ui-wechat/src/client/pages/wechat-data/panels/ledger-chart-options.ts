/**
 * 把账本快照转成 ECharts 配置。颜色在调用时从主题令牌读取，不能写死。
 */
import type { EChartsCoreOption } from 'echarts/core'
import type { LedgerSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { tokenColor } from '../utils/theme-color.ts'
import {
  contactLabel, funnelSteps, moneyParts, pareto, pivotContacts, sankeyLinks, topContacts, yuan,
  type MoneyPart,
} from './ledger-chart-model.ts'

interface Palette {
  in: string
  out: string
  text: string
  muted: string
  border: string
  tipBg: string
}

export interface LedgerChartSpec {
  key: string
  title: string
  meta: string
  option: EChartsCoreOption | null
  /** 词云不走 ECharts，由面板自己画。 */
  cloud?: boolean
}

function palette(): Palette {
  return {
    in: tokenColor('--nm-success', 1, '#07c160'),
    out: tokenColor('--nm-danger', 1, '#fa5151'),
    text: tokenColor('--nm-text-1', 1, '#111111'),
    muted: tokenColor('--nm-text-2', 1, '#666666'),
    border: tokenColor('--nm-border', 1, '#333333'),
    tipBg: tokenColor('--dsw-alias-tooltip-bg', 1, '#1c1c1c'),
  }
}

/** tooltip 的公共样式。**显式对象类型**：ECharts 的 `tooltip` 字段还允许数组形态，
 * 直接 spread 一个 union 会编译不过（TS2698），所以这里只声明真正用到的三个键。 */
interface TipStyle {
  backgroundColor: string
  borderColor: string
  textStyle: { color: string; fontSize: number }
}

function tip(p: Palette): TipStyle {
  return { backgroundColor: p.tipBg, borderColor: p.border, textStyle: { color: p.text, fontSize: 12 } }
}

function axisLabel(p: Palette): { color: string; fontSize: number; width: number; overflow: 'truncate' } {
  return { color: p.muted, fontSize: 11, width: 72, overflow: 'truncate' }
}

function partColor(part: MoneyPart, p: Palette): string {
  return part.tone === 'out' ? p.out : p.in
}

function columnOption(data: LedgerSnapshot, p: Palette): EChartsCoreOption | null {
  const parts = moneyParts(data)
  if (parts.length === 0) return null
  return {
    tooltip: { ...tip(p), trigger: 'axis', valueFormatter: (v: unknown) => yuan(Number(v)) },
    grid: { left: 8, right: 12, top: 16, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: parts.map((part) => part.name), axisLabel: axisLabel(p), axisLine: { lineStyle: { color: p.border } } },
    yAxis: { type: 'value', axisLabel: { ...axisLabel(p), width: 56 }, splitLine: { lineStyle: { color: p.border } } },
    series: [{
      type: 'bar',
      data: parts.map((part) => ({ value: part.value, itemStyle: { color: partColor(part, p) } })),
      barMaxWidth: 36,
    }],
  }
}

function pieOption(data: LedgerSnapshot, p: Palette): EChartsCoreOption | null {
  const parts = moneyParts(data)
  if (parts.length === 0) return null
  return {
    tooltip: { ...tip(p), trigger: 'item', valueFormatter: (v: unknown) => yuan(Number(v)) },
    series: [{
      type: 'pie',
      radius: ['42%', '68%'],
      label: { color: p.muted, fontSize: 11, overflow: 'truncate', width: 72 },
      data: parts.map((part) => ({ name: part.name, value: part.value, itemStyle: { color: partColor(part, p) } })),
    }],
  }
}

function comboOption(data: LedgerSnapshot, p: Palette): EChartsCoreOption | null {
  const rows = topContacts(data.byContact).filter((row) => row.amount > 0 || row.count > 0)
  if (rows.length === 0) return null
  return {
    tooltip: { ...tip(p), trigger: 'axis' },
    legend: { data: ['金额', '笔数'], textStyle: { color: p.muted, fontSize: 11 }, top: 0 },
    grid: { left: 8, right: 12, top: 28, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: rows.map(contactLabel), axisLabel: axisLabel(p), axisLine: { lineStyle: { color: p.border } } },
    yAxis: [
      { type: 'value', name: '金额', axisLabel: { ...axisLabel(p), width: 48 }, splitLine: { lineStyle: { color: p.border } }, nameTextStyle: { color: p.muted, fontSize: 11 } },
      { type: 'value', name: '笔数', axisLabel: axisLabel(p), splitLine: { show: false }, nameTextStyle: { color: p.muted, fontSize: 11 } },
    ],
    series: [
      { name: '金额', type: 'bar', data: rows.map((row) => ({ value: row.amount, itemStyle: { color: row.direction === 'out' ? p.out : p.in } })), barMaxWidth: 22 },
      { name: '笔数', type: 'line', yAxisIndex: 1, data: rows.map((row) => row.count), itemStyle: { color: p.text }, lineStyle: { color: p.text } },
    ],
  }
}

function lineOption(data: LedgerSnapshot, p: Palette): EChartsCoreOption | null {
  const points = pareto(data.byContact)
  if (points.length === 0) return null
  return {
    tooltip: { ...tip(p), trigger: 'axis', valueFormatter: (v: unknown) => `${String(v)}%` },
    grid: { left: 8, right: 12, top: 16, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: points.map((point) => point.name), axisLabel: axisLabel(p), axisLine: { lineStyle: { color: p.border } } },
    yAxis: { type: 'value', max: 100, axisLabel: { ...axisLabel(p), width: 40, formatter: '{value}%' }, splitLine: { lineStyle: { color: p.border } } },
    series: [{ type: 'line', data: points.map((point) => point.share), smooth: true, itemStyle: { color: p.in }, areaStyle: { color: tokenColor('--nm-success', 0.16, 'rgba(7,193,96,0.16)') } }],
  }
}

function scatterOption(data: LedgerSnapshot, p: Palette): EChartsCoreOption | null {
  const rows = data.byContact.filter((row) => row.amount > 0 || row.count > 0)
  if (rows.length === 0) return null
  const series = (tone: 'in' | 'out', name: string, color: string) => ({
    name,
    type: 'scatter' as const,
    data: rows.filter((row) => (tone === 'out' ? row.direction === 'out' : row.direction !== 'out')).map((row) => ({
      name: contactLabel(row),
      value: [row.count, row.amount],
    })),
    itemStyle: { color },
  })
  return {
    tooltip: {
      ...tip(p),
      trigger: 'item',
      formatter: (raw: unknown) => {
        const item = raw as { name?: string; value?: number[] }
        const value = item.value ?? [0, 0]
        return `${item.name ?? ''}<br/>${String(value[0])} 笔<br/>${yuan(value[1] ?? 0)}`
      },
    },
    legend: { data: ['收到', '发出'], textStyle: { color: p.muted, fontSize: 11 }, top: 0 },
    grid: { left: 8, right: 12, top: 28, bottom: 8, containLabel: true },
    xAxis: { type: 'value', name: '笔数', axisLabel: axisLabel(p), splitLine: { lineStyle: { color: p.border } }, nameTextStyle: { color: p.muted, fontSize: 11 } },
    yAxis: { type: 'value', name: '金额', axisLabel: { ...axisLabel(p), width: 48 }, splitLine: { lineStyle: { color: p.border } }, nameTextStyle: { color: p.muted, fontSize: 11 } },
    series: [series('in', '收到', p.in), series('out', '发出', p.out)],
  }
}

function radarOption(data: LedgerSnapshot, p: Palette): EChartsCoreOption | null {
  const parts = moneyParts(data)
  if (parts.length === 0) return null
  const max = Math.max(...parts.map((part) => part.value), 1)
  return {
    tooltip: { ...tip(p), valueFormatter: (v: unknown) => yuan(Number(v)) },
    radar: {
      indicator: parts.map((part) => ({ name: part.name, max })),
      axisName: { color: p.muted, fontSize: 11 },
      splitLine: { lineStyle: { color: p.border } },
      splitArea: { show: false },
      axisLine: { lineStyle: { color: p.border } },
    },
    series: [{ type: 'radar', data: [{ value: parts.map((part) => part.value), name: '已知金额', areaStyle: { color: tokenColor('--nm-success', 0.2, 'rgba(7,193,96,0.2)') }, lineStyle: { color: p.in }, itemStyle: { color: p.in } }] }],
  }
}

function heatOption(data: LedgerSnapshot, p: Palette): EChartsCoreOption | null {
  const rows = pivotContacts(data.byContact).filter((row) => row.amountIn + row.amountOut + row.count > 0)
  if (rows.length === 0) return null
  const metrics = ['收入', '支出', '笔数'] as const
  const raw = rows.map((row) => [row.amountIn, row.amountOut, row.count])
  const maxes = [0, 1, 2].map((col) => Math.max(...raw.map((line) => line[col] ?? 0), 0))
  const cells: Array<[number, number, number]> = []
  raw.forEach((line, y) => {
    line.forEach((value, x) => {
      const max = maxes[x] ?? 0
      cells.push([x, y, max <= 0 ? 0 : Math.round((value / max) * 100)])
    })
  })
  return {
    tooltip: {
      ...tip(p),
      formatter: (item: unknown) => {
        const cell = (item as { data?: number[] }).data ?? [0, 0, 0]
        const row = rows[cell[1] ?? 0]
        const value = raw[cell[1] ?? 0]?.[cell[0] ?? 0] ?? 0
        const metric = metrics[cell[0] ?? 0] ?? ''
        const shown = metric === '笔数' ? `${String(value)} 笔` : yuan(value)
        return `${row?.name ?? ''}<br/>${metric} ${shown}`
      },
    },
    grid: { left: 8, right: 12, top: 8, bottom: 8, containLabel: true },
    xAxis: { type: 'category', data: [...metrics], axisLabel: axisLabel(p), axisLine: { lineStyle: { color: p.border } } },
    yAxis: { type: 'category', data: rows.map((row) => row.name), axisLabel: axisLabel(p), axisLine: { lineStyle: { color: p.border } } },
    visualMap: { min: 0, max: 100, show: false, inRange: { color: [tokenColor('--nm-success', 0.12, 'rgba(7,193,96,0.12)'), p.in] } },
    series: [{ type: 'heatmap', data: cells, label: { show: false } }],
  }
}

function treemapOption(data: LedgerSnapshot, p: Palette): EChartsCoreOption | null {
  const rows = topContacts(data.byContact, 12).filter((row) => row.amount > 0)
  if (rows.length === 0) return null
  return {
    tooltip: { ...tip(p), valueFormatter: (v: unknown) => yuan(Number(v)) },
    series: [{
      type: 'treemap',
      roam: false,
      breadcrumb: { show: false },
      label: { color: p.text, fontSize: 11, overflow: 'truncate' },
      data: rows.map((row) => ({
        name: contactLabel(row),
        value: row.amount,
        itemStyle: { color: row.direction === 'out' ? p.out : p.in },
      })),
    }],
  }
}

function sunburstOption(data: LedgerSnapshot, p: Palette): EChartsCoreOption | null {
  const s = data.summary
  const income = [
    { name: '转账收入', value: s.transferAmountIn, itemStyle: { color: p.in } },
    { name: '红包收入', value: s.redpacketAmountReceived, itemStyle: { color: tokenColor('--nm-success', 0.55, '#39d07a') } },
  ].filter((part) => part.value > 0)
  const expense = [
    { name: '转账支出', value: s.transferAmountOut, itemStyle: { color: p.out } },
    { name: '红包支出', value: s.redpacketAmountSent, itemStyle: { color: tokenColor('--nm-danger', 0.55, '#ff8a8a') } },
  ].filter((part) => part.value > 0)
  if (income.length + expense.length === 0) return null
  return {
    tooltip: { ...tip(p), valueFormatter: (v: unknown) => yuan(Number(v)) },
    series: [{
      type: 'sunburst',
      radius: ['18%', '90%'],
      label: { color: p.text, fontSize: 11, overflow: 'truncate', width: 64 },
      data: [
        ...(income.length > 0 ? [{ name: '收入', itemStyle: { color: p.in }, children: income }] : []),
        ...(expense.length > 0 ? [{ name: '支出', itemStyle: { color: p.out }, children: expense }] : []),
      ],
    }],
  }
}

function parallelOption(data: LedgerSnapshot, p: Palette): EChartsCoreOption | null {
  const rows = pivotContacts(data.byContact).filter((row) => row.amountIn + row.amountOut + row.count > 0)
  if (rows.length === 0) return null
  const axis = (dim: number, name: string) => ({ dim, name, nameTextStyle: { color: p.muted, fontSize: 11 }, axisLabel: { color: p.muted, fontSize: 10 } })
  return {
    tooltip: { ...tip(p) },
    parallel: { left: 48, right: 48, top: 28, bottom: 16 },
    parallelAxis: [axis(0, '收入'), axis(1, '支出'), axis(2, '笔数')],
    series: [{
      type: 'parallel',
      lineStyle: { width: 1.5, opacity: 0.75, color: p.in },
      data: rows.map((row) => [row.amountIn, row.amountOut, row.count]),
    }],
  }
}

function sankeyOption(data: LedgerSnapshot, p: Palette): EChartsCoreOption | null {
  const links = sankeyLinks(data)
  if (links.length === 0) return null
  return {
    tooltip: { ...tip(p), valueFormatter: (v: unknown) => yuan(Number(v)) },
    series: [{
      type: 'sankey',
      left: 8,
      right: 8,
      top: 8,
      bottom: 8,
      nodeWidth: 12,
      nodeGap: 10,
      lineStyle: { color: 'gradient', opacity: 0.45 },
      label: { color: p.muted, fontSize: 11, overflow: 'truncate', width: 72 },
      data: [...new Set(links.flatMap((link) => [link.source, link.target]))].map((name) => ({
        name,
        itemStyle: { color: name.startsWith('支') ? p.out : p.in },
      })),
      links,
    }],
  }
}

function funnelOption(data: LedgerSnapshot, p: Palette): EChartsCoreOption | null {
  const steps = funnelSteps(data).filter((step) => step.value > 0)
  if (steps.length === 0) return null
  return {
    tooltip: { ...tip(p), trigger: 'item', valueFormatter: (v: unknown) => `${String(v)} 笔` },
    series: [{
      type: 'funnel',
      left: 8,
      right: 8,
      top: 8,
      bottom: 8,
      minSize: '12%',
      sort: 'descending',
      label: { color: p.text, fontSize: 11, position: 'inside' },
      data: steps.map((step, index) => ({
        name: step.name,
        value: step.value,
        itemStyle: { color: index === steps.length - 1 ? p.in : tokenColor('--nm-success', 0.35 + index * 0.2, '#07c160') },
      })),
    }],
  }
}

/** 资金页要画的图。统计地图没有地区字段，不在这里。 */
export function ledgerChartSpecs(data: LedgerSnapshot): LedgerChartSpec[] {
  const p = palette()
  return [
    { key: 'column', title: '柱形图', meta: '四类已知金额', option: columnOption(data, p) },
    { key: 'pie', title: '饼图', meta: '金额构成', option: pieOption(data, p) },
    { key: 'combo', title: '组合图', meta: '柱是金额，线是笔数', option: comboOption(data, p) },
    { key: 'line', title: '线图', meta: '按金额从高到低的累计占比，不是按时间', option: lineOption(data, p) },
    { key: 'sankey', title: '桑基图', meta: '收到的流向我，再流向发出', option: sankeyOption(data, p) },
    { key: 'treemap', title: '矩形树图', meta: '面积是金额', option: treemapOption(data, p) },
    { key: 'sunburst', title: '旭日图', meta: '先分收支，再分类型', option: sunburstOption(data, p) },
    { key: 'scatter', title: '散点图', meta: '横轴笔数，纵轴金额', option: scatterOption(data, p) },
    { key: 'radar', title: '雷达图', meta: '四类金额的相对大小', option: radarOption(data, p) },
    { key: 'heat', title: '热力图', meta: '颜色是该项里的相对高低', option: heatOption(data, p) },
    { key: 'parallel', title: '平行坐标', meta: '每个联系人一条线', option: parallelOption(data, p) },
    { key: 'funnel', title: '漏斗图', meta: '最下层是金额已解析笔数的下限', option: funnelOption(data, p) },
    { key: 'cloud', title: '词云图', meta: '字号是金额', option: null, cloud: true },
  ]
}
