
/**
 * Chats 面板的媒体消息（M21 第三十二刀自 Chats.tsx 拆出）。
 *
 * 这些原先都是 Chats.tsx 里的顶层函数/组件（不吃面板状态，只吃道具）—— 整段原样搬出，
 * 面板按需 import。依赖由脚本从「这块里真实用到的面板 import」生成。
 */
import { apiGetEmoticonDataUrl, apiGetImageDataUrl, apiGetImageOriginal, apiGetVideoInfo, apiGetVoiceDataUrl, apiGetVoiceInfo, apiGetVoiceTranscript, apiOpenPath, apiTranscribeVoiceMessage } from '../api.ts'
import kitCss from '../ui/kit.module.css'
import { clickableKey, useDialogFocus } from '../ui/kit.tsx'
import { RemoteImg } from './remote-img.tsx'
import { CardFoot } from './chats-cards.tsx'
import { IconCallMissedOutline, IconCallOutline, IconImage, IconMinus } from './chats-support.tsx'
import css from './chats.module.css'
import { IconChevronLeftOutline14, IconChevronRightOutline14, IconCloseOutline16, IconFullscreenOutline16, IconLinkOutline14, IconPlayOutline16, IconPlusOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { clsx } from 'clsx'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
/** 微信语音时长（秒）→ 气泡宽度：官方公式 80px + 秒数×4（1s→84px，60s 封顶 320px）。 */
export function voiceWidth(sec: number): string {
  const clamped = Math.min(60, Math.max(1, sec))
  return `${80 + clamped * 4}px`
}
/** One image entry in the viewer strip. */
export interface ViewerImage {
  username: string
  localId: number
}
/**
 * Lightbox image viewer: zoom (wheel/buttons), drag pan, prev/next, ESC/backdrop close.
 * Resolves each image to a data URL through the Remote on demand.
 */
export function ImageViewer({ images, index, onClose, onIndexChange }: {
  images: readonly ViewerImage[]
  index: number
  onClose: () => void
  onIndexChange: (i: number) => void
}): React.JSX.Element {
  const item = images[index]
  const [src, setSrc] = useState<string | null>(null)
  const [vErr, setVErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [off, setOff] = useState({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)
  const dragStart = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)

  useEffect(() => {
    if (!item) return
    let cancelled = false
    setSrc(null)
    setVErr(null)
    setZoom(1)
    setOff({ x: 0, y: 0 })
    setLoading(true)
    apiGetImageDataUrl({ username: item.username, localId: item.localId })
      .then((r) => {
        if (cancelled) return
        if (r.url) setSrc(r.url)
        else setVErr(r.error ?? '图片不可用')
      })
      .catch((e: unknown) => { if (!cancelled) setVErr((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [item?.username, item?.localId])

  // 媒体查看器是 createPortal 出去的覆盖层，同样需要把焦点收进来并锁在里面。
  useDialogFocus(!!item, '[data-st-dialog="chats-viewer"]')

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') onIndexChange((index - 1 + images.length) % images.length)
      else if (e.key === 'ArrowRight') onIndexChange((index + 1) % images.length)
    }
    window.addEventListener('keydown', onKey)
    return () =>{  window.removeEventListener('keydown', onKey) }
  }, [onClose, onIndexChange, index, images.length])

  const zoomBy = (f: number): void =>{  setZoom(z => Math.min(Math.max(z * f, 0.25), 8)) }
  const reset = (): void => { setZoom(1); setOff({ x: 0, y: 0 }) }

  return createPortal(
    <div className={css.viewerOverlay} role="dialog" data-st-dialog="chats-viewer" aria-modal="true"
      onWheel={(e) => { e.preventDefault(); zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15) }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      onMouseMove={(e) => {
        if (dragging && dragStart.current) {
          setOff({
            x: dragStart.current.ox + (e.clientX - dragStart.current.x),
            y: dragStart.current.oy + (e.clientY - dragStart.current.y),
          })
        }
      }}
      onMouseUp={() => { setDragging(false); dragStart.current = null }}
      onMouseLeave={() => { setDragging(false); dragStart.current = null }}
    >

      <div className={css.viewerBar}>
        <span className={css.viewerCount}>{index + 1} / {images.length}</span>
        <button type="button" className={css.viewerBtn} title="放大" aria-label="放大" onClick={() =>{  zoomBy(1.3) }}><IconPlusOutline16 size={15} /></button>
        <button type="button" className={css.viewerBtn} title="缩小" aria-label="缩小" onClick={() =>{  zoomBy(1 / 1.3) }}><IconMinus /></button>
        <button type="button" className={css.viewerBtn} title="1:1" aria-label="1:1" onClick={reset}><IconFullscreenOutline16 size={15} /></button>
        <button type="button" className={css.viewerBtn} title="上一张" aria-label="上一张" onClick={() => { onIndexChange((index - 1 + images.length) % images.length) }}><IconChevronLeftOutline14 /></button>
        <button type="button" className={css.viewerBtn} title="下一张" aria-label="下一张" onClick={() => { onIndexChange((index + 1) % images.length) }}><IconChevronRightOutline14 /></button>
        <button type="button" className={clsx(css.viewerBtn, css.viewerBtnClose)} title="关闭" aria-label="关闭" onClick={(e) => { e.stopPropagation(); onClose() }}><IconCloseOutline16 size={16} /></button>
      </div>
      <div className={css.viewerStage}>
        {loading && !src && !vErr && <div className={css.viewerMsg}>加载中…</div>}
        {vErr && <div className={css.viewerMsg}>{vErr === 'hevc-unsupported' ? '🖼️ wxgf 原图（需系统 HEVC 解码）' : vErr}</div>}
        {src && (
          <img
            src={src}
            alt="图片"
            className={css.viewerImg}
            style={{ transform: `translate(${off.x}px, ${off.y}px) scale(${zoom})` }}
            draggable={false}
            onMouseDown={(e) => {
              e.preventDefault()
              setDragging(true)
              dragStart.current = { x: e.clientX, y: e.clientY, ox: off.x, oy: off.y }
            }}
          />
        )}
      </div>
    </div>,
    document.body,
  )
}
/** 单张消息图片（可点击进大图）。图片组网格也复用它。 */
export function MessageThumb({ username, localId, onOpen, alt = '图片' }: {
  username: string
  localId: number
  onOpen?: () => void
  alt?: string
}): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setErr(null)
    apiGetImageDataUrl({ username, localId })
      .then((r) => { if (!cancelled) { if (r.url) setSrc(r.url); else setErr(r.error ?? '图片不可用') } })
      .catch((e: unknown) => { if (!cancelled) setErr((e as Error).message) })
    return () => { cancelled = true }
  }, [username, localId])
  if (err) {
    return <span className={css.msgImageGridEmpty} title={err}><IconImage /></span>
  }
  if (!src) return <span className={css.msgImageGridEmpty} data-loading="true" />
  return (
    <span
      className={css.msgImageGridItem}
      {...(onOpen ? clickableKey(onOpen, { label: '查看大图' }) : {})}
    >
      <img src={src} alt={alt} loading="lazy" decoding="async" />
    </span>
  )
}
/**
 * 图片组（微信「连拍合并」）。
 *
 * 微信把一次连拍的 N 张图拆成 N 条消息，每条都带同一个 `<groupinfo><id>` 与
 * `<count>`。逐条平铺会让一屏只有图片、失去「这是一组」的信息；这里按 id 合成
 * 网格（最多 9 格，多出的用 `+N` 角标），点击任意格进大图。
 * @param props.items - the group's messages (in order).
 * @returns the grid element.
 */
export function MessageImageGroup({ items, username, onOpenAt }: {
  items: readonly WechatMessage[]
  username: string
  onOpenAt: (m: WechatMessage) => void
}): React.JSX.Element {
  const shown = items.slice(0, 9)
  const rest = items.length - shown.length
  return (
    <div className={css.msgImageGrid} data-count={Math.min(shown.length, 9)}>
      {shown.map((m, i) => (
        <span key={m.localId} className={css.msgImageGridCell}>
          <MessageThumb username={username} localId={m.localId} onOpen={() => { onOpenAt(m) }} />
          {rest > 0 && i === shown.length - 1 && <span className={css.msgImageGridMore}>+{rest}</span>}
        </span>
      ))}
    </div>
  )
}
/**
 * 系统提示行（type 10000 / 10002）。
 *
 * 撤回单独成类（后端 `renderType === 'revoke'`）：它是**动作**不是通知——
 * 微信也用不同的灰底样式表示。其余系统消息按是否有图标区分：
 * @returns the centered system line.
 */
export function MessageSystem({ m }: { m: WechatMessage }): React.JSX.Element {
  const text = m.displayText || (m.renderType === 'revoke' ? '撤回了一条消息' : '[系统消息]')
  const kind = m.renderType === 'revoke' ? 'revoke' : (m.sysKind === 'chatroomtopmsg' || m.sysKind === 'top' ? 'top' : 'notice')
  const icon = kind === 'revoke' ? '↩' : kind === 'top' ? '📌' : ''
  return (
    <div className={css.msgSystem} data-kind={kind}>
      {icon && <span className={css.msgSystemIcon} aria-hidden="true">{icon}</span>}
      <span className={css.msgSystemText}>{text}</span>
    </div>
  )
}
/**
 * 位置卡片：标题 + 详细地址 + 经纬度（可复制核对）。
 *
 * 后端 `rich.lat/lng` 来自 `<location x y>`（x=纬度、y=经度，微信沿用 mapkit 命名）。
 * 没有可用的离线地图瓦片，所以**不画假地图** —— 只给一个坐标芯片，
 * 让「这条位置到底是哪」可核对，而不是一个只有地名的空卡。
 * @param props.m - the location message.
 * @returns the location card element.
 */
export function MessageLocation({ m }: { m: WechatMessage }): React.JSX.Element {
  const rich = m.rich
  const name = rich?.title || m.displayText || '位置'
  const addr = rich?.desc || ''
  const lat = typeof rich?.lat === 'number' ? rich.lat : null
  const lng = typeof rich?.lng === 'number' ? rich.lng : null
  const coord = lat !== null && lng !== null ? `${lat.toFixed(5)}, ${lng.toFixed(5)}` : ''
  return (
    <div className={css.msgLocationCard}>
      <span className={css.msgLocationMap} aria-hidden="true">
        <span className={css.msgLocationGrid} />
        <span className={css.msgLocationPin}>📍</span>
      </span>
      <span className={css.msgLocationBody}>
        <span className={css.msgLocationTitle} title={name}>{name}</span>
        {addr && addr !== name && <span className={css.msgLocationDesc} title={addr}>{addr}</span>}
        {coord && <span className={css.msgLocationCoord} title="纬度, 经度">{coord}</span>}
      </span>
      <CardFoot label="位置" />
    </div>
  )
}
/**
 * 名片卡片：头像（CDN 地址，可能不可达则退回首字）+ 昵称 + 别名/微信号。
 * @param props.m - the contact-card message.
 * @returns the card element.
 */
export function MessageContact({ m }: { m: WechatMessage }): React.JSX.Element {
  const rich = m.rich
  const nick = rich?.nickname || rich?.title || m.displayText || '联系人'
  const uname = rich?.username || ''
  const alias = typeof rich?.alias === 'string' ? rich.alias : ''
  // 名片消息里的头像是消息 XML 带来的**原始地址**：不许由渲染层自己去要（M23），
  // 交给后端代理，取不到就退回首字母（与「本机没有这张头像」同一形状）。
  const avatar = typeof rich?.avatar === 'string' ? rich.avatar : ''
  const initial = (nick || uname || '?').slice(0, 1).toUpperCase()
  const isEnterprise = m.type === 66 || uname.endsWith('@openim')
  return (
    <div className={css.msgContactCard}>
      <span className={css.msgContactAvatar}>
        <RemoteImg src={avatar} alt="" loading="lazy" pending={initial} failed={initial} />
      </span>
      <span className={css.msgContactBody}>
        <span className={css.msgContactNick} title={nick}>{nick}</span>
        {alias && <span className={kitCss.textCaption}>别名：{alias}</span>}
        {uname && <span className={kitCss.textCaptionTrunc} title={uname}>{uname}</span>}
      </span>
      <CardFoot label={isEnterprise ? '企业微信名片' : '个人名片'} />
    </div>
  )
}
/** 微信语音波纹字形（三层声波，参考 WeChatDataAnalysis MessageContent.vue）。 */
export function IconVoiceWaves({ mirror, size = 18 }: { mirror?: boolean; size?: number }): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="currentColor"
      aria-hidden="true"
      style={mirror ? { transform: 'scaleX(-1)' } : undefined}
    >
      <path d="M10.24 11.616l-4.224 4.192 4.224 4.192c1.088-1.056 1.76-2.56 1.76-4.192s-0.672-3.136-1.76-4.192z" />
      <path d="M15.199 6.721l-1.791 1.76c1.856 1.888 3.008 4.48 3.008 7.328s-1.152 5.44-3.008 7.328l1.791 1.76c2.336-2.304 3.809-5.536 3.809-9.088s-1.473-6.784-3.809-9.088z" opacity="0.85" />
      <path d="M20.129 1.793l-1.762 1.76c3.104 3.168 5.025 7.488 5.025 12.256s-1.921 9.088-5.025 12.256l1.762 1.76c3.648-3.616 5.887-8.544 5.887-14.016s-2.239-10.4-5.887-14.016z" opacity="0.55" />
    </svg>
  )
}
/**
 * 引用行里「卡片类 appmsg」的类型图标（转账 2000）。
 *
 * 形状按官方参考图**逐像素描**：外径 13-14px 的描边圆（笔画约 1.5px）+ 圆内
 * 居中一块约 8×5.5 的实心圆角矩形（把参考图放大到 1px 一个字符量出来的）。
 * 图标语义（是「转账」专用还是卡片消息通用）本机无法验证，所以只挂到
 * appmsg 2000，其余类型保持原样 —— 若日后证明是通用形，把条件放宽即可。
 * @returns the glyph element.
 */
