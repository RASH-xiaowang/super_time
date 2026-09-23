/**
 * 画一张「可能是远程地址」的图（M23）。
 *
 * 与直接写 `<img src={cspSafeSrc(url)}>` 的区别只有一条：**远程地址不再由渲染层自己去取**，
 * 而是交给后端的图片代理 —— 于是「自动获取原图（CDN）」与「禁止出网」两个开关管得到它、
 * 取回动作进操作记录、字节落在本机缓存里。这件事值得多一层组件的原因：让 `<img>` 直接吃
 * https 地址，等于把「渲染层可向任意 https 主机发请求」写进产品，那两个开关都拦不到它 ——
 * 用户在界面上关掉开关之后其实还在出网，隐私声明里「关掉就不再请求」那句就成了假的。
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

/** 本地地址：能直接画，不需要代理。也用于「这个地址只在本机有效」的判断（如 `<video poster>`）。 */
export function localImageSrc(src: string): string {
  const s = String(src ?? '').trim()
  return /^(data:|blob:|file:)/i.test(s) ? s : ''
}

export type RemoteImageStatus = 'empty' | 'pending' | 'ready' | 'failed'

export interface RemoteImageState {
  status: RemoteImageStatus
  /** `status === 'ready'` 时是可直接给 `src`/`poster` 用的地址，其余情况为空串。 */
  src: string
}

/**
 * 把一个「可能是远程」的地址解析成可直接画的地址。
 * @param source - 消息/库里记录的图片地址。
 * @returns 当前状态与可画的地址；远程地址在代理回话之前是 `pending`（不会拿旧图凑数）。
 */
export function useRemoteImage(source: string): RemoteImageState {
  const trimmed = String(source ?? '').trim()
  const local = localImageSrc(trimmed)
  const remote = local === '' && /^https?:/i.test(trimmed)
  /** 解析结果连同**它属于哪个地址**一起存：换源时（列表复用节点）不能拿上一张图错画在新条目上。 */
  const [hit, setHit] = useState<{ forUrl: string; dataUrl: string } | null>(null)

  useEffect(() => {
    if (!remote) return
    let alive = true
    void apiGetRemoteImageUrl(trimmed).then((u) => {
      if (alive && u !== '') setHit({ forUrl: trimmed, dataUrl: u })
    })
    return () => { alive = false }
  }, [trimmed, remote])

  if (trimmed === '') return { status: 'empty', src: '' }
  if (local !== '') return { status: 'ready', src: trimmed }
  if (!remote) return { status: 'failed', src: '' }
  if (hit !== null && hit.forUrl === trimmed) return { status: 'ready', src: hit.dataUrl }
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
  /** 代理还在取时画什么。不给就什么都不画，固定尺寸的格子会塌。 */
  pending?: React.ReactNode
  /** 取不到时画什么（开关关掉、主机不在微信 CDN 清单内、CDN 404）。不给就一直不画，由外层占位接管。 */
  failed?: React.ReactNode
}

/**
 * 渲染一张图：本地地址直接画，远程地址经后端代理。
 * @param props - 与 `<img>` 同名的展示属性，外加 pending / failed 两种占位。
 * @returns `<img>`，或调用方给的占位内容；什么都没有时返回 null。
 */
export function RemoteImg({ pending, failed, ...imgProps }: RemoteImgProps): React.JSX.Element | null {
  const state = useRemoteImage(imgProps.src)
  if (state.status === 'ready') return <img {...imgProps} src={state.src} />
  if (state.status === 'pending') return <>{pending ?? null}</>
  if (state.status === 'failed') return <>{failed ?? null}</>
  return null
}
