/**
 * friend 地区世界地图.
 *
 * 世界层有两种视图：联网时优先用 ECharts 渲染真实世界地理地图（中文国名 GeoJSON，
 * 按好友数分级填色、悬停提示、点击国家下钻）；GeoJSON 不可达或用户切换后回退到
 * 自绘的等距圆柱 SVG 世界地图（粗略大陆剪影 + 涟漪标记）。下钻到「中国」时按省份
 * 渲染 ECharts 中国地图（对应 3D 中国地图下钻示例的交互），省份点击后再落到省/市的
 * 方块图。其它国家/城市的下钻仍用空间叙利化的方块图（treemap），悬停城市块在旁展示
 * 好友头像与标签。支持鼠标滚轮缩放、拖拽平移，以及「聚焦中国」／「重置视图」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiGetAvatarsLocal, apiGetRegionMap } from '../api.ts'
import { useWechatDataUpdated } from './hooks.tsx'
import type { RegionFriend, RegionMapSnapshot, RegionNode } from '@deepseek-ai/dsh-wechat-data/types'
import { squarify } from './treemap.ts'
import { ChinaMap } from './ChinaMap.tsx'
import { CityMap } from './CityMap.tsx'
import { FriendAvatarRail } from './FriendAvatarRail.tsx'
import { GeoEchartsMap } from './GeoEchartsMap.tsx'
import { ProvinceMap } from './ProvinceMap.tsx'
import { WORLD_GEO_URLS, fetchFirstJson, worldChildByName, worldFeatureName } from './world-map-data.ts'
import { collectSubtreeFriends } from './region-friends.ts'
import {
  CHINA_BBOX,
  CHINA_OUTLINE,
  CONTINENTS,
  MAP_H,
  MAP_W,
  countryCenter,
  project,
  projectBBox,
  provinceAdcode,
  provinceCenter,
  smoothClosedPath,
  type ProjectFn,
} from './world-geo.ts'
import css from './world-map.module.css'

/** Pick the display name for a friend. */
function friendName(f: RegionFriend): string {
  return f.displayName || f.remark || f.nickName
}

/** One layout slot (item + rect) owned by the component. */
interface Slot {
  node: RegionNode
  x: number
  y: number
  w: number
  h: number
}

/** Pan/zoom state in viewBox coordinates (MAP_W x MAP_H). */
interface MapView {
  k: number
  tx: number
  ty: number
}

/** Clamp a view so the map cannot be panned off-screen. */
function clampView(v: MapView): MapView {
  const k = Math.min(12, Math.max(1, v.k))
  const maxTx = MAP_W * (k - 1)
  const maxTy = MAP_H * (k - 1)
  return {
    k,
    tx: Math.min(0, Math.max(-maxTx, v.tx)),
    ty: Math.min(0, Math.max(-maxTy, v.ty)),
  }
}

/** Interpolate the space-capsule accent cyan -> violet by friend density. */
function densityColor(ratio: number): string {
  const t = Math.max(0, Math.min(1, ratio))
  const r = Math.round(168 * t)
  const g = Math.round(240 + (85 - 240) * t)
  const b = Math.round(255 + (247 - 255) * t)
  return `rgb(${r}, ${g}, ${b})`
}

/** Bbox-fit projection that fills the viewBox with mainland China. */
const chinaProject: ProjectFn = (lon, lat) => projectBBox(lon, lat, CHINA_BBOX)

/**
 * Render the world-region map.
 * @returns the world-map element tree.
 */
