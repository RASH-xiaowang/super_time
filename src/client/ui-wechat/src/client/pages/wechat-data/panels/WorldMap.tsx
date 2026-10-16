/**
 * friend 地区世界地图.
 *
 * 世界层有两种视图：联网时优先用 ECharts 渲染真实世界地理地图（中文国名 GeoJSON，
 * 按好友数分级填色、悬停提示、点击国家下钻）；GeoJSON 不可达或用户切换后回退到
 * 自绘的等距圆柱 SVG 世界地图（粗略大陆剪影 + 涟漪标记）。下钻到「中国」时按省份
 * 渲染 ECharts 中国地图（与同类下钻示例一致的交互），省份点击后再落到省/市的
 * 方块图。其它国家/城市的下钻仍用空间叙利化的方块图（treemap），悬停城市块在旁展示
 * 好友头像与标签。支持鼠标滚轮缩放、拖拽平移，以及「聚焦中国」／「重置视图」。
 *
 * 2026-09-28：世界层**固定为 2D 平面视图**（用户要求移除全部 3D / 倾斜 / 透视交互）。
 * 曾经的等距立体渲染器（WorldIsoMap + world-iso 系列）已整套删除，源码里不许再出现。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ErrorState } from '../ui/kit.tsx'
import { apiGetAvatarsLocal } from '../api.ts'
import { useElapsedSeconds, useWechatDataUpdated } from './hooks.tsx'
import {
  REGION_MAP_TIMEOUT_TEXT,
  fetchRegionMapBounded,
  hasCachedRegionMap,
  initialRegionMap,
  rememberRegionMap,
} from './world-map-region-load.ts'
import type { RegionFriend, RegionMapSnapshot, RegionNode } from '@deepseek-ai/dsh-wechat-data/types'
import { squarify } from './treemap.ts'
import { ChinaMap } from './ChinaMap.tsx'
import { CityMap } from './CityMap.tsx'
import { FriendAvatarRail } from './FriendAvatarRail.tsx'
import { MapStage } from './MapStage.tsx'
import { TreemapStage } from './TreemapStage.tsx'
import { GeoEchartsMap } from './GeoEchartsMap.tsx'
import { ProvinceMap } from './ProvinceMap.tsx'
import { WORLD_GEO_URLS, fetchFirstJson, worldChildByName, worldFeatureName } from './world-map-data.ts'
import { collectSubtreeFriends } from './region-friends.ts'
import {
  provinceAdcode,
} from './world-geo.ts'
import css from './world-map.module.css'

/** Pick the display name for a friend. */
function friendName(f: RegionFriend): string {
  return f.displayName || f.remark || f.nickName
}

/**
 * 地区数据加载态（外提，2026-09-28）。
 *
 * 两个理由：① `WorldMapPanel` 的函数体已被 `function-size-ratchet.spec.ts` 登记
 * （棘轮只许变小），这块 UI 放回去会顶破它；② 加载态自己带一个"走秒 → 出现重试"
 * 的小状态机，独立出来才讲得清。
 *
 * 为什么要重试按钮：后端同步串行，这一次 RPC 可能排在长任务后面几十秒。
 * 文案让用户"点重试"，就必须真有东西可点（见 `world-map-region-load.ts` 的说明）。
 * @param props.elapsed - 已等待秒数（U2 约定：加载态要能自证在动）。
 * @param props.onRetry - 手动重取一次。
 * @returns 加载态元素。
 */
function RegionLoading({ elapsed, onRetry }: { elapsed: number; onRetry: () => void }): React.JSX.Element {
  return (
    <div className={css.loading}>
      {`正在解析好友地区…已用 ${elapsed}s · 后端按顺序处理请求，若有长任务在跑这一块要排在它后面，请稍候`}
      {elapsed >= 3 && <button type="button" className={css.retry} onClick={onRetry}>重试</button>}
    </div>
  )
}

/** One layout slot (item + rect) owned by the component. */
interface Slot {
  node: RegionNode
  x: number
  y: number
  w: number
  h: number
}

/**
 * 地区数据未就绪时的**空世界节点**：ECharts 只据此画底图、不着色。
 * 有了它，世界层就不必等 `getRegionMap()` 才肯画地图（用户明确要求「先渲染世界地图」）。
 */
const EMPTY_WORLD: RegionNode = { key: 'world', name: '世界', count: 0, children: [], friends: [] }

/**
 * Render the world-region map.
 * @returns the world-map element tree.
 */
export function WorldMapPanel(): React.JSX.Element {
  // 首屏渲染缓存（P2-5）：上次成功渲染过的地区快照**同步**取回 ⇒ 再进这一页立刻就有数据，
  // 不必再排一次后端队列。取数策略（有界等待 / 缓存键 / 超时文案）都在
  // `world-map-region-load.ts` —— 外提是为了不再撑大本组件的函数体（见该文件头注）。
  const [map, setMap] = useState<RegionMapSnapshot | null>(initialRegionMap)
  const [error, setError] = useState<string | null>(null)
  // Drill path: [] = world map; [country]; [country, province].
  const [path, setPath] = useState<RegionNode[]>([])
  // Hovered leaf city (friends shown beside) within the treemap.
  const [hoverCity, setHoverCity] = useState<RegionNode | null>(null)
  const [avatars, setAvatars] = useState<Record<string, string>>({})
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [chinaFallback, setChinaFallback] = useState(false)
  const [provinceFallback, setProvinceFallback] = useState(false)
  const [cityFallback, setCityFallback] = useState(false)
  const [worldGeo, setWorldGeo] = useState<{ ok: true; data: unknown } | { ok: false } | null>(null)
  const worldGeoRef = useRef<{ ok: true; data: unknown } | { ok: false } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    setError(null)
    const r = await fetchRegionMapBounded()
    if (r.kind === 'ok') { setMap(r.map); rememberRegionMap(r.map); return }
    if (r.kind === 'error') { setError(r.message); return }
    // 超时：已经有旧快照时不要用错误盖掉它 —— 那是可用的数据，不是失败。
    if (!hasCachedRegionMap()) setError(REGION_MAP_TIMEOUT_TEXT)
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
  // **不等地区数据**（2026-09-26：用户要求「先渲染世界地图」+ 地理 SVG 已移除）。
  // GeoJSON 一到就先画**真地图底图**，好友地区着色随后叠加（数据未就绪时传空世界节点）。
  // 原先这里要求 `map !== null`，是为了绕开「切到 ECharts 但 `map` 那一路被挡住 ⇒ 两边都不画」；
  // 现在空节点由 `GeoEchartsMap` 自己吃得下，那个约束连同 SVG 回退一起撤掉了。
  const showWorldEcharts = worldEchartsReady
  // 底图拉不到（未联网 / 镜像源不可达）时给一句明确说明，而不是留一片空白。
  const geoTilesBlocked = onWorldMap && worldGeo?.ok === false
  // The ECharts map is the default China view; it falls back to the SVG map when offline.
  const showChinaEcharts = chinaMode && !chinaFallback
  // 2026-09-28：世界层回到 **2D 平面 ECharts 地图**（用户要求移除 3D 与倾斜/透视）。
  // 非中国的国家层仍走 treemap 承接 —— 2D 地图上没有"推近动画"，留在地图上没有意义，
  // 而方块图能直接把该国的城市好友摊开看（下方榜单也同一口径）。
  // Everything else (cities, unknown provinces, China-fallback) uses the squarified treemap.
  const showTreemap = !onWorldMap && (!chinaMode || chinaFallback) && !showProvinceMap && !showCityMap

  const children = focused?.children ?? []

  // Contacts of the whole current subtree, split across the two side rails.
  // 每侧 4 列；栏内可滚动查看全部好友。
  const levelFriends = useMemo(() => collectSubtreeFriends(onWorldMap ? map?.world : focused), [onWorldMap, map, focused])
  const halfFriends = Math.ceil(levelFriends.length / 2)
  const leftFriends = levelFriends.slice(0, halfFriends)
  const rightFriends = levelFriends.slice(halfFriends)

  // Probe the world GeoJSON once per session visit (kept in a ref so a fetch
  // failure does not retry in a loop); the map shows an empty base until ready.
  useEffect(() => {
    // 只有世界层要底图；下钻后由中国/省/市各自的取数口负责。
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

  // 换数据源 / 换会话时清掉各层的「ECharts 起不来」标记，让它们重新试一次真地图。
  useEffect(() => {
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
  // railKey 原先在渲染里现算：好友上千时每次渲染都要 concat+map+**全量排序**+join，
  // 而它只取决于当前子树的好友集合（`levelFriends` 已经是 useMemo 的产物），
  // 换算成 memo 后只有子树变化时才重算（L9）。等价性：left/right 是同一个数组的
  // 前半/后半，concat 出来与 levelFriends 同序同样的元素。
  const railKey = useMemo(() => levelFriends.map(f => f.username).sort().join('|'), [levelFriends])
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

  const goUp = (): void => {
    setPath(p => p.slice(0, Math.max(0, p.length - 1)))
    setHoverCity(null)
  }

  const zoomInto = (node: RegionNode): void => {
    setPath(p => [...p, node])
    setHoverCity(null)
  }

  const goWorld = (): void => {
    setPath([])
    setHoverCity(null)
  }

  /** 世界层 ECharts 起不来时标记「底图不可用」（地理 SVG 已移除，只能给提示）。 */
  const fallbackWorldEcharts = (): void => {
    worldGeoRef.current = { ok: false }
    setWorldGeo({ ok: false })
  }

  // 首屏加载走秒（U2 约定，口径见 hooks.tsx#useElapsedSeconds）。后端是同步队列：
  // 排在长任务后面时这块地区数据可能要等几十秒，一句静止的「正在解析…」会被当成卡死
  // （2026-09-26 用户实测反馈的原话就是「世界地图还是这样，一直在加载中」）。
  const regionLoading = map === null && error === null
  const regionElapsed = useElapsedSeconds(regionLoading)

  /** Drill from a province map into a city and immediately show its friends. */
  const openCity = (node: RegionNode): void => {
    setPath(p => [...p, node])
    setHoverCity(node)
  }

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
        <span className={css.meta}>共 {map?.total ?? 0} 位好友有地区{map && map.unknown > 0 ? ` · ${map.unknown} 位未填地区` : ''}</span>
      </div>

      {error && <ErrorState message={error} />}
      {/* 加载态只在**还没有任何数据**时出现：有首屏缓存时 map 非 null，
          这时安静地后台刷新即可，不该再对用户喊「正在解析…」。 */}
      {regionLoading && <RegionLoading elapsed={regionElapsed} onRetry={() => { void load() }} />}

      {showWorldEcharts && (
        <MapStage
          leftFriends={leftFriends}
          rightFriends={rightFriends}
          avatars={avatars}
          hint="滚轮缩放 · 拖拽平移 · 点击国家下钻"
        >
          <GeoEchartsMap
            node={map?.world ?? EMPTY_WORLD}
            mapName="world"
            urls={WORLD_GEO_URLS}
            geo={worldGeo.data}
            featureName={worldFeatureName}
            featureLabel={worldFeatureName}
            childByKey={key => worldChildByName(map?.world.children ?? [], key)}
            onDrill={zoomInto}
            onFallback={fallbackWorldEcharts}
          />
        </MapStage>
      )}

      {geoTilesBlocked && (
        <div className={css.stage}>
          <div className={css.mapEmpty}>
            地图底图不可用：当前无法从镜像源取到行政区划数据（应用内已无底图开关）。
            好友地区数据仍可通过下方的省份 / 城市榜单查看。
          </div>
        </div>
      )}

      {map && showChinaEcharts && (
        <MapStage leftFriends={leftFriends} rightFriends={rightFriends} avatars={avatars}>
          <ChinaMap
            node={focused}
            onDrill={zoomInto}
            onFallback={() => { setChinaFallback(true) }}
            overlay={path.length > 0 ? (
              <button type="button" className={css.backOverlay} onClick={goUp}>← 上一级</button>
            ) : null}
          />
        </MapStage>
      )}

      {map && showProvinceMap && provinceNode && provinceAd && (
        <MapStage
          leftFriends={leftFriends}
          rightFriends={rightFriends}
          avatars={avatars}
          hint="滚轮缩放 · 拖拽平移 · 点击城市查看好友"
        >
          <ProvinceMap
            node={provinceNode}
            adcode={provinceAd}
            onDrill={openCity}
            onFallback={() => { setProvinceFallback(true) }}
            overlay={path.length > 0 ? (
              <button type="button" className={css.backOverlay} onClick={goUp}>← 上一级</button>
            ) : null}
          />
        </MapStage>
      )}

      {map && showCityMap && cityNode && cityProvinceAd && (
        <MapStage
          leftFriends={leftFriends}
          rightFriends={rightFriends}
          avatars={avatars}
          hint="滚轮缩放 · 拖拽平移 · 点击区县查看好友"
        >
          <CityMap
            node={cityNode}
            provinceAdcode={cityProvinceAd}
            onFallback={() => { setCityFallback(true) }}
            overlay={path.length > 0 ? (
              <button type="button" className={css.backOverlay} onClick={goUp}>← 上一级</button>
            ) : null}
          />
        </MapStage>
      )}

      {map && showTreemap && (
        <TreemapStage
          canvasRef={canvasRef}
          children={children}
          slots={slots}
          measured={box.w > 0}
          hoverCity={hoverCity}
          canGoUp={path.length > 0}
          onDrill={zoomInto}
          onHover={setHoverCity}
          onGoUp={goUp}
          leftFriends={leftFriends}
          rightFriends={rightFriends}
          avatars={avatars}
          nameOf={friendName}
        />
      )}
    </div>
  )
}




