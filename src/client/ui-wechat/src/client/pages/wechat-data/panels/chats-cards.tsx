
/**
 * Chats 面板的消息渲染与卡片（M21 第三十二刀自 Chats.tsx 拆出）。
 *
 * 这些原先都是 Chats.tsx 里的顶层函数/组件（不吃面板状态，只吃道具）—— 整段原样搬出，
 * 面板按需 import。依赖由脚本从「这块里真实用到的面板 import」生成。
 */
import { apiGetPaymentStatus } from '../api.ts'
import kitCss from '../ui/kit.module.css'
import { clickableKey } from '../ui/kit.tsx'
import { fmtBytes } from '../utils/format.ts'
import { renderKindOf } from '../utils/message-items.ts'
import { MessageText } from '../utils/message-text.tsx'
import { cspSafeSrc } from '../utils/url.ts'
import { MessageCall, MessageContact, MessageEmoticon, MessageImage, MessageLocation, MessageSystem, MessageVideo, MessageVoice, quoteKindIcon } from './chats-media.tsx'
import { TransferArrowGlyph, TransferCheckGlyph, decodeEntities, downloadMessageFile, fileStyle, liveStatusText, openLink, quoteTypeLabel, transferStateKey, transferStatusLabel } from './chats-support.tsx'
import css from './chats.module.css'
import { IconDataOutline16, IconLinkOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { MessageRich, PaymentStatus, MessageRenderKind as RenderKind, WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { useEffect, useState } from 'react'
/** Authoritative transfer/redpacket status line from general.db. */
export function PayStatusLine({ serverId }: { serverId: string }): React.JSX.Element | null {
  const [pay, setPay] = useState<PaymentStatus | null>(null)
  useEffect(() => {
    let cancelled = false
    apiGetPaymentStatus(serverId)
      .then((r) => { if (!cancelled && r.found) setPay(r) })
      .catch(() => { /* keep XML-derived status */ })
    return () => { cancelled = true }
  }, [serverId])
  if (!pay || pay.kind === 'transfer' || !pay.redpacket) return null
  const rp = pay.redpacket
  const state = rp.hbStatus === 4 || rp.receiveStatus === 4 ? '已退还'
    : rp.receiveStatus === 3 ? '已被领取'
      : rp.receiveStatus === 2 ? '已领取'
        : '待领取'
  return (
    <div className={css.msgPayStatus} data-kind={pay.kind}>
      {rp.sender ? '来自 ' + rp.sender + ' · ' : ''}{state}
      {rp.hbType === 1 ? ' · 群红包' : ''}
    </div>
  )
}
/** 点击打开/下载收到的文件（走 msg/file 本地缓存读取）。 */
export function OpenFileCard({ title, size, createTime }: { title: string; size: string; createTime?: number }): React.JSX.Element {
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [message, setMessage] = useState('')
  const openFile = async (): Promise<void> => {
    setStatus('loading')
    setMessage('')
    const bytes = Number(size)
    const err = await downloadMessageFile(title, {
      ...(Number.isFinite(bytes) && bytes > 0 ? { size: bytes } : {}),
      ...(createTime !== undefined ? { createTime } : {}),
    })
    if (err) {
      setStatus('error')
      setMessage(err)
      return
    }
    setStatus('idle')
  }
  const ext = (title.split('.').pop() || '').toLowerCase()
  const style = fileStyle(title)
  const sized = size ? fmtBytes(Number(size)) : ''
  const foot = status === 'loading' ? '打开中…' : status === 'error' ? message : '点击打开 / 下载'
  return (
    <div className={css.msgFileCard} {...clickableKey(() => { void openFile() })} title={status === 'error' ? message : '点击打开/下载文件'}>
      <span className={css.msgFileIcon} data-kind={style.kind}>{style.emoji}</span>
      <span className={css.msgFileBody}>
        <span className={css.msgFileTitle}>{title}</span>
        <span className={css.msgFileMeta}>{[ext ? ext.toUpperCase() : '文件', sized].filter(Boolean).join(' · ')}</span>
        <span className={css.msgFileHint}>{foot}</span>
      </span>
      <span className={css.msgFileExt}>{ext ? ext.toUpperCase() : '文件'}</span>
      <CardFoot label="微信电脑版" />
    </div>
  )
}
/**
 * 卡片底部的**类型条**（微信原生卡片底部那一行「微信转账 / 微信红包 / 聊天记录」）。
 *
 * 有了它，同一张卡片在不同位置（气泡内 / 合并转发弹窗内）都能被一眼认出来源；
 * 也因此**不再**把类型名塞进标题 —— 那会让标题被截断。
 * @param props.label - 类型名。
 * @returns the footer element.
 */
export function CardFoot({ label }: { label: string }): React.JSX.Element {
  return <span className={css.msgCardFoot}>{label}</span>
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
  icon: string
  label: string
  title?: string
  desc?: string
  source?: string
  url?: string
  foot?: string
  thumb?: string
}): React.JSX.Element {
  const link = /^https?:\/\//i.test(url ?? '')
  const safeThumb = cspSafeSrc(thumb)
  return (
    <div
      className={link ? `${css.msgAppmsgCard} ${css.msgAppmsgCardOpen}` : css.msgAppmsgCard}
      title={link ? '点击打开链接' : undefined}
      {...(link ? clickableKey(() => { openLink(url ?? '') }, { role: 'link', label: '打开链接' }) : {})}
    >
      {safeThumb
        ? <img className={css.msgAppmsgThumb} src={safeThumb} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
        : <span className={css.msgAppmsgIcon} aria-hidden="true">{icon}</span>}
      <span className={css.msgAppmsgBody}>
        <span className={css.msgAppmsgLabel}>{label}</span>
        {title && <span className={css.msgAppmsgTitle} title={title}>{title}</span>}
        {desc && <span className={css.msgAppmsgDesc} title={desc}>{desc}</span>}
        {source && <span className={css.msgAppmsgSource}>{source}</span>}
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
  const safe = cspSafeSrc(cover)
  const [broken, setBroken] = useState(false)
  const open = onOpen
  return (
    <div
      className={css.msgMediaCard}
      data-variant={variant}
      {...(open ? clickableKey(open, { role: 'link', label: '打开' }) : {})}
    >
      <div className={css.msgMediaCover} data-empty={!safe || broken || undefined}>
        {safe && !broken
          ? <img src={safe} alt="" loading="lazy" onError={() => { setBroken(true) }} />
          : <span className={css.msgMediaCoverFallback} aria-hidden="true">{variant === 'live' ? '📡' : '▶'}</span>}
        {badge && <span className={css.msgMediaBadge}>{badge}</span>}
        {variant === 'live' && <span className={css.msgMediaDot} aria-hidden="true" />}
      </div>
      <div className={css.msgMediaBody}>
        <div className={css.msgMediaTitle} title={title}>{title}</div>
        {from && <div className={css.msgMediaFrom}>{from}</div>}
        {desc && desc !== title && <div className={css.msgMediaDesc} title={desc}>{desc}</div>}
      </div>
      <CardFoot label={variant === 'live' ? '视频号直播' : '视频号'} />
    </div>
  )
}
/**
 * 公众号多图文推送的一篇（后端 `rich.mpArticles`）。
 *
 * 客户端这份类型是**本地声明**：`node_modules` 里那份类型副本落后于后端，
 * 它的 `MessageRich` 索引签名还没有 `MpArticle[]`，直接读会过不了 `tsc`。
 * 所以这里只做「从 unknown 里安全取数组」这一件事，字段逐个校验。
 */
export interface MpArticle {
  title?: string
  url?: string
  cover?: string
  summary?: string
}
/** 安全读后端写的次条数组（字段缺失/类型不对时返回空数组，界面退化成普通链接卡）。 */
export function mpArticlesOf(rich: MessageRich): MpArticle[] {
  const raw: unknown = rich.mpArticles
  if (!Array.isArray(raw)) return []
  return raw.filter((a): a is MpArticle => !!a && typeof a === 'object')
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
  const cover = cspSafeSrc(rich.thumb)
  const [broken, setBroken] = useState(false)
  const secondaries = mpArticlesOf(rich)
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
          <img className={css.msgMpCoverImg} src={cover} alt="" loading="lazy" onError={() => { setBroken(true) }} />
        </span>
      )}
      {secondaries.length === 0 ? (
        <span
          className={`${css.msgMpTitle} ${mainClickable ? css.msgMpClickable : ''}`}
          title={mainClickable ? '点击打开文章' : undefined}
          {...(mainClickable ? clickableKey(() => { openUrl(url) }, { role: 'link', label: '打开文章' }) : {})}
        >
          {title}
        </span>
      ) : (
        secondaries.map((a, i) => {
          const t = a.title || ''
          const u = a.url || ''
          const thumb = cspSafeSrc(a.cover)
          const clickable = /^https?:\/\//i.test(u)
          return (
            <span
              key={`${u || t}-${String(i)}`}
              className={`${css.msgMpRow} ${clickable ? css.msgMpClickable : ''}`}
              title={clickable ? '点击打开文章' : undefined}
              {...(clickable ? clickableKey(() => { openUrl(u) }, { role: 'link', label: '打开次条文章' }) : {})}
            >
              <span className={css.msgMpRowTitle}>{t || '[无标题]'}</span>
              {thumb && <img className={css.msgMpRowThumb} src={thumb} alt="" loading="lazy" />}
            </span>
          )
        })
      )}
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
  const safeThumb = cspSafeSrc(rich.thumb)
  const [broken, setBroken] = useState(false)
  const clickable = /^https?:\/\//i.test(url)
  const cover = rich.linkStyle === 'cover' && safeThumb && !broken
  const source = rich.source || ''
  let host = ''
  try { host = clickable ? new URL(url).hostname : '' } catch { host = '' }
  return (
    <div
      className={[css.msgLinkCard, clickable ? css.msgLinkCardOpen : '', cover ? css.msgLinkCover : ''].filter(Boolean).join(' ')}
      title={clickable ? '点击打开链接' : undefined}
      // 可打开时是链接语义（读屏播报「链接」），不可打开时完全不挂交互属性
      {...(clickable ? clickableKey(() => { openLink(url) }, { role: 'link', label: '打开链接' }) : {})}
    >
      {cover && (
        <span className={css.msgLinkCoverWrap}>
          <img className={css.msgLinkCoverImg} src={safeThumb} alt="" loading="lazy" onError={() => { setBroken(true) }} />
          {clickable && <span className={css.msgLinkOpen}><IconLinkOutline14 size={12} /></span>}
          <span className={css.msgLinkCoverTitle} title={title}>{title}</span>
        </span>
      )}
      {!cover && (
        <span className={css.msgLinkThumbWrap}>
          <span className={css.msgLinkText}>
            {source && <span className={css.msgLinkSource}>{source}</span>}
            <span className={css.msgLinkTitle}>{title}</span>
            {desc && <span className={css.msgLinkDesc} title={desc}>{desc}</span>}
            {!safeThumb && clickable && <span className={css.msgLinkUrl} title={url}>{host || url}</span>}
          </span>
          {safeThumb && (
            <img className={css.msgLinkThumb} src={safeThumb} alt="" loading="lazy" onError={() => { setBroken(true) }} />
          )}
        </span>
      )}
      {clickable && !cover && <span className={css.msgLinkOpen}><IconLinkOutline14 size={12} /></span>}
    </div>
  )
}
/** 需要走 `RichCard` 的卡片型种类（其余种类有专用渲染器）。 */
export const CARD_KINDS = new Set<RenderKind>([
  'file', 'link', 'quote', 'miniapp', 'channels', 'live', 'music', 'product',
  'card', 'note', 'sticker', 'announcement', 'solitaire', 'chatlog',
  'transfer', 'redpacket', 'unsupported', 'unknown',
])
/**
 * Render a rich media card (file/link/quote/miniapp/...) inside a bubble.
 *
 * 与旧实现的区别：**种类判断只在 `MessageBody` 里做一次**（按后端 `renderType`），
 * 这里只按 `rich.type` 分派外形，不再维护第二张白名单。
 * @param props - the parsed rich descriptor + render context.
 * @returns the card element.
 */
