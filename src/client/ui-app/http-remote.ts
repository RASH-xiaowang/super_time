/**
 * 浏览器态的 Remote：把「调后端」从 Electron IPC 换成同源 HTTP，把「后端事件」换成 SSE。
 *
 * ## 它替换的是哪一段
 *
 * 桌面端的路径是 `window.electronAPI.wechat.call(method, args)`（preload 桥 → 主进程
 * `ipc-wechat.js` → worker）。手机浏览器里没有 preload，所以这里用 `fetch` 打
 * `POST /api/wechat/call`，服务端那一边过的是**同一道闸门**（`call-gates.js`）、
 * 进的是**同一个 worker**。返回的信封形状 `{ ok, value }` / `{ ok:false, error }` 完全一致，
 * 因此 `api-core.ts` 的 `unwrap` 与所有面板**一行都不用改**。
 *
 * 事件同理：SSE 的 data 帧与 IPC 的 `wechat:event` 载荷同形（`{ name, args }`），
 * 两边都交给 `wechat-events.ts` 的同一张映射表翻译成 DOM CustomEvent ——
 * WAL 实时刷新链（`dsh-wechat-data-updated`）在手机上因此与桌面端同样即时。
 *
 * ## 三个刻意的决定
 *
 *   ① **客户端不设超时**。后端的调用超时分档是 60 秒 / 长任务 10 分钟
 *      （`backend-rpc.js`），服务端按方法名自己选。客户端再设一个更短的超时，
 *      只会让「正常跑着的长任务」被前端提前判死（用户看到失败，后端其实还在跑，
 *      而且结果会被丢掉）。`AbortController` 只用于用户主动取消。
 *   ② **切回前台必须补一次全量刷新**。手机浏览器切到后台会挂起 `EventSource`，
 *      期间的事件全丢；回到前台时界面还停在旧数据上 —— 这与上一轮实时性事故的
 *      症状一模一样（界面正常、数据不动）。所以 `visibilitychange` 变可见时
 *      主动派发一次 `wechat-data/updated`，让面板重取（带 2 秒限频防抖）。
 *   ③ **会话失效要能被界面知道**。令牌换来的会话有 12 小时寿命，过期后每个请求都是 401。
 *      这里把 401 翻译成一个 DOM 事件（`dsh-remote-session-lost`），令牌门据此重新出现 ——
 *      否则用户看到的是一屏「加载失败」，而原因是「该重新扫码了」。
 *
 * @module ui-app/http-remote
 */
import { dispatchWechatEvent } from './wechat-events.ts'
import type { BackendEvent } from './wechat-events.ts'

/** 会话失效时派发的 DOM 事件（令牌门订阅它并重新出现）。 */
export const SESSION_LOST_EVENT = 'dsh-remote-session-lost'

/** 切回前台时补刷新的最小间隔：快速切来切去不该变成一串重查询。 */
const RESYNC_MIN_GAP_MS = 2_000

/** 会话失效探测的退避上限：连不上时不要每秒都去打一次。 */
const PROBE_MAX_GAP_MS = 15_000

/** 后端信封（与 IPC 侧同形；这里只声明用到的字段）。 */
interface Envelope {
  ok: boolean
  value?: unknown
  error?: { message?: string, code?: string, details?: unknown }
}

/** 造一个「网络/协议层失败」的信封 —— 面板的 `unwrap` 只认信封，抛异常会变成未捕获拒绝。 */
function errorEnvelope(message: string, code: string): Envelope {
  return { ok: false, error: { message, code } }
}

let sessionLostFired = false

/** 通知界面「会话没了，该重新扫码」。幂等：一次失效只通知一次，恢复后自动复位。 */
function notifySessionLost(): void {
  if (sessionLostFired) return
  sessionLostFired = true
  window.dispatchEvent(new CustomEvent(SESSION_LOST_EVENT))
}

/** 会话恢复（重新登录成功）时复位，下次失效才还能再通知。 */
export function resetSessionLost(): void {
  sessionLostFired = false
}

/**
 * 调一个后端方法。
 *
 * @param method - `@Remote` 方法名（服务端还要过白名单，不在名单里会回
 *   `METHOD_NOT_ALLOWED_REMOTE`）。
 * @param args - 参数数组。
 * @returns 后端信封；网络失败时也返回信封（不抛）。
 */
export async function callRemote(method: string, args: unknown[]): Promise<Envelope> {
  try {
    const res = await fetch('/api/wechat/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 同源；写出来是为了让「Cookie 必须带上」这件事在代码里可见（SSE 也依赖它）
      credentials: 'same-origin',
      body: JSON.stringify({ method, args }),
    })
    if (res.status === 401) {
      notifySessionLost()
      return errorEnvelope('会话已失效，请重新扫码或输入令牌', 'UNAUTHORIZED')
    }
    const text = await res.text()
    try {
      return JSON.parse(text) as Envelope
    } catch {
      // 服务端在极端情况下（进程被杀、代理插入错误页）会给出非 JSON
      return errorEnvelope(`远程调用返回了无法解析的响应（HTTP ${String(res.status)}）`, 'BAD_RESPONSE')
    }
  } catch (e) {
    return errorEnvelope(
      `连不上电脑上的 Super Time：${(e as Error)?.message ?? String(e)}`,
      'NETWORK',
    )
  }
}

