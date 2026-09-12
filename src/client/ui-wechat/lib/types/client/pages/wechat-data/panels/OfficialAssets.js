import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 公众号内容资产面板 — gh_* 账号的消息/文章规模与最近文章时间，支持跳转
 * 会话查看原文。全部本机离线统计。
 */
import { useCallback, useEffect, useState } from 'react';
import { ListSentinel, useProgressiveList } from "./hooks.js";
import { apiGetOfficialAssets, readRenderCache, writeRenderCache } from "../api.js";
import { Card, CellPrimary, Mono, PanelHeader, StatCard, StatGrid } from "../ui/kit.js";
import css from './official-assets.module.css';
function fmtTs(ts) {
    if (!ts)
        return '—';
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/**
 * Render the official account assets panel.
 * @param props - optional chat navigation callback.
 * @returns the official assets element tree.
 */
export function OfficialAssetsPanel({ onOpenChat } = {}) {
    const [data, setData] = useState(() => readRenderCache('official-assets'));
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const load = useCallback(async () => {
        setLoading(true);
        try {
            const fresh = await apiGetOfficialAssets();
            setData(fresh);
            writeRenderCache('official-assets', fresh);
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
    const { count: rowCount, sentinelRef } = useProgressiveList(data?.rows.length ?? 0, 100);
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u516C\u4F17\u53F7\u5185\u5BB9\u8D44\u4EA7", desc: "gh_* \u8D26\u53F7\u6D88\u606F/\u6587\u7AE0\u89C4\u6A21 \u00B7 \u6700\u8FD1\u6587\u7AE0 \u00B7 \u672C\u5730\u79BB\u7EBF" }), error && _jsx("div", { className: css.error, role: "alert", children: error }), loading && !data && _jsx("div", { className: css.empty, children: "\u7EDF\u8BA1\u4E2D\u2026" }), data && !loading && (_jsxs(_Fragment, { children: [_jsxs(StatGrid, { children: [_jsx(StatCard, { icon: "\uD83D\uDCE2", value: data.total.toLocaleString(), label: "\u516C\u4F17\u53F7", tone: "blue" }), _jsx(StatCard, { icon: "\uD83D\uDCAC", value: data.rows.reduce((a, r) => a + r.messages, 0).toLocaleString(), label: "\u6D88\u606F" }), _jsx(StatCard, { icon: "\uD83D\uDCC4", value: data.rows.reduce((a, r) => a + r.articles, 0).toLocaleString(), label: "\u6587\u7AE0", tone: "purple" }), _jsx(StatCard, { icon: "\uD83D\uDD50", value: data.rows.filter(r => r.articles > 0).length.toLocaleString(), label: "\u6700\u8FD1\u66F4\u65B0", hint: "\u6709\u6587\u7AE0\u8D26\u53F7", tone: "green" })] }), _jsx(Card, { flush: true, title: "\u516C\u4F17\u53F7\u660E\u7EC6", children: _jsxs("div", { className: css.table, children: [_jsxs("div", { className: css.head, children: [_jsx("span", { className: css.colName, children: "\u516C\u4F17\u53F7" }), _jsx("span", { className: css.colNum, children: "\u6D88\u606F" }), _jsx("span", { className: css.colNum, children: "\u6587\u7AE0" }), _jsx("span", { className: css.colTime, children: "\u6700\u8FD1\u6587\u7AE0" })] }), data.rows.length === 0 ? (_jsx("div", { className: css.empty, children: "\u6682\u65E0\u516C\u4F17\u53F7\u5185\u5BB9 \u2014 \u8BF7\u786E\u8BA4\u516C\u4F17\u53F7\u4F1A\u8BDD\u5DF2\u5165\u5E93" })) : (data.rows.slice(0, rowCount).map(r => (_jsxs("button", { type: "button", className: css.row, onClick: () => { onOpenChat?.(r.username); }, title: "\u6253\u5F00\u4F1A\u8BDD", children: [_jsxs("span", { className: css.colName, children: [_jsx(CellPrimary, { children: r.name }), _jsx("span", { className: css.rowUser, children: r.username })] }), _jsx("span", { className: css.colNum, children: r.messages.toLocaleString() }), _jsx("span", { className: css.colNum, children: r.articles.toLocaleString() }), _jsx(Mono, { children: fmtTs(r.lastArticleTime) })] }, r.username)))), data.rows.length > rowCount && _jsx(ListSentinel, { refFn: sentinelRef })] }) })] }))] }));
}
//# sourceMappingURL=OfficialAssets.js.map