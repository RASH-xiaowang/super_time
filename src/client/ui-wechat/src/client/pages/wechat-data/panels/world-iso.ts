/**
 * 世界地图的**等距立体**投影与柱体几何（2026-09-27）。
 *
 * ## 为什么单独成文件
 *
 * `WorldMapPanel` 在单函数行数棘轮上（351 行，只许变小），塞不进去；更要紧的是
 * **投影与柱体几何必须是可单测的纯函数** —— 立体感一旦靠"看截图调参数"，
 * 下次换主题、换数据源就会静默走形，而截图没人天天看。
 *
 * ## 口径（一眼能对上的三件事）
 *
 * · **投影**：等距圆柱（lon/lat → x/y）后再按 `ISO_TILT` 压扁纵轴 —— 压扁就是"把地图平放、
 *   相机抬高"的观感，1 表示正射俯视（平的）、越小越"立起来"。0.56 与设计稿那块斜板一致。
 * · **柱体**：高度取 `sqrt(count)` 再归一到 [MIN_H, MAX_H]。用 sqrt 不用线性：好友数跨度是
 *   1~200，线性会让只有 1 位好友的国家矮成一条线（看不出"这里也有人"）。
 * · **色调**：`tone = count / maxCount`（0..1）线性插值青→品红，与皮肤同一套端点色。
 *
 * @module world-iso
 */

/** 画布盒子（css 像素）。 */
export interface IsoView { w: number; h: number }

/** 相机：缩放与平移（屏幕像素）。 */
export interface IsoCam { k: number; tx: number; ty: number }

/** 经纬度。 */
export interface LonLat { lon: number; lat: number }

/** 俯视压缩比：1 = 平放（正射），越小越"立起来"。 */
export const ISO_TILT = 0.56
/** 上下留白占视图高度的比例（给柱体与光晕留位置）。 */
export const ISO_PAD_RATIO = 0.04
/** 一个要素（几何 + 名字 + 锚点 + 包围盒）—— 渲染层与绘制层共用同一份形状。 */
export interface IsoFeature {
  name: string
  label: string
  rings: Ring[]
  center: LonLat | null
  bbox: { minLon: number; maxLon: number; minLat: number; maxLat: number } | null
}

/** 柱体高度区间（像素，按基准宽 960 归一后再乘缩放）。 */
export const COL_H_MIN = 10
export const COL_H_MAX = 80
/** 柱体半宽与基准宽的比例。 */
export const COL_R_RATIO = 0.0075
/** 最小基准宽：窄于此按此算，免得小窗口里柱体细得看不见。 */
const BASE_W = 960

/** 中立相机（未缩放、未平移）。 */
export const IDENTITY_CAM: IsoCam = { k: 1, tx: 0, ty: 0 }

/** 地图内容在视图里的纵向可用高度（扣掉上下留白）。 */
function contentH(view: IsoView): number {
  return view.h * (1 - 2 * ISO_PAD_RATIO)
}

/**
 * 经纬度 → 画布坐标（含相机）。
 * @param lon - 经度（-180..180）。
 * @param lat - 纬度（-90..90）。
 * @param view - 画布盒子。
 * @param cam - 缩放/平移；省略即"正放"。
 * @returns 画布上的 x/y（css 像素）。
 */
export function projectLonLat(lon: number, lat: number, view: IsoView, cam: IsoCam = IDENTITY_CAM): { x: number; y: number } {
  const rawX = ((lon + 180) / 360) * view.w
  const rawY = ((90 - lat) / 180) * contentH(view) * ISO_TILT + view.h * ISO_PAD_RATIO
  // 以视图中心为锚做缩放，再叠加平移 —— 与"滚轮缩放围着手/鼠标"是同一套变换。
  const cx = view.w / 2
  const cy = view.h / 2
  return { x: cx + (rawX - cx) * cam.k + cam.tx, y: cy + (rawY - cy) * cam.k + cam.ty }
}

/**
 * 画布坐标 → 经纬度（`projectLonLat` 的逆）。
 * 悬停命中用不到多边形求交：把鼠标位置反投影回经纬度，再拿国家的 **bbox** 判归属就够了
 * （世界地图尺度下 bbox 的重叠远小于像素级误差的影响，而它比逐点多边形测试便宜得多）。
 * @param x - 画布 x。
 * @param y - 画布 y。
 * @param view - 画布盒子。
 * @param cam - 缩放/平移。
 * @returns 经纬度；`y` 落在留白区时会给出范围外的纬度（调用方靠 bbox 自然排除）。
 */
export function unproject(x: number, y: number, view: IsoView, cam: IsoCam = IDENTITY_CAM): LonLat {
  const cx = view.w / 2
  const cy = view.h / 2
  const rawX = cx + (x - cx - cam.tx) / cam.k
  const rawY = cy + (y - cy - cam.ty) / cam.k
  const lon = (rawX / view.w) * 360 - 180
  const lat = 90 - ((rawY - view.h * ISO_PAD_RATIO) / (contentH(view) * ISO_TILT)) * 180
  return { lon, lat }
}

/** GeoJSON 环（`[[lon,lat], …]`）。 */
export type Ring = number[][]

