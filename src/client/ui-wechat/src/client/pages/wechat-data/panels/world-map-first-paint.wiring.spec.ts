
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
 *  ③ **底图拉不到要给明确说明**（未联网 / 镜像源不可达），不留一片空白。
 *  ④ **中国层 ECharts 起不来落到 treemap** —— SVG 走后，它接管了原来的兜底位置
 *     （省 / 市两层本来就是这条降级路径）。
 *  ⑤ **底图取数不再问任何开关**（2026-09-30 出网开关全移除）：原先 `fetchFirstJson`
 *     要先问一次「禁止地图底图出网」开关，那是一次同步 RPC，排在后端长任务后面要等
 *     几十秒 ⇒ 底图连"开始拉"都还没轮到。现在开关与 `map-tiles-flag.ts` 本地镜像都删了，
 *     取数口直接 `fetch(url)`；本文件只保留「加载态要能自证在动」（U2 约定）这条判据。
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { atLeast, findRoot, readStripped, readText, sliceBetween } from '../../../test-helpers/wiring-kit.ts'

const HERE = import.meta.dirname
const MAP = readStripped(join(HERE, 'WorldMap.tsx'))
const GEO = readStripped(join(HERE, 'world-geo.ts'))
const CSS = readText(join(HERE, 'world-map.module.css'))