export function IconQuoteCard(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <circle cx="7" cy="6.7" r="5.8" stroke="currentColor" strokeWidth="1.4" />
      <rect x="4.2" y="4.2" width="6.9" height="5.4" rx="2.6" fill="currentColor" />
    </svg>
  )
}
/**
 * 引用行里的类型图标：官方在摘要前放一个类型小图标；没有合适图标时返回 null（只显示名字与摘要）。
 * @param t - 被引用消息的 refermsg `<type>`。
 * @param appType - 被引用内容是 appmsg 时的子类型（后端 `rich.referAppType`）；0 表示不是 appmsg。
 * @returns the icon element or null.
 */
export function quoteKindIcon(t: number | undefined, appType = 0): React.JSX.Element | null {
  if (appType === 2000) return <IconQuoteCard />
  switch (t) {
    case 3: return <IconImage />
    case 34: return <IconVoiceWaves size={13} />
    case 43: return <IconPlayOutline16 size={13} />
    case 42: case 66: return <IconUserOutline16 size={13} />
    case 49: case 5: case 68: return <IconLinkOutline14 size={13} />
    default: return null
  }
}
/**
 * 当前正在播放的语音（模块级）：消息流里同时只允许一条在放（微信行为）。
 * 用模块级而不是 state，是因为「点新的一条要停掉上一条」需要跨组件实例访问。
 */
