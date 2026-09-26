
/**
 * 世界地图：**地理 SVG 已移除**，世界层改走 ECharts 且不等数据（2026-09-26 用户要求）。
 *
 * 前一版（同一天更早）：世界层在 GeoJSON 未就绪时先渲染一张自绘 SVG 底图。
 * 用户随后要求删掉那张 SVG —— 于是本文件的不变量整体换了一批：
 *
 *  ① **SVG 视图不再存在**：`showWorldSvg` / `showGeoMap` / `showWorldSvg` 的按钮组、
 *     `mapSvg`/`grat`/`land`/`mapMarker` 这套类、以及 `world-geo.ts` 里只服务它的
 *     静态轮廓数据（`CHINA_OUTLINE` / `CHINA_BBOX` / `projectBBox` / `countryCenter` /
 *     `provinceCenter`）都已删除。**别再让它们回来。**
 *     注意 `CONTINENTS` / `smoothClosedPath` / `MAP_W` / `MAP_H` / `project` **不能删** ——
 *     足迹地图（`FootprintMap.tsx`）还在用同一套。
 *  ② **世界层不等数据**：GeoJSON 一到就先画真地图底图，好友着色随后叠加
 *     （`node` 回退到 `EMPTY_WORLD` 空节点）。这条取代了上一版的「先渲染 SVG」。
 *  ③ **底图拉不到要给明确说明**（未联网 / 用户开了 `blockMapTiles`），不留一片空白。
 *  ④ **中国层 ECharts 起不来落到 treemap** —— SVG 走后，它接管了原来的兜底位置
 *     （省 / 市两层本来就是这条降级路径）。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, readStripped, readText, sliceBetween } from './wiring-kit.ts'

const HERE = import.meta.dirname
const MAP = readStripped(join(HERE, 'WorldMap.tsx'))
const GEO = readStripped(join(HERE, 'world-geo.ts'))
const CSS = readText(join(HERE, 'world-map.module.css'))

/** SVG 视图的标识串（任何一条回来都说明 SVG 复活了）。 */
const SVG_MARKERS = ['showWorldSvg', 'showGeoMap', 'css.mapSvg', 'css.grat', 'css.land', 'wmGradLand0']

describe('① 地理 SVG 已移除，且不许复活', () => {
  it('WorldMap 里没有任何 SVG 视图的标识串', () => {
    for (const m of SVG_MARKERS) {
      expect(MAP.includes(m), `SVG 标识串回来了：${m}`).toBe(false)
    }
  })

  it('SVG 专用的事件/派生也没了（平移缩放、涟漪、经纬网、底图路径）', () => {
    for (const m of ['clampView', 'setHoverRegion', 'dragRef', 'geoRipple', 'graticule', 'backdropPaths', 'projectView']) {
      expect(MAP.includes(m), `SVG 时代的东西还在：${m}`).toBe(false)
    }
  })

  it('CSS 里没有 SVG 专用类残留', () => {
    for (const cls of ['mapSvg', 'grat', 'land', 'mapGlow', 'mapMarker', 'mapRipple', 'mapLegend', 'viewCtrls']) {
      expect(CSS.includes(`.${cls} {`) || CSS.includes(`.${cls}:`) || CSS.includes(`.${cls},`),
        `死样式还在：.${cls}`).toBe(false)
    }
  })

  it('world-geo 只服务 SVG 的导出已删；足迹地图要用的那几个**必须留着**', () => {
    for (const dead of ['CHINA_OUTLINE', 'CHINA_BBOX', 'projectBBox', 'countryCenter', 'provinceCenter']) {
      expect(GEO.includes(`export `) && new RegExp(`export (const|function) ${dead}\\b`).test(GEO),
        `${dead} 只服务已删的 SVG，应该删掉`).toBe(false)
    }
    // 反例：这几个被 FootprintMap 共用，删了会把它一起弄坏
    for (const keep of ['CONTINENTS', 'smoothClosedPath', 'MAP_W', 'MAP_H', 'project']) {
      expect(new RegExp(`export (const|function) ${keep}\\b`).test(GEO), `${keep} 被足迹地图共用，不能删`).toBe(true)
    }
    expect(new RegExp('export function provinceAdcode\\b').test(GEO), 'ChinaMap 还要用它').toBe(true)
  })
})

describe('② 世界层：ECharts 不等数据', () => {
  it('showWorldEcharts 不再要求 map', () => {
    expect(MAP, '又退回「等数据才画」了').toMatch(/const showWorldEcharts = worldEchartsReady\s*$/m)
    expect(MAP.includes('worldEchartsReady && map !== null'), '不该再要求 map').toBe(false)
  })

  it('ECharts 分支不带 map 前置，且 node 有空节点兜底', () => {
    expect(MAP).toContain('{showWorldEcharts && (')
    expect(MAP.includes('{map && showWorldEcharts && ('), '不该再等数据').toBe(false)
    expect(MAP, '缺空世界节点').toMatch(/const EMPTY_WORLD: RegionNode = \{ key: 'world'/)
    expect(MAP, 'node 没做空值回退').toContain('node={map?.world ?? EMPTY_WORLD}')
  })

  it('childByKey 也要防空（否则数据没到时直接崩）', () => {
    expect(MAP).toContain('worldChildByName(map?.world.children ?? [], key)')
  })
})

describe('③ 底图拉不到时给明确说明，不留空白', () => {
  it('有 blocked 判据与提示文案', () => {
    expect(MAP, '缺少「底图不可用」判据').toMatch(/const geoTilesBlocked = onWorldMap && worldGeo\?\.ok === false/)
    expect(MAP, '缺少提示块').toContain('{geoTilesBlocked && (')
    const tip = sliceBetween(MAP, '{geoTilesBlocked && (', ')}', '底图不可用提示')
    expect(tip, '提示要说清原因（未联网 / 隐私开关）').toContain('禁止地图底图出网')
    expect(tip, '要指个去处，否则用户以为数据丢了').toContain('省份 / 城市榜单')
  })
})

describe('④ 中国层 ECharts 起不来 → treemap', () => {
  it('showTreemap 把 chinaFallback 也算进去', () => {
    expect(MAP).toMatch(/const showTreemap = !onWorldMap && \(!chinaMode \|\| chinaFallback\) && !showProvinceMap && !showCityMap/)
  })

  it('fallbackWorldEcharts 仍在（ECharts 失败时标记底图不可用）', () => {
    expect(MAP).toContain('const fallbackWorldEcharts = (): void => {')
    expect(MAP).toContain('onFallback={fallbackWorldEcharts}')
  })

  it('防空转：真读到了三个文件', () => {
    atLeast(MAP.length, 5000, 'WorldMap.tsx 源码')
    atLeast(GEO.length, 3000, 'world-geo.ts 源码')
    atLeast(CSS.length, 4000, 'world-map.module.css 源码')
  })
})
