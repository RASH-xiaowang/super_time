// @vitest-environment node
/**
 * M23（渲染层半边）：远程图片走后端代理的**接线与攒批**验收。
 *
 * 为什么要有这一份（而不是只看组件代码）：这一层的价值全在「怎么发」上 ——
 *   · 一屏 12 张卡片封面必须是**一次** RPC（逐张发就成了 12 次跨进程调用，每趟都带 base64）；
 *   · 后端会**去重**（同一张图挂两处只取一次），所以回填必须按 URL 查表，
 *     按下标回填会把「第 2 张的结果」错接到第 3 张上 —— 那种错法在界面上是「图串了」，
 *     比不显示更难查；
 *   · 同一张图第二次画不许再发 RPC（进程内缓存），否则虚拟化列表来回滚会把代理打成热点；
 *   · 取不到必须回**空串**而不是破图地址：卡片外层的「没有封面」占位分支靠它。
 * 判据是数「远程面被调了几次、每批带几个地址、每个 promise 拿到什么」—— 全是确定性的，
 * 不依赖计时，也不看源码里有没有出现过某个函数名。
 *
 * 能证明什么、不能证明什么：证明 api 层真的攒批、按 URL 回填、缓存生效；
 * **组件里那条「先不画再画」的时序没有浏览器验证**（仓库没有组件测试环境），
 * 它由 `panels/remote-img.tsx` 的注释与 `remote-image-wiring.spec.ts` 的接线断言覆盖。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { apiGetRemoteImageUrl, setWechatRemote, type WechatRemote } from './api.ts'
import type { RemoteImageItem } from './api-core.ts'

const PNG = 'data:image/png;base64,AAAA'

interface Batch { urls: string[] }

/** 假远程面：记录每一批收了几个地址，并按 URL 回结果（可选去重 / 报错 / 缺条目）。 */
function stubRemote(behavior: (urls: string[]) => RemoteImageItem[] = (urls) => urls.map((url) => ({ url, dataUrl: PNG }))): { batches: Batch[] } {
  const batches: Batch[] = []
  const base = {
    getRemoteImages: async ({ urls }: { urls?: string[] }) => {
      const list = urls ?? []
      batches.push({ urls: [...list] })
      return { ok: true as const, value: { items: behavior(list) } }
    },
  }
  setWechatRemote(base as unknown as WechatRemote)
  return { batches }
}

/** 攒到同一个微任务里入队，才会被合并成一次批量调用（与真实渲染提交同一形状）。 */
async function all(urls: string[]): Promise<string[]> {
  return Promise.all(urls.map((u) => apiGetRemoteImageUrl(u)))
}

afterEach(() => {
  // 换一个什么都不给的远程面：万一某个用例忘了 stub，下一个用例就会因为「没有远程面」而红，
  // 而不是悄悄复用上一个的计数。
  setWechatRemote({
    getRemoteImages: async () => { throw new Error('本用例没有 stub 远程面') },
  } as unknown as WechatRemote)
})

describe('M23：渲染层的远程图片走后端代理', () => {
  it('一屏 N 张合成一次 RPC，并按入参顺序把 data URL 交回每一张', async () => {
    const { batches } = stubRemote()
    const urls = Array.from({ length: 12 }, (_, i) => `https://mmbiz.qpic.cn/cover/${String(i)}.jpg`)
    const got = await all(urls)
    expect(batches.length, '必须攒成一次批量调用').toBe(1)
    expect(batches[0]?.urls).toEqual(urls)
    expect(got.every((u) => u === PNG)).toBe(true)
  })

  it('后端去重后按 URL 回填：同一地址挂两处，拿到的仍是它自己的结果', async () => {
    // 实现按「后端真实契约」回数据：入参 4 个、去重后只回 2 条
    const { batches } = stubRemote((urls) => {
      const uniq = [...new Set(urls)]
      return uniq.map((url, i) => ({ url, dataUrl: `data:image/png;base64,R${String(i)}` }))
    })
    const got = await all(['https://p.qpic.cn/a', 'https://p.qpic.cn/a', 'https://p.qpic.cn/b', 'https://p.qpic.cn/b'])
    expect(batches.length).toBe(1)
    expect(got, '按下标回填会把 b 的结果错接到 a 上').toEqual([
      'data:image/png;base64,R0', 'data:image/png;base64,R0',
      'data:image/png;base64,R1', 'data:image/png;base64,R1',
    ])
  })

  it('同一张图第二次画不再发 RPC（进程内缓存）', async () => {
    const { batches } = stubRemote()
    const first = await apiGetRemoteImageUrl('https://p.qpic.cn/cached')
    const before = batches.length
    const again = await apiGetRemoteImageUrl('https://p.qpic.cn/cached')
    expect(first).toBe(PNG)
    expect(again).toBe(PNG)
    expect(batches.length, '第二次不该再打后端').toBe(before)
  })

  it('取不到就回空串（开关关掉 / 主机不在白名单 / 整批失败），且不会被缓存成"永久没有"', async () => {
    const { batches } = stubRemote((urls) => urls.map((url) => ({ url, error: '已关闭「自动获取原图（CDN）」' })))
    expect(await apiGetRemoteImageUrl('https://p.qpic.cn/err')).toBe('')
    // 失败不留缓存位：再问一次要重新发（后端自己有 60s 冷却，那边才是节流的地方）
    expect(await apiGetRemoteImageUrl('https://p.qpic.cn/err')).toBe('')
    expect(batches.length).toBe(2)
  })

  it('整批 reject 时逐条回空串，不把一批错误悄悄变成"没有这张图"以外的形状', async () => {
    setWechatRemote({
      getRemoteImages: async () => { throw new Error('后端不可用') },
    } as unknown as WechatRemote)
    const got = await all(['https://p.qpic.cn/x1', 'https://p.qpic.cn/x2'])
    expect(got).toEqual(['', ''])
  })

  it('超过单次上限就分批评，而不是把整批送给后端去报错', async () => {
    const { batches } = stubRemote()
    const urls = Array.from({ length: 45 }, (_, i) => `https://p.qpic.cn/big/${String(i)}`)
    const got = await all(urls)
    expect(batches.map((b) => b.urls.length), `各批大小：${JSON.stringify(batches.map((b) => b.urls.length))}`).toEqual([40, 5])
    expect(got.filter((u) => u === PNG).length).toBe(45)
  })

  it('空地址不发 RPC；同一次批量里不重复带同一个地址', async () => {
    const { batches } = stubRemote()
    expect(await apiGetRemoteImageUrl('   ')).toBe('')
    expect(batches).toEqual([])
    await all(['https://p.qpic.cn/dup', 'https://p.qpic.cn/dup'])
    expect(batches.length).toBe(1)
  })
})
