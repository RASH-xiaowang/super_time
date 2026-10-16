// @vitest-environment jsdom
/**
 * Chats 轮询族的**行为**守卫（#19 第一刀：`chats-polling.ts`）。
 *
 * 这一族是本面板唯一会自己动地往 `messages` 上写的东西：定时器、可见性切换、宿主推送、
 * SWR 后台刷新四个入口，共用两个在途闸门和一套会话归属令牌。它原先坐在
 * `useChatsThread` 那 458 行里、**一条用例都没有**（同目录只有 `chats-*.wiring.spec.ts`
 * 那种读源码文本的守卫），错的后果全是"看不见"那一类：
 * 上一个会话的消息画进当前会话、渲染缓存被污染后重开还是错的、状态栏写着上一个会话的失败。
 *
 * 所以这里的判据全部**数 RPC / 看数组身份 / 看写进缓存的那一份**，不读源码形状：
 * - 数组身份不变 = React 不重渲染，这是「去重没生效」和「对账什么都没改」唯一可观测的形式；
 * - 写进渲染缓存的那一份必须是**合并后**的整列表，只写增量会让下次打开时旧消息全丢；
 * - 归属令牌失效的分支要同时钉住「不写消息」与「不写状态栏」，后者漏掉的表现是
 *   「切到新会话后状态栏闪了一下上一个会话的错误」。
 *
 * 两处夹具上的必要伪装：jsdom 不实现 `scrollIntoView`（本族"贴着底部才跟随"要用），
 * `requestAnimationFrame` 在这里同步执行 —— 否则异步帧落在 `act` 之外，断言会随机漂移。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'

/** `vi.mock` 的工厂在导入阶段执行，取不到后面才赋值的常量 ⇒ 必须放进 hoisted。 */
const mocks = vi.hoisted(() => ({
  apiGetNewMessages: vi.fn(),
  apiGetMessages: vi.fn(),
  readRenderCache: vi.fn(),
  writeRenderCache: vi.fn(),
  SNAPSHOT_REFRESHED_EVENT: 'dsh-snapshot-refreshed',
}))
vi.mock('../api.ts', () => mocks)

const { useChatsPolling } = await import('./chats-polling.ts')
const { POLL_HIDDEN_MS, POLL_VISIBLE_MS } = await import('./chats-support.tsx')
// 事件名以 cache.ts 为准：本文件的 mock 里那个字符串若与它分道，下面「SWR 广播」那条就会红。
const { SNAPSHOT_REFRESHED_EVENT } = await import('../cache.ts')

const CUR = { username: 'wxid_poll', displayName: '轮询夹具', type: 'private' } as WechatSession
const OTHER = { username: 'wxid_other', displayName: '另一个会话', type: 'private' } as WechatSession

/** 钩子返回值（测试从这里取 pollNew / reconcileRecent）。 */
let api: { pollNew: () => Promise<void>; reconcileRecent: () => Promise<void> } | null = null

/** 面板那侧被模拟的 state：只保留本族用得上的行为（**延后的** updater + 身份比较）。 */
let msgs: readonly WechatMessage[] = []
let pending: Array<(prev: readonly WechatMessage[]) => readonly WechatMessage[]> = []
let committed: number
let identityKept: number
let pollStatus = ''
let watermarkFromCalls: Array<readonly WechatMessage[]> = []
let seenWatermark = 0
let liveEpoch = 0
let liveTalker = CUR.username
let session: WechatSession | null = CUR
let inFlight = false

let host: HTMLDivElement
let root: Root

const msg = (localId: number, extra?: Partial<WechatMessage>): WechatMessage =>
  ({ localId, createTime: 1700000000 + localId, type: 1, isSender: 0, content: `消息 ${String(localId)}`, sortSeq: localId, ...extra }) as WechatMessage

function Harness(): React.JSX.Element {
  api = useChatsPolling({
    curSession: session,
    inFlightRef: { get current() { return inFlight }, set current(v: boolean) { inFlight = v } } as React.MutableRefObject<boolean>,
    msgEndRef: { current: document.createElement('div') } as React.RefObject<HTMLDivElement>,
    sessionAlive: (epoch, talker) => epoch === liveEpoch && talker === liveTalker,
    sessionEpochRef: { get current() { return liveEpoch }, set current(v: number) { liveEpoch = v } } as React.MutableRefObject<number>,
    setMessages: (u) => {
      // React 的真实形状是**延后执行** updater（批量渲染），本族里「外层查一遍令牌、
      // updater 里再查一遍」正是防这一段的 —— 夹具要是立即执行，那条双重检查就永远测不到。
      if (typeof u === 'function') pending.push(u as (prev: readonly WechatMessage[]) => readonly WechatMessage[])
      else { msgs = u; committed += 1 }
    },
    setPollStatus: (u) => { pollStatus = typeof u === 'function' ? u(pollStatus) : u },
    setWatermarkFrom: (list) => { watermarkFromCalls.push(list); seenWatermark = Math.max(seenWatermark, ...list.map((m) => m.sortSeq ?? 0)) },
    watermarkRef: { get current() { return seenWatermark }, set current(v: number) { seenWatermark = v } } as React.MutableRefObject<number>,
  })
  return createElement('div')
}

