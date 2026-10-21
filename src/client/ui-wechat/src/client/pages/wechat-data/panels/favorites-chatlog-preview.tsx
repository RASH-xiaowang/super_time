/**
 * 收藏里的「聊天记录」预览。
 *
 * 结构与消息页的 `ChatsChatlogView` 一致（头像、发送者、时间、正文），
 * 但数据来自收藏的 `<dataitem>`，没有嵌套栈，因此不需要复用整套栈式抽屉。
 * 头像继续交给 `RemoteImg`：`sourceheadurl` 是未校验的原始地址，渲染层不能直接请求。
 */
import { useMemo } from 'react'
import type { FavorItem } from '@deepseek-ai/dsh-wechat-data/types'
import { Drawer } from '../ui/kit.tsx'
import kitCss from '../ui/kit.module.css'
import { parseFavItem } from './favorites-parse.ts'
import { FavoriteAvatar } from './favorites-avatar.tsx'
import { FavoritePart } from './favorites-media.tsx'
import { useSharedRemoteImages } from './remote-img.tsx'
import csscards from './chats-cards.module.css'
import cssshell from './chats-shell.module.css'

export interface FavoritesChatlogPreviewProps {
  /** 当前打开的聊天记录收藏；`null` 时不渲染。 */
  item: FavorItem | null
  /** 列表已解码的图片（md5 → data URL）。 */
  thumbs: Readonly<Record<string, string>>
  onClose: () => void
}

/**
 * 近全高的收藏聊天记录预览。
 * @param props - 收藏条目与关闭回调。
 * @returns 右侧抽屉与逐条消息。
 */
export function FavoritesChatlogPreview({ item, thumbs, onClose }: FavoritesChatlogPreviewProps): React.JSX.Element | null {
  const info = useMemo(() => (item ? parseFavItem(item) : null), [item])
  const sharedHeads = useSharedRemoteImages(info?.items.map((part) => part.sourceHead ?? '') ?? [])
  if (!item || !info) return null
  const lines = info.items
  return (
    <Drawer
      open
      onClose={onClose}
      title={info.title}
      width={520}
    >
      <div className={cssshell.chatlogBody}>
        {lines.length === 0 && <div className={kitCss.emptyInline}>暂无内层消息</div>}
        {lines.map((part, idx) => {
          const avatarSrc = part.sourceHead
            ? (sharedHeads[part.sourceHead] ?? part.sourceHead)
            : (item.avatar ?? '')
          return (
            <div key={idx} className={cssshell.chatlogRow}>
              <FavoriteAvatar
                avatar={avatarSrc}
                name={part.sourceName || info.source}
                className={csscards.chatlogAvatar}
              />
              <div className={cssshell.chatlogMain}>
                <div className={cssshell.chatlogTop}>
                  <span className={cssshell.chatlogName}>{part.sourceName || '未知发送者'}</span>
                  {part.sourceTime && <span className={cssshell.chatlogTime}>{part.sourceTime}</span>}
                </div>
                <FavoritePart part={part} updateTime={item.updateTime} thumbs={thumbs} />
              </div>
            </div>
          )
        })}
      </div>
    </Drawer>
  )
}
