/**
 * 非「聊天记录」类收藏的通用详情。
 *
 * 单独成文件是为了让 `FavoritesPanel` 保持在单函数行数棘轮预算内；
 * 聊天记录收藏改走 `FavoritesChatlogPreview`，两者不要混回同一个渲染分支。
 */
import type { FavorItem } from '@deepseek-ai/dsh-wechat-data/types'
import kitCss from '../ui/kit.module.css'
import { FavoriteAvatar } from './favorites-avatar.tsx'
import { FavoritePart } from './favorites-media.tsx'
import { parseFavItem } from './favorites-parse.ts'
import css from './list-panel.module.css'

export interface FavoriteDetailProps {
  /** 要展示的收藏。 */
  item: FavorItem
  /** 已解码的图片（md5 → data URL）。 */
  thumbs: Readonly<Record<string, string>>
}

/**
 * 渲染普通收藏详情主体。
 * @param props - 收藏与图片缓存。
 * @returns 详情内容。
 */
export function FavoriteDetail({ item, thumbs }: FavoriteDetailProps): React.JSX.Element {
  const d = parseFavItem(item)
  return (
    <div className={css.formBody}>
      <div className={css.favSource}>
        <FavoriteAvatar avatar={item.avatar} name={d.source} />
        <div className={css.favSourceMeta}>
          <div className={css.favSourceName}>{d.source || '未知来源'}</div>
          <div className={kitCss.textMeta}>{d.typeLabel + ' · ' + d.time}</div>
        </div>
      </div>
      <div className={css.favDetail}>
        {d.items.length > 0 ? d.items.map((it, idx) => (
          <div key={idx} className={css.favPart}>
            {(it.sourceName || it.sourceTime) && <div className={css.favPartMeta}>{[it.sourceName, it.sourceTime].filter(Boolean).join(' · ')}</div>}
            <FavoritePart part={it} updateTime={item.updateTime} thumbs={thumbs} />
          </div>
        )) : <div className={css.favPartText}>{d.desc || ''}</div>}
      </div>
      {d.url && <a href={d.url} target="_blank" rel="noopener noreferrer" className={css.rowName}>打开链接</a>}
    </div>
  )
}
