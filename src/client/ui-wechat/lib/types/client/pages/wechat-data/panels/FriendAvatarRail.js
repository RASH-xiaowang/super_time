import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import css from './world-map.module.css';
/**
 * Render one avatar rail.
 * @param props - component props.
 * @returns the rail element.
 */
export function FriendAvatarRail({ side, friends, avatars, mapId }) {
    const cls = side === 'left' ? css.avatarRailLeft : css.avatarRailRight;
    return (_jsx("div", { className: cls, "data-side": side, role: "list", "aria-label": `${side === 'left' ? '左侧' : '右侧'}联系人头像`, "aria-owns": mapId, children: friends.map((f) => {
            const src = avatars[f.username] || f.avatarUrl;
            const name = f.displayName || f.remark || f.nickName || f.username;
            return (_jsxs("div", { className: css.avatarItem, role: "listitem", title: `${name}\n${f.username}`, children: [_jsx("span", { className: css.avatarWrap, children: src ? (_jsx("img", { className: css.avatar, src: src, alt: "" })) : (_jsx("span", { className: css.avatarFallback, children: name.slice(0, 1) })) }), _jsx("span", { className: css.friendLabel, children: name })] }, f.username));
        }) }));
}
//# sourceMappingURL=FriendAvatarRail.js.map