/**
 * 浏览器态 Remote 的判据：HTTP 调用 + SSE 事件流 + 令牌门所需的几个小工具。
 *
 * ## 这里守的是「与桌面端等价」这件事
 *
 * 手机与桌面共用同一套面板，前提是两条传输路**对面板看起来完全一样**：
 *   · 返回值都是后端信封 `{ ok, value }` / `{ ok:false, error }`（面板的 `unwrap` 只认这个）；
 *   · 网络失败也**必须**返回信封而不是抛 —— 抛出去会变成未捕获的 Promise 拒绝，
 *     面板那边只会停在 loading，用户看到「一直转圈」而不是「连不上电脑」；
 *   · 事件都经 `wechat-events.ts` 的同一张表翻译成 DOM CustomEvent。
 *
 * 另外三条是手机端**特有**的失效模式，桌面端根本不会遇到，所以只能在这里钉：
 *   ① 会话 12 小时到期后每个请求都是 401 ⇒ 必须翻译成「该重新扫码了」的 DOM 事件，
 *      否则用户看到的是一屏加载失败；
 *   ② 切到后台时浏览器会挂起 `EventSource`，期间事件全丢 ⇒ 回到前台必须补一次刷新，
 *      这正是上一轮「界面正常但数据不动」事故的同款症状；
 *   ③ 令牌只该在地址栏出现一次（扫码那一趟），换到会话后要立刻抹掉。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_LOST_EVENT,
  authenticate,
  callRemote,
  createHttpRemote,
  hasSession,
  resetSessionLost,
  startHttpEventRelay,
  stripTokenFromUrl,
  tokenFromUrl,
} from './http-remote.ts'
import type { BackendEvent } from './wechat-events.ts'

/** 最小的 EventSource 替身：只需要 onmessage / onerror / close。 */
class FakeEventSource {
  static instances: FakeEventSource[] = []
  url: string
  closed = false
  onmessage: ((e: MessageEvent<string>) => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeEventSource.instances.push(this)
  }
  close(): void { this.closed = true }
  /** 测试用：喂一帧。 */
  emit(data: string): void { this.onmessage?.({ data } as MessageEvent<string>) }
}

/** 造一个 fetch 替身，记下每次请求。 */
function stubFetch(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string, init?: RequestInit }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    return impl(url, init)
  }))
  return calls
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** 记下 window 上派发的自定义事件。 */
function listenWindow(): Array<{ type: string, detail: unknown }> {
  const seen: Array<{ type: string, detail: unknown }> = []
  const handler = (e: Event): void => { seen.push({ type: e.type, detail: (e as CustomEvent).detail }) }
  for (const t of [SESSION_LOST_EVENT, 'dsh-wechat-data-updated']) window.addEventListener(t, handler)
  return seen
}

beforeEach(() => {
  FakeEventSource.instances = []
  vi.stubGlobal('EventSource', FakeEventSource)
  resetSessionLost()
  window.history.replaceState(null, '', '/')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('callRemote：信封原样透传，失败也返回信封', () => {
  it('成功信封与错误信封都原样返回（面板的 unwrap 只认这个形状）', async () => {
    stubFetch(async () => json(200, { ok: true, value: { sessions: [1, 2] } }))
    expect(await callRemote('getSessions', [{ page: 1 }]))
      .toEqual({ ok: true, value: { sessions: [1, 2] } })

    stubFetch(async () => json(200, { ok: false, error: { message: '不开放远程访问', code: 'METHOD_NOT_ALLOWED_REMOTE' } }))
    const r = await callRemote('getWechatConfig', [])
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('METHOD_NOT_ALLOWED_REMOTE')
  })

  it('请求形状：POST + JSON body {method,args} + 同源凭据（SSE 与调用都靠 Cookie）', async () => {
    const calls = stubFetch(async () => json(200, { ok: true }))
    await callRemote('askWechat', ['q'])
    expect(calls.length).toBe(1)
    expect(calls[0]?.url).toBe('/api/wechat/call')
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.credentials, '少了同源凭据 ⇒ 会话 Cookie 不会被带上').toBe('same-origin')
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ method: 'askWechat', args: ['q'] })
    expect((calls[0]?.init?.headers as Record<string, string>)['content-type']).toContain('application/json')
  })

  it('401 → 派发「会话失效」事件，并返回 UNAUTHORIZED 信封（不是抛）', async () => {
    const seen = listenWindow()
    stubFetch(async () => json(401, { ok: false, error: { message: '未授权', code: 'UNAUTHORIZED' } }))
    const r = await callRemote('getSessions', [])
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('UNAUTHORIZED')
    expect(seen.some((e) => e.type === SESSION_LOST_EVENT), '会话失效没有通知界面 ⇒ 用户只会看到一屏加载失败').toBe(true)
  })

  it('会话失效只通知一次（每个请求都 401 时不该刷一屏事件）', async () => {
    const seen = listenWindow()
    stubFetch(async () => json(401, { ok: false, error: {} }))
    await callRemote('getSessions', [])
    await callRemote('getMessages', [])
    await callRemote('getContacts', [])
    expect(seen.filter((e) => e.type === SESSION_LOST_EVENT).length).toBe(1)
  })

  it('网络层抛错 → NETWORK 信封（抛出去会变成未捕获拒绝，面板只会一直转圈）', async () => {
    stubFetch(async () => { throw new TypeError('Failed to fetch') })
    const r = await callRemote('getSessions', [])
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('NETWORK')
    expect(r.error?.message, '错误信息要说清是「连不上电脑」，而不是一个裸的 TypeError').toContain('连不上电脑上的 Super Time')
  })

  it('响应不是 JSON（代理插页 / 进程被杀）→ BAD_RESPONSE 信封', async () => {
    stubFetch(async () => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }))
    const r = await callRemote('getSessions', [])
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('BAD_RESPONSE')
    expect(r.error?.message).toContain('502')
  })
})

