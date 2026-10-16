/**
 * 公共行政区划 GeoJSON 的**后端代理取回**。
 *
 * 渲染层曾经直接 `fetch` jsDelivr / unpkg / 阿里 DataV，绕过主机白名单与操作记录。
 * 这里只代取三组固定公开数据源：世界国名 GeoJSON、中国省级 GeoJSON、以及 DataV 的
 * 省市边界。URL 在发请求前逐条过白名单，拒绝一切不在固定形状内的地址。
 *
 * 数据不含用户聊天内容；取回后原样交回渲染层，由 ECharts 解析。
 */
import { fetchWithRetry } from '../net/fetch-retry.ts'
import type { MapGeoJsonResult } from '../types.ts'

/** 固定包镜像：世界国名数据（`world-map-data.ts` 的候选地址同源）。 */
const PINNED_GEO_PATHS = [
  '/npm/@surbowl/world-geo-json-zh@2.1.5/world.zh.json',
  '/@surbowl/world-geo-json-zh@2.1.5/world.zh.json',
  '/npm/chinese-global-compliant-geodata@1.0.0/dist/src/geojson/countries/as/chn/global/chn-level-1.json',
  '/chinese-global-compliant-geodata@1.0.0/dist/src/geojson/countries/as/chn/global/chn-level-1.json',
] as const

/** 阿里 DataV 边界接口只收六位 adcode 的 `_full` 查询。 */
const DATA_V_GEO_PATH = '/areas_v3/bound/geojson'
const DATA_V_CODE = /^\d{6}_full$/

/** 单次 RPC 最多代取几个候选地址，避免渲染层一次塞进任意长清单。 */
const MAX_GEO_URLS = 4
const GEO_TIMEOUT_MS = 20_000

/**
 * 该地址是否是地图模块允许取回的公共 GeoJSON 源。
 * @param raw - 渲染层传来的候选地址。
 * @returns true 才允许发请求；其余协议、主机、路径和查询参数都会拒绝。
 */
export function isAllowedMapGeoUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) return false
  if (url.host === 'cdn.jsdelivr.net' || url.host === 'unpkg.com') {
    return url.search === '' && PINNED_GEO_PATHS.includes(url.pathname as typeof PINNED_GEO_PATHS[number])
  }
  if (url.host === 'geo.datav.aliyun.com') {
    if (url.pathname !== DATA_V_GEO_PATH) return false
    const params = [...url.searchParams.entries()]
    const [[name = '', value = ''] = []] = params
    return params.length === 1 && name === 'code' && DATA_V_CODE.test(value)
  }
  return false
}

/**
 * 按候选顺序取回第一份可用的 GeoJSON。
 * @param urls - 候选地址；不在白名单里的项直接跳过。
 * @returns 已解析的 JSON，或首条可展示的失败原因。
 */
export async function fetchMapGeoJson(urls: readonly string[]): Promise<MapGeoJsonResult> {
  const candidates = [...new Set((Array.isArray(urls) ? urls : []).map((u) => String(u).trim()).filter(Boolean))]
    .filter(isAllowedMapGeoUrl)
    .slice(0, MAX_GEO_URLS)
  if (candidates.length === 0) {
    return { ok: false, error: '地图底图地址不在允许清单内，已拒绝请求' }
  }

  let lastError = '没有可用的地图数据源'
  for (const url of candidates) {
    try {
      const res = await fetchWithRetry(
        fetch,
        url,
        { headers: { Accept: 'application/json', 'User-Agent': 'super-time/1.0' } },
        { timeoutMs: GEO_TIMEOUT_MS },
      )
      if (!res.ok) throw new Error(`geo http ${String(res.status)}`)
      const data: unknown = await res.json()
      return { ok: true, data }
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e)
    }
  }
  return { ok: false, error: `地图底图拉取失败：${lastError}` }
}