export let currentVoiceAudio: HTMLAudioElement | null = null
/**
 * 语音消息：时长来自消息 XML（`<voicemsg voicelength>`，毫秒）。
 *
 * 旧实现拿 `VoiceInfo.length(voice_data)`（**压缩后的字节数**）除以 2000 当秒用，
 * 短语音普遍显示 0″、长语音偏差一倍以上。XML 里的 voicelength 才是微信自己
 * 展示的那个值；只有它缺失时才退回「已知可解码但没有时长」的形态。
 * @param props.m - the voice message.
 * @returns the voice bubble.
 */
export function MessageVoice({ m, selfName }: { m: WechatMessage; selfName: string }): React.JSX.Element {
  const [transcript, setTranscript] = useState<string | null>(null)
  const [transcribing, setTranscribing] = useState(false)
  const [tErr, setTErr] = useState<string | null>(null)
  const [audioOk, setAudioOk] = useState<boolean | null>(null)
  const [playing, setPlaying] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  useEffect(() => {
    let cancelled = false
    apiGetVoiceInfo({ username: selfName, localId: m.localId })
      .then((r) => { if (!cancelled) setAudioOk(r.available === true) })
      .catch(() => { if (!cancelled) setAudioOk(false) })
    apiGetVoiceTranscript({ username: selfName, localId: m.localId })
      .then((r) => { if (!cancelled && r.text) setTranscript(r.text) })
      .catch(() => { /* 尚未转写,跳过 */ })
    return () => { cancelled = true }
  }, [selfName, m.localId])
  const doTranscribe = async (): Promise<void> => {
    setTranscribing(true)
    setTErr(null)
    try {
      const r = await apiTranscribeVoiceMessage({ username: selfName, localId: m.localId })
      if (r.ok && r.text) setTranscript(r.text)
      else setTErr(r.error ?? '转写失败')
    } catch (e) {
      setTErr((e as Error).message)
    } finally {
      setTranscribing(false)
    }
  }
  const ms = typeof m.rich?.durationMs === 'number' ? m.rich.durationMs : 0
  const sec = ms > 0 ? Math.max(1, Math.round(ms / 1000)) : 0
  const width = sec > 0 ? voiceWidth(sec) : undefined
  const isSelf = m.isSender === 1
  // 卸载（切会话/滚动出窗口）时停掉本条，避免声音在后台继续放
  useEffect(() => () => {
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null }
  }, [])
  /**
   * 点气泡就地播放/暂停。
   * 音频是后端解码好的 16kHz wav（data URL）——CSP 的 `media-src` 允许 `data:`，
   * 不允许 `file:`，所以只能走 data URL；同一条消息流里只允许一条在放（微信行为）。
   */
  const togglePlay = async (): Promise<void> => {
    setLoadErr(null)
    const cur = audioRef.current
    if (cur && playing) { cur.pause(); setPlaying(false); return }
    try {
      let url = cur ? cur.src : ''
      if (!url) {
        const r = await apiGetVoiceDataUrl({ username: selfName, localId: m.localId })
        if (!r.url) { setLoadErr(r.error ?? '语音不可播放'); return }
        url = r.url
      }
      if (currentVoiceAudio && currentVoiceAudio !== cur) currentVoiceAudio.pause()
      const a = cur ?? new Audio(url)
      audioRef.current = a
      currentVoiceAudio = a
      a.onended = () => { setPlaying(false) }
      a.onerror = () => { setPlaying(false); setLoadErr('播放失败') }
      await a.play()
      setPlaying(true)
    } catch (e) {
      setPlaying(false)
      setLoadErr((e as Error).message)
    }
  }
  return (
    <div className={css.msgVoice}>
      <div
        className={css.msgVoiceBubble}
        style={width ? { width } : undefined}
        title={loadErr ?? (playing ? '点击暂停' : '点击播放')}
        data-self={isSelf || undefined}
        data-playing={playing || undefined}
        {...clickableKey(() => { void togglePlay() }, { role: 'button', label: playing ? '暂停语音' : '播放语音' })}
      >
        {/* 方向：微信只把**我方**图标镜像（参考实现 chat.css `.voice-icon-sent { transform: scaleX(-1) }`），
            对方用基础方向 —— 基础图形是「锥体朝左 + 波纹朝右」，所以对方应是 `◀))) 5″`。
            此前写成 mirror={!isSelf} 把两侧都镜像反了（用户报「对方语音图标方向错」）。 */}
        <span className={css.msgVoiceIcon}><IconVoiceWaves mirror={isSelf} /></span>
        {sec > 0 && <span className={css.msgVoiceDur}>{sec}″</span>}
      </div>
      {sec === 0 && audioOk === false && <span className={kitCss.textMeta}>语音数据不在本地</span>}
      {loadErr && <span className={css.msgVoiceErr} title={loadErr}>{loadErr.length > 28 ? loadErr.slice(0, 28) + '…' : loadErr}</span>}
      {!transcript && !transcribing && !tErr && (
        <button type="button" className={css.msgVoiceBtn} onClick={() => { void doTranscribe() }}>语音转文字</button>
      )}
      {transcribing && <span className={kitCss.textMeta}>转写中…</span>}
      {tErr && !transcript && (
        <span className={css.msgVoiceErr} title={tErr}>{tErr.length > 28 ? tErr.slice(0, 28) + '…' : tErr}</span>
      )}
      {transcript && <span className={css.msgVoiceText}>【{transcript}】</span>}
    </div>
  )
}
/**
 * 视频消息气泡：有封面就画封面 + 播放钮 + 时长角标；没有封面但有实体时给可点开的一行。
 *
 * 「打开」交给系统播放器（`apiOpenPath`）：渲染进程的 CSP 是 `media-src 'self' data: blob:`，
 * 不含 `file:`，站内 `<video src="file://…">` 会被直接拦掉，所以链接文件才是真能用的路径。
 */
