/**
 * 地图两侧的联系人头像栏。
 *
 * 在世界 / 中国 / 省区等任一地图层级，把当前子树的联系人头像分别渲染在地图左右两侧，
 * 便于直接浏览而不需要悬停；列表按好友排列、可滚动。
 */
import type { RegionFriend } from '@deepseek-ai/dsh-wechat-data/types'
import { localImageSrc } from './remote-img.tsx'
import css from './world-map.module.css'

/** Options for the avatar rail component. */
interface FriendAvatarRailProps {
  /** Which side of the map this rail is rendered on. */
  side: 'left' | 'right'
  /** Friends to render (already split by caller). */
  friends: RegionFriend[]
  /** Local avatar URLs keyed by username (empty when offline/unresolvable). */
  avatars: Record<string, string>
  /** HTML id of the map container, for an accessible relationship. */
  mapId?: string
}

/**
 * Render one avatar rail.
 * @param props - component props.
 * @returns the rail element.
 */
export function FriendAvatarRail({ side, friends, avatars, mapId }: FriendAvatarRailProps): React.JSX.Element {
  const cls = side === 'left' ? css.avatarRailLeft : css.avatarRailRight
  return (
    <div
      className={cls}
      data-side={side}
      role="list"
      aria-label={`${side === 'left' ? '左侧' : '右侧'}联系人头像`}
      aria-owns={mapId}
    >
      {friends.map((f) => {
        // `avatars` 是 api 层交回来的**可画地址**（本机离线头像，或后端代理取回的 data URL，
        // 拿不到的就是空串）。快照里的 `f.avatarUrl` 是原始远程地址，**不再直接用**（M23：
        // 渲染层自己向 CDN 发图片请求的话，两个出网开关都管不到）。
        const src = localImageSrc(avatars[f.username])
        const name = f.displayName || f.remark || f.nickName || f.username
        return (
          <div key={f.username} className={css.avatarItem} role="listitem" title={`${name}\n${f.username}`}>
            <span className={css.avatarWrap}>
              {src ? (
                <img className={css.avatar} src={src} alt="" loading="lazy" referrerPolicy="no-referrer" />
              ) : (
                <span className={css.avatarFallback}>{name.slice(0, 1)}</span>
              )}
            </span>
            <span className={css.friendLabel}>{name}</span>
          </div>
        )
      })}
    </div>
  )
}
