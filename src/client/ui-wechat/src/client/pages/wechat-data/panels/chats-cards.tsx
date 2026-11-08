
/**
 * Chats 面板的消息渲染与卡片（M21 第三十二刀自 Chats.tsx 拆出）。
 *
 * 这些原先都是 Chats.tsx 里的顶层函数/组件（不吃面板状态，只吃道具）—— 整段原样搬出，
 * 面板按需 import。依赖由脚本从「这块里真实用到的面板 import」生成。
 */
import kitCss from '../ui/kit.module.css'
import { clickableKey } from '../ui/kit.tsx'
import { fmtBytes } from '../utils/format.ts'
import { renderKindOf } from '../utils/message-items.ts'
import { MessageText } from '../utils/message-text.tsx'
import { proxyableSrc } from '../utils/url.ts'
import { RemoteImg } from './remote-img.tsx'
import { MessageCall, MessageContact, MessageEmoticon, MessageImage, MessageLocation, MessageSystem, MessageVideo, MessageVoice, quoteKindIcon } from './chats-media.tsx'
import { AppCardIcon, FileKindIcon, RedPacketGlyph, TransferArrowGlyph, decodeEntities, downloadMessageFile, fileStyle, liveStatusText, openLink, transferAmountLabel } from './chats-support.tsx'
import css from './chats.module.css'
import cssrows from './chats-rows.module.css'
import { CardFoot } from './chats-card-foot.tsx'
import { withEnterprise } from './enterprise-identity.ts'
import { IdentityName } from './identity.tsx'
import { IconDataOutline16, IconLinkOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { ChatlogRecord, MpArticle, MessageRich, MessageRenderKind as RenderKind, WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { useState } from 'react'
import { ExportProgressStatus } from './ExportProgressStatus.tsx'
import { useMediaSaveTask } from './media-save-task.ts'

/** Normalize a file extension without treating an extensionless name as one. */
function fileExtension(title: string, declared?: string): string {
  const explicit = (declared ?? '').replace(/^\./, '').trim()
  if (/^[a-z0-9]{1,12}$/i.test(explicit)) return explicit.toUpperCase()
  const base = title.split(/[\\/]/).pop() ?? title
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  const inferred = base.slice(dot + 1)
  return /^[a-z0-9]{1,12}$/i.test(inferred) ? inferred.toUpperCase() : ''
}

/** 点击打开/下载收到的文件（走 msg/file 本地缓存读取）。 */
export function OpenFileCard({ title, size, ext, fileMd5, createTime, sessionUsername, localId }: {
  title: string
  size: string
  ext?: string
  fileMd5?: string
  createTime?: number
  sessionUsername?: string
  localId?: number
}): React.JSX.Element {
  const fileSave = useMediaSaveTask()
  const openFile = async (): Promise<void> => {
    const bytes = Number(size)
    await fileSave.save<{ path?: string }>({
      idPrefix: 'chat-file',
      label: '保存聊天原文件',
      successMessage: (r) => `已保存原文件 → ${r.path ?? ''}`,
      run: async (jobId) => {
        const result = await downloadMessageFile(title, {
          ...(sessionUsername ? { username: sessionUsername } : {}),
          ...(localId !== undefined ? { localId } : {}),
          ...(Number.isFinite(bytes) && bytes > 0 ? { size: bytes } : {}),
          ...(createTime !== undefined ? { createTime } : {}),
          ...(fileMd5 ? { fileMd5 } : {}),
          jobId,
        })
        if (result.error) throw new Error(result.error)
        return result.path ? result : null
      },
    })
  }
  const style = fileStyle(title, ext)
  const bytes = Number(size)
  const sized = Number.isFinite(bytes) && bytes > 0 ? fmtBytes(bytes) : ''
  const meta = [fileExtension(title, ext), sized].filter(Boolean).join(' · ')
  return (
    <div className={css.msgFileCard} {...clickableKey(() => { void openFile() })}>
      <span className={css.msgFileIcon} data-kind={style.kind}><FileKindIcon kind={style.kind} /></span>
      <div className={css.msgFileBody}>
        <span className={cssrows.msgFileTitle}>{title}</span>
        {meta && <span className={cssrows.msgFileMeta}>{meta}</span>}
        <ExportProgressStatus
          compact
          state={fileSave.state}
          onCancel={() => { void fileSave.cancel() }}
        />
      </div>
      <CardFoot label="微信电脑版" />
    </div>
  )
}
/**
 * 通用「带标签的小卡」：群公告 / 笔记 / 卡片 / 商品 / 表情 / 版本不支持。
 *
 * 这些 appmsg 子类型在 `RichCard` 里曾经一律落到 `default` 分支，
 * 于是被画成**链接卡**（标题 + 描述 + 假链接区）—— 实际它们没有可跳转的 URL。
 * 这里给一个统一外形：图标 + 类型标签 + 标题 + 描述（+ 来源 + 可选的跳转）。
 * @param props - icon/label plus the parsed title/desc/source/url.
 * @returns the card element.
 */
export function LabeledCard({ icon, label, title, desc, source, url, foot, thumb }: {
  icon: React.ReactNode
  label: string
  title?: string
  desc?: string
  source?: string
  url?: string
  foot?: string
  thumb?: string
}): React.JSX.Element {
  const link = /^https?:\/\//i.test(url ?? '')
  const safeThumb = proxyableSrc(thumb)
  const cleanTitle = (title ?? '').trim()
  const cleanDesc = (desc ?? '').trim()
  const cleanSource = (source ?? '').trim()
  const visibleTitle = cleanTitle === label || cleanTitle === foot ? '' : cleanTitle
  const visibleDesc = cleanDesc === visibleTitle || cleanDesc === label || cleanDesc === foot || cleanDesc === cleanSource ? '' : cleanDesc
  const visibleSource = cleanSource === visibleTitle || cleanSource === label || cleanSource === foot ? '' : cleanSource
  return (
    <div
      className={link ? `${css.msgAppmsgCard} ${css.msgAppmsgCardOpen}` : css.msgAppmsgCard}
      aria-label={label}
      title={link ? '点击打开链接' : undefined}
      {...(link ? clickableKey(() => { openLink(url ?? '') }, { role: 'link', label: '打开链接' }) : {})}
    >
      {safeThumb
        ? <RemoteImg className={cssrows.msgAppmsgThumb} src={safeThumb} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
        : <span className={cssrows.msgAppmsgIcon} aria-hidden="true">{icon}</span>}
      <span className={cssrows.msgAppmsgBody}>
        {visibleTitle && <span className={cssrows.msgAppmsgTitle} title={visibleTitle}>{visibleTitle}</span>}
        {visibleDesc && <span className={cssrows.msgAppmsgDesc} title={visibleDesc}>{visibleDesc}</span>}
        {visibleSource && <span className={cssrows.msgAppmsgSource}>{visibleSource}</span>}
      </span>
      {foot && <CardFoot label={foot} />}
    </div>
  )
}
/**
 * 视频号 / 直播卡片：封面 + 作者 + 标题 + 可选角标。
 *
 * 视频号分享在本机 appmsg 里是 type 51（标题常被微信替换成
 * 「当前微信版本不支持展示该内容」），真正的标题来自 `<finderFeed><desc>` ——
 * 后端已解析到 `rich.title`，界面只需别再退化成通用链接卡。
 * @param props - the channels/live rich descriptor.
 * @returns the card element.
 */
export function MediaCoverCard({ cover, badge, title, from, desc, onOpen, variant }: {
  cover?: string
  badge?: string
  title: string
  from?: string
  desc?: string
  onOpen?: () => void
  variant: 'channels' | 'live'
}): React.JSX.Element {
  const safe = proxyableSrc(cover)
  const [broken, setBroken] = useState(false)
  const open = onOpen
  const visibleTitle = /^(?:\[(?:视频号|直播)\]|视频号|直播|视频号直播)$/.test(title.trim()) ? '' : title
  return (
    <div
      className={css.msgMediaCard}
      data-variant={variant}
      {...(open ? clickableKey(open, { role: 'link', label: '打开' }) : {})}
    >
      <div className={css.msgMediaCover} data-empty={!safe || broken || undefined}>
        {safe && !broken
          ? <RemoteImg src={safe} alt="" loading="lazy" onError={() => { setBroken(true) }} />
          : <span className={cssrows.msgMediaCoverFallback} aria-hidden="true"><AppCardIcon kind={variant === 'live' ? 'live' : 'play'} /></span>}
        {badge && <span className={css.msgMediaBadge}>{badge}</span>}
        {variant === 'live' && <span className={cssrows.msgMediaDot} aria-hidden="true" />}
      </div>
      <div className={cssrows.msgMediaBody}>
        {visibleTitle && <div className={cssrows.msgMediaTitle} title={visibleTitle}>{visibleTitle}</div>}
        {from && <div className={cssrows.msgMediaFrom}>{from}</div>}
        {desc && desc !== visibleTitle && <div className={cssrows.msgMediaDesc} title={desc}>{desc}</div>}
      </div>
      <CardFoot label={variant === 'live' ? '视频号直播' : '视频号'} />
    </div>
  )
}
/** 安全读后端写的次条数组（字段缺失/类型不对时返回空数组，界面退化成普通链接卡）。 */
export function mpArticlesOf(rich: MessageRich): MpArticle[] {
  const raw = rich.mpArticles
  if (!Array.isArray(raw)) return []
  return raw.filter((a): a is MpArticle => !!a && typeof a === 'object')
}

/** 合并转发卡的内层预览：发送者带头像，正文仍保持单行省略。 */
function ChatlogPreview({ records }: { records: ChatlogRecord[] }): React.JSX.Element | null {
  const lines = records.slice(0, 4)
  if (lines.length === 0) return null
  return (
    <span className={cssrows.msgChatlogPreview}>
      {lines.map((record, idx) => {
        const name = withEnterprise(record.name, record.enterpriseName)
        const text = `${record.name ? `${name}：` : ''}${record.text || ''}`.trim()
        return (
          <span key={idx} className={cssrows.msgChatlogLine} title={text}>
            <IdentityName
              className={cssrows.msgChatlogLineIdentity}
              name={record.name || record.sourceUsername || '群成员'}
              username={record.sourceUsername ?? ''}
              size={14}
            >
              {text}
            </IdentityName>
          </span>
        )
      })}
    </span>
  )
}
/**
 * 公众号推送卡（官方形态，用户参考图）：**大图封面**在卡片顶部，
 * 单篇推送在封面下方给标题；多篇推送则把次条排成一行一篇（标题 + 右小方图），
 * 头条只由那张大图代表（参考图里 2 篇的推送就是「大图 + 1 行次条」）。
 *
 * 判据来自 `biz_message_0.db` 的真实结构（见后端 `applyMpNews`）：
 * `<mmreader><topnew><cover>` 是头条封面，`<item>` 列表第 2 篇起是次条。
 * 卡片宽度按微信的 384px 封顶 —— 本项目普通气泡是 100%（见 `--wx-bubble-maxw`），
 * 但 16:9 的封面在宽窗口下会被拉成一条横带，所以这里单独封顶。
 * @param props.rich - the parsed link fields (`mpNews` / `mpArticles` / `thumb`).
 * @param props.title - the top article's title.
 * @param props.url - the top article's url.
 * @returns the card element.
 */
export function MpNewsCard({ rich, title, url }: { rich: MessageRich; title: string; url: string }): React.JSX.Element {
  const cover = proxyableSrc(rich.thumb)
  const [broken, setBroken] = useState(false)
  const secondaries = mpArticlesOf(rich)
  const desc = decodeEntities(rich.desc || '')
  const source = decodeEntities(rich.source || '')
  const openUrl = (u: string) => { if (/^https?:\/\//i.test(u)) openLink(u) }
  const mainClickable = /^https?:\/\//i.test(url)
  const showCover = !!cover && !broken
  return (
    <div className={css.msgMpCard} data-mp-count={secondaries.length + 1}>
      {showCover && (
        <span
          className={`${css.msgMpCover} ${mainClickable ? css.msgMpClickable : ''}`}
          title={mainClickable ? '点击打开文章' : undefined}
          {...(mainClickable ? clickableKey(() => { openUrl(url) }, { role: 'link', label: '打开文章' }) : {})}
        >
          <RemoteImg className={css.msgMpCoverImg} src={cover} alt="" loading="lazy" onError={() => { setBroken(true) }} />
        </span>
      )}
      <span
        className={`${css.msgMpHead} ${mainClickable ? css.msgMpClickable : ''}`}
        title={mainClickable ? '点击打开文章' : undefined}
        {...(mainClickable ? clickableKey(() => { openUrl(url) }, { role: 'link', label: '打开文章' }) : {})}
      >
        {source && <span className={css.msgMpSource}>{source}</span>}
        {title && <span className={css.msgMpTitle}>{title}</span>}
        {desc && <span className={css.msgMpDesc} title={desc}>{desc}</span>}
      </span>
      {secondaries.map((a, i) => {
        const t = a.title || ''
        const u = a.url || ''
        const summary = a.summary || ''
        const thumb = proxyableSrc(a.cover)
        const clickable = /^https?:\/\//i.test(u)
        return (
          <span
            key={`${u || t}-${String(i)}`}
            className={`${css.msgMpRow} ${clickable ? css.msgMpClickable : ''}`}
            title={clickable ? '点击打开文章' : undefined}
            {...(clickable ? clickableKey(() => { openUrl(u) }, { role: 'link', label: '打开次条文章' }) : {})}
          >
            <span className={css.msgMpRowBody}>
              {t && <span className={css.msgMpRowTitle}>{t}</span>}
              {summary && <span className={css.msgMpRowDesc} title={summary}>{summary}</span>}
            </span>
            {thumb && <RemoteImg className={cssrows.msgMpRowThumb} src={thumb} alt="" loading="lazy" />}
          </span>
        )
      })}
    </div>
  )
}
/**
 * 链接卡：`default`（左文右图）与 `cover`（公众号大图式）两种外形。
 *
 * 微信把公众号文章渲染成「封面大图 + 底部标题」，普通网页是「标题 + 摘要 + 域名」。
 * 后端用 `rich.linkStyle` 已经判好了（摘要以话题标签开头 / 含 `#话题#` /
 * PC 信息流链接近 cover），界面按它切换即可，不必每个面板自己猜。
 * @param props - the parsed link fields.
 * @returns the card element.
 */
export function LinkCard({ rich, title, desc, url }: {
  rich: MessageRich
  title: string
  desc: string
  url: string
}): React.JSX.Element {
  const safeThumb = proxyableSrc(rich.thumb)
  const [broken, setBroken] = useState(false)
  const clickable = /^https?:\/\//i.test(url)
  const cover = rich.linkStyle === 'cover' && safeThumb && !broken
  const source = rich.source || ''
  return (
    <div
      className={[css.msgLinkCard, clickable ? css.msgLinkCardOpen : '', cover ? css.msgLinkCover : ''].filter(Boolean).join(' ')}
      title={clickable ? '点击打开链接' : undefined}
      // 可打开时是链接语义（读屏播报「链接」），不可打开时完全不挂交互属性
      {...(clickable ? clickableKey(() => { openLink(url) }, { role: 'link', label: '打开链接' }) : {})}
    >
      {cover && (
        <span className={cssrows.msgLinkCoverWrap}>
          <RemoteImg className={cssrows.msgLinkCoverImg} src={safeThumb} alt="" loading="lazy" onError={() => { setBroken(true) }} />
          {clickable && <span className={cssrows.msgLinkOpen}><IconLinkOutline14 size={12} /></span>}
          <span className={css.msgLinkCoverTitle} title={title}>{title}</span>
        </span>
      )}
      {!cover && (
        <span className={cssrows.msgLinkThumbWrap}>
          <span className={cssrows.msgLinkText}>
            {source && <span className={css.msgLinkSource}>{source}</span>}
            <span className={cssrows.msgLinkTitle}>{title}</span>
            {desc && <span className={cssrows.msgLinkDesc} title={desc}>{desc}</span>}
          </span>
          {safeThumb && (
            <RemoteImg className={cssrows.msgLinkThumb} src={safeThumb} alt="" loading="lazy" onError={() => { setBroken(true) }} />
          )}
        </span>
      )}
      {clickable && !cover && <span className={cssrows.msgLinkOpen}><IconLinkOutline14 size={12} /></span>}
    </div>
  )
}

function TransferCard({ rich }: { rich: MessageRich }): React.JSX.Element {
  const amount = transferAmountLabel(rich.amount || rich.title)
  return (
    <div className={css.msgTransferCard}>
      <span className={css.msgTransferArrow} aria-hidden="true"><TransferArrowGlyph /></span>
      {amount && <span className={cssrows.msgTransferMain}><span className={cssrows.msgTransferAmount}>{amount}</span></span>}
      <CardFoot label="微信转账" />
    </div>
  )
}

function RedPacketCard({ rich }: { rich: MessageRich }): React.JSX.Element {
  const decoded = decodeEntities(rich.desc || '').trim()
  const greeting = /^\[?微信红包\]?$/.test(decoded) ? '' : decoded
  return (
    <div className={css.msgRedpacketCard}>
      <div className={cssrows.msgRedpacketIcon} aria-hidden="true"><RedPacketGlyph /></div>
      <div className={cssrows.msgRedpacketBody}>
        {greeting && <div className={cssrows.msgRedpacketTitle}>{greeting}</div>}
      </div>
      <CardFoot label="微信红包" />
    </div>
  )
}

/** 需要走 `RichCard` 的卡片型种类（其余种类有专用渲染器）。 */
export const CARD_KINDS = new Set<RenderKind>([
  'file', 'link', 'quote', 'miniapp', 'channels', 'live', 'music', 'product',
  'card', 'note', 'sticker', 'announcement', 'solitaire', 'chatlog',
  'transfer', 'redpacket', 'unsupported', 'unknown',
])

interface RichCardProps {
  rich: MessageRich
  fallback: string
  onOpenChatlog?: (rich: MessageRich) => void
  onOpenQuote?: (rich: MessageRich) => void
  /** 本条消息的接收时间（秒）—— 文件卡按它缩小到月份目录。 */
  createTime?: number
  /** 当前会话 username 与本条消息 localId；文件导出据此从消息库确认归属。 */
  sessionUsername?: string
  localId?: number
}

/** Quote preview under a message bubble; only probe avatars for a real referrer username. */
function QuoteStrip({ name, username, summary, icon, thumb, onOpen }: {
  name: string
  username: string
  summary: string
  icon: React.ReactNode
  thumb: string
  onOpen?: () => void
}): React.JSX.Element | null {
  if (!summary && !name && !thumb) return null
  const thumbOpen = /^https?:\/\//i.test(thumb)
  const fullTitle = name ? `${name}：${summary}` : summary
  const content = (
    <>
      {name && (
        username
          ? <IdentityName className={cssrows.msgQuoteWho} name={name} username={username} size={16}>{name}:</IdentityName>
          : <span className={cssrows.msgQuoteWho}>{name}:</span>
      )}
      {icon && <span className={cssrows.msgQuoteKind} aria-hidden="true">{icon}</span>}
      {summary && <span className={cssrows.msgQuoteWhat}>{summary}</span>}
      {thumb && (
        <span
          className={`${cssrows.msgQuoteThumbWrap} ${thumbOpen ? cssrows.msgQuoteThumbOpen : ''}`}
          {...(thumbOpen ? {
            onClick: (event: React.MouseEvent) => {
              event.stopPropagation()
              openLink(thumb)
            },
          } : {})}
        >
          <RemoteImg className={cssrows.msgQuoteThumb} src={thumb} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
        </span>
      )}
    </>
  )
  if (!onOpen) {
    return <div className={css.msgQuoteStrip} title={fullTitle}>{content}</div>
  }
  return (
    <button
      type="button"
      className={`${css.msgQuoteStrip} ${css.msgQuoteStripOpen}`}
      title={`${fullTitle}${fullTitle ? ' · ' : ''}点击定位原消息`}
      aria-label={`定位引用的原消息${fullTitle ? `：${fullTitle}` : ''}`}
      onClick={(event) => {
        event.stopPropagation()
        onOpen()
      }}
    >
      {content}
    </button>
  )
}

/**
 * Render a rich media card (file/link/quote/miniapp/...) inside a bubble.
 *
 * 与旧实现的区别：**种类判断只在 `MessageBody` 里做一次**（按后端 `renderType`），
 * 这里只按 `rich.type` 分派外形，不再维护第二张白名单。
 * @param props - the parsed rich descriptor + render context.
 * @returns the card element.
 */
export function RichCard({
  rich,
  fallback,
  onOpenChatlog,
  onOpenQuote,
  createTime,
  sessionUsername,
  localId,
}: RichCardProps): React.JSX.Element {
  const title = decodeEntities(rich.title || fallback || '')
  const desc = decodeEntities(rich.desc || '')
  const url = rich.url || ''
  switch (rich.type) {
    case 'transfer':
      return <TransferCard rich={rich} />
    case 'redpacket':
      return <RedPacketCard rich={rich} />
    case 'solitaire':
      // 微信把接龙作为普通多行文本展示；成员名单只用于数据检索，不进消息气泡。
      return (
        <div className={css.msgBubble}>
          <MessageText text={title || fallback} onOpenLink={openLink} />
        </div>
      )
    case 'announcement':
      return <LabeledCard icon={<AppCardIcon kind="announcement" />} label="群公告" title={title} desc={desc} source={rich.source || ''} foot="群公告" />
    case 'note':
      return <LabeledCard icon={<AppCardIcon kind="note" />} label="笔记" title={title || desc} desc={title ? desc : ''} source={rich.source || ''} foot="笔记" />
    case 'card': {
      // 36 类卡片（本机实测是第三方 H5/团购卡）：有 url 就能跳，别画成死卡。
      return <LabeledCard icon={<AppCardIcon kind="card" />} label="卡片" title={title} desc={desc} source={rich.source || ''} thumb={rich.thumb || ''} url={url} foot="卡片" />
    }
    case 'product':
      return <LabeledCard icon={<AppCardIcon kind="product" />} label="商品" title={title} desc={desc} source={rich.source || ''} thumb={rich.thumb || ''} url={url} foot="商品" />
    case 'sticker': {
      // 自定义表情：按 md5 解码真图；有 CDN thumb 时优先用 thumb（免扫盘）。
      const md5 = rich.md5 || (/^[0-9a-f]{32}$/i.test(title) ? title : '')
      const label = title && !/^[0-9a-f]{32}$/i.test(title) ? title : undefined
      const safeThumb = proxyableSrc(rich.thumb)
      if (safeThumb) {
        return (
          <div className={cssrows.msgSticker} title={label || '表情'}>
            <RemoteImg className={cssrows.msgStickerImg} src={safeThumb} alt={label || '表情'} loading="lazy"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          </div>
        )
      }
      if (md5) return <MessageEmoticon md5={md5} label={label} emojiUrl={typeof rich.emojiUrl === 'string' ? rich.emojiUrl : undefined} />
      return (
        <div className={css.msgBubble}>
          <span className={cssrows.msgEmojiChip} title="表情">[表情]</span>
        </div>
      )
    }
    case 'pat':
      return <div className={css.msgSystem} data-kind="pat">{title || '[拍一拍]'}</div>
    case 'unsupported':
      return <div className={css.msgSystem} data-kind="notice">
        <span className={cssrows.msgSystemText}>{title && !/^(?:版本不支持|暂不支持)$/.test(title) ? title : '当前微信版本不支持展示该内容，请升级至最新版本。'}</span>
      </div>
    case 'quote': {
      // 引用：desc = 被引用的原文（媒体/卡片已折成 `[图片]`/`[转账]`），referName = 被引用方昵称。
      //
      // 官方形态（用户参考图 + 几何核对）：**被引用内容不套在气泡里**，而是气泡下方
      // 独立的一行灰字 `发送者: <类型图标> 摘要`，无底色、**最多两行、超出省略**
      // （2026-09-25 二次实测改正：先前写的是「单行省略」，但参考图里那条引用行
      //   高 58px = 两行；而单行 + nowrap 在宽窗口下会把行撑到 1694px）。
      //   宽度上界走 --wx-quote-maxw（640px），不能跟气泡的 100%。
      // 判据：参考图里那条引用行宽 138px，而同一条绿色气泡只有 40px ——
      // 引用行比气泡还宽，它不可能是气泡的子元素。
      const quoted = desc || ''
      const refUsername = rich.referUsername?.trim() ?? ''
      const thumb = proxyableSrc(rich.thumb)
      const appType = typeof rich.referAppType === 'number' ? rich.referAppType : 0
      const kindIcon = quoteKindIcon(rich.referType, appType)
      // 引用行已经画了类型图标，摘要就不再重复一遍类型词
      // （官方参考图是「⊙微信转账」，不是「⊙ [转账] 微信转账」）。
      const prefixes: string[] = []
      if (appType === 2000) prefixes.push('[转账]')
      if (appType === 2001 || appType === 2003) prefixes.push('[红包]')
      if (appType === 4 || appType === 5 || appType === 68) prefixes.push('[链接]')
      if (appType === 36) prefixes.push('[卡片]')
      if (rich.referType === 3) prefixes.push('[图片]')
      if (rich.referType === 34) prefixes.push('[语音]')
      if (rich.referType === 43) prefixes.push('[视频]')
      if (rich.referType === 42 || rich.referType === 66) prefixes.push('[名片]')
      if (rich.referType === 49 || rich.referType === 5 || rich.referType === 68) prefixes.push('[链接]')
      let summary = quoted
      if (kindIcon) {
        const prefix = prefixes.find((p) => summary.startsWith(p))
        if (prefix) summary = summary.slice(prefix.length).trimStart()
      }
      return (
        <>
          {title && <div className={css.msgBubble}>{title}</div>}
          <QuoteStrip
            name={rich.referName || ''}
            username={refUsername}
            summary={summary}
            icon={kindIcon}
            thumb={thumb}
            {...(onOpenQuote ? { onOpen: () => { onOpenQuote(rich) } } : {})}
          />
        </>
      )
    }
    case 'file':
      return (
        <OpenFileCard
          title={title}
          size={rich.fileSize ?? ''}
          {...(rich.fileExt ? { ext: rich.fileExt } : {})}
          {...(rich.fileMd5 ? { fileMd5: rich.fileMd5 } : {})}
          {...(createTime !== undefined ? { createTime } : {})}
          {...(sessionUsername ? { sessionUsername } : {})}
          {...(localId !== undefined ? { localId } : {})}
        />
      )
    case 'chatlog': {
      const records = Array.isArray(rich.records) ? rich.records : []
      return (
        <button type="button" className={css.msgChatlogCard}
          onClick={onOpenChatlog ? () => { onOpenChatlog(rich) } : undefined}
          disabled={!onOpenChatlog}
          title={onOpenChatlog ? '点击查看聊天记录' : '当前消息没有可展开的聊天记录'}>
          <span className={cssrows.msgChatlogMain}>
            <span className={cssrows.msgChatlogIcon}><IconDataOutline16 size={15} /></span>
            <span className={cssrows.msgChatlogBody}>
              <span className={cssrows.msgChatlogTitle}>{title || '群聊的聊天记录'}</span>
              <ChatlogPreview records={records} />
            </span>
          </span>
          <CardFoot label="聊天记录" />
        </button>
      )
    }
    case 'miniapp': {
      // 微信原生小程序卡：顶栏应用名 → 标题 → 页面封面大图 → 底栏「小程序」。
      const cover = proxyableSrc(rich.thumb)
      const appIcon = proxyableSrc(typeof rich.avatar === 'string' ? rich.avatar : '')
      const appName = rich.source || ''
      const bodyDesc = desc && !/[<>]/.test(desc) && desc !== title ? desc : ''
      const visibleTitle = /^(?:\[小程序\]|小程序)$/.test(title.trim()) ? '' : title
      return (
        <div className={css.msgMiniappCard} data-no-cover={!cover || undefined}>
          {(appName || appIcon) && (
            <div className={css.msgMiniappApp}>
              {appIcon
                ? <RemoteImg className={cssrows.msgMiniappAppIcon} src={appIcon} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                : <span className={cssrows.msgMiniappAppDot} aria-hidden="true" />}
              {appName && <span className={cssrows.msgMiniappName}>{appName}</span>}
            </div>
          )}
          {visibleTitle && <div className={cssrows.msgMiniappTitle}>{visibleTitle}</div>}
          {bodyDesc && bodyDesc !== visibleTitle && <div className={cssrows.msgMiniappDesc}>{bodyDesc}</div>}
          {cover && (
            <div className={cssrows.msgMiniappCover}>
              <RemoteImg
                className={cssrows.msgMiniappCoverImg}
                src={cover}
                alt=""
                loading="lazy"
                onError={(e) => {
                  const el = e.target as HTMLImageElement
                  el.style.display = 'none'
                  el.parentElement?.setAttribute('data-empty', '')
                }}
              />
            </div>
          )}
          <CardFoot label="小程序" />
        </div>
      )
    }
    case 'channels':
      return (
        <MediaCoverCard
          variant="channels"
          cover={rich.thumb}
          title={title}
          {...(rich.source ? { from: rich.source } : {})}
          {...(desc ? { desc } : {})}
          {...(/^https?:\/\//i.test(url) ? { onOpen: () => { openLink(url) } } : {})}
        />
      )
    case 'live':
      return (
        <MediaCoverCard
          variant="live"
          cover={rich.thumb}
          {...(liveStatusText(typeof rich.status === 'string' ? rich.status : '') ? { badge: liveStatusText(typeof rich.status === 'string' ? rich.status : '') } : {})}
          title={title}
          {...(rich.source ? { from: rich.source } : {})}
          {...(desc ? { desc } : {})}
          {...(/^https?:\/\//i.test(url) ? { onOpen: () => { openLink(url) } } : {})}
        />
      )
    case 'music': {
      const safeThumb = proxyableSrc(rich.thumb)
      const link = /^https?:\/\//i.test(url)
      return (
        <div className={css.msgMusicCard}
          title={link ? '点击打开' : undefined}
          {...(link ? clickableKey(() => { openLink(url) }, { role: 'link', label: '打开音乐' }) : {})}>
          <span className={cssrows.msgMusicCover} data-empty={!safeThumb || undefined}>
            {safeThumb
              ? <RemoteImg src={safeThumb} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
              : <AppCardIcon kind="music" />}
          </span>
          <span className={cssrows.msgMusicBody}>
            {title && <span className={cssrows.msgMusicTitle} title={title}>{title}</span>}
            {desc && <span className={cssrows.msgMusicArtist} title={desc}>{desc}</span>}
            {rich.source && <span className={cssrows.msgMusicFrom}>{rich.source}</span>}
          </span>
          <CardFoot label="音乐" />
        </div>
      )
    }
    case 'link': {
      const cardUrl = url || (title.match(/https?:\/\/[^\s<>"']+/) ?? [])[0]?.replace(/[。，；、！？）)】…]+$/, '') || ''
      // 公众号推送（后端识别出 `<mmreader>`）走大图卡 + 次条，其余链接仍是紧凑链接卡
      if (rich.mpNews === true) return <MpNewsCard rich={rich} title={title} url={cardUrl} />
      return <LinkCard rich={rich} title={title} desc={desc} url={cardUrl} />
    }
    default: {
      // appmsg 兜底：有 url 走链接卡，没 url 就只显示标题文本，绝不画带假链接的卡片。
      const cardUrl = url
        || (title.match(/https?:\/\/[^\s<>"']+/) ?? [])[0]?.replace(/[。，；、！？）)】…]+$/, '')
        || ''
      if (/^https?:\/\//i.test(cardUrl)) return <LinkCard rich={rich} title={title} desc={desc} url={cardUrl} />
      return (
        <div className={css.msgAppmsgCard}>
          <span className={cssrows.msgAppmsgIcon} aria-hidden="true"><AppCardIcon kind="message" /></span>
          <span className={cssrows.msgAppmsgBody}>
            {title && <span className={cssrows.msgAppmsgTitle} title={title}>{title}</span>}
            {desc && <span className={cssrows.msgAppmsgDesc} title={desc}>{desc}</span>}
          </span>
        </div>
      )
    }
  }
}
/**
 * Render one message body by its canonical `renderType`.
 *
 * **只按 `renderType` 分派**（后端 `classifyRender` 的单一答案），不再
 * 「先看 local_type、再看 rich.type、再看白名单」三段判断 —— 后者每漏一个
 * 子类型就退化成通用链接卡（接龙/笔记/卡片/表情都掉过）。
 * `renderKindOf(m)`（`utils/message-items.ts`）只为渲染缓存里的旧消息兜底。
 * @param props - the message + render callbacks.
 * @returns the message body element.
 */
export function MessageBody({ m, selfName, sessionUsername, onOpenImage, onOpenChatlog, onOpenQuote }: {
  m: WechatMessage
  selfName: string
  sessionUsername?: string
  onOpenImage?: (m: WechatMessage) => void
  onOpenChatlog?: (rich: MessageRich) => void
  onOpenQuote?: (rich: MessageRich) => void
}): React.JSX.Element {
  const kind = renderKindOf(m)
  const text = m.displayText || ''
  const rich = m.rich

  // 系统/撤回：居中系统行（带子类型样式），不是气泡。
  if (kind === 'system' || kind === 'revoke') return <MessageSystem m={m} />
  if (kind === 'pat') return <div className={css.msgSystem} data-kind="pat">{text || '[拍一拍]'}</div>
  // 11000：内容为空、status=2 的占位行。微信本身没有可读正文，
  // 这里保留占位但不显示数据库诊断文案。
  if (kind === 'empty') {
    return <div className={css.msgSystem} data-kind="empty" aria-hidden="true" />
  }

  if (kind === 'text') {
    return (
      <div className={css.msgBubble}>
        <MessageText text={text} atUsers={m.atUsers} onOpenLink={openLink} />
      </div>
    )
  }
  if (kind === 'image') {
    return <MessageImage m={m} selfName={selfName} {...(onOpenImage ? { onOpen: onOpenImage } : {})} />
  }
  if (kind === 'voice') return <MessageVoice m={m} selfName={selfName} />
  if (kind === 'video') return <MessageVideo m={m} selfName={selfName} />
  if (kind === 'location') {
    // 位置消息可能没有 rich（老的 render cache），此时退回纯文本展示。
    if (!rich || rich.type !== 'location') return <div className={css.msgBubble}><MessageText text={text || '[位置]'} onOpenLink={openLink} /></div>
    return <MessageLocation m={m} />
  }
  if (kind === 'contactCard') return <MessageContact m={m} />
  if (kind === 'voip') return <MessageCall m={m} />
  if (kind === 'emoji') {
    const md5 = rich?.md5 || rich?.title || ''
    if (md5) return <MessageEmoticon md5={md5} label={text || undefined} emojiUrl={typeof rich?.emojiUrl === 'string' ? rich.emojiUrl : undefined} />
    return (
      <div className={css.msgBubble}>
        <span className={cssrows.msgEmojiChip} title="表情">[表情]</span>
      </div>
    )
  }

  // 卡片型：rich 存在时走 RichCard；rich 缺失（旧缓存 / 极端兜底）时给可读文本。
  if (rich && (CARD_KINDS.has(kind) || rich.type !== undefined)) {
    return (
      <RichCard rich={rich} fallback={text}
        createTime={m.createTime}
        {...(sessionUsername ? { sessionUsername } : {})}
        localId={m.localId}
        {...(onOpenChatlog ? { onOpenChatlog } : {})}
        {...(onOpenQuote ? { onOpenQuote } : {})} />
    )
  }
  if (kind === 'link') {
    const urlMatch = text.match(/https?:\/\/[^\s<>"']+/)
    const url = urlMatch ? urlMatch[0].replace(/[。，；、！？）)】…]+$/, '') : ''
    return <LinkCard rich={{ type: 'link', title: text }} title={text} desc="" url={url} />
  }
  return (
    <div className={css.msgBubble}>
      <span className={kitCss.textMeta}>{describeFallbackText(text)}</span>
    </div>
  )
}

/**
 * 兜底预览文案：**任何情况下都不把原始 XML 铺给用户**（2026-09-29 修"各种类型消息预览坏了"）。
 *
 * 为什么需要：上面的分派已覆盖 text / image / voice / video / location / contactCard /
 * voip / emoji / link，以及"有 `rich` 的卡片型"。剩下两类会落到最后那行兜底：
 *   ① 未识别的 `kind`；
 *   ② 旧渲染缓存里 **`rich` 缺失**的卡片（`<appmsg>` 之类）。
 * 这两类的 `text` 往往就是**整段 `<msg>…</msg>` XML** ⇒ 原先直接把尖括号渲染出来，
 * 于是同一屏里文本消息好好的、旁边那条卡片消息却是一堆标记。
 *
 * 做法：按 XML 根标签映射成中文标签；认不出只显示通用占位；非 XML 则清控制字符并限长。
 * **只改展示**，不碰解析与数据。
 * @param text - 兜底可用的文本（可能是 XML 片段）。
 * @returns 一行可读文案。
 */
function describeFallbackText (text: string): string {
  const raw = (text ?? '').trim()
  if (raw === '') return '[暂不支持的消息]'
  if (raw.startsWith('<')) {
    const flat = raw.replace(/\s+/g, ' ')
    const byTag: ReadonlyArray<readonly [RegExp, string]> = [
      [/<img\b/i, '图片'], [/<emoji\b/i, '表情'], [/<voicemsg\b/i, '语音'], [/<videomsg\b/i, '视频'],
      [/<location\b/i, '位置'], [/<transfer\b/i, '转账'], [/<wcpayinfo\b/i, '微信支付'],
      [/<redpacket|<hongbao/i, '红包'], [/<music\b/i, '音乐'], [/<chathistory|<recorditem/i, '聊天记录'],
      [/finderusernamecard|<findernamecard/i, '视频号'], [/<card\b|<wcscard/i, '名片'],
      [/<refermsg\b/i, '引用（卡片）'], [/<appmsg\b/i, '链接 / 文件'], [/<sysmsg\b/i, '系统消息'],
    ]
    for (const [re, label] of byTag) if (re.test(flat)) return `[${label}]`
    return '[暂不支持的消息]'
  }
  const clean = raw.replace(/[\u0000-\u0008\u000b-\u001f]/g, '').replace(/\s+/g, ' ').trim()
  return clean.length > 200 ? clean.slice(0, 200) + '…' : clean
}
