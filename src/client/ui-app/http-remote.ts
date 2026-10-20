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
 *   ③ **会话失效要能被界面知道**。配对码换来的会话有 12 小时寿命，过期后每个请求都是 401。
 *      这里把 401 翻译成一个 DOM 事件（`dsh-remote-session-lost`），令牌门据此重新出现 ——
 *      否则用户看到的是一屏「加载失败」，而原因是「该重新扫码了」。
 *
 * @module ui-app/http-remote
 */
import { dispatchWechatEvent } from './wechat-events.ts'
import type { BackendEvent } from './wechat-events.ts'
import type { WechatRemote } from '@deepseek-ai/dsh-client-ui-wechat/host'
import type { RemoteEnvelope } from '@deepseek-ai/dsh-client-ui-wechat/contracts'

/** 会话失效时派发的 DOM 事件（令牌门订阅它并重新出现）。 */
export const SESSION_LOST_EVENT = 'dsh-remote-session-lost'

/**
 * 「连不上电脑」与「会话没了」的边界（2026-10-14 真机反例量出来的）。
 *
 * 杀掉电脑上的应用之后，浏览器里 `GET /api/status` 得到的是**网络层失败**（`ERR_EMPTY_RESPONSE`），
 * 不是 401。而旧实现把「探测没通过」一律当成会话失效 ⇒ 手机上弹出一句
 * 「会话已失效，请重新扫码或输入配对码」，把用户踢回令牌门 —— 可在服务没跑起来的时候，
 * 令牌门本身就是走不通的，于是卡死在一个说错原因的循环里。
 * 这条事件就是给那一侧的：应用继续显示，横幅说「连不上电脑上的 Super Time，正在重试」。
 */
export const REMOTE_UNREACHABLE_EVENT = 'dsh-remote-unreachable'

/** 探测的三种结果 —— 把「没权限」和「没在服务」分开，是这次修复的全部要点。 */
export type SessionProbe = 'ok' | 'gone' | 'unreachable'

/** 切回前台时补刷新的最小间隔：快速切来切去不该变成一串重查询。 */
const RESYNC_MIN_GAP_MS = 2_000

/** 会话失效探测的退避上限：连不上时不要每秒都去打一次。 */
const PROBE_MAX_GAP_MS = 15_000

