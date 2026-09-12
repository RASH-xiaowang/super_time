import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 数据健康中心 — 解密 SQLite 遍历统计、WAL/SHM、搜索索引、插件存储与
 * 解码缓存占用，支持重建搜索索引。
 */
import { useCallback, useEffect, useState } from 'react';
import { apiBuildSearchIndex, apiGetDbHealth, apiGetDbStatus, readRenderCache, writeRenderCache } from "../api.js";
import { Card, PanelHeader, StatCard, StatGrid } from "../ui/kit.js";
import kitCss from '../ui/kit.module.css';
import css from './health.module.css';
function fmtBytes(n) {
    if (n <= 0)
        return '0 B';
    if (n < 1048576)
        return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
}
/**
 * Render the data health panel.
 * @param props - optional tab navigation callback for quick jumps.
 * @returns the health element tree.
 */
export function HealthPanel({ onNavigate } = {}) {
    const [snap, setSnap] = useState(() => readRenderCache('health')?.snap ?? null);
    const [status, setStatus] = useState(() => readRenderCache('health')?.status ?? null);
    const [loading, setLoading] = useState(false);
    const [building, setBuilding] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const cached = readRenderCache('health');
            if (cached) {
                setSnap(cached.snap);
                setStatus(cached.status);
            }
            const [h, s] = await Promise.all([apiGetDbHealth(), apiGetDbStatus().catch(() => null)]);
            setSnap(h);
            setStatus(s);
            writeRenderCache('health', { snap: h, status: s });
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, []);
    // 数据健康遍历统计较重：不进入页签即自动执行，初始仅展示渲染缓存，
    // 由「重新检查」按钮按需触发全量统计。
    useEffect(() => {
        const cached = readRenderCache('health');
        if (cached) {
            setSnap(cached.snap);
            setStatus(cached.status);
        }
    }, []);
    const rebuild = useCallback(async () => {
        setBuilding(true);
        try {
            const r = await apiBuildSearchIndex({ force: true });
            setNotice(`重建完成：${r.rows} 行索引`);
            window.setTimeout(() => { setNotice(null); }, 3000);
            await load();
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setBuilding(false);
        }
    }, [load]);
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u6570\u636E\u5065\u5EB7\u4E2D\u5FC3", desc: `解密库/索引/插件存储/解码缓存占用 · 本地检查${snap ? ` · 快照 ${new Date(snap.updatedAt * 1000).toLocaleString('zh-CN')}` : ''}`, actions: (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: css.btn, onClick: () => { void load(); }, disabled: loading, children: loading ? '检查中…' : '重新检查' }), _jsx("button", { type: "button", className: css.btn, onClick: () => { void rebuild(); }, disabled: building, children: building ? '重建中…' : '重建搜索索引' })] })) }), notice && _jsx("div", { className: css.notice, children: notice }), error && _jsx("div", { className: css.error, role: "alert", children: error }), loading && !snap && _jsx("div", { className: css.empty, children: "\u68C0\u67E5\u4E2D\u2026" }), !loading && !snap && !error && _jsx("div", { className: css.empty, children: "\u70B9\u51FB\u300C\u91CD\u65B0\u68C0\u67E5\u300D\u751F\u6210\u6570\u636E\u5065\u5EB7\u62A5\u544A" }), snap && (_jsxs(_Fragment, { children: [_jsxs(StatGrid, { children: [_jsx(StatCard, { icon: "\uD83D\uDDC4\uFE0F", value: snap.dbFiles, label: "\u89E3\u5BC6\u5E93\u6587\u4EF6" }), _jsx(StatCard, { icon: "\uD83D\uDCBE", value: fmtBytes(snap.dbBytes), label: "\u89E3\u5BC6\u5E93\u5927\u5C0F", tone: "purple" }), _jsx(StatCard, { icon: "\uD83D\uDCDD", value: `${snap.walFiles} / ${snap.shmFiles}`, label: "WAL / SHM", tone: "amber" }), _jsx(StatCard, { icon: "\uD83D\uDD0D", value: snap.searchIndex.exists ? `${snap.searchIndex.rows} 行` : '未构建', label: "\u641C\u7D22\u7D22\u5F15", tone: snap.searchIndex.exists ? 'green' : 'red' }), _jsx(StatCard, { icon: "\uD83D\uDDBC\uFE0F", value: snap.decodedImagesCount, label: "\u89E3\u7801\u7F13\u5B58", tone: "blue" }), _jsx(StatCard, { icon: "\uD83E\uDDEE", value: fmtBytes(snap.decodedImagesBytes), label: "\u7F13\u5B58\u5927\u5C0F" })] }), onNavigate && (_jsx(Card, { title: "\u5FEB\u6377\u5165\u53E3", children: _jsxs("div", { className: css.actions, children: [_jsx("button", { type: "button", className: css.btn, onClick: () => { onNavigate('settings'); }, children: "\u524D\u5F80\u7CFB\u7EDF\u8BBE\u7F6E" }), _jsx("button", { type: "button", className: css.btn, onClick: () => { onNavigate('privacytrust'); }, children: "\u9690\u79C1\u4E0E\u4FE1\u4EFB" }), _jsx("button", { type: "button", className: css.btn, onClick: () => { onNavigate('files'); }, children: "\u6587\u4EF6\u8D44\u4EA7" })] }) })), _jsxs("div", { className: kitCss.cardGrid, children: [_jsx(Card, { title: "\u63D2\u4EF6\u5B58\u50A8\u6587\u4EF6", children: snap.stores.length === 0 ? (_jsx("div", { className: css.empty, children: "\u6682\u65E0\u63D2\u4EF6\u5B58\u50A8\u6587\u4EF6" })) : (_jsx("div", { className: css.storeList, children: snap.stores.map(s => (_jsxs("div", { className: css.storeRow, children: [_jsx("span", { className: css.storeName, children: s.name }), _jsx("span", { className: css.storeSize, children: fmtBytes(s.size) })] }, s.name))) })) }), _jsx(Card, { title: "DB \u72B6\u6001\u6458\u8981", children: (status?.lines ?? []).length === 0 ? (_jsx("div", { className: css.empty, children: "\u6682\u65E0\u72B6\u6001\u884C" })) : (_jsx("div", { className: css.lines, children: status?.lines.map(line => _jsx("div", { className: css.line, children: line }, line)) })) })] })] }))] }));
}
//# sourceMappingURL=Health.js.map