const DATA = readStripped(join(HERE, 'world-map-data.ts'))

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
    // 2026-09-30：不再有「禁止地图底图出网」开关，原因只剩「镜像源取不到」。
    expect(tip, '提示要说清原因（镜像源取不到行政区划数据）').toContain('地图底图不可用')
    expect(tip, '要指个去处，否则用户以为数据丢了').toContain('省份 / 城市榜单')
  })

  it('产品文案与文档**都不许再承诺「改用离线视图」**（那个视图已被删）', () => {
    const privacy = readStripped(join(HERE, 'PrivacyTrust.tsx'))
    expect(privacy.includes('离线视图'), 'SVG 已删，界面不能再承诺离线视图').toBe(false)
    // 文档侧守「必须如实写出代价」而不是「不许出现某个词」—— 后者会把
    // 「说明历史时引用旧承诺」也判成违规（这条断言的第一版就撞了这个坑）。
    const doc = readText(join(findRoot(HERE), 'docs', 'PRIVACY.md'))
    // 2026-09-30：文档口径改成「拉不到时世界层显示『底图不可用』说明，不再回退到那张
    // 已删的自绘 SVG」—— 守的是同一件事：代价与去处都必须写出来，不许只写好处。
    expect(doc, 'PRIVACY.md 必须如实写出代价：拉不到底图时给的是说明，不是离线底图').toContain('底图不可用')
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

describe('⑤ 取数口不再问开关（出网开关与本地镜像都已删除）', () => {
  it('底图取数口里没有闸门、也没有本地镜像（fetchFirstJson 直接 fetch）', () => {
    // 2026-09-30：`mapTilesBlocked()` 与 `map-tiles-flag.ts` 整体删除。
    // 这一条防的是「有人把那个先读镜像、再问后端的排队路径搬回来」。
    expect(DATA, '取数口里又长回了底图闸门').not.toContain('mapTilesBlocked')
    expect(DATA, '取数口里又长回了本地镜像').not.toContain('readMapTilesFlag')
    expect(DATA, 'fetchFirstJson 没有直接 fetch 候选地址').toMatch(/async function fetchFirstJson[\s\S]{0,240}await fetch\(url\)/)
    expect(MAP, 'WorldMap 又去问隐私开关了').not.toContain('apiGetPrivacyState')
  })

  it('慢加载要能自证在动：地区解析显示已用秒数（U2 约定）', () => {
    expect(MAP, '加载态没走秒').toContain('useElapsedSeconds(regionLoading)')
    // 文案在加载态组件 `RegionLoading` 里（该组件与取数策略一同外提，见下方 ⑥）；
    // 秒数由调用方以 `elapsed` 传进去 —— 断言的是"这句话里确实有走秒"，不是它住在哪个文件。
    expect(MAP, '文案里没有已用秒数').toMatch(/正在解析好友地区…已用 \$\{elapsed\}s/)
    expect(MAP, '加载态组件没有接收走秒值').toMatch(/<RegionLoading elapsed=\{regionElapsed\}/)
  })

  it('防空转：两个文件都真读到了', () => {
    atLeast(MAP.length, 5000, 'WorldMap.tsx 源码')
    atLeast(DATA.length, 2000, 'world-map-data.ts 源码')
  })
})

/**
 * ⑥ 地区快照自己也要有界 + 首屏缓存（2026-09-28 补，症状见截图口径）。
 *
 * 底图闸门修好之后，同一页还有第二条会「一直加载中」的路：**`getRegionMap` 自身**。
 * 它后端只要 ~11ms（`PERF-AUDIT-172` 实测冷 11 / 热 8，并刻意不加后端缓存），
 * 但 worker 同步串行 ⇒ 排在长任务后面时这一次 RPC 要等几十秒。此时底图早已画好，
 * 而 `map` 仍是 null，页面就停在「共 0 位好友有地区 + 正在解析…」——
 * 与 ⑤ 是同一族问题，只是发生在另一条调用上。
 *
 * 取数策略住在 `world-map-region-load.ts`：`WorldMapPanel` 的函数体已被
 * `function-size-ratchet.spec.ts` 登记（棘轮只许变小），所以这块**必须**外提
 * （见该模块头注与 `docs/CONTRIBUTING.md` §4）。
 */
describe('⑥ 地区快照的有界等待与首屏缓存', () => {
  const LOAD = readStripped(join(HERE, 'world-map-region-load.ts'))

  it('等待必须写成具名常量，且真的用 Promise.race 收敛', () => {
    expect(LOAD, '等待上限要写成具名常量，不要散魔法数').toMatch(/export const REGION_MAP_WAIT_MS = \d+/)
    expect(LOAD, '没有超时上限 —— 排在长任务后面会无限转圈').toContain('Promise.race')
    expect(LOAD, '超时后要清掉定时器，别让它在调用方卸载后还活着').toContain('clearTimeout(timer)')
  })

  it('首屏缓存：初值直接来自 readRenderCache（再进这一页立刻有数据）', () => {
    expect(LOAD, '没有首屏渲染缓存 —— 每次进这一页都要重排后端队列')
      .toMatch(/readRenderCache<RegionMapSnapshot>\(REGION_MAP_CACHE_KEY\)/)
    expect(LOAD, '缓存键要写成具名常量').toMatch(/export const REGION_MAP_CACHE_KEY = '/)
    // 组件侧必须用这个同步初值，而不是 null 起步（null 起步 = 每次都要等队列）。
    expect(MAP, '组件没有用首屏缓存的同步初值').toContain('useState<RegionMapSnapshot | null>(initialRegionMap)')
  })

  it('成功才写缓存；超时不许把已有旧快照盖成错误', () => {
    expect(LOAD, '拿到结果后没有写缓存 ⇒ 首屏缓存永远是空的').toContain('writeRenderCache(REGION_MAP_CACHE_KEY, map)')
    // 反例：有旧快照时还弹错误，等于把可用数据换成一个没有信息量的报错。
    expect(MAP, '有旧快照时不该用超时错误盖掉它').toMatch(/if \(!hasCachedRegionMap\(\)\) setError\(REGION_MAP_TIMEOUT_TEXT\)/)
  })

  it('超时文案必须是可行动的（指出原因 + 给出路），不是"加载失败"这种空话', () => {
    expect(LOAD, '超时文案要指出后端在排队').toContain('后端在按顺序处理请求')
    expect(LOAD, '超时文案要给出路（重试）').toContain('重试')
    // 加载态里真的要有那个按钮 —— 文案让用户"点重试"，就得有东西可点。
    expect(MAP, '加载态里没有重试按钮，文案就是空头支票').toContain('onClick={onRetry}>重试</button>')
    // 按钮只在等了几秒之后才出现（一进来就闪一个"重试"会让人以为已经失败了）。
    expect(MAP, '重试按钮没有"等几秒再出现"的门槛').toMatch(/elapsed >= 3 && <button/)
  })

  it('防空转：这几条判据读到的确实是本包的源码', () => {
    atLeast(MAP.length, 8000, 'WorldMap.tsx 源码')
    atLeast(LOAD.length, 1200, 'world-map-region-load.ts 源码')
  })
})
