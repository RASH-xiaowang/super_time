/**
 * 市区街道地图（ECharts `map` 系列，阿里 DataV 城市 GeoJSON）。
 *
 * 在「中国 → 省 → 市」层级渲染城市的区县地图（如南宁市的兴宁区、青秀区等）。
 *
 * ## 数据层级事实（2026-10-17 核实）
 *
 * 区域快照是 `世界 → 国家 → 省 → 市 → 好友`，**没有独立的区县字段**
 * （微信 `extra_buffer` 只有 field 5/6/7 = 国家/省/市）。但**直辖市的「市」字段
 * 实际存的是区名**（`北京 › 朝阳区`、`上海 › 徐汇区` —— 见 `region.ts` 的 `CITY_ALIAS`）。
 *
 * 于是 `path` 的第三段有两种可能：
 *   · **普通城市**（`中国 › 广西 › 南宁`）→ 南宁是地级市，`110000_full` 那类文件里
 *     有它的下级区县 ⇒ 渲染区县地图，但**快照里没有区县好友**（`children` 为空）
 *     ⇒ 所有区县 value=0；
 *   · **直辖市的区**（`中国 › 北京 › 朝阳区`）→ 朝阳区**本身就是最细一级**，
 *     再往下是街道（DataV 没有）⇒ 请求 `110105_full` 会 404。
 *
 * ## 修复（2026-10-17 用户报「国内的县区地图内容没有做好」）
 *
 * 修复前这里是 `childByKey={() => null}` —— 即使数据里有区名也匹配不到，
 * 所有区县恒为 0，`visualMap` 把它们全涂成起点色，看起来就是「一张同色地图，没有信息」。
 *
 * 现在分三种情况：
 *   ① **节点本身是区县**（名字以 区/县/旗 结尾）⇒ 不再下钻，直接显示该区的好友数；
 *   ② **有区县子节点**（理论上只有直辖市会有，但快照目前不产生）⇒ 正常着色；
 *   ③ **普通城市**（`children` 为空）⇒ 不画同色地图，给一句明确说明
 *      「本机数据只到市级」+ 该城市好友数。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { RegionNode } from '@deepseek-ai/dsh-wechat-data/types'
import { GeoEchartsMap } from './GeoEchartsMap.tsx'
import { cityGeoUrl } from './city-map-data.ts'
import { fetchCityAdcode } from './city-map-data.ts'
import { provinceCityChild, provinceFeatureLabel, provinceFeatureName } from './province-map-data.ts'
import css from './world-map.module.css'

/** 名字以这些后缀结尾 ⇒ 该节点已经是区县一级（再往下是街道，DataV 没有）。 */
const DISTRICT_SUFFIX = /[区县旗]$/

/** Options for the city map component. */
interface CityMapProps {
  /** The city region node (children = districts, only populated for 直辖市). */
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

  /*
   * ① 节点本身已经是区县（`中国 › 北京 › 朝阳区`）：不再请求下级 GeoJSON
   *    （DataV 没有街道级数据，请求 `110105_full` 会 404）。
   */
  const isDistrictLeaf = DISTRICT_SUFFIX.test(node.name)

  useEffect(() => {
    if (isDistrictLeaf) return
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
  }, [node.name, provinceAdcode, isDistrictLeaf])

  const urls = useMemo(() => (adcode ? [cityGeoUrl(adcode)] : []), [adcode])

  /*
   * 区县匹配：用 `node.children`（直辖市的 children 就是区）。
   * 普通城市的 children 为空 ⇒ 所有区县 value 恒为 0 ⇒ 下面走「无区县数据」提示。
   */
  const hasDistricts = node.children.length > 0
  const childByKey = useMemo(
    () => (key: string) => provinceCityChild(node.children, key),
    [node.children],
  )

  /* ① 已经是区县一级：直接给好友数（没有更细的地图可画）。 */
  if (isDistrictLeaf) {
    return (
      <div className={css.china3d}>
        <div className={css.loading}>
          {node.name} · {node.count} 位好友
          <br />
          已是最细一级（区县），没有更细的地图
        </div>
        {overlay}
      </div>
    )
  }

  if (!adcode) {
    return (
      <div className={css.china3d}>
        <div className={css.loading}>正在加载城市地图…</div>
      </div>
    )
  }

  /*
   * ③ 没有区县数据时**不画同色地图**：所有区县 value=0 时 visualMap 会把它们
   * 全涂成起点色，看起来像「地图坏了 / 数据丢了」。给一句明确说明更有用。
   */
  if (!hasDistricts) {
    return (
      <div className={css.china3d}>
        <div className={css.loading}>
          {node.name} · {node.count} 位好友
          <br />
          本机微信数据只记录到「市」一级，没有区县明细
        </div>
        {overlay}
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
      childByKey={childByKey}
      onDrill={() => { /* district leaves have no child regions */ }}
      onFallback={onFallback}
      overlay={overlay ?? null}
    />
  )
}
