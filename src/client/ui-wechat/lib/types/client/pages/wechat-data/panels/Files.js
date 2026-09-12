import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 文件面板 — React 版：图片/视频/文件分类 + 网格预览（图片本地解码缩略图 + 点击放大）
 * + 大小/时间/会话 + 刷新 + 导出。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useProgressiveList } from "./hooks.js";
import { apiExportCsv, apiGetFiles, apiGetSnsImageDataUrl } from "../api.js";
import { useWechatDataUpdated } from "./hooks.js";
import { Dialog, Drawer, PanelHeader, SearchInput, Segmented, Toolbar } from "../ui/kit.js";
import css from './list-panel.module.css';
import { fileIcon } from "../utils/format.js";
const CAT_LABEL = { image: '图片', video: '视频', file: '文件' };
/** 缓存文件名 → 解析键（去掉 .dat / _t/_h/_b 后缀）。 */
function fileKey(f) {
    const base = f.fileName || f.md5;
    return base.replace(/\.dat$/i, '').replace(/_(t|h|b|thumb.*)$/i, '');
}
/** 文件大小格式化。 */
function fmtBytes(n) {
    if (n < 1048576)
        return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824)
        return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
}
/** 时间格式化（月-日）。 */
function fmtDate(ts) {
    if (!ts)
        return '';
    const d = new Date(ts * 1000);
    return `${d.getMonth() + 1}-${d.getDate()}`;
}
/** Detects a hash-like (unreadable) file name: hex/base32 without a real extension. */
function isHashLike(f) {
    const n = (f.fileName || f.md5).replace(/\.dat$/i, '');
    if (/^[0-9a-f]{16,64}$/i.test(n))
        return true;
    return !n.includes('.') && /^[0-9a-z]{16,}$/i.test(n);
}
/** Readable label: uses the original name when readable, else category + date. */
function fileDisplayName(f) {
    if (!f)
        return '(未知)';
    if (!isHashLike(f))
        return f.fileName || f.md5 || '';
    const label = CAT_LABEL[f.category] || f.category || '文件';
    const src = f.sessionName ? `来自 ${f.sessionName} · ` : '';
    return `${label} · ${src}${fmtDate(f.modifyTime)}`;
}
/**
 * Render the files panel.
 * @returns the files element tree.
 */
