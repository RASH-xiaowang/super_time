/**
 * 地图 GeoJSON 后端代理的 URL 白名单与候选顺序。
 *
 * 重点不是「JSON 能回来」，而是「不在白名单里的地址一个字节都不发」：
 * 渲染层传来的只是候选列表，真正出网前必须重新收敛。
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchMapGeoJson, isAllowedMapGeoUrl } from '../src/query/map-geo.ts'

const WORLD_CDN = 'https://cdn.jsdelivr.net/npm/@surbowl/world-geo-json-zh@2.1.5/world.zh.json'
const CHINA_UNPKG = 'https://unpkg.com/chinese-global-compliant-geodata@1.0.0/dist/src/geojson/countries/as/chn/global/chn-level-1.json'
const DATA_V = 'https://geo.datav.aliyun.com/areas_v3/bound/geojson?code=450000_full'
/** 下钻三层：中国省级 / 省→市 / 市→区。 */
const DATA_V_CHINA = 'https://geo.datav.aliyun.com/areas_v3/bound/geojson?code=100000_full'
const DATA_V_GUANGXI = 'https://geo.datav.aliyun.com/areas_v3/bound/geojson?code=450000_full'
const DATA_V_NANNING = 'https://geo.datav.aliyun.com/areas_v3/bound/geojson?code=450100_full'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('map GeoJSON 代理：白名单', () => {
  it('只允许三个固定公开源，且路径与查询形状必须精确', () => {
    expect(isAllowedMapGeoUrl(WORLD_CDN)).toBe(true)
    expect(isAllowedMapGeoUrl(CHINA_UNPKG)).toBe(true)
    expect(isAllowedMapGeoUrl(DATA_V)).toBe(true)

    expect(isAllowedMapGeoUrl('http://cdn.jsdelivr.net/npm/@surbowl/world-geo-json-zh@2.1.5/world.zh.json')).toBe(false)
    expect(isAllowedMapGeoUrl('https://cdn.jsdelivr.net/npm/other-package@1.0.0/index.json')).toBe(false)
    expect(isAllowedMapGeoUrl(`${WORLD_CDN}?x=1`)).toBe(false)
    expect(isAllowedMapGeoUrl('https://geo.datav.aliyun.com/areas_v3/bound/geojson?code=450000')).toBe(false)
    expect(isAllowedMapGeoUrl('https://geo.datav.aliyun.com/areas_v3/bound/geojson?code=450000_full&extra=1')).toBe(false)
    expect(isAllowedMapGeoUrl('https://example.com/world.zh.json')).toBe(false)
    expect(isAllowedMapGeoUrl('not a url')).toBe(false)
  })
})

describe('map GeoJSON 代理：取回', () => {
  /**
   * ⚠️ 2026-10-17：世界 GeoJSON 现在**随包分发**（`resources/geo/world.zh.json`），
   * `fetchMapGeoJson` 会先读本地。所以下面这些「走 CDN」的用例必须显式传
   * `() => null` 把本地读取器关掉 —— 否则本地一命中就返回，`fetch` 根本不会被调用，
   * 用例测的就不是 CDN 那条路了。
   */
  const NO_LOCAL = (): null => null

  it('跳过白名单外的候选，成功取回第一份并原样给 JSON', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ features: [{ id: 1 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))

    const result = await fetchMapGeoJson(['file:///etc/passwd', WORLD_CDN], NO_LOCAL)
    expect(calls).toEqual([WORLD_CDN])
    expect(result).toEqual({ ok: true, data: { features: [{ id: 1 }] } })
  })

  it('第一个候选非 2xx 时按顺序试下一个', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      const url = String(input)
      calls.push(url)
      if (url === WORLD_CDN) return new Response('nope', { status: 404 })
      return new Response(JSON.stringify({ features: [{ id: 2 }] }), { status: 200 })
    }))

    const result = await fetchMapGeoJson([WORLD_CDN, CHINA_UNPKG], NO_LOCAL)
    expect(calls).toEqual([WORLD_CDN, CHINA_UNPKG])
    expect(result).toEqual({ ok: true, data: { features: [{ id: 2 }] } })
  })

  it('所有候选失败或全被拒绝时不发白名单外请求，并给可读错误', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const rejected = await fetchMapGeoJson(['https://example.com/a.json'], NO_LOCAL)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(rejected.ok).toBe(false)

    const failed = await fetchMapGeoJson([WORLD_CDN], NO_LOCAL)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error).toContain('地图底图拉取失败')
  })
})

