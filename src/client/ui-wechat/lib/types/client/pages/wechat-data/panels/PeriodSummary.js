import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 周期总结面板 — 按日期区间（本周/本月/自定义）汇总聊天要点，复用每日
 * 总结的数据收集与 DSH LLM 生成链路，支持复制结果。
 */
import { useCallback, useMemo, useState } from 'react';
import { apiGeneratePeriodSummary } from "../api.js";
import { PanelHeader } from "../ui/kit.js";
import css from './period-summary.module.css';
function localToday() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function addDays(date, n) {
    const d = new Date(date);
    d.setDate(d.getDate() + n);
    return d;
}
function fmt(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/** Ready-made ranges. */
const RANGES = [
    {
        key: 'week', label: '本周',
        range: () => {
            const now = new Date();
            const monday = addDays(now, -((now.getDay() + 6) % 7));
            return { from: fmt(monday), to: fmt(addDays(monday, 6)) };
        },
    },
    {
        key: 'month', label: '本月',
        range: () => {
            const now = new Date();
            return { from: fmt(new Date(now.getFullYear(), now.getMonth(), 1)), to: fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0)) };
        },
    },
    {
        key: 'last-month', label: '上月',
        range: () => {
            const now = new Date();
            return { from: fmt(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: fmt(new Date(now.getFullYear(), now.getMonth(), 0)) };
        },
    },
];
/**
 * Render the period summary panel.
 * @returns the period summary element tree.
 */
export function PeriodSummaryPanel() {
    const today = localToday();
    const [from, setFrom] = useState(today);
    const [to, setTo] = useState(today);
    const [result, setResult] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const applyRange = useCallback((key) => {
        const r = RANGES.find(x => x.key === key)?.range();
        if (r) {
            setFrom(r.from);
            setTo(r.to);
        }
    }, []);
    const generate = useCallback(async () => {
        if (!from || !to)
            return;
        setLoading(true);
        setError(null);
        try {
            const r = await apiGeneratePeriodSummary({ from, to });
            setResult(r);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, [from, to]);
    const copyResult = useCallback(async () => {
        if (!result)
            return;
        try {
            await navigator.clipboard.writeText(result.summary);
            setNotice('已复制总结');
            window.setTimeout(() => { setNotice(null); }, 3000);
        }
        catch {
            setNotice('复制失败');
        }
    }, [result]);
    const rangeText = useMemo(() => (from && to ? `${from} ~ ${to}` : '未选择日期'), [from, to]);
    const typesText = useMemo(() => {
        if (!result)
            return '';
        return Object.entries(result.types).map(([k, v]) => `${k} ${v}`).join(' · ');
    }, [result]);
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u5468\u671F\u603B\u7ED3", desc: "\u6309\u65E5\u671F\u533A\u95F4\u6C47\u603B\u804A\u5929\u8981\u70B9 \u00B7 \u590D\u7528\u6BCF\u65E5\u603B\u7ED3\u94FE\u8DEF\uFF08DSH LLM\uFF09" }), _jsxs("div", { className: css.formCard, children: [_jsxs("div", { className: css.row, children: [_jsx("label", { className: css.fieldLabel, htmlFor: "period-from", children: "\u4ECE" }), _jsx("input", { id: "period-from", className: css.input, type: "date", value: from, onChange: (e) => { setFrom(e.target.value); } }), _jsx("label", { className: css.fieldLabel, htmlFor: "period-to", children: "\u5230" }), _jsx("input", { id: "period-to", className: css.input, type: "date", value: to, onChange: (e) => { setTo(e.target.value); } })] }), _jsxs("div", { className: css.row, children: [RANGES.map(r => (_jsx("button", { type: "button", className: css.btn, onClick: () => { applyRange(r.key); }, children: r.label }, r.key))), _jsx("button", { type: "button", className: css.btn, "data-active": "true", onClick: () => { void generate(); }, disabled: loading, children: loading ? '生成中…' : '生成总结' }), _jsx("button", { type: "button", className: css.btn, onClick: () => { void copyResult(); }, disabled: !result, children: "\u590D\u5236\u7ED3\u679C" })] }), _jsxs("div", { className: css.rangeText, children: ["\u5F53\u524D\u533A\u95F4\uFF1A", rangeText] })] }), notice && _jsx("div", { className: css.notice, children: notice }), error && _jsx("div", { className: css.error, role: "alert", children: error }), loading && _jsx("div", { className: css.loading, children: "\u6B63\u5728\u6536\u96C6\u533A\u95F4\u6D88\u606F\u5E76\u751F\u6210\u603B\u7ED3\u2026" }), result && !loading && (_jsxs("div", { className: css.resultCard, children: [_jsx("div", { className: css.cardTitle, children: "\u603B\u7ED3" }), _jsxs("div", { className: css.stats, children: [_jsxs("span", { className: css.stat, children: [_jsx("b", { children: result.total.toLocaleString() }), " \u6D88\u606F"] }), _jsxs("span", { className: css.stat, children: [_jsx("b", { children: result.sessions }), " \u6D3B\u8DC3\u4F1A\u8BDD"] }), _jsxs("span", { className: css.stat, children: [_jsx("b", { children: result.messages }), " \u6587\u672C\u884C"] })] }), typesText && _jsx("div", { className: css.types, children: typesText }), result.topSessions.length > 0 && (_jsx("div", { className: css.topSessions, children: result.topSessions.slice(0, 5).map(s => (_jsxs("span", { className: css.topChip, children: [s.username, " \u00B7 ", s.count] }, s.username))) })), _jsx("div", { className: css.summary, children: result.summary })] }))] }));
}
//# sourceMappingURL=PeriodSummary.js.map