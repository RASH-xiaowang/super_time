/**
 * 朋友圈足迹地图（离线自绘，不依赖任何网络资源）。
 *
 * 数据源是后端 `MomentsGeo.pointList` —— 每条带坐标朋友圈的**已修正**经纬度
 * （微信在 XML 里把 latitude/longitude 两个属性写反，见 query/moments-insights.ts 的说明）。
 * 这里不做任何坐标换算假设，只做投影：`project(lng, lat)`（等距圆柱，与 WorldMap 同一套 viewBox）。
 *
 * 两个视图：
 *   · 世界：0..360 / -90..90 全图（能看到出境记录）
 *   · 足迹范围：按实际数据的 bbox 自适应放大（本机 99% 的点在中国，世界视图下会挤成一团）
 *
 * 为什么按坐标聚成气泡而不是画 490 个点：同一个地点打卡多次时坐标**完全相同**，
 * 直接画会重叠成一个点、看不出次数。聚合口径写在界面上（「490 次打卡 → N 个坐标点」），
 * 所以「聚合」这件事对用户是可见的，不是偷偷做的。
 */
import { useMemo, useState } from 'react'
import type { MomentsGeoPoint } from '@deepseek-ai/dsh-wechat-data/types'
import { CONTINENTS, MAP_H, MAP_W, smoothClosedPath, type ProjectFn } from './world-geo.ts'
import { Segmented } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './moments-insights.module.css'

/**
 * 一个聚合后的坐标气泡。
 * 坐标按 3 位小数（约 110 m）归并：同一次打卡写出的浮点数完全相同，
 * 3 位小数只是把「同一地点、略有抖动」的记录也并到一起。
 */
interface FootprintCluster {
  lat: number
  lng: number
  count: number
  city: string
  poi: string
}

/**
 * Group raw points into coordinate clusters.
 * @param points - corrected points from the backend.
 * @returns clusters sorted by count desc, then by city/poi for stability.
 */
function clusterPoints(points: readonly MomentsGeoPoint[]): FootprintCluster[] {
  const map = new Map<string, FootprintCluster>()
  for (const p of points) {
    const key = `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`
    const cur = map.get(key)
    if (cur) {
      cur.count += 1
      if (!cur.city && p.city) cur.city = p.city
      if (!cur.poi && p.poi) cur.poi = p.poi
    } else {
      map.set(key, { lat: p.lat, lng: p.lng, count: 1, city: p.city, poi: p.poi })
    }
  }
  return [...map.values()].sort((a, b) => b.count - a.count || a.city.localeCompare(b.city) || a.poi.localeCompare(b.poi))
}

/** Build a projection that fits the cluster bbox into the fixed viewBox, keeping the 2:1 aspect. */
function fitProjection(clusters: readonly FootprintCluster[]): { proj: ProjectFn; bbox: [number, number, number, number] } | null {
  if (clusters.length === 0) return null
  let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity
  for (const c of clusters) {
    if (c.lng < lonMin) lonMin = c.lng
    if (c.lng > lonMax) lonMax = c.lng
    if (c.lat < latMin) latMin = c.lat
    if (c.lat > latMax) latMax = c.lat
  }
  // 单点 / 单线退化成 0 宽或 0 高时给一个最小跨度，否则除零得到 Infinity 坐标
  let spanLon = Math.max(lonMax - lonMin, 1)
  let spanLat = Math.max(latMax - latMin, 1)
  // viewBox 是 2:1，投影后要保持「不拉伸」：把较窄的一边撑到同样的纵横比
  const targetRatio = MAP_W / MAP_H
  const curRatio = spanLon / spanLat
  if (curRatio < targetRatio) {
    const need = spanLat * targetRatio
    const mid = (lonMin + lonMax) / 2
    lonMin = mid - need / 2; lonMax = mid + need / 2
  } else {
    const need = spanLon / targetRatio
    const mid = (latMin + latMax) / 2
    latMin = mid - need / 2; latMax = mid + need / 2
  }
  // 8% 内边距，避免边缘的点贴在框上
  const padLon = (lonMax - lonMin) * 0.08
  const padLat = (latMax - latMin) * 0.08
  lonMin -= padLon; lonMax += padLon; latMin -= padLat; latMax += padLat
  const proj: ProjectFn = (lon, lat) => ({
    x: ((lon - lonMin) / (lonMax - lonMin)) * MAP_W,
    y: ((latMax - lat) / (latMax - latMin)) * MAP_H,
  })
  return { proj, bbox: [lonMin, lonMax, latMin, latMax] }
}