export function MessageVideo({ m, selfName }: { m: WechatMessage; selfName: string }): React.JSX.Element {
  const [cover, setCover] = useState<string | null>(null)
  const [vErr, setVErr] = useState<string | null>(null)
  const [videoPath, setVideoPath] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    apiGetVideoInfo({ username: selfName, localId: m.localId })
      .then((r) => {
        if (cancelled) return
        // videoPath 是后端新增字段；types 包在 node_modules 里是旧副本（既有的 48 条类型错误同源），
        // 这里按运行时读，不为了一个字段去动那份副本。
        const path = (r as { videoPath?: string }).videoPath
        if (path) setVideoPath(path)
        if (r.coverUrl) setCover(r.coverUrl)
        else setVErr(r.error === 'hevc-unsupported' ? 'wxgf/HEVC 封面（需系统解码）' : (r.error ?? '视频不可用'))
      })
      .catch((e: unknown) => { if (!cancelled) setVErr((e as Error).message) })
    return () => { cancelled = true }
  }, [selfName, m.localId])
  const durSec = typeof m.rich?.durationSec === 'number' ? m.rich.durationSec : 0
  const durText = durSec > 0 ? `${Math.floor(durSec / 60)}:${String(durSec % 60).padStart(2, '0')}` : ''
  const openVideo = (): void => {
    if (!videoPath) return
    void apiOpenPath(videoPath).catch(() => { /* 打不开就保持原样，用户可用右键菜单里的「显示所在位置」 */ })
  }
  // 没有封面但有实体：给一行可点的入口，而不是报「不在本地」
  if (vErr && videoPath) {
    return (
      <div className={css.msgBubble}>
        <span className={css.msgVoicelike} title={videoPath} {...clickableKey(openVideo, { role: 'button', label: '用系统播放器打开视频' })}>
          <IconPlayOutline16 size={13} /> 视频{durText ? ` ${durText}` : ''}
        </span>
        <span className={kitCss.textMeta}>封面不在本地，点上方用系统播放器打开</span>
      </div>
    )
  }
  if (vErr) {
    return (
      <div className={css.msgBubble}>
        <span className={css.msgVoicelike}><IconPlayOutline16 size={13} /> 视频{durText ? ` ${durText}` : ''}</span>
        <span className={kitCss.textMeta}>（{vErr}）</span>
      </div>
    )
  }
  if (!cover) {
    return (
      <div className={css.msgBubble}>
        <span className={css.msgVoicelike}><IconPlayOutline16 size={13} /> 视频{durText ? ` ${durText}` : ''}</span>
        <span className={kitCss.textMeta}>加载中…</span>
      </div>
    )
  }
  return (
    <div className={`${css.msgBubble} ${css.msgBubbleTight}`}>
      <span
        className={css.msgVideoWrap}
        title={videoPath ? `${videoPath}\n（点击用系统播放器打开）` : '视频封面'}
        {...(videoPath ? clickableKey(openVideo, { role: 'button', label: '用系统播放器打开视频' }) : {})}
      >
        <img src={cover} alt="视频封面" className={css.msgImage} loading="lazy" />
        <span className={css.msgVideoPlay}><IconPlayOutline16 size={18} /></span>
        {durText && <span className={css.msgVideoDur}>{durText}</span>}
      </span>
    </div>
  )
}
/**
 * Format a call duration in seconds as MM:SS (or H:MM:SS past an hour).
 * @param sec - duration in seconds.
 * @returns the clock-style duration text.
 */
