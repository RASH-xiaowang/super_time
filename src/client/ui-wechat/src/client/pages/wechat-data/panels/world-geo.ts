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
/** A geographic bounding box in degrees. */
export interface BBox {
  lonMin: number
  lonMax: number
  latMin: number
  latMax: number
}

/** Bounding box of mainland China for the province drill-down. */
export const CHINA_BBOX: BBox = { lonMin: 73, lonMax: 135, latMin: 18, latMax: 54 }

/**
 * Project a [lon, lat] point into the MAP_W x MAP_H viewBox so a region
 * bounding box fills the map (used for the China province drill-down).
 * @param lon - longitude in degrees.
 * @param lat - latitude in degrees.
 * @param bbox - region bounding box in degrees.
 * @returns projected x/y within the viewBox.
 */
export function projectBBox(lon: number, lat: number, bbox: BBox): { x: number; y: number } {
  const x = ((lon - bbox.lonMin) / (bbox.lonMax - bbox.lonMin)) * MAP_W
  const y = ((bbox.latMax - lat) / (bbox.latMax - bbox.latMin)) * MAP_H
  return { x, y }
}

/**
 * Build a closed smooth SVG path through a polygon's projected points using
 * quadratic beziers through the edge midpoints, giving rounded continent
 * silhouettes instead of angular chain segments.
 * @param points - polygon vertices in [lon, lat].
 * @param proj - projection to apply (defaults to the global `project`).
 * @returns an SVG path `d` string, or '' when fewer than 3 points.
 */
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
 * Chinese country/region label -> [lon, lat] centroid, covering the labels
 * RegionMapSnapshot emits. Entries with a geographic centre are plotted as
 * markers; labels absent from this table are collected into an "unlocated"
 * list so the drill still works.
 */
export const COUNTRY_CENTERS: Readonly<Record<string, LatLon>> = {
  中国: [104.2, 35.9],
  中国香港: [114.17, 22.32],
  中国澳门: [113.55, 22.2],
  中国台湾: [121, 23.7],
  阿尔巴尼亚: [20.17, 41.15],
  阿尔及利亚: [2.63, 28.03],
  阿根廷: [-63.62, -38.42],
  阿富汗: [67.71, 33.94],
  阿联酋: [54.4, 23.9],
  阿鲁巴: [-69.98, 12.52],
  阿曼: [55.92, 20.6],
  阿塞拜疆: [47.58, 40.14],
  埃及: [30.8, 26.82],
  埃塞俄比亚: [40.5, 9.14],
  爱沙尼亚: [25.01, 58.59],
  爱尔兰: [-8, 53.4],
  安道尔: [1.52, 42.51],
  安哥拉: [17.87, -11.2],
  奥地利: [14.55, 47.52],
  澳大利亚: [133.78, -25.27],
  巴基斯坦: [69.35, 30.38],
  巴拉圭: [-59.35, -23.22],
  巴拿马: [-80.78, 8.54],
  巴布亚新几内亚: [143.9, -6.31],
  巴哈马: [-77.4, 24.9],
  巴西: [-51.93, -14.24],
  白俄罗斯: [27.95, 53.9],
  百慕大: [-64.75, 32.31],
  保加利亚: [25.21, 42.73],
  比利时: [4.47, 50.5],
  冰岛: [-19, 64.9],
  波兰: [19.15, 52.1],
  波黑: [17.6, 43.9],
  玻利维亚: [-63.59, -17.06],
  博茨瓦纳: [24.66, -22.33],
  不丹: [90.31, 27.43],
  布基纳法索: [-1.56, 12.24],
  布隆迪: [29.86, -3.47],
  朝鲜: [126.55, 40.34],
  赤道几内亚: [10.45, 1.65],
  丹麦: [9.5, 56.26],
  德国: [10.45, 51.16],
  多哥: [0.82, 8.62],
  多米尼加: [-70.16, 18.74],
  俄罗斯: [100, 55],
  厄瓜多尔: [-78.19, -1.44],
  法国: [2.21, 46.23],
  斐济: [178, -17.7],
  芬兰: [25.75, 61.92],
  格鲁吉亚: [43.4, 42.3],
  格陵兰: [-42, 72],
  古巴: [-79.5, 21.5],
  哈萨克斯坦: [66.92, 48.02],
  韩国: [127.77, 35.91],
  荷兰: [5.29, 52.13],
  加拿大: [-106.35, 56.13],
  加纳: [-1.02, 7.95],
  柬埔寨: [104.99, 12.57],
  捷克: [15.47, 49.82],
  津巴布韦: [29.15, -19.01],
  喀麦隆: [12.35, 7.37],
  卡塔尔: [51.18, 25.35],
  科威特: [47.48, 29.31],
  克罗地亚: [16.55, 45.1],
  肯尼亚: [37.91, -0.02],
  拉脱维亚: [24.6, 56.88],
  老挝: [102.5, 19.9],
  立陶宛: [23.88, 55.17],
  利比亚: [17.23, 27.03],
  卢森堡: [6.13, 49.61],
  罗马尼亚: [24.97, 45.94],
  马达加斯加: [46.87, -19.37],
  马来西亚: [101.98, 4.21],
  马里: [-3.99, 17.57],
  毛里求斯: [57.55, -20.35],
  美国: [-95.71, 37.09],
  美国本土外小岛屿: [-110, 20],
  蒙古: [103.85, 46.86],
  孟加拉国: [90.36, 23.69],
  缅甸: [96.5, 21.9],
  摩洛哥: [-7.09, 31.79],
  莫桑比克: [35.53, -18.67],
  墨西哥: [-102.55, 23.63],
  南非: [24.67, -29],
  南极洲: [10, -75],
  尼泊尔: [84.12, 28.39],
  尼加拉瓜: [-84.95, 12.65],
  尼日尔: [8.08, 17.61],
  尼日利亚: [8.68, 9.08],
  挪威: [8.47, 60.47],
  葡萄牙: [-8, 39.5],
  日本: [138.25, 36.2],
  瑞典: [15, 62],
  瑞士: [8.23, 46.82],
  萨尔瓦多: [-88.95, 13.79],
  塞尔维亚: [21, 44.2],
  塞内加尔: [-14.5, 14.5],
  塞浦路斯: [33.43, 35.13],
  沙特阿拉伯: [45.08, 23.89],
  斯里兰卡: [80.77, 7.87],
  斯洛伐克: [19.7, 48.67],
  斯洛文尼亚: [14.82, 46.15],
  泰国: [100.99, 15.87],
  新加坡: [103.82, 1.35],
  圣诞岛: [105.6, -10.49],
  坦桑尼亚: [34.9, -6.37],
  特立尼达和多巴哥: [-61.2, 10.4],
  突尼斯: [9.54, 33.89],
  土耳其: [35.24, 38.96],
  危地马拉: [-90.3, 15.51],
  委内瑞拉: [-66.59, 6.42],
  文莱: [114.73, 4.54],
  乌干达: [32.29, 1.37],
  乌克兰: [31.17, 48.38],
  乌拉圭: [-55.77, -33.4],
  乌兹别克斯坦: [63.98, 41.24],
  西班牙: [-3.75, 40.46],
  希腊: [21.82, 39.07],
  新西兰: [174.89, -40.9],
  匈牙利: [19.5, 47.16],
  叙利亚: [38.1, 34.8],
  牙买加: [-77.42, 18.12],
  亚美尼亚: [45.04, 40.07],
  伊拉克: [43.68, 32.6],
  伊朗: [53.69, 32.43],
  以色列: [34.85, 31.05],
  意大利: [12.57, 41.87],
  印度: [78.96, 20.59],
  印度尼西亚: [113.9, -0.79],
  英国: [-3.44, 55.38],
  约旦: [36.24, 31.26],
  越南: [108.28, 14.06],
  赞比亚: [27.85, -13.13],
  泽西岛: [-2.13, 49.21],
  乍得: [18.7, 15.45],
  智利: [-71.54, -35.68],
}

