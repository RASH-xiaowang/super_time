import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 朋友圈洞察面板 — 我的朋友圈：发布/获赞/评论统计、互动 Top、月度分布、
 * 那年今天。全部基于本机 sns.db 离线计算。
 */
import { useCallback, useEffect, useState } from 'react';
import { apiGetMomentsInsights, readRenderCache, writeRenderCache } from "../api.js";
import { Card, PanelHeader, StatCard, StatGrid } from "../ui/kit.js";
import kitCss from '../ui/kit.module.css';
import css from './moments-insights.module.css';
function fmtTs(ts) {
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/**
 * Render the moments insights panel.
 * @returns the insights element tree.
 */
export function MomentsInsightsPanel() {
    const [data, setData] = useState(() => readRenderCache('moments-insights'));
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const load = useCallback(async () => {
        setLoading(true);
        try {
            const fresh = await apiGetMomentsInsights();
            setData(fresh);
            writeRenderCache('moments-insights', fresh);
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
    const maxMonthly = data && data.monthly.length > 0 ? Math.max(...data.monthly.map(m => m.count)) : 1;
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u670B\u53CB\u5708\u6D1E\u5BDF", desc: "\u6211\u7684\u53D1\u5E03/\u83B7\u8D5E/\u8BC4\u8BBA\u7EDF\u8BA1 \u00B7 \u4E92\u52A8 Top \u00B7 \u90A3\u5E74\u4ECA\u5929" }), error && _jsx("div", { className: css.error, role: "alert", children: error }), loading && !data && _jsx("div", { className: css.empty, children: "\u7EDF\u8BA1\u4E2D\u2026" }), data && !loading && (_jsxs(_Fragment, { children: [_jsxs(StatGrid, { children: [_jsx(StatCard, { icon: "\uD83D\uDCDD", value: data.posts, label: "\u53D1\u5E03" }), _jsx(StatCard, { icon: "\u2764\uFE0F", value: data.likes, label: "\u83B7\u8D5E", tone: "green" }), _jsx(StatCard, { icon: "\uD83D\uDCAC", value: data.comments, label: "\u8BC4\u8BBA", tone: "purple" })] }), _jsxs("div", { className: kitCss.cardGrid, children: [_jsx(Card, { title: "\u70B9\u8D5E\u6700\u591A\u7684\u4EBA", children: data.likedBy.length === 0 ? _jsx("div", { className: css.empty, children: "\u6682\u65E0\u70B9\u8D5E\u6570\u636E" }) : (_jsx("div", { className: css.list, children: data.likedBy.slice(0, 5).map(r => (_jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: r.nickname || r.username }), _jsx("span", { className: css.rowCount, children: r.count })] }, r.username || r.nickname))) })) }), _jsx(Card, { title: "\u8BC4\u8BBA\u6700\u591A\u7684\u4EBA", children: data.commenters.length === 0 ? _jsx("div", { className: css.empty, children: "\u6682\u65E0\u8BC4\u8BBA\u6570\u636E" }) : (_jsx("div", { className: css.list, children: data.commenters.slice(0, 5).map(r => (_jsxs("div", { className: css.row, children: [_jsx("span", { className: css.rowName, children: r.nickname || r.username }), _jsx("span", { className: css.rowCount, children: r.count })] }, r.username || r.nickname))) })) })] }), _jsxs("div", { className: kitCss.cardGrid, children: [_jsx(Card, { title: "\u6708\u5EA6\u53D1\u5E03\u5206\u5E03", children: data.monthly.length === 0 ? _jsx("div", { className: css.empty, children: "\u6682\u65E0\u53D1\u5E03\u6570\u636E" }) : (_jsx("div", { className: css.monthly, children: data.monthly.map(m => (_jsxs("div", { className: css.monthRow, children: [_jsx("span", { className: css.monthLabel, children: m.month }), _jsx("div", { className: css.monthTrack, children: _jsx("div", { className: css.monthFill, style: { width: `${Math.round((m.count / maxMonthly) * 100)}%` } }) }), _jsx("span", { className: css.monthCount, children: m.count })] }, m.month))) })) }), _jsx(Card, { title: "\u90A3\u5E74\u4ECA\u5929", children: data.today.length === 0 ? _jsx("div", { className: css.empty, children: "\u4ECA\u5929\u6CA1\u6709\u5386\u53F2\u670B\u53CB\u5708" }) : (_jsx("div", { className: css.todayList, children: data.today.map(t => (_jsxs("div", { className: css.todayRow, children: [_jsx("span", { className: css.todayTime, children: fmtTs(t.ts) }), _jsx("span", { className: css.todayText, children: t.text || '（无文字）' })] }, t.tid))) })) })] })] }))] }));
}
//# sourceMappingURL=MomentsInsights.js.map