export function fmtCallDuration(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(s).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}
/** 16px 摄像机字形（视频通话结局）。 */
export function IconVideoCallOutline(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.5" y="4" width="9" height="8" rx="2" stroke="currentColor" strokeWidth="1.25" />
      <path d="M10.5 8.4 14.5 6v4.8L10.5 8.4Z" fill="currentColor" />
    </svg>
  )
}
/**
 * Call bubble (type 50) —— 通话结局与时长都来自 voip XML 的 `<msg>` 文本。
 *
 * 后端 `parseMessageContent(50, …)` 解出 `rich = { type:'call', status,
 * connected, callStatus, durationSec?, voipType? }`：`status` 是微信自己写的结局
 * （通话时长 00:21 / 对方已取消 / 已拒绝 / 未应答 / 已在其它设备接听 …）。
 * `durationSec` 由它解析而来（XML 的 `<duration>` 实测恒为 0，不可用）。
 * `voipType` 来自 `<room_type>`（1=视频、2=语音），未知时只画话筒图标。
 * @param props.m - the call message.
 * @returns the call bubble element.
 */
export function MessageCall({ m }: { m: WechatMessage }): React.JSX.Element {
  const rich = m.rich
  const status = String(rich?.status ?? rich?.title ?? '').trim() || (m.displayText || '').replace(/^\[通话\]\s*/, '')
  const durSec = typeof rich?.durationSec === 'number' ? rich.durationSec : null
  const connected = rich?.connected === true || durSec !== null
  const kind = String(rich?.callStatus ?? (connected ? 'connected' : 'missed'))
  const isVideo = rich?.voipType === 'video'
  // 「通话时长 00:21」里的时长已单独渲染，状态行去掉尾部时间避免重复。
  const label = status.replace(/\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/, '').trim()
  return (
    <div className={css.msgCall} data-state={connected ? 'done' : 'missed'} data-kind={kind} data-media={isVideo ? 'video' : 'audio'}>
      <span className={css.msgCallIcon} aria-hidden="true">
        {isVideo ? <IconVideoCallOutline /> : connected ? <IconCallOutline /> : <IconCallMissedOutline />}
      </span>
      <span className={css.msgCallBody}>
        {/*
          微信的通话气泡只有「图标 + 结局」两段：语音/视频由**图标**表达
          （话筒 / 摄像机），气泡里**不写**「语音通话 / 视频通话」这行标签。
          此前多画了一行，实测气泡比官方的宽 50px（215×38 vs 参考 165×36）。
        */}
        <span className={css.msgCallStatus}>{label || (connected ? '通话' : '未接通')}</span>
        {durSec !== null && <span className={css.msgCallDur}>{fmtCallDuration(durSec)}</span>}
      </span>
    </div>
  )
}
/**
 * Lazy message image: resolve + decode via Remote, render as data URL.
 *
 * 下方那个「取原图」是 2026-09-20 加的：本机实测 93% 的图片在磁盘上**只有缩略图**
 * （微信从不主动下载原图），所以「图糊」不是解码失败。能不能自动补回来取决于消息 XML 里
 * 带的是哪种指针 —— 只有免登录预签名直链（`tpurl`/`tphdurl`，实测约 16%）能直接取，
 * 另一类 `cdnbigimgurl` 需要微信登录态，本应用不做。而「这条属于哪一种」只有查过 XML
 * 才知道，所以按钮常在、取不到时把**具体原因**显示出来，而不是一句「失败」。
 */