/**
 * Look up a country/region centre by its Chinese label.
 * @param name - the label emitted by the region snapshot.
 * @returns the [lon, lat] centre, or null when the label is unknown.
 */
export function countryCenter(name: string): LatLon | null {
  return COUNTRY_CENTERS[name] ?? null
}












/**
 * Hand-authored coarse China outline for the province drill-down backdrop.
 * Vertices are [lon, lat] in degrees.
 */
export const CHINA_OUTLINE: ReadonlyArray<LatLon> = [
  [73, 39], [74, 44], [80, 45], [85, 48], [90, 47], [96, 48], [100, 50],
  [106, 49], [110, 48], [116, 47], [120, 46], [124, 44], [128, 42], [131, 40],
  [134, 38], [133, 36], [129, 34], [126, 32], [122, 30], [121, 28], [120, 26],
  [118, 24], [114, 23], [110, 21], [107, 19], [103, 21], [98, 23], [97, 28],
  [92, 27], [87, 28], [81, 30], [78, 32], [75, 34], [74, 37], [73, 39],
]

/**
 * Chinese province label -> [lon, lat] centroid for the province drill-down.
 * Covers the province labels RegionMapSnapshot emits under 中国, including the
 * synthetic 「省份未填」 bucket (placed centrally so it stays visible).
 */
export const PROVINCE_CENTERS: Readonly<Record<string, LatLon>> = {
  北京: [116.4, 39.9],
  天津: [117.2, 39.1],
  上海: [121.47, 31.23],
  重庆: [106.55, 29.56],
  河北: [114.5, 38.4],
  河南: [113.65, 34.76],
  云南: [101.7, 25.0],
  辽宁: [123.4, 41.8],
  黑龙江: [127.0, 47.0],
  湖南: [112.98, 28.2],
  安徽: [117.28, 31.86],
  山东: [117.0, 36.0],
  新疆: [87.6, 43.8],
  江苏: [119.5, 32.9],
  浙江: [120.15, 29.27],
  江西: [115.85, 27.7],
  湖北: [114.3, 30.6],
  广西: [108.32, 23.0],
  甘肃: [103.8, 36.0],
  山西: [112.4, 37.9],
  内蒙古: [111.67, 40.8],
  陕西: [108.95, 34.27],
  吉林: [125.35, 43.9],
  福建: [118.09, 25.9],
  贵州: [106.9, 26.6],
  广东: [113.3, 23.3],
  青海: [96.0, 35.5],
  西藏: [88.8, 30.0],
  四川: [102.7, 30.6],
  宁夏: [106.2, 37.5],
  海南: [110.0, 19.2],
  省份未填: [95, 34],
}

/**
 * Look up a province centre by its Chinese label.
 * @param name - the province label emitted by the region snapshot.
 * @returns the [lon, lat] centre, or null when the label is unknown.
 */
export function provinceCenter(name: string): LatLon | null {
  return PROVINCE_CENTERS[name] ?? null
}


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
