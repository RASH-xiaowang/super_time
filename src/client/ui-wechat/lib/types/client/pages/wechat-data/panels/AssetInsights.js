import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 收藏/表情资产洞察 — 收藏类型与年份分布、表情包/文案规模、最常使用的
 * 表情 md5 排行。全部本机离线计算。
 */
import { useCallback, useEffect, useState } from 'react';
import { apiGetAssetInsights, readRenderCache, writeRenderCache } from "../api.js";
import { Card, PanelHeader, StatCard, StatGrid } from "../ui/kit.js";
import kitCss from '../ui/kit.module.css';
import css from './asset-insights.module.css';
/**
 * Render the asset insights panel.
 * @returns the asset insights element tree.
 */
export function AssetInsightsPanel() {
    const [data, setData] = useState(() => readRenderCache('asset-insights'));
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const load = useCallback(async () => {
        setLoading(true);
        try {
            const fresh = await apiGetAssetInsights();
            setData(fresh);
            writeRenderCache('asset-insights', fresh);
            setError(null);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);
    const maxYear = data && data.favorites.byYear.length > 0 ? Math.max(...data.favorites.byYear.map(y => y.count)) : 1;
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u6536\u85CF/\u8868\u60C5\u8D44\u4EA7", desc: "\u6536\u85CF\u7C7B\u578B\u4E0E\u5E74\u4EFD\u5206\u5E03 \u00B7 \u8868\u60C5\u89C4\u6A21 \u00B7 \u5E38\u7528\u8868\u60C5\u6392\u884C" }), error && _jsx("div", { className: css.error, role: "alert", children: error }), loading && !data && _jsx("div", { className: css.empty, children: "\u7EDF\u8BA1\u4E2D\u2026" }), data && !loading && (_jsxs(_Fragment, { children: [_jsxs(StatGrid, { children: [_jsx(StatCard, { icon: "\u2B50", value: data.favorites.total, label: "\u6536\u85CF\u603B\u6570", tone: "amber" }), _jsx(StatCard, { icon: "\uD83D\uDE00", value: data.emoticons.customCount, label: "\u81EA\u5B9A\u4E49\u8868\u60C5", tone: "green" }), _jsx(StatCard, { icon: "\uD83D\uDCE6", value: data.emoticons.storePackages, label: "\u8868\u60C5\u5305", tone: "purple" }), _jsx(StatCard, { icon: "\uD83D\uDCAC", value: data.emoticons.captions, label: "\u8868\u60C5\u6587\u6848", tone: "blue" })] }), _jsxs("div", { className: kitCss.cardGrid, children: [_jsx(Card, { title: "\u6536\u85CF\u7C7B\u578B\u5206\u5E03", children: data.favorites.byType.length === 0 ? _jsx("div", { className: css.empty, children: "\u6682\u65E0\u6536\u85CF" }) : (_jsx("div", { className: css.typeList, children: data.favorites.byType.map(t => (_jsxs("div", { className: css.typeRow, children: [_jsx("span", { className: css.typeLabel, children: t.label }), _jsx("span", { className: css.typeCount, children: t.count })] }, t.type))) })) }), _jsx(Card, { title: "\u6536\u85CF\u5E74\u4EFD\u5206\u5E03", children: data.favorites.byYear.length === 0 ? _jsx("div", { className: css.empty, children: "\u6682\u65E0\u6536\u85CF" }) : (_jsx("div", { className: css.yearList, children: data.favorites.byYear.slice(0, 12).map(y => (_jsxs("div", { className: css.yearRow, children: [_jsx("span", { className: css.yearLabel, children: y.year }), _jsx("div", { className: css.yearTrack, children: _jsx("div", { className: css.yearFill, style: { width: `${Math.round((y.count / maxYear) * 100)}%` } }) }), _jsx("span", { className: css.yearCount, children: y.count })] }, y.year))) })) })] }), _jsx(Card, { title: "\u5E38\u7528\u8868\u60C5 Top 10", children: data.emoticons.topUsed.length === 0 ? _jsx("div", { className: css.empty, children: "\u6682\u65E0\u4F7F\u7528\u8BB0\u5F55" }) : (_jsx("div", { className: css.emojiList, children: data.emoticons.topUsed.map(e => (_jsxs("div", { className: css.emojiRow, children: [_jsx("span", { className: css.emojiMd5, children: e.md5 }), _jsxs("span", { className: css.emojiCount, children: [e.count, " \u6B21"] })] }, e.md5))) })) })] }))] }));
}
//# sourceMappingURL=AssetInsights.js.map