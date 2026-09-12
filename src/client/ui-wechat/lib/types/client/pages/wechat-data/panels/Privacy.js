import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 隐私体检面板 — React 版，忠实迁移 PrivacyScan.svelte：扫描本地消息中的
 * 隐私风险（手机号/身份证/银行卡/邮箱/密码/地址），按类别聚合样本（可展开/
 * 跳转定位）+ 风险联系人/群 Top10 + CSV 报告导出。走 Remote（getPrivacyScan）。
 */
import { useCallback, useEffect, useState } from 'react';
import { apiExportCsv, apiGetPrivacyScan, readRenderCache, writeRenderCache } from "../api.js";
import { Card, PanelHeader } from "../ui/kit.js";
import css from './list-panel.module.css';
/**
 * Render the privacy-scan panel.
 * @param props - optional callback to jump into a conversation.
 * @returns the privacy element tree.
 */
export function PrivacyPanel({ onOpenChat }) {
    const [data, setData] = useState(() => readRenderCache('privacy-scan'));
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [expanded, setExpanded] = useState(new Set());
    const [showMore, setShowMore] = useState(new Set());
    const scan = useCallback(async () => {
        setLoading(true);
        setError(null);
        const cached = readRenderCache('privacy-scan');
        if (cached)
            setData(cached);
        try {
            const fresh = await apiGetPrivacyScan();
            setData(fresh);
            writeRenderCache('privacy-scan', fresh);
        }
        catch (e) {
            if (!cached)
                setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, []);
    // 全库敏感信息扫描较重：不再在打开页签时自动执行，由用户点击「开始扫描」触发；
    // 已有渲染缓存时直接展示缓存，避免白屏。
    useEffect(() => {
        const cached = readRenderCache('privacy-scan');
        if (cached)
            setData(cached);
    }, []);
    const toggleCat = (key) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(key))
                next.delete(key);
            else
                next.add(key);
            return next;
        });
    };
    const moreSamples = (key) => {
        setShowMore((prev) => {
            const next = new Set(prev);
            if (next.has(key))
                next.delete(key);
            else
                next.add(key);
            return next;
        });
    };
    const exportCsv = async () => {
        try {
            const r = await apiExportCsv({ kind: 'privacy' });
            window.alert(`已导出风险清单 ${r.count} 条 → ${r.path}`);
        }
        catch (e) {
            window.alert('导出失败: ' + e.message);
        }
    };
    const involved = data?.involved_sessions ?? 0;
    const totalHits = data?.total_hits ?? 0;
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u9690\u79C1\u4F53\u68C0", desc: data ? `命中 ${totalHits} 条 · 涉及 ${involved} 个会话` : '扫描手机号 / 身份证 / 银行卡 / 邮箱 / 密码 / 地址等敏感信息', actions: (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: css.catBtn, "data-active": "true", onClick: () => { void scan(); }, disabled: loading, children: loading ? '扫描中…' : data ? '重新扫描' : '开始扫描' }), data && _jsx("button", { type: "button", className: css.catBtn, onClick: () => { void exportCsv(); }, children: "\u5BFC\u51FA\u62A5\u544A" })] })) }), error && _jsxs("div", { className: css.empty, children: ["\u26A0\uFE0F ", error] }), !error && loading && !data && _jsx("div", { className: css.empty, children: "\u6B63\u5728\u626B\u63CF\u672C\u5730\u6D88\u606F\u4E2D\u7684\u654F\u611F\u4FE1\u606F\u2026" }), !error && !loading && !data && _jsx("div", { className: css.empty, children: "\u4F53\u68C0\u4F60\u7684\u5FAE\u4FE1\u6570\u636E\uFF1A\u626B\u63CF\u624B\u673A\u53F7 / \u8EAB\u4EFD\u8BC1 / \u94F6\u884C\u5361 / \u90AE\u7BB1 / \u5BC6\u7801 / \u5730\u5740\u7B49\u654F\u611F\u4FE1\u606F\u3002" }), !error && data && (_jsxs("div", { className: css.scroll, children: [data.categories.map((c) => {
                        const open = expanded.has(c.key);
                        const more = showMore.has(c.key);
                        const samples = c.samples.slice(0, more ? 200 : 5);
                        return (_jsxs("div", { className: css.row, style: { flexDirection: 'column', alignItems: 'stretch', border: '1px solid var(--wc-border)', borderRadius: 10, marginBottom: 8, padding: 10 }, children: [_jsxs("div", { style: { display: 'flex', alignItems: 'center', gap: 8 }, onClick: () => { toggleCat(c.key); }, role: "button", children: [_jsx("span", { className: css.rowIcon, children: c.icon }), _jsx("span", { className: css.rowName, style: { flex: 1 }, children: c.label }), _jsxs("span", { className: css.rowTime, children: [c.count, " \u6761", open ? ' ▾' : ' ▸'] })] }), open && (_jsxs("div", { style: { marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }, children: [samples.length === 0 && _jsx("div", { className: css.empty, style: { padding: 8 }, children: "\u65E0\u547D\u4E2D\u6837\u672C" }), samples.map((s, i) => (_jsxs("div", { style: { fontSize: 12, lineHeight: 1.5 }, children: [_jsxs("div", { style: { display: 'flex', gap: 8, alignItems: 'center' }, children: [_jsx("span", { style: { fontWeight: 600 }, children: s.name || s.username }), _jsx("span", { className: css.rowTime, children: s.time }), onOpenChat && (_jsx("button", { type: "button", className: css.catBtn, style: { marginLeft: 'auto' }, onClick: () => { onOpenChat(s.username, s.local_id); }, children: "\u8DF3\u8F6C \u203A" }))] }), _jsx("div", { className: css.rowMeta, style: { wordBreak: 'break-all' }, children: s.snippet })] }, i))), c.samples.length > 5 && (_jsx("button", { type: "button", className: css.catBtn, style: { alignSelf: 'center' }, onClick: () => { moreSamples(c.key); }, children: more ? '收起' : `展开更多（共 ${c.samples.length} 条）` }))] }))] }, c.key));
                    }), data.top_contacts.length > 0 && (_jsx(Card, { title: "\u98CE\u9669\u8054\u7CFB\u4EBA TOP10", children: data.top_contacts.map((c, i) => (_jsxs("div", { className: css.barRow, children: [_jsxs("span", { className: css.barLabel, children: [i + 1, ". ", c.name || c.username] }), _jsx("div", { className: css.barTrack, children: _jsx("div", { className: css.barFill, style: { width: `${(c.count / (data.top_contacts[0]?.count ?? 1)) * 100}%` } }) }), _jsxs("span", { className: css.barValue, children: [c.count, " \u6761"] })] }, c.username))) })), data.top_groups.length > 0 && (_jsx(Card, { title: "\u98CE\u9669\u7FA4\u804A TOP10", children: data.top_groups.map((c, i) => (_jsxs("div", { className: css.barRow, children: [_jsxs("span", { className: css.barLabel, children: [i + 1, ". ", c.name || c.username] }), _jsx("div", { className: css.barTrack, children: _jsx("div", { className: css.barFill, style: { width: `${(c.count / (data.top_groups[0]?.count ?? 1)) * 100}%` } }) }), _jsxs("span", { className: css.barValue, children: [c.count, " \u6761"] })] }, c.username))) })), totalHits === 0 && _jsx("div", { className: css.empty, children: "\u65E0\u547D\u4E2D \u00B7 \u672C\u5730\u6D88\u606F\u4E2D\u672A\u53D1\u73B0\u654F\u611F\u4FE1\u606F" })] }))] }));
}
//# sourceMappingURL=Privacy.js.map