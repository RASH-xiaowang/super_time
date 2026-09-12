import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 通讯录面板 — React 版，忠实迁移 WeChatPanel 的 contacts 页签：分类统计
 * （联系人/群聊/公众号/服务号/企业微信/群成员/系统/已删除）、拼音首字母
 * 分组、搜索、资料卡（群主/群成员数/所在群/签名/类型）、TA的朋友圈、
 * 发消息、复制用户名、CSV 导出。数据经 DSH 后端 Remote（contact.db 完整语义）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LazyMount, ListSentinel, ListSkeleton, useLazySentinel, usePagedList } from "./hooks.js";
import { apiExportCsv, apiGetAvatar, apiGetContact360, apiGetContacts } from "../api.js";
import { useWechatDataUpdated } from "./hooks.js";
import { Drawer, SearchInput, Segmented, Toolbar } from "../ui/kit.js";
import css from './contacts.module.css';
const CATS = [
    { key: 'all', label: '全部' },
    { key: 'friend', label: '联系人' },
    { key: 'group', label: '群聊' },
    { key: 'official', label: '公众号' },
    { key: 'service', label: '服务号' },
    { key: 'enterprise', label: '企业微信' },
    { key: 'member', label: '群成员' },
    { key: 'system', label: '系统' },
    { key: 'deleted', label: '已删除' },
];
function displayName(c) {
    return c.displayName;
}
/** Format a unix timestamp as YYYY-MM-DD HH:MM. */
function fmtTs(ts) {
    if (!ts)
        return '';
    const d = new Date(ts * 1000);
    if (isNaN(d.getTime()))
        return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** 类型标签：优先后端 local_type_label，其次按用户名模式推断。 */
function typeLabel(c) {
    if (c.localTypeLabel)
        return c.localTypeLabel;
    if (c.username.endsWith('@chatroom'))
        return '群聊';
    if (c.username.startsWith('gh_'))
        return '公众号';
    if (c.username.includes('@openim'))
        return '企业微信';
    return '联系人';
}
/** 头像缓存。 */
const avatarCache = new Map();
/**
 * Render the contacts panel.
 * @param props - onNavigate to jump tabs; onOpenChat to open a session;
 *   onOpenMoments to jump to a member's timeline.
 * @returns the contacts element tree.
 */
export function ContactsPanel({ onNavigate, onOpenChat, onOpenMoments }) {
    const [contacts, setContacts] = useState([]);
    const [stats, setStats] = useState({});
    const [total, setTotal] = useState(0);
    const [search, setSearch] = useState('');
    const [cat, setCat] = useState('all');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [profile, setProfile] = useState(null);
    const [profile360, setProfile360] = useState(null);
    const [profile360Loading, setProfile360Loading] = useState(false);
    const [notice, setNotice] = useState(null);
    const [exporting, setExporting] = useState(false);
    const scrollRef = useRef(null);
    const jumpToLetter = useCallback((letter) => {
        scrollRef.current?.querySelector(`[data-letter="${letter}"]`)?.scrollIntoView({ block: 'start' });
    }, []);
    const pager = usePagedList({
        pageSize: 200,
        fetchPage: async (offset, limit) => {
            const env = await apiGetContacts({ limit, offset });
            setStats(env.stats ?? {});
            return { items: env.contacts, total: env.total };
        },
    });
    const searching = search.trim() !== '';
    // 普通浏览：分页逐页加载；搜索时一次性拉全量（用户主动操作），保证跨页搜索结果完整。
    useEffect(() => {
        if (searching) {
            let cancelled = false;
            setLoading(true);
            setError(null);
            void apiGetContacts()
                .then((env) => {
                if (cancelled)
                    return;
                setContacts(env.contacts);
                setStats(env.stats ?? {});
                setTotal(env.total);
            })
                .catch((e) => { if (!cancelled)
                setError(e.message); })
                .finally(() => { if (!cancelled)
                setLoading(false); });
            return () => { cancelled = true; };
        }
        pager.reset();
        return undefined;
    }, [searching, pager.reset]);
    useEffect(() => {
        if (searching)
            return;
        setContacts(pager.items);
        setTotal(pager.total);
        setLoading(pager.loading);
        setError(pager.error);
    }, [searching, pager.items, pager.total, pager.loading, pager.error]);
    const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore)
        pager.loadMore(); }, '600px 0px', () => scrollRef.current);
    // 数据落地后安静刷新（有渲染缓存时不闪整页），使新联系/群名及时可见。
    useWechatDataUpdated(() => { if (!searching)
        pager.reset(); });
    // 打开资料卡时异步拉取跨域社交画像（消息/朋友圈/资金/共同群）。
    useEffect(() => {
        if (!profile) {
            setProfile360(null);
            return;
        }
        let alive = true;
        setProfile360Loading(true);
        void apiGetContact360(profile.username)
            .then((r) => { if (alive)
            setProfile360(r); })
            .catch(() => { })
            .finally(() => { if (alive)
            setProfile360Loading(false); });
        return () => { alive = false; };
    }, [profile]);
    const notify = (text) => {
        setNotice(text);
        setTimeout(() => { setNotice(null); }, 4000);
    };
    const grouped = useMemo(() => {
        const q = search.trim().toLowerCase();
        const filtered = contacts.filter((c) => {
            if (cat !== 'all' && (c.category ?? '') !== cat)
                return false;
            if (!q)
                return true;
            return [displayName(c), c.username, c.alias ?? '', c.remark, c.quanPin ?? ''].some(v => v.toLowerCase().includes(q));
        });
        const map = new Map();
        for (const c of filtered) {
            const k = c.initial || '#';
            const arr = map.get(k) ?? [];
            arr.push(c);
            map.set(k, arr);
        }
        return Array.from(map.entries()).sort((a, b) => (a[0] === '#' ? 1 : b[0] === '#' ? -1 : a[0].localeCompare(b[0])));
    }, [contacts, search, cat]);
    const doExport = async () => {
        setExporting(true);
        try {
            const r = await apiExportCsv({ kind: 'contacts' });
            notify(`已导出 ${r.count} 个联系人 → ${r.path}`);
        }
        catch (e) {
            notify('导出失败: ' + e.message);
        }
        finally {
            setExporting(false);
        }
    };
    const copyUsername = async (c) => {
        try {
            await navigator.clipboard.writeText(c.username);
            notify('已复制用户名 ' + c.username);
        }
        catch {
            notify('复制失败');
        }
    };
    const sendMessage = (c) => {
        if (onOpenChat) {
            onOpenChat(c.username);
            return;
        }
        void copyUsername(c);
        onNavigate?.('chats');
    };
    return (_jsxs("div", { className: css.panel, children: [_jsx(Toolbar, { left: (_jsx(SearchInput, { value: search, onChange: (v) => { setSearch(v); }, placeholder: "\u641C\u7D22\u6635\u79F0 / \u5907\u6CE8 / \u5FAE\u4FE1\u53F7 / \u5168\u62FC", ariaLabel: "\u641C\u7D22\u8054\u7CFB\u4EBA" })), right: (_jsxs(_Fragment, { children: [_jsx(Segmented, { options: CATS.map((c) => {
                                const n = c.key === 'all' ? total : (stats[c.key] ?? 0);
                                return { value: c.key, label: `${c.label}${n > 0 ? ` (${n})` : ''}` };
                            }), value: cat, onChange: (v) => { setCat(v); }, ariaLabel: "\u8054\u7CFB\u4EBA\u5206\u7C7B" }), _jsx("button", { type: "button", className: css.catBtn, onClick: () => { void doExport(); }, disabled: exporting, children: exporting ? '导出中…' : '导出 CSV' })] })) }), notice && _jsx("div", { className: css.notice, children: notice }), _jsx("div", { className: css.indexBar, "aria-hidden": "false", children: grouped.map(([letter]) => (_jsx("button", { type: "button", className: css.indexLetter, onClick: () => { jumpToLetter(letter); }, "aria-label": '跳到字母 ' + letter, children: letter }, letter))) }), _jsxs("div", { className: css.scroll, ref: scrollRef, children: [loading && _jsx(ListSkeleton, { rows: 12 }), error && _jsx("div", { className: css.empty, children: error }), !loading && !error && grouped.length === 0 && _jsx("div", { className: css.empty, children: "\u6682\u65E0\u8054\u7CFB\u4EBA" }), !loading && !error && grouped.map(([letter, list]) => (_jsxs("div", { className: css.group, "data-letter": letter, children: [_jsxs("div", { className: css.letterHd, children: [letter, "\uFF08", list.length, "\uFF09"] }), list.map(c => (_jsx(ContactRowItem, { c: c, onOpen: () => { setProfile(c); } }, c.username)))] }, letter))), !loading && !error && !searching && pager.hasMore && _jsx(ListSentinel, { refFn: loadMoreRef })] }), _jsx(Drawer, { open: profile !== null, onClose: () => { setProfile(null); }, title: profile ? displayName(profile) : '联系人资料', width: 460, children: profile && (_jsxs(_Fragment, { children: [_jsxs("div", { className: css.profileHd, children: [_jsx(ContactAvatar, { c: profile, size: 56 }), _jsxs("div", { className: css.profileNames, children: [_jsx("div", { className: css.profileName, children: displayName(profile) }), _jsx("div", { className: css.profileType, children: typeLabel(profile) })] })] }), _jsxs("div", { className: css.profileRow, children: [_jsx("span", { children: "\u5FAE\u4FE1\u53F7" }), _jsx("code", { children: profile.username })] }), profile.alias && _jsxs("div", { className: css.profileRow, children: [_jsx("span", { children: "\u522B\u540D" }), _jsx("span", { children: profile.alias })] }), profile.remark && _jsxs("div", { className: css.profileRow, children: [_jsx("span", { children: "\u5907\u6CE8" }), _jsx("span", { children: profile.remark })] }), profile.nickName && profile.nickName !== profile.displayName && (_jsxs("div", { className: css.profileRow, children: [_jsx("span", { children: "\u6635\u79F0" }), _jsx("span", { children: profile.nickName })] })), profile.description && _jsxs("div", { className: css.profileRow, children: [_jsx("span", { children: "\u7B7E\u540D" }), _jsx("span", { children: profile.description })] }), profile.memberCount != null && _jsxs("div", { className: css.profileRow, children: [_jsx("span", { children: "\u7FA4\u6210\u5458\u6570" }), _jsxs("span", { children: [profile.memberCount, " \u4EBA"] })] }), profile.owner && _jsxs("div", { className: css.profileRow, children: [_jsx("span", { children: "\u7FA4\u4E3B" }), _jsx("span", { children: profile.owner })] }), profile.groupName && (_jsxs("div", { className: css.profileRow, children: [_jsx("span", { children: "\u6240\u5728\u7FA4" }), _jsx("button", { type: "button", className: css.linkBtn, onClick: () => { setProfile(null); onOpenChat?.(profile.groupUsername ?? ''); }, children: profile.groupName })] })), profile360Loading && _jsxs("div", { className: css.profileRow, children: [_jsx("span", { children: "\u753B\u50CF" }), _jsx("span", { children: "\u7EDF\u8BA1\u4E2D\u2026" })] }), profile360 && (_jsxs(_Fragment, { children: [_jsx("div", { className: css.profileSection, children: "\u793E\u4EA4\u753B\u50CF" }), _jsxs("div", { className: css.profileRow, children: [_jsx("span", { children: "\u6D88\u606F" }), _jsxs("span", { children: [profile360.messages.count.toLocaleString(), " \u6761", profile360.messages.lastTime ? ` · 最近 ${fmtTs(profile360.messages.lastTime)}` : ''] })] }), profile360.messages.firstTime ? (_jsxs("div", { className: css.profileRow, children: [_jsx("span", { children: "\u8BA4\u8BC6" }), _jsx("span", { children: fmtTs(profile360.messages.firstTime) })] })) : null, _jsxs("div", { className: css.profileRow, children: [_jsx("span", { children: "\u670B\u53CB\u5708" }), _jsxs("span", { children: [profile360.moments.count.toLocaleString(), " \u6761"] })] }), _jsxs("div", { className: css.profileRow, children: [_jsx("span", { children: "\u8D44\u91D1\u5F80\u6765" }), _jsxs("span", { children: ["\u8F6C\u8D26 ", profile360.funds.transfers, " \u00B7 \u7EA2\u5305 ", profile360.funds.redpackets] })] }), profile360.commonGroups.length > 0 && (_jsxs("div", { className: css.profileRow, children: [_jsx("span", { children: "\u5171\u540C\u7FA4" }), _jsx("span", { className: css.commonGroups, children: profile360.commonGroups.map(g => (_jsxs("button", { type: "button", className: css.groupChip, onClick: () => { setProfile(null); onOpenChat?.(g.username); }, title: `${g.name} · ${g.memberCount} 人`, children: [g.name, " (", g.memberCount, ")"] }, g.username))) })] }))] })), _jsxs("div", { className: css.profileActions, children: [_jsx("button", { type: "button", className: css.catBtn, onClick: () => { void copyUsername(profile); }, children: "\u590D\u5236\u7528\u6237\u540D" }), onOpenMoments && _jsx("button", { type: "button", className: css.catBtn, onClick: () => { setProfile(null); onOpenMoments(profile.username); }, children: "TA \u7684\u670B\u53CB\u5708" }), _jsx("button", { type: "button", className: css.catBtn, onClick: () => { setProfile(null); sendMessage(profile); }, children: "\u53D1\u6D88\u606F" })] })] })) })] }));
}
/** 联系人行（含懒加载头像）。 */
function ContactRowItem({ c, onOpen }) {
    return (_jsxs("div", { className: css.contactItem, onClick: onOpen, role: "button", children: [_jsx(LazyMount, { placeholder: _jsx("div", { className: css.avatar, style: { width: 36, height: 36 }, children: "\u2026" }), rootMargin: "400px 0px", children: _jsx(ContactAvatar, { c: c, size: 36 }) }), _jsxs("div", { className: css.contactInfo, children: [_jsx("span", { className: css.contactName, children: displayName(c) }), _jsxs("span", { className: css.contactMeta, children: [typeLabel(c), c.groupName ? ` · ${c.groupName}` : ''] })] })] }, c.username));
}
/** 联系人头像（head_image 数据 / 远程 URL / 首字母占位）。 */
function ContactAvatar({ c, size }) {
    const key = c.username || displayName(c) || '';
    const [src, setSrc] = useState(null);
    useEffect(() => {
        let cancelled = false;
        if (!key)
            return;
        // 优先后端解析的远程头像 URL
        if (c.avatarUrl) {
            setSrc(c.avatarUrl);
            return;
        }
        const cached = avatarCache.get(key);
        if (cached !== undefined) {
            setSrc(cached);
            return;
        }
        apiGetAvatar({ username: key })
            .then((r) => {
            const v = r.kind === 'data' ? (r.data ?? null) : r.kind === 'url' ? (r.url ?? null) : null;
            avatarCache.set(key, v);
            if (!cancelled)
                setSrc(v);
        })
            .catch(() => { avatarCache.set(key, null); if (!cancelled)
            setSrc(null); });
        return () => { cancelled = true; };
    }, [key, c.avatarUrl]);
    if (src) {
        return _jsx("img", { src: src, alt: "", className: css.avatarImg, width: size, height: size, style: { borderRadius: 8 }, loading: "lazy" });
    }
    const letter = displayName(c).slice(0, 1).toUpperCase();
    const hue = (c.username || '').split('').reduce((a, ch) => a + ch.charCodeAt(0), 0) % 360;
    return _jsx("div", { className: css.avatar, style: { width: size, height: size, background: `hsl(${hue} 45% 55%)` }, children: letter });
}
//# sourceMappingURL=Contacts.js.map