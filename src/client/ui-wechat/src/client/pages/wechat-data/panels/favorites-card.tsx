/**
 * 收藏卡片（#22 虚拟化之后的一行）。
 *
 * 为什么要从 `Favorites.tsx` 的 map 里搬出来：面板函数在**单函数行数棘轮**里记着 270 行（只许变小），
 * 而虚拟化要在面板里加挂载、定位、测高那十几行；更要紧的是虚拟化之后**每一行都会反复挂载/卸载**，
 * "接近视口才解码缩略图"这件事的表达方式跟着变了（原来是给整段列表挂 IntersectionObserver，
 * 现在是"行挂上就是要看它"）—— 这一条规则得待在一个能单独渲染一行来测的地方。
 *
 * 卡片的可观察形状与搬出前逐条一致：`role` 随「批量选择」在 checkbox 与 button 之间切、
 * 选择模式下前面那个勾、标题/摘要/来源时间那一行、有缩略图才出 `<img>`。
 */
import { useEffect } from 'react'
import { clickableKey } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import css from './list-panel.module.css'
import { parseFavItem } from './favorites-parse.ts'
import type { FavorItem } from '@deepseek-ai/dsh-wechat-data/types'

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

/**
 * 渲染一张收藏卡片。
 * @returns 卡片元素。
 */
export function FavCard({ f, selectMode, checked, thumbs, onActivate, onMounted }: FavCardProps): React.JSX.Element {
  const info = parseFavItem(f)
  const preview = info.items.length > 0 ? info.items.filter((p) => p.kind === 'text').map((p) => p.text || '').join('\n') : info.desc
  const md5 = info.items.find((it) => it.kind === 'image' && it.md5)?.md5 ?? ''
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
      <div className={css.favCardBody}>
        <div className={css.favCardTitle}>{info.title}</div>
        {preview && <div className={css.favCardDesc}>{preview}</div>}
        <div className={kitCss.textCaption}>{info.typeLabel + (info.source ? ' · ' + info.source : '') + ' · ' + info.time}</div>
      </div>
      {url && <img className={css.favCardThumb} src={url} alt="" loading="lazy" referrerPolicy="no-referrer" />}
    </div>
  )
}
