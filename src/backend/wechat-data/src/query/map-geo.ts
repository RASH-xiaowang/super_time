/**
 * 公共行政区划 GeoJSON 的**后端代理取回**。
 *
 * 渲染层曾经直接 `fetch` jsDelivr / unpkg / 阿里 DataV，绕过主机白名单与操作记录。
 * 这里只代取三组固定公开数据源：世界国名 GeoJSON、中国省级 GeoJSON、以及 DataV 的
 * 省市边界。URL 在发请求前逐条过白名单，拒绝一切不在固定形状内的地址。
 *
 * 数据不含用户聊天内容；取回后原样交回渲染层，由 ECharts 解析。
 *
 * ## 本地优先（2026-10-17）
 *
 * 世界国名 GeoJSON 现在**随包分发**（`resources/geo/world.zh.json`，约 300 KB）：
 * 先读本地文件，读不到才走 CDN。理由：这张图是「打开就要看到」的底图，
 * 而 CDN 在断网 / 被墙 / 公司代理下都拿不到 —— 那时用户看到的是**空白地图**，
 * 且没有任何可操作的补救（重试也还是同一个 CDN）。
 *
 * 本地文件缺失时**不报错**，静默回退到 CDN —— 开发态（未打包）与老版本升级
 * 都可能没有这个文件，那时行为与改动前完全一致。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
 * 随包分发的世界 GeoJSON 文件名（`resources/geo/` 下）。
 *
 * 与 `PINNED_GEO_PATHS` 的第一条**同源同版本**（`@surbowl/world-geo-json-zh@2.1.5`）——
 * 本地与在线必须是同一份数据，否则「有网」和「没网」会画出两张不同的地图。
 */
const LOCAL_WORLD_GEO = 'world.zh.json'

/**
 * 下钻地图（中国省级 / 省→市 / 市→区）的本地目录（`resources/geo/drill/` 下）。
 *
 * 文件名 = `<adcode>.json`（如 `100000.json` = 中国省级、`450000.json` = 广西、
 * `450100.json` = 南宁市）。由 `scripts/fetch-drill-geo.mjs` 生成：
 * 从 DataV 拉原始数据 → Douglas-Peucker 抽稀（容差 0.02°）+ 坐标截到 3 位小数。
 * 全量约 2.8 MB（34 省 + 329 市），随包分发。
 */
const LOCAL_DRILL_DIR = 'drill'

/**
 * 本地 GeoJSON 的候选目录（按顺序试）。
 *
 * ⚠️ **`import.meta.url` 指向的是 esbuild 打出来的 bundle**（`lib/index.js`），
 * 不是本源码文件（`src/query/map-geo.ts`）—— 所以候选路径要按 **bundle 的位置**算：
 *
 *   · 开发态：`<repo>/src/backend/wechat-data/lib/index.js`
 *     → `../resources/geo` = `<repo>/src/backend/wechat-data/resources/geo` ✅
 *   · 打包态：`app.asar/lib/index.js`，而 `resources/` 被 `asarUnpack` 解到
 *     `app.asar.unpacked/src/backend/wechat-data/resources/geo` —— 相对 bundle 仍是
 *     `../resources/geo`（asar 的 unpacked 目录与 asar 内路径**同构**）。
 *
 * 所以 `../resources/geo` 一条就够；另外两条是给「bundle 被挪到别处」的兜底
 * （读不到就下一个，全读不到才回退 CDN —— 不会因为路径猜错就画不出图）。
 * @returns 候选绝对路径列表。
 */
function localGeoDirs(): string[] {
  const out: string[] = []
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    // 主路径：bundle 在 lib/ 下，resources 与 lib 同级（开发态与打包态同构）。
    out.push(join(here, '..', 'resources', 'geo'))
    // 兜底：万一 bundle 被嵌进更深一层（如 lib/query/index.js）。
    out.push(join(here, '..', '..', 'resources', 'geo'))
    out.push(join(here, '..', '..', '..', 'resources', 'geo'))
  } catch {
    /* 拿不到 import.meta.url（极少数打包形态）—— 直接走 CDN */
  }
  return out
}

/**
 * 读一个本地 GeoJSON 文件（相对 `resources/geo/`）。
 * @param rel - 相对路径（如 `world.zh.json` 或 `drill/450000.json`）。
 * @returns 已解析的 JSON；本地没有或解析失败时返回 null（调用方回退 CDN）。
 */
