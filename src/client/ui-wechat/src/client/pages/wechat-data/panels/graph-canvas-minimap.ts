import { communityColor } from './graph-model.ts'
import type { Scene } from './graph-canvas.ts'
import type { MiniTransform } from './graph-canvas-support.ts'

/**
 * 把全部坐标按比例缩进右下角的小画布，并画出当前视口矩形。
 *
 * 返回 `null` 表示这一帧没有可用的节点坐标；调用方应保留上一份有效变换。
 */
export function drawGraphMinimap(
  canvas: HTMLCanvasElement | null,
  dpr: number,
  scene: Scene,
): MiniTransform | null {
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return null
  const width = canvas.width / dpr
  const height = canvas.height / dpr
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const nodes = scene.nodes
  if (nodes.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    const point = scene.positions.get(node.id)
    if (!point) continue
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }
  if (!Number.isFinite(minX)) return null
  const pad = 6
  const spanX = Math.max(1e-6, maxX - minX)
  const spanY = Math.max(1e-6, maxY - minY)
  const scale = Math.min((width - pad * 2) / spanX, (height - pad * 2) / spanY)
  const offsetX = pad + (width - pad * 2 - spanX * scale) / 2
  const offsetY = pad + (height - pad * 2 - spanY * scale) / 2
  const px = (x: number): number => offsetX + (x - minX) * scale
  const py = (y: number): number => offsetY + (y - minY) * scale

  ctx.globalAlpha = 0.8
  for (const node of nodes) {
    const point = scene.positions.get(node.id)
    if (!point) continue
    ctx.beginPath()
    ctx.arc(
      px(point.x),
      py(point.y),
      Math.max(1, Math.min(3, (scene.radii.get(node.id) ?? 8) * scale)),
      0,
      Math.PI * 2,
    )
    ctx.fillStyle = node.community >= 0 ? communityColor(node.community) : 'rgba(150,160,180,0.7)'
    ctx.fill()
  }
  ctx.globalAlpha = 1

  const camera = scene.camera
  const halfWidth = scene.size.w / 2 / camera.k
  const halfHeight = scene.size.h / 2 / camera.k
  ctx.strokeStyle = 'rgba(34,211,238,0.85)'
  ctx.lineWidth = 1
  ctx.strokeRect(
    px(camera.x - halfWidth),
    py(camera.y - halfHeight),
    halfWidth * 2 * scale,
    halfHeight * 2 * scale,
  )
  return { minX, minY, s: scale, ox: offsetX, oy: offsetY }
}
