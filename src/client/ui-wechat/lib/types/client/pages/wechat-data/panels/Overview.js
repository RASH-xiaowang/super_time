import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 微信数据总览 — 太空舱版。一屏纵览微信数据资产：核心统计、趋势/热度/新鲜度、
 * 资金快照、清理建议、风险提示与战术分析。数据经 DSH 后端 Remote（node:sqlite），
 * 只读统计、无 HTTP。保留全部既有内容，新增扩展洞察。
 */
import { Suspense, useEffect, useRef, useState } from 'react';
import { apiExportAllSessions, apiGetLedger, apiGetOverview, apiGetOverviewInsights, apiGetStorageStats, apiGetAvatar, } from "../api.js";
import { LazyMount, useWechatDataUpdated } from "./hooks.js";
// 地图面板与 GeoJSON/ECharts 较重：进入可视区附近时才按需加载对应代码块。
import { WorldMapPanel } from "./WorldMap.js";
import { CalendarHeatmap } from "./CalendarHeatmap.js";
import { Card, PanelHeader, StatCard } from "../ui/kit.js";
import kitCss from '../ui/kit.module.css';
import css from './overview.module.css';
/** Format bytes for display. */
function fmtBytes(n) {
    if (isNaN(n) || n <= 0)
        return '0 B';
    if (n < 1048576)
        return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1073741824)
        return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(1)} GB`;
}
/** Format a signed delta with an arrow. */
function deltaArrow(n) {
    if (n > 0)
        return { text: `▲ ${n.toLocaleString()}`, cls: css.deltaUp };
    if (n < 0)
        return { text: `▼ ${(n * -1).toLocaleString()}`, cls: css.deltaDown };
    return { text: '— 持平', cls: css.deltaFlat };
}
/** Format a timestamp as a short local time. */
function fmtTime(t) {
    if (!t)
        return '—';
    return new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
/** Download a text payload as a file via a temporary object URL. */
function downloadText(filename, text, mime) {
    const blob = new Blob([text], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); }, 2000);
}
/** Recursively copy computed styles from a source element into a detached clone. */
function inlineComputedStyles(src, dst) {
    const style = getComputedStyle(src);
    const el = dst;
    for (let i = 0; i < style.length; i++) {
        const p = style[i];
        if (p)
            el.style.setProperty(p, style.getPropertyValue(p));
    }
    const sc = Array.from(src.children);
    const dc = Array.from(dst.children);
    for (let i = 0; i < sc.length && i < dc.length; i++) {
        if (sc[i] instanceof Element && dc[i] instanceof Element) {
            inlineComputedStyles(sc[i], dc[i]);
        }
    }
}
/** Read an image into a data URL without relying on SVG-as-image loading. */
async function imageToDataUrl(img) {
    const src = img.getAttribute('src') ?? '';
    if (!src || src.startsWith('data:'))
        return null;
    if (img.complete && img.naturalWidth > 0) {
        try {
            const c = document.createElement('canvas');
            c.width = img.naturalWidth || img.width || 1;
            c.height = img.naturalHeight || img.height || 1;
            const ctx = c.getContext('2d');
            if (ctx) {
                ctx.drawImage(img, 0, 0);
                const url = c.toDataURL('image/png');
                if (url.length > 100)
                    return url;
            }
        }
        catch {
            // Cross-origin without CORS: fall through to fetch below.
        }
    }
    try {
        const res = await fetch(src);
        if (!res.ok)
            return null;
        const blob = await res.blob();
        return await new Promise((resolve) => {
            const fr = new FileReader();
            fr.onload = () => { resolve(typeof fr.result === 'string' ? fr.result : null); };
            fr.onerror = () => { resolve(null); };
            fr.readAsDataURL(blob);
        });
    }
    catch {
        return null;
    }
}
/** Replace canvases and blob/CDN images in the clone so the foreignObject export keeps them. */
async function exportableClone(src, clone) {
    // Capture original clone images first: the canvas replacement below inserts
    // new <img> elements, which would otherwise shift the index alignment.
    const srcImgs = Array.from(src.querySelectorAll('img'));
    const dstImgs = Array.from(clone.querySelectorAll('img'));
    // Canvas pixels are not serialized by cloneNode: turn each into an <img> data URL.
    const srcCanvases = Array.from(src.querySelectorAll('canvas'));
    const dstCanvases = Array.from(clone.querySelectorAll('canvas'));
    srcCanvases.forEach((sc, i) => {
        const dc = dstCanvases[i];
        if (!(dc instanceof HTMLCanvasElement))
            return;
        let url;
        try {
            url = sc.toDataURL('image/png');
        }
        catch {
            return;
        }
        if (!url || url.length <= 100)
            return;
        const img = document.createElement('img');
        img.src = url;
        img.alt = '';
        img.style.width = getComputedStyle(sc).width;
        img.style.height = getComputedStyle(sc).height;
        dc.replaceWith(img);
    });
    // Blob and cross-origin avatar <img> sources do not render inside an SVG-as-image
    // element; bake loaded images (or re-fetch) to data URLs so they survive the export.
    await Promise.all(srcImgs.map(async (si, i) => {
        const di = dstImgs[i];
        if (!(di instanceof HTMLImageElement))
            return;
        const url = await imageToDataUrl(si);
        if (url)
            di.setAttribute('src', url);
    }));
}
/** Render a DOM element (with computed styles inlined) into a PNG/JPG download. */
async function exportElementImage(el, format, filename) {
    const scale = 2;
    const width = Math.max(el.offsetWidth, 1);
    const fullHeight = Math.max(el.scrollHeight, el.offsetHeight, 1);
    const clone = el.cloneNode(true);
    inlineComputedStyles(el, clone);
    await exportableClone(el, clone);
    clone.style.height = `${fullHeight}px`;
    clone.style.overflow = 'visible';
    clone.style.maxHeight = 'none';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${fullHeight}" viewBox="0 0 ${width} ${fullHeight}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(clone)}</foreignObject></svg>`;
    const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    const img = new Image();
    await new Promise((resolve, reject) => {
        img.onload = () => { resolve(); };
        img.onerror = () => { reject(new Error('image render failed')); };
        img.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = fullHeight * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        throw new Error('canvas context unavailable');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#0a1025';
    ctx.fillRect(0, 0, width, fullHeight);
    ctx.drawImage(img, 0, 0, width, fullHeight);
    const mime = format === 'png' ? 'image/png' : 'image/jpeg';
    const dataUrl = canvas.toDataURL(mime, 0.92);
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = filename;
    a.click();
}
/** Build a Markdown report from the loaded overview snapshots. */
function buildOverviewReport(data, ins, ledger, stor, generated, lastUpdated, avatars = {}) {
    const ls = ledger?.summary;
    const L = [];
    const p = (s) => { L.push(s); };
    p('# 微信数据总览报告');
    p('');
    p(`> 生成时间：${generated.toLocaleString('zh-CN')} · 数据更新：${lastUpdated ? new Date(lastUpdated).toLocaleString('zh-CN') : '—'}`);
    p('');
    p('## 核心统计');
    p('');
    p('| 指标 | 数值 |');
    p('| --- | --- |');
    p(`| 会话 | ${data.sessions.toLocaleString()} |`);
    p(`| 群聊 | ${data.groups.toLocaleString()} |`);
    p(`| 好友 | ${data.contacts.toLocaleString()} |`);
    p(`| 公众号/服务号 | ${data.official.toLocaleString()} |`);
    p(`| 朋友圈 | ${data.moments.toLocaleString()} |`);
    p(`| 收藏 | ${data.favorites.toLocaleString()} |`);
    p(`| 自定义表情 | ${data.emoticons.toLocaleString()} |`);
    p(`| 媒体占用 | ${fmtBytes(data.storage.total_size)}（${data.storage.total_count.toLocaleString()} 项） |`);
    p('');
    p('## 撤回与存储构成');
    p('');
    p(`- 撤回消息痕迹：${data.revoked.toLocaleString()} 条`);
    if (data.storage.categories.length > 0) {
        p('- 媒体类型：' + data.storage.categories.map(c => `${c.label} ${c.count.toLocaleString()} 项/${fmtBytes(c.size)}`).join(' · '));
    }
    p('');
    if (data.moments_authors.length > 0) {
        p('## 朋友圈活跃作者 Top 20');
        p('');
        p('| # | 头像 | 作者 | 条数 |');
        p('| :-- | :-- | :-- | :-- |');
        data.moments_authors.slice(0, 20).forEach((a, i) => {
            const img = avatars[a.username] ? `![头像](${avatars[a.username]})` : '(无头像)';
            p(`| ${i + 1} | ${img} | ${a.name} | ${a.posts} |`);
        });
        p('');
    }
    if (ins) {
        p('## 交互画像');
        p('');
        p(`- 消息总数：${ins.messages.total.toLocaleString()}（发出 ${ins.messages.sent.toLocaleString()} / 收到 ${ins.messages.received.toLocaleString()}）`);
        p(`- 活跃天数：${ins.time.activeDays} · 时间跨度：${ins.time.spanDays} 天 · 最忙 ${ins.time.busyHour}:00（${ins.time.busyCount.toLocaleString()} 条）`);
        p(`- 深夜占比：${ins.time.deepNightPct}% · 周末占比：${ins.time.weekendPct}%`);
        p(`- 消息类型：文本 ${ins.messages.text.toLocaleString()} / 图片 ${ins.messages.image.toLocaleString()} / 视频 ${ins.messages.video.toLocaleString()} / 链接卡片 ${ins.messages.rich.toLocaleString()} / 系统 ${ins.messages.system.toLocaleString()}`);
        p('');
        p('## 关系浓度');
        p('');
        p(`- 好友 ${ins.relations.total} · 有往来 ${ins.relations.active} · 沉默 ${ins.relations.silent} · 有消息的群 ${ins.relations.groupsWithMsg}`);
        if (ins.relations.top.length > 0) {
            p('- 对话 Top：' + ins.relations.top.map((t, i) => `${i + 1}.${t.name}(${t.count})`).join(' '));
        }
        p('');
        p('## 内容构成与资产');
        p('');
        p(`- 朋友圈 ${ins.moments.total}（图${ins.moments.images}/赞${ins.moments.likes}/评${ins.moments.comments}）`);
        p(`- 收藏 ${ins.assets.favorites} · 表情 ${ins.assets.emoticons} · 文件 ${ins.assets.files}（${fmtBytes(ins.assets.fileBytes)}）`);
        p('');
        p('## 数据健康');
        p('');
        p(`- 数据库文件 ${ins.health.dbFiles} · 体积 ${fmtBytes(ins.health.dbBytes)} · 可读 ${ins.health.ok ? '✅' : '⚠️'}`);
        if (ins.extras) {
            p(`- 最近同步 ${ins.extras.freshness.lastSync || '—'} · WAL ${ins.extras.freshness.walPending ? '待落库⚠️' : '正常'}`);
        }
        p('');
    }
    if (ls) {
        p('## 资金快照');
        p('');
        p(`- 收入 ¥${ls.totalAmountIn.toFixed(2)} · 支出 ¥${ls.totalAmountOut.toFixed(2)}`);
        p(`- 转账 ${ls.transfers.toLocaleString()} 次 · 红包收/发 ${ls.redpacketsSent + ls.redpacketsReceived} 个`);
        p('');
    }
    if (stor) {
        p('## 存储清理建议');
        p('');
        p(`- 媒体占用 ${fmtBytes(stor.total_size)}（${stor.total_count.toLocaleString()} 项）`);
        if (stor.large_files && stor.large_files.length > 0) {
            p('- 超大文件：' + stor.large_files.slice(0, 5).map(x => `${x.name || '(未知)'} ${fmtBytes(x.size)}`).join(' · '));
        }
        p('');
    }
    return L.join('\n');
}
/** 朋友圈活跃作者头像：组件挂载（进入可视区）后才请求头像，避免批量预取。 */
function AuthorAvatar({ author }) {
    const [src, setSrc] = useState('');
    useEffect(() => {
        let alive = true;
        void apiGetAvatar({ username: author.username })
            .then((r) => {
            if (!alive)
                return;
            setSrc(r.kind === 'data' ? (r.data ?? '') : r.kind === 'url' ? (r.url ?? '') : '');
        })
            .catch(() => { });
        return () => { alive = false; };
    }, [author.username]);
    if (src)
        return _jsx("img", { className: css.authorAvatar, src: src, alt: "", loading: "lazy" });
    return _jsx("span", { className: css.authorAvatarFallback, children: (author.name || '?').slice(0, 1) });
}
const CACHE_BASE = 'dsh-wechat-overview-base-v1';
const CACHE_INSIGHTS = 'dsh-wechat-overview-insights-v1';
const CACHE_LEDGER = 'dsh-wechat-overview-ledger-v1';
const CACHE_STOR = 'dsh-wechat-overview-storage-v1';
const CACHE_TIME = 'dsh-wechat-overview-last-updated-v1';
function readCache(key) {
    try {
        const s = localStorage.getItem(key);
        return s ? JSON.parse(s) : null;
    }
    catch {
        return null;
    }
}
function writeCache(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    }
    catch {
        /* ignore */
    }
}
/** Cards with icon, value, label, and target tab. */
const CARDS = [
    { key: 'sessions', label: '会话', icon: '💬', tab: 'chats' },
    { key: 'groups', label: '群聊', icon: '👥', tab: 'contacts' },
    { key: 'contacts', label: '好友', icon: '👤', tab: 'contacts' },
    { key: 'official', label: '公众号/服务号', icon: '📢', tab: 'bizchats' },
    { key: 'moments', label: '朋友圈', icon: '🖼️', tab: 'moments' },
    { key: 'favorites', label: '收藏', icon: '⭐', tab: 'favorites' },
    { key: 'emoticons', label: '自定义表情', icon: '😀', tab: 'emoticons' },
    { key: 'storage', label: '媒体占用', icon: '💾', tab: 'storage' },
];
/** High-value cross-panel entries. */
const QUICK_ACTIONS = [
    { tab: 'ask', icon: '✨', title: '微信问答', desc: '问本机聊天记录，引用可跳转原文' },
    { tab: 'ledger', icon: '💰', title: '资金账本', desc: '转账/红包按月汇总与异常清单' },
    { tab: 'tasks', icon: '✅', title: '待办与日程', desc: '从聊天提取待办并跳回原文' },
    { tab: 'groupinsights', icon: '📊', title: '群聊分析', desc: '成员活跃、群公告与沉默变化' },
    { tab: 'privacytrust', icon: '🛡️', title: '隐私与信任', desc: '数据边界、敏感扫描与 AI 审计' },
    { tab: 'health', icon: '🩺', title: '数据健康', desc: '索引、缓存与库状态检查' },
];
/** 消息类型分布（战术三）的展示顺序。 */
const MSG_BUCKETS = [
    { label: '文本', key: 'text' },
    { label: '图片', key: 'image' },
    { label: '视频', key: 'video' },
    { label: '链接/文件/卡片', key: 'rich' },
    { label: '系统消息', key: 'system' },
];
/**
 * Render the WeChat data overview panel (space-capsule cockpit).
 * @param props - navigation, chat and moments deep-link callbacks.
 * @returns the overview element tree.
 */
