/**
 * P0-3：`cachedFetch` 必须是**真的** stale-while-revalidate。
 *
 * 旧实现是「命中缓存也 await 完整后端请求，只有请求失败才回缓存」—— 那是带兜底的
 * fetch-through，不是 SWR，而注释一直写着 SWR（实现与注释不符）。用户侧的症状是
 * 「切回面板还要转圈」：`sessions`(30s) / `messages`(5s) / `moments` / `records` /
 * `privacy` / `group` / `pay` / `daily` / `kb-model` 九个接口二次打开仍要等完整后端。
 *
 * 判据取「**永不 resolve 的 fetcher**」这一种形状：如果实现还在 await，命中那次调用
 * 就永远不会 settle ⇒ 用例变红。这比量时间更硬 —— 时间断言在 CI 上要么恒过要么恒红。
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SNAPSHOT_REFRESHED_EVENT, cachedFetch, isEmptySnapshot } from './cache.ts'

const PREFIX = 'dsh-wechat-cache-v1:'

beforeEach(() => {
  localStorage.clear()
})

/** 等微任务队列排干（早返回是同步语义，只需要几个 tick）。 */
async function drain(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve()
}

describe('cachedFetch 命中即返回', () => {
  it('冷跑：等 fetcher、拿到值、写进 localStorage', async () => {
    const v = await cachedFetch('sessions:cold', async () => ({ items: [1], total: 1 }))
    expect(v).toEqual({ items: [1], total: 1 })
    expect(localStorage.getItem(PREFIX + 'sessions:cold')).toContain('"total":1')
  })

  it('命中：**不等** fetcher 就返回旧快照（fetcher 永不 resolve 也要能返回）', async () => {
    await cachedFetch('messages:hit', async () => ({ items: ['a'], total: 1 }))
    let fetcherCalls = 0
    let settled = false
    const pending = cachedFetch('messages:hit', () => {
      fetcherCalls += 1
      return new Promise<{ items: string[]; total: number }>(() => { /* 永不 resolve */ })
    })
    void pending.then(() => { settled = true })
    await drain()
    expect(settled, '命中时仍在 await 后端请求 —— 这就是「切回面板还要转圈」的根因').toBe(true)
    expect(await pending).toEqual({ items: ['a'], total: 1 })
    expect(fetcherCalls, '命中后还要在后台发起刷新（SWR 的 R）').toBe(1)
  })

  it('后台刷新完成后写回缓存，并按接口族广播（界面靠它重渲染）', async () => {
    await cachedFetch('moments:bg', async () => ({ items: ['旧'], total: 1 }))
    const seen: string[] = []
    window.addEventListener(`${SNAPSHOT_REFRESHED_EVENT}:moments`, (e) => {
      seen.push(JSON.stringify((e as CustomEvent).detail ?? {}))
    })
    const hit = await cachedFetch('moments:bg', async () => ({ items: ['新'], total: 2 }))
    expect(hit, '早返回的必须是旧快照').toEqual({ items: ['旧'], total: 1 })
    await vi.waitFor(() => expect(seen.length).toBe(1), { timeout: 500 })
    expect(seen[0]).toContain('moments:bg')
    // 新值已落缓存 ⇒ 下一次调用立刻拿到新快照
    const again = await cachedFetch('moments:bg', async () => ({ items: ['不该被调用'], total: 3 }))
    expect(again).toEqual({ items: ['新'], total: 2 })
  })

  it('同键并发的后台刷新只发一次请求（否则一次重渲染就是一场风暴）', async () => {
    await cachedFetch('records:dedupe', async () => ({ items: [1], total: 1 }))
    let calls = 0
    const slow = () => new Promise<{ items: number[]; total: number }>((resolve) => {
      calls += 1
      setTimeout(() => resolve({ items: [2], total: 2 }), 20)
    })
    const a = cachedFetch('records:dedupe', slow)
    const b = cachedFetch('records:dedupe', slow)
    const c = cachedFetch('records:dedupe', slow)
    await Promise.all([a, b, c])
    expect(calls, '三次调用打出了三次后台请求').toBe(1)
    await vi.waitFor(() => expect(localStorage.getItem(PREFIX + 'records:dedupe')).toContain('"total":2'), { timeout: 500 })
  })

  it('后台刷新失败：留着旧快照、不炸界面，事件照样广播', async () => {
    await cachedFetch('privacy:failbg', async () => ({ hits: 3 }))
    const hit = await cachedFetch('privacy:failbg', async () => { throw new Error('后端重启中') })
    expect(hit).toEqual({ hits: 3 })
    await vi.waitFor(() => expect(localStorage.getItem(PREFIX + 'privacy:failbg')).toContain('"hits":3'), { timeout: 300 })
  })

  it('后台刷新拿到**同样的值** ⇒ 不广播（否则订阅者重读会自转成环）', async () => {
    await cachedFetch('group:same', async () => ({ members: ['a'], total: 1 }))
    let at = 0
    const before = localStorage.getItem(PREFIX + 'group:same')
    window.addEventListener(`${SNAPSHOT_REFRESHED_EVENT}:group`, () => { at += 1 })
    for (let i = 0; i < 3; i += 1) {
      await cachedFetch('group:same', async () => ({ members: ['a'], total: 1 }))
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(at, '数据一个字没变也在广播 ⇒ 面板重读、再刷新、再广播').toBe(0)
    expect(localStorage.getItem(PREFIX + 'group:same'), '值没变就不该重写').toBe(before)
  })

  it('空快照不许当命中（临时空快照会永久盖住真实数据）', async () => {
    localStorage.setItem(PREFIX + 'moments:empty', JSON.stringify({ at: Date.now(), v: { items: [], total: 0 } }))
    expect(isEmptySnapshot({ items: [], total: 0 }), '夹具本身必须是「空快照」').toBe(true)
    const v = await cachedFetch('moments:empty', async () => ({ items: ['真数据'], total: 1 }))
    expect(v).toEqual({ items: ['真数据'], total: 1 })
  })

  it('过期即当没命中（TTL 是这套缓存唯一的鲜度保证）', async () => {
    localStorage.setItem(PREFIX + 'daily:ttl', JSON.stringify({ at: Date.now() - 10_000, v: { items: ['旧'], total: 1 } }))
    let fetched = false
    const v = await cachedFetch('daily:ttl', async () => { fetched = true; return { items: ['新'], total: 1 } }, 1_000)
    expect(fetched).toBe(true)
    expect(v).toEqual({ items: ['新'], total: 1 })
  })
})
