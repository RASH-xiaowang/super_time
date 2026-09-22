/**
 * Squarified treemap layout for the WeChat world-region map.
 *
 * Given weighted items and a viewport rectangle, produce one rectangle per
 * item whose area is proportional to its weight. Implements the standard
 * squarify algorithm (Bruls, Huizing & van Wijk) so blocks stay near-square
 * and readable. Pure function with no I/O, so it is trivially unit-testable.
 */

/** A weighted input item. */
export interface TreemapItem {
  /** Non-negative weight (area share). */
  value: number
}

/** A computed rectangle (absolute position + size). */
export interface TreemapRect {
  x: number
  y: number
  w: number
  h: number
}

interface Box { x: number; y: number; w: number; h: number }

/** Worst aspect ratio for a row (lower is better, 1 = square). */
function worst(row: number[], w: number, h: number): number {
  if (row.length === 0) return Number.POSITIVE_INFINITY
  const sum = row.reduce((a, b) => a + b, 0)
  if (sum === 0 || w <= 0 || h <= 0) return Number.POSITIVE_INFINITY
  const s2 = sum * sum
  return Math.max((w * w * h) / s2, s2 / (w * w * h))
}

/**
 * Squarify a list of weights into rectangles within the given box.
 * @param items - weighted items (each gets one output rect, index-aligned).
 * @param box - target rectangle.
 * @returns one rect per input item (zero-weight items get a zero-size rect).
 */
export function squarify(items: TreemapItem[], box: Box): TreemapRect[] {
  const out: TreemapRect[] = items.map(() => ({ x: box.x, y: box.y, w: 0, h: 0 }))
  const total = items.reduce((a, b) => a + Math.max(0, b.value), 0)
  if (total === 0 || box.w <= 0 || box.h <= 0) return out

  const scale = (box.w * box.h) / total
  const vals = items.map(it => Math.max(0, it.value) * scale)
  const posIdx: Array<{ v: number; i: number }> = []
  for (let i = 0; i < vals.length; i += 1) {
    const val = vals[i]
    if (val !== undefined && val > 0) posIdx.push({ v: val, i })
  }

  let x = box.x
  let y = box.y
  let w = box.w
  let h = box.h
  let row: number[] = []
  let cursor = 0

  const layoutRow = (): void => {
    if (row.length === 0) return
    const sum = row.reduce((a, b) => a + b, 0)
    if (w >= h) {
      let rw = sum / h
      if (rw > w) rw = w
      const cellH = sum / Math.max(rw, 1e-9)
      let yy = y
      for (const v of row) {
        const ch = (v / sum) * cellH
        const target = posIdx[cursor]
        if (target) out[target.i] = { x, y: yy, w: rw, h: ch }
        yy += ch
      }
      x += rw
      w -= rw
    } else {
      let rh = sum / w
      if (rh > h) rh = h
      const cellW = sum / Math.max(rh, 1e-9)
      let xx = x
      for (const v of row) {
        const cw = (v / sum) * cellW
        const target = posIdx[cursor]
        if (target) out[target.i] = { x: xx, y, w: cw, h: rh }
        xx += cw
      }
      y += rh
      h -= rh
    }
    cursor += row.length
    row = []
  }

  for (const { v } of posIdx) {
    if (row.length > 0 && worst([...row, v], w, h) > worst(row, w, h)) layoutRow()
    row.push(v)
  }
  layoutRow()
  return out
}

/**
 * Lay items with one chosen item centered and the rest filling the frame
 * around it. The centered item gets a square-ish block at the middle; the
 * remainder is squarified into the surrounding strips. Used at the world level
 * so the dominant country (中国) sits in the center.
 * @param items - weighted items (each gets one output rect, index-aligned).
 * @param box - target rectangle.
 * @param centerIndex - index of the item to center.
 * @returns one rect per input item.
 */
