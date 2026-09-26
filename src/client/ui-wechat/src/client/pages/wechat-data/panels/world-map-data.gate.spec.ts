// @vitest-environment jsdom
/**
 * 地图底图出网闸的行为守卫（P3-9，2026-09-26）。
 *
 * 这一族之前只有接线守卫（谁先读、谁写镜像），值不值得信**没有**判据 —— 于是
 * 「渲染层镜像可被改写绕过开关」这条一直挂着。现在的口径是：
 * ① 镜像**新鲜**（写入时间还在 {@link FLAG_FRESH_MS} 之内）才直接采信 —— 这是
 *    「世界地图一直在加载中」那轮换来的 0ms 快路，不能丢；
 * ② 镜像缺失或**过期**都必须回去问后端真值（有界等待），拿到就刷新镜像；
 * ③ 真值拿不到时：有过期镜像就拿它顶着（那是后端真值的旧副本），什么都没有才放行。
 *
 * 三条合起来才是"闸门"：只读镜像 = 改写一条 localStorage 就能长开或长关；
 * 只问后端 = 后端排队时整张地图静止不动。
 *
 * 超时与抛错走的是同一个分支（`hit === null`），所以这里用抛错来量那条兜底 ——
 * 真等 2 秒的定时器测试留给 e2e，不在单测里赌时序。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WORLD_GEO_URLS, fetchFirstJson } from './world-map-data.ts'
import { readMapTilesFlag, writeMapTilesFlag } from '../map-tiles-flag.ts'

const api = vi.hoisted(() => ({
  getPrivacy: vi.fn((): Promise<{ blockMapTiles?: boolean }> => Promise.resolve({})),
}))

vi.mock('../api.ts', () => ({ apiGetPrivacyState: api.getPrivacy }))

const KEY = 'wxdata:blockMapTiles'
const TIME_KEY = 'wxdata:blockMapTiles:at'
const FRESH_MS = 15_000

/** 把镜像摆成指定状态（`null` = 清掉），时间戳按 ageMs 折算；ageMs 为 null 表示只有值、没有时间。 */
function seed(blocked: boolean | null, ageMs: number | null = 0): void {
  localStorage.clear()
  if (blocked === null) return
  localStorage.setItem(KEY, blocked ? '1' : '0')
  if (ageMs !== null) localStorage.setItem(TIME_KEY, String(Date.now() - ageMs))
}

const fetchSpy = vi.fn(async (): Promise<Response> => ({ ok: true, status: 200, json: async () => ({ type: 'FeatureCollection' }) }) as unknown as Response)

/** 跑一次闸门：返回 'allowed' 或拦截时的错误文案。 */
async function gate(): Promise<string> {
  try {
    await fetchFirstJson(WORLD_GEO_URLS)
    return 'allowed'
  } catch (e) {
    return (e as Error).message
  }
}

const BLOCKED_TEXT = '地图底图出网已在「数据边界与出网 → 禁止地图底图出网」里关闭'

beforeEach(() => {
  localStorage.clear()
  api.getPrivacy.mockReset()
  fetchSpy.mockClear()
  vi.stubGlobal('fetch', fetchSpy)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('新鲜镜像：0ms 快路（不能退回去排队）', () => {
  it('镜像 true 且刚写过 ⇒ 直接拦，连后端都不问', async () => {
    seed(true, 0)
    expect(await gate()).toBe(BLOCKED_TEXT)
    expect(api.getPrivacy, '新鲜镜像还要排队问后端 ⇒ 就是「世界地图一直在加载中」那颗 bug').not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('镜像 false 且刚写过 ⇒ 放行，fetch 真发生', async () => {
    seed(false, 0)
    expect(await gate()).toBe('allowed')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(api.getPrivacy).not.toHaveBeenCalled()
  })

  it('刚好压在新鲜期边界上仍算新鲜（边界不双重收紧，也不放宽）', async () => {
    seed(true, FRESH_MS)
    expect(await gate()).toBe(BLOCKED_TEXT)
    expect(api.getPrivacy).not.toHaveBeenCalled()
  })
})

describe('过期镜像：后端真值说了算（P3-9 的正身）', () => {
  it('镜像写着 false、后端说 true ⇒ 拦，且镜像被换成后端真值', async () => {
    seed(false, FRESH_MS + 1)
    api.getPrivacy.mockResolvedValue({ blockMapTiles: true })
    expect(await gate()).toBe(BLOCKED_TEXT)
    expect(readMapTilesFlag()).toBe(true)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('镜像写着 true、后端说 false ⇒ 放行（副本不许把用户锁死）', async () => {
    seed(true, 60_000)
    api.getPrivacy.mockResolvedValue({ blockMapTiles: false })
    expect(await gate()).toBe('allowed')
    expect(readMapTilesFlag()).toBe(false)
  })

  it('只有值、没有时间戳（被人直接改过 localStorage）⇒ 按过期处理，必须回问后端', async () => {
    seed(false, null)
    api.getPrivacy.mockResolvedValue({ blockMapTiles: true })
    expect(await gate(), '改一条 localStorage 就长开放行 ⇒ 闸门形同虚设').toBe(BLOCKED_TEXT)
    expect(localStorage.getItem(TIME_KEY), '回问过却没刷新时间戳 ⇒ 下一次还要再等 RPC').not.toBeNull()
  })

  it('完全没有镜像 ⇒ 走后端，拿到真值后建镜像', async () => {
    seed(null)
    api.getPrivacy.mockResolvedValue({ blockMapTiles: true })
    expect(await gate()).toBe(BLOCKED_TEXT)
    expect(readMapTilesFlag()).toBe(true)
  })
})

describe('拿不到真值时的兜底方向', () => {
  it('后端抛错 + 有过期镜像 ⇒ 拿旧副本顶着（比"什么都没有"更接近真相）', async () => {
    seed(true, 60_000)
    api.getPrivacy.mockRejectedValue(new Error('gateway busy'))
    expect(await gate()).toBe(BLOCKED_TEXT)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('后端抛错 + 什么镜像都没有 ⇒ 如实放行（这份 GeoJSON 是公开的，宁可出网不要空白）', async () => {
    seed(null)
    api.getPrivacy.mockRejectedValue(new Error('gateway busy'))
    expect(await gate()).toBe('allowed')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})

describe('镜像写入方（api-read 那两个入口共用的一颗）', () => {
  it('写值一定同时写时间戳 —— 只写值就等于造出一个"永远新鲜不了也过期不了"的副本', () => {
    localStorage.clear()
    writeMapTilesFlag(true)
    expect(localStorage.getItem(KEY)).toBe('1')
    const at = Number(localStorage.getItem(TIME_KEY))
    expect(Number.isFinite(at)).toBe(true)
    expect(Math.abs(Date.now() - at)).toBeLessThan(5_000)
  })
})
