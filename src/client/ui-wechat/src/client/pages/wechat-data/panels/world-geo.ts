/**
 * Friend-region world-map geometry.
 *
 * The host returns a RegionMapSnapshot whose countries are Chinese labels
 * (from region.ts). This module supplies the offline SVG fallback geometry:
 * coarse continent polygons for the backdrop plus a country-centre table so
 * markers can be placed geographically. `project` maps [lon, lat] into the
 * fixed 1000x500 viewBox; `smoothClosedPath` turns a polygon into a rounded,
 * organic SVG path. When a world GeoJSON is reachable, GeoEchartsMap renders
 * the real ECharts world map instead and this SVG layer becomes the fallback.
 */

/** A geographic point as [longitude, latitude] in degrees. */
export type LatLon = readonly [number, number]

/** A projection mapping [lon, lat] into the fixed MAP_W x MAP_H viewBox. */
export type ProjectFn = (lon: number, lat: number) => { x: number; y: number }

/** Equirectangular (plate carrée) viewBox width used by the map SVG. */
export const MAP_W = 1000
/** Equirectangular (plate carrée) viewBox height used by the map SVG. */
export const MAP_H = 500

/**
 * Project a [lon, lat] point into the fixed MAP_W x MAP_H viewBox.
 * @param lon - longitude in degrees (-180..180).
 * @param lat - latitude in degrees (-90..90).
 * @returns projected x/y within the viewBox.
 */
export function project(lon: number, lat: number): { x: number; y: number } {
  const x = ((lon + 180) / 360) * MAP_W
  const y = ((90 - lat) / 180) * MAP_H
  return { x, y }
}
export function smoothClosedPath(points: readonly LatLon[], proj: ProjectFn = project): string {
  if (points.length < 3) return ''
  const pts = points.map(p => proj(p[0], p[1]))
  const n = pts.length
  const first = pts[0]
  if (!first) return ''
  const mid = (a: { x: number; y: number }, b: { x: number; y: number }): { x: number; y: number } =>
    ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
  let d = 'M' + fmt(first.x) + ' ' + fmt(first.y)
  for (let i = 0; i < n; i += 1) {
    const cur = pts[i]
    const next = pts[(i + 1) % n]
    if (!cur || !next) continue
    const m = mid(cur, next)
    d += ' Q' + fmt(cur.x) + ' ' + fmt(cur.y) + ' ' + fmt(m.x) + ' ' + fmt(m.y)
  }
  return d + ' Z'
}

/** Format a coordinate to 1 decimal place (keeps the SVG path compact). */
function fmt(v: number): string {
  return String(Math.round(v * 10) / 10)
}

/**
 * Continent centroids for the world map backdrop. Hand-authored coarse
 * polygons; each entry is a continent name and its [lon, lat] vertices.
 */