/** 造一个「网络/协议层失败」的信封 —— 面板的 `unwrap` 只认信封，抛异常会变成未捕获拒绝。 */
function errorEnvelope(message: string, code: string): RemoteEnvelope {
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

/** 连不上状态的上一次值：只在**变化**时派发事件（每次退避都发一遍会把横幅闪成噪声）。 */
let unreachableSince = false

/**
 * 通知界面「现在连不上电脑上那个服务」（或恢复了）。
 * @param down - true = 连不上；false = 探通了。
 */
function setUnreachable(down: boolean): void {
  if (unreachableSince === down) return
  unreachableSince = down
  window.dispatchEvent(new CustomEvent(REMOTE_UNREACHABLE_EVENT, { detail: { down } }))
  // 恢复的那一刻补一次重取：断连期间的事件全丢了，不补就会停在旧数据上 ——
  // 与「切回前台补刷新」走的是同一条路径（同一张映射表）。
  if (!down) dispatchWechatEvent({ name: 'wechat-data/updated', args: [] })
}

/**
 * 调一个后端方法。
 *
 * @param method - `@Remote` 方法名（服务端还要过白名单，不在名单里会回
 *   `METHOD_NOT_ALLOWED_REMOTE`）。
 * @param args - 参数数组。
 * @returns 后端信封；网络失败时也返回信封（不抛）。
 */
export async function callRemote(method: string, args: unknown[]): Promise<RemoteEnvelope> {
  try {
    const res = await fetch('/api/wechat/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // 同源；写出来是为了让「Cookie 必须带上」这件事在代码里可见（SSE 也依赖它）
      credentials: 'same-origin',
      body: JSON.stringify({ method, args }),
    })
    if (res.status === 401) {
      // 401 是「服务活着、只是没权限」——必须先把「连不上」那个状态清掉，
      // 否则令牌门会盖在一条「连不上电脑上的 Super Time，正在重试」的横幅上（真机实测到的）。
      setUnreachable(false)
      notifySessionLost()
      return errorEnvelope('会话已失效，请重新扫码或输入配对码', 'UNAUTHORIZED')
    }
    // 任何一次 talking 成功都是「服务回来了」的实证。恢复**不能**只靠 SSE 出错时的退避探测：
    // 服务端回来后 EventSource 自己会重连成功、不再 onerror，那条退避路径就永远不再走一遍，
    // 横幅会一直挂着（真机实测：重启应用 30 秒后横幅还在）。
    setUnreachable(false)
    const text = await res.text()
    try {
      return JSON.parse(text) as RemoteEnvelope
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
 * 用 Proxy 而不是逐个列方法：后端有 195 个 `@Remote` 方法且还在增加，
 * 列一份就等于每次加方法都要回来改这里（而忘了改的症状是「手机上这个功能不存在」）。
 * `$on` 是 `api.ts` 约定的订阅位，桌面端也是返回一个空退订函数。
 * @returns 可传给 `setWechatRemote` 的对象。
 */
export function createHttpRemote(): WechatRemote {
  const remote = new Proxy({} as WechatRemote, {
    get(_target, prop) {
      if (prop === '$on') return () => () => undefined
      const name = String(prop)
      return (...args: unknown[]) => callRemote(name, args)
    },
  })
  return remote
}

/**
 * 用一次性配对码换会话。
 *
 * @param token - 桌面端「打开网页」交接时生成的一次性配对码（不再有设置入口）。
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
    const body = (await res.json().catch(() => null)) as RemoteEnvelope | null
    if (res.status === 429) return { ok: false, error: '试错次数太多，请一分钟后再试' }
    return { ok: false, error: body?.error?.message || `配对码不正确（HTTP ${String(res.status)}）` }
  } catch (e) {
    return { ok: false, error: `连不上电脑上的 Super Time：${(e as Error)?.message ?? String(e)}` }
  }
}

/**
 * 探测当前会话：`ok` / `gone`（401、403 = 令牌门该回来）/ `unreachable`（连不上 = 别改用户的登录态）。
 *
 * 三态而不是布尔：把「没在服务」误判成「没权限」，症状就是上面注释里那条 ——
 * 一句说错原因的「请重新扫码」，而且把界面关进了一个此刻根本走不通的门。
 * @returns 探测结果。
 */
export async function probeSession(): Promise<SessionProbe> {
  try {
    const res = await fetch('/api/status', { credentials: 'same-origin' })
    if (res.ok) return 'ok'
    return res.status === 401 || res.status === 403 ? 'gone' : 'unreachable'
  } catch {
    return 'unreachable'
  }
}

/**
 * 当前有没有有效会话（令牌门用它决定「直接进」还是「先要令牌」）。
 *
 * 注意这里的口径：**探测失败按「还在」处理**（返回 true）。首屏连不上时，
 * 让用户看到一个带横幅的应用（数据是旧的 / 取不到）比把他挡在门外更容易理解；
 * 真的没权限时服务端会明确回 401，那时才出门。
 * @returns 有效为 true。
 */
export async function hasSession(): Promise<boolean> {
  return (await probeSession()) !== 'gone'
}

/** 把地址栏里的 `?t=<配对码>` 抹掉（配对码只该出现一次，别留在历史与 Referer 里）。 */
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

/** 从地址栏读一次性配对码（扫码进来的那一趟）。@returns 配对码，没有则空串。 */
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

  // 连上了（含**自动重连成功**）就是把横幅撤掉的时机：服务端回来后 EventSource 会自己接上，
  // 而接上之后既不再 onerror、也不一定有新的 HTTP 调用（用户可能就把页面晾在那儿），
  // 只靠那两条恢复路径真机实测会挂住横幅。onopen 能触发就说明连接与 Cookie 都是好的。
  es.onopen = () => {
    probeGap = 1_000
    setUnreachable(false)
  }

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
    void probeSession().then((p) => {
      if (p === 'ok') {
        probeGap = 1_000
        setUnreachable(false)
        return
      }
      if (p === 'unreachable') {
        // 服务没在跑 / 网断了：**不许**改用户的登录态，只把原因说出来并继续按退避重试。
        setUnreachable(true)
        return
      }
      // 同上：'gone' 意味着服务端答话了（答的是 401），「连不上」到此为止。
      setUnreachable(false)
      notifySessionLost()
      es.close() // 会话没了就别再自动重连：每次重连都是一次 401
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