/** Marker radius from the number of check-ins at that coordinate (log so 1 vs 30 stays readable). */
function radiusOf(count: number): number {
  return Math.min(2.4 + 1.9 * Math.log2(1 + count), 9)
}

/**
 * Render the moments footprint map.
 * @param props.points - corrected (lat, lng) points; empty renders nothing.
 * @param props.cities - number of distinct cities, shown in the summary.
 */
export function FootprintMap({ points, cities }: { points: readonly MomentsGeoPoint[]; cities: number }): React.JSX.Element | null {
  const clusters = useMemo(() => clusterPoints(points), [points])
  const fit = useMemo(() => fitProjection(clusters), [clusters])
  const [view, setView] = useState<'world' | 'fit'>('fit')
  if (points.length === 0) return null

  const useFit = view === 'fit' && fit !== null
  const proj: ProjectFn = useFit && fit ? fit.proj : (lon, lat) => ({
    x: ((lon + 180) / 360) * MAP_W,
    y: ((90 - lat) / 180) * MAP_H,
  })
  const maxCount = clusters.reduce((m, c) => Math.max(m, c.count), 1)
  const area = useFit ? '' : ` 当前为世界视图：本机 ${points.length} 次打卡里绝大多数落在东亚，会挤成一小团。`
  const summary = `${points.length} 次打卡 · ${clusters.length} 个坐标点 · ${cities} 个城市`

  return (
    <div className={css.footprintWrap}>
      <div className={css.footprintBar}>
        <span className={kitCss.textCaption}>{summary}</span>
        <Segmented
          ariaLabel="足迹地图范围"
          value={view}
          onChange={(v) => { setView(v === 'world' ? 'world' : 'fit') }}
          options={[{ value: 'fit', label: '足迹范围' }, { value: 'world', label: '世界' }]}
        />
      </div>
      <svg
        className={css.footprintSvg}
        viewBox={`0 0 ${MAP_W} ${MAP_H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`朋友圈足迹地图：${summary}。${area}点越大表示该坐标打卡次数越多（本次最多 ${maxCount} 次）。`}
      >
        <g>
          {CONTINENTS.map(c => (
            <path key={c.name} className={css.footprintLand} d={smoothClosedPath(c.points, proj)} />
          ))}
        </g>
        <g>
          {clusters.map(c => {
            const p = proj(c.lng, c.lat)
            const label = `${c.city || '未知城市'}${c.poi ? ' · ' + c.poi : ''} · ${c.count} 次`
            return (
              <circle
                key={`${c.lat},${c.lng}`}
                className={css.footprintDot}
                data-st-point="1"
                data-count={c.count}
                data-lat={c.lat}
                data-lng={c.lng}
                cx={p.x}
                cy={p.y}
                r={radiusOf(c.count)}
                style={{ opacity: 0.35 + 0.55 * (c.count / maxCount) }}
              >
                <title>{label}</title>
              </circle>
            )
          })}
        </g>
      </svg>
      <div className={css.footprintFoot}>
        <span className={kitCss.textCaption}>
          点大小/亮度 = 该坐标的打卡次数（最多 {maxCount} 次）· 坐标取自每条朋友圈 XML 的
          &lt;location&gt;，微信把 latitude/longitude 写反，后端已换回
        </span>
      </div>
    </div>
  )
}