/** 取一个要素里**最大的那个环**（外环）：孔洞对定位没用，小岛会把中心拉偏。 */
export function largestRing(rings: Ring[] | undefined): Ring | null {
  if (!rings || rings.length === 0) return null
  let best: Ring | null = null
  for (const r of rings) {
    if (!Array.isArray(r) || r.length === 0) continue
    if (best === null || r.length > best.length) best = r
  }
  return best
}

/**
 * 环的中心：顶点均值。
 *
 * 不用面积加权重心：这里的用途是"把柱子插在国家上"，而不是地理质心；
 * 均值对不规则形状更稳（面积重心在多岛国家会被最大的那块拽走）。
 * 顶点的**等距采样**（每 N 个取一个）是为了让环点数差异极大的数据集不至于把中心算偏。
 * @param ring - 环。
 * @returns 经纬度；空环返回 null。
 */
export function ringCenter(ring: Ring | null): LonLat | null {
  if (!ring || ring.length === 0) return null
  const step = Math.max(1, Math.floor(ring.length / 64))
  let sx = 0
  let sy = 0
  let n = 0
  for (let i = 0; i < ring.length; i += step) {
    const p = ring[i]
    if (!p || typeof p[0] !== 'number' || typeof p[1] !== 'number') continue
    sx += p[0]
    sy += p[1]
    n += 1
  }
  if (n === 0) return null
  return { lon: sx / n, lat: sy / n }
}

/** 环的经纬度包围盒。 */
export function ringBBox(ring: Ring): { minLon: number; maxLon: number; minLat: number; maxLat: number } {
  let minLon = Number.POSITIVE_INFINITY
  let maxLon = Number.NEGATIVE_INFINITY
  let minLat = Number.POSITIVE_INFINITY
  let maxLat = Number.NEGATIVE_INFINITY
  for (const p of ring) {
    if (!p || typeof p[0] !== 'number' || typeof p[1] !== 'number') continue
    if (p[0] < minLon) minLon = p[0]
    if (p[0] > maxLon) maxLon = p[0]
    if (p[1] < minLat) minLat = p[1]
    if (p[1] > maxLat) maxLat = p[1]
  }
  return { minLon, maxLon, minLat, maxLat }
}

/** 屏幕上的一个柱体。 */
export interface IsoColumn {
  name: string
  /** 柱底中心（画布坐标）。 */
  x: number
  y: number
  /** 柱高（像素，已经含相机缩放）。 */
  h: number
  /** 半宽（像素）。 */
  r: number
  count: number
  /** 0..1：在最大值里的位置，用来取青→品红的插值。 */
  tone: number
}

/**
 * 把「国家 → 好友数」变成一组柱体。
 * @param items - 每个要素的名字、锚点与好友数。
 * @param view - 画布盒子。
 * @param cam - 缩放/平移。
 * @returns 柱体数组；`count <= 0` 的要素会被丢掉（没数据的地方不该立柱子）。
 */
export function isoColumns(
  items: ReadonlyArray<{ name: string; anchor: LonLat | null; count: number }>,
  view: IsoView,
  cam: IsoCam = IDENTITY_CAM,
): IsoColumn[] {
  const max = items.reduce((a, it) => Math.max(a, it.count), 0)
  if (max <= 0) return []
  const base = Math.max(BASE_W, view.w)
  const out: IsoColumn[] = []
  for (const it of items) {
    if (!it.anchor || it.count <= 0) continue
    const t = Math.min(1, it.count / max)
    const { x, y } = projectLonLat(it.anchor.lon, it.anchor.lat, view, cam)
    out.push({
      name: it.name,
      x,
      y,
      // sqrt 曲线：1 位好友也要看得见（线性会让它矮成一条线）；再乘相机缩放。
      h: (COL_H_MIN + (COL_H_MAX - COL_H_MIN) * Math.sqrt(t)) * cam.k,
      r: base * COL_R_RATIO * (0.7 + 0.6 * t) * cam.k,
      count: it.count,
      tone: t,
    })
  }
  // 高的在后、矮的在前：矮柱叠在高柱上会被盖住（画家算法）。
  return out.sort((a, b) => a.y - b.y)
}

/** 一个等距柱体的三个面（画布坐标）。 */
export interface ColumnFaces {
  top: Array<[number, number]>
  left: Array<[number, number]>
  right: Array<[number, number]>
}

/**
 * 柱体的可见三面：顶面菱形 + 左右两个侧面。
 * @param c - 柱体。
 * @returns 三个多边形（顺序即绘制顺序：先侧面后顶面）。
 */
export function columnFaces(c: IsoColumn): ColumnFaces {
  const { x, y, h, r } = c
  const ty = y - h
  const half = r / 2
  return {
    left: [[x - r, ty], [x, ty + half], [x, y + half], [x - r, y]],
    right: [[x + r, ty], [x, ty + half], [x, y + half], [x + r, y]],
    top: [[x, ty - half], [x + r, ty], [x, ty + half], [x - r, ty]],
  }
}

/** 命中判定：点是否落在柱体的包围盒里（悬停/点击都用它，够快也够准）。 */
export function hitColumn(c: IsoColumn, x: number, y: number): boolean {
  return x >= c.x - c.r && x <= c.x + c.r && y >= c.y - c.h - c.r / 2 && y <= c.y + c.r / 2
}