export function RichCard({ rich, fallback, self = false, onOpenChatlog, serverId, createTime }: {
  rich: MessageRich
  fallback: string
  self?: boolean
  onOpenChatlog?: (rich: MessageRich) => void
  serverId?: string
  /** 本条消息的接收时间（秒）—— 文件卡按它缩小到月份目录。 */
  createTime?: number
}): React.JSX.Element {
  const title = decodeEntities(rich.title || fallback || '')
  const desc = decodeEntities(rich.desc || '')
  const url = rich.url || ''
  switch (rich.type) {
    case 'transfer': {
      const amount = (rich.title || '').replace(/^\s*[Y￥]/, '¥')
      const state = transferStatusLabel(self, rich.paysubtype)
      const key = transferStateKey(rich.paysubtype)
      return (
        <div className={css.msgTransferCard} data-state={key}>
          <span className={css.msgTransferArrow} aria-hidden="true">{key === 'pending' ? <TransferArrowGlyph /> : <TransferCheckGlyph />}</span>
          <span className={css.msgTransferMain}>
            <span className={css.msgTransferAmount}>{amount || '¥0.00'}</span>
            <span className={css.msgTransferStatus}>{state || (key === 'pending' ? (self ? '等待对方领取' : '待收款') : '已收款')}</span>
          </span>
          <CardFoot label="微信转账" />
        </div>
      )
    }
    case 'redpacket': {
      const amount = typeof rich.amount === 'string' ? rich.amount.replace(/^\s*[Y￥]/, '¥') : ''
      const greet = rich.desc || '恭喜发财，大吉大利'
      return (
        <div className={css.msgRedpacketCard}>
          <div className={css.msgRedpacketIcon} aria-hidden="true">🧧</div>
          <div className={css.msgRedpacketBody}>
            <div className={css.msgRedpacketTitle}>{greet}</div>
            {amount && <div className={css.msgRedpacketAmount}>{amount}</div>}
            {serverId && <PayStatusLine serverId={serverId} />}
          </div>
          <CardFoot label="微信红包" />
        </div>
      )
    }
    case 'solitaire': {
      // 群接龙：title 只是摘要（`#接龙\n明晚球\n\n1. 云端"），参与者名单在 rich.members。
      // 本机 316 条接龙里 268 条带名单 —— 旧实现把它们渲染成通用链接卡，名单全看不见。
      const members = Array.isArray(rich.members) ? rich.members : []
      const declared = typeof rich.declared === 'number' ? rich.declared : 0
      const lines = String(rich.title || '').replace(/^#?接龙\s*/, '').split('\n').map(l => l.trim()).filter(Boolean)
      // 有名单时只留事由（第一行）；没名单时 title 里的 "1. xxx" 就是全部信息，照原样显示
      const subject = members.length > 0 ? (lines[0] ?? '') : lines.join(' · ')
      const shown = members.slice(0, 8)
      return (
        <div className={css.msgSolitaireCard}>
          <div className={css.msgSolitaireHd}>
            <span className={css.msgSolitaireIcon} aria-hidden="true">🧾</span>
            <span className={css.msgSolitaireSubject} title={subject || '群接龙'}>{subject || '群接龙'}</span>
            {members.length > 0 && <span className={css.msgSolitaireCount}>{declared > members.length ? `${members.length}/${declared} 人` : `${members.length} 人`}</span>}
          </div>
          {shown.length > 0 && (
            <ol className={css.msgSolitaireList}>
              {shown.map(m => (
                <li key={m.idx} className={css.msgSolitaireItem} title={m.username ? `${m.username}` : undefined}>
                  <span className={css.msgSolitaireIdx}>{m.idx}</span>
                  <span className={css.msgSolitaireText}>{m.content || '（未填）'}</span>
                </li>
              ))}
            </ol>
          )}
          {members.length > shown.length && (
            <div className={kitCss.textCaption}>还有 {members.length - shown.length} 人…</div>
          )}
          {declared > members.length && (
            <div className={kitCss.textCaption}>名单声明 {declared} 人，当前列出 {members.length} 人（有人退出后未同步）</div>
          )}
          <CardFoot label="群接龙" />
        </div>
      )
    }
    case 'announcement':
      return <LabeledCard icon="📢" label="群公告" title={title || '群公告'} desc={desc} source={rich.source || ''} foot="群公告" />
    case 'note':
      return <LabeledCard icon="📝" label="笔记" title={title || desc} desc={title ? desc : ''} source={rich.source || ''} foot="笔记" />
    case 'card': {
      // 36 类卡片（本机实测是第三方 H5/团购卡）：有 url 就能跳，别画成死卡。
      return <LabeledCard icon="🏷️" label="卡片" title={title} desc={desc} source={rich.source || ''} thumb={rich.thumb || ''} url={url} foot="卡片" />
    }
    case 'product':
      return <LabeledCard icon="🛍️" label="商品" title={title} desc={desc} source={rich.source || ''} thumb={rich.thumb || ''} url={url} foot="商品" />
    case 'sticker': {
      // 自定义表情：按 md5 解码真图；有 CDN thumb 时优先用 thumb（免扫盘）。
      const md5 = rich.md5 || title || ''
      const safeThumb = cspSafeSrc(rich.thumb)
      if (safeThumb) {
        return (
          <div className={css.msgSticker} title={title || '表情'}>
            <img className={css.msgStickerImg} src={safeThumb} alt={title || '表情'} loading="lazy"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
          </div>
        )
      }
      if (md5) return <MessageEmoticon md5={md5} label={title || undefined} emojiUrl={typeof rich.emojiUrl === 'string' ? rich.emojiUrl : undefined} />
      return (
        <div className={css.msgBubble}>
          <span className={css.msgEmojiChip} title="自定义表情">😊 [表情]</span>
        </div>
      )
    }
    case 'pat':
      return <div className={css.msgSystem} data-kind="pat">{title || '[拍一拍]'}</div>
    case 'unsupported':
      return (
        <LabeledCard icon="⚠️" label="版本不支持" title={title || '当前微信版本不支持展示该内容，请升级至最新版本。'} foot="暂不支持" />
      )
    case 'quote': {
      // 引用：desc = 被引用的原文（媒体/卡片已折成 `[图片]`/`[转账]`），referName = 被引用方昵称。
      //
      // 官方形态（用户参考图 + 几何核对）：**被引用内容不套在气泡里**，而是气泡下方
      // 独立的一行灰字 `发送者: <类型图标> 摘要`，无底色、单行省略。
      // 判据：参考图里那条引用行宽 138px，而同一条绿色气泡只有 40px ——
      // 引用行比气泡还宽，它不可能是气泡的子元素。
      const quoted = desc || ''
      const refName = rich.referName || ''
      const thumb = cspSafeSrc(rich.thumb)
      const qType = quoteTypeLabel(rich.referType)
      const appType = typeof rich.referAppType === 'number' ? rich.referAppType : 0
      const kindIcon = quoteKindIcon(rich.referType, appType)
      // 引用行已经画了类型图标，摘要就不再重复一遍类型词
      // （官方参考图是「⊙微信转账」，不是「⊙ [转账] 微信转账」）。
      const summary = appType === 2000 ? quoted.replace(/^\[转账\]\s*/, '') : quoted
      const thumbOpen = /^https?:\/\//i.test(thumb)
      return (
        <>
          <div className={css.msgBubble}>{title}</div>
          {(quoted || refName || qType) && (
            <div className={css.msgQuoteStrip} title={refName ? `${refName}：${summary}` : summary}>
              {refName && <span className={css.msgQuoteWho}>{refName}:</span>}
              {kindIcon && <span className={css.msgQuoteKind} aria-hidden="true">{kindIcon}</span>}
              <span className={css.msgQuoteWhat}>{summary || `[${qType}]`}</span>
              {thumb && (
                <span
                  className={`${css.msgQuoteThumbWrap} ${thumbOpen ? css.msgQuoteThumbOpen : ''}`}
                  {...(thumbOpen ? clickableKey(() => { openLink(thumb) }, { role: 'link', label: '查看引用缩略图' }) : {})}
                >
                  <img className={css.msgQuoteThumb} src={thumb} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                </span>
              )}
            </div>
          )}
        </>
      )
    }
    case 'file':
      return <OpenFileCard title={title} size={rich.fileSize ?? ''} {...(createTime !== undefined ? { createTime } : {})} />
    case 'chatlog': {
      const records = Array.isArray(rich.records) ? rich.records : []
      const preview = records.slice(0, 4).map(r => `${r.name || ''}${r.name ? '：' : ''}${r.text || ''}`.trim()).filter(Boolean)
      return (
        <button type="button" className={css.msgChatlogCard}
          onClick={onOpenChatlog ? () => { onOpenChatlog(rich) } : undefined}
          title={onOpenChatlog ? '点击查看聊天记录' : undefined}>
          <span className={css.msgChatlogMain}>
            <span className={css.msgChatlogIcon}><IconDataOutline16 size={15} /></span>
            <span className={css.msgChatlogBody}>
              <span className={css.msgChatlogTitle}>{title || '群聊的聊天记录'}</span>
              {preview.length > 0 && (
                <span className={css.msgChatlogPreview}>
                  {preview.map((line, i) => <span key={i} className={css.msgChatlogLine} title={line}>{line}</span>)}
                </span>
              )}
            </span>
          </span>
          <CardFoot label={records.length > 0 ? `聊天记录 · 共 ${records.length} 条` : '聊天记录'} />
        </button>
      )
    }
    case 'miniapp': {
      // 微信原生小程序卡：顶栏应用名 → 标题 → 页面封面大图 → 底栏「小程序」。
      const cover = cspSafeSrc(rich.thumb)
      const appIcon = cspSafeSrc(typeof rich.avatar === 'string' ? rich.avatar : '')
      const appName = rich.source || ''
      const bodyDesc = desc && !/[<>]/.test(desc) && desc !== title ? desc : ''
      return (
        <div className={css.msgMiniappCard}>
          {(appName || appIcon) && (
            <div className={css.msgMiniappApp}>
              {appIcon
                ? <img className={css.msgMiniappAppIcon} src={appIcon} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                : <span className={css.msgMiniappAppDot} aria-hidden="true" />}
              <span className={css.msgMiniappName}>{appName || '小程序'}</span>
            </div>
          )}
          <div className={css.msgMiniappTitle}>{title || '[小程序]'}</div>
          {bodyDesc && <div className={css.msgMiniappDesc}>{bodyDesc}</div>}
          <div className={css.msgMiniappCover} data-empty={!cover || undefined}>
            {cover
              ? (
                <img
                  className={css.msgMiniappCoverImg}
                  src={cover}
                  alt=""
                  loading="lazy"
                  onError={(e) => {
                    const el = e.target as HTMLImageElement
                    el.style.display = 'none'
                    el.parentElement?.setAttribute('data-empty', '')
                  }}
                />
              )
              : (
                <span className={css.msgMiniappCoverFallback} aria-hidden="true">
                  <IconDataOutline16 size={22} />
                </span>
              )}
          </div>
          <CardFoot label="小程序" />
        </div>
      )
    }
    case 'channels':
      return (
        <MediaCoverCard
          variant="channels"
          cover={rich.thumb}
          title={title || '[视频号]'}
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
          title={title || '[直播]'}
          {...(rich.source ? { from: rich.source } : {})}
          {...(desc ? { desc } : {})}
          {...(/^https?:\/\//i.test(url) ? { onOpen: () => { openLink(url) } } : {})}
        />
      )
    case 'music': {
      const safeThumb = cspSafeSrc(rich.thumb)
      const link = /^https?:\/\//i.test(url)
      return (
        <div className={css.msgMusicCard}
          title={link ? '点击打开' : undefined}
          {...(link ? clickableKey(() => { openLink(url) }, { role: 'link', label: '打开音乐' }) : {})}>
          <span className={css.msgMusicCover} data-empty={!safeThumb || undefined}>
            {safeThumb
              ? <img src={safeThumb} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
              : <span aria-hidden="true">🎵</span>}
          </span>
          <span className={css.msgMusicBody}>
            <span className={css.msgMusicTitle} title={title}>{title || '音乐'}</span>
            {desc && <span className={css.msgMusicArtist} title={desc}>{desc}</span>}
            {rich.source && <span className={css.msgMusicFrom}>{rich.source}</span>}
          </span>
          <CardFoot label="音乐" />
        </div>
      )
    }
    case 'link': {
      const cardUrl = url || (title.match(/https?:\/\/[^\s<>"']+/) ?? [])[0]?.replace(/[。，；、！？）)】…]+$/, '') || ''
      // 公众号推送（后端识别出 `<mmreader>`）走大图卡 + 次条，其余链接仍是紧凑链接卡
      if (rich.mpNews === true) return <MpNewsCard rich={rich} title={title} url={cardUrl} />
      return <LinkCard rich={rich} title={title || '链接'} desc={desc} url={cardUrl} />
    }
    default: {
      // appmsg 兜底：有 url 走链接卡，没 url 就只显示标题文本，绝不画带假链接的卡片。
      const cardUrl = url
        || (title.match(/https?:\/\/[^\s<>"']+/) ?? [])[0]?.replace(/[。，；、！？）)】…]+$/, '')
        || ''
      if (/^https?:\/\//i.test(cardUrl)) return <LinkCard rich={rich} title={title || '链接'} desc={desc} url={cardUrl} />
      return (
        <div className={css.msgAppmsgCard}>
          <span className={css.msgAppmsgIcon} aria-hidden="true">💬</span>
          <span className={css.msgAppmsgBody}>
            <span className={css.msgAppmsgTitle} title={title}>{title || fallback || '[应用消息]'}</span>
            {desc && <span className={css.msgAppmsgDesc} title={desc}>{desc}</span>}
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
export function MessageBody({ m, selfName, onOpenImage, onOpenChatlog }: {
  m: WechatMessage
  selfName: string
  onOpenImage?: (m: WechatMessage) => void
  onOpenChatlog?: (rich: MessageRich) => void
}): React.JSX.Element {
  const kind = renderKindOf(m)
  const text = m.displayText || ''
  const rich = m.rich

  // 系统/撤回：居中系统行（带子类型样式），不是气泡。
  if (kind === 'system' || kind === 'revoke') return <MessageSystem m={m} />
  if (kind === 'pat') return <div className={css.msgSystem} data-kind="pat">{text || '[拍一拍]'}</div>
  // 11000：内容为空、status=2 的占位行（本机 13 条）。画空气泡或空白都很难看，
  // 给一行极淡的说明，让「这里有一条记录但没内容」这件事可见。
  if (kind === 'empty') {
    return <div className={css.msgSystem} data-kind="empty"><span className={css.msgSystemText}>（无内容的消息记录）</span></div>
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
        <span className={css.msgEmojiChip} title="自定义表情">😊 [表情]</span>
      </div>
    )
  }

  // 卡片型：rich 存在时走 RichCard；rich 缺失（旧缓存 / 极端兜底）时给可读文本。
  if (rich && (CARD_KINDS.has(kind) || rich.type !== undefined)) {
    return (
      <RichCard rich={rich} fallback={text} self={m.isSender === 1}
        createTime={m.createTime}
        {...(onOpenChatlog ? { onOpenChatlog } : {})}
        {...(m.serverId ? { serverId: m.serverId } : {})} />
    )
  }
  if (kind === 'link') {
    const urlMatch = text.match(/https?:\/\/[^\s<>"']+/)
    const url = urlMatch ? urlMatch[0].replace(/[。，；、！？）)】…]+$/, '') : ''
    return <LinkCard rich={{ type: 'link', title: text }} title={text || '链接'} desc="" url={url} />
  }
  return <div className={css.msgBubble}><span className={kitCss.textMeta}>{text || `[类型 ${m.type}]`}</span></div>
}