/** 重新渲染（改 `session` 等外部变量之后必须走一次，钩子才拿得到新身份）。 */
function rerender(): void {
  act(() => { root.render(createElement(Harness)) })
}

/** 跑一段异步并让 React 把 act 队列排干。 */
async function flush(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // jsdom 没有这两个东西：scrollIntoView 根本没实现，rAF 异步会落到 act 之外
  ;(Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = vi.fn()
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => { cb(0); return 1 })
  mocks.apiGetNewMessages.mockReset().mockResolvedValue({ messages: [] })
  mocks.apiGetMessages.mockReset().mockResolvedValue({ messages: [] })
  mocks.writeRenderCache.mockReset()
  mocks.readRenderCache.mockReset().mockReturnValue(null)
  msgs = []
  pending = []
  committed = 0
  identityKept = 0
  pollStatus = ''
  watermarkFromCalls = []
  seenWatermark = 0
  liveEpoch = 7
  liveTalker = CUR.username
  session = CUR
  inFlight = false
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  rerender()
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  api = null
  vi.unstubAllGlobals()
  vi.useRealTimers()
  // 上面两条用例会把 visibilityState 钉成 hidden，不还原就会串到下一个文件的其它用例上
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  document.dispatchEvent(new Event('visibilitychange'))
})

/** 让 React 把排着的 updater 落地（等价于一次渲染）。 */
function commit(): void {
  const queue = pending
  pending = []
  act(() => {
    for (const u of queue) {
      const next = u(msgs)
      if (next === msgs) { identityKept += 1; continue }
      msgs = next
      committed += 1
    }
  })
}

const pollRaw = async (): Promise<void> => { await act(async () => { await api?.pollNew() }) }
const poll = async (): Promise<void> => { await pollRaw(); commit() }
const reconcile = async (): Promise<void> => { await act(async () => { await api?.reconcileRecent() }); commit() }

describe('轮询的两道闸门', () => {
  it('水位为 0 ⇒ 一次 RPC 都不发（没有水位就不知道该问哪之后）', async () => {
    seenWatermark = 0
    await poll()
    expect(mocks.apiGetNewMessages, '没有水位也去问了后端').not.toHaveBeenCalled()
  })

  it('闸门开着（上一次轮询还在飞）⇒ 不发第二次', async () => {
    seenWatermark = 10
    inFlight = true
    await poll()
    expect(mocks.apiGetNewMessages).not.toHaveBeenCalled()
    inFlight = false
    await poll()
    expect(mocks.apiGetNewMessages, '闸门关了还不发，轮询就永久停摆').toHaveBeenCalledTimes(1)
    expect(mocks.apiGetNewMessages).toHaveBeenCalledWith({ talker: CUR.username, after: 10, limit: 200 })
  })
})

describe('会话归属令牌：切走之后到达的响应必须整条丢掉', () => {
  it('talker 已切走 ⇒ 不写消息、不写缓存、不写状态栏', async () => {
    msgs = [msg(1)]
    seenWatermark = 5
    liveTalker = OTHER.username
    mocks.apiGetNewMessages.mockResolvedValue({ messages: [msg(9)] })
    await poll()
    expect(committed, '把别的会话的消息写进来了').toBe(0)
    expect(mocks.writeRenderCache, '渲染缓存被写脏之后，重开还是错的').not.toHaveBeenCalled()
    expect(pollStatus, '状态栏被别的会话的响应占了').toBe('')
  })

  it('外层检查通过、**updater 落地时**才失效 ⇒ 仍保持原数组身份', async () => {
    // 这才是真实的风险形状：`setMessages(fn)` 里的 fn 要等到渲染才执行，
    // 而那一段时间里用户完全可能点了另一个会话。外层那道 `if (!sessionAlive) return`
    // 挡不住它 —— 所以 updater 里面还有一道，这一条专门钉第二道。
    msgs = [msg(1)]
    seenWatermark = 5
    mocks.apiGetNewMessages.mockResolvedValue({ messages: [msg(9)] })
    await pollRaw()
    liveTalker = OTHER.username
    commit()
    expect(msgs).toHaveLength(1)
    expect(identityKept, '第二道令牌检查没做 ⇒ 失效分支还产出了新数组，会白重渲染一次').toBeGreaterThan(0)
  })
})

