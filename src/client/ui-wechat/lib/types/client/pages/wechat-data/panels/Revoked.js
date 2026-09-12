import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 撤回记录面板 — React 版，忠实迁移 RevokedMessages.svelte：只读展示被撤回
 * 消息（sender / type_label / content / create_time），类型构成 + 发送者
 * Top5 统计 + 可展开内容列表 + 隐私横幅。走 Remote（getRevoked）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useProgressiveList } from "./hooks.js";
import { apiGetRevoked } from "../api.js";
import { Badge, Card, PanelHeader, SearchInput, Segmented, Toolbar } from "../ui/kit.js";
import css from './list-panel.module.css';
function fmtTime(ts) {
    if (!ts)
        return '--';
    const d = new Date(ts * 1000);
    if (isNaN(d.getTime()))
        return '--';
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** 发送者头像首字 + 由名字派生的颜色。 */
function colorFromName(name) {
    let h = 0;
    for (const ch of name)
        h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 45% 55%)`;
}
/**
 * Render the revoked-messages panel.
 * @returns the revoked element tree.
 */
export function RevokedPanel() {
    const [items, setItems] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [expanded, setExpanded] = useState(new Set());
    const [search, setSearch] = useState('');
    const [typeFilter, setTypeFilter] = useState(null);
    const pager = usePagedList({
        pageSize: 100,
        fetchPage: async (offset, limit) => {
            const env = await apiGetRevoked({ limit, offset });
            return { items: env.items, total: env.total };
        },
    });
    const searching = search.trim() !== '';
    // 普通浏览：分页逐页加载；搜索/类型筛选时一次性拉取 500 条（用户主动操作），保证结果完整。
    useEffect(() => {
        if (searching || typeFilter) {
            let cancelled = false;
            setLoading(true);
            setError(null);
            void apiGetRevoked({ limit: 500 })
                .then((env) => {
                if (cancelled)
                    return;
                setItems(env.items);
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
    }, [searching, typeFilter, pager.reset]);
    useEffect(() => {
        if (searching || typeFilter)
            return;
        setItems(pager.items);
        setTotal(pager.total);
        setLoading(pager.loading);
        setError(pager.error);
    }, [searching, typeFilter, pager.items, pager.total, pager.loading, pager.error]);
    const refresh = useCallback(() => {
        setError(null);
        if (searching || typeFilter) {
            setLoading(true);
            void apiGetRevoked({ limit: 500 })
                .then((env) => { setItems(env.items); setTotal(env.total); })
                .catch((e) => { setError(e.message); })
                .finally(() => { setLoading(false); });
        }
        else {
            pager.reset();
        }
    }, [searching, typeFilter, pager.reset]);
    const revokedScrollRef = useRef(null);
    const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore)
        pager.loadMore(); }, '600px 0px', () => revokedScrollRef.current);
    const typeCounts = useMemo(() => {
        const m = new Map();
        for (const it of items) {
            const k = it.type_label || '未知';
            m.set(k, (m.get(k) ?? 0) + 1);
        }
        return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
    }, [items]);
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return items.filter((it) => {
            if (typeFilter && (it.type_label || '未知') !== typeFilter)
                return false;
            if (!q)
                return true;
            return (it.sender || '').toLowerCase().includes(q) || (it.content || '').toLowerCase().includes(q);
        });
    }, [items, search, typeFilter]);
    const senderTop = useMemo(() => {
        const m = new Map();
        for (const it of items) {
            const k = it.sender || '未知';
            m.set(k, (m.get(k) ?? 0) + 1);
        }
        return Array.from(m.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5);
    }, [items]);
    const toggle = (idx) => {
        const next = new Set(expanded);
        if (next.has(idx))
            next.delete(idx);
        else
            next.add(idx);
        setExpanded(next);
    };
    const { count: rvCount, sentinelRef: rvSentinel } = useProgressiveList(filtered.length, 80);
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u64A4\u56DE\u6D88\u606F\u8BB0\u5F55", desc: "\u5FAE\u4FE1 4.x \u9632\u64A4\u56DE\u673A\u5236\u5728\u672C\u673A\u4FDD\u7559\u7684\u5220\u9664\u7F13\u5B58 \u00B7 \u53EA\u8BFB\u5C55\u793A", actions: (_jsx("button", { type: "button", className: css.catBtn, onClick: refresh, disabled: loading, children: loading ? '读取中…' : '刷新' })) }), _jsx("div", { className: css.notice, style: { color: 'var(--wc-muted)' }, children: "\uD83D\uDEE1\uFE0F \u6570\u636E\u4EC5\u6765\u81EA\u672C\u673A\u5FAE\u4FE1\u6570\u636E\u5E93\u7684\u89E3\u5BC6\u526F\u672C\uFF0C\u4E0D\u8054\u7F51\u3001\u4E0D\u4E0A\u4F20\u3002\u7F13\u5B58\u5185\u5BB9\u4E0E\u64A4\u56DE\u65F6\u95F4\u7531\u5FAE\u4FE1\u5BA2\u6237\u7AEF\u5199\u5165\u3002" }), error && _jsxs("div", { className: css.empty, children: ["\u26A0\uFE0F ", error] }), !error && loading && items.length === 0 && _jsx(ListSkeleton, { rows: 8 }), !error && !loading && items.length === 0 && (_jsxs("div", { className: css.empty, children: [_jsx("p", { children: "\u6682\u65E0\u64A4\u56DE\u6D88\u606F\u8BB0\u5F55" }), _jsx("p", { className: css.hdCount, children: "\u5FAE\u4FE1\u5BA2\u6237\u7AEF\u672A\u4FDD\u7559\u9632\u64A4\u56DE\u7F13\u5B58\uFF0C\u6216\u89E3\u5BC6\u5E93\u5C1A\u672A\u540C\u6B65\u6700\u65B0\u6570\u636E" })] })), !error && items.length > 0 && (_jsxs(_Fragment, { children: [_jsx(Toolbar, { left: (_jsx(SearchInput, { value: search, onChange: (v) => { setSearch(v); }, placeholder: "\u641C\u7D22\u53D1\u9001\u8005 / \u5185\u5BB9\u2026", ariaLabel: "\u641C\u7D22\u64A4\u56DE\u8BB0\u5F55" })), right: typeCounts.length > 0 ? (_jsx(Segmented, { options: [{ value: '__all__', label: '全部' }, ...typeCounts.map(([k, n]) => ({ value: k, label: `${k} (${n})` }))], value: typeFilter ?? '__all__', onChange: (v) => { setTypeFilter(v === '__all__' ? null : v); }, ariaLabel: "\u7C7B\u578B\u7B5B\u9009" })) : undefined }), _jsx("div", { className: css.hd, children: _jsxs("span", { className: css.hdCount, children: ["\u5171 ", total, " \u6761\u88AB\u64A4\u56DE\u6D88\u606F\uFF08\u5DF2\u52A0\u8F7D ", items.length, "\uFF09"] }) }), senderTop.length > 0 && (_jsx(Card, { title: "\u64A4\u56DE\u6700\u591A", children: _jsx("div", { style: { display: 'flex', flexWrap: 'wrap', gap: 8 }, children: senderTop.map(([k, n]) => _jsxs(Badge, { tone: "cyan", title: `${k} 撤回 ${n} 条`, children: [k, " ", n] }, k)) }) })), _jsxs("div", { ref: revokedScrollRef, className: css.scroll, style: { padding: 6 }, children: [filtered.length === 0 && _jsx("div", { className: css.empty, children: "\u65E0\u5339\u914D\u8BB0\u5F55" }), filtered.slice(0, rvCount).map((it, idx) => {
                                const open = expanded.has(idx);
                                return (_jsxs("div", { className: css.row, style: { flexDirection: 'column', cursor: 'pointer', border: '1px solid var(--wc-border)', marginBottom: 6 }, onClick: () => { toggle(idx); }, role: "button", children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 10 }, children: [_jsx("span", { style: { width: 28, height: 28, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#fff', background: colorFromName(it.sender) }, children: (it.sender || '?').slice(0, 1) }), _jsx("span", { className: css.rowName, children: it.sender }), _jsx("span", { className: css.cite, style: { color: 'var(--wc-accent)', border: '1px solid var(--wc-accent)' }, children: it.type_label }), _jsx("span", { className: css.rowTime, style: { marginLeft: 'auto' }, children: fmtTime(it.create_time) }), _jsx("span", { className: css.rowTime, children: open ? '▾' : '▸' })] }), open && (_jsxs("div", { style: { padding: '4px 4px 6px 38px' }, children: [_jsx("div", { style: { fontSize: 13, lineHeight: 1.7, whiteSpace: 'pre-wrap', wordBreak: 'break-word', padding: '10px 12px', borderRadius: 8, background: 'var(--wc-muted-bg)' }, children: it.content }), _jsx("div", { className: css.rowMeta, style: { marginTop: 4 }, children: "\u2191 \u8BE5\u5185\u5BB9\u5728\u5FAE\u4FE1\u5BA2\u6237\u7AEF\u88AB\u64A4\u56DE\uFF0C\u6B64\u5904\u4E3A\u672C\u5730\u7F13\u5B58\u526F\u672C" })] }))] }, `${it.create_time}-${idx}`));
                            }), filtered.length > rvCount && _jsx(ListSentinel, { refFn: rvSentinel }), !searching && !typeFilter && pager.hasMore && _jsx(ListSentinel, { refFn: loadMoreRef })] })] }))] }));
}
//# sourceMappingURL=Revoked.js.map