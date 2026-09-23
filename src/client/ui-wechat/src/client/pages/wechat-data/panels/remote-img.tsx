/**
 * 画一张「可能是远程地址」的图（M23）。
 *
 * 与直接写 `<img src={cspSafeSrc(url)}>` 的区别只有一条：**远程地址不再由渲染层自己去取**，
 * 而是交给后端的图片代理 —— 于是「自动获取原图（CDN）」与「禁止出网」两个开关管得到它、
 * 取回动作进操作记录、字节落在本机缓存里。这件事值得多一层组件的原因：让 `<img>` 直接吃
 * https 地址，等于把「渲染层可向任意 https 主机发请求」写进产品，那两个开关都拦不到它 ——
 * 用户在界面上关掉开关之后其实还在出网，隐私声明里「关掉就不再请求」那句就成了假的。
 *
 * 三条行为，都是刻意的：
 *   · `data:` / `blob:` / `file:` 与空串是本地地址：**同步照画**，一次 RPC 都不绕
 *     （聊天里绝大多数图片走这条，它们本来就是后端解出来的 data URL）；
 *   · 远程地址先**什么都不画**，拿到 data URL 再画 —— 所以没有「先闪一下破图再被替换」那一帧；
 *   · 取不到（开关关掉 / 主机不在白名单 / 网络失败）就一直不画：外层卡片本来就有
 *     「没有封面」的占位分支，那比给一个坏图标诚实。
 *
 * 换 `src` 时（虚拟化列表会复用 DOM 节点）先清空再取，避免上一张图错画在新条目上。
 */
import { useEffect, useState } from 'react'
import { apiGetRemoteImageUrl } from '../api.ts'

/** 本地地址：能直接画，不需要代理。 */
function localSrcOf(src: string): string {
  return /^(data:|blob:|file:)/i.test(src) ? src : ''
}

export interface RemoteImgProps {
  /** 图片地址：本地地址原样用，`http(s)` 走后端代理。 */
  src: string
  className?: string
  alt?: string
  style?: React.CSSProperties
  /** 默认懒加载：远程图本来就要等，滚动经过时不该全量取。 */
  loading?: 'lazy' | 'eager'
  title?: string
  onClick?: () => void
  /** 与 `<img>` 同形（调用点靠 `e.target` 把这张图藏掉），所以带事件参数。 */
  onError?: React.ReactEventHandler<HTMLImageElement>
}

/**
 * 渲染一张图：本地地址直接画，远程地址经后端代理。
 * @param props - 与 `<img>` 同名的展示属性；`src` 允许是消息里的远程地址。
 * @returns `<img>`；还没有可画的地址时返回 null（不画，也就不会有破图）。
 */
export function RemoteImg({
  src, className, alt = '', style, loading = 'lazy', title, onClick, onError,
}: RemoteImgProps): React.JSX.Element | null {
  const trimmed = String(src ?? '').trim()
  const local = localSrcOf(trimmed)
  const remote = local === '' && /^https?:/i.test(trimmed)
  const [resolved, setResolved] = useState('')

  useEffect(() => {
    if (local !== '' || !remote) return
    let alive = true
    setResolved('') // 先清掉上一张：列表复用节点时不该错画别人的图
    void apiGetRemoteImageUrl(trimmed).then((u) => { if (alive) setResolved(u) })
    return () => { alive = false }
  }, [trimmed, local, remote])

  const drawn = local !== '' ? trimmed : resolved
  if (drawn === '') return null
  return (
    <img
      className={className}
      src={drawn}
      alt={alt}
      style={style}
      title={title}
      loading={loading}
      onClick={onClick}
      onError={onError}
    />
  )
}