export function MessageImage({ m, selfName, onOpen }: {
  m: WechatMessage
  selfName: string
  onOpen?: (m: WechatMessage) => void
}): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [imgErr, setImgErr] = useState<string | null>(null)
  const [isThumb, setIsThumb] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [fetching, setFetching] = useState(false)
  const [origNote, setOrigNote] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setSrc(null)
    setImgErr(null)
    apiGetImageDataUrl({ username: selfName, localId: m.localId })
      .then((r) => {
        if (cancelled) return
        if (r.url) { setSrc(r.url); setIsThumb(r.thumb === true) }
        else setImgErr(r.error ?? '图片不可用')
      })
      .catch((e: unknown) => { if (!cancelled) setImgErr((e as Error).message) })
    return () => { cancelled = true }
  }, [selfName, m.localId, nonce])

  /** 取回的原图会落进后端解码路径优先读的那个缓存槽，所以成功后只需重跑一次取图。 */
  const getOriginal = async (): Promise<void> => {
    setFetching(true)
    setOrigNote(null)
    try {
      const r = await apiGetImageOriginal({ username: selfName, localId: m.localId })
      if (r.ok) {
        setOrigNote(r.note ?? (r.bytes ? `已取回原图（约 ${String(Math.max(1, Math.round(r.bytes / 1024)))} KB），正在重新加载` : '已取到原图，正在重新加载'))
        setNonce((n) => n + 1)
      } else {
        setOrigNote(r.error ?? '这条消息取不到原图')
      }
    } catch (e) {
      setOrigNote((e as Error).message)
    } finally {
      setFetching(false)
    }
  }

  if (imgErr) {
    const isHevc = imgErr === 'hevc-unsupported'
    const isNoDat = imgErr.startsWith('找不到 .dat')
    const short = isHevc ? 'wxgf 原图' : isNoDat ? '图片（未解码）' : imgErr
    return (
      <div className={css.msgBubble} title={imgErr}><span className={kitCss.textMeta}><IconImage /> {short}</span></div>
    )
  }
  if (!src) {
    return <div className={`${css.msgBubble} ${css.msgBubbleTight}`}><span className={kitCss.textMeta}><IconImage /> 图片加载中…</span></div>
  }
  return (
    <>
      <div className={`${css.msgBubble} ${css.msgBubbleZoom}`} {...clickableKey(() => { if (onOpen) onOpen(m) }, { label: '查看大图' })}>
        <img src={src} alt="图片" className={css.msgImage} loading="lazy" />
      </div>
      <div className={css.msgFileHint}>
        {isThumb && <span className={kitCss.textMeta}>本机只有缩略图 </span>}
        {fetching
          ? <span className={kitCss.textMeta}>正在取原图…</span>
          : <button type="button" className={css.msgVoiceBtn} onClick={() => { void getOriginal() }}>取原图</button>}
        {origNote !== null && <span className={kitCss.textMeta}> {origNote}</span>}
      </div>
    </>
  )
}
/**
 * 自定义表情真图：按 md5 走 Remote 解码（decoded 缓存优先，否则扫本地表情缓存），
 * 本地解不开时后端会用消息带来的 `cdnurl` 下载一次并落缓存（见后端 fetchEmoticonRemote）。
 * 失败时退回占位芯片，保证会话里永远有一行可读内容。
 */