export function OverviewPanel({ onNavigate, onOpenChat, onOpenMoments } = {}) {
    const [data, setData] = useState(() => readCache(CACHE_BASE));
    const [ins, setIns] = useState(() => readCache(CACHE_INSIGHTS));
    const [ledger, setLedger] = useState(() => readCache(CACHE_LEDGER));
    const [stor, setStor] = useState(() => readCache(CACHE_STOR));
    const [loading, setLoading] = useState(false);
    const [refreshing, setRefreshing] = useState(false);
    const [error, setError] = useState(null);
    const [exporting, setExporting] = useState(false);
    const [notice, setNotice] = useState(null);
    const [lastUpdated, setLastUpdated] = useState(() => readCache(CACHE_TIME));
    const [done, setDone] = useState(false);
    const doneTimer = useRef(null);
    const rootRef = useRef(null);
    const [exportOpen, setExportOpen] = useState(false);
    const load = async () => {
        const hadData = data !== null;
        if (hadData)
            setRefreshing(true);
        else
            setLoading(true);
        try {
            const [base, insw] = await Promise.all([
                apiGetOverview(),
                apiGetOverviewInsights(),
            ]);
            setData(base);
            setIns(insw);
            writeCache(CACHE_BASE, base);
            writeCache(CACHE_INSIGHTS, insw);
            setError(null);
            const now = Date.now();
            setLastUpdated(now);
            writeCache(CACHE_TIME, now);
            if (hadData) {
                setDone(true);
                if (doneTimer.current)
                    clearTimeout(doneTimer.current);
                doneTimer.current = setTimeout(() => { setDone(false); }, 1600);
            }
        }
        catch (e) {
            if (data === null)
                setError(e.message);
            else
                setNotice('后台刷新失败，当前显示缓存数据：' + e.message);
        }
        finally {
            setLoading(false);
            setRefreshing(false);
        }
        // 资金/存储等较重扩展数据在后台慢慢更新并持久化，不阻塞核心刷新。
        try {
            const [lg, st] = await Promise.all([
                apiGetLedger(),
                apiGetStorageStats(),
            ]);
            setLedger(lg);
            setStor(st);
            writeCache(CACHE_LEDGER, lg);
            writeCache(CACHE_STOR, st);
        }
        catch {
            /* 保留已有缓存/数据 */
        }
    };
    useEffect(() => { void load(); }, []);
    useWechatDataUpdated(() => { void load(); });
    // 朋友圈活跃作者头像改为逐行懒加载：作者卡片进入可视区附近时才请求头像。
    const go = (tab) => { onNavigate?.(tab); };
    const openChat = (username) => { onOpenChat?.(username); };
    const openMoments = (username) => { onOpenMoments?.(username); };
    const topBase = (ins?.relations.top[0]?.count ?? 1) || 1;
    const extras = ins?.extras;
    const exportAll = async () => {
        setExporting(true);
        try {
            const r = await apiExportAllSessions();
            setNotice('已归档 ' + String(r.count) + ' 条消息 → ' + r.path);
            setTimeout(() => { setNotice(null); }, 6000);
        }
        catch (e) {
            setNotice('归档失败: ' + e.message);
        }
        finally {
            setExporting(false);
        }
    };
    const doExport = async (format) => {
        if (!data)
            return;
        const now = new Date();
        const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
        if (format === 'json') {
            const payload = {
                exportedAt: now.toISOString(),
                updatedAt: lastUpdated ? new Date(lastUpdated).toISOString() : null,
                snapshot: data,
                insights: ins,
                ledger,
                storage: stor,
            };
            downloadText(`微信数据总览-${stamp}.json`, JSON.stringify(payload, null, 2), 'application/json');
        }
        else if (format === 'md') {
            downloadText(`微信数据总览报告-${stamp}.md`, buildOverviewReport(data, ins, ledger, stor, now, lastUpdated), 'text/markdown;charset=utf-8');
        }
        else {
            setExportOpen(false);
            await new Promise((r) => { setTimeout(r, 40); });
            const root = rootRef.current;
            if (root) {
                try {
                    await exportElementImage(root, format, `微信数据总览-${stamp}.${format}`);
                }
                catch (e) {
                    setNotice('图片导出失败: ' + e.message);
                    return;
                }
            }
        }
        setNotice('已导出报告');
        setTimeout(() => { setNotice(null); }, 2500);
    };
    const ls = ledger?.summary;
    const largeFiles = stor?.large_files?.slice(0, 4) ?? [];
    const warnCount = ledger?.warnings.length ?? 0;
    return (_jsxs("div", { ref: rootRef, className: refreshing ? `${css.root} ${css.updating}` : css.root, children: [refreshing && _jsx("div", { className: css.scanbar }), _jsx(PanelHeader, { title: "\u5FAE\u4FE1\u6570\u636E\u603B\u89C8", desc: (_jsxs(_Fragment, { children: ["\u592A\u7A7A\u8231 \u00B7 \u672C\u673A\u5FAE\u4FE1\u6570\u636E\u8D44\u4EA7\u4E00\u5C4F\u7EB5\u89C8", refreshing && _jsxs(_Fragment, { children: [_jsx("span", { className: css.spinner }), " \u540C\u6B65\u4E2D\u2026"] }), lastUpdated ? ` · 最后更新 ${fmtTime(lastUpdated)}` : ''] })), actions: (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: css.refresh, onClick: () => { void exportAll(); }, disabled: exporting, children: exporting ? '归档中…' : '导出全部会话 ZIP' }), _jsx("button", { type: "button", className: css.refresh, onClick: () => { void load(); }, disabled: loading || refreshing, children: (loading || refreshing)
                                ? _jsxs(_Fragment, { children: [_jsx("span", { className: css.spinner }), " ", loading ? '统计中…' : '更新中…'] })
                                : done ? '✓ 已更新' : '刷新' }), _jsxs("div", { className: css.exportWrap, children: [_jsx("button", { type: "button", className: css.refresh, onClick: () => { setExportOpen(v => !v); }, disabled: !data, children: "\u5BFC\u51FA \u25BE" }), exportOpen && (_jsxs(_Fragment, { children: [_jsx("div", { className: css.exportBackdrop, onClick: () => { setExportOpen(false); } }), _jsxs("div", { className: css.exportMenu, children: [_jsx("button", { type: "button", className: css.exportItem, onClick: () => { void doExport('md'); setExportOpen(false); }, children: "Markdown \u62A5\u544A" }), _jsx("button", { type: "button", className: css.exportItem, onClick: () => { void doExport('json'); setExportOpen(false); }, children: "JSON \u6570\u636E" }), _jsx("button", { type: "button", className: css.exportItem, onClick: () => { void doExport('png'); setExportOpen(false); }, children: "PNG \u56FE\u7247" }), _jsx("button", { type: "button", className: css.exportItem, onClick: () => { void doExport('jpg'); setExportOpen(false); }, children: "JPG \u56FE\u7247" })] })] }))] })] })) }), notice && _jsx("div", { className: css.error, children: notice }), error && data === null && _jsx("div", { className: css.error, children: error }), error && data !== null && _jsx("div", { className: css.error, children: "\u540E\u53F0\u5237\u65B0\u5931\u8D25\uFF08\u6B63\u5728\u5C55\u793A\u7F13\u5B58\u6570\u636E\uFF09" }), !error && data === null && _jsxs("div", { className: css.loading, children: [_jsx("span", { className: css.spinner }), " \u6B63\u5728\u7EDF\u8BA1\u5FAE\u4FE1\u6570\u636E\u2026"] }), !error && data !== null && (_jsxs(_Fragment, { children: [_jsxs("div", { className: css.cols, children: [_jsx("div", { className: css.heroLeft, children: _jsx(Card, { title: "\u6838\u5FC3\u8D44\u4EA7", children: _jsx("div", { className: css.heroStats, children: CARDS.slice(0, 4).map((card) => {
                                            const value = card.key === 'storage'
                                                ? fmtBytes(data.storage.total_size)
                                                : data[card.key].toLocaleString();
                                            const sub = card.key === 'storage' ? `${data.storage.total_count.toLocaleString()} 项` : undefined;
                                            const tone = card.key === 'moments' ? 'purple'
                                                : card.key === 'official' ? 'blue'
                                                    : card.key === 'storage' ? 'green' : 'cyan';
                                            return (_jsx(StatCard, { icon: card.icon, value: value, label: card.label, hint: sub, tone: tone, onClick: () => { go(card.tab); }, title: `查看${card.label}` }, card.key));
                                        }) }) }) }), _jsx("div", { className: css.heroRight, children: _jsx(Card, { title: "\u884C\u52A8\u5165\u53E3", children: _jsx("div", { className: css.quickGrid, children: QUICK_ACTIONS.map(a => (_jsxs("button", { type: "button", className: css.quickCard, onClick: () => { go(a.tab); }, title: a.desc, children: [_jsx("span", { className: css.quickIcon, children: a.icon }), _jsxs("span", { className: css.quickBody, children: [_jsx("span", { className: css.quickTitle, children: a.title }), _jsx("span", { className: css.quickDesc, children: a.desc })] }), _jsx("span", { className: css.quickArrow, children: "\u2192" })] }, a.tab))) }) }) })] }), _jsx(Card, { title: "\u4E16\u754C\u677F\u5757 \u00B7 \u597D\u53CB\u5730\u533A", children: _jsx(LazyMount, { placeholder: _jsx("div", { className: css.empty, children: "\u5730\u56FE\u8FDB\u5165\u53EF\u89C6\u533A\u540E\u52A0\u8F7D\u2026" }), children: _jsx(Suspense, { fallback: _jsx("div", { className: css.empty, children: "\u5730\u56FE\u8D44\u6E90\u52A0\u8F7D\u4E2D\u2026" }), children: _jsx(WorldMapPanel, {}) }) }) }), extras && (_jsxs("div", { className: css.cols, children: [_jsx(Card, { title: "\u8F68\u9053\u8D8B\u52BF", children: _jsxs("div", { className: css.trendGrid, children: [_jsxs("div", { className: css.trendCell, children: [_jsx("span", { className: css.metricValue, children: extras.trends.messages7.toLocaleString() }), _jsx("span", { className: css.metricLabel, children: "\u8FD1 7 \u5929\u6D88\u606F" }), _jsx("span", { className: deltaArrow(extras.trends.messages7Delta).cls, children: deltaArrow(extras.trends.messages7Delta).text })] }), _jsxs("div", { className: css.trendCell, children: [_jsx("span", { className: css.metricValue, children: extras.trends.messages30.toLocaleString() }), _jsx("span", { className: css.metricLabel, children: "\u8FD1 30 \u5929\u6D88\u606F" }), _jsx("span", { className: deltaArrow(extras.trends.messages30Delta).cls, children: deltaArrow(extras.trends.messages30Delta).text })] }), _jsxs("div", { className: css.trendCell, children: [_jsx("span", { className: css.metricValue, children: extras.trends.activeContacts30.toLocaleString() }), _jsx("span", { className: css.metricLabel, children: "\u8FD1 30 \u5929\u6D3B\u8DC3\u597D\u53CB" })] }), _jsxs("div", { className: css.trendCell, children: [_jsx("span", { className: css.metricValue, children: extras.trends.activeGroups30.toLocaleString() }), _jsx("span", { className: css.metricLabel, children: "\u8FD1 30 \u5929\u6D3B\u8DC3\u7FA4" })] }), _jsxs("div", { className: css.trendCell, children: [_jsx("span", { className: css.metricValue, children: fmtBytes(extras.trends.storageBytes30) }), _jsx("span", { className: css.metricLabel, children: "\u8FD1 30 \u5929\u65B0\u589E\u5A92\u4F53" })] })] }) }), extras.heatmap.length > 0 && (_jsx(Card, { title: "\u6D88\u606F\u70ED\u5EA6 \u00B7 \u8FD1 90 \u5929", children: _jsx(CalendarHeatmap, { data: extras.heatmap }) }))] })), _jsxs("div", { className: kitCss.cardGrid, children: [_jsx(Card, { title: `存储构成 Top ${data.storage.categories.length}`, extra: (_jsx("button", { type: "button", className: css.panelGo, onClick: () => { go('storage'); }, children: "\u8BE6\u60C5 \u2192" })), children: data.storage.categories.length === 0 ? (_jsx("div", { className: css.empty, children: "\u6682\u65E0\u5A92\u4F53\u8D44\u6E90\u8BB0\u5F55" })) : (_jsx("div", { className: css.catList, children: data.storage.categories.slice(0, 4).map(c => (_jsxs("div", { className: css.cat, children: [_jsxs("div", { className: css.catRow, children: [_jsx("span", { className: css.catLabel, children: c.label }), _jsxs("span", { className: css.catMeta, children: [c.count.toLocaleString(), " \u9879 \u00B7 ", fmtBytes(c.size)] })] }), _jsx("div", { className: css.bar, children: _jsx("div", { className: css.barFill, style: { width: `${(c.size / Math.max(1, data.storage.categories[0]?.size ?? 1)) * 100}%` } }) })] }, c.label))) })) }), _jsx(Card, { title: "\u64A4\u56DE\u6D88\u606F\u75D5\u8FF9", extra: (_jsx("button", { type: "button", className: css.panelGo, onClick: () => { go('revoked'); }, children: "\u8BE6\u60C5 \u2192" })), children: _jsxs("div", { className: css.revoke, children: [_jsx("span", { className: css.revokeValue, children: data.revoked.toLocaleString() }), _jsx("span", { className: css.revokeLabel, children: "\u6761\u88AB\u64A4\u56DE\u6D88\u606F\u7684\u5143\u6570\u636E\u75D5\u8FF9\uFF08\u53D1\u9001\u8005/\u65F6\u95F4/\u7C7B\u578B\u53EF\u67E5\uFF09" }), _jsx("p", { className: css.revokeNote, children: "\u5FAE\u4FE1 4.x \u9632\u64A4\u56DE\u673A\u5236\u5728\u672C\u5730\u4FDD\u7559\u7684\u5220\u9664\u7F13\u5B58\uFF0C\u53EF\u7528\u4E8E\u56DE\u987E\"\u8C01\u64A4\u56DE\u4E86\u4EC0\u4E48\"\u3002" })] }) })] }), _jsxs("div", { className: kitCss.cardGrid, children: [_jsx(Card, { title: `资金快照 · ${ledger?.month ?? ''}`, extra: (_jsx("button", { type: "button", className: css.panelGo, onClick: () => { go('ledger'); }, children: "\u8BE6\u60C5 \u2192" })), children: ls ? (_jsxs("div", { className: css.metricGrid, children: [_jsxs("div", { className: css.metric, children: [_jsxs("span", { className: css.metricValue, children: ["\u00A5", ls.totalAmountIn.toFixed(2)] }), _jsx("span", { className: css.metricLabel, children: "\u6536\u5165" })] }), _jsxs("div", { className: css.metric, children: [_jsxs("span", { className: css.metricValue, children: ["\u00A5", ls.totalAmountOut.toFixed(2)] }), _jsx("span", { className: css.metricLabel, children: "\u652F\u51FA" })] }), _jsxs("div", { className: css.metric, children: [_jsx("span", { className: css.metricValue, children: ls.transfers.toLocaleString() }), _jsx("span", { className: css.metricLabel, children: "\u8F6C\u8D26\u6B21\u6570" })] }), _jsxs("div", { className: css.metric, children: [_jsx("span", { className: css.metricValue, children: ls.redpacketsSent + ls.redpacketsReceived }), _jsx("span", { className: css.metricLabel, children: "\u7EA2\u5305\u6536/\u53D1" })] })] })) : (_jsx("div", { className: css.empty, children: "\u6682\u65E0\u8D44\u91D1\u8BB0\u5F55" })) }), _jsx(Card, { title: "\u5B58\u50A8\u6E05\u7406\u5EFA\u8BAE", extra: (_jsx("button", { type: "button", className: css.panelGo, onClick: () => { go('storage'); }, children: "\u8BE6\u60C5 \u2192" })), children: _jsxs("div", { className: css.metricGrid, children: [_jsxs("div", { className: css.metric, children: [_jsx("span", { className: css.metricValue, children: fmtBytes(stor?.total_size ?? 0) }), _jsx("span", { className: css.metricLabel, children: "\u5A92\u4F53\u5360\u7528" })] }), _jsxs("div", { className: css.metric, children: [_jsx("span", { className: css.metricValue, children: (stor?.total_count ?? 0).toLocaleString() }), _jsx("span", { className: css.metricLabel, children: "\u5A92\u4F53\u9879" })] }), _jsxs("div", { className: css.metric, children: [_jsx("span", { className: css.metricValue, children: largeFiles.length }), _jsx("span", { className: css.metricLabel, children: "\u8D85\u5927\u6587\u4EF6" })] })] }) })] }), ins && (_jsxs("div", { className: css.cols, children: [_jsxs(Card, { title: "\u4EA4\u4E92\u753B\u50CF \u00B7 \u57FA\u4E8E\u6D88\u606F\u65F6\u95F4\u4E0E\u7C7B\u578B", children: [_jsxs("div", { className: css.metricGrid, children: [_jsxs("div", { className: css.metric, children: [_jsx("span", { className: css.metricValue, children: ins.messages.total.toLocaleString() }), _jsx("span", { className: css.metricLabel, children: "\u6D88\u606F\u603B\u6570" })] }), _jsxs("div", { className: css.metric, children: [_jsx("span", { className: css.metricValue, children: ins.time.activeDays }), _jsx("span", { className: css.metricLabel, children: "\u6D3B\u8DC3\u5929\u6570" })] }), _jsxs("div", { className: css.metric, children: [_jsx("span", { className: css.metricValue, children: ins.time.spanDays }), _jsx("span", { className: css.metricLabel, children: "\u65F6\u95F4\u8DE8\u5EA6(\u5929)" })] }), _jsxs("div", { className: css.metric, children: [_jsxs("span", { className: css.metricValue, children: [ins.time.busyHour, ":00"] }), _jsxs("span", { className: css.metricLabel, children: ["\u6700\u5FD9\u65F6\u6BB5 \u00B7 ", ins.time.busyCount.toLocaleString(), " \u6761"] })] }), _jsxs("div", { className: css.metric, children: [_jsxs("span", { className: css.metricValue, children: [ins.time.deepNightPct, "%"] }), _jsx("span", { className: css.metricLabel, children: "\u6DF1\u591C(23-6\u70B9)\u5360\u6BD4" })] }), _jsxs("div", { className: css.metric, children: [_jsxs("span", { className: css.metricValue, children: [ins.time.weekendPct, "%"] }), _jsx("span", { className: css.metricLabel, children: "\u5468\u672B\u5360\u6BD4" })] })] }), _jsx("div", { className: css.hourBars, children: ins.time.hourDist.map((n, h) => {
                                            const max = Math.max(1, ...ins.time.hourDist);
                                            return (_jsxs("div", { className: css.hourCol, title: `${h}:00 · ${n} 条`, children: [_jsx("div", { className: css.hourFill, style: { height: `${Math.max(4, (n / max) * 100)}%` }, "data-hot": n === ins.time.busyCount || undefined }), _jsx("span", { className: css.hourLabel, children: h })] }, h));
                                        }) })] }), _jsxs(Card, { title: "\u5173\u7CFB\u6D53\u5EA6 \u00B7 \u597D\u53CB\u6D3B\u8DC3\u4E0E\u5BF9\u8BDD Top", children: [_jsxs("div", { className: css.metricGrid, children: [_jsxs("div", { className: css.metric, children: [_jsx("span", { className: css.metricValue, children: ins.relations.total }), _jsx("span", { className: css.metricLabel, children: "\u597D\u53CB\u603B\u6570" })] }), _jsxs("div", { className: css.metric, children: [_jsx("span", { className: css.metricValue, children: ins.relations.active }), _jsx("span", { className: css.metricLabel, children: "\u6709\u6D88\u606F\u5F80\u6765" })] }), _jsxs("div", { className: css.metric, children: [_jsx("span", { className: css.metricValue, children: ins.relations.silent }), _jsx("span", { className: css.metricLabel, children: "\u6C89\u9ED8\u597D\u53CB(\u65E0\u6D88\u606F)" })] }), _jsxs("div", { className: css.metric, children: [_jsx("span", { className: css.metricValue, children: ins.relations.groupsWithMsg }), _jsx("span", { className: css.metricLabel, children: "\u6709\u6D88\u606F\u7684\u7FA4" })] })] }), ins.relations.top.length > 0 && (_jsx("div", { className: css.topList, children: ins.relations.top.map((t, i) => (_jsxs("button", { type: "button", className: css.topRow, onClick: () => { openChat(t.username); }, title: `与「${t.name}」的对话`, children: [_jsx("span", { className: css.topRank, children: i + 1 }), _jsx("span", { className: css.topName, children: t.name }), _jsx("div", { className: css.topTrack, children: _jsx("div", { className: css.topFill, style: { width: `${(t.count / topBase) * 100}%` } }) }), _jsxs("span", { className: css.topCount, children: [t.count, " \u6761"] })] }, t.username))) }))] })] })), _jsxs("div", { className: css.cols, children: [data.moments_authors.length > 0 && (_jsx(Card, { title: "\u670B\u53CB\u5708\u6D3B\u8DC3 Top 20", extra: (_jsx("button", { type: "button", className: css.panelGo, onClick: () => { go('moments'); }, children: "\u8BE6\u60C5 \u2192" })), children: _jsx("div", { className: css.authors, children: data.moments_authors.map((a, i) => (_jsxs("button", { type: "button", className: css.author, onClick: () => { openMoments(a.username); }, title: `${a.name} 共发布 ${a.posts} 条`, children: [_jsx("span", { className: css.authorRank, children: i + 1 }), _jsx(LazyMount, { placeholder: _jsx("span", { className: css.authorAvatarFallback, children: (a.name || '?').slice(0, 1) }), rootMargin: "300px 0px", children: _jsx(AuthorAvatar, { author: a }) }), _jsx("span", { className: css.authorName, children: a.name }), _jsxs("span", { className: css.authorPosts, children: [a.posts, " \u6761"] })] }, a.username))) }) })), _jsxs("div", { className: css.colStack, children: [ins && (_jsxs(Card, { title: "\u5185\u5BB9\u6784\u6210\u4E0E\u8D44\u4EA7", children: [_jsx("div", { className: css.catList, children: MSG_BUCKETS.map((x) => {
                                                    const n = ins.messages[x.key];
                                                    const max = Math.max(1, ins.messages.text);
                                                    return (_jsxs("div", { className: css.cat, children: [_jsxs("div", { className: css.catRow, children: [_jsx("span", { className: css.catLabel, children: x.label }), _jsxs("span", { className: css.catMeta, children: [n.toLocaleString(), " \u6761"] })] }), _jsx("div", { className: css.bar, children: _jsx("div", { className: css.barFill, style: { width: `${(n / max) * 100}%` } }) })] }, x.label));
                                                }) }), _jsxs("div", { className: css.catRow, style: { marginTop: 10 }, children: [_jsx("span", { className: css.catLabel, children: "\u8D44\u4EA7" }), _jsx("span", { className: css.catMeta, children: `朋友圈 ${ins.moments.total}(图${ins.moments.images}/赞${ins.moments.likes}/评${ins.moments.comments})` +
                                                            ` · 收藏 ${ins.assets.favorites} · 表情 ${ins.assets.emoticons}` +
                                                            ` · 文件 ${ins.assets.files} (${fmtBytes(ins.assets.fileBytes)})` })] })] })), _jsx(Card, { title: "\u98CE\u9669\u4E0E\u9690\u79C1\u63D0\u793A", extra: (_jsx("button", { type: "button", className: css.panelGo, onClick: () => { go('privacytrust'); }, children: "\u8BE6\u60C5 \u2192" })), children: _jsxs("div", { className: css.riskRow, children: [_jsxs("span", { className: css.riskItem, children: ["\u64A4\u56DE\u6D88\u606F ", _jsx("b", { children: data.revoked.toLocaleString() }), " \u6761"] }), _jsxs("span", { className: css.riskItem, children: ["\u8F6C\u8D26/\u7EA2\u5305\u5F02\u5E38 ", _jsx("b", { children: warnCount }), " \u6761"] }), _jsx("span", { className: css.riskItem, children: "\u5EFA\u8BAE\u5B9A\u671F\u8FD0\u884C\u300C\u9690\u79C1\u4E0E\u4FE1\u4EFB\u300D\u626B\u63CF" })] }) }), ins && (_jsx(Card, { title: "\u6570\u636E\u5065\u5EB7", children: _jsxs("div", { className: css.metricGrid, children: [_jsxs("div", { className: css.metric, children: [_jsx("span", { className: css.metricValue, children: ins.health.dbFiles }), _jsx("span", { className: css.metricLabel, children: "\u6570\u636E\u5E93\u6587\u4EF6" })] }), _jsxs("div", { className: css.metric, children: [_jsx("span", { className: css.metricValue, children: fmtBytes(ins.health.dbBytes) }), _jsx("span", { className: css.metricLabel, children: "\u89E3\u5BC6\u6570\u636E\u4F53\u79EF" })] }), _jsxs("div", { className: css.metric, children: [_jsx("span", { className: css.metricValue, children: ins.health.ok ? '✅' : '⚠️' }), _jsx("span", { className: css.metricLabel, children: "\u6570\u636E\u53EF\u8BFB\u6027" })] }), _jsxs("div", { className: css.metric, children: [_jsx("span", { className: css.metricValue, children: ins.time.lastActive || '—' }), _jsx("span", { className: css.metricLabel, children: "\u6700\u8FD1\u6D3B\u8DC3" })] }), extras && (_jsxs("div", { className: css.metric, children: [_jsx("span", { className: css.metricValue, children: extras.freshness.walPending ? '⚠️' : '✅' }), _jsx("span", { className: css.metricLabel, children: "WAL \u5F85\u843D\u5E93" })] }))] }) }))] })] })] }))] }));
}
//# sourceMappingURL=Overview.js.map