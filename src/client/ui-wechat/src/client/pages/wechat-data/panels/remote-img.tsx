/**
 * 画一张「可能是远程地址」的图（M23）。
 *
 * 与直接写 `<img src={proxyableSrc(url)}>` 的区别只有一条：**远程地址不再由渲染层自己去取**，
 * 而是交给后端的图片代理 —— 取回动作进操作记录、字节落在本机缓存里，且只认腾讯系主机白名单。
 * 这件事值得多一层组件的原因：让 `<img>` 直接吃 https 地址，等于把
 * 「渲染层可向任意 https 主机发请求」写进产品，绕过白名单与操作记录。
 *
 * 四种状态，都刻意区分开（朋友圈的格子有固定尺寸，把「还在取」和「取不到」都画成空白，
 * 版面就会塌成一块块没意义的空格子）：
 *   · `empty`   没有地址；
 *   · `pending` 远程地址还在代理路上 —— 画占位，不画破图；
 *   · `ready`   本地地址（`data:`/`blob:`/`file:`）**同步就是它**，或多等一次之后拿到 data URL；
 *   · `failed`  取不到（开关关掉、主机不在微信 CDN 清单内、CDN 404）—— 画「加载失败」而不是坏图标。
 */
import { useEffect, useState } from 'react'
import { apiGetRemoteImageUrl } from '../api.ts'

/**
 * 本地地址：能直接画，不需要代理。也用于「这个地址只在本机有效」的判断（如 `<video poster>`）。
 *
 * 注释里曾有一个 `upgradeToHttps()`（把 `http://` 改写成 `https://` 再交给代理）。
 * **2026-09-29 实测后删除**：同一张图用原始 http 与改写 https **直连都是 HTTP 400**
 * （朋友圈 8/8 样本），说明这些 CDN 地址本身已失效，改协议并不能让它可取；
 * 保留它只会每张图白跑一次注定失败的请求。真机结论：**这批历史数据只能靠本机解码**，
 * 而"CDN 失效 ⇒ 回落本机解码"由 `fallbackSrc` 承担。
 */
export function localImageSrc(src: string | undefined): string {
  const s = String(src ?? '').trim()
  return /^(data:|blob:|file:)/i.test(s) ? s : ''
}

/**
 * 代理取图的超时（毫秒）。
 *
 * 为什么必须有：代理请求卡住时（系统防火墙丢包、断网但 `navigator.onLine` 仍为 true、
 * 对端不响应），`pending` 会一直停着 —— 而**本地兜底是在"主地址失败"时才生效的**，
 * 于是用户看到的是一个永远不出来的空框。到点即判"取不到"，让 `fallbackSrc`（本机解码）接管。
 */
export const REMOTE_IMAGE_TIMEOUT_MS = 4000

export type RemoteImageStatus = 'empty' | 'pending' | 'ready' | 'failed'

export interface RemoteImageState {
  status: RemoteImageStatus
  /** `status === 'ready'` 时是可直接给 `src`/`poster` 用的地址，其余情况为空串。 */
  src: string
}

/**
 * 把一个「可能是远程」的地址解析成可直接画的地址。
 *
 * 2026-09-29 修正（用户报"朋友圈有的图片加载不出来"）：
 * 原实现只在代理**成功**时落状态，取不到时什么都不做 ⇒ `status` 停在 `pending`，
 * 而上面文档写明应画 `failed` 的三种情况（开关关掉 / 主机不在 CDN 清单 / CDN 404）
 * **全都表现为永久「加载中」**。这里补上「明确失败」，并支持**失败后回落**到备选地址
 * （朋友圈用它把 CDN 失效的图回落到本机解码结果，避免一格空白）。
 *
 * @param source - 消息/库里记录的图片地址（主地址，朋友圈传 CDN 地址）。
 * @param fallback - 主地址取不到时可用的备选地址（朋友圈传本机解码出的 `data:`）。
 * @returns 当前状态与可画的地址；远程地址在代理回话之前是 `pending`（不会拿旧图凑数）。
 */
