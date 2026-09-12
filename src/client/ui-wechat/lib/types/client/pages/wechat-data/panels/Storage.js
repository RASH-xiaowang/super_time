import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 存储空间分析 — 仪表盘版：总占用 Hero + 指标卡 + 分类环形图 + 会话/发送者
 * 排行 + 大文件清单。数据经 DSH 后端 Remote（message_resource.db 联表）。
 */
import { useEffect, useState } from 'react';
import { apiGetStorageStats, readRenderCache, writeRenderCache } from "../api.js";
import css from './storage.module.css';
import { Card, CellPrimary, DataTable, Mono, PanelHeader } from "../ui/kit.js";
import kitCss from '../ui/kit.module.css';
const DONUT_COLORS = ['#22d3ee', '#60a5fa', '#4ade80', '#fbbf24', '#f87171', '#c084fc', '#f472b6', '#2dd4bf', '#94a3b8'];
function fmtBytes(n) {
    if (isNaN(n) || n <= 0)
        return '0 B';
    if (n < 1024)
        return `${n} B`;
    if (n < 1048576)
        return `${(n / 1024).toFixed(1)} KB`;
    if (n < 1073741824)
        return `${(n / 1048576).toFixed(1)} MB`;
    return `${(n / 1073741824).toFixed(2)} GB`;
}
function pct(part, whole) {
    return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}
/**
 * Render the storage panel.
 * @param props - optional callback to open a conversation.
 * @returns the storage element tree.
 */
