/**
 * Generic ECharts `map` renderer shared by the China drill-down and the world
 * level. Takes preloaded GeoJSON (`geo`) or fetches the first reachable URL,
 * registers the map with feature names normalised to `featureName`, colours
 * regions by friend count (`visualMap`), shows a hover tooltip and drills into
 * a region on click. Fetch/init failures call `onFallback` so the parent can
 * show the offline SVG map instead.
 */
import { useEffect, useRef } from 'react'
import * as echarts from 'echarts/core'
import { MapChart } from 'echarts/charts'
import { TooltipComponent, VisualMapComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import type { RegionNode } from '@deepseek-ai/dsh-wechat-data/types'
import { fetchFirstJson, type WorldGeoFeature } from './world-map-data.ts'
import { tokenColor } from '../utils/theme-color.ts'
import { useThemeMode } from '../theme.ts'
import css from './world-map.module.css'

echarts.use([MapChart, TooltipComponent, VisualMapComponent, CanvasRenderer])

/** GeoJSON shape accepted by `echarts.registerMap`. */
type GeoInput = Parameters<typeof echarts.registerMap>[1]

/** GeoJSON collection with a feature array. */
interface GeoCollection {
  features?: WorldGeoFeature[]
}

/** Props for the generic ECharts map. */
export interface GeoEchartsMapProps {
  /** Region node whose children are the geographic regions; null renders nothing. */
  node: RegionNode | null
  /** `registerMap` key. */
  mapName: string
  /** GeoJSON URLs tried in order when `geo` is not provided. */
  urls: readonly string[]
  /** Preloaded GeoJSON; avoids a second fetch when the parent probed first. */
  geo?: unknown
  /** GeoJSON feature -> registered name (adcode for China, zh name for world). */
  featureName: (feature: WorldGeoFeature) => string
  /** GeoJSON feature -> display label for the tooltip. */
  featureLabel: (feature: WorldGeoFeature) => string
  /** Registered name -> region node (null = no friends in that region). */
  childByKey: (key: string) => RegionNode | null
  /** Called when a region with friends is clicked. */
  onDrill: (child: RegionNode) => void
  /** Called when GeoJSON fetch or chart initialisation fails. */
  onFallback: () => void
  /** Optional overlay rendered inside the map container (e.g. back button). */
  overlay?: React.JSX.Element | null
}

/**
 * Render an ECharts map.
 * @param props - component props.
 * @returns the map container element.
 */
export function GeoEchartsMap(props: GeoEchartsMapProps): React.JSX.Element {
  const elRef = useRef<HTMLDivElement | null>(null)
  const propsRef = useRef(props)
  // 图表配色取自主题令牌，切换主题后必须重建 option 才会换色。
  const themeMode = useThemeMode()

  useEffect(() => {
    propsRef.current = props
  })

  useEffect(() => {
    let alive = true
    let chart: echarts.ECharts | null = null
    const el = elRef.current
    if (!el) {
      /* v8 ignore next -- React attaches the ref before the effect runs. */
      props.onFallback()
      return
    }
    const { node, geo, urls, mapName, featureName, featureLabel, childByKey, onDrill, onFallback } = propsRef.current
    if (!node) {
      onFallback()
      return
    }
    void (async () => {
      try {
        const data = geo ?? await fetchFirstJson(urls)
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- cleanup can flip alive while the fetch awaits.
        if (!alive) return
        const features = ((data as GeoCollection).features ?? []).filter(f => featureName(f))
        // Build a minimal GeoJSON with only type + features: the Chinese
        // compliant dataset carries an EPSG:4490 `crs` field that ECharts'
        // GeoJSON parser does not consume and would otherwise blank the map.
        const registered = {
          type: 'FeatureCollection',
          features: features.map(f => ({
            ...f,
            properties: { ...(f.properties ?? {}), name: featureName(f) },
          })),
        } as GeoInput
        echarts.registerMap(mapName, registered)
        chart = echarts.init(el)
        const labelBy = new Map<string, string>()
        for (const f of features) {
          const name = featureName(f)
          labelBy.set(name, featureLabel(f))
        }
        const max = features.reduce((a, f) => Math.max(a, childByKey(featureName(f))?.count ?? 0), 0) || 1
        const dataItems = features.map(f => ({
          name: featureName(f),
          value: childByKey(featureName(f))?.count ?? 0,
        }))
        chart.setOption({
          tooltip: {
            trigger: 'item',
            formatter: (params: { name: string; value: number }) => {
              const name = params.name
              const label = labelBy.get(name) ?? name
              const child = childByKey(name)
              const top = (child?.children.slice(0, 3).map(c => `${c.name} ${c.count}`) ?? []).join('<br/>')
              return `${label}<br/>${params.value} 位好友${top ? `<br/>${top}` : ''}`
            },
            backgroundColor: tokenColor('--dsw-alias-tooltip-bg'),
            borderColor: tokenColor('--nm-cyan', 0.4),
            textStyle: { color: tokenColor('--nm-text-1') },
          },
          visualMap: {
            min: 0,
            max,
            calculable: true,
            // ECharts 画在 canvas 上，颜色必须由 JS 给出具体值（不能写 var()），
            // 否则浅色主题下会沿用深色主题的霓虹配色。
            inRange: { color: [tokenColor('--nm-cyan', 0.25), tokenColor('--nm-purple', 0.95)] },
            textStyle: { color: tokenColor('--nm-text-3') },
            left: 10,
            bottom: 10,
          },
          series: [{
            type: 'map',
            map: mapName,
            roam: true,
            scaleLimit: { min: 0.8, max: 8 },
            data: dataItems,
            label: { show: false, color: tokenColor('--nm-text-2'), fontSize: 10 },
            itemStyle: { areaColor: tokenColor('--nm-map-land'), borderColor: tokenColor('--nm-cyan', 0.45), borderWidth: 0.6 },
            emphasis: { label: { show: true, color: tokenColor('--nm-text-1'), fontWeight: 'bold' }, itemStyle: { areaColor: tokenColor('--nm-cyan', 0.85) } },
          }],
        } as unknown as echarts.EChartsCoreOption)
        chart.on('click', (params: unknown) => {
          const name = (params as { name?: string }).name ?? ''
          const child = childByKey(name)
          if (child) onDrill(child)
        })
      } catch {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- cleanup can flip alive before a settled rejection resumes.
        if (alive) onFallback()
      }
    })()
    const ro = new ResizeObserver(() => { chart?.resize() })
    ro.observe(el)
    return () => {
      alive = false
      ro.disconnect()
      chart?.dispose()
    }
  }, [props.node, props.mapName, props.geo, props.urls, themeMode])

  return (
    <div className={css.mapFrame}>
      {/* The overlay is a sibling of the chart container: echarts.init() clears
          the container's children, so an overlay inside it would be removed. */}
      <div ref={elRef} className={css.china3d} />
      {props.overlay}
    </div>
  )
}
