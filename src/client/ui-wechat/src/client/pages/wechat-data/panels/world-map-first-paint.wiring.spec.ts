
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
 *  ⑤ **底图闸门不许把首帧堵在后端队列上**（2026-09-26 用户报「世界地图一直在加载中」）：
 *     `fetchFirstJson` 要先问一次「禁止地图底图出网」开关，而那是一次 RPC；后端同步串行，
 *     排在长任务（实测 `analyzeVisibleMessages` 54,103ms / `getRemoteImages` 45,000~51,000ms）
 *     后面时要等几十秒 ⇒ 底图连"开始拉"都还没轮到。改为**先读本地镜像**（0ms）+ 后端读取
 *     **有界等待**。加载态同时要能自证在动（已用 Ns，U2 约定）。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, findRoot, readStripped, readText, sliceBetween } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const MAP = readStripped(join(HERE, 'WorldMap.tsx'))
const GEO = readStripped(join(HERE, 'world-geo.ts'))
const CSS = readText(join(HERE, 'world-map.module.css'))

const DATA = readStripped(join(HERE, 'world-map-data.ts'))
const FLAG = readStripped(join(HERE, '..', 'map-tiles-flag.ts'))
const API = readStripped(join(HERE, '..', 'api-read.ts'))

/** `mapTilesBlocked` 的函数体：切到行首那个收尾大括号（内部的大括号都有缩进）。 */
const GATE = sliceBetween(DATA, 'async function mapTilesBlocked', '\n}', 'mapTilesBlocked')

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

  it('隐私开关的文案与文档**都不许再承诺「改用离线视图」**（那个视图已被删）', () => {
    const privacy = readStripped(join(HERE, 'PrivacyTrust.tsx'))
    expect(privacy.includes('离线视图'), 'SVG 已删，界面不能再承诺离线视图').toBe(false)
    // 文档侧守「必须如实写出代价」而不是「不许出现某个词」—— 后者会把
    // 「说明历史时引用旧承诺」也判成违规（这条断言的第一版就撞了这个坑）。
    const doc = readText(join(findRoot(HERE), 'docs', 'PRIVACY.md'))
    expect(doc, 'PRIVACY.md 必须如实写出代价：不再画底图').toContain('不再画底图')
    expect(doc, '并点明旧承诺指的是被删的那张 SVG').toContain('已于 2026-09-26 按用户要求移除')
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

describe('⑤ 底图闸门不许把首帧堵在后端队列上', () => {
  it('先读本地镜像，且读镜像之前一个 await 都没有（否则等于没省下排队）', () => {
    const mirrorAt = GATE.indexOf('readMapTilesFlag()')
    expect(mirrorAt, '没有读本地镜像').toBeGreaterThan(-1)
    expect(GATE.slice(0, mirrorAt).includes('await'), '读镜像前就 await 了').toBe(false)
    // P3-9：快路留着，但**只对新鲜的镜像**开 —— 值与新一起判，缺一样都回去问后端。
    expect(GATE, '镜像采信要同时看值与新鲜期').toMatch(/if \(mirrored !== null && ageMs !== null && ageMs <= FLAG_FRESH_MS\) return mirrored/)
    expect(GATE, '没读镜像的写入时间（等于无法判新旧）').toContain('readMapTilesFlagAgeMs()')
  })

  it('镜像过期或缺失才问后端，且有界等待；拿不到真值时旧副本顶着、否则放行', () => {
    expect(GATE.indexOf('apiGetPrivacyState') > GATE.indexOf('readMapTilesFlag()'),
      '问后端必须在读镜像之后').toBe(true)
    expect(GATE, '问后端没有超时上限').toContain('Promise.race')
    expect(DATA, '等待上限要写成具名常量，不要散魔法数').toMatch(/const FLAG_WAIT_MS = \d+/)
    // P3-9 把"新鲜期"也收成具名常量：散成字面量就没人知道这条 TTL 是刻意的
    expect(DATA, '镜像新鲜期要写成具名常量').toMatch(/const FLAG_FRESH_MS = \d+/)
    expect(GATE, '超时分支应放行（false），不是拦截').toMatch(/if \(hit === null\) return mirrored \?\? false/)
  })

  it('镜像只在**拿到后端真值**时写入；读不到要返回 null 而不是猜一个 false', () => {
    for (const name of ['apiGetPrivacyState', 'apiSetPrivacyState']) {
      const fn = sliceBetween(API, `export async function ${name}`, '\n}', name)
      expect(fn, `${name} 没有刷新镜像（开关改了地图还在用旧值）`).toContain('writeMapTilesFlag(')
    }
    expect(FLAG, '读不到镜像必须是 null（false 会被当成"已确认未禁止"）')
      .toMatch(/return raw === '1' \? true : raw === '0' \? false : null/)
    expect(FLAG, '写入入口要显式声明只接真值').toMatch(/export function writeMapTilesFlag\(blocked: boolean\)/)
  })

  it('闸门仍然包着唯一拉取点（S07 也守这条，这里留一份是为了本组能独立说清）', () => {
    expect(DATA).toMatch(/async function fetchFirstJson[\s\S]{0,200}mapTilesBlocked\(\)/)
  })

  it('慢加载要能自证在动：地区解析显示已用秒数（U2 约定）', () => {
    expect(MAP, '加载态没走秒').toContain('useElapsedSeconds(regionLoading)')
    expect(MAP, '文案里没有已用秒数').toMatch(/正在解析好友地区…已用 \$\{regionElapsed\}s/)
  })

  it('防空转：三个文件都真读到了', () => {
    atLeast(GATE.length, 300, 'mapTilesBlocked 函数体')
    atLeast(FLAG.length, 400, 'map-tiles-flag.ts 源码')
    atLeast(API.length, 5000, 'api-read.ts 源码')
    atLeast(DATA.length, 2000, 'world-map-data.ts 源码')
  })
})