describe('合并、去重与写回缓存', () => {
  it('新消息接到尾部，水位只按**新增那批**推进，缓存写的是合并后的整列表', async () => {
    msgs = [msg(1), msg(2)]
    seenWatermark = 2
    mocks.apiGetNewMessages.mockResolvedValue({ messages: [msg(3), msg(4)] })
    await poll()
    expect(msgs.map((m) => m.localId)).toEqual([1, 2, 3, 4])
    expect(watermarkFromCalls).toHaveLength(1)
    expect(watermarkFromCalls[0]?.map((m) => m.localId), '水位推进用的是整批 fresh：重复项会把水位算回去').toEqual([3, 4])
    expect(mocks.writeRenderCache).toHaveBeenCalledWith(
      'chat-msgs:v2:' + CUR.username,
      expect.arrayContaining([expect.objectContaining({ localId: 1 }), expect.objectContaining({ localId: 4 })]),
    )
    expect((mocks.writeRenderCache.mock.calls[0]?.[1] as readonly WechatMessage[]).length, '只写增量 ⇒ 下次打开旧消息全丢').toBe(4)
  })

  it('localId + sortSeq 都见过的行不重复追加（保持原身份）', async () => {
    msgs = [msg(2, { sortSeq: 20 })]
    seenWatermark = 20
    mocks.apiGetNewMessages.mockResolvedValue({ messages: [msg(2, { sortSeq: 20 })] })
    await poll()
    expect(msgs).toHaveLength(1)
    expect(identityKept).toBeGreaterThan(0)
    expect(mocks.writeRenderCache, '什么都没变还写缓存').not.toHaveBeenCalled()
  })

  it('同一条 localId 但 sortSeq 变了（就地改过）⇒ 算新消息，不去重掉', async () => {
    msgs = [msg(2, { sortSeq: 20 })]
    seenWatermark = 20
    mocks.apiGetNewMessages.mockResolvedValue({ messages: [msg(2, { sortSeq: 21 })] })
    await poll()
    expect(msgs.map((m) => m.sortSeq)).toEqual([20, 21])
  })
})

describe('状态栏：成功与失败都要如实留痕', () => {
  it('成功 ⇒ `✓ 时间 · N 条新消息`', async () => {
    msgs = [msg(1)]
    seenWatermark = 1
    mocks.apiGetNewMessages.mockResolvedValue({ messages: [msg(2), msg(3)] })
    await poll()
    expect(pollStatus).toMatch(/^✓ .*\b2 条新消息$/)
  })

  it('失败 ⇒ `✗ 原因`，且长原因截到 60 字符内', async () => {
    seenWatermark = 1
    liveTalker = OTHER.username
    const boom = new Error('E'.repeat(200))
    // 归属仍然对得上：把 talker 改回当前会话，只让 RPC 失败
    liveTalker = CUR.username
    mocks.apiGetNewMessages.mockRejectedValue(boom)
    await poll()
    expect(pollStatus.startsWith('✗ '), `失败没进状态栏：${pollStatus}`).toBe(true)
    expect(pollStatus.length).toBeLessThanOrEqual(62)
  })
})

describe('定时器：可见与隐藏两套周期，卸载要清干净', () => {
  /** 换到假表之后必须**重新挂载** —— 定时器是在 effect 里注册的，先挂后造假表等于没造。 */
  function remount(): void {
    act(() => { root.unmount() })
    root = createRoot(host)
    rerender()
  }

  /** 推进假时间并把微任务排干（`inFlightRef` 闸门要等 promise 落地才放开）。 */
  async function tick(ms: number): Promise<void> {
    await act(async () => { vi.advanceTimersByTime(ms); await Promise.resolve(); await Promise.resolve() })
  }

  const calls = (): number => mocks.apiGetNewMessages.mock.calls.length

  it('可见 ⇒ 每 POLL_VISIBLE_MS 一次；隐藏 ⇒ 换成 POLL_HIDDEN_MS', async () => {
    vi.useFakeTimers()
    seenWatermark = 1
    remount()
    await tick(POLL_VISIBLE_MS)
    expect(calls(), '可见时一个周期都没打后端').toBe(1)
    await tick(POLL_VISIBLE_MS)
    expect(calls(), '两个周期只发了一次').toBe(2)

    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await Promise.resolve()
    const atSwitch = calls()
    expect(atSwitch, '切到后台没立刻补一次轮询（切回前台之前那段是空的）').toBe(3)
    await tick(POLL_VISIBLE_MS)
    expect(calls(), '切到隐藏后仍按可见周期打后端').toBe(atSwitch)
    await tick(POLL_HIDDEN_MS)
    expect(calls(), '隐藏周期没生效').toBe(atSwitch + 1)
  })

  it('卸载 ⇒ 定时器与 visibilitychange 监听都摘掉（切会话会重挂，漏一次就多一条在打的定时器）', async () => {
    vi.useFakeTimers()
    seenWatermark = 1
    remount()
    await tick(POLL_VISIBLE_MS)
    const at = calls()
    expect(at, '夹具本身没跑起来').toBeGreaterThan(0)
    act(() => { root.unmount() })
    await tick(POLL_VISIBLE_MS * 5)
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await Promise.resolve()
    expect(calls(), '卸载后还在轮询').toBe(at)
    root = createRoot(host)
  })
})

