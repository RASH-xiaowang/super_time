/**
 * 地图两侧的联系人头像栏。
 *
 * 在世界 / 中国 / 省区等任一地图层级，把当前子树的联系人头像分别渲染在地图左右两侧，
 * 便于直接浏览而不需要悬停；列表按好友排列、可滚动。
 */
import type { RegionFriend } from '@deepseek-ai/dsh-wechat-data/types';
/** Options for the avatar rail component. */
interface FriendAvatarRailProps {
    /** Which side of the map this rail is rendered on. */
    side: 'left' | 'right';
    /** Friends to render (already split by caller). */
    friends: RegionFriend[];
    /** Local avatar URLs keyed by username (empty when offline/unresolvable). */
    avatars: Record<string, string>;
    /** HTML id of the map container, for an accessible relationship. */
    mapId?: string;
}
/**
 * Render one avatar rail.
 * @param props - component props.
 * @returns the rail element.
 */
export declare function FriendAvatarRail({ side, friends, avatars, mapId }: FriendAvatarRailProps): React.JSX.Element;
export {};
//# sourceMappingURL=FriendAvatarRail.d.ts.map