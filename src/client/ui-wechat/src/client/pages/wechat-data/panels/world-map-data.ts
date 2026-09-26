/**
 * World GeoJSON source and helpers for the ECharts world map.
 *
 * The host region snapshot (query/region-map.ts) emits Chinese country labels.
 * The chosen data set (@surbowl/world-geo-json-zh, deprecated but stable) ships
 * a world GeoJSON whose feature names are already Chinese, so no ISO-code table
 * is needed on the client. URLs are tried in order at runtime; when none is
 * reachable the world layer says so explicitly —— 2026-09-26 地理 SVG 已按用户要求移除，
 * 不再有离线底图可回退（这句原来写的是 “falls back to the offline SVG map”）。
 */
import type { RegionNode } from '@deepseek-ai/dsh-wechat-data/types'
import { readMapTilesFlag, readMapTilesFlagAgeMs, writeMapTilesFlag } from '../map-tiles-flag.ts'

/** 镜像缺失时等后端开关的上限：超过就按「读不到」放行（理由见下）。 */
const FLAG_WAIT_MS = 2000

/**
 * 镜像的**新鲜期**（P3-9）：这之内可以直接采信（0ms、不进队列）；
 * 过了就必须回去问后端真值 —— 镜像只是副本，它可能是另一个窗口改之前的、
 * 也可能是渲染层别处改写的。取 15 秒的量级：地图是用户点开才拉的，
 * 一次有界等待（最多 {@link FLAG_WAIT_MS}）换回"开关以你刚设的那个为准"。
 */
const FLAG_FRESH_MS = 15_000

/**
 * 地图底图出网闸（2026-09-26）。
 *
 * 为什么闸门在这里：本模块的 `fetchFirstJson` 是**全部**地图 GeoJSON 的唯一
 * 拉取点（世界层、中国层、省级下钻都走它），所以一处关闭就全关 —— 不必去每个
 * 地图组件里各写一遍，也就不会漏掉将来新增的那个。
 *
 * **判断顺序（2026-09-26 改成"先镜像、后有界等待"，起因是用户报「世界地图一直
 * 在加载中」；同日 P3-9 又把"先镜像"收成"先**新鲜**的镜像"）**：
 * 先读渲染层本地镜像（`../map-tiles-flag.ts`，一次 localStorage 读，0ms、不进队列），
 * **且只在它还在新鲜期内采信**；镜像缺失或过期都回去问后端（有界等待 {@link FLAG_WAIT_MS}）。
 * 于是"改写 localStorage 就能长关/长开放行"这条路被 TTL 挡住 —— 副本过期就不是答案了，
 * 拉底图前一定要再过一次后端真值。
 *
 * 为什么不能直接 await 后端：后端是**同步串行**的。用户会话日志实测
 * `analyzeVisibleMessages` 单次 54,103ms、`getRemoteImages` 八个各 45,000~51,000ms、
 * `getWordCloud` 2,6xx ms 反复重跑 —— 排在这些后面的 RPC 要等几十秒，于是底图
 * **连"开始拉"都还没轮到**，世界层只剩一句静止的「正在解析好友地区…」，看上去像卡死。
 * 这就是为什么快路留着、而等待必须**有界**。
 *
 * 什么都不知道时**放行**（宁可出网也不要整张地图空白）：这与后端隐私闸
 * 「读不到就拦」的方向相反，是刻意的不对称 —— 那边拦下的是用户内容，这边只是
 * 一份公开的行政区划 GeoJSON。有过期镜像时先拿它顶着（那是后端真值的旧副本，
 * 比"什么都没有"更接近真相），异常与超时同属"读不到真值"，走同一条兜底。
 * @returns true 表示已禁止拉取底图。
 */
async function mapTilesBlocked(): Promise<boolean> {
  // ① 本地镜像**且还在新鲜期内**：一次 localStorage 读就够（0ms、不进队列）。
  const mirrored = readMapTilesFlag()
  const ageMs = readMapTilesFlagAgeMs()
  if (mirrored !== null && ageMs !== null && ageMs <= FLAG_FRESH_MS) return mirrored
  // ② 镜像缺失或过期 ⇒ 以后端真值为准，且**不许无限等**：超时按"读不到真值"处理。
  try {
    // 动态 import：避免与 api.ts 形成顶层循环依赖（api 桶会引到面板层）。
    const { apiGetPrivacyState } = await import('../api.ts')
    const hit = await Promise.race([
      apiGetPrivacyState().then(s => s.blockMapTiles === true).catch(() => null),
      new Promise<null>(resolve => { setTimeout(() => resolve(null), FLAG_WAIT_MS) }),
    ])
    if (hit === null) return mirrored ?? false
    writeMapTilesFlag(hit)
    return hit
  } catch {
    return mirrored ?? false
  }
}

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
 * Fetch the first GeoJSON candidate that answers with a 2xx response.
 * @param urls - candidate URLs in preference order.
 * @returns the parsed JSON body.
 * @throws when every candidate fails (network, non-2xx or parse error).
 */
export async function fetchFirstJson(urls: readonly string[]): Promise<unknown> {
  if (await mapTilesBlocked()) {
    throw new Error('地图底图出网已在「数据边界与出网 → 禁止地图底图出网」里关闭')
  }
  let lastError: Error | null = null
  for (const url of urls) {
    try {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`geo http ${res.status}`)
      return await res.json()
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e))
    }
  }
  throw lastError ?? new Error('no geo source')
}
