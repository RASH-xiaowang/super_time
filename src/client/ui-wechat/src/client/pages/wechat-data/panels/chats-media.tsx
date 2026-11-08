
/**
 * Chats 面板的媒体消息（M21 第三十二刀自 Chats.tsx 拆出）。
 *
 * 这些原先都是 Chats.tsx 里的顶层函数/组件（不吃面板状态，只吃道具）—— 整段原样搬出，
 * 面板按需 import。依赖由脚本从「这块里真实用到的面板 import」生成。
 */
import { apiExportChatImage, apiExportChatVideo, apiGetEmoticonDataUrl, apiGetImageDataUrl, apiGetImageOriginal, apiGetVideoInfo, apiGetVoiceDataUrl, apiGetVoiceTranscript, apiOpenPath, apiSaveFileDialog, apiTranscribeVoiceMessage } from '../api.ts'
import kitCss from '../ui/kit.module.css'
import { clickableKey } from '../ui/kit.tsx'
import { RemoteImg } from './remote-img.tsx'
import { MediaViewer } from '../media-viewer/MediaViewer.tsx'
import { recallImage, rememberImage } from '../image-cache.ts'
import { CardFoot } from './chats-card-foot.tsx'
import { ImageTextActions } from './chats-ocr.tsx'
import { IconCallMissedOutline, IconCallOutline, IconImage, IconMinus, imageOriginalFailureText } from './chats-support.tsx'
import { isEnterpriseWechatUser, withEnterprise } from './enterprise-identity.ts'
import css from './chats.module.css'
import cssrows from './chats-rows.module.css'
import { IconLinkOutline14, IconPlayOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { withThumbWidth } from '../wechat-media.ts'
import { desktopAction, desktopActionProps } from '../ui/desktop-only.tsx'
import { ExportProgressStatus } from './ExportProgressStatus.tsx'
import { useMediaSaveTask } from './media-save-task.ts'
import type { MediaOriginalExportResult } from '@deepseek-ai/dsh-wechat-data/types'

/**
 * 聊天气泡的最大显示宽度是 240 CSS px；按 2x DPR 取 480px 的缩略档，
 * 避免 Chromium 为一张 12MP 原图分配数十 MB 的位图。查看器仍加载原图。
 */
export const CHAT_IMAGE_THUMB_WIDTH = 480

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

/** 从查看器已加载的 data URL / 媒体路径推断保存对话框的默认扩展名。 */
function chatImageExt(src: string): string {
  const dataMatch = src.match(/^data:image\/([a-z0-9+.-]+)[;,]/i)
  if (dataMatch) {
    const ext = (dataMatch[1] ?? '').toLowerCase()
    return ext === 'jpeg' ? 'jpg' : ext
  }
  const clean = src.split(/[?#]/, 1)[0] ?? ''
  const ext = clean.split('.').pop()?.toLowerCase() ?? ''
  return /^[a-z0-9]{2,5}$/.test(ext) ? ext : 'jpg'
}

/**
 * 保存聊天原图：路径由保存对话框选择，字节由后端重新解析并校验。
 * 缩略图不会进入写盘路径，避免把低清预览当成原图交付。
 */
async function saveChatOriginal(
  im: ViewerImage,
  src: string,
  jobId: string,
): Promise<{ path: string } | null> {
  if (!desktopAction()) {
    const ext = chatImageExt(src)
    const picked = await apiSaveFileDialog({
      defaultName: `聊天图片-${String(im.localId)}.${ext}`,
      title: '保存聊天原图',
      filters: [{ name: '图片', extensions: [ext] }],
    })
    if (picked.canceled || !picked.path) return null
    const result = await apiExportChatImage({
      username: im.username,
      localId: im.localId,
      dest: picked.path,
      jobId,
    })
    if (!result.ok) throw new Error(result.error || '聊天原图写入失败')
    return { path: result.path ?? picked.path }
  }
  throw new Error('聊天原图仅支持电脑端保存')
}

/**
 * 聊天图片查看器（2026-10-21 接入统一 `MediaViewer`）：
 *  - 缩略图先用内存缓存铺底（`recallImage`），原图按需取；
 *  - 左右相邻各预取一张，翻页不闪白；
 *  - 缩放/拖拽/双击/键盘/缩略图条与全应用同一套交互。
 */
export function ImageViewer({ images, index, onClose, onIndexChange }: {
  images: readonly ViewerImage[]
  index: number
  onClose: () => void
  onIndexChange: (i: number) => void
}): React.JSX.Element {
  const imageSave = useMediaSaveTask()
  const sources = useMemo(() => images.map((im) => ({
    key: `${im.username}:${String(im.localId)}`,
    thumb: withThumbWidth(recallImage(im.username, im.localId)?.url ?? '', CHAT_IMAGE_THUMB_WIDTH),
    load: async (): Promise<string> => {
      const cached = recallImage(im.username, im.localId)
      if (cached) return cached.url
      const r = await apiGetImageDataUrl({ username: im.username, localId: im.localId })
      if (r.url) {
        rememberImage(im.username, im.localId, { url: r.url, thumb: r.thumb === true })
        return r.url
      }
      throw new Error('图片暂不可用')
    },
    onDownload: async (src: string) => {
      await imageSave.save<{ path: string }>({
        idPrefix: 'chat-image',
        label: '保存聊天原图',
        successMessage: (r) => `已保存聊天原图 → ${r.path}`,
        run: (jobId) => saveChatOriginal(im, src, jobId),
      })
    },
    downloadDisabled: desktopAction(),
    downloadDisabledReason: '聊天原图保存仅支持电脑端',
  })), [imageSave.save, images])
  return (
    <MediaViewer
      sources={sources}
      index={index}
      onIndexChange={onIndexChange}
      onClose={onClose}
      dialogName="chats-viewer"
      showThumbnails={images.length > 1}
      statusOverlay={(
        <ExportProgressStatus
          compact
          state={imageSave.state}
          onCancel={() => { void imageSave.cancel() }}
        />
      )}
    />
  )
}
type MessageThumbVariant = 'grid' | 'stack' | 'stack-layer' | 'expanded'

const THUMB_CLASS: Record<MessageThumbVariant, string | undefined> = {
  grid: cssrows.msgImageGridItem,
  stack: cssrows.msgImageStackItem,
  'stack-layer': cssrows.msgImageStackLayerItem,
  expanded: cssrows.msgImageExpandedItem,
}

/** 单张消息图片（可点击进大图）。图片组折叠栈和展开态也复用它。 */
export function MessageThumb({
  username,
  localId,
  onOpen,
  alt = '图片',
  variant = 'grid',
  showOcr = true,
  ocrLayout = 'overlay',
  isSelf = false,
  onSource,
}: {
  username: string
  localId: number
  onOpen?: () => void
  alt?: string
  variant?: MessageThumbVariant
  showOcr?: boolean
  ocrLayout?: 'overlay' | 'side'
  isSelf?: boolean
  onSource?: (source: string | null) => void
}): React.JSX.Element {
  // 图片组与单图共用同一份消息图片内存缓存：滚出虚拟窗口再回来不重新读盘/解码。
  const [src, setSrc] = useState<string | null>(() => recallImage(username, localId)?.url ?? null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    const cached = recallImage(username, localId)
    setSrc(cached?.url ?? null)
    setErr(null)
    if (cached) return () => { cancelled = true }
    apiGetImageDataUrl({ username, localId })
      .then((r) => {
        if (cancelled) return
        if (r.url) {
          setSrc(r.url)
          rememberImage(username, localId, { url: r.url, thumb: r.thumb === true })
        } else {
          setErr('图片暂不可用')
        }
      })
      .catch(() => { if (!cancelled) setErr('图片暂不可用') })
    return () => { cancelled = true }
  }, [username, localId])
  useEffect(() => { onSource?.(src) }, [onSource, src])
  if (err) {
    return <span className={cssrows.msgImageGridEmpty} title="图片暂不可用"><IconImage /></span>
  }
  if (!src) return <span className={cssrows.msgImageGridEmpty} data-loading="true" />
  const displaySrc = withThumbWidth(src, CHAT_IMAGE_THUMB_WIDTH)
  const thumb = (
    <span
      className={THUMB_CLASS[variant]}
      {...(onOpen ? clickableKey(onOpen, { label: '查看大图' }) : {})}
    >
      <img src={displaySrc} alt={alt} loading="lazy" decoding="async" />
    </span>
  )
  const action = showOcr
    ? <ImageTextActions source={src} username={username} localId={localId} layout={ocrLayout} />
    : null
  if (ocrLayout === 'side' && showOcr) {
    return (
      <span className={cssrows.msgImageWithOcr} data-self={isSelf ? '1' : undefined}>
        {thumb}
        {action}
      </span>
    )
  }
  return <>{thumb}{action}</>
}
/**
 * 图片组（微信「连拍合并」）。
 *
 * 微信把一次连拍的 N 张图拆成 N 条消息，每条都带同一个 `<groupinfo><id>` 与
 * `<count>`。逐条平铺会让一屏只有图片、失去「这是一组」的信息；折叠态沿用
 * 微信的卡片栈（第一张完整展示、其余露出一叠边缘），点「展开 N」后在原位
 * 纵向展开全部图片。
 * @param props.items - the group's messages (in order).
 * @returns the collapsed card stack or its expanded image list.
 */
export function MessageImageGroup({ items, username, onOpenAt }: {
  items: readonly WechatMessage[]
  username: string
  onOpenAt: (m: WechatMessage) => void
}): React.JSX.Element {
  const first = items[0]
  const isSelf = first?.isSender === 1
  const groupKey = `${username}\u0000${String(first?.localId ?? '')}\u0000${String(first?.rich?.groupId ?? '')}`
  const firstImageKey = `${username}\u0000${String(first?.localId ?? '')}`
  const [expanded, setExpanded] = useState(false)
  const [firstSource, setFirstSource] = useState<{ key: string; source: string | null } | null>(null)
  const rememberFirstSource = useCallback((source: string | null): void => {
    setFirstSource({ key: firstImageKey, source })
  }, [firstImageKey])

  // 虚拟列表会复用组件实例；切到另一组时必须回到折叠态。
  useEffect(() => {
    setExpanded(false)
  }, [groupKey])

  if (!first) return <></>
  const visibleFirstSource = firstSource?.key === firstImageKey ? firstSource.source : null

  if (expanded) {
    return (
      <div className={cssrows.msgImageGroupExpanded} data-self={isSelf ? '1' : undefined}>
        {items.map((m) => (
          <span key={m.localId} className={cssrows.msgImageExpandedFrame}>
            <MessageThumb
              username={username}
              localId={m.localId}
              variant="expanded"
              ocrLayout="side"
              isSelf={isSelf}
              onOpen={() => { onOpenAt(m) }}
            />
          </span>
        ))}
        <div className={cssrows.msgImageGroupExpandedActions}>
          <button
            type="button"
            className={cssrows.msgImageGroupToggle}
            aria-expanded="true"
            title={`收起这组 ${String(items.length)} 张图片`}
            onClick={(event) => { event.stopPropagation(); setExpanded(false) }}
          >收起</button>
        </div>
      </div>
    )
  }

  const backLayers = items.slice(1, 4)
  return (
    <div className={cssrows.msgImageGroupPanel} data-self={isSelf ? '1' : undefined}>
      <div className={cssrows.msgImageStack}>
        {backLayers.map((m, index) => (
          <span
            key={m.localId}
            className={cssrows.msgImageStackLayer}
            data-slot={index}
            aria-hidden="true"
          >
            <MessageThumb
              username={username}
              localId={m.localId}
              variant="stack-layer"
              showOcr={false}
            />
          </span>
        ))}
        <span className={cssrows.msgImageStackFront}>
          <MessageThumb
            username={username}
            localId={first.localId}
            variant="stack"
            showOcr={false}
            onSource={rememberFirstSource}
            onOpen={() => { onOpenAt(first) }}
          />
        </span>
      </div>
      <div className={cssrows.msgImageGroupActions}>
        {visibleFirstSource
          ? <ImageTextActions source={visibleFirstSource} username={username} localId={first.localId} layout="side" />
          : <span className={cssrows.msgOcrActionSlot} aria-hidden="true" />}
        <button
          type="button"
          className={cssrows.msgImageGroupToggle}
          aria-expanded="false"
          title={`展开这组 ${String(items.length)} 张图片`}
          onClick={(event) => { event.stopPropagation(); setExpanded(true) }}
        >展开 {items.length}</button>
      </div>
    </div>
  )
}
/**
 * 系统提示行（type 10000 / 10002）。
 *
 * 撤回与通知统一为微信的居中灰字；不再附加项目自造的图标或底色。
 * @returns the centered system line.
 */
export function MessageSystem({ m }: { m: WechatMessage }): React.JSX.Element {
  const text = m.displayText || (m.renderType === 'revoke' ? '撤回了一条消息' : '')
  const kind = m.renderType === 'revoke' ? 'revoke' : (m.sysKind === 'chatroomtopmsg' || m.sysKind === 'top' ? 'top' : 'notice')
  return (
    <div className={css.msgSystem} data-kind={kind}>
      <span className={cssrows.msgSystemText}>{text}</span>
    </div>
  )
}
/**
 * 位置卡片：标题 + 详细地址。
 *
 * 后端 `rich.lat/lng` 来自 `<location x y>`（x=纬度、y=经度，微信沿用 mapkit 命名）。
 * 经纬度仅供数据层使用，不进入消息正文；没有离线地图瓦片时不画假地图。
 * @param props.m - the location message.
 * @returns the location card element.
 */
export function MessageLocation({ m }: { m: WechatMessage }): React.JSX.Element {
  const rich = m.rich
  const name = rich?.title || m.displayText || ''
  const addr = rich?.desc || ''
  const visibleName = name.trim() === '位置' ? '' : name
  return (
    <div className={css.msgLocationCard}>
      <span className={css.msgLocationBody}>
        {visibleName && <span className={cssrows.msgLocationTitle} title={visibleName}>{visibleName}</span>}
        {addr && addr !== visibleName && <span className={cssrows.msgLocationDesc} title={addr}>{addr}</span>}
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
  const uname = rich?.username || ''
  const rawNick = rich?.nickname || rich?.title || m.displayText || ''
  const nick = rawNick && rawNick !== uname && !/^wxid_/i.test(rawNick) ? rawNick : '微信用户'
  const rawAlias = typeof rich?.alias === 'string' ? rich.alias : ''
  const alias = rawAlias && rawAlias !== uname && !/^wxid_/i.test(rawAlias) ? rawAlias : ''
  const displayIdentity = withEnterprise(nick, rich?.enterpriseName)
  // 名片消息里的头像是消息 XML 带来的**原始地址**：不许由渲染层自己去要（M23），
  // 交给后端代理，取不到就退回首字母（与「本机没有这张头像」同一形状）。
  const avatar = typeof rich?.avatar === 'string' ? rich.avatar : ''
  const initial = nick.slice(0, 1).toUpperCase()
  const isEnterprise = m.type === 66 || isEnterpriseWechatUser(uname)
  return (
    <div className={css.msgContactCard}>
      <span className={cssrows.msgContactAvatar}>
        <RemoteImg src={avatar} alt="" loading="lazy" pending={initial} failed={initial} />
      </span>
      <span className={cssrows.msgContactBody}>
        <span className={cssrows.msgContactNick} title={displayIdentity}>{displayIdentity}</span>
        {alias && <span className={kitCss.textCaptionTrunc} title={alias}>{alias}</span>}
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
/** 引用红包时使用的小红封图形，避免退回通用链接图标。 */
export function IconQuoteRedPacket(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <rect x="2.4" y="1.2" width="9.2" height="11.6" rx="1.7" fill="#D95749" stroke="#E9B85E" strokeWidth="0.7" />
      <path d="M2.8 3.1c2.8 2 5.6 2 8.4 0v2.2c-2.8 1.7-5.6 1.7-8.4 0V3.1Z" fill="#EE7869" />
      <circle cx="7" cy="6.8" r="1.8" fill="#F3C962" />
      <path d="M7 6v1.6M6.2 6.8h1.6" stroke="#B77A23" strokeWidth="0.7" strokeLinecap="round" />
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
  if (appType === 2001 || appType === 2003) return <IconQuoteRedPacket />
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

/** 释放音频解码资源；只 pause 会保留已加载的 data URL 和媒体缓冲。 */
function releaseVoiceAudio(audio: HTMLAudioElement | null): void {
  if (!audio) return
  if (currentVoiceAudio === audio) currentVoiceAudio = null
  audio.onended = null
  audio.onerror = null
  audio.pause()
  audio.removeAttribute('src')
  audio.load()
}

/** 停止并释放全应用当前语音（切页签/关闭会话时调用）。 */
export function stopCurrentVoice(): void {
  releaseVoiceAudio(currentVoiceAudio)
}
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
  const [playing, setPlaying] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  /** 卸载后禁止任何迟到请求创建/播放音频或写回 React 状态。 */
  const aliveRef = useRef(true)
  /** 点击序号：用户连续点按/卸载都会让上一轮异步播放失效。 */
  const playAttemptRef = useRef(0)
  const transcribeAttemptRef = useRef(0)
  useEffect(() => {
    let cancelled = false
    setTranscript(null)
    setTErr(null)
    apiGetVoiceTranscript({ username: selfName, localId: m.localId, svrId: m.serverId })
      .then((r) => { if (!cancelled && r.text) setTranscript(r.text) })
      .catch(() => { /* 尚未转写,跳过 */ })
    return () => { cancelled = true }
  }, [selfName, m.localId, m.serverId])
  const doTranscribe = async (): Promise<void> => {
    const attempt = ++transcribeAttemptRef.current
    setTranscribing(true)
    setTErr(null)
    try {
      const r = await apiTranscribeVoiceMessage({ username: selfName, localId: m.localId, svrId: m.serverId })
      if (!aliveRef.current || attempt !== transcribeAttemptRef.current) return
      if (r.ok && r.text) setTranscript(r.text)
      else setTErr('转写失败')
    } catch {
      if (aliveRef.current && attempt === transcribeAttemptRef.current) setTErr('转写失败')
    } finally {
      if (aliveRef.current && attempt === transcribeAttemptRef.current) setTranscribing(false)
    }
  }
  const ms = typeof m.rich?.durationMs === 'number' ? m.rich.durationMs : 0
  const sec = ms > 0 ? Math.max(1, Math.round(ms / 1000)) : 0
  const width = sec > 0 ? voiceWidth(sec) : undefined
  const isSelf = m.isSender === 1
  // 卸载（切会话/滚动出窗口）时停掉本条，并让尚未返回的取音频请求失效。
  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      playAttemptRef.current += 1
      transcribeAttemptRef.current += 1
      releaseVoiceAudio(audioRef.current)
      audioRef.current = null
    }
  }, [])
  /**
   * 点气泡就地播放/暂停。
   * 音频是后端解码好的 16kHz wav（data URL）——CSP 的 `media-src` 允许 `data:`，
   * 不允许 `file:`，所以只能走 data URL；同一条消息流里只允许一条在放（微信行为）。
   */
  const togglePlay = async (): Promise<void> => {
    const attempt = ++playAttemptRef.current
    setLoadErr(null)
    const cur = audioRef.current
    // Another bubble may have released this element while React still held
    // `playing=true`. Only the current, live element is genuinely pausable.
    if (cur && playing && currentVoiceAudio === cur && cur.src) {
      cur.pause()
      setPlaying(false)
      return
    }
    if (playing) setPlaying(false)
    try {
      let url = cur ? cur.src : ''
      if (!url) {
        const r = await apiGetVoiceDataUrl({ username: selfName, localId: m.localId, svrId: m.serverId })
        if (!aliveRef.current || attempt !== playAttemptRef.current) return
        if (!r.url) { setLoadErr('语音暂不可用'); return }
        url = r.url
      }
      if (currentVoiceAudio && currentVoiceAudio !== cur) releaseVoiceAudio(currentVoiceAudio)
      // stopCurrentVoice() clears the element's src. Reusing that dead element
      // would make every later play() reject even after a fresh URL arrived.
      const reusable = cur && cur.src ? cur : null
      if (cur && !reusable) releaseVoiceAudio(cur)
      const a = reusable ?? new Audio(url)
      audioRef.current = a
      currentVoiceAudio = a
      a.onended = () => {
        setPlaying(false)
        // Chromium can leave a finished data-URL media element at duration;
        // explicitly rewind so the next click starts a new playback.
        try { a.currentTime = 0 } catch { /* metadata already gone */ }
      }
      a.onpause = () => { if (aliveRef.current && audioRef.current === a) setPlaying(false) }
      a.onerror = () => { setPlaying(false); setLoadErr('播放失败') }
      if (a.ended) a.currentTime = 0
      await a.play()
      if (!aliveRef.current || attempt !== playAttemptRef.current) {
        if (audioRef.current === a) {
          releaseVoiceAudio(a)
          audioRef.current = null
        }
        return
      }
      setPlaying(true)
    } catch (error) {
      if (aliveRef.current && attempt === playAttemptRef.current) {
        setPlaying(false)
        // 切到另一条语音时，浏览器会用 pause() 打断上一条的 play()，
        // 这是正常替换而不是“语音暂不可用”。
        if (error !== null && typeof error === 'object' && 'name' in error && error.name === 'AbortError') return
        setLoadErr('语音暂不可用')
      }
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
        {...clickableKey(() => { void togglePlay() }, {
          role: 'button',
          label: playing ? '暂停语音' : '播放语音',
          // 语音播放是消息行内操作，不能顺带触发整行的“选中即分析”。
          stopPropagation: true,
        })}
      >
        {/* 方向：微信只把**我方**图标镜像（参考实现 chat.css `.voice-icon-sent { transform: scaleX(-1) }`），
            对方用基础方向 —— 基础图形是「锥体朝左 + 波纹朝右」，所以对方应是 `◀))) 5″`。
            此前写成 mirror={!isSelf} 把两侧都镜像反了（用户报「对方语音图标方向错」）。 */}
        <span className={css.msgVoiceIcon}><IconVoiceWaves mirror={isSelf} /></span>
        {sec > 0 && <span className={cssrows.msgVoiceDur}>{sec}″</span>}
      </div>
      {loadErr && <span className={css.msgVoiceErr}>{loadErr}</span>}
      {!transcript && !transcribing && !tErr && (
        <button
          type="button"
          className={cssrows.msgVoiceBtn}
          onClick={(event) => {
            event.stopPropagation()
            void doTranscribe()
          }}
        >语音转文字</button>
      )}
      {transcribing && <span className={kitCss.textMeta}>转写中…</span>}
      {tErr && !transcript && (
        <span className={css.msgVoiceErr}>{tErr}</span>
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
  const [openErr, setOpenErr] = useState<string | null>(null)
  const [videoPath, setVideoPath] = useState<string | null>(null)
  const videoSave = useMediaSaveTask()
  useEffect(() => {
    let cancelled = false
    apiGetVideoInfo({ username: selfName, localId: m.localId })
      .then((r) => {
        if (cancelled) return
        const path = r.videoPath
        if (path) setVideoPath(path)
        if (r.coverUrl) setCover(r.coverUrl)
        else setVErr('视频暂不可用')
      })
      .catch(() => { if (!cancelled) setVErr('视频暂不可用') })
    return () => { cancelled = true }
  }, [selfName, m.localId])
  const durSec = typeof m.rich?.durationSec === 'number' ? m.rich.durationSec : 0
  const durText = durSec > 0 ? `${Math.floor(durSec / 60)}:${String(durSec % 60).padStart(2, '0')}` : ''
  const openVideo = (): void => {
    if (!videoPath) return
    setOpenErr(null)
    // ⚠️ 必须检查返回值（2026-10-17）：`openPath` 失败时**不抛异常**，返回 `{ ok: false, error }`。
    // 原先只 `.catch()` ⇒ 后端拒绝时静默无反应（用户可用右键菜单里的「显示所在位置」兜底）。
    void apiOpenPath(videoPath).then((r) => {
      if (!r.ok) setOpenErr('打开视频失败：' + (r.error || '系统播放器未启动'))
    }).catch((error: unknown) => {
      setOpenErr('打开视频失败：' + (error instanceof Error ? error.message : String(error ?? '未知错误')))
    })
  }
  const saveVideo = async (): Promise<void> => {
    if (desktopAction()) {
      return
    }
    await videoSave.save<MediaOriginalExportResult>({
      idPrefix: 'chat-video',
      label: '保存聊天原视频',
      successMessage: (r) => `已保存原视频 → ${r.path ?? ''}`,
      run: async (jobId) => {
        const picked = await apiSaveFileDialog({
          defaultName: `聊天视频-${String(m.localId)}.mp4`,
          title: '保存聊天原视频',
          filters: [{ name: '视频', extensions: ['mp4', 'mov', 'm4v'] }],
        })
        if (picked.canceled || !picked.path) return null
        const result = await apiExportChatVideo({
          username: selfName,
          localId: m.localId,
          dest: picked.path,
          jobId,
        })
        if (!result.ok) throw new Error(result.error || '视频原文件写入失败')
        return { ...result, path: result.path ?? picked.path }
      },
    })
  }
  const saveAction = (
    <button
      type="button"
      className={cssrows.msgVideoSave}
      disabled={videoSave.running || desktopAction()}
      data-saving={videoSave.running || undefined}
      onClick={(event) => {
        event.stopPropagation()
        void saveVideo()
      }}
      {...desktopActionProps()}
    >
      {videoSave.finishing ? '完成中…' : videoSave.running ? '保存中…' : '保存原视频'}
    </button>
  )
  const saveStatus = (
    <ExportProgressStatus
      compact
      state={videoSave.state}
      onCancel={() => { void videoSave.cancel() }}
    />
  )
  // 没有封面但有实体：给一行可点的入口，而不是报「不在本地」
  if (vErr && videoPath) {
    return (
      <div className={css.msgBubble}>
        <span className={cssrows.msgVoicelike} {...clickableKey(openVideo, {
          role: 'button',
          label: '用系统播放器打开视频',
          stopPropagation: true,
        })}>
          <IconPlayOutline16 size={13} /> 视频{durText ? ` ${durText}` : ''}
        </span>
        {openErr && <span className={css.msgVoiceErr}>{openErr}</span>}
        {saveAction}
        {saveStatus}
      </div>
    )
  }
   if (vErr) {
     return (
       <div className={css.msgBubble}>
         <span className={cssrows.msgVoicelike}><IconPlayOutline16 size={13} /> 视频{durText ? ` ${durText}` : ''}</span>
         {saveAction}
         {saveStatus}
       </div>
     )
   }
   if (!cover) {
     return (
       <div className={`${css.msgBubble} ${css.msgBubbleTight}`}>
         <div className={css.msgImageSkeleton} aria-hidden="true" />
       </div>
     )
   }
  return (
    <div className={`${css.msgBubble} ${css.msgBubbleTight}`}>
      <span
        className={cssrows.msgVideoWrap}
        title={videoPath ? '点击用系统播放器打开视频' : '视频封面'}
        {...(videoPath ? clickableKey(openVideo, {
          role: 'button',
          label: '用系统播放器打开视频',
          stopPropagation: true,
        }) : {})}
      >
        <img src={cover} alt="视频封面" className={css.msgImage} loading="lazy" />
        <span className={cssrows.msgVideoPlay}><IconPlayOutline16 size={18} /></span>
        {durText && <span className={cssrows.msgVideoDur}>{durText}</span>}
      </span>
      {openErr && <span className={css.msgVoiceErr}>{openErr}</span>}
      {saveAction}
      {saveStatus}
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
      <span className={cssrows.msgCallBody}>
        {/*
          微信的通话气泡只有「图标 + 结局」两段：语音/视频由**图标**表达
          （话筒 / 摄像机），气泡里**不写**「语音通话 / 视频通话」这行标签。
          此前多画了一行，实测气泡比官方的宽 50px（215×38 vs 参考 165×36）。
        */}
        <span className={css.msgCallStatus}>{label || (connected ? '通话' : '未接通')}</span>
        {durSec !== null && <span className={cssrows.msgCallDur}>{fmtCallDuration(durSec)}</span>}
      </span>
    </div>
  )
}
/**
 * Lazy message image: resolve + decode via Remote, render as data URL.
 *
 * 图片右下角的「取原图」是本机补全能力：本机实测 93% 的图片在磁盘上**只有缩略图**
 * （微信从不主动下载原图），所以「图糊」不是解码失败。能不能自动补回来取决于消息 XML 里
 * 带的是哪种指针 —— 只有免登录预签名直链（`tpurl`/`tphdurl`，实测约 16%）能直接取，
 * 另一类 `cdnbigimgurl` 需要微信登录态，本应用不做。而「这条属于哪一种」只有查过 XML
 * 才知道。入口只在悬停图片时出现，避免在每条图片消息下常驻项目专属按钮。
 */
export function MessageImage({ m, selfName, onOpen }: {
  m: WechatMessage
  selfName: string
  onOpen?: (m: WechatMessage) => void
}): React.JSX.Element {
  // **首帧就查缓存**（lazy 初值）：命中时同步拿到地址，这一帧直接是图片、不闪占位 ——
  // 滚出视口再滚回来、切走再切回来，走的都是这条路。换消息（虚拟行复用节点）时惰性初值
  // 不会重算，由下面 effect 里那次同样的查表纠正。
  const [src, setSrc] = useState<string | null>(() => recallImage(selfName, m.localId)?.url ?? null)
  const [imgErr, setImgErr] = useState<string | null>(null)
  const [isThumb, setIsThumb] = useState(() => recallImage(selfName, m.localId)?.thumb ?? false)
  const [nonce, setNonce] = useState(0)
  const [fetching, setFetching] = useState(false)
  const [origNote, setOrigNote] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    // 命中内存缓存：一个请求都不发（nonce 变化 = 用户点了「取原图」，那一次必须重取）
    const hit = recallImage(selfName, m.localId)
    if (hit !== undefined && nonce === 0) {
      setSrc(hit.url)
      setIsThumb(hit.thumb)
      setImgErr(null)
      setLoaded(false)
      return () => { cancelled = true }
    }
    setSrc(null)
    setImgErr(null)
    setLoaded(false)
    apiGetImageDataUrl({ username: selfName, localId: m.localId })
      .then((r) => {
        if (cancelled) return
        if (r.url) {
          const thumb = r.thumb === true
          setSrc(r.url)
          setIsThumb(thumb)
          // 写进缓存：**这次之后**再遇到同一条（滚回来、切会话回来）就不用再取一次。
          // 只写成功结果 —— 失败不写，免得「这次没取到」被记成「已知没图」。
          rememberImage(selfName, m.localId, { url: r.url, thumb })
        } else setImgErr('图片暂不可用')
      })
      .catch(() => { if (!cancelled) setImgErr('图片暂不可用') })
    return () => { cancelled = true }
  }, [selfName, m.localId, nonce])

  useEffect(() => {
    if (origNote === null) return
    const t = window.setTimeout(() => { setOrigNote(null) }, 2000)
    return () => { window.clearTimeout(t) }
  }, [origNote])

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
        setOrigNote(imageOriginalFailureText(r.error))
      }
    } catch {
      setOrigNote('取原图失败')
    } finally {
      setFetching(false)
    }
  }

  if (imgErr) {
    return (
      <div className={css.msgBubble}><span className={kitCss.textMeta}><IconImage /> 图片暂不可用</span></div>
    )
  }
  if (!src) {
     // 骨架只表达「尚不可见」，不补项目专属的加载提示。
     return (
       <div className={`${css.msgBubble} ${css.msgBubbleTight}`}>
         <div className={css.msgImageSkeleton} aria-hidden="true" />
       </div>
    )
  }
  const displaySrc = withThumbWidth(src, CHAT_IMAGE_THUMB_WIDTH)
  return (
    <div className={cssrows.msgImageWithOcr} data-self={m.isSender === 1 ? '1' : undefined}>
      <div className={`${css.msgBubble} ${css.msgBubbleZoom}`} {...clickableKey(() => { if (onOpen) onOpen(m) }, { label: '查看大图' })}>
        <img
          src={displaySrc}
          alt="图片"
          className={css.msgImage}
          loading="lazy"
          decoding="async"
          data-thumb={isThumb ? '1' : undefined}
          data-loaded={loaded ? '1' : undefined}
          onLoad={() => { setLoaded(true) }}
        />
        <div className={cssrows.msgImageTools}>
          {fetching
            ? <span>正在取原图…</span>
            : <button type="button" className={cssrows.msgImageToolBtn} onClick={(e) => { e.stopPropagation(); void getOriginal() }}>取原图</button>}
          {origNote !== null && <span>{origNote}</span>}
        </div>
      </div>
      <ImageTextActions source={src} username={selfName} localId={m.localId} layout="side" />
    </div>
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
  const safeLabel = label && !/^[0-9a-f]{32}$/i.test(label) ? label : '表情'
  useEffect(() => {
    let cancelled = false
    if (!md5 || !/^[0-9a-f]{32}$/i.test(md5)) {
      setSrc(null)
      setErr('表情不可用')
      return () => { cancelled = true }
    }
    setSrc(null)
    setErr(null)
    apiGetEmoticonDataUrl({ md5: md5.toLowerCase(), ...(emojiUrl ? { emojiUrl } : {}) })
      .then((r) => {
        if (cancelled) return
        if (r.url) setSrc(r.url)
        else setErr('表情不可用')
      })
      .catch(() => { if (!cancelled) setErr('表情不可用') })
    return () => { cancelled = true }
  }, [md5, emojiUrl])
  if (src) {
    return (
      <div className={cssrows.msgSticker} title={safeLabel}>
        <img className={cssrows.msgStickerImg} src={src} alt={safeLabel} loading="lazy" decoding="async" />
      </div>
    )
  }
  return (
    <div className={css.msgBubble}>
      {err
        ? <span className={cssrows.msgEmojiChip} title="表情">表情</span>
        : <span className={cssrows.msgEmojiChip} data-loading="true" aria-hidden="true" />}
    </div>
  )
}