export function WorldMapPanel(): React.JSX.Element {
  const [map, setMap] = useState<RegionMapSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Drill path: [] = world map; [country]; [country, province].
  const [path, setPath] = useState<RegionNode[]>([])
  // Hovered leaf city (friends shown beside) within the treemap.
  const [hoverCity, setHoverCity] = useState<RegionNode | null>(null)
  const [avatars, setAvatars] = useState<Record<string, string>>({})
  const [view, setView] = useState<MapView>({ k: 1, tx: 0, ty: 0 })
  const [hoverRegion, setHoverRegion] = useState<{ node: RegionNode; x: number; y: number } | null>(null)
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [mapSize, setMapSize] = useState({ w: 0, h: 0 })
  const [chinaFallback, setChinaFallback] = useState(false)
  const [provinceFallback, setProvinceFallback] = useState(false)
  const [cityFallback, setCityFallback] = useState(false)
  const [worldGeo, setWorldGeo] = useState<{ ok: true; data: unknown } | { ok: false } | null>(null)
  const worldGeoRef = useRef<{ ok: true; data: unknown } | { ok: false } | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; tx: number; ty: number } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setError(null)
    try {
      const m = await apiGetRegionMap()
      setMap(m)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => { void load() }, [load])
  useWechatDataUpdated(() => { void load() })

  const level = path.length
  const onWorldMap = level === 0
  const focused = onWorldMap ? null : path[path.length - 1] ?? null
  const chinaMode = !onWorldMap && focused?.key === '中国'
  // A province under 中国 (path [中国, 广西]) renders a city-level ECharts map.
  const provinceNode = !onWorldMap && level === 2 && path[0]?.key === '中国' ? focused : null
  const provinceAd = provinceNode ? provinceAdcode(provinceNode.name) : null
  const provinceMode = provinceAd !== null
  const showProvinceMap = provinceMode && !provinceFallback
  // A city under a Chinese province (path [中国, 广西, 南宁]) renders a district map.
  const cityNode = !onWorldMap && level === 3 && path[0]?.key === '中国' ? focused : null
  const cityProvinceAd = cityNode && path[1] ? provinceAdcode(path[1].name) : null
  const cityMode = cityProvinceAd !== null
  const showCityMap = cityMode && !cityFallback
  const worldEchartsReady = onWorldMap && worldGeo?.ok === true
  const showWorldEcharts = worldEchartsReady
  const showWorldSvg = onWorldMap && !showWorldEcharts
  // A geographic SVG map is rendered for the world level before the ECharts map
  // is ready or when it fails; it is never offered as a manual view toggle.
  const showGeoMap = showWorldSvg || (chinaMode && chinaFallback)
  // The ECharts map is the default China view; it falls back to the SVG map when offline.
  const showChinaEcharts = chinaMode && !chinaFallback
  // Everything else (non-China countries, cities, unknown provinces) uses the squarified treemap.
  const showTreemap = !onWorldMap && !chinaMode && !showProvinceMap && !showCityMap

  const children = focused?.children ?? []

  // Contacts of the whole current subtree, split across the two side rails.
  // 每侧 4 列；栏内可滚动查看全部好友。
  const levelFriends = useMemo(() => collectSubtreeFriends(onWorldMap ? map?.world : focused), [onWorldMap, map, focused])
  const halfFriends = Math.ceil(levelFriends.length / 2)
  const leftFriends = levelFriends.slice(0, halfFriends)
  const rightFriends = levelFriends.slice(halfFriends)

  // Probe the world GeoJSON once per session visit (kept in a ref so a fetch
  // failure does not retry in a loop); the SVG map stays visible until ready.
  useEffect(() => {
    if (!onWorldMap) return
    const cached = worldGeoRef.current
    if (cached) {
      setWorldGeo(cached)
      return
    }
    let alive = true
    void fetchFirstJson(WORLD_GEO_URLS)
      .then((data) => {
        worldGeoRef.current = { ok: true, data }
        if (alive) setWorldGeo({ ok: true, data })
      })
      .catch(() => {
        worldGeoRef.current = { ok: false }
        if (alive) setWorldGeo({ ok: false })
      })
    return () => { alive = false }
  }, [onWorldMap])

  // Measure the treemap canvas (present only when the treemap is shown).
  useEffect(() => {
    if (!showTreemap) return
    const el = canvasRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setBox({ w: Math.max(0, r.width), h: Math.max(0, r.height) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [showTreemap, map])

  // Measure the map container (world level or China province level).
  useEffect(() => {
    if (!showGeoMap) return
    const el = mapRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setMapSize({ w: Math.max(0, r.width), h: Math.max(0, r.height) })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [showGeoMap, map])

  // Native (non-passive) wheel listener so the map can zoom without scrolling.
  useEffect(() => {
    if (!showGeoMap) return
    const el = mapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const mx = ((e.clientX - r.left) / r.width) * MAP_W
      const my = ((e.clientY - r.top) / r.height) * MAP_H
      setView((v) => {
        const factor = e.deltaY < 0 ? 1.15 : 0.87
        const k2 = Math.min(12, Math.max(1, v.k * factor))
        const scale = k2 / v.k
        return clampView({ k: k2, tx: mx - (mx - v.tx) * scale, ty: my - (my - v.ty) * scale })
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel) }
  }, [showGeoMap, map])

  // Reset the view (and hover) whenever the geo source or the snapshot changes.
  useEffect(() => {
    setView({ k: 1, tx: 0, ty: 0 })
    setHoverRegion(null)
    setHoverCity(null)
    setChinaFallback(false)
    setProvinceFallback(false)
    setCityFallback(false)
  }, [onWorldMap, chinaMode, map])

  // Lay out the current drill level as a treemap (province -> city, or city list).
  const slots = useMemo<Slot[]>(() => {
    if (!showTreemap || !focused || box.w <= 0 || box.h <= 0) return []
    const items = children.map(n => ({ value: n.count }))
    const rects = squarify(items, { x: 0, y: 0, w: box.w, h: box.h })
    return children.map((node, i) => {
      const r = rects[i]
      return r ? { node, x: r.x, y: r.y, w: r.w, h: r.h } : { node, x: 0, y: 0, w: 0, h: 0 }
    })
  }, [showTreemap, focused, children, box])

  // Load avatars for the hovered city's friends.
  useEffect(() => {
    if (!hoverCity || hoverCity.friends.length === 0) return
    let alive = true
    void apiGetAvatarsLocal({ usernames: hoverCity.friends.map(f => f.username) })
      .then((r) => { if (alive) setAvatars(r) })
      .catch(() => { if (alive) setAvatars({}) })
    return () => { alive = false }
  }, [hoverCity])

  // 懒加载左右两侧联系人栏的头像（只请求尚未加载的账号）。
  const railKey = leftFriends.concat(rightFriends).map(f => f.username).sort().join('|')
  useEffect(() => {
    const usernames = railKey ? railKey.split('|') : []
    if (usernames.length === 0) return
    const missing = usernames.filter(u => !(u in avatars))
    if (missing.length === 0) return
    let alive = true
    void apiGetAvatarsLocal({ usernames: missing })
      .then((r) => {
        if (!alive) return
        setAvatars(prev => ({ ...prev, ...r }))
      })
      .catch(() => { /* 头像不可用保持字母占位 */ })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [railKey])

  // Geo source: world countries, or China's provinces.
  const geoRegions = onWorldMap ? (map?.world.children ?? []) : (chinaMode ? children : [])
  const geoCenter = onWorldMap ? countryCenter : provinceCenter
  const geoMax = geoRegions.reduce((a, c) => Math.max(a, c.count), 0) || 1
  const geoRipple = new Set(geoRegions.slice().sort((a, b) => b.count - a.count).slice(0, 3).map(c => c.key))
  const geoMarkers = useMemo(() => geoRegions.map(c => ({ node: c, center: geoCenter(c.name) })), [geoRegions, geoCenter])
  const located = geoMarkers.filter(m => m.center !== null)

  const activeProj = chinaMode ? chinaProject : project
  const backdropPaths = useMemo(() => {
    if (onWorldMap) return CONTINENTS.map(c => smoothClosedPath(c.points))
    if (chinaMode) return [smoothClosedPath(CHINA_OUTLINE, chinaProject)]
    return []
  }, [onWorldMap, chinaMode])
  const graticule = useMemo(() => {
    if (onWorldMap) {
      const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
      for (let lon = -180; lon <= 180; lon += 30) {
        const a = project(lon, 90)
        const b = project(lon, -90)
        lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })
      }
      for (let lat = -60; lat <= 60; lat += 30) {
        const a = project(-180, lat)
        const b = project(180, lat)
        lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })
      }
      return lines
    }
    if (chinaMode) {
      const lines: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
      for (let lon = CHINA_BBOX.lonMin; lon <= CHINA_BBOX.lonMax; lon += 10) {
        const a = chinaProject(lon, CHINA_BBOX.latMax)
        const b = chinaProject(lon, CHINA_BBOX.latMin)
        lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })
      }
      for (let lat = CHINA_BBOX.latMin; lat <= CHINA_BBOX.latMax; lat += 10) {
        const a = chinaProject(CHINA_BBOX.lonMin, lat)
        const b = chinaProject(CHINA_BBOX.lonMax, lat)
        lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y })
      }
      return lines
    }
    return []
  }, [onWorldMap, chinaMode])

  const goUp = (): void => {
    setPath(p => p.slice(0, Math.max(0, p.length - 1)))
    setHoverCity(null)
  }

  const zoomInto = (node: RegionNode): void => {
    setPath(p => [...p, node])
    setHoverCity(null)
    setHoverRegion(null)
  }

  const goWorld = (): void => {
    setPath([])
    setHoverCity(null)
  }

  /** Switch the world level back to the automatic SVG fallback when ECharts init fails. */
  const fallbackWorldEcharts = (): void => {
    worldGeoRef.current = { ok: false }
    setWorldGeo({ ok: false })
  }

  /** Drill from a province map into a city and immediately show its friends. */
  const openCity = (node: RegionNode): void => {
    setPath(p => [...p, node])
    setHoverCity(node)
    setHoverRegion(null)
  }

  const focusChina = (): void => {
    const hit = countryCenter('中国')
    if (!hit) return
    const p = project(hit[0], hit[1])
    setHoverRegion(null)
    setView(clampView({ k: 4, tx: MAP_W / 2 - p.x * 4, ty: MAP_H / 2 - p.y * 4 }))
  }

  const resetView = (): void => {
    setHoverRegion(null)
    setView({ k: 1, tx: 0, ty: 0 })
  }

  const projectView = (lon: number, lat: number): { x: number; y: number } => {
    const p = activeProj(lon, lat)
    return {
      x: ((p.x * view.k + view.tx) / MAP_W) * mapSize.w,
      y: ((p.y * view.k + view.ty) / MAP_H) * mapSize.h,
    }
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (view.k === 1) return
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { startX: e.clientX, startY: e.clientY, tx: view.tx, ty: view.ty }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = dragRef.current
    if (!d || mapSize.w === 0) return
    const dx = ((e.clientX - d.startX) / mapSize.w) * MAP_W
    const dy = ((e.clientY - d.startY) / mapSize.h) * MAP_H
    setView(v => clampView({ ...v, tx: d.tx + dx, ty: d.ty + dy }))
  }
  const onPointerUp = (): void => { dragRef.current = null }

  return (
    <div className={css.wrap}>
      <div className={css.toolbar}>
        <span className={css.title}>🌍 好友地区分布</span>
        <div className={css.breadcrumb}>
          <button type="button" className={css.crumb} onClick={goWorld}>世界</button>
          {path.map((n, i) => (
            <span key={n.key} className={css.crumbSeg}>
              <span className={css.crumbSep}>›</span>
              <button type="button" className={css.crumb} onClick={() => { setPath(path.slice(0, i + 1)); setHoverCity(null) }}>{n.name}</button>
            </span>
          ))}
        </div>
        {onWorldMap && showWorldSvg && (
          <span className={css.viewCtrls}>
            <button type="button" className={css.back} onClick={focusChina}>聚焦中国</button>
            <button type="button" className={css.back} onClick={resetView}>重置</button>
          </span>
        )}
        <span className={css.meta}>共 {map?.total ?? 0} 位好友有地区{map && map.unknown > 0 ? ` · ${map.unknown} 位未填地区` : ''}</span>
      </div>

      {error && <div className={css.error}>{error}</div>}
      {!map && !error && <div className={css.loading}>正在解析好友地区…</div>}

      {map && showGeoMap && (
        <div className={css.stage}>
          <FriendAvatarRail side="left" friends={leftFriends} avatars={avatars} />
          <div
            ref={mapRef}
            className={css.map}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerLeave={onPointerUp}
          >
            <svg className={css.mapSvg} viewBox={`0 0 ${MAP_W} ${MAP_H}`} preserveAspectRatio="none" aria-hidden="true">
              <defs>
                {/* 渐变 stop 的颜色与透明度交给 CSS 类（第 94 轮从行内样式搬来）：
                    声明里仍然用 var(--nm-cyan)，所以浅色主题下同样跟随令牌 ——
                    原来写行内样式的理由是「内联 style 是真正的 CSS 声明、var() 能解析到令牌」，
                    这一点对 CSS 类同样成立，而且不必把布局写进 TSX。 */}
                <radialGradient id="ov-land" cx="50%" cy="40%" r="75%">
                  <stop offset="0%" className={css.wmGradLand0} />
                  <stop offset="100%" className={css.wmGradLand1} />
                </radialGradient>
                <radialGradient id="ov-glow" cx="32%" cy="26%" r="80%">
                  <stop offset="0%" className={css.wmGradGlow0} />
                  <stop offset="100%" className={css.wmGradGlow1} />
                </radialGradient>
              </defs>
              <g transform={`translate(${view.tx} ${view.ty}) scale(${view.k})`}>
                {graticule.map((l, i) => (
                  <line key={i} className={css.grat} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} />
                ))}
                {backdropPaths.map((d, i) => (
                  <path key={i} className={css.land} fill="url(#ov-land)" d={d} />
                ))}
              </g>
              <rect className={css.mapGlow} width={MAP_W} height={MAP_H} fill="url(#ov-glow)" />
            </svg>

            {located.map(({ node, center }) => {
              const c = center as NonNullable<typeof center>
              const px = projectView(c[0], c[1])
              const ratio = node.count / geoMax
              const r = 7 + 13 * Math.sqrt(ratio)
              const ripple = geoRipple.has(node.key)
              return (
                <button
                  key={node.key}
                  type="button"
                  className={css.mapMarker}
                  style={{ left: px.x, top: px.y, width: r * 2, height: r * 2 }}
                  onPointerDown={(e) => { e.stopPropagation() }}
                  onMouseEnter={() => { setHoverRegion({ node, x: px.x, y: px.y }) }}
                  onMouseLeave={() => { setHoverRegion(null) }}
                  onClick={() => { zoomInto(node) }}
                  title={`${node.name} · ${node.count} 位好友`}
                >
                  {ripple && <span className={css.mapRipple} />}
                  <span className={css.mapDot} style={{ '--dot-color': densityColor(ratio) } as React.CSSProperties} />
                  {ripple && <span className={css.mapName}>{node.name}</span>}
                  {ripple && <span className={css.mapCount}>{node.count}</span>}
                </button>
              )
            })}

            {hoverRegion && (
              <div
                className={css.mapTip}
                style={{
                  left: hoverRegion.x,
                  top: hoverRegion.y,
                  transform: hoverRegion.x > mapSize.w - 190 ? 'translate(calc(-100% - 14px), -50%)' : 'translate(14px, -50%)',
                }}
              >
                <div className={css.mapTipHd}>{hoverRegion.node.name}<span>{hoverRegion.node.count} 位好友</span></div>
                <div className={css.mapTipBody}>
                  {hoverRegion.node.children.slice(0, 3).map(p => (
                    <span key={p.key} className={css.mapTipRow}>{p.name} {p.count}</span>
                  ))}
                </div>
                <div className={css.mapTipHint}>点击下钻查看下一级</div>
              </div>
            )}

            {located.length === 0 && (
              <div className={css.mapEmpty}>没有可定位的地区数据</div>
            )}

            <div className={css.mapLegend}>
              <span className={css.legendTitle}>好友数</span>
              <span className={css.legendSwatch} style={{ background: densityColor(0) }} />
              <span className={css.legendBar} />
              <span className={css.legendSwatch} style={{ background: densityColor(1) }} />
              <span className={css.legendHint}>滚轮缩放 · 拖拽平移</span>
            </div>
            {path.length > 0 && (
              <button type="button" className={css.backOverlay} onClick={goUp}>← 上一级</button>
            )}
          </div>
          <FriendAvatarRail side="right" friends={rightFriends} avatars={avatars} />
        </div>
      )}

      {map && showWorldEcharts && (
        <div className={css.stage}>
          <FriendAvatarRail side="left" friends={leftFriends} avatars={avatars} />
          <GeoEchartsMap
            node={map.world}
            mapName="world"
            urls={WORLD_GEO_URLS}
            geo={worldGeo.data}
            featureName={worldFeatureName}
            featureLabel={worldFeatureName}
            childByKey={key => worldChildByName(map.world.children, key)}
            onDrill={zoomInto}
            onFallback={fallbackWorldEcharts}
          />
          <div className={css.mapHint}>滚轮缩放 · 拖拽平移 · 点击国家下钻</div>
          <FriendAvatarRail side="right" friends={rightFriends} avatars={avatars} />
        </div>
      )}

      {map && showChinaEcharts && (
        <div className={css.stage}>
          <FriendAvatarRail side="left" friends={leftFriends} avatars={avatars} />
          <ChinaMap
            node={focused}
            onDrill={zoomInto}
            onFallback={() => { setChinaFallback(true) }}
            overlay={path.length > 0 ? (
              <button type="button" className={css.backOverlay} onClick={goUp}>← 上一级</button>
            ) : null}
          />
          <FriendAvatarRail side="right" friends={rightFriends} avatars={avatars} />
        </div>
      )}

      {map && showProvinceMap && provinceNode && provinceAd && (
        <div className={css.stage}>
          <FriendAvatarRail side="left" friends={leftFriends} avatars={avatars} />
          <ProvinceMap
            node={provinceNode}
            adcode={provinceAd}
            onDrill={openCity}
            onFallback={() => { setProvinceFallback(true) }}
            overlay={path.length > 0 ? (
              <button type="button" className={css.backOverlay} onClick={goUp}>← 上一级</button>
            ) : null}
          />
          <div className={css.mapHint}>滚轮缩放 · 拖拽平移 · 点击城市查看好友</div>
          <FriendAvatarRail side="right" friends={rightFriends} avatars={avatars} />
        </div>
      )}

      {map && showCityMap && cityNode && cityProvinceAd && (
        <div className={css.stage}>
          <FriendAvatarRail side="left" friends={leftFriends} avatars={avatars} />
          <CityMap
            node={cityNode}
            provinceAdcode={cityProvinceAd}
            onFallback={() => { setCityFallback(true) }}
            overlay={path.length > 0 ? (
              <button type="button" className={css.backOverlay} onClick={goUp}>← 上一级</button>
            ) : null}
          />
          <div className={css.mapHint}>滚轮缩放 · 拖拽平移 · 点击区县查看好友</div>
          <FriendAvatarRail side="right" friends={rightFriends} avatars={avatars} />
        </div>
      )}

      {map && showTreemap && (
        <div className={css.stage}>
          <FriendAvatarRail side="left" friends={leftFriends} avatars={avatars} />
          {children.length > 0 && (
            <div ref={canvasRef} className={css.canvas}>
              {slots.map((s) => {
                const isLeaf = s.node.children.length === 0
                const isHovered = hoverCity?.key === s.node.key
                return (
                  <button
                    key={s.node.key}
                    type="button"
                    className={css.cell}
                    data-leaf={isLeaf || undefined}
                    data-hovered={isHovered || undefined}
                    style={{ left: s.x, top: s.y, width: s.w, height: s.h }}
                    onMouseEnter={() => { if (isLeaf) setHoverCity(s.node) }}
                    onClick={() => { if (!isLeaf) zoomInto(s.node) }}
                    title={`${s.node.name} · ${s.node.count} 位好友`}
                  >
                    <span className={css.cellName}>{s.node.name}</span>
                    <span className={css.cellCount}>{s.node.count}</span>
                  </button>
                )
              })}
              {slots.length === 0 && box.w > 0 && <div className={css.empty}>没有子板块</div>}
              {path.length > 0 && (
                <button type="button" className={css.backOverlay} onClick={goUp}>← 上一级</button>
              )}
            </div>
          )}
          {children.length === 0 && !hoverCity && <div className={css.empty}>没有子板块</div>}

          {hoverCity && hoverCity.friends.length > 0 && (
            <div className={css.friends}>
              <div className={css.friendsHd}>
                <span>{hoverCity.name}</span>
                <span className={css.friendsCount}>{hoverCity.friends.length} 位好友</span>
              </div>
              <div className={css.friendGrid}>
                {hoverCity.friends.map(f => (
                  <div key={f.username} className={css.friend} title={`${friendName(f)}\n${f.username}`}>
                    <span className={css.avatarWrap}>
                      {avatars[f.username] ? (
                        <img className={css.avatar} src={avatars[f.username]} alt="" loading="lazy" referrerPolicy="no-referrer" />
                      ) : (
                        <span className={css.avatarFallback}>{friendName(f).slice(0, 1)}</span>
                      )}
                    </span>
                    <span className={css.friendLabel}>{friendName(f)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {children.length === 0 && path.length > 0 && (
            <button type="button" className={css.backOverlay} onClick={goUp}>← 上一级</button>
          )}
          <FriendAvatarRail side="right" friends={rightFriends} avatars={avatars} />
        </div>
      )}
    </div>
  )
}