/**
 * 本地优先（2026-10-17）：世界国名 GeoJSON 随包分发，断网 / CDN 被墙时也能画出地图。
 *
 * 用户报的现象是「在线渲染会不显示地图」—— 根因就是这张底图**只从 CDN 拿**，
 * 拿不到时世界层是空白的，且重试也还是同一个 CDN。
 */
describe('map GeoJSON 代理：本地优先', () => {
  it('本地有世界 GeoJSON 时**一次网络都不发**', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const local = { type: 'FeatureCollection', features: [{ properties: { name: '中国' } }] }

    const r = await fetchMapGeoJson([WORLD_CDN], () => local)
    expect(r).toEqual({ ok: true, data: local })
    expect(fetchMock, '本地命中时不该出网').not.toHaveBeenCalled()
  })

  it('本地缺失时静默回退 CDN（开发态 / 老版本升级都可能没有这个文件）', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 })
    }))

    const r = await fetchMapGeoJson([WORLD_CDN], () => null)
    expect(calls).toEqual([WORLD_CDN])
    expect(r.ok).toBe(true)
  })

  it('随包分发的世界 GeoJSON 真实存在且是合法 FeatureCollection（防止打包漏带）', () => {
    const p = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'geo', 'world.zh.json')
    expect(existsSync(p), `随包 GeoJSON 不见了：${p}（打包配置的 asarUnpack 要包含 resources/**）`).toBe(true)
    const data = JSON.parse(readFileSync(p, 'utf8')) as { type?: string, features?: unknown[] }
    expect(data.type).toBe('FeatureCollection')
    expect(data.features?.length ?? 0, '世界 GeoJSON 的国家数太少，多半是坏文件').toBeGreaterThan(200)
  })
})

/**
 * 下钻地图（中国省级 / 省→市 / 市→区）也走本地（2026-10-17 用户要求
 * 「下钻的地图内容也要本地渲染，不要使用在线渲染」）。
 *
 * 数据由 `scripts/fetch-drill-geo.mjs` 生成到 `resources/geo/drill/<adcode>.json`：
 * 从 DataV 拉原始数据 → Douglas-Peucker 抽稀（容差 0.02°）+ 坐标截到 3 位小数。
 */
describe('map GeoJSON 代理：下钻地图本地优先', () => {
  const DRILL_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'geo', 'drill')

  it('中国省级（100000_full）本地命中时一次网络都不发', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const local = { type: 'FeatureCollection', features: [{ properties: { name: '广西', adcode: 450000 } }] }

    const r = await fetchMapGeoJson([DATA_V_CHINA], () => local)
    expect(r).toEqual({ ok: true, data: local })
    expect(fetchMock, '本地命中时不该出网').not.toHaveBeenCalled()
  })

  it('省→市（450000_full）本地命中时一次网络都不发', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const local = { type: 'FeatureCollection', features: [{ properties: { name: '南宁市', adcode: 450100 } }] }

    const r = await fetchMapGeoJson([DATA_V_GUANGXI], () => local)
    expect(r).toEqual({ ok: true, data: local })
    expect(fetchMock, '本地命中时不该出网').not.toHaveBeenCalled()
  })

  it('市→区（450100_full）本地命中时一次网络都不发', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const local = { type: 'FeatureCollection', features: [{ properties: { name: '青秀区', adcode: 450103 } }] }

    const r = await fetchMapGeoJson([DATA_V_NANNING], () => local)
    expect(r).toEqual({ ok: true, data: local })
    expect(fetchMock, '本地命中时不该出网').not.toHaveBeenCalled()
  })

  it('下钻数据本地缺失时静默回退 CDN', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200 })
    }))

    const r = await fetchMapGeoJson([DATA_V_GUANGXI], () => null)
    expect(calls).toEqual([DATA_V_GUANGXI])
    expect(r.ok).toBe(true)
  })

  it('随包分发的下钻文件真实存在（中国省级 + 广西 + 南宁）', () => {
    for (const [code, label] of [['100000', '中国省级'], ['450000', '广西'], ['450100', '南宁市']] as const) {
      const p = join(DRILL_DIR, `${code}.json`)
      expect(existsSync(p), `下钻 GeoJSON 不见了：${p}（跑 scripts/fetch-drill-geo.mjs 生成）`).toBe(true)
      const data = JSON.parse(readFileSync(p, 'utf8')) as { type?: string, features?: unknown[] }
      expect(data.type, `${label} 不是 FeatureCollection`).toBe('FeatureCollection')
      expect(data.features?.length ?? 0, `${label} 的要素数太少，多半是坏文件`).toBeGreaterThan(0)
    }
  })

  it('下钻文件确实被简化过（体积远小于原始 DataV 数据）', () => {
    // 原始 100000_full 约 569 KB；简化后应显著更小（实测约 212 KB）。
    const p = join(DRILL_DIR, '100000.json')
    const size = readFileSync(p).length
    expect(size, `中国省级简化后 ${String(size)} 字节，看起来没简化过`).toBeLessThan(400 * 1024)
  })

  /**
   * ⚠️ 上面几条都**注入**了 `readLocal`，绕过了生产默认实现 `readLocalForCandidates`。
   * 所以「按候选形状分派」这条逻辑必须**不注入**地单独验一次 ——
   * 否则把分派改成「一律读世界数据」时，注入的用例仍然全绿（M637 第一次就没咬住）。
   */
  it('默认实现按候选形状分派：DataV 地址读 drill/<adcode>.json，不读世界数据', async () => {
    // 不注入 readLocal ⇒ 走 readLocalForCandidates。
    const china = await fetchMapGeoJson([DATA_V_CHINA])
    expect(china.ok, '中国省级本地读取失败').toBe(true)
    if (china.ok) {
      const data = china.data as { features?: Array<{ properties?: { adcode?: unknown } }> }
      // 中国省级数据的要素带 adcode（世界数据没有）—— 这是「读对了文件」的判据。
      const hasAdcode = (data.features ?? []).some((f) => typeof f.properties?.adcode === 'number' || typeof f.properties?.adcode === 'string')
      expect(hasAdcode, '拿到的不是中国省级数据（多半被世界地图顶替了）').toBe(true)
      expect(data.features?.length ?? 0, '中国省级要素数不对').toBeGreaterThan(30)
    }
  })

  it('默认实现：世界数据与世界地图是两份不同的文件（不能互相顶替）', async () => {
    const world = await fetchMapGeoJson([WORLD_CDN])
    const china = await fetchMapGeoJson([DATA_V_CHINA])
    expect(world.ok && china.ok).toBe(true)
    if (world.ok && china.ok) {
      const w = world.data as { features?: unknown[] }
      const c = china.data as { features?: unknown[] }
      expect(w.features?.length, '世界数据要素数不对').toBeGreaterThan(200)
      expect(c.features?.length, '中国省级要素数不对').toBeGreaterThan(30)
      expect(w.features?.length, '世界与中国省级拿到了同一份数据（分派坏了）').not.toBe(c.features?.length)
    }
  })

  /**
   * ⚠️ 上面「下钻本地命中」那几条都**注入**了 `readLocal`，绕过了生产默认实现。
   * 所以「下钻真的读本地」必须**不注入**地验一次 —— 否则把 `readLocalDrillGeo`
   * 那段删掉时，注入的用例仍然全绿（M638 第一次就没咬住）。
   *
   * 判据：断网（stub fetch 抛错）时下钻仍能拿到数据 ⇒ 只可能来自本地文件。
   */
  it('默认实现：断网时下钻三层仍能拿到数据（只可能来自本地文件）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    for (const [label, url, minFeatures] of [
      ['中国省级', DATA_V_CHINA, 30],
      ['广西（省→市）', DATA_V_GUANGXI, 10],
      ['南宁（市→区）', DATA_V_NANNING, 5],
    ] as const) {
      const r = await fetchMapGeoJson([url])
      expect(r.ok, `${label} 断网时拿不到数据 —— 本地读取没生效`).toBe(true)
      if (r.ok) {
        const d = r.data as { features?: unknown[] }
        expect(d.features?.length ?? 0, `${label} 要素数不对`).toBeGreaterThan(minFeatures)
      }
    }
  })
})