describe('createHttpRemote：与桌面端 remoteProxy 同形状', () => {
  it('属性访问变成一次调用，方法名与参数数组都对', async () => {
    const calls = stubFetch(async () => json(200, { ok: true, value: 'v' }))
    const remote = createHttpRemote() as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>
    await remote.getSessions!({ page: 2 })
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ method: 'getSessions', args: [{ page: 2 }] })
    await remote.askWechat!('你好', { kb: true })
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ method: 'askWechat', args: ['你好', { kb: true }] })
  })

  it('无参调用得到空数组（后端按位置取参，undefined 会让它拿到 null）', async () => {
    const calls = stubFetch(async () => json(200, { ok: true }))
    const remote = createHttpRemote() as unknown as Record<string, () => Promise<unknown>>
    await remote.getOverview!()
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ method: 'getOverview', args: [] })
  })

  it('$on 返回一个可调用的退订函数（api.ts 的约定，桌面端也是这么给的）', () => {
    const remote = createHttpRemote() as unknown as { $on: () => () => undefined }
    expect(typeof remote.$on).toBe('function')
    const off = remote.$on()
    expect(typeof off).toBe('function')
    expect(off()).toBeUndefined()
  })
})

describe('令牌门用的几个小工具', () => {
  it('authenticate：200 成功、401 给原因、429 给「稍后再试」、网络错误也给原因', async () => {
    stubFetch(async () => json(200, { ok: true, value: {} }))
    expect(await authenticate('tok')).toEqual({ ok: true })

    stubFetch(async () => json(401, { ok: false, error: { message: '令牌不正确' } }))
    expect(await authenticate('bad')).toEqual({ ok: false, error: '令牌不正确' })

    stubFetch(async () => json(429, { ok: false, error: {} }))
    expect((await authenticate('x')).error).toContain('一分钟后再试')

    stubFetch(async () => { throw new Error('offline') })
    expect((await authenticate('x')).error).toContain('连不上电脑上的 Super Time')
  })

  it('登录成功后复位「会话失效」标记（否则下次失效通知不出来）', async () => {
    const seen = listenWindow()
    stubFetch(async () => json(401, { ok: false, error: {} }))
    await callRemote('getSessions', [])
    expect(seen.filter((e) => e.type === SESSION_LOST_EVENT).length).toBe(1)
    stubFetch(async () => json(200, { ok: true, value: {} }))
    expect((await authenticate('tok')).ok).toBe(true)
    stubFetch(async () => json(401, { ok: false, error: {} }))
    await callRemote('getSessions', [])
    expect(seen.filter((e) => e.type === SESSION_LOST_EVENT).length, '重新登录后又失效，应当能再通知一次').toBe(2)
  })

  it('hasSession：200 为真、401 为假、抛错为假', async () => {
    stubFetch(async () => json(200, { ok: true }))
    expect(await hasSession()).toBe(true)
    stubFetch(async () => json(401, { ok: false }))
    expect(await hasSession()).toBe(false)
    stubFetch(async () => { throw new Error('x') })
    expect(await hasSession()).toBe(false)
  })

  it('一次性令牌：读出来、然后从地址栏抹掉（不该进历史与 Referer）', () => {
    window.history.replaceState(null, '', '/?t=abc123')
    expect(tokenFromUrl()).toBe('abc123')
    stripTokenFromUrl()
    expect(window.location.search, '令牌还留在地址栏里').toBe('')
    expect(tokenFromUrl()).toBe('')
    // 没有 ?t= 时抹除是空操作，且不该把别处的查询串搞坏
    window.history.replaceState(null, '', '/?tab=chats')
    stripTokenFromUrl()
    expect(window.location.search).toBe('?tab=chats')
  })
})

