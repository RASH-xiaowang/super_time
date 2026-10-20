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
  /**
   * 点击**没有对应子节点**的区域时调用（可选）。
   *
   * 用途：国家层没有更细的底图可下钻（`geo.datav.aliyun.com` 的 adcode 接口只覆盖中国），
   * 于是点地图任意处都表示「返回世界层」。世界层**不传**它 —— 那里点空白海洋不该有反应。
   */
  onBack?: () => void
  /** Called when GeoJSON fetch or chart initialisation fails. */
  onFallback: () => void
  /** Optional overlay rendered inside the map container (e.g. back button). */
  overlay?: React.JSX.Element | null
  /**
   * `visualMap` 起点色（`value: 0` 的区域）的透明度，默认 0.55。
   *
   * 为什么需要覆盖：世界地图上绝大多数国家没有数据（value = 0），起点色决定
   * 「没数据的陆地」有多亮。数据总览里好友分布很散，0.55 让轮廓清晰；
   * 但朋友圈足迹本机 590 次打卡**全在中国**，0.55 会让中国和其他国家一样亮，
   * 看不出「足迹集中在哪」—— 那里传 0.18，让有数据的国家明显跳出来。
   */
  emptyAlpha?: number
  /**
   * 悬停提示里数量的单位，默认 `位好友`。
   *
   * 为什么需要：这个组件同时被「数据总览」（好友分布）和「朋友圈洞察」（足迹）复用，
   * 而 tooltip 文案原先写死 `位好友` ⇒ 足迹地图上显示「中国 553 位好友」，
   * 但那是 553 次打卡（用户反馈「反馈内容应该是足迹，不是好友」）。
   * 足迹地图传 `次打卡`。
   */
  unit?: string
  /**
   * 用**对数**刻度给 `visualMap` 分档，默认 `false`（线性）。
   *
   * 为什么需要：足迹地图本机广西 457 次、其他省 1~28 次，线性映射下
   * 除广西外全部落在最低档，整张图只有两种颜色（真机截图）。
   * 对数分档让 1 / 10 / 100 / 400 各占一档，少量打卡的省份也看得出深浅。
   * 数据总览的好友分布相对均匀，保持线性。
   */
  logScale?: boolean
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
    const { node, geo, urls, mapName, featureName, featureLabel, childByKey, onDrill, onFallback, onBack } = propsRef.current
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
        /*
         * 分档策略（`logScale` 时启用）：
         *
         * 足迹地图本机广西 457 次、其他省 1~28 次。线性映射下除广西外全部落在最低档；
         * 纯对数 + 两段色阶插值时，1 条和 100 条的颜色差不到 10%（真机截图整张图一片青）。
         *
         * 改成**按实际分布切 5 档**（`piecewise`）：把有数据的区域按数量排序，
         * 每档约 20% 的省份，颜色用 5 个离散色阶。这样「1 条 / 5 条 / 20 条 / 100 条 / 400 条」
         * 各占一档，深浅一眼可分，且不依赖值域跨度。
         */
        const useLog = propsRef.current.logScale === true
        const counts = features
          .map(f => childByKey(featureName(f))?.count ?? 0)
          .filter(n => n > 0)
          .sort((a, b) => a - b)
        const piecewise = useLog && counts.length > 0
        /** 分位点：把有数据的省份按数量切成 5 档。 */
        const cuts: number[] = []
        if (piecewise) {
          for (let i = 1; i <= 4; i += 1) {
            const v = counts[Math.min(counts.length - 1, Math.floor((counts.length * i) / 5))] ?? 1
            // 去重：省份很少时多个分位点会落在同一个值上，重复的 cut 会让 ECharts 报错。
            if (cuts.length === 0 || v > (cuts[cuts.length - 1] ?? 0)) cuts.push(v)
          }
        }
        const dataItems = features.map(f => ({
          name: featureName(f),
          value: childByKey(featureName(f))?.count ?? 0,
        }))
        const visualMax = max
        chart.setOption({
          tooltip: {
            trigger: 'item',
            formatter: (params: { name: string; value: number }) => {
              const name = params.name
              const label = labelBy.get(name) ?? name
              const child = childByKey(name)
              // 单位由调用方给：数据总览是「位好友」，足迹地图是「次打卡」。
              const unit = propsRef.current.unit ?? '位好友'
              // 子行（城市 / 省份）也带单位：改前只有首行有单位，
              // 下面几行是裸数字 `南宁市 457`，看不出是好友数还是打卡数。
              const top = (child?.children.slice(0, 3).map(c => `${c.name} ${String(c.count)} ${unit}`) ?? []).join('<br/>')
              return `${label}<br/>${String(params.value)} ${unit}${top ? `<br/>${top}` : ''}`
            },
            backgroundColor: tokenColor('--dsw-alias-tooltip-bg'),
            borderColor: tokenColor('--nm-cyan', 0.4),
            textStyle: { color: tokenColor('--nm-text-1') },
          },
          visualMap: piecewise
            ? {
                /*
                 * 分档模式（足迹地图）：按实际分布切 5 档，每档一个离散颜色。
                 *
                 * 为什么不用 `min/max + inRange` 连续插值：本机广西 457 次、其他省 1~28 次，
                 * 连续插值时 1 条和 100 条的颜色差不到 10%，整张图一片青（真机截图）。
                 * `piecewise` 让每档颜色固定，深浅一眼可分。
                 */
                type: 'piecewise',
                pieces: [
                  { min: 0, max: 0, color: tokenColor('--nm-map-land') },
                  ...cuts.map((cut, i) => ({
                    min: i === 0 ? 1 : (cuts[i - 1] ?? 0) + 1,
                    max: cut,
                    color: tokenColor('--nm-cyan', 0.3 + i * 0.15),
                  })),
                  { min: (cuts[cuts.length - 1] ?? 0) + 1, color: tokenColor('--nm-purple', 0.95) },
                ],
                textStyle: { color: tokenColor('--nm-text-3'), fontSize: 10 },
                /* 右上角：改前在左下角，与地图重叠（真机截图海南被图例遮住）。 */
                right: 8,
                top: 8,
                itemWidth: 10,
                itemHeight: 8,
                itemGap: 4,
              }
            : {
                min: 0,
                max: visualMax,
                calculable: true,
                // ECharts 画在 canvas 上，颜色必须由 JS 给出具体值（不能写 var()），
                // 否则浅色主题下会沿用深色主题的霓虹配色。
                //
                // ⚠️ 起点透明度不能低（2026-10-16 修「手机端看不到地图」）：
                // `visualMap` 会**覆盖** `itemStyle.areaColor`，所以 `value: 0` 的区域
                // 拿到的就是这里的起点色。世界地图上绝大多数国家没有好友（value = 0），
                // 起点若只有 0.25 透明度，整张地图在深色背景上几乎看不见 ——
                // 实测画布 27.6% 的像素非透明，但 alpha 只有 2~33（最高 13%），
                // 肉眼就是「一片空白」。0.55 让陆地轮廓清晰可辨，同时仍明显弱于有好友的国家。
                //
                // 调用方可用 `emptyAlpha` 覆盖（足迹地图传 0.18：数据全集中在一个国家时，
                // 0.55 会让它和空白国家一样亮，看不出足迹在哪）。
                inRange: { color: [tokenColor('--nm-cyan', propsRef.current.emptyAlpha ?? 0.55), tokenColor('--nm-purple', 0.95)] },
                textStyle: { color: tokenColor('--nm-text-3'), fontSize: 10 },
                /* 右上角：改前在左下角，与地图重叠（真机截图海南被图例遮住）。 */
                right: 8,
                top: 8,
                itemWidth: 10,
                itemHeight: 60,
              },
          series: [{
            type: 'map',
            map: mapName,
            roam: true,
            scaleLimit: { min: 0.8, max: 8 },
            /*
             * 显式给 `layoutCenter` + `layoutSize`：不给时 ECharts 按容器尺寸铺满，
             * 但 `visualMap` 占了左下角一块，地图会被挤到右上、右下角被裁掉
             * （真机截图：海南和南海诸岛只露出一半）。
             *
             * `layoutSize: '100%'` 按容器**短边**算尺寸 —— 容器 755×518 时短边是 518，
             * 中国地图宽高比约 1.4:1 ⇒ 宽 725、高 518，正好铺满。
             * 改前给 92% 时四周各留 4%，地图明显偏小（真机截图）。
             */
            layoutCenter: ['50%', '50%'],
            layoutSize: '100%',
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
          // `onBack`：国家层没有更细的底图可下钻，点地图任意处都表示「返回世界层」。
          // 世界层不传它 —— 那里只有**有好友的国家**才可下钻（点空白海洋不该有反应）。
          else if (onBack) onBack()
        })
      } catch (e) {
        // 留一条可诊断的日志：这张图失败时界面只剩「底图不可用」，没有信息量；
        // 实测过一次「本地 GeoJSON 已到、ECharts 初始化抛错」，控制台没日志很难定位。
        const rect = el.getBoundingClientRect()
        console.warn('[GeoEchartsMap] init failed:', e, {
          mapName: propsRef.current.mapName,
          hasGeo: propsRef.current.geo !== undefined,
          clientW: el.clientWidth,
          clientH: el.clientHeight,
          rect: [Math.round(rect.width), Math.round(rect.height)],
          chart: chart === null ? 'null' : 'created',
        })
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