/**
 * 造一个与桌面端 `remoteProxy` 同形状的 Remote，交给 `setWechatRemote`。
 *
 * 用 Proxy 而不是逐个列方法：后端有 194 个 `@Remote` 方法且还在增加，
 * 列一份就等于每次加方法都要回来改这里（而忘了改的症状是「手机上这个功能不存在」）。
 * `$on` 是 `api.ts` 约定的订阅位，桌面端也是返回一个空退订函数。
 * @returns 可传给 `setWechatRemote` 的对象。
 */
export function createHttpRemote(): Record<string, unknown> {
  return new Proxy({} as Record<string, (...a: unknown[]) => unknown>, {
    get(_target, prop) {
      if (prop === '$on') return () => () => undefined
      const name = String(prop)
      return (...args: unknown[]) => callRemote(name, args)
    },
  })
}

/**
 * 用令牌换会话。
 *
 * @param token - 桌面端「设置 → 远程访问（手机）」里生成/显示的令牌。
 * @returns 成功为 `{ ok: true }`；失败给一句能直接显示给用户的原因。
 */
export async function authenticate(token: string): Promise<{ ok: boolean, error?: string }> {
  try {
    const res = await fetch('/api/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token }),
    })
    if (res.ok) {
      resetSessionLost()
      return { ok: true }
    }
    const body = (await res.json().catch(() => null)) as Envelope | null
    if (res.status === 429) return { ok: false, error: '试错次数太多，请一分钟后再试' }
    return { ok: false, error: body?.error?.message || `令牌不正确（HTTP ${String(res.status)}）` }
  } catch (e) {
    return { ok: false, error: `连不上电脑上的 Super Time：${(e as Error)?.message ?? String(e)}` }
  }
}

/**
 * 当前有没有有效会话（令牌门用它决定「直接进」还是「先要令牌」）。
 * @returns 有效为 true。
 */
export async function hasSession(): Promise<boolean> {
  try {
    const res = await fetch('/api/status', { credentials: 'same-origin' })
    return res.ok
  } catch {
    return false
  }
}

/** 把地址栏里的 `?t=<令牌>` 抹掉（令牌只该出现一次，别留在历史与 Referer 里）。 */
export function stripTokenFromUrl(): void {
  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('t')) return
    url.searchParams.delete('t')
    window.history.replaceState(null, '', url.toString())
  } catch {
    /* replaceState 在个别环境（沙箱 iframe）会抛；抹不掉不影响功能 */
  }
}

/** 从地址栏读一次性令牌（扫码进来的那一趟）。@returns 令牌，没有则空串。 */
export function tokenFromUrl(): string {
  try {
    return new URL(window.location.href).searchParams.get('t') ?? ''
  } catch {
    return ''
  }
}

/**
 * 起 SSE 事件流，把后端事件翻译成 DOM CustomEvent。
 *
 * `EventSource` 自带重连（服务端下发了 `retry: 3000`），所以这里不自己写重连循环；
 * 要做的是另外两件事：**区分「网络抖动」与「会话失效」**（前者等它自己重连，
 * 后者要叫令牌门回来），以及**切回前台补一次刷新**（后台期间的事件已经丢了）。
 *
 * @param opts.dispatch - 事件派发实现（测试注入用），缺省 `dispatchWechatEvent`。
 * @returns 停止函数（关掉流与所有监听器）。
 */
export function startHttpEventRelay(
  opts: { dispatch?: (ev: BackendEvent) => string | null } = {},
): () => void {
  const dispatch = opts.dispatch ?? ((ev: BackendEvent) => dispatchWechatEvent(ev))
  const es = new EventSource('/api/wechat/events')
  let probeGap = 1_000
  let lastProbe = 0
  let lastResync = 0

  es.onmessage = (e: MessageEvent<string>) => {
    try {
      const ev = JSON.parse(e.data) as BackendEvent
      if (ev && typeof ev.name === 'string') dispatch(ev)
    } catch {
      /* 心跳注释帧或坏帧：忽略即可，不值得断流 */
    }
  }

  es.onerror = () => {
    // 退避探测：401 = 会话没了（叫令牌门回来）；其它 = 网络抖动（交给 EventSource 自己重连）。
    const now = Date.now()
    if (now - lastProbe < probeGap) return
    lastProbe = now
    probeGap = Math.min(probeGap * 2, PROBE_MAX_GAP_MS)
    void hasSession().then((ok) => {
      if (ok) probeGap = 1_000
      else {
        notifySessionLost()
        es.close() // 会话没了就别再自动重连：每次重连都是一次 401
      }
    })
  }

  // 切回前台补一次刷新：后台期间 SSE 被挂起，事件全丢，界面会停在旧数据上。
  const onVisible = (): void => {
    if (document.visibilityState !== 'visible') return
    const now = Date.now()
    if (now - lastResync < RESYNC_MIN_GAP_MS) return
    lastResync = now
    probeGap = 1_000
    // 走同一张映射表派发，保证事件名与 detail 口径和真实推送完全一致
    dispatch({ name: 'wechat-data/updated', args: [] })
  }
  document.addEventListener('visibilitychange', onVisible)

  return () => {
    document.removeEventListener('visibilitychange', onVisible)
    es.close()
  }
}
