/**
 * 地区快照的取数策略（2026-09-28 从 `WorldMap.tsx` 外提）。
 *
 * ## 为什么单独成文件
 *
 * `WorldMapPanel` 的函数体已经被 `function-size-ratchet.spec.ts` 登记
 * （`KNOWN_BIG` 里是 313 行，棘轮**只许变小**）。这次要给它加"有界等待 + 首屏缓存"，
 * 直接写在组件里会把它顶到 343 行 —— 而本仓的规矩是
 * 「加两行注释都会拦，**删注释是错的方向**，正确做法是把整块搬出去」
 * （`docs/CONTRIBUTING.md` §4）。搬出来之后组件回到 313 以内，判据也更好写。
 *
 * ## 为什么要"有界"
 *
 * 后端是**同步串行**的 worker。`getRegionMap` 自身只要 ~11ms
 * （冷 11ms / 热 8ms，并**刻意不加后端缓存**
 * ——「只有 11ms，加缓存会引入数据不刷新风险，收益不成比例」），但排在长任务
 * （语音转写 / 原图抓取 / 词云）后面时要等几十秒。
 *
 * 症状：世界层的底图（一条前端 fetch）早画好了，而 `map` 仍是 `null` ⇒ 页面停在
 * 「共 **0** 位好友有地区 + 正在解析…」——那句 "0" 是 `map?.total ?? 0` 的兜底，
 * **不是**"好友真的都没有地区"。用户在截图里看到的就是这个组合。
 *
 * 同一页的底图闸门在 2026-09-26 已按"先镜像 + 有界等待"修过（`world-map-data.ts`），
 * 这里是同一族问题的另一条调用。
 */
import type { RegionMapSnapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { apiGetRegionMap } from '../api.ts'
import { readRenderCache, writeRenderCache } from '../cache.ts'

/** 首屏渲染缓存的键（本面板一次只持有一份地区快照）。 */
export const REGION_MAP_CACHE_KEY = 'world-region-map:v1'

/**
 * 地区快照的等待上限。
 *
 * 取 8 秒：正常排队（词云 ~2s 那一档）等得到；真遇到 30s+ 的长任务时，
 * 与其让用户对着一个没有终点的转圈，不如给一句能行动的说明 + 重试入口。
 */
export const REGION_MAP_WAIT_MS = 8000

/** 超时文案：指出真实原因（后端在排队）并给出路（重试），不谎报"加载失败"。 */
export const REGION_MAP_TIMEOUT_TEXT =
  '好友地区解析超时：后端在按顺序处理请求，可能有长任务（语音转写 / 原图抓取 / 词云）正在跑。'
  + '稍后点「重试」即可，不影响其它面板。'

/** 一次取数的结果：要么拿到快照，要么拿到一句可读的原因。 */
export type RegionMapOutcome =
  | { kind: 'ok'; map: RegionMapSnapshot }
  | { kind: 'error'; message: string }
  /** 超时。有旧快照时调用方应**忽略它**（旧数据可用，不该被错误盖掉）。 */
  | { kind: 'timeout' }

/** 首次进入时的同步初值：上次成功渲染过的快照，没有则 `null`。 */
export function initialRegionMap(): RegionMapSnapshot | null {
  return readRenderCache<RegionMapSnapshot>(REGION_MAP_CACHE_KEY)
}

/** 是否已有可用的旧快照（决定超时要不要弹错误）。 */
export function hasCachedRegionMap(): boolean {
  return readRenderCache<RegionMapSnapshot>(REGION_MAP_CACHE_KEY) !== null
}

/**
 * 取一次地区快照，**有界等待**。
 *
 * 超时不抛错、也不返回 `ok`：它只是"还没轮到"，由调用方决定如何呈现。
 * @returns 三态结果（见 {@link RegionMapOutcome}）。
 */
export async function fetchRegionMapBounded(): Promise<RegionMapOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), REGION_MAP_WAIT_MS)
  })
  try {
    const raced = await Promise.race([
      apiGetRegionMap().then((map) => map, (e: unknown) => ({ __err: (e as Error).message })),
      timeout,
    ])
    if (raced === null) return { kind: 'timeout' }
    if (raced !== null && typeof raced === 'object' && '__err' in raced) {
      return { kind: 'error', message: String((raced as { __err: string }).__err) }
    }
    return { kind: 'ok', map: raced as RegionMapSnapshot }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** 成功取到快照后写入首屏缓存（失败/超时不写，避免把坏数据当成"上次渲染结果"）。 */
export function rememberRegionMap(map: RegionMapSnapshot): void {
  writeRenderCache(REGION_MAP_CACHE_KEY, map)
}
