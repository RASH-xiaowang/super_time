/**
 * 省区城市地图（ECharts `map` 系列，阿里 DataV 省市 GeoJSON）——`GeoEchartsMap` 的薄封装。
 *
 * 在「中国 → 省份」层级按城市好友数渲染一张可缩放/平移的省份图（比如广西下钻后显示南宁、
 * 柳州等城市板块），悬停提示、点击城市回调 onDrill 进入城市好友面板。GeoJSON 运行时从
 * geo.datav.aliyun.com 的 `<adcode>_full` 拉取；失败（离线）时回退到父级维护的空间叙利化
 * 方块图（onFallback）。
 */
import { useMemo } from 'react'
import type { RegionNode } from '@deepseek-ai/dsh-wechat-data/types'
import { GeoEchartsMap } from './GeoEchartsMap.tsx'
import { provinceCityChild, provinceFeatureLabel, provinceFeatureName, provinceGeoUrl } from './province-map-data.ts'

/** Options for the province map component. */
interface ProvinceMapProps {
  /** The province region node (children = cities). */
  node: RegionNode
  /** Aliyun DataV adcode of the province (e.g. 450000). */
  adcode: string
  /** Called when a city with data is clicked. */
  onDrill: (child: RegionNode) => void
  /** Called when the GeoJSON fetch or chart initialisation fails. */
  onFallback: () => void
  /** Optional overlay rendered inside the map container (e.g. back button). */
  overlay?: React.JSX.Element | null
}

/**
 * Render the province city map.
 * @param props - component props.
 * @returns the map container element.
 */
export function ProvinceMap({ node, adcode, onDrill, onFallback, overlay }: ProvinceMapProps): React.JSX.Element {
  const urls = useMemo(() => [provinceGeoUrl(adcode)], [adcode])
  return (
    <GeoEchartsMap
      node={node}
      mapName="province"
      urls={urls}
      featureName={provinceFeatureName}
      featureLabel={provinceFeatureLabel}
      childByKey={key => provinceCityChild(node.children, key)}
      onDrill={onDrill}
      onFallback={onFallback}
      overlay={overlay ?? null}
    />
  )
}
