/**
 * 等距立体世界地图的**绘制层**（2026-09-27）：一层 canvas 活儿，从 `WorldIsoMap` 里拆出来。
 *
 * 为什么拆：`WorldIsoMap` 一旦把"取数 / 交互 / 绘制"三件事都端在手里就冲过 250 行，
 * 撞上 `function-size-ratchet`（那条闸门的要求就是"要么现在拆，要么写清为什么留着"）。
 * 拆法按职责切：**这个文件只认识几何与颜色**，不认识 props、不认识 React、不认识取数；
 * 光晕/底板/网格/柱体这些"画什么"的决定全在这里，改视觉不用碰组件的状态机。
 *
 * 画序（从后往前）：地面光晕 → 等距网格 → 底板 → 土地面 → 柱体（先侧后顶）→ 悬停由 alpha 提亮。
 *
 * @module world-iso-draw
 */

import { tokenColor } from '../utils/theme-color.ts'
import {
  ISO_TILT, type IsoCam, type IsoColumn, type IsoFeature, type IsoView, columnFaces, isoColumns, projectLonLat,
} from './world-iso.ts'

/** `rgb()/rgba()` 或 `#rgb/#rrggbb` → 三个通道；解不出来返回 null。 */
export function rgbOf(color: string): [number, number, number] | null {
  const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i.exec(color)
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  const h = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (h?.[1]) {
    const v = Number.parseInt(h[1], 16)
    return [(v >> 16) & 255, (v >> 8) & 255, v & 255]
  }
  return null
}

/**
 * 画一帧（清屏 + 全场景）。调用方负责 canvas 尺寸与 DPR。
 * @returns 本次画出的柱体（调用方拿去命中判定，别自己在事件里重算一遍）。
 */