export function centeredSquarify(items: TreemapItem[], box: Box, centerIndex: number): TreemapRect[] {
  const n = items.length
  const out: TreemapRect[] = items.map(() => ({ x: box.x, y: box.y, w: 0, h: 0 }))
  if (n === 0) return out
  const center = Math.min(Math.max(centerIndex, 0), n - 1)
  const total = items.reduce((a, b) => a + Math.max(0, b.value), 0)
  if (total === 0 || box.w <= 0 || box.h <= 0) return out

  const centerItem = items[center]
  const centerValue = centerItem ? centerItem.value : 0
  const share = Math.min(0.7, Math.max(0.2, Math.max(0, centerValue) / total))
  const cArea = box.w * box.h * share
  const maxW = box.w * 0.66
  const maxH = box.h * 0.82
  let cWidth = Math.sqrt(cArea * (box.w / box.h))
  let cHeight = cArea / Math.max(cWidth, 1e-9)
  if (cWidth > maxW) { cWidth = maxW; cHeight = cArea / cWidth }
  if (cHeight > maxH) { cHeight = maxH; cWidth = cArea / cHeight }
  const cx = box.x + (box.w - cWidth) / 2
  const cy = box.y + (box.h - cHeight) / 2
  out[center] = { x: cx, y: cy, w: cWidth, h: cHeight }

  const others: TreemapItem[] = []
  const otherIdx: number[] = []
  for (let i = 0; i < n; i += 1) {
    if (i === center) continue
    const item = items[i]
    others.push({ value: item ? item.value : 0 })
    otherIdx.push(i)
  }
  const oTotal = others.reduce((a, b) => a + Math.max(0, b.value), 0)
  if (oTotal === 0) return out
  // Centering needs enough surrounding items to fill the 4-frame strips; with
  // too few it leaves gaps, so fall back to a plain (gap-free) squarify.
  if (others.length < 4) return squarify(items, box)

  const strips: Box[] = [
    { x: box.x, y: box.y, w: cx - box.x, h: box.h },
    { x: cx + cWidth, y: box.y, w: box.x + box.w - (cx + cWidth), h: box.h },
    { x: cx, y: box.y, w: cWidth, h: cy - box.y },
    { x: cx, y: cy + cHeight, w: cWidth, h: box.y + box.h - (cy + cHeight) },
  ]
  const stripArea = strips.map(s => Math.max(0, s.w * s.h))
  const totalStrip = stripArea.reduce((a, b) => a + b, 0)
  if (totalStrip <= 0) return squarify(items, box)

  const buckets: number[][] = strips.map((): number[] => [])
  const bucketArea = [...stripArea]
  const order: Array<{ o: TreemapItem; i: number }> = []
  for (let i = 0; i < others.length; i += 1) { const o = others[i]; if (o) order.push({ o, i }) }
  order.sort((a, b) => (b.o.value || 0) - (a.o.value || 0))

  const live: Array<{ a: number; s: number }> = []
  for (let s = 0; s < stripArea.length; s += 1) {
    const a = stripArea[s]
    if (a !== undefined && a > 0) live.push({ a, s })
  }
  for (const { s } of live) {
    if (order.length === 0) break
    const seed = order.pop()
    if (!seed) break
    const b = buckets[s]
    const ba = bucketArea[s]
    if (b && ba !== undefined) {
      b.push(seed.i)
      bucketArea[s] = ba - (seed.o.value / oTotal) * totalStrip
    }
  }
  for (const { o, i } of order) {
    let best = -1
    for (let s = 0; s < bucketArea.length; s += 1) {
      if (best === -1 || (bucketArea[s] ?? 0) > (bucketArea[best] ?? 0)) best = s
    }
    if (best === -1) continue
    const b = buckets[best]
    const ba = bucketArea[best]
    if (b && ba !== undefined) {
      b.push(i)
      bucketArea[best] = ba - (o.value / oTotal) * totalStrip
    }
  }
  for (let s = 0; s < strips.length; s += 1) {
    const bucket = buckets[s]
    const strip = strips[s]
    if (!bucket || !strip) continue
    const rects = squarify(bucket.map(i => others[i] ?? { value: 0 }), strip)
    for (let k = 0; k < bucket.length; k += 1) {
      const src = bucket[k]
      const rect = rects[k]
      const targetIdx = src === undefined ? undefined : otherIdx[src]
      if (src !== undefined && rect && targetIdx !== undefined) out[targetIdx] = rect
    }
  }
  return out
}