describe('宿主推送与 SWR 广播：两个事件都要同时触发增量与对账', () => {
  it('`dsh-wechat-data-updated` ⇒ pollNew + reconcileRecent 各一次', async () => {
    seenWatermark = 3
    await act(async () => { window.dispatchEvent(new Event('dsh-wechat-data-updated')) })
    await flush()
    expect(mocks.apiGetNewMessages, '推送没触发增量轮询').toHaveBeenCalledTimes(1)
    expect(mocks.apiGetMessages, '推送没触发就地改对账（撤回会一直挂着旧内容）').toHaveBeenCalledWith({ talker: CUR.username, limit: 50 })
  })

  it(`\`${SNAPSHOT_REFRESHED_EVENT}:messages\` ⇒ 同样两条都跑（SWR 后台刷新落地的另一半）`, async () => {
    seenWatermark = 3
    await act(async () => { window.dispatchEvent(new Event(`${SNAPSHOT_REFRESHED_EVENT}:messages`)) })
    await flush()
    expect(mocks.apiGetNewMessages).toHaveBeenCalledTimes(1)
    expect(mocks.apiGetMessages).toHaveBeenCalledTimes(1)
  })
})

describe('就地改对账：只替换真变了的行', () => {
  it('type 变了 ⇒ 换成新行；什么都没变 ⇒ 保持原身份且不写缓存', async () => {
    const a = msg(1, { sortSeq: 10 })
    const b = msg(2, { sortSeq: 11 })
    msgs = [a, b]
    mocks.apiGetMessages.mockResolvedValue({ messages: [msg(1, { sortSeq: 11 }), b] })
    await reconcile()
    expect(msgs[0]?.sortSeq, 'sortSeq 变了没替换').toBe(11)
    expect(msgs[1]).toBe(b)
    expect(mocks.writeRenderCache).toHaveBeenCalledTimes(1)

    mocks.writeRenderCache.mockClear()
    committed = 0
    mocks.apiGetMessages.mockResolvedValue({ messages: [msg(1, { sortSeq: 11 }), b] })
    await reconcile()
    expect(committed, '什么都没变还提交新数组').toBe(0)
    expect(mocks.writeRenderCache, '无变化也写缓存（每次推送都把整列表序列化一遍）').not.toHaveBeenCalled()
  })

  it('type 与 sortSeq 都没变 ⇒ 哪怕正文换了也不替换（后端这两项才是变化信号）', async () => {
    const a = msg(1, { sortSeq: 10 })
    msgs = [a]
    mocks.apiGetMessages.mockResolvedValue({ messages: [{ ...a, remark: '换了正文但序号没动' } as WechatMessage] })
    await reconcile()
    expect(msgs[0], '只看 localId 就替换 ⇒ 会把没动的行也换成新对象').toBe(a)
  })

  it('一次只允许一个在途；返回空列表时不动界面', async () => {
    msgs = [msg(1)]
    mocks.apiGetMessages.mockResolvedValue({ messages: [] })
    await reconcile()
    expect(committed).toBe(0)
    expect(msgs).toHaveLength(1)

    committed = 0
    mocks.apiGetMessages.mockResolvedValue({ messages: [msg(1, { type: 10002 })] })
    await reconcile()
    expect(msgs[0]?.type, '撤回(10002)没换行').toBe(10002)
  })

  it('没有会话 ⇒ 不发请求', async () => {
    session = null
    rerender()
    await reconcile()
    await poll()
    expect(mocks.apiGetMessages).not.toHaveBeenCalled()
  })
})