export function drawIsoScene(
  ctx: CanvasRenderingContext2D,
  opts: {
    features: readonly IsoFeature[]
    size: IsoView
    cam: IsoCam
    /** 当前悬停的要素名（提亮它）。 */
    hoverName: string
    /** 名字 → 好友数（没有就是 0）。 */
    countOf: (name: string) => number
  },
): IsoColumn[] {
  const { features, size, cam, hoverName, countOf } = opts
  ctx.clearRect(0, 0, size.w, size.h)

  const cyan = rgbOf(tokenColor('--nm-cyan', 1, '#3ad6ff')) ?? [58, 214, 255]
  const purple = rgbOf(tokenColor('--nm-purple', 1, '#d072ff')) ?? [208, 114, 255]
  const land = tokenColor('--nm-map-land', 1, '#0b2a33')
  const landEdge = tokenColor('--nm-cyan', 0.35, 'rgba(58,214,255,0.35)')
  const mix = (a: number, b: number, t: number): number => Math.round(a + (b - a) * t)

  // ① 地面光晕：把"板子浮在光上"画出来（看不见，但少了整块就塌）
  const floor = ctx.createRadialGradient(size.w / 2, size.h * 0.58, 0, size.w / 2, size.h * 0.58, size.w * 0.5)
  floor.addColorStop(0, 'rgba(90,200,255,0.2)')
  floor.addColorStop(0.55, 'rgba(130,100,255,0.09)')
  floor.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = floor
  ctx.fillRect(0, 0, size.w, size.h)

  // ② 等距网格地面：两条斜线族铺在"地面"上（立体感一半来自它）
  ctx.save()
  ctx.strokeStyle = 'rgba(120,200,255,0.09)'
  ctx.lineWidth = 0.7
  const gx = 46
  ctx.beginPath()
  for (let x = -size.h; x < size.w + size.h; x += gx) {
    ctx.moveTo(x, size.h * 0.96)
    ctx.lineTo(x + size.h * 0.62, size.h * 0.96 - size.h * 0.62 * (1 - ISO_TILT) - size.h * 0.6)
    ctx.moveTo(x + size.h * 0.62, size.h * 0.96)
    ctx.lineTo(x, size.h * 0.96 - size.h * 0.62 * (1 - ISO_TILT) - size.h * 0.6)
  }
  ctx.stroke()
  ctx.restore()

  // ③ 底板：世界 bbox 投影出来就是一个平行四边形 —— 把它当"托着地图的那块板"
  const corners = [
    projectLonLat(-180, 90, size, cam), projectLonLat(180, 90, size, cam),
    projectLonLat(180, -90, size, cam), projectLonLat(-180, -90, size, cam),
  ]
  const pad = 12
  ctx.save()
  ctx.beginPath()
  ctx.moveTo(corners[0]!.x - pad, corners[0]!.y - pad)
  ctx.lineTo(corners[1]!.x + pad, corners[1]!.y - pad)
  ctx.lineTo(corners[2]!.x + pad, corners[2]!.y + pad)
  ctx.lineTo(corners[3]!.x - pad, corners[3]!.y + pad)
  ctx.closePath()
  const slab = ctx.createLinearGradient(0, corners[0]!.y - pad, 0, corners[2]!.y + pad)
  slab.addColorStop(0, 'rgba(70,180,255,0.16)')
  slab.addColorStop(0.5, 'rgba(40,90,190,0.1)')
  slab.addColorStop(1, 'rgba(120,80,255,0.14)')
  ctx.fillStyle = slab
  ctx.fill()
  ctx.strokeStyle = 'rgba(120,215,255,0.34)'
  ctx.lineWidth = 1
  ctx.stroke()
  // 上沿再压一道亮线：像板子被顶光打到的边
  ctx.beginPath()
  ctx.moveTo(corners[0]!.x - pad, corners[0]!.y - pad)
  ctx.lineTo(corners[1]!.x + pad, corners[1]!.y - pad)
  ctx.strokeStyle = 'rgba(190,240,255,0.6)'
  ctx.lineWidth = 1.4
  ctx.stroke()
  ctx.restore()

  // ④ 土地面：暗底 + 双描边（宽而淡 + 细而亮）
  ctx.lineJoin = 'round'
  for (const f of features) {
    ctx.beginPath()
    for (const ring of f.rings) {
      // 取二分之一点数即可：世界尺度下省下的点看不出，但交互帧率差很多
      const n = Math.max(2, Math.floor(ring.length / 2))
      const step = Math.max(1, Math.floor(ring.length / n))
      let started = false
      for (let i = 0; i < ring.length; i += step) {
        const p = ring[i]
        if (!p || typeof p[0] !== 'number' || typeof p[1] !== 'number') continue
        const { x, y } = projectLonLat(p[0], p[1], size, cam)
        if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
      }
      ctx.closePath()
    }
    ctx.globalAlpha = f.name === hoverName ? 1 : 0.86
    ctx.fillStyle = land
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.strokeStyle = 'rgba(90,210,255,0.18)'
    ctx.lineWidth = 1.6
    ctx.stroke()
    ctx.strokeStyle = landEdge
    ctx.lineWidth = 0.7
    ctx.stroke()
  }

  // ⑤ 柱体：光晕 + 两个侧面（左暗右亮）+ 顶面
  const cols = isoColumns(features.map((f) => ({ name: f.name, anchor: f.center, count: countOf(f.name) })), size, cam)
  for (const c of cols) {
    const faces = columnFaces(c)
    const r = mix(cyan[0], purple[0], c.tone)
    const g = mix(cyan[1], purple[1], c.tone)
    const b = mix(cyan[2], purple[2], c.tone)
    const hot = c.name === hoverName
    ctx.save()
    ctx.shadowColor = `rgba(${String(r)},${String(g)},${String(b)},${hot ? '1' : '0.6'})`
    ctx.shadowBlur = (hot ? 28 : 17) * cam.k
    for (const [poly, shade] of [[faces.left, 0.5], [faces.right, 0.74]] as const) {
      ctx.beginPath()
      const first = poly[0] ?? [0, 0]
      ctx.moveTo(first[0], first[1])
      for (const p of poly.slice(1)) ctx.lineTo(p[0], p[1])
      ctx.closePath()
      ctx.fillStyle = `rgba(${String(Math.round(r * shade))},${String(Math.round(g * shade))},${String(Math.round(b * (shade + 0.06)))},0.94)`
      ctx.fill()
    }
    ctx.beginPath()
    const top0 = faces.top[0] ?? [0, 0]
    ctx.moveTo(top0[0], top0[1])
    for (const p of faces.top.slice(1)) ctx.lineTo(p[0], p[1])
    ctx.closePath()
    ctx.fillStyle = `rgba(${String(r)},${String(g)},${String(b)},1)`
    ctx.fill()
    ctx.restore()
  }
  return cols
}
