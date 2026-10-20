/**
 * 批量下载并简化下钻地图 GeoJSON（2026-10-17）。
 *
 * 层级：中国省级（100000_full）→ 各省（<省adcode>_full，含地级市）→ 各市（<市adcode>_full，含区县）。
 * 输出到 src/backend/wechat-data/resources/geo/drill/ 下，文件名 = adcode.json。
 *
 * 用法：node scripts/fetch-drill-geo.mjs [--level=province|city|all]
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT = 'src/backend/wechat-data/resources/geo/drill'
const TOL = 0.02
const PREC = 3
const CONCURRENCY = 6

function distSq(p, a, b) {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  if (dx === 0 && dy === 0) return (p[0] - a[0]) ** 2 + (p[1] - a[1]) ** 2
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)
  t = Math.max(0, Math.min(1, t))
  return (p[0] - (a[0] + t * dx)) ** 2 + (p[1] - (a[1] + t * dy)) ** 2
}

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

function simplifyCoords(c, tol, prec) {
  if (typeof c[0] === 'number') return [Number(c[0].toFixed(prec)), Number(c[1].toFixed(prec))]
  if (Array.isArray(c[0]) && typeof c[0][0] === 'number') {
    return simplifyLine(c, tol).map(p => [Number(p[0].toFixed(prec)), Number(p[1].toFixed(prec))])
  }
  return c.map(x => simplifyCoords(x, tol, prec))
}

function simplifyGeo(data) {
  for (const f of data.features ?? []) {
    const g = f.geometry
    if (!g?.coordinates) continue
    g.coordinates = simplifyCoords(g.coordinates, TOL, PREC)
  }
  return data
}

async function fetchGeo(code) {
  const url = `https://geo.datav.aliyun.com/areas_v3/bound/geojson?code=${code}_full`
  const res = await fetch(url, { headers: { 'User-Agent': 'super-time/1.0' } })
  if (!res.ok) throw new Error(`http ${res.status}`)
  return await res.json()
}

async function saveOne(code) {
  const file = join(OUT, `${code}.json`)
  if (existsSync(file)) return { code, skipped: true }
  try {
    const raw = await fetchGeo(code)
    const simplified = simplifyGeo(raw)
    const out = JSON.stringify(simplified)
    writeFileSync(file, out, 'utf8')
    return { code, bytes: out.length, features: simplified.features?.length ?? 0 }
  } catch (e) {
    return { code, error: String(e.message ?? e) }
  }
}

async function runPool(codes, fn, limit) {
  const results = []
  let i = 0
  const workers = Array.from({ length: limit }, async () => {
    while (i < codes.length) {
      const idx = i++
      results[idx] = await fn(codes[idx])
    }
  })
  await Promise.all(workers)
  return results
}

mkdirSync(OUT, { recursive: true })

const level = (process.argv.find(a => a.startsWith('--level=')) ?? '--level=all').split('=')[1]

// ① 中国省级
const china = await fetchGeo('100000')
const chinaSimplified = simplifyGeo(china)
writeFileSync(join(OUT, '100000.json'), JSON.stringify(chinaSimplified), 'utf8')
console.log(`100000 (中国省级): ${chinaSimplified.features.length} 个省级`)

const provinceCodes = chinaSimplified.features
  .map(f => f.properties?.adcode)
  .filter(c => c && /^\d{6}$/.test(String(c)))
  .map(String)
console.log(`省级 adcode: ${provinceCodes.length} 个`)

if (level === 'province' || level === 'all') {
  console.log('\n下载省级（含地级市）...')
  const r = await runPool(provinceCodes, saveOne, CONCURRENCY)
  const ok = r.filter(x => x.bytes)
  const fail = r.filter(x => x.error)
  console.log(`  成功 ${ok.length} / 失败 ${fail.length} / 跳过 ${r.filter(x => x.skipped).length}`)
  console.log(`  总体积 ${(ok.reduce((n, x) => n + x.bytes, 0) / 1024 / 1024).toFixed(1)} MB`)
  if (fail.length) console.log('  失败:', fail.map(x => `${x.code}(${x.error})`).join(', '))
}

if (level === 'city' || level === 'all') {
  console.log('\n收集地级市 adcode...')
  const cityCodes = new Set()
  for (const pc of provinceCodes) {
    const file = join(OUT, `${pc}.json`)
    if (!existsSync(file)) continue
    const d = JSON.parse(readFileSync(file, 'utf8'))
    for (const f of d.features ?? []) {
      const c = f.properties?.adcode
      if (c && /^\d{6}$/.test(String(c))) cityCodes.add(String(c))
    }
  }
  console.log(`  地级市 ${cityCodes.size} 个`)
  console.log('\n下载市级（含区县）...')
  const r = await runPool([...cityCodes], saveOne, CONCURRENCY)
  const ok = r.filter(x => x.bytes)
  const fail = r.filter(x => x.error)
  console.log(`  成功 ${ok.length} / 失败 ${fail.length} / 跳过 ${r.filter(x => x.skipped).length}`)
  console.log(`  总体积 ${(ok.reduce((n, x) => n + x.bytes, 0) / 1024 / 1024).toFixed(1)} MB`)
  if (fail.length) console.log('  失败:', fail.slice(0, 10).map(x => `${x.code}(${x.error})`).join(', '))
}