describe('SSE 事件流', () => {
  it('连的是 /api/wechat/events，收到的帧交给注入的派发器', () => {
    const got: BackendEvent[] = []
    const stop = startHttpEventRelay({ dispatch: (ev) => { got.push(ev); return ev.name } })
    expect(FakeEventSource.instances.length).toBe(1)
    expect(FakeEventSource.instances[0]?.url).toBe('/api/wechat/events')
    const es = FakeEventSource.instances[0]!
    es.emit(JSON.stringify({ name: 'wechat-data/updated', args: [] }))
    es.emit(JSON.stringify({ name: 'wechat-ask/delta', args: [{ id: 'a', text: 'hi' }] }))
    expect(got).toEqual([
      { name: 'wechat-data/updated', args: [] },
      { name: 'wechat-ask/delta', args: [{ id: 'a', text: 'hi' }] },
    ])
    stop()
    expect(es.closed, '停止函数没有关掉事件流').toBe(true)
  })

  it('缺省派发器就是共用的映射表：SSE 帧直接变成面板订阅的 DOM 事件', () => {
    // 前面几条都注入了自己的 dispatch（为了看清算不算转发）。这一条**不注入** ——
    // 它守的是真实接线：手机收到的帧必须变成 `dsh-*` 那个面板真的在听的名字。
    // 少了它，「把缺省派发器换掉」这种改法只会被结构判据抓到，行为上没人管。
    const stop = startHttpEventRelay()
    const es = FakeEventSource.instances[0]!
    const seen: string[] = []
    const onData = (e: Event): void => { seen.push(e.type) }
    const onDelta = (e: Event): void => { seen.push(`${e.type}:${JSON.stringify((e as CustomEvent).detail)}`) }
    window.addEventListener('dsh-wechat-data-updated', onData)
    window.addEventListener('dsh-wechat-ask-delta', onDelta)
    es.emit(JSON.stringify({ name: 'wechat-data/updated', args: [] }))
    es.emit(JSON.stringify({ name: 'wechat-ask/delta', args: [{ id: 'a1', text: '全文' }] }))
    // 后端会推的、表里没有的事件不该变成任何 DOM 事件
    es.emit(JSON.stringify({ name: 'remote-access/heartbeat', args: [] }))
    window.removeEventListener('dsh-wechat-data-updated', onData)
    window.removeEventListener('dsh-wechat-ask-delta', onDelta)
    expect(seen).toEqual([
      'dsh-wechat-data-updated',
      'dsh-wechat-ask-delta:{"id":"a1","text":"全文"}',
    ])
    stop()
  })

  it('坏帧（心跳注释、非 JSON）被忽略而不是断流', () => {
    const got: BackendEvent[] = []
    const stop = startHttpEventRelay({ dispatch: (ev) => { got.push(ev); return null } })
    const es = FakeEventSource.instances[0]!
    es.emit('')
    es.emit('not json')
    es.emit(JSON.stringify({ nope: true }))
    es.emit(JSON.stringify({ name: 'wechat-data/updated', args: [] }))
    expect(got.length, '坏帧之后就不该再收事件了').toBe(1)
    expect(es.closed).toBe(false)
    stop()
  })

  it('切回前台补一次刷新（后台期间 SSE 被挂起、事件全丢）', () => {
    const got: BackendEvent[] = []
    const stop = startHttpEventRelay({ dispatch: (ev) => { got.push(ev); return null } })
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(got.length, '还在后台就补刷新了').toBe(0)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(got, '回到前台没有补刷新 ⇒ 界面会停在旧数据上').toEqual([{ name: 'wechat-data/updated', args: [] }])
    // 限频：紧接着再切一次不该再补（快速切来切去不能变成一串重查询）
    document.dispatchEvent(new Event('visibilitychange'))
    expect(got.length, '补刷新没有限频').toBe(1)
    stop()
  })

  it('出错时探测会话：失效就通知界面并停止自动重连', async () => {
    const seen = listenWindow()
    stubFetch(async () => json(401, { ok: false }))
    const stop = startHttpEventRelay({ dispatch: () => null })
    const es = FakeEventSource.instances[0]!
    es.onerror?.()
    // 探测链是 fetch → await → then，几层微任务；用一次宏任务把它们全部排干
    // （只 await Promise.resolve() 层数不够，会看到「还没通知」的假失败）。
    await new Promise((r) => setTimeout(r, 5))
    expect(seen.some((e) => e.type === SESSION_LOST_EVENT), '会话没了却没通知界面').toBe(true)
    expect(es.closed, '会话没了还在自动重连 ⇒ 每次重连都是一次 401').toBe(true)
    stop()
  })

  it('出错但会话仍有效 → 不通知、不关流（交给 EventSource 自己重连）', async () => {
    const seen = listenWindow()
    stubFetch(async () => json(200, { ok: true }))
    const stop = startHttpEventRelay({ dispatch: () => null })
    const es = FakeEventSource.instances[0]!
    es.onerror?.()
    await new Promise((r) => setTimeout(r, 5))
    expect(seen.filter((e) => e.type === SESSION_LOST_EVENT).length).toBe(0)
    expect(es.closed, '网络抖动就把流关了 ⇒ 手机端从此再也收不到实时事件').toBe(false)
    stop()
  })
})