export function useRemoteImage(source: string, fallback = ''): RemoteImageState {
  const trimmed = String(source ?? '').trim()
  const local = localImageSrc(trimmed)
  const remote = local === '' && /^https?:/i.test(trimmed)
  /** 解析结果连同**它属于哪个地址**一起存：换源时（列表复用节点）不能拿上一张图错画在新条目上。 */
  const [hit, setHit] = useState<{ forUrl: string; dataUrl: string } | null>(null)
  /** 明确失败的主地址（代理拒绝/取不到）——用于区分"还在取"与"取不到"。 */
  const [miss, setMiss] = useState<{ forUrl: string } | null>(null)
  const fbLocal = localImageSrc(fallback)

  /**
   * **离线短路**（2026-10-03，用户要求"只有在无网的环境下才使用本地缓存"）。
   *
   * 断网时**不发那一趟注定失败的代理请求**：省一次 RPC 与一次超时等待，
   * 直接把主地址判定为"取不到" ⇒ 走下面的回落分支用本地 `fallback`。
   * 这是**共用层的一处实现**：所有走 `useRemoteImage` 的面板（朋友圈 / 聊天 / 收藏 / 文件 / 公众号…）
   * 同时得到"先网后本、无网只用本地"的行为。`offline` 进依赖数组 ⇒ 网络恢复时会自动重试。
   */
  const offline = typeof navigator !== 'undefined' && navigator.onLine === false
  useEffect(() => {
    if (!remote) return
    if (offline) { setMiss({ forUrl: trimmed }); return }
    let alive = true
    /** 超时闸：卡住的请求也必须有个终点，否则本地兜底永远不触发（见常量上的说明）。 */
    const timer = setTimeout(() => { if (alive) setMiss({ forUrl: trimmed }) }, REMOTE_IMAGE_TIMEOUT_MS)
    void apiGetRemoteImageUrl(trimmed).then((u) => {
      if (!alive) return
      clearTimeout(timer)
      if (u !== '') setHit({ forUrl: trimmed, dataUrl: u })
      else setMiss({ forUrl: trimmed }) // ← 取不到就是取不到：不再让格子永远转圈
    }).catch(() => { if (alive) { clearTimeout(timer); setMiss({ forUrl: trimmed }) } })
    return () => { alive = false; clearTimeout(timer) }
  }, [trimmed, remote, offline])

  // 主地址失败 ⇒ 回落备选（本地解码结果）——避免"CDN 失效 = 一格空白"
  if (miss !== null && miss.forUrl === trimmed && fbLocal !== '') return { status: 'ready', src: fbLocal }
  if (trimmed === '') return fbLocal === '' ? { status: 'empty', src: '' } : { status: 'ready', src: fbLocal }
  if (local !== '') return { status: 'ready', src: trimmed }
  if (!remote) return fbLocal === '' ? { status: 'failed', src: '' } : { status: 'ready', src: fbLocal }
  if (hit !== null && hit.forUrl === trimmed) return { status: 'ready', src: hit.dataUrl }
  if (miss !== null && miss.forUrl === trimmed) return { status: 'failed', src: '' }
  return { status: 'pending', src: '' }
}

/**
 * 与原生 `<img>` 同形（少一个 `src` 的歧义：这里的 `src` 允许是远程地址），
 * 外加两种占位。**这里刻意不接受 `data-*`**：`pending` / `failed` 画的是占位而不是 `<img>`，
 * 把「哪一格该去本机解码」这类靠 DOM 认的钥匙挂在这个组件上，就会在代理回话之前消失 ——
 * 于是那一格永远不会被观察到。这类钥匙要挂在**永远在 DOM 里**的外层节点上。
 * （这条只能由 `remote-image-wiring.spec.ts` 钉：`tsc` 对带连字符的 JSX 属性名不做多余属性检查。）
 */
export interface RemoteImgProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  /** 图片地址：本地地址原样用，`http(s)` 走后端代理。 */
  src: string
  /**
   * 主地址取不到时的**回落地址**（2026-09-29 加）。
   *
   * 朋友圈的用法：`src` 传 CDN 地址（秒开）、`fallbackSrc` 传本机解码出的 `data:`。
   * 于是 CDN 失效/被开关拦下时，那一格仍然显示本机解码结果，而不是空白或"加载失败"。
   * 与 `pending`/`failed` 一样，它**不会**被透传到 `<img>` 上（下面显式解构掉）。
   */
  fallbackSrc?: string
  /** 代理还在取时画什么。不给就什么都不画，固定尺寸的格子会塌。 */
  pending?: React.ReactNode
  /** 取不到时画什么（开关关掉、主机不在微信 CDN 清单内、CDN 404、回落也没有）。不给就一直不画，由外层占位接管。 */
  failed?: React.ReactNode
  /** `src` 本身为空时画什么（既没有可代理的 https，也没有本机解码结果）。不给就返回 null ⇒ **空框**，用户看不出原因。 */
  empty?: React.ReactNode
}

/**
 * 渲染一张图：本地地址直接画，远程地址经后端代理，主地址失败可回落 `fallbackSrc`。
 * @param props - 与 `<img>` 同名的展示属性，外加 fallbackSrc / pending / failed 三种处理。
 * @returns `<img>`，或调用方给的占位内容；什么都没有时返回 null。
 */
export function RemoteImg({ pending, failed, empty, fallbackSrc, ...imgProps }: RemoteImgProps): React.JSX.Element | null {
  const state = useRemoteImage(imgProps.src, fallbackSrc ?? '')
  if (state.status === 'ready') return <img {...imgProps} src={state.src} />
  if (state.status === 'pending') return <>{pending ?? null}</>
  if (state.status === 'failed') return <>{failed ?? null}</>
  // `src` 为空：没有任何来源可画 —— 用调用方给的说明代替空框（不给则保持旧行为）
  if (state.status === 'empty') return <>{empty ?? null}</>
  return null
}
