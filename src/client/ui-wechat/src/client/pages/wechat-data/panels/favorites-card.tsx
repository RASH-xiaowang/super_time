/**
 * 收藏卡片（#22 虚拟化之后的一行）。
 *
 * 为什么要从 `Favorites.tsx` 的 map 里搬出来：面板函数在**单函数行数棘轮**里记着 270 行（只许变小），
 * 而虚拟化要在面板里加挂载、定位、测高那十几行；更要紧的是虚拟化之后**每一行都会反复挂载/卸载**，
 * "接近视口才解码缩略图"这件事的表达方式跟着变了（原来是给整段列表挂 IntersectionObserver，
 * 现在是"行挂上就是要看它"）—— 这一条规则得待在一个能单独渲染一行来测的地方。
 *
 * 卡片的可观察形状：`role` 随「批量选择」在 checkbox 与 button 之间切、
 * 选择模式下前面那个勾、标题/摘要/落款、有缩略图才出 `<img>`。
 */
import { useEffect } from 'react'
import { clickableKey } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './list-panel.module.css'
import { parseFavItem } from './favorites-parse.ts'
import { FavoriteAvatar } from './favorites-avatar.tsx'
import type { FavItemPart, FavorItem } from '@deepseek-ai/dsh-wechat-data/types'

export interface FavCardProps {
  /** 这一条收藏。 */
  f: FavorItem
  selectMode: boolean
  /** 批量选择模式下这条有没有被勾上（非选择模式忽略）。 */
  checked: boolean
  thumbs: Readonly<Record<string, string>>
  onActivate: (f: FavorItem) => void
  /**
   * 这一行挂载了 ⇒ 请求它的缩略图。
   * 回调必须稳定（面板那边是 `useCallback(…, [])`），否则每次渲染都会重新触发一次解码请求。
   */
  onMounted: (md5: string) => void
}

/** 列表缩略图候选：图片优先缩略图，视频/小程序等优先封面。 */
function previewPartOf(items: readonly FavItemPart[]): FavItemPart | undefined {
  return items.find((part) => (
    part.kind === 'image'
    || part.kind === 'video'
    || part.kind === 'miniapp'
    || part.kind === 'product'
    || part.kind === 'music'
    || part.kind === 'note'
    || part.kind === 'channels'
    || part.kind === 'unknown'
  ) && Boolean(part.thumbMd5 || part.fullMd5 || part.md5))
}

/** 资源种类对应的缩略图占位字。 */
function previewGlyph(part: FavItemPart): string {
  if (part.kind === 'video') return '▶'
  if (part.kind === 'image') return '图'
  if (part.kind === 'miniapp') return '小'
  if (part.kind === 'channels') return '视'
  if (part.kind === 'music') return '♪'
  return '◈'
}

/**
 * 渲染一张收藏卡片。
 * @returns 卡片元素。
 */
export function FavCard({ f, selectMode, checked, thumbs, onActivate, onMounted }: FavCardProps): React.JSX.Element {
  const info = parseFavItem(f)
  /**
   * 聊天记录收藏的卡片预览只取前两条正文，并带上发送者前缀；
   * 普通收藏仍按原来的口径取文本条目，避免把 `sourceName` 当成正文重复一遍。
   */
  const preview = info.items.length > 0
    ? (f.type === 14
        ? info.items.filter((p) => p.kind === 'text' && p.text).slice(0, 2)
          .map((p) => (p.sourceName ? `${p.sourceName}：${p.text ?? ''}` : p.text ?? '')).join('\n')
        : info.items.filter((p) => p.kind === 'text').map((p) => p.text || '').join('\n'))
    : info.desc
  const previewPart = previewPartOf(info.items)
  const md5 = previewPart?.thumbMd5 ?? previewPart?.fullMd5 ?? previewPart?.md5 ?? ''
  const url = md5 ? thumbs[md5] : undefined
  useEffect(() => {
    if (md5) onMounted(md5)
  }, [md5, onMounted])
  return (
    <div
      className={css.favCard}
      data-fav-id={String(f.localId)}
      data-media-md5={md5 || undefined}
      {...clickableKey(() => { onActivate(f) })}
      // 卡片在「批量选择」模式下其实是复选框语义，不能一律声明成按钮；
      // 后写的属性覆盖 clickableKey 的默认值，键盘与读屏两边都准确。
      role={selectMode ? 'checkbox' : 'button'}
      aria-checked={selectMode ? checked : undefined}
      aria-label={info.title}
    >
      {selectMode && (
        <span className={kitCss.batchCheck} data-checked={checked || undefined}>
          {checked ? '✓' : ''}
        </span>
      )}
      <FavoriteAvatar
        avatar={f.avatar}
        name={info.source}
        className={css.favCardAvatar}
        fallbackClassName={css.favCardAvatarFallback}
      />
      <div className={css.favCardBody}>
        <div className={css.favCardTitle}>{info.title}</div>
        {preview && <div className={css.favCardDesc}>{preview}</div>}
        <div className={css.favCardFoot}>
          <span className={css.favCardMeta + ' ' + kitCss.textCaption}>{info.typeLabel + (info.source ? ' · ' + info.source : '')}</span>
          {info.time && <span className={css.favCardTime + ' ' + kitCss.textCaption}>{info.time}</span>}
        </div>
      </div>
      {url && <img className={css.favCardThumb} src={url} alt="" loading="lazy" referrerPolicy="no-referrer" />}
      {!url && previewPart && (
        <span className={css.favCardThumbFallback} aria-hidden="true">{previewGlyph(previewPart)}</span>
      )}
    </div>
  )
}