export function MessageEmoticon({ md5, label, emojiUrl }: { md5: string; label?: string; emojiUrl?: string }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!md5 || !/^[0-9a-f]{32}$/i.test(md5)) {
      setSrc(null)
      setErr('缺少表情 MD5')
      return () => { cancelled = true }
    }
    setSrc(null)
    setErr(null)
    apiGetEmoticonDataUrl({ md5: md5.toLowerCase(), ...(emojiUrl ? { emojiUrl } : {}) })
      .then((r) => {
        if (cancelled) return
        if (r.url) setSrc(r.url)
        else setErr(r.error ?? '表情不可用')
      })
      .catch((e: unknown) => { if (!cancelled) setErr((e as Error).message) })
    return () => { cancelled = true }
  }, [md5])
  if (src) {
    return (
      <div className={css.msgSticker} title={label || '表情'}>
        <img className={css.msgStickerImg} src={src} alt={label || '表情'} loading="lazy" decoding="async" />
      </div>
    )
  }
  return (
    <div className={css.msgBubble}>
      <span className={css.msgEmojiChip} title={err || (md5 ? `自定义表情 · MD5 ${md5}` : '自定义表情')}>
        {err ? '😊 [表情]' : '😊 表情加载中…'}
      </span>
    </div>
  )
}