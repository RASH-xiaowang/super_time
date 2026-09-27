// @vitest-environment node
/**
 * 等距立体世界地图的**几何口径**（2026-09-27，`world-iso.ts`）。
 *
 * 为什么这些数值得单测：立体感全靠"看着像"是件危险的事 —— 投影压扁多少、柱体多高、
 * 谁在前谁在后、点中判定算不算命中，这四件事一旦错，界面上**照样能看**（图还是那个图），
 * 只是"哪里有人"读错了或者点不动。所以这里把它们全钉成可复算的数字：
 *
 *  · 投影：中心对得上、经度大往右、纬度大往上、**纵轴真的被压扁**（这就是"立体"的那一刀）；
 *  · 往返：`unproject(project(p))` 回到原点（悬停命中就靠它）；
 *  · 柱体：1 位好友也看得见（sqrt 曲线）、最大值的柱子到顶、`tone` 落在 0..1；
 *  · 面与命中：顶面在侧面之上、柱底附近算命中、远处不算。
 */
import { describe, expect, it } from 'vitest'
import {
  COL_H_MAX, COL_H_MIN, IDENTITY_CAM, ISO_TILT, columnFaces, hitColumn, isoColumns, largestRing,
  projectLonLat, ringBBox, ringCenter, unproject, type IsoView,
} from './world-iso.ts'

const VIEW: IsoView = { w: 960, h: 520 }

describe('投影：把地图压成一块"立起来的板"', () => {
  it('倾角是设计决定（0 < tilt < 1），且被钉住', () => {
    // < 1 才是"立起来"；= 1 是正射俯视（平的），0 会压成一条线。
    expect(ISO_TILT).toBeGreaterThan(0)
    expect(ISO_TILT).toBeLessThan(1)
    expect(ISO_TILT).toBeCloseTo(0.56, 5)
  })

  it('经度大往右、纬度大往上；赤道与本初子午线落在视图中间', () => {
    const center = projectLonLat(0, 0, VIEW)
    expect(Math.round(center.x)).toBe(Math.round(VIEW.w / 2))
    const east = projectLonLat(60, 0, VIEW)
    const west = projectLonLat(-60, 0, VIEW)
    expect(east.x).toBeGreaterThan(center.x)
    expect(west.x).toBeLessThan(center.x)
    const north = projectLonLat(0, 60, VIEW)
    const south = projectLonLat(0, -60, VIEW)
    expect(north.y).toBeLessThan(center.y)
    expect(south.y).toBeGreaterThan(center.y)
  })

  it('纵轴真的被压扁了：整块地图的投影高度 < 视图高度（"立体"就是这一刀）', () => {
    const top = projectLonLat(0, 90, VIEW).y
    const bottom = projectLonLat(0, -90, VIEW).y
    expect(bottom - top).toBeLessThan(VIEW.h)
    // 反例自证：把倾角按 1（不压扁）算一遍，高度就该顶满视图 —— 说明上面那条量的确实是压扁。
    const flat = ((90 - 90) / 180) * VIEW.h * 1
    const flatBottom = ((90 - -90) / 180) * VIEW.h * 1
    expect(flatBottom - flat).toBeGreaterThan(bottom - top)
  })

  it('往返一致：unproject(project(p)) 回到原经纬度（悬停命中靠它）', () => {
    for (const [lon, lat] of [[0, 0], [12.5, 41.9], [-122.3, 47.6], [139.7, 35.7]]) {
      const p = projectLonLat(lon as number, lat as number, VIEW)
      const back = unproject(p.x, p.y, VIEW)
      expect(back.lon).toBeCloseTo(lon as number, 6)
      expect(back.lat).toBeCloseTo(lat as number, 6)
    }
  })

  it('相机：缩放围着视图中心、平移就是平移', () => {
    const plain = projectLonLat(30, 20, VIEW)
    const zoomed = projectLonLat(30, 20, VIEW, { k: 2, tx: 0, ty: 0 })
    const cx = VIEW.w / 2
    // 缩放 2 倍后，离中心的距离也翻倍
    expect(Math.abs(zoomed.x - cx)).toBeCloseTo(Math.abs(plain.x - cx) * 2, 6)
    const moved = projectLonLat(30, 20, VIEW, { k: 1, tx: 40, ty: -15 })
    expect(moved.x - plain.x).toBeCloseTo(40, 6)
    expect(moved.y - plain.y).toBeCloseTo(-15, 6)
    // 往返也要跟着相机走（否则缩放过以后就点不中了）
    const back = unproject(moved.x, moved.y, VIEW, { k: 1, tx: 40, ty: -15 })
    expect(back.lon).toBeCloseTo(30, 6)
    expect(back.lat).toBeCloseTo(20, 6)
  })
})

