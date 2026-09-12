import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 群聊离线洞察面板 — 选择群聊后展示总量/活跃天数/人均/群公告/成员发言排行。
 * 全部基于本机解密库离线统计。
 */
import { useCallback, useEffect, useState } from 'react';
import { apiGetGroupInsights, apiGetSessions, readRenderCache, writeRenderCache } from "../api.js";
import { Card, PanelHeader, Select, StatCard, StatGrid } from "../ui/kit.js";
import kitCss from '../ui/kit.module.css';
import css from './group-insights.module.css';
function fmtTs(ts) {
    if (!ts)
        return '—';
    const d = new Date(ts * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/**
 * Render the offline group insights panel.
 * @param props - optional chat navigation + tab navigation callbacks.
 * @returns the insights element tree.
 */
export function GroupInsightsPanel({ onOpenChat, onNavigate, } = {}) {
    const [groups, setGroups] = useState([]);
    const [username, setUsername] = useState('');
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const loadGroups = useCallback(async () => {
        try {
            const env = await apiGetSessions({ limit: 500 });
            const gs = env.sessions.filter(s => s.username.endsWith('@chatroom') || s.type === 'group');
            setGroups(gs);
            // 不再自动选择第一个群并立刻做全量统计；由用户点选后才按需计算。
        }
        catch {
            /* keep */
        }
    }, [username]);
    useEffect(() => { void loadGroups(); }, [loadGroups]);
    useEffect(() => {
        if (!username)
            return;
        let alive = true;
        setLoading(true);
        setError(null);
        const cached = readRenderCache('group-insights:' + username);
        if (cached) {
            setData(cached);
            setLoading(false);
        }
        void apiGetGroupInsights(username)
            .then((r) => {
            if (!alive)
                return;
            setData(r);
            writeRenderCache('group-insights:' + username, r);
        })
            .catch((e) => { if (alive && !cached)
            setError(e.message); })
            .finally(() => { if (alive)
            setLoading(false); });
        return () => { alive = false; };
    }, [username]);
    const maxCount = data && data.topMembers.length > 0 ? Math.max(...data.topMembers.map(m => m.count)) : 1;
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u7FA4\u804A\u79BB\u7EBF\u6D1E\u5BDF", desc: "\u603B\u91CF/\u6D3B\u8DC3\u5929\u6570/\u7FA4\u516C\u544A/\u6210\u5458\u53D1\u8A00\u6392\u884C \u00B7 \u4EC5\u672C\u5730\u8BA1\u7B97", actions: (_jsx(Select, { value: username, onChange: (v) => { setUsername(v); }, options: groups.map(g => ({ value: g.username, label: g.displayName || g.username })), placeholder: "\u9009\u62E9\u7FA4\u804A\u2026", ariaLabel: "\u9009\u62E9\u7FA4\u804A" })) }), error && _jsx("div", { className: css.error, role: "alert", children: error }), loading && _jsx("div", { className: css.empty, children: "\u7EDF\u8BA1\u4E2D\u2026" }), !loading && !data && !error && !username && _jsx("div", { className: css.empty, children: "\u8BF7\u9009\u62E9\u4E0A\u65B9\u7FA4\u804A\u540E\u67E5\u770B\u6D1E\u5BDF" }), data && !loading && (_jsxs(_Fragment, { children: [_jsxs(StatGrid, { children: [_jsx(StatCard, { icon: "\uD83D\uDC65", value: data.memberCount, label: "\u6210\u5458" }), _jsx(StatCard, { icon: "\uD83D\uDCAC", value: data.total.toLocaleString(), label: "\u6D88\u606F\u603B\u6570", tone: "purple" }), _jsx(StatCard, { icon: "\uD83D\uDCC5", value: data.activeDays, label: "\u6D3B\u8DC3\u5929\u6570", tone: "green" }), _jsx(StatCard, { icon: "\u2696\uFE0F", value: data.avgPerDay.toFixed(1), label: "\u65E5\u5747", tone: "blue" }), _jsx(StatCard, { icon: "\uD83D\uDD50", value: fmtTs(data.from), label: "\u9996\u6B21", tone: "amber" }), _jsx(StatCard, { icon: "\uD83D\uDD51", value: fmtTs(data.to), label: "\u6700\u8FD1" })] }), (onOpenChat || onNavigate) && (_jsxs("div", { className: css.actions, children: [onOpenChat && _jsx("button", { type: "button", className: css.btn, onClick: () => { onOpenChat(data.username); }, children: "\u6253\u5F00\u5B8C\u6574\u4F1A\u8BDD" }), onNavigate && _jsx("button", { type: "button", className: css.btn, onClick: () => { onNavigate('monitor'); }, children: "\u7FA4\u804A\u6D3B\u8DC3\u76D1\u63A7" }), onNavigate && _jsx("button", { type: "button", className: css.btn, onClick: () => { onNavigate('contacts'); }, children: "\u901A\u8BAF\u5F55\u7BA1\u7406" })] })), _jsxs("div", { className: kitCss.cardGrid, children: [_jsx(Card, { title: `成员发言排行 Top ${data.topMembers.length}`, children: data.topMembers.length === 0 ? (_jsx("div", { className: css.empty, children: "\u6682\u65E0\u6210\u5458\u53D1\u8A00\u6570\u636E" })) : (_jsx("div", { className: css.bars, children: data.topMembers.map(m => (_jsxs("div", { className: css.barRow, children: [_jsx("span", { className: css.barName, children: m.name }), _jsx("div", { className: css.barTrack, children: _jsx("div", { className: css.barFill, style: { width: `${Math.round((m.count / maxCount) * 100)}%` } }) }), _jsx("span", { className: css.barCount, children: m.count })] }, m.username))) })) }), _jsx(Card, { title: "\u7FA4\u516C\u544A", children: data.announcement ? (_jsx("div", { className: css.announcement, children: data.announcement })) : (_jsx("div", { className: css.empty, children: "\u6682\u65E0\u7FA4\u516C\u544A" })) })] })] }))] }));
}
//# sourceMappingURL=GroupInsights.js.map