export function FilesPanel() {
    const [files, setFiles] = useState([]);
    const [total, setTotal] = useState(0);
    const [cat, setCat] = useState('all');
    const [search, setSearch] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [fileImgs, setFileImgs] = useState({});
    const [preview, setPreview] = useState(null);
    const [dupOpen, setDupOpen] = useState(false);
    const imgFetched = useRef(new Set());
    const gridRef = useRef(null);
    const pager = usePagedList({
        pageSize: 120,
        fetchPage: async (offset, limit) => {
            const env = await apiGetFiles({ limit, offset });
            return { items: env.files, total: env.total };
        },
    });
    const searching = search.trim() !== '';
    // 普通浏览：分页逐页加载；搜索时一次性拉取 500 条（用户主动操作），保证跨页搜索结果完整。
    useEffect(() => {
        if (searching) {
            let cancelled = false;
            setLoading(true);
            setError(null);
            void apiGetFiles({ limit: 500 })
                .then((env) => {
                if (cancelled)
                    return;
                setFiles(env.files);
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
        setFiles(pager.items);
        setTotal(pager.total);
        setLoading(pager.loading);
        setError(pager.error);
    }, [searching, pager.items, pager.total, pager.loading, pager.error]);
    const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore)
        pager.loadMore(); }, '600px 0px', () => gridRef.current);
    const refresh = useCallback(() => {
        setError(null);
        if (searching) {
            setLoading(true);
            void apiGetFiles({ limit: 500 })
                .then((env) => { setFiles(env.files); setTotal(env.total); })
                .catch((e) => { setError(e.message); })
                .finally(() => { setLoading(false); });
        }
        else {
            pager.reset();
        }
    }, [searching, pager.reset]);
    // 数据落地后按需安静刷新（不打断用户滚动位置）。
    useWechatDataUpdated(() => { if (!searching)
        pager.reset(); });
    const searched = useMemo(() => {
        const list = files;
        const q = search.trim().toLowerCase();
        if (!q)
            return list;
        return list.filter(f => (f.fileName || f.md5).toLowerCase().includes(q));
    }, [files, search]);
    const visible = useMemo(() => {
        if (cat === 'all')
            return searched;
        return searched.filter(f => f.category === cat);
    }, [searched, cat]);
    const countOf = (c) => searched.filter(f => f.category === c).length;
    const { count: fileCount, sentinelRef: fileSentinel } = useProgressiveList(visible.length, 120);
    // 图片资源懒加载：仅当图片格子接近视口时才离线解码（IntersectionObserver），
    // 避免一次性解码数百张图片导致卡顿；进入视口的才请求数据，已取到的用 fileImgs 缓存。
    useEffect(() => {
        const root = gridRef.current;
        const list = files;
        if (!root || list.length === 0)
            return;
        const md5ByKey = new Map();
        for (const f of list) {
            if (f.category !== 'image')
                continue;
            const key = fileKey(f);
            if (key)
                md5ByKey.set(key, f.md5 || '');
        }
        const decode = (key, md5) => {
            if (!key || imgFetched.current.has(key))
                return;
            imgFetched.current.add(key);
            void apiGetSnsImageDataUrl({ md5 })
                .then((r) => { if (r.url)
                setFileImgs(prev => ({ ...prev, [key]: r.url })); })
                .catch(() => { });
        };
        if (typeof IntersectionObserver === 'undefined') {
            // 无 IO 支持时兜底全部解码，保证图片可见。
            for (const [key, md5] of md5ByKey)
                decode(key, md5);
            return;
        }
        const ob = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (!e.isIntersecting)
                    continue;
                const key = e.target.dataset.mediaKey || '';
                const md5 = md5ByKey.get(key);
                if (key && md5)
                    decode(key, md5);
            }
        }, { root, rootMargin: '500px 0px' });
        // 观察当前已渲染的图片格子；随渐进渲染增加时本 effect 会随 fileCount 重跑。
        root.querySelectorAll('[data-media-key]').forEach((el) => { ob.observe(el); });
        return () => { ob.disconnect(); };
    }, [files, fileCount]);
    const dupGroups = useMemo(() => {
        const byKey = new Map();
        for (const f of visible) {
            const k = fileKey(f);
            const arr = byKey.get(k) ?? [];
            arr.push(f);
            byKey.set(k, arr);
        }
        return [...byKey.values()]
            .filter(g => g.length > 1)
            .map(g => ({ key: g[0]?.md5 ?? '', items: g, total: g.reduce((a, f) => a + (f.fileSize || 0), 0) }))
            .sort((a, b) => b.items.length * b.total - a.items.length * a.total);
    }, [visible]);
    const doExport = async () => {
        try {
            const r = await apiExportCsv({ kind: 'files' });
            window.alert(`已导出 ${r.count} 个文件 → ${r.path}`);
        }
        catch (e) {
            window.alert('导出失败: ' + e.message);
        }
    };
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u6587\u4EF6\u7BA1\u7406", desc: `共 ${total} 项`, actions: (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: css.catBtn, onClick: refresh, children: "\u5237\u65B0" }), _jsx("button", { type: "button", className: css.catBtn, onClick: () => { void doExport(); }, children: "\u5BFC\u51FA" }), _jsxs("button", { type: "button", className: css.catBtn, "data-active": dupOpen || undefined, onClick: () => { setDupOpen(v => !v); }, children: ["\u67E5\u627E\u91CD\u590D (", dupGroups.length, ")"] })] })) }), _jsx(Toolbar, { left: (_jsx(SearchInput, { value: search, onChange: (v) => { setSearch(v); }, placeholder: "\u641C\u7D22\u6587\u4EF6\u540D / MD5", ariaLabel: "\u641C\u7D22\u6587\u4EF6" })), right: (_jsx(Segmented, { options: [
                        { value: 'all', label: `全部 (${searched.length})` },
                        { value: 'image', label: `图片 (${countOf('image')})` },
                        { value: 'video', label: `视频 (${countOf('video')})` },
                        { value: 'file', label: `文件 (${countOf('file')})` },
                    ], value: cat, onChange: (v) => { setCat(v); }, ariaLabel: "\u6587\u4EF6\u5206\u7C7B" })) }), _jsxs("div", { className: css.grid, ref: gridRef, children: [loading && _jsx(ListSkeleton, { rows: 10, grid: true }), error && _jsxs("div", { className: css.empty, children: ["\u26A0\uFE0F \u6587\u4EF6\u6570\u636E\u63A5\u53E3\u5C1A\u672A\u5C31\u7EEA\uFF08", error, "\uFF09"] }), !loading && !error && visible.length === 0 && _jsx("div", { className: css.empty, children: "\u6682\u65E0\u6587\u4EF6" }), !loading && !error && visible.slice(0, fileCount).map((f) => {
                        const fk = fileKey(f);
                        const imgSrc = f.category === 'image' ? fileImgs[fk] || '' : '';
                        const iconHtml = fileIcon(((f.fileName || '').split('.').pop() ?? '').slice(0, 8));
                        return (_jsxs("div", { className: css.fileCell, title: f.fileName || f.md5, onClick: () => { if (imgSrc)
                                setPreview(f); }, "data-media-key": f.category === 'image' ? fileKey(f) : undefined, children: [imgSrc ? (_jsx("img", { className: css.fileThumb, src: imgSrc, alt: "", loading: "lazy", referrerPolicy: "no-referrer" })) : (_jsx("span", { className: css.fileIcon, dangerouslySetInnerHTML: { __html: iconHtml } })), _jsx("span", { className: css.fileName, children: fileDisplayName(f).slice(0, 24) }), _jsxs("span", { className: css.fileMeta, children: [CAT_LABEL[f.category] || f.category, " \u00B7 ", fmtBytes(f.fileSize || 0), " \u00B7 ", fmtDate(f.modifyTime)] })] }, f.md5));
                    }), !loading && !error && visible.length > fileCount && _jsx(ListSentinel, { refFn: fileSentinel }), !loading && !error && !searching && pager.hasMore && _jsx(ListSentinel, { refFn: loadMoreRef })] }), _jsxs(Drawer, { open: dupOpen, onClose: () => { setDupOpen(false); }, title: "\u91CD\u590D\u6587\u4EF6\u9884\u89C8", children: [_jsx("div", { className: css.dupSub, children: "\u201C\u53BB\u91CD\u201D\u4E3A\u53EA\u8BFB\u5EFA\u8BAE\uFF0C\u4E0D\u5728\u672C\u673A\u5220\u9664\u6570\u636E" }), dupGroups.length === 0 && _jsx("div", { className: css.empty, children: "\u672A\u53D1\u73B0\u91CD\u590D\u6587\u4EF6" }), dupGroups.map(g => (_jsxs("div", { className: css.dupRow, children: [_jsx("span", { className: css.dupName, children: fileDisplayName(g.items[0]) }), _jsxs("span", { className: css.dupMeta, children: ["\u540C\u5185\u5BB9 \u00D7", g.items.length, " \u00B7 \u5171 ", fmtBytes(g.total)] }), _jsx("span", { className: css.dupKeep, children: "\u5EFA\u8BAE\u4FDD\u7559 1 \u4EFD" })] }, g.key)))] }), _jsx(Dialog, { open: preview !== null, onClose: () => { setPreview(null); }, title: preview?.fileName || preview?.md5 || '图片预览', children: preview && (_jsxs(_Fragment, { children: [fileImgs[fileKey(preview)] ? (_jsx("img", { className: css.filePreviewImg, src: fileImgs[fileKey(preview)] ?? '', alt: preview.fileName || preview.md5, referrerPolicy: "no-referrer" })) : _jsx("div", { className: css.empty, children: "\u6682\u65E0\u56FE\u7247\u9884\u89C8" }), _jsxs("div", { className: css.fileMeta, children: [CAT_LABEL[preview.category] || preview.category, " \u00B7 ", fmtBytes(preview.fileSize || 0), " \u00B7 ", fmtDate(preview.modifyTime)] })] })) })] }));
}
//# sourceMappingURL=Files.js.map