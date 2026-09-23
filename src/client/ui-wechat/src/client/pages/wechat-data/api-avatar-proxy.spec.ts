// @vitest-environment node
/**
 * M23（第四刀）：头像的远程地址必须在 **api 层**就被换成后端代理的结果。
 *
 * 为什么钉在这一层而不是逐个面板：`getAvatar` 会回 `{ kind: 'url' }`（本机没有这张头像时），
 * 而它有 **7 个**调用点（联系人、朋友圈大小头像、聊天侧栏、总览、设置、面板头、群成员栏）。
 * 只要有一个点留着 `kind === 'url'` 分支，那条 `<img src=https://…>` 就还在渲染层直连：
 * 「自动获取原图（CDN）」与「禁止出网」两个开关管不到它、操作记录里没有它、也没有缓存 ——
 * 而 CSP 的 `https:` 通配没拿掉之前**连违规都不会报**。所以这一层是唯一的收口处，
 * 判据是「假远程面被叫了几次、每次带什么、这一层最终交出什么地址」。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { apiGetAvatar, apiGetAvatarsLocal, setWechatRemote, type WechatRemote } from './api.ts'
import type { RemoteImageItem } from './api-core.ts'

const PNG = 'data:image/png;base64,AVATAR'
let seq = 0
/** 每个用例用不同的地址：渲染层那张 `源地址 → data URL` 的进程内缓存是跨用例的。 */
function url(prefix = 'avatar'): string {
  seq += 1
  return `https://wx.qlogo.cn/mmhead/${prefix}-${String(seq)}/0`
}

interface Calls {
  proxyBatches: string[][]
  avatarReqs: number
  batchReqs: number
}

/**
 * 假远程面。
 * @param opts - `resolve` 决定代理对某个地址回 data URL 还是回错误；`local` 是批量头像接口的返回。
 */
function stub(opts: {
  avatar?: { kind: string; data?: string; url?: string }
  local?: Record<string, string>
  resolve?: (u: string) => RemoteImageItem
} = {}): Calls {
  const calls: Calls = { proxyBatches: [], avatarReqs: 0, batchReqs: 0 }
  const resolve = opts.resolve ?? ((u: string) => ({ url: u, dataUrl: PNG }))
  setWechatRemote({
    getAvatar: async () => {
      calls.avatarReqs += 1
      return { ok: true as const, value: opts.avatar ?? { kind: 'none' } }
    },
    getAvatarsLocal: async () => {
      calls.batchReqs += 1
      return { ok: true as const, value: opts.local ?? {} }
    },
    getRemoteImages: async ({ urls }: { urls?: string[] }) => {
      const list = urls ?? []
      calls.proxyBatches.push([...list])
      return { ok: true as const, value: { items: list.map(resolve) } }
    },
  } as unknown as WechatRemote)
  return calls
}

/** 把所有远程地址换成结果；远程地址不许原样出现在返回值里。 */
function hasRemote(v: unknown): boolean {
  return JSON.stringify(v ?? null).includes('https://')
}

afterEach(() => {
  setWechatRemote({
    getAvatar: async () => { throw new Error('本用例没有 stub 远程面') },
    getAvatarsLocal: async () => { throw new Error('本用例没有 stub 远程面') },
    getRemoteImages: async () => { throw new Error('本用例没有 stub 远程面') },
  } as unknown as WechatRemote)
})

describe('M23：头像的远程地址在 api 层就换成本机可画地址', () => {
  it('后端回 kind=url 时，交回来的是代理取回的 data URL，且只走一次批量代理', async () => {
    const remote = url()
    const calls = stub({ avatar: { kind: 'url', url: remote }, resolve: (u) => ({ url: u, dataUrl: PNG }) })
    const r = await apiGetAvatar({ username: 'wxid_a' })
    expect(r.kind).toBe('data')
    expect(r.data).toBe(PNG)
    expect(hasRemote(r), '远程地址漏到调用方手里了：' + JSON.stringify(r)).toBe(false)
    expect(calls.proxyBatches.length, '代理只该被叫一次').toBe(1)
    expect(calls.proxyBatches[0]).toEqual([remote])
  })

  it('代理取不到（开关关掉 / 主机不在清单 / CDN 失败）就如实回 none，而不是把远程地址交出去', async () => {
    const remote = url()
    const calls = stub({
      avatar: { kind: 'url', url: remote },
      resolve: (u) => ({ url: u, error: '「自动获取原图（CDN）」已关闭' }),
    })
    const r = await apiGetAvatar({ username: 'wxid_b' })
    expect(r.kind).toBe('none')
    expect(r.url, 'kind=none 还带着远程地址').toBeUndefined()
    expect(calls.proxyBatches.length).toBe(1)
  })

  it('本机已有头像（kind=data）时一个代理请求都不发', async () => {
    const calls = stub({ avatar: { kind: 'data', data: PNG } })
    const r = await apiGetAvatar({ username: 'wxid_c' })
    expect(r.kind).toBe('data')
    expect(r.data).toBe(PNG)
    expect(calls.proxyBatches, '本机地址不该再敲代理').toEqual([])
  })

  it('批量头像：远程值换成 data URL、本机值原样保留、键一个都不掉', async () => {
    const r1 = url('one')
    const r2 = url('two')
    const calls = stub({
      local: { a: 'data:image/png;base64,LOCAL', b: r1, c: r2, d: '' },
      resolve: (u) => (u === r2 ? { url: u, error: 'CDN 404' } : { url: u, dataUrl: PNG }),
    })
    const map = await apiGetAvatarsLocal({ usernames: ['a', 'b', 'c', 'd'] })
    expect(map.a, '本机地址不该被改动').toBe('data:image/png;base64,LOCAL')
    expect(map.b).toBe(PNG)
    expect(map.c, '取不到要留空串（而不是漏出远程地址）').toBe('')
    expect(map.d).toBe('')
    expect(Object.keys(map).sort(), '删键会让调用方对「这批问过了没有」重新推理').toEqual(['a', 'b', 'c', 'd'])
    expect(hasRemote(map), '远程地址漏进了批量结果：' + JSON.stringify(map)).toBe(false)
    expect(calls.proxyBatches.length, '两个远程地址要攒成一次代理调用').toBe(1)
    expect(calls.proxyBatches[0]).toEqual([r1, r2])
  })

  it('整批都是本机地址时不产生任何代理调用（批量接口不因此变慢）', async () => {
    const calls = stub({ local: { a: 'data:image/png;base64,A', b: 'file:///C:/x/b.png' } })
    const map = await apiGetAvatarsLocal({ usernames: ['a', 'b'] })
    expect(map.a).toBe('data:image/png;base64,A')
    expect(map.b).toBe('file:///C:/x/b.png')
    expect(calls.proxyBatches).toEqual([])
    expect(calls.batchReqs).toBe(1)
  })
})