function readLocalGeo(rel: string): unknown | null {
  for (const dir of localGeoDirs()) {
    try {
      const raw = readFileSync(join(dir, rel), 'utf8')
      const data: unknown = JSON.parse(raw)
      // 形状自检：不是 FeatureCollection 就当没读到（宁可走 CDN 也不要画一张空图）。
      if (data !== null && typeof data === 'object' && (data as { type?: unknown }).type === 'FeatureCollection') {
        return data
      }
    } catch {
      /* 这个目录没有，试下一个 */
    }
  }
  return null
}

/**
 * 读随包分发的世界 GeoJSON。
 * @returns 已解析的 JSON；本地没有或解析失败时返回 null（调用方回退 CDN）。
 */
function readLocalWorldGeo(): unknown | null {
  return readLocalGeo(LOCAL_WORLD_GEO)
}

/**
 * 从 DataV 地址里取出 adcode（`?code=450000_full` → `450000`）。
 * @param url - 候选地址。
 * @returns 六位 adcode，或 null（不是 DataV 地址 / 形状不对）。
 */
function dataVAdcode(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.host !== 'geo.datav.aliyun.com') return null
    const code = u.searchParams.get('code') ?? ''
    const m = /^(\d{6})_full$/.exec(code)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * 读随包分发的下钻 GeoJSON（中国省级 / 省→市 / 市→区）。
 * @param adcode - 六位 adcode。
 * @returns 已解析的 JSON；本地没有时返回 null（调用方回退 CDN）。
 */
function readLocalDrillGeo(adcode: string): unknown | null {
  return readLocalGeo(`${LOCAL_DRILL_DIR}/${adcode}.json`)
}

/**
 * 按候选地址的形状选本地文件（生产默认实现）。
 *
 * **两类数据不能混用**：拿世界地图去冒充省界会画出一张错图。
 *   · 候选里有 `world.zh.json` → 读世界数据；
 *   · 候选是 DataV 地址（`?code=<adcode>_full`）→ 读 `drill/<adcode>.json`。
 * 两者都没有 → 返回 null（走 CDN）。
 * @param candidates - 已过白名单的候选地址。
 * @returns 已解析的 JSON，或 null。
 */
function readLocalForCandidates(candidates: readonly string[]): unknown | null {
  if (candidates.some((u) => u.includes('world.zh.json'))) {
    return readLocalWorldGeo()
  }
  for (const u of candidates) {
    const adcode = dataVAdcode(u)
    if (adcode !== null) {
      const local = readLocalDrillGeo(adcode)
      if (local !== null) return local
    }
  }
  return null
}

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
 * @param readLocal - 本地读取器（默认按候选地址自动选：世界数据读 `world.zh.json`，
 *   DataV 地址读 `drill/<adcode>.json`）。
 *
 *   **为什么要能注入**：单测要分别验证「本地命中」与「本地缺失 → 走 CDN」两条路，
 *   而本地文件在仓库里是**真实存在**的（`resources/geo/`）——
 *   不注入的话「走 CDN」那条用例永远测不到（本地一命中就返回了）。
 *   生产调用方不传，用默认实现。
 * @returns 已解析的 JSON，或首条可展示的失败原因。
 */
export async function fetchMapGeoJson(
  urls: readonly string[],
  readLocal?: (urls: readonly string[]) => unknown | null,
): Promise<MapGeoJsonResult> {
  const candidates = [...new Set((Array.isArray(urls) ? urls : []).map((u) => String(u).trim()).filter(Boolean))]
    .filter(isAllowedMapGeoUrl)
    .slice(0, MAX_GEO_URLS)
  if (candidates.length === 0) {
    return { ok: false, error: '地图底图地址不在允许清单内，已拒绝请求' }
  }

  /*
   * ① 本地优先（2026-10-17）：所有地图 GeoJSON 都随包分发，先读本地。
   *
   * 两类数据各有本地副本，**按候选地址的形状分派**（不能混用 —— 拿世界地图去冒充
   * 省界会画出一张错图）：
   *   · 世界国名数据（`world.zh.json`）→ `resources/geo/world.zh.json`；
   *   · DataV 地址（`?code=<adcode>_full`）→ `resources/geo/drill/<adcode>.json`。
   *
   * 本地缺失时**静默回退 CDN** —— 开发态（未跑 `fetch-drill-geo.mjs`）与老版本升级
   * 都可能没有这些文件，那时行为与改动前完全一致。
   */
  const local = readLocal !== undefined ? readLocal(candidates) : readLocalForCandidates(candidates)
  if (local !== null) return { ok: true, data: local }

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
