/**
 * 地图 GeoJSON 简化脚本（2026-10-17）。
 *
 * 目的：把 DataV / jsDelivr 的原始 GeoJSON 压到能随包分发的体积。
 * 手段：① Douglas-Peucker 顶点抽稀（容差按经纬度度数）；② 坐标精度截断。
 *
 * 用法：node scripts/simplify-geo.mjs <输入> <输出> [容差=0.01] [精度=3]
 */
import { readFileSync, writeFileSync } from 'node:fs'

/** 点到线段的垂直距离平方（经纬度平面近似，够用）。 */
function distSq(p, a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  if (dx === 0 && dy === 0) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)
  t = Math.max(0, Math.min(1, t))
  const px = a[0] + t * dx
  const py = a[1] + t * dy
  return (p[0] - px) ** 2 + (p[1] - py) ** 2
}

/** Douglas-Peucker 抽稀。 */
function simplifyLine(pts, tol) {
  if (pts.length <= 2) return pts
  const tolSq = tol * tol
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  while (stack.length > 0) {
    const [s, e] = stack.pop()
    let maxD = 0
    let idx = -1
    for (let i = s + 1; i < e; i++) {
      const d = distSq(pts[i], pts[s], pts[e])
      if (d > maxD) { maxD = d; idx = i }
    }
    if (maxD > tolSq && idx > 0) {
      keep[idx] = 1
      stack.push([s, idx], [idx, e])
    }
  }
  const out = []
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(pts[i])
  return out
}

/** 递归处理任意嵌套的坐标数组。 */
function simplifyCoords(c, tol, prec) {
  if (typeof c[0] === 'number') {
    return [Number(c[0].toFixed(prec)), Number(c[1].toFixed(prec))]
  }
  // 判断这一层是不是「点数组」（元素是 [num, num]）
  if (Array.isArray(c[0]) && typeof c[0][0] === 'number') {
    const simplified = simplifyLine(c, tol)
    return simplified.map(p => [Number(p[0].toFixed(prec)), Number(p[1].toFixed(prec))])
  }
  return c.map(x => simplifyCoords(x, tol, prec))
}

const [, , input, output, tolArg, precArg] = process.argv
if (!input || !output) {
  console.error('用法: node scripts/simplify-geo.mjs <输入> <输出> [容差=0.01] [精度=3]')
  process.exit(1)
}
const tol = Number(tolArg ?? 0.01)
const prec = Number(precArg ?? 3)

const raw = readFileSync(input, 'utf8')
const data = JSON.parse(raw)
let before = 0
let after = 0

for (const f of data.features ?? []) {
  const g = f.geometry
  if (!g?.coordinates) continue
  const countPts = (c) => (typeof c[0] === 'number' ? 1 : c.reduce((n, x) => n + countPts(x), 0))
  before += countPts(g.coordinates)
  g.coordinates = simplifyCoords(g.coordinates, tol, prec)
  after += countPts(g.coordinates)
}

const out = JSON.stringify(data)
writeFileSync(output, out, 'utf8')
console.log(`${input} → ${output}`)
console.log(`  顶点 ${before} → ${after} (${((1 - after / before) * 100).toFixed(0)}% 减少)`)
console.log(`  体积 ${(raw.length / 1024).toFixed(0)} KB → ${(out.length / 1024).toFixed(0)} KB (${((1 - out.length / raw.length) * 100).toFixed(0)}% 压缩)`)