export function StoragePanel({ onOpenChat }) {
    const [stats, setStats] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const load = async () => {
        setError(null);
        const cached = readRenderCache('storage');
        if (cached) {
            setStats(cached);
            setLoading(false);
        }
        else {
            setLoading(true);
        }
        try {
            const fresh = await apiGetStorageStats();
            setStats(fresh);
            writeRenderCache('storage', fresh);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    };
    useEffect(() => { void load(); }, []);
    const cats = (stats?.categories ?? []).slice().sort((a, b) => b.size - a.size);
    const chats = (stats?.chats ?? []).slice().sort((a, b) => b.size - a.size).slice(0, 10);
    const senders = (stats?.senders ?? []).slice().sort((a, b) => b.size - a.size).slice(0, 10);
    const files = (stats?.large_files ?? []).slice().sort((a, b) => b.size - a.size).slice(0, 20);
    const total = stats?.total_size ?? 0;
    const totalCount = stats?.total_count ?? 0;
    const maxChat = Math.max(1, ...chats.map(c => c.size));
    const maxSender = Math.max(1, ...senders.map(c => c.size));
    const topCat = cats[0];
    const topChat = chats[0];
    // 环形图 conic-gradient（按分类大小占比）
    let acc = 0;
    const stops = cats.map((c, i) => {
        const start = acc;
        acc += total > 0 ? (c.size / total) * 100 : 0;
        const color = DONUT_COLORS[i % DONUT_COLORS.length] ?? '#22d3ee';
        return `${color} ${start}% ${acc}%`;
    }).join(', ');
    /** 大文件清单列定义（闭包持有 total 与跳转回调）。 */
    const fileCols = [
        {
            id: 'name',
            header: '文件名',
            cell: f => _jsx(CellPrimary, { children: f.name || '(未知文件名)' }),
            sortValue: f => f.name || '',
        },
        {
            id: 'session',
            header: '所属会话',
            cell: f => (f.username && onOpenChat
                ? _jsx("button", { type: "button", className: css.linkBtn, onClick: () => { onOpenChat(f.username); }, children: f.sessionName || f.username })
                : (f.sessionName || f.username || '—')),
            sortValue: f => f.sessionName || f.username || '',
        },
        {
            id: 'date',
            header: '日期',
            cell: f => _jsx(Mono, { children: f.create_time ? new Date(f.create_time * 1000).toISOString().slice(0, 10) : '--' }),
            sortValue: f => f.create_time || 0,
        },
        {
            id: 'size',
            header: '大小',
            cell: f => _jsx(Mono, { children: fmtBytes(f.size) }),
            sortValue: f => f.size,
            align: 'right',
        },
        {
            id: 'pct',
            header: '占比',
            cell: f => `${pct(f.size, total)}%`,
            sortValue: f => f.size,
            align: 'right',
        },
    ];
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u5B58\u50A8\u7A7A\u95F4\u5206\u6790", desc: "\u6765\u81EA\u6D88\u606F\u8D44\u6E90\u5E93\u7684\u53EA\u8BFB\u7EDF\u8BA1\uFF08\u4E0D\u542B\u672C\u5730\u6570\u636E\u5E93\u672C\u8EAB\uFF09", actions: (_jsx("button", { type: "button", className: css.btn, onClick: () => { void load(); }, disabled: loading, children: loading ? '统计中…' : '刷新' })) }), loading && stats === null && (_jsxs("div", { className: css.skeletonWrap, children: [_jsxs("div", { className: css.skelHero, children: [_jsx("div", { className: css.skelBlock }), _jsx("div", { className: css.skelBlock })] }), _jsxs("div", { className: css.grid, children: [_jsxs("section", { className: css.card, children: [_jsx("h3", { className: css.cardTitle, children: "\u5206\u7C7B\u5206\u5E03" }), _jsx("div", { className: css.skelLine }), _jsx("div", { className: css.skelLine }), _jsx("div", { className: css.skelLine })] }), _jsxs("section", { className: css.card, children: [_jsx("h3", { className: css.cardTitle, children: "\u4F1A\u8BDD\u5360\u7528\u6392\u884C" }), _jsx("div", { className: css.skelLine }), _jsx("div", { className: css.skelLine }), _jsx("div", { className: css.skelLine })] }), _jsxs("section", { className: css.card, children: [_jsx("h3", { className: css.cardTitle, children: "\u53D1\u9001\u8005\u6392\u884C" }), _jsx("div", { className: css.skelLine }), _jsx("div", { className: css.skelLine })] })] })] })), error && _jsxs("div", { className: css.empty, children: ["\u26A0\uFE0F \u5B58\u50A8\u6570\u636E\u8BFB\u53D6\u5931\u8D25\uFF08", error, "\uFF09"] }), !error && stats !== null && (_jsxs(_Fragment, { children: [_jsxs("div", { className: css.hero, children: [_jsxs("div", { className: css.heroMain, children: [_jsx("span", { className: css.heroValue, children: fmtBytes(total) }), _jsx("span", { className: css.heroLabel, children: "\u5A92\u4F53\u8D44\u6E90\u603B\u5360\u7528" })] }), _jsxs("div", { className: css.heroStats, children: [_jsxs("div", { className: css.heroStat, children: [_jsx("span", { className: css.heroStatValue, children: totalCount.toLocaleString() }), _jsx("span", { className: css.heroStatLabel, children: "\u8D44\u6E90\u603B\u6570" })] }), _jsxs("div", { className: css.heroStat, children: [_jsx("span", { className: css.heroStatValue, children: fmtBytes(totalCount > 0 ? total / totalCount : 0) }), _jsx("span", { className: css.heroStatLabel, children: "\u5E73\u5747\u5355\u9879" })] }), _jsxs("div", { className: css.heroStat, children: [_jsxs("span", { className: css.heroStatValue, children: [topCat ? pct(topCat.size, total) : 0, "%"] }), _jsx("span", { className: css.heroStatLabel, children: topCat?.label ?? '—' })] }), _jsxs("div", { className: css.heroStat, children: [_jsxs("span", { className: css.heroStatValue, children: [topChat ? pct(topChat.size, total) : 0, "%"] }), _jsxs("span", { className: css.heroStatLabel, children: ["\u6700\u591A\u4F1A\u8BDD \u00B7 ", topChat?.name || topChat?.username || '—'] })] })] })] }), _jsxs("div", { className: kitCss.cardGrid, children: [_jsx(Card, { title: "\u5206\u7C7B\u5206\u5E03", children: _jsxs("div", { className: css.donutRow, children: [_jsx("div", { className: css.donut, style: { background: `conic-gradient(${stops})` } }), _jsxs("div", { className: css.donutLegend, children: [cats.map((c, i) => (_jsxs("div", { className: css.legendRow, children: [_jsx("span", { className: css.legendDot, style: { background: DONUT_COLORS[i % DONUT_COLORS.length] ?? '#22d3ee' } }), _jsx("span", { className: css.legendLabel, children: c.label }), _jsxs("span", { className: css.legendMeta, children: [c.count.toLocaleString(), " \u9879 \u00B7 ", fmtBytes(c.size), " \u00B7 ", pct(c.size, total), "%"] })] }, c.label))), cats.length === 0 && _jsx("div", { className: css.empty, children: "\u6682\u65E0\u5206\u7C7B\u6570\u636E" })] })] }) }), _jsxs(Card, { title: "\u4F1A\u8BDD\u5360\u7528\u6392\u884C\uFF08Top 10\uFF09", children: [chats.map((c) => {
                                        const name = c.name || c.username || '(未知)';
                                        return (_jsxs("div", { className: css.barRow, style: onOpenChat ? { cursor: 'pointer' } : undefined, onClick: onOpenChat ? () => { onOpenChat(c.username); } : undefined, title: "\u70B9\u51FB\u6253\u5F00\u4F1A\u8BDD", children: [_jsx("span", { className: css.barLabel, children: name }), _jsx("div", { className: css.barTrack, children: _jsx("div", { className: css.barFill, style: { width: `${(c.size / maxChat) * 100}%` } }) }), _jsxs("span", { className: css.barValue, children: [fmtBytes(c.size), " \u00B7 ", pct(c.size, total), "%"] })] }, `${c.username}_${c.name}_${c.count}`));
                                    }), chats.length === 0 && _jsx("div", { className: css.empty, children: "\u6682\u65E0\u6570\u636E" })] }), _jsxs(Card, { title: "\u53D1\u9001\u8005\u6392\u884C\uFF08Top 10\uFF09", children: [senders.map(c => (_jsxs("div", { className: css.barRow, children: [_jsx("span", { className: css.barLabel, children: c.name || c.username || '(未知)' }), _jsx("div", { className: css.barTrack, children: _jsx("div", { className: css.barFill, style: { width: `${(c.size / maxSender) * 100}%` } }) }), _jsxs("span", { className: css.barValue, children: [fmtBytes(c.size), " \u00B7 ", pct(c.size, total), "%"] })] }, `${c.username}_${c.name}_${c.count}`))), senders.length === 0 && _jsx("div", { className: css.empty, children: "\u6682\u65E0\u6570\u636E" })] })] }), _jsx(Card, { title: "\u5927\u6587\u4EF6\u6E05\u5355\uFF08\u6309\u4F53\u79EF Top 20\uFF09", extra: _jsxs("span", { className: css.cardSub, children: ["\u5171 ", files.length, " \u4E2A \u00B7 \u5408\u8BA1 ", fmtBytes(files.reduce((a, f) => a + f.size, 0))] }), flush: true, children: _jsx(DataTable, { columns: fileCols, rows: files, getRowId: (f, i) => `${f.username}-${f.size}-${f.create_time}-${i}`, emptyTitle: "\u6682\u65E0\u5927\u6587\u4EF6" }) })] }))] }));
}
//# sourceMappingURL=Storage.js.map