import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 表情面板 — React 版，忠实迁移 WeChatPanel 的 emoticons 页签：自定义表情 /
 * 表情包 分类标签 + 网格（点击复制 MD5），搜索按名称/MD5 过滤。走 Remote
 * （getEmoticons），无 HTTP 依赖。
 */
import { useEffect, useMemo, useState } from 'react';
import { ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useProgressiveList } from "./hooks.js";
import { apiGetEmoticons } from "../api.js";
import { PanelHeader, SearchInput, Segmented, Toolbar } from "../ui/kit.js";
import css from './list-panel.module.css';
/** 表情类型 → 中文标签（1=图片 2=GIF 3=动图）。 */
function typeLabel(t) {
    if (t === 1)
        return '图片';
    if (t === 2)
        return 'GIF';
    if (t === 3)
        return '动图';
    return '';
}
/**
 * Render the emoticons panel.
 * @returns the emoticons element tree.
 */
export function EmoticonsPanel() {
    const [custom, setCustom] = useState([]);
    const [packages, setPackages] = useState([]);
    const [total, setTotal] = useState(0);
    const [tab, setTab] = useState('all');
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const pager = usePagedList({
        pageSize: 200,
        fetchPage: async (offset, limit) => {
            const env = await apiGetEmoticons({ limit, offset });
            setPackages(env.packages);
            setTotal(env.total);
            return { items: env.custom, total: env.total };
        },
    });
    const searching = search.trim() !== '';
    // 普通浏览：分页逐页加载；搜索时一次性拉取 2000 条（用户主动操作），保证跨页搜索结果完整。
    useEffect(() => {
        if (searching) {
            let cancelled = false;
            setLoading(true);
            setError(null);
            void apiGetEmoticons({ limit: 2000 })
                .then((env) => {
                if (cancelled)
                    return;
                setCustom(env.custom);
                setPackages(env.packages);
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
        setCustom(pager.items);
        setTotal(pager.total);
        setLoading(pager.loading);
        setError(pager.error);
    }, [searching, pager.items, pager.total, pager.loading, pager.error]);
    const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore)
        pager.loadMore(); });
    const notify = (text) => {
        setNotice(text);
        setTimeout(() => { setNotice(null); }, 3000);
    };
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (!q)
            return custom;
        return custom.filter(e => e.md5.toLowerCase().includes(q) || (e.caption ?? '').toLowerCase().includes(q));
    }, [custom, search]);
    const shownCustom = tab === 'all' || tab === 'custom' ? filtered : [];
    const { count: emoCount, sentinelRef: emoSentinel } = useProgressiveList(shownCustom.length, 150);
    const { count: pkgCount, sentinelRef: pkgSentinel } = useProgressiveList(tab === 'packages' ? packages.length : 0, 150);
    const copyMd5 = (md5) => {
        void navigator.clipboard.writeText(md5).then(() => { notify('已复制 MD5: ' + md5.slice(0, 8) + '…'); }).catch(() => { notify('复制失败'); });
    };
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u8868\u60C5", desc: `自定义 ${custom.length} · 表情包 ${packages.length} · 共 ${total}` }), _jsx(Toolbar, { left: (_jsx(SearchInput, { value: search, onChange: (v) => { setSearch(v); }, placeholder: "\u641C\u7D22\u8868\u60C5\u5305\u540D\u79F0 / \u8868\u60C5 MD5", ariaLabel: "\u641C\u7D22\u8868\u60C5" })), right: (_jsx(Segmented, { options: [
                        { value: 'all', label: `全部 (${custom.length + packages.length})` },
                        { value: 'custom', label: `自定义 (${custom.length})` },
                        { value: 'packages', label: `表情包 (${packages.length})` },
                    ], value: tab, onChange: (v) => { setTab(v); }, ariaLabel: "\u8868\u60C5\u5206\u7C7B" })) }), notice && _jsx("div", { className: css.notice, children: notice }), _jsxs("div", { className: css.grid, children: [loading && _jsx(ListSkeleton, { rows: 10, grid: true }), error && _jsxs("div", { className: css.empty, children: ["\u26A0\uFE0F \u8868\u60C5\u6570\u636E\u52A0\u8F7D\u5931\u8D25\uFF08", error, "\uFF09"] }), !loading && !error && tab !== 'packages' && shownCustom.length === 0 && _jsxs("div", { className: css.empty, children: ["\u6682\u65E0", tab === 'custom' ? '自定义' : '', "\u8868\u60C5"] }), !loading && !error && tab !== 'packages' && shownCustom.slice(0, emoCount).map((e) => (_jsxs("div", { className: css.emoCell, title: `${e.md5}${e.caption ? ` · ${e.caption}` : ''}${typeLabel(e.item_type) ? ` · ${typeLabel(e.item_type)}` : ''}`, onClick: () => { copyMd5(e.md5); }, children: [_jsx("span", { className: css.emoName, children: e.caption || '自定义表情' }), _jsxs("span", { className: css.emoMd5, children: ["MD5 \u00B7 ", e.md5.slice(0, 8)] }), _jsx("span", { className: css.emoPh, children: "\uD83D\uDE00" }), _jsx("span", { className: css.emoMd5, style: { color: 'var(--wc-accent)' }, children: "\u70B9\u51FB\u590D\u5236 MD5" })] }, e.md5))), !loading && !error && tab !== 'packages' && shownCustom.length > emoCount && _jsx(ListSentinel, { refFn: emoSentinel }), !loading && !error && tab !== 'packages' && !searching && pager.hasMore && _jsx(ListSentinel, { refFn: loadMoreRef }), !loading && !error && tab === 'packages' && packages.length === 0 && _jsx("div", { className: css.empty, children: "\u6682\u65E0\u8868\u60C5\u5305" }), !loading && !error && tab === 'packages' && packages.slice(0, pkgCount).map(p => (_jsxs("div", { className: css.fileCell, title: p.name, children: [_jsx("span", { className: css.fileIcon, children: "\uD83D\uDCE6" }), _jsx("span", { className: css.fileName, children: p.name }), _jsxs("span", { className: css.fileMeta, children: [p.count, " \u4E2A\u8868\u60C5"] })] }, p.name))), !loading && !error && tab === 'packages' && packages.length > pkgCount && _jsx(ListSentinel, { refFn: pkgSentinel })] })] }));
}
//# sourceMappingURL=Emoticons.js.map