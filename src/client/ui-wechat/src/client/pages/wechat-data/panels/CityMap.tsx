/**
 * 市区街道地图（ECharts `map` 系列，阿里 DataV 城市 GeoJSON）。
 *
 * 在「中国 → 省 → 市」层级渲染城市的区县地图（如南宁市的兴宁区、青秀区等）。区域快照
 * 不含区级好友，因此各区颜色按 0 值展示，真正的朋友数据由两侧头像栏提供；GeoJSON 拉取
 * 失败时回退到父级维护的好友面板（onFallback）。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RegionNode } from '@deepseek-ai/dsh-wechat-data/types'
import { GeoEchartsMap } from './GeoEchartsMap.tsx'
import { cityGeoUrl } from './city-map-data.ts'
import { fetchCityAdcode } from './city-map-data.ts'
import { provinceFeatureLabel, provinceFeatureName } from './province-map-data.ts'
import css from './world-map.module.css'

/** Options for the city map component. */
interface CityMapProps {
  /** The city region node (districts are not present in the snapshot). */
  node: RegionNode
  /** Aliyun DataV adcode of the parent province (e.g. 450000). */
  provinceAdcode: string
  /** Called when the adcode resolution or district GeoJSON fetch fails. */
  onFallback: () => void
  /** Optional overlay rendered inside the map container (e.g. back button). */
  overlay?: React.JSX.Element | null
}

/**
 * Render the city district map.
 * @param props - component props.
 * @returns the map container element.
 */
export function CityMap({ node, provinceAdcode, onFallback, overlay }: CityMapProps): React.JSX.Element {
  const [adcode, setAdcode] = useState<string | null>(null)
  const onFallbackRef = useRef(onFallback)
  onFallbackRef.current = onFallback

  useEffect(() => {
    let alive = true
    setAdcode(null)
    void (async () => {
      try {
        const code = await fetchCityAdcode(provinceAdcode, node.name)
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- cleanup can flip alive while the fetch awaits.
        if (!alive) return
        if (code) setAdcode(code)
        else onFallbackRef.current()
      } catch {
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- cleanup can flip alive before a settled rejection resumes.
        if (alive) onFallbackRef.current()
      }
    })()
    return () => { alive = false }
  }, [node.name, provinceAdcode])

  const urls = useMemo(() => (adcode ? [cityGeoUrl(adcode)] : []), [adcode])

  if (!adcode) {
    return (
      <div className={css.china3d}>
        <div className={css.loading}>正在加载城市地图…</div>
      </div>
    )
  }

  return (
    <GeoEchartsMap
      node={node}
      mapName="city"
      urls={urls}
      featureName={provinceFeatureName}
      featureLabel={provinceFeatureLabel}
      childByKey={() => null}
      onDrill={() => { /* district leaves have no child regions */ }}
      onFallback={onFallback}
      overlay={overlay ?? null}
    />
  )
}
