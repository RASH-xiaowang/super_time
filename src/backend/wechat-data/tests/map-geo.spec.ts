/**
 * 地图 GeoJSON 后端代理的 URL 白名单与候选顺序。
 *
 * 重点不是「JSON 能回来」，而是「不在白名单里的地址一个字节都不发」：
 * 渲染层传来的只是候选列表，真正出网前必须重新收敛。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchMapGeoJson, isAllowedMapGeoUrl } from '../src/query/map-geo.ts'

const WORLD_CDN = 'https://cdn.jsdelivr.net/npm/@surbowl/world-geo-json-zh@2.1.5/world.zh.json'
const CHINA_UNPKG = 'https://unpkg.com/chinese-global-compliant-geodata@1.0.0/dist/src/geojson/countries/as/chn/global/chn-level-1.json'
const DATA_V = 'https://geo.datav.aliyun.com/areas_v3/bound/geojson?code=450000_full'

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
  it('跳过白名单外的候选，成功取回第一份并原样给 JSON', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ features: [{ id: 1 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }))

    const result = await fetchMapGeoJson(['file:///etc/passwd', WORLD_CDN])
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

    const result = await fetchMapGeoJson([WORLD_CDN, CHINA_UNPKG])
    expect(calls).toEqual([WORLD_CDN, CHINA_UNPKG])
    expect(result).toEqual({ ok: true, data: { features: [{ id: 2 }] } })
  })

  it('所有候选失败或全被拒绝时不发白名单外请求，并给可读错误', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const rejected = await fetchMapGeoJson(['https://example.com/a.json'])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(rejected.ok).toBe(false)

    const failed = await fetchMapGeoJson([WORLD_CDN])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error).toContain('地图底图拉取失败')
  })
})
