/**
 * World GeoJSON source and helpers for the ECharts world map.
 *
 * The host region snapshot (query/region-map.ts) emits Chinese country labels.
 * The chosen data set (@surbowl/world-geo-json-zh, deprecated but stable) ships
 * a world GeoJSON whose feature names are already Chinese, so no ISO-code table
 * is needed on the client. URLs are tried in order at runtime; when none is
 * reachable the world layer says so explicitly —— 2026-09-26 地理 SVG 已按用户要求移除，
 * 不再有离线底图可回退（这句原来写的是 “falls back to the offline SVG map”）。
 *
 * 网络请求已收口到后端 `getMapGeoJson`：本文件只保留候选地址、名称匹配与首份选择，
 * 不再直接 `fetch`。
 *
 * 底图是**本地优先**的：后端拿到候选地址后先读随包的 `resources/geo/world.zh.json`
 * （见 `src/backend/wechat-data/src/query/map-geo.ts`），只有本地缺失才回退 CDN。
 * 但「本地优先」仍要经过主进程的全局调用闸：应用刚启动时首屏请求会把队列打满，
 * 这次静态文件读取也会被 `REMOTE_BUSY` 拒绝，界面于是误报「底图不可用」。
 * 所以这里对**队列繁忙**做退避重试（400/1200/3000ms），其余错误立即失败。
 */
import type { RegionNode } from '@deepseek-ai/dsh-wechat-data/types'
import { apiGetMapGeoJson } from '../api-media.ts'

/** World GeoJSON fetch candidates, pinned to an immutable version. */
export const WORLD_GEO_URLS = [
  'https://cdn.jsdelivr.net/npm/@surbowl/world-geo-json-zh@2.1.5/world.zh.json',
  'https://unpkg.com/@surbowl/world-geo-json-zh@2.1.5/world.zh.json',
] as const

/** One GeoJSON feature's properties (name key varies across sources). */
export interface WorldGeoFeature {
  properties?: Record<string, unknown>
}

/** Variant feature names (Chinese or English) -> snapshot's canonical label. */
const WORLD_NAME_ALIASES: Readonly<Record<string, string>> = {
  China: '中国',
  中国香港: '中国香港',
  香港: '中国香港',
  'Hong Kong': '中国香港',
  中国澳门: '中国澳门',
  澳门: '中国澳门',
  Macao: '中国澳门',
  Macau: '中国澳门',
  中国台湾: '中国台湾',
  台湾: '中国台湾',
  Taiwan: '中国台湾',
  'United States': '美国',
  'United States Minor Outlying Islands': '美国本土外小岛屿',
  'United Kingdom': '英国',
  'Republic of Korea': '韩国',
  大韩民国: '韩国',
  "Democratic People's Republic of Korea": '朝鲜',
  朝鲜民主主义人民共和国: '朝鲜',
  Russia: '俄罗斯',
  俄罗斯联邦: '俄罗斯',
  Czechia: '捷克',
  'Czech Republic': '捷克',
  捷克共和国: '捷克',
  'Bosnia and Herzegovina': '波黑',
  波斯尼亚和黑塞哥维那: '波黑',
}

/**
 * Read the feature name used for registration and matching.
 * @param feature - one world GeoJSON feature.
 * @returns the feature name, or '' when the feature carries none.
 */
export function worldFeatureName(feature: WorldGeoFeature): string {
  const p = feature.properties
  const name = p?.name
  if (typeof name === 'string' && name) return name
  const upper = p?.NAME
  if (typeof upper === 'string' && upper) return upper
  return ''
}

/**
 * Match a GeoJSON feature name to a region snapshot child.
 * @param children - region snapshot children (countries).
 * @param name - feature name from the GeoJSON.
 * @returns the matching child, or null when unrecognised.
 */
export function worldChildByName(children: readonly RegionNode[], name: string): RegionNode | null {
  const exact = children.find(c => c.name === name)
  if (exact) return exact
  const alias = WORLD_NAME_ALIASES[name]
  if (!alias) return null
  return children.find(c => c.name === alias) ?? null
}

/**
 * Region children that have no feature in the GeoJSON.
 *
 * The chosen data set merges a few Chinese territories (中国香港/中国澳门/中国台湾)
 * into 中国, so those snapshot labels cannot be shaded or clicked on the map; they
 * are surfaced as chips so the drill still works.
 * @param children - region snapshot children (countries).
 * @param features - world GeoJSON features.
 * @returns the unmatched children, in snapshot order.
 */
export function worldUnmatchedChildren(children: readonly RegionNode[], features: readonly WorldGeoFeature[]): RegionNode[] {
  const matched = new Set<string>()
  for (const f of features) {
    const name = worldFeatureName(f)
    const child = name ? worldChildByName(children, name) : null
    if (child) matched.add(child.key)
  }
  return children.filter(c => !matched.has(c.key))
}

/**
 * 已取到的 GeoJSON，按 URL 列表的拼接键缓存。
 *
 * 为什么需要：`ChinaMap` / `ProvinceMap` 都不传 `geo`，每次挂载都要 `fetchFirstJson`。
 * 而底图是**静态资源**（同一份 GeoJSON 永远一样），重复出网既慢又给了「网络抖动 ⇒
 * 地图空白」的机会（实测下钻中国层偶发空白，就是这一次 fetch 失败触发了 `onFallback`）。
 * 缓存后：同一层反复进出**同步命中**，不再有空白窗口。
 *
 * ⚠️ 只缓存**成功**结果。失败不写缓存 —— 否则一次抖动会让该层永久空白。
 */
const GEO_CACHE = new Map<string, unknown>()

/**
 * 是否为「队列繁忙」这类**可重试**的临时失败。
 *
 * 主进程调用闸（`src/backend/http-queue.js`）在并发 2 / 排队 32 打满时直接拒绝，
 * 错误码 `REMOTE_BUSY`、文案「远程调用太密集…」。IPC 包一层后只剩 message，
 * 所以按文案与错误码一起判。
 * @param message - 后端/remote 返回的错误信息。
 * @returns 值得退避重试时为 true。
 */
function isBusyError(message: string): boolean {
  return /远程调用太密集|排队已满|REMOTE_BUSY/.test(message)
}

/**
 * Fetch the first GeoJSON candidate that answers with a 2xx response.
 * 实际出网由后端代理完成（本地优先，见文件头注释）；这里只负责把失败原因转成可捕获异常。
 * @param urls - candidate URLs in preference order.
 * @returns the parsed JSON body.
 * @throws when every candidate fails (network, non-2xx or parse error).
 */
export async function fetchFirstJson(urls: readonly string[]): Promise<unknown> {
  const key = urls.join('\n')
  const hit = GEO_CACHE.get(key)
  if (hit !== undefined) return hit
  const retryDelays = [400, 1200, 3000]
  let lastError = ''
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await apiGetMapGeoJson(urls)
      if (result.ok) {
        GEO_CACHE.set(key, result.data)
        return result.data
      }
      lastError = result.error
    } catch (e) {
      // `unwrap` 会把 `{ok:false}` 转成异常抛出（REMOTE_BUSY 也在其中），必须一起接住。
      lastError = e instanceof Error ? e.message : String(e)
    }
    if (attempt >= retryDelays.length || !isBusyError(lastError)) break
    await new Promise<void>((resolve) => setTimeout(resolve, retryDelays[attempt]))
  }
  throw new Error(lastError)
}