describe('要素几何：外环、中心、包围盒', () => {
  const square: number[][] = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]

  it('largestRing 取最长的那个（小岛不该把中心带偏）', () => {
    const small = [[100, 100], [101, 100], [101, 101]]
    expect(largestRing([small, square])).toBe(square)
    expect(largestRing([])).toBeNull()
  })

  it('ringCenter 是顶点均值（等距采样，长环也算得动）', () => {
    const c = ringCenter(square)
    expect(c).not.toBeNull()
    expect(c?.lon).toBeCloseTo(4, 5)
    expect(c?.lat).toBeCloseTo(4, 5)
    // 4000 个点的环：采样后仍落在中心附近（不许因为采样少而整体偏移）
    const many: number[][] = Array.from({ length: 4000 }, (_, i) => [i % 100, Math.floor(i / 100)])
    const mc = ringCenter(many)
    expect(mc?.lon).toBeGreaterThan(40)
    expect(mc?.lon).toBeLessThan(60)
  })

  it('ringBBox 盖住全部顶点', () => {
    const b = ringBBox(square)
    expect(b).toEqual({ minLon: 0, maxLon: 10, minLat: 0, maxLat: 10 })
  })
})

describe('柱体：1 位好友也看得见，最多的那根到顶', () => {
  const items = [
    { name: 'A', anchor: { lon: 0, lat: 0 }, count: 1 },
    { name: 'B', anchor: { lon: 10, lat: 10 }, count: 25 },
    { name: 'C', anchor: { lon: -20, lat: 5 }, count: 100 },
    { name: 'D', anchor: null, count: 50 },
    { name: 'E', anchor: { lon: 30, lat: 0 }, count: 0 },
  ]

  it('没锚点或没数据的地方不立柱', () => {
    const cols = isoColumns(items, VIEW)
    expect(cols.map((c) => c.name).sort()).toEqual(['A', 'B', 'C'])
  })

  it('高度用 sqrt：1 位好友也看得见，且随数量单调不降', () => {
    const cols = isoColumns(items, VIEW)
    const h = (n: string): number => cols.find((c) => c.name === n)?.h ?? 0
    expect(h('A')).toBeGreaterThanOrEqual(COL_H_MIN)
    expect(h('A')).toBeLessThan(h('B'))
    expect(h('B')).toBeLessThan(h('C'))
    expect(h('C')).toBeCloseTo(COL_H_MAX, 5)
    // 反例自证：线性曲线下 1/100 的柱子会矮到不足 1px（那正是不能用线性的理由）
    const linearA = COL_H_MIN + (COL_H_MAX - COL_H_MIN) * (1 / 100)
    expect(linearA - COL_H_MIN).toBeLessThan(1)
    expect(h('A') - COL_H_MIN).toBeGreaterThan(5)
  })

  it('tone 落在 0..1，最大值是 1（青→品红的插值端点）', () => {
    const cols = isoColumns(items, VIEW)
    for (const c of cols) {
      expect(c.tone).toBeGreaterThan(0)
      expect(c.tone).toBeLessThanOrEqual(1)
    }
    expect(cols.find((c) => c.name === 'C')?.tone).toBeCloseTo(1, 5)
  })

  it('画家顺序：纵向在前的（y 小的）排后面，矮柱不被高柱盖住', () => {
    const cols = isoColumns(items, VIEW)
    for (let i = 1; i < cols.length; i += 1) {
      expect(cols[i]!.y).toBeGreaterThanOrEqual(cols[i - 1]!.y)
    }
  })

  it('一个都没数据时返回空（不画一排零高度的东西）', () => {
    expect(isoColumns([{ name: 'A', anchor: { lon: 0, lat: 0 }, count: 0 }], VIEW)).toEqual([])
  })

  it('相机会影响柱高（缩放后柱子跟着长），但不影响 tone', () => {
    const plain = isoColumns(items, VIEW)[2]!
    const zoomed = isoColumns(items, VIEW, { k: 2, tx: 0, ty: 0 })[2]!
    expect(zoomed.h).toBeCloseTo(plain.h * 2, 5)
    expect(zoomed.tone).toBeCloseTo(plain.tone, 6)
  })
})

describe('柱面与命中：点得中、点不偏', () => {
  const col = isoColumns([{ name: 'A', anchor: { lon: 0, lat: 0 }, count: 100 }], VIEW)[0]!

  it('顶面在侧面之上，三个面都贴着柱底到柱顶', () => {
    const f = columnFaces(col)
    const topMinY = Math.min(...f.top.map((p) => p[1]))
    const sideMinY = Math.min(...f.left.map((p) => p[1]), ...f.right.map((p) => p[1]))
    expect(topMinY).toBeLessThan(sideMinY)
    const bottomY = Math.max(...f.left.map((p) => p[1]))
    expect(bottomY).toBeCloseTo(col.y + col.r / 2, 5)
  })

  it('命中判定：柱体范围内算中、远处不算', () => {
    expect(hitColumn(col, col.x, col.y - col.h / 2)).toBe(true)
    expect(hitColumn(col, col.x + col.r * 3, col.y)).toBe(false)
    expect(hitColumn(col, col.x, col.y + col.r * 3)).toBe(false)
  })

  it('默认相机是恒等（判据与调用方对得上）', () => {
    expect(IDENTITY_CAM).toEqual({ k: 1, tx: 0, ty: 0 })
  })
})
