import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 媒体资产馆（v1 盘点）— hardlink 图片/文件/视频规模、总占用与重复 md5
 * 清单。空间治理的可执行动作（去重/清理）为后续项。
 */
import { useCallback, useEffect, useState } from 'react';
import { ListSentinel, useProgressiveList, useWechatDataUpdated } from "./hooks.js";
import { apiGetMediaAssets, readRenderCache, writeRenderCache } from "../api.js";
import { Card, Mono, PanelHeader, StatCard, StatGrid } from "../ui/kit.js";
import css from './media-assets.module.css';
function fmtBytes(n) {
    if (n <= 0)
        return '0 B';
    if (n < 1048576)
        return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
}
/**
 * Render the media assets panel.
 * @param props - optional tab navigation callback for quick jumps.
 * @returns the media assets element tree.
 */
export function MediaAssetsPanel({ onNavigate } = {}) {
    const [data, setData] = useState(() => readRenderCache('media-assets'));
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const load = useCallback(async () => {
        // 安静 SWR：有渲染缓存时先展示缓存（不闪整页），后台再刷新。
        const cached = readRenderCache('media-assets');
        if (cached)
            setLoading(false);
        else
            setLoading(true);
        setError(null);
        try {
            const fresh = await apiGetMediaAssets();
            setData(fresh);
            writeRenderCache('media-assets', fresh);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);
    // 新媒体随真实同步落地后安静刷新。
    useWechatDataUpdated(() => { void load(); });
    const { count: dupCount, sentinelRef } = useProgressiveList(data?.duplicates.length ?? 0, 100);
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u5A92\u4F53\u8D44\u4EA7\u9986", desc: "\u56FE\u7247/\u6587\u4EF6/\u89C6\u9891\u89C4\u6A21 \u00B7 \u91CD\u590D\u8D44\u4EA7\u6E05\u5355 \u00B7 \u672C\u5730\u76D8\u70B9" }), error && _jsx("div", { className: css.error, role: "alert", children: error }), loading && !data && _jsx("div", { className: css.empty, children: "\u7EDF\u8BA1\u4E2D\u2026" }), data && !loading && (_jsxs(_Fragment, { children: [_jsxs(StatGrid, { children: [data.categories.map(c => (_jsx(StatCard, { icon: "\uD83D\uDDC2\uFE0F", value: c.count.toLocaleString(), label: c.category, hint: fmtBytes(c.size) }, c.category))), _jsx(StatCard, { icon: "\uD83E\uDDEE", value: data.totalFiles.toLocaleString(), label: "\u5408\u8BA1", hint: fmtBytes(data.totalBytes), tone: "blue" }), _jsx(StatCard, { icon: "\u267B\uFE0F", value: data.duplicateFiles.toLocaleString(), label: "\u91CD\u590D\u6587\u4EF6", hint: fmtBytes(data.duplicateBytes), tone: "amber" }), _jsx(StatCard, { icon: "\u2728", value: fmtBytes(data.reclaimBytes), label: "\u53EF\u56DE\u6536\u4F30\u7B97", hint: "\u53BB\u91CD\u540E\uFF08\u53EA\u8BFB\uFF09", tone: "green" })] }), onNavigate && (_jsx(Card, { title: "\u5FEB\u6377\u5165\u53E3", children: _jsxs("div", { className: css.actions, children: [_jsx("button", { type: "button", className: css.actionBtn, onClick: () => { onNavigate('files'); }, children: "\u67E5\u770B\u6587\u4EF6\u8D44\u4EA7" }), _jsx("button", { type: "button", className: css.actionBtn, onClick: () => { onNavigate('storage'); }, children: "\u67E5\u770B\u5B58\u50A8\u5360\u7528" }), _jsx("button", { type: "button", className: css.actionBtn, onClick: () => { onNavigate('health'); }, children: "\u6570\u636E\u5065\u5EB7\u68C0\u67E5" })] }) })), _jsx(Card, { title: "\u91CD\u590D\u8D44\u4EA7\uFF08md5 \u76F8\u540C\uFF0C\u5F85\u53BB\u91CD\uFF09", children: data.duplicates.length === 0 ? _jsx("div", { className: css.empty, children: "\u672A\u53D1\u73B0\u91CD\u590D\u8D44\u4EA7" }) : (_jsxs("div", { className: css.dupList, children: [data.duplicates.slice(0, dupCount).map(d => (_jsxs("div", { className: css.dupRow, children: [_jsx(Mono, { children: d.md5 }), _jsxs("span", { className: css.dupCount, children: [d.count, " \u4EFD \u00B7 ", fmtBytes(d.size), " \u00B7 \u53EF\u56DE\u6536 ", fmtBytes(d.reclaimBytes)] })] }, d.md5))), data.duplicates.length > dupCount && _jsx(ListSentinel, { refFn: sentinelRef })] })) }), _jsx("p", { className: css.footnote, children: "\u53BB\u91CD/\u6E05\u7406\u52A8\u4F5C\u4E0E\u79BB\u7EBF\u539F\u56FE\u5173\u8054\u4E3A\u540E\u7EED\u9879\uFF1B\u672C\u9875\u5148\u505A\u53EA\u8BFB\u76D8\u70B9\uFF0C\u660E\u7EC6\u53EF\u8DF3\u300C\u6587\u4EF6\u8D44\u4EA7\u300D\u4E0E\u300C\u5B58\u50A8\u5360\u7528\u300D\u3002" })] }))] }));
}
//# sourceMappingURL=MediaAssets.js.map