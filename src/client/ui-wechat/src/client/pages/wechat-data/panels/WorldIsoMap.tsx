/**
 * 世界层的**等距立体地图**（2026-09-27，按设计稿"立体 + 视觉冲击"改）。
 *
 * ## 与 `GeoEchartsMap` 的分工
 *
 * 世界层换成这套自绘渲染：土地面按 `ISO_TILT` 压扁成"平放的地图板"，每个有好友的国家
 * 拔起一根发光柱（高度 ∝ √好友数），柱底一圈光晕 —— 立体感与"哪里有人"一眼可读。
 * 省/市级下钻仍走 `GeoEchartsMap`（那边要 ECharts 的区县边界与下钻交互，自绘不划算）。
 *
 * ## 为什么不引 echarts-gl
 *
 * 本仓的 echarts 是 6.x，而 `echarts-gl` 的 `map3D` 停在 echarts 5 时代（且是独立大包）；
 * 换它要动依赖面 + 打包白名单 + 主题色两条链（`map3D` 还不认 CSS 变量）。这里用的是
 * **投影 + 柱体几何**，全在 `world-iso.ts` 里做成纯函数：能单测、能跟主题、零新依赖。
 *
 * ## 四条纪律
 *
 * · 底图仍然**受出网闸门管**：GeoJSON 走 `fetchFirstJson`（`world-map-data.ts`），
 *   拉不到就 `onFallback()` —— 与 ECharts 那条路一模一样，别在这里另开一条取数路；
 * · 空数据也要先画出**底图**（"先渲染世界地图"这条口径）：`node` 为空时柱体为 0，土地面照画；
 * · **回调进 ref、effect 只认值**：父组件每次渲染都会传新的箭头函数（`childByKey`/`onDrill`），
 *   把它们写进依赖会让取底图的 effect 每渲染重跑一遍；
 * · 不依赖 `ResizeObserver` 存在（jsdom 没有）：拿不到就按挂载那一刻的尺寸静态画一次。
 *
 * @module WorldIsoMap
 */

import { useEffect, useRef, useState } from 'react'
import type { RegionNode } from '@deepseek-ai/dsh-wechat-data/types'
import { fetchFirstJson, type WorldGeoFeature } from './world-map-data.ts'
import {
  IDENTITY_CAM, type IsoCam, type IsoColumn, type IsoFeature, type IsoView, type LonLat, type Ring,
  hitColumn, largestRing, ringBBox, ringCenter, unproject,
} from './world-iso.ts'
import { drawIsoScene } from './world-iso-draw.ts'
import css from './world-map.module.css'

interface GeoCollection { features?: WorldGeoFeature[] }

/** Props（与 `GeoEchartsMap` 对齐，父组件换渲染器时一行就够）。 */
export interface WorldIsoMapProps {
  node: RegionNode | null
  urls: readonly string[]
  geo?: unknown
  featureName: (feature: WorldGeoFeature) => string
  featureLabel: (feature: WorldGeoFeature) => string
  childByKey: (key: string) => RegionNode | null
  onDrill: (child: RegionNode) => void
  onFallback: () => void
  overlay?: React.JSX.Element | null
}

/** 从 GeoJSON 要素里抽出画得动的那份几何。 */
function parseFeatures(features: readonly WorldGeoFeature[], nameOf: (f: WorldGeoFeature) => string, labelOf: (f: WorldGeoFeature) => string): IsoFeature[] {
  const out: IsoFeature[] = []
  for (const f of features) {
    const name = nameOf(f)
    if (!name) continue
    const g = (f as { geometry?: { type?: string; coordinates?: unknown } }).geometry
    const rings: Ring[] = []
    if (g?.type === 'Polygon') {
      const first = (g.coordinates as Ring[] | undefined)?.[0]
      if (first) rings.push(first)
    } else if (g?.type === 'MultiPolygon') {
      for (const poly of (g.coordinates as Ring[][] | undefined) ?? []) {
        const first = poly?.[0]
        if (first) rings.push(first)
      }
    }
    if (rings.length === 0) continue
    const main = largestRing(rings)
    out.push({ name, label: labelOf(f), rings, center: ringCenter(main), bbox: main ? ringBBox(main) : null })
  }
  return out
}

/**
 * 渲染等距立体世界地图。
 * @param props - 见 `WorldIsoMapProps`。
 * @returns 地图容器。
 */
export function WorldIsoMap(props: WorldIsoMapProps): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [features, setFeatures] = useState<IsoFeature[]>([])
  const [size, setSize] = useState<IsoView>({ w: 0, h: 0 })
  const [cam, setCam] = useState<IsoCam>(IDENTITY_CAM)
  /** 悬停高亮是**画上去的**（不是 DOM），所以靠一个计数触发重画。 */
  const [tick, setTick] = useState(0)
  const [tip, setTip] = useState<{ x: number; y: number; name: string; count: number; top: string[] } | null>(null)
  /** 每帧算出的柱体：命中判定直接用它，别在 mousemove 里重算。 */
  const colsRef = useRef<IsoColumn[]>([])
  const dragRef = useRef<{ px: number; py: number; tx: number; ty: number } | null>(null)
  const hoverRef = useRef<string>('')

  // 回调进 ref：父组件每次渲染都传新箭头函数，写进依赖会让取底图那步每渲染重跑。
  const propsRef = useRef(props)
  propsRef.current = props
  const { geo, urls } = props

  // ① 取底图（同一个受闸门的取数口），失败即回退。
  useEffect(() => {
    let alive = true
    void (async () => {
      const p = propsRef.current
      try {
        const data = geo ?? (await fetchFirstJson(urls))
        if (!alive) return
        const list = ((data as GeoCollection)?.features ?? []).filter((f) => p.featureName(f) !== '')
        setFeatures(parseFeatures(list, p.featureName, p.featureLabel))
      } catch {
        if (alive) p.onFallback()
      }
    })()
    return () => { alive = false }
  }, [geo, urls])

  // ② 尺寸（拿不到 ResizeObserver 就量一次）。
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setSize({ w: Math.max(1, Math.round(r.width)), h: Math.max(1, Math.round(r.height)) })
    }
    measure()
    if (typeof ResizeObserver !== 'function') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [])

  // ③ 画：全场景交给 world-iso-draw（那一层只认识几何与颜色，见它的头注）。
  //    柱子是画出来的，命中判定要用的那份就从这里拿 —— 别在 mousemove 里重算。
  useEffect(() => {
    const el = canvasRef.current
    if (!el || size.w === 0 || size.h === 0) return
    const ctx = typeof el.getContext === 'function' ? el.getContext('2d') : null
    if (!ctx) return
    const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1)
    el.width = Math.round(size.w * dpr)
    el.height = Math.round(size.h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    colsRef.current = drawIsoScene(ctx, {
      features,
      size,
      cam,
      hoverName: hoverRef.current,
      countOf: (name) => propsRef.current.childByKey(name)?.count ?? 0,
    })
  }, [features, size, cam, tick])

  // ④ 交互：滚轮缩放（围着光标）、拖拽平移、悬停出提示、点击下钻。
  const localPoint = (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }
  const onMove = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const { x, y } = localPoint(e)
    const drag = dragRef.current
    if (drag) {
      setCam((c) => ({ ...c, tx: drag.tx + (x - drag.px), ty: drag.ty + (y - drag.py) }))
      return
    }
    const hit = colsRef.current.find((c) => hitColumn(c, x, y))
    // 柱体没中，就反投影回经纬度，用国家的 bbox 判归属（世界尺度够准，且比多边形求交便宜）
    const at = hit ? null : unproject(x, y, size, cam)
    const over = hit
      ? features.find((f) => f.name === hit.name) ?? null
      : (at === null ? null : features.find((f) => f.bbox !== null && at.lon >= f.bbox.minLon && at.lon <= f.bbox.maxLon && at.lat >= f.bbox.minLat && at.lat <= f.bbox.maxLat) ?? null)
    const name = hit?.name ?? over?.name ?? ''
    if (name !== hoverRef.current) { hoverRef.current = name; setTick((t) => t + 1) }
    const child = name === '' ? null : propsRef.current.childByKey(name)
    if (name === '') setTip(null)
    else {
      const top = (child?.children ?? []).slice().sort((a, b) => b.count - a.count).slice(0, 3).map((c) => `${c.name} ${String(c.count)}`)
      setTip({ x, y, name: over?.label ?? name, count: child?.count ?? 0, top })
    }
  }
  const onDown = (e: React.MouseEvent<HTMLCanvasElement>): void => {
    const { x, y } = localPoint(e)
    dragRef.current = { px: x, py: y, tx: cam.tx, ty: cam.ty }
  }
  const endDrag = (): void => { dragRef.current = null }
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>): void => {
    const { x, y } = localPoint(e)
    setCam((c) => {
      const k = Math.min(8, Math.max(1, c.k * Math.exp(-e.deltaY * 0.0015)))
      // 让光标下那个点不动：tx' = x − (x − tx)·(k'/k)（以视图中心为锚）
      const cx = size.w / 2
      const cy = size.h / 2
      return { k, tx: x - cx - ((x - cx - c.tx) * k) / c.k, ty: y - cy - ((y - cy - c.ty) * k) / c.k }
    })
  }
  const onClick = (): void => {
    const child = hoverRef.current === '' ? null : propsRef.current.childByKey(hoverRef.current)
    if (child) propsRef.current.onDrill(child)
  }

  return (
    <div ref={wrapRef} className={css.mapFrame}>
      <canvas
        ref={canvasRef}
        className={css.isoCanvas}
        onMouseMove={onMove}
        onMouseDown={onDown}
        onMouseUp={endDrag}
        onMouseLeave={() => { endDrag(); hoverRef.current = ''; setTick((t) => t + 1); setTip(null) }}
        onWheel={onWheel}
        onClick={onClick}
      />
      {tip && (
        <div className={css.isoTip} style={{ left: `${String(Math.round(tip.x + 12))}px`, top: `${String(Math.round(tip.y + 12))}px` }}>
          <b>{tip.name}</b>
          <span>{tip.count} 位好友</span>
          {tip.top.length > 0 && <em>{tip.top.join(' · ')}</em>}
        </div>
      )}
      {props.overlay}
    </div>
  )
}
