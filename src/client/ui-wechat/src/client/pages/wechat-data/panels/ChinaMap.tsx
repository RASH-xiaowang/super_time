/**
 * 中国地图（ECharts `map` 系列，中文国名 GeoJSON + 阿里 DataV 兜底）——`GeoEchartsMap` 的薄封装。
 *
 * 世界层下钻到「中国」时，用 echarts 渲染一张可缩放/平移的中国地图，按省份好友数
 * 分级填色（choropleth），悬停显示提示、点击有数据的省份回调 onDrill 进入该省/市方块图。
 * GeoJSON 优先从与「世界地图」同源的 jsDelivr 中文国名数据包拉取（chinese-global-compliant-geodata
 * 的 chn-level-1.json，feature 名为北京/广东/香港等），失败后回退到阿里 DataV 的
 * `100000_full`（按 adcode 归一化）；两者都失败（离线）时回退到父级维护的 2D SVG 地图。
 */
import type { RegionNode } from '@deepseek-ai/dsh-wechat-data/types'
import { GeoEchartsMap } from './GeoEchartsMap.tsx'
import { worldChildByName, type WorldGeoFeature } from './world-map-data.ts'
import { provinceAdcode } from './world-geo.ts'

/** China GeoJSON candidates, in preference order (same CDN as the world map first). */
const CHINA_GEO_URLS = [
  'https://cdn.jsdelivr.net/npm/chinese-global-compliant-geodata@1.0.0/dist/src/geojson/countries/as/chn/global/chn-level-1.json',
  'https://unpkg.com/chinese-global-compliant-geodata@1.0.0/dist/src/geojson/countries/as/chn/global/chn-level-1.json',
  'https://geo.datav.aliyun.com/areas_v3/bound/geojson?code=100000_full',
] as const

/**
 * Registered feature name: Aliyun uses numeric adcodes, the Chinese-name dataset
 * uses Chinese province names. Boundary-line features (「境界线」) are dropped.
 * @param feature - one China GeoJSON feature.
 * @returns the registered name, or '' to skip the feature.
 */
function chinaFeatureName(feature: WorldGeoFeature): string {
  const p = feature.properties
  const name = p?.name
  if (name === '境界线') return ''
  const ad = p?.adcode
  if (typeof ad === 'string' && ad) return ad
  if (typeof ad === 'number' && Number.isFinite(ad)) return String(ad)
  if (typeof name === 'string' && name) return name
  const upper = p?.NAME
  return typeof upper === 'string' && upper ? upper : ''
}

/** Tooltip display label for a China feature. */
function chinaFeatureLabel(feature: WorldGeoFeature): string {
  const p = feature.properties
  const name = p?.name
  return typeof name === 'string' && name ? name : ''
}

/**
 * Match a registered feature key to the region snapshot child. Adcodes map via
 * provinceAdcode; Chinese names (including 香港/澳门/台湾) map via the world alias table.
 */
function chinaChildByKey(children: readonly RegionNode[], key: string): RegionNode | null {
  if (/^\d{6}$/.test(key)) return children.find(c => provinceAdcode(c.name) === key) ?? null
  return worldChildByName(children, key)
}

/** Options for the China map component. */
interface ChinaMapProps {
  /** The 中国 region node (children = provinces). */
  node: RegionNode | null
  /** Called when a province with data is clicked. */
  onDrill: (child: RegionNode) => void
  /** Called when the ECharts map cannot be initialised (offline GeoJSON fetch / render error). */
  onFallback: () => void
  /** Optional overlay rendered inside the map container (e.g. back button). */
  overlay?: React.JSX.Element | null
}

/**
 * Render the China map.
 * @param props - component props.
 * @returns the map container element.
 */
export function ChinaMap({ node, onDrill, onFallback, overlay }: ChinaMapProps): React.JSX.Element {
  return (
    <GeoEchartsMap
      node={node}
      mapName="china"
      urls={CHINA_GEO_URLS}
      featureName={chinaFeatureName}
      featureLabel={chinaFeatureLabel}
      childByKey={key => chinaChildByKey(node?.children ?? [], key)}
      onDrill={onDrill}
      onFallback={onFallback}
      overlay={overlay ?? null}
    />
  )
}