export const CONTINENTS: ReadonlyArray<{ name: string; points: readonly LatLon[] }> = [
  {
    name: '北美洲',
    points: [
      [-168, 66], [-160, 70], [-150, 71], [-135, 69], [-125, 72], [-110, 74],
      [-95, 76], [-85, 72], [-70, 67], [-60, 59], [-55, 52], [-65, 47],
      [-73, 41], [-77, 37], [-80, 31], [-82, 26], [-89, 26], [-94, 30],
      [-100, 28], [-105, 22], [-112, 27], [-117, 33], [-121, 37], [-124, 44],
      [-128, 49], [-133, 55], [-140, 60], [-150, 62], [-158, 58], [-164, 56],
      [-168, 60],
    ],
  },
  { name: '格陵兰', points: [[-45, 60], [-52, 63], [-55, 70], [-42, 79], [-28, 78], [-20, 72], [-26, 64], [-38, 60]] },
  {
    name: '南美洲',
    points: [
      [-78, 8], [-70, 11], [-60, 10], [-50, 5], [-44, -2], [-37, -8],
      [-35, -15], [-39, -22], [-48, -27], [-55, -34], [-62, -40], [-66, -48],
      [-70, -54], [-73, -45], [-75, -35], [-76, -26], [-80, -12], [-82, -5],
      [-80, 2],
    ],
  },
  {
    name: '非洲',
    points: [
      [-10, 35], [-5, 36], [0, 35], [8, 34], [11, 36], [18, 35], [24, 33],
      [30, 32], [34, 28], [38, 24], [40, 18], [44, 12], [46, 4], [44, -4],
      [40, -12], [34, -20], [30, -30], [25, -34], [18, -34], [12, -30],
      [8, -22], [6, -12], [2, -4], [-2, 4], [-8, 5], [-14, 8], [-17, 12],
      [-16, 20], [-12, 27], [-10, 35],
    ],
  },
  {
    name: '欧洲',
    points: [
      [-9, 37], [-9, 43], [-4, 44], [-4, 48], [0, 48], [2, 51], [5, 51],
      [8, 52], [12, 54], [16, 54], [20, 55], [24, 56], [28, 56], [30, 53],
      [28, 48], [26, 44], [22, 40], [18, 39], [15, 41], [12, 43], [10, 44],
      [8, 44], [5, 43], [3, 40], [1, 38], [-4, 37],
    ],
  },
  {
    name: '亚洲',
    points: [
      [-6, 36], [0, 36], [10, 38], [18, 40], [26, 38], [34, 34], [40, 30],
      [47, 30], [55, 36], [60, 42], [66, 48], [70, 55], [80, 62], [90, 68],
      [105, 74], [120, 74], [135, 70], [150, 64], [162, 60], [170, 56],
      [165, 50], [155, 44], [150, 38], [142, 32], [135, 27], [128, 23],
      [122, 18], [116, 12], [110, 7], [105, 2], [100, -2], [103, -6],
      [108, -9], [114, -8], [118, -4], [122, 0], [128, 2], [132, 4],
    ],
  },
  {
    name: '大洋洲',
    points: [
      [114, -22], [118, -20], [122, -17], [128, -14], [136, -12], [142, -11],
      [146, -14], [150, -19], [153, -25], [150, -32], [145, -37], [139, -37],
      [135, -35], [131, -31], [126, -28], [122, -30], [117, -32], [114, -28],
    ],
  },
  {
    name: '南极洲',
    points: [
      [-180, -70], [-120, -72], [-60, -73], [0, -71], [60, -70], [120, -72],
      [180, -70], [180, -90], [-180, -90],
    ],
  },
]

/**
 * Chinese province label -> Aliyun DataV adcode, used to fetch a province's
 * GeoJSON and to colour the China ECharts map by friend count. Synthetic buckets
 * (「省份未填」) have no adcode and are absent.
 */
export const PROVINCE_ADCODE: Readonly<Record<string, string>> = {
  北京: '110000',
  天津: '120000',
  上海: '310000',
  重庆: '500000',
  河北: '130000',
  河南: '410000',
  云南: '530000',
  辽宁: '210000',
  黑龙江: '230000',
  湖南: '430000',
  安徽: '340000',
  山东: '370000',
  新疆: '650000',
  江苏: '320000',
  浙江: '330000',
  江西: '360000',
  湖北: '420000',
  广西: '450000',
  甘肃: '620000',
  山西: '140000',
  内蒙古: '150000',
  陕西: '610000',
  吉林: '220000',
  福建: '350000',
  贵州: '520000',
  广东: '440000',
  青海: '630000',
  西藏: '540000',
  四川: '510000',
  宁夏: '640000',
  海南: '460000',
  台湾: '710000',
  香港: '810000',
  澳门: '820000',
}

/**
 * Look up a province adcode by its Chinese label.
 * @param name - the province label emitted by the region snapshot.
 * @returns the adcode, or null when the label is unknown/synthetic.
 */
export function provinceAdcode(name: string): string | null {
  return PROVINCE_ADCODE[name] ?? null
}
