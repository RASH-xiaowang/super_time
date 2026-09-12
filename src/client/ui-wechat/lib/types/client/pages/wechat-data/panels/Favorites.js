import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 收藏面板 — React 版：列表 + 搜索 + 类型分类 + 多选删除 + 导出 + 详情。
 * 后端已解析时直接用后端字段；后端字段缺失时客户端完整兜底解析 XML，
 * 保证不显示原始 XML / undefined。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useProgressiveList } from "./hooks.js";
import { apiDeleteFavoriteItems, apiExportCsv, apiGetFavorites, apiGetSnsImageDataUrl } from "../api.js";
import { Dialog, PanelHeader, SearchInput, Segmented, Toolbar } from "../ui/kit.js";
import css from './list-panel.module.css';
/** 收藏类型 → 中文标签（微信 fav type）。 */
function favTypeLabel(type) {
    switch (type) {
        case 1: return '文本';
        case 2: return '图片';
        case 3: return '语音';
        case 4: return '视频';
        case 5: return '链接';
        case 6: return '位置';
        case 7: return '音乐';
        case 8: return '文件';
        case 14: return '聊天记录';
        case 16: return '商品';
        case 18: return '笔记';
        case 19: return '小程序';
        case 20: return '视频号';
        default: return '其他';
    }
}
/** Unescape XML/HTML entities (keep newlines). */
function decodeFavText(s) {
    return s
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#x0A;/gi, '\n')
        .replace(/&#10;/g, '\n');
}
/** Extract text between <tag ...> and </tag> (first occurrence). */
function xmlTagText(xml, tag) {
    const openExact = '<' + tag + '>';
    const openAttr = '<' + tag + ' ';
    const start = xml.indexOf(openExact) >= 0 ? xml.indexOf(openExact) : xml.indexOf(openAttr);
    if (start < 0)
        return null;
    const contentStart = xml.startsWith(openExact, start) ? start + openExact.length : (xml.indexOf('>', start) + 1);
    const close = xml.indexOf('</' + tag + '>', contentStart);
    if (close < 0)
        return null;
    return xml.slice(contentStart, close);
}
/** Extract an attribute value from a tag open (first occurrence). */
function xmlTagAttr(xml, tag, attr) {
    const openExact = '<' + tag + '>';
    const openAttr = '<' + tag + ' ';
    const start = xml.indexOf(openExact) >= 0 ? xml.indexOf(openExact) : xml.indexOf(openAttr);
    if (start < 0)
        return null;
    const tagStr = xml.slice(start, xml.indexOf('>', start));
    const search = attr + '="';
    const a = tagStr.indexOf(search);
    if (a < 0)
        return null;
    const v = a + search.length;
    const e = tagStr.indexOf('"', v);
    if (e < 0)
        return null;
    return tagStr.slice(v, e);
}
/** 客户端兜底解析收藏 XML 的标题/描述/来源。 */
function parseFavXml(content) {
    if (!content || !content.includes('<'))
        return { title: '', desc: content || '', fromUsr: '', srcName: '' };
    const title = (content.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    const raw = (content.match(/<desc>([\s\S]*?)<\/desc>/) || [])[1] || '';
    const fromUsr = (content.match(/<fromusr>([^<]*)<\/fromusr>/) || [])[1] || '';
    const srcName = (content.match(/<datasrcname>([^<]*)<\/datasrcname>/) || [])[1] || '';
    return { title, desc: decodeFavText(raw), fromUsr, srcName };
}
/** 客户端兜底解析 `<datalist><dataitem>` 资源条目。 */
function parseFavParts(content) {
    if (!content || !content.includes('<dataitem'))
        return [];
    const out = [];
    let pos = 0;
    for (;;) {
        const start = content.indexOf('<dataitem', pos);
        if (start < 0)
            break;
        const end = content.indexOf('</dataitem>', start);
        const body = end >= 0 ? content.slice(start, end) : content.slice(start);
        const datatype = Number.parseInt(xmlTagAttr(body, 'dataitem', 'datatype') ?? '0', 10) || 0;
        const dataid = (xmlTagAttr(body, 'dataitem', 'dataid') ?? '').trim().toLowerCase();
        const fullmd5 = (xmlTagText(body, 'fullmd5') ?? '').trim().toLowerCase();
        const thumbmd5 = (xmlTagText(body, 'thumbfullmd5') ?? '').trim().toLowerCase();
        const text = decodeFavText(xmlTagText(body, 'datadesc') ?? '') || decodeFavText(xmlTagText(body, 'datatitle') ?? '');
        const sourceName = xmlTagText(body, 'datasrcname') ?? '';
        const sourceTime = xmlTagText(body, 'datasrctime') ?? '';
        const base = () => {
            const p = { kind: 'text' };
            if (sourceName)
                p.sourceName = sourceName;
            if (sourceTime)
                p.sourceTime = sourceTime;
            return p;
        };
        if (datatype === 1) {
            if (text) {
                const p = base();
                p.text = text;
                out.push(p);
            }
        }
        else if (datatype === 2) {
            const p = base();
            p.kind = 'image';
            const m = thumbmd5 || fullmd5 || dataid;
            if (m)
                p.md5 = m;
            if (text)
                p.text = text;
            out.push(p);
        }
        else if (datatype === 3) {
            const p = base();
            p.kind = 'voice';
            const m = fullmd5 || dataid;
            if (m)
                p.md5 = m;
            out.push(p);
        }
        else if (datatype === 4) {
            const p = base();
            p.kind = 'video';
            const m = fullmd5 || dataid;
            if (m)
                p.md5 = m;
            const dur = Number.parseFloat(xmlTagText(body, 'duration') ?? '0');
            if (dur > 0)
                p.duration = dur;
            out.push(p);
        }
        else if (datatype === 5 || datatype === 19 || datatype === 36) {
            const p = base();
            p.kind = 'link';
            if (text)
                p.text = text;
            const u = (xmlTagText(body, 'stream_weburl') ?? xmlTagText(body, 'url') ?? '').replace(/&amp;/g, '&');
            if (u)
                p.url = u;
            out.push(p);
        }
        else if (datatype === 8) {
            const p = base();
            p.kind = 'file';
            const n = xmlTagText(body, 'datatitle') ?? '';
            if (n)
                p.name = n;
            const e = xmlTagText(body, 'datafmt') ?? '';
            if (e)
                p.ext = e;
            const sz = Number.parseInt(xmlTagText(body, 'fullsize') ?? '0', 10);
            if (sz > 0)
                p.size = sz;
            out.push(p);
        }
        pos = end >= 0 ? end + 10 : content.length;
    }
    return out;
}
/** Format a unix timestamp as `YYYY-MM-DD HH:mm`. */
function fmtDateTime(ts) {
    if (!ts)
        return '';
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** 规范化一条收藏：后端字段优先，缺失时客户端兜底解析。 */
function parseFavItem(f) {
    const info = parseFavXml(f.content);
    const typeLabel = f.typeLabel || favTypeLabel(f.type);
    const items = f.items ?? parseFavParts(f.content);
    const source = f.source || f.chatName || info.srcName || info.fromUsr || f.fromUsr || '';
    const time = f.time || fmtDateTime(f.updateTime);
    return {
        title: f.title || info.title || typeLabel,
        desc: f.desc || info.desc || '',
        url: f.url || '',
        source,
        time,
        typeLabel,
        items,
    };
}
/**
 * Render the favorites panel.
 * @returns the favorites element tree.
 */
export function FavoritesPanel() {
    const [items, setItems] = useState([]);
    const [total, setTotal] = useState(0);
    const [search, setSearch] = useState('');
    const [type, setType] = useState('all');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [selectMode, setSelectMode] = useState(false);
    const [selected, setSelected] = useState(new Set());
    const [notice, setNotice] = useState(null);
    const [exporting, setExporting] = useState(false);
    const [detail, setDetail] = useState(null);
    const [favImgs, setFavImgs] = useState({});
    const favImgFetched = useRef(new Set());
    const scrollRef = useRef(null);
    const filtered = useMemo(() => {
        const q = search.trim().toLowerCase();
        return items.filter((f) => {
            if (type !== 'all' && String(f.type) !== type)
                return false;
            if (!q)
                return true;
            const info = parseFavItem(f);
            return [info.title, info.desc, info.source, f.content, f.fromUsr, f.chatName].some(v => v.toLowerCase().includes(q));
        });
    }, [items, search, type]);
    const { count: favCount, sentinelRef: favSentinel } = useProgressiveList(filtered.length, 120);
    const notify = (text) => {
        setNotice(text);
        setTimeout(() => { setNotice(null); }, 4000);
    };
    const pager = usePagedList({
        pageSize: 120,
        fetchPage: async (offset, limit) => {
            const env = await apiGetFavorites({ limit, offset });
            return { items: env.favorites, total: env.total };
        },
    });
    const searching = search.trim() !== '';
    // 普通浏览：分页逐页加载；搜索时一次性拉取 500 条（用户主动操作），保证跨页搜索结果完整。
    useEffect(() => {
        if (searching) {
            let cancelled = false;
            setLoading(true);
            setError(null);
            void apiGetFavorites({ limit: 500 })
                .then((env) => {
                if (cancelled)
                    return;
                setItems(env.favorites);
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
        setItems(pager.items);
        setTotal(pager.total);
        setLoading(pager.loading);
        setError(pager.error);
    }, [searching, pager.items, pager.total, pager.loading, pager.error]);
    const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore)
        pager.loadMore(); }, '600px 0px', () => scrollRef.current);
    // 收藏内图片离线解析（懒加载）：仅当卡片接近视口时才解码对应媒体，避免一次性
    // 解码大量收藏图片导致卡顿；已取到的用 favImgs 缓存，不会重复请求。
    const decodeFavImg = useCallback((md5) => {
        if (!md5 || favImgFetched.current.has(md5))
            return;
        favImgFetched.current.add(md5);
        void apiGetSnsImageDataUrl({ md5 })
            .then((r) => { if (r.url)
            setFavImgs(prev => ({ ...prev, [md5]: r.url })); })
            .catch(() => { });
    }, []);
    useEffect(() => {
        const root = scrollRef.current;
        if (!root || filtered.length === 0)
            return;
        const md5ByKey = new Map();
        for (const f of filtered.slice(0, favCount)) {
            const it = parseFavItem(f).items.find(p => p.kind === 'image' && p.md5);
            if (it?.md5)
                md5ByKey.set(String(f.localId), it.md5);
        }
        if (typeof IntersectionObserver === 'undefined') {
            // 无 IO 支持时兜底解码当前渲染卡片，保证图片可见。
            for (const md5 of md5ByKey.values())
                decodeFavImg(md5);
            return;
        }
        const ob = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (!e.isIntersecting)
                    continue;
                const key = e.target.dataset.mediaKey || '';
                const md5 = md5ByKey.get(key);
                if (md5)
                    decodeFavImg(md5);
            }
        }, { root, rootMargin: '500px 0px' });
        root.querySelectorAll('[data-media-key]').forEach((el) => { ob.observe(el); });
        return () => { ob.disconnect(); };
    }, [filtered, favCount, decodeFavImg]);
    // 打开收藏详情时按需解码该条目的图片（点 3c：详情查看时才读取）。
    useEffect(() => {
        if (!detail)
            return;
        const d = parseFavItem(detail);
        for (const it of d.items)
            if (it.kind === 'image' && it.md5)
                decodeFavImg(it.md5);
    }, [detail, decodeFavImg]);
    const types = useMemo(() => {
        const map = new Map();
        for (const f of items) {
            const key = String(f.type);
            const cur = map.get(key);
            if (cur)
                cur.count += 1;
            else
                map.set(key, { label: f.typeLabel || favTypeLabel(f.type), count: 1 });
        }
        return Array.from(map.entries()).map(([type, v]) => ({ type, label: v.label, count: v.count }));
    }, [items]);
    const doExport = async () => {
        setExporting(true);
        try {
            const r = await apiExportCsv({ kind: 'favorites' });
            notify(`已导出 ${r.count} 项收藏 → ${r.path}`);
        }
        catch (e) {
            notify('导出失败: ' + e.message);
        }
        finally {
            setExporting(false);
        }
    };
    const doDelete = async () => {
        const ids = [...selected];
        if (ids.length === 0)
            return;
        if (!window.confirm(`删除所选 ${ids.length} 项收藏（本地副本）？`))
            return;
        try {
            const r = await apiDeleteFavoriteItems({ ids });
            notify(`已删除 ${r.deleted} 项收藏`);
            if (searching) {
                const env = await apiGetFavorites({ limit: 500 });
                setItems(env.favorites);
                setTotal(env.total);
            }
            else {
                pager.reset();
            }
            setSelected(new Set());
            setSelectMode(false);
        }
        catch (e) {
            notify('删除失败: ' + e.message);
        }
    };
    const toggleSelect = (id) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    };
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u6536\u85CF", desc: `${filtered.length} 项 · 共 ${total}`, actions: (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: css.catBtn, "data-active": selectMode || undefined, onClick: () => { setSelectMode(v => !v); setSelected(new Set()); }, children: selectMode ? '退出批量' : '批量' }), _jsx("button", { type: "button", className: css.catBtn, onClick: () => { void doExport(); }, disabled: exporting, children: exporting ? '导出中…' : '导出' }), selectMode && _jsxs("button", { type: "button", className: css.catBtn, "data-active": "true", onClick: () => { void doDelete(); }, disabled: selected.size === 0, children: ["\u5220\u9664\u6240\u9009 (", selected.size, ")"] })] })) }), _jsx(Toolbar, { left: (_jsx(SearchInput, { value: search, onChange: (v) => { setSearch(v); }, placeholder: "\u641C\u7D22\u6807\u9898 / \u63CF\u8FF0 / \u6765\u6E90", ariaLabel: "\u641C\u7D22\u6536\u85CF" })), right: (_jsx(Segmented, { options: [{ value: 'all', label: `全部 (${items.length})` }, ...types.map(t => ({ value: t.type, label: `${t.label} (${t.count})` }))], value: type, onChange: (v) => { setType(v); }, ariaLabel: "\u6536\u85CF\u5206\u7C7B" })) }), notice && _jsx("div", { className: css.notice, children: notice }), _jsxs("div", { className: css.scroll, ref: scrollRef, children: [loading && _jsx(ListSkeleton, { rows: 8 }), error && _jsxs("div", { className: css.empty, children: ["\u26A0\uFE0F \u6536\u85CF\u6570\u636E\u63A5\u53E3\u5C1A\u672A\u5C31\u7EEA\uFF08", error, "\uFF09"] }), !loading && !error && filtered.length === 0 && _jsx("div", { className: css.empty, children: search || type !== 'all' ? '无匹配收藏' : '暂无收藏' }), !loading && !error && filtered.slice(0, favCount).map((f) => {
                        const info = parseFavItem(f);
                        const preview = info.items.length > 0 ? info.items.filter(p => p.kind === 'text').map(p => p.text || '').join('\n') : info.desc;
                        const cardImg = info.items.find(it => it.kind === 'image' && it.md5);
                        const imgPart = info.items.find(it => it.kind === 'image' && it.md5 && favImgs[it.md5]);
                        return (_jsxs("div", { className: css.favCard, onClick: () => { if (selectMode)
                                toggleSelect(f.localId);
                            else
                                setDetail(f); }, "data-media-key": cardImg?.md5 ? String(f.localId) : undefined, children: [selectMode && (_jsx("span", { className: css.batchCheck, "data-checked": selected.has(f.localId) || undefined, children: selected.has(f.localId) ? '✓' : '' })), _jsxs("div", { className: css.favCardBody, children: [_jsx("div", { className: css.favCardTitle, children: info.title }), preview && _jsx("div", { className: css.favCardDesc, children: preview }), _jsx("div", { className: css.favCardMeta, children: info.typeLabel + (info.source ? ' · ' + info.source : '') + ' · ' + info.time })] }), imgPart && _jsx("img", { className: css.favCardThumb, src: favImgs[imgPart.md5 ?? ''], alt: "", loading: "lazy", referrerPolicy: "no-referrer" })] }, f.localId));
                    }), !loading && !error && filtered.length > favCount && _jsx(ListSentinel, { refFn: favSentinel }), !loading && !error && !searching && pager.hasMore && _jsx(ListSentinel, { refFn: loadMoreRef })] }), _jsx(Dialog, { open: detail !== null, onClose: () => { setDetail(null); }, title: detail ? parseFavItem(detail).title : '收藏详情', children: detail && (() => {
                    const d = parseFavItem(detail);
                    return (_jsxs("div", { className: css.formBody, children: [_jsx("div", { className: css.favDetailMeta, children: d.typeLabel + (d.source ? ' · ' + d.source : '') + ' · ' + d.time }), _jsx("div", { className: css.favDetail, children: d.items.length > 0 ? d.items.map((it, idx) => (_jsxs("div", { className: css.favPart, children: [(it.sourceName || it.sourceTime) && _jsx("div", { className: css.favPartMeta, children: [it.sourceName, it.sourceTime].filter(Boolean).join(' · ') }), it.kind === 'image' ? ((it.md5 && favImgs[it.md5]) ? _jsx("img", { className: css.favPartImg, src: favImgs[it.md5], alt: "", loading: "lazy", referrerPolicy: "no-referrer" }) : _jsx("div", { className: css.favPartPh, children: "[\u56FE\u7247]" })) : it.kind === 'link' ? (it.url ? _jsx("a", { className: css.favPartText, href: it.url, target: "_blank", rel: "noopener noreferrer", children: it.text || it.url }) : _jsx("div", { className: css.favPartText, children: it.text || '[链接]' })) : it.kind === 'file' ? (_jsxs("div", { className: css.favPartText, children: [it.name || '[文件]', it.ext ? ' (' + it.ext + ')' : '', it.size ? ` · ${Math.round(it.size / 1024)} KB` : ''] })) : it.kind === 'video' ? (_jsxs("div", { className: css.favPartText, children: ["[\u89C6\u9891]", it.duration ? ` · ${Math.round(it.duration)}s` : ''] })) : it.kind === 'voice' ? (_jsx("div", { className: css.favPartText, children: "[\u8BED\u97F3]" })) : (_jsx("div", { className: css.favPartText, children: it.text || '' }))] }, idx))) : _jsx("div", { className: css.favPartText, children: d.desc || '' }) }), d.url && _jsx("a", { href: d.url, target: "_blank", rel: "noopener noreferrer", className: css.rowName, children: "\u6253\u5F00\u94FE\u63A5" })] }));
                })() })] }));
}
//# sourceMappingURL=Favorites.js.map