import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 隐私与信任页 — 明示本地/AI 功能边界，并聚合隐私体检结果（敏感信息扫描、
 * 高风险联系人/群）。审计开关与打码自动化为后续项。
 */
import { useCallback, useEffect, useState } from 'react';
import { apiClearPrivacyAudit, apiGetPrivacyAuditRows, apiGetPrivacyState, apiSetPrivacyState, readRenderCache, writeRenderCache } from "../api.js";
import { Card, PanelHeader } from "../ui/kit.js";
import kitCss from '../ui/kit.module.css';
import css from './privacy-trust.module.css';
const LOCAL_FEATURES = [
    '搜索 / 全库统一搜索', '统计与总览', '导出（CSV/HTML/TXT 等）', '关系图谱',
    '资金账本', '联系人 360°', '群聊洞察', '朋友圈洞察', '数据健康', '备份管家', '隐私体检',
];
const AI_FEATURES = [
    { name: '微信问答', desc: '检索本机聊天片段后调用所选模型生成回答' },
    { name: '每日总结', desc: '收集当日消息后调用所选模型生成要点' },
    { name: '周期总结', desc: '收集区间消息后调用所选模型生成要点' },
    { name: '待办提取', desc: '收集最近消息后调用所选模型提取待办 JSON' },
];
/**
 * Render the privacy & trust panel.
 * @returns the privacy trust element tree.
 */
export function PrivacyTrustPanel() {
    const [scan, setScan] = useState(() => readRenderCache('privacy-scan'));
    const [state, setState] = useState(() => readRenderCache('privacy-state'));
    const [rows, setRows] = useState(() => readRenderCache('privacy-audit-rows') ?? []);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const load = useCallback(async () => {
        setLoading(true);
        try {
            const cachedScan = readRenderCache('privacy-scan');
            const cachedState = readRenderCache('privacy-state');
            const cachedRows = readRenderCache('privacy-audit-rows');
            if (cachedScan)
                setScan(cachedScan);
            if (cachedState)
                setState(cachedState);
            if (cachedRows)
                setRows(cachedRows);
            // 全库敏感信息扫描较重：本页只读取设置与审计记录，扫描结果沿用渲染缓存；
            // 需要最新结果时前往「隐私体检」页点击扫描。
            const [st, rws] = await Promise.all([
                apiGetPrivacyState(),
                apiGetPrivacyAuditRows().catch(() => []),
            ]);
            setState(st);
            setRows(rws);
            writeRenderCache('privacy-state', st);
            writeRenderCache('privacy-audit-rows', rws);
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
    const toggle = useCallback(async (key, value) => {
        try {
            setState(await apiSetPrivacyState({ [key]: value }));
        }
        catch (e) {
            setError(e.message);
        }
    }, []);
    const exportAudit = useCallback(() => {
        const header = 'id,feature,ts,chars,sessions,messages';
        const lines = rows.map(r => `${r.id},${r.feature},${r.ts},${r.chars},${r.sessions},${r.messages}`);
        const blob = new Blob(['\uFEFF' + header + '\n' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'wechat-privacy-audit.csv';
        a.click();
        URL.revokeObjectURL(url);
    }, [rows]);
    const clearAudit = useCallback(async () => {
        try {
            await apiClearPrivacyAudit();
            setRows([]);
            setState(await apiGetPrivacyState());
        }
        catch (e) {
            setError(e.message);
        }
    }, []);
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u9690\u79C1\u4E0E\u4FE1\u4EFB", desc: "\u6570\u636E\u8FB9\u754C \u00B7 AI \u51FA\u7F51\u8BF4\u660E \u00B7 \u654F\u611F\u4FE1\u606F\u626B\u63CF\u7ED3\u679C" }), _jsx(Card, { title: "\u6570\u636E\u8FB9\u754C", children: _jsx("p", { className: css.lead, children: "\u5FAE\u4FE1\u6570\u636E\u5728\u672C\u673A\u89E3\u6790/\u5165\u5E93/\u5206\u6790\uFF1B\u68C0\u7D22\u7EDF\u8BA1\u3001\u5BFC\u51FA\u3001\u56FE\u8C31\u3001\u5907\u4EFD\u7B49\u5747\u4E3A\u7EAF\u672C\u5730\u64CD\u4F5C\u3002\u542F\u7528 AI \u529F\u80FD\u65F6\uFF0C\u53EA\u6709\u68C0\u7D22\u5230\u7684\u804A\u5929\u7247\u6BB5\u4F1A\u53D1\u9001\u5230\u6240\u9009 LLM \u6A21\u578B\uFF0C\u53EF\u5728\u6A21\u578B\u8BBE\u7F6E\u4E2D\u66F4\u6362\u6216\u8C03\u6574\u3002" }) }), _jsx(Card, { title: "\u9632\u62A4\u8BBE\u7F6E", children: state ? (_jsxs("div", { className: css.toggles, children: [_jsxs("button", { type: "button", className: css.toggle, "data-active": state.redactSensitive, onClick: () => { void toggle('redactSensitive', !state.redactSensitive); }, children: ["\u654F\u611F\u5B57\u6BB5\u6253\u7801\uFF08\u624B\u673A\u53F7/\u8EAB\u4EFD\u8BC1/\u94F6\u884C\u5361/\u90AE\u7BB1/\u53E3\u4EE4\uFF09 \u00B7 ", state.redactSensitive ? '开' : '关'] }), _jsxs("button", { type: "button", className: css.toggle, "data-active": state.blockOutbound, onClick: () => { void toggle('blockOutbound', !state.blockOutbound); }, children: ["\u7981\u6B62 AI \u51FA\u7F51\uFF08\u95EE\u7B54/\u603B\u7ED3/\u5F85\u529E\u4E0D\u8C03\u7528\u6A21\u578B\uFF09 \u00B7 ", state.blockOutbound ? '开' : '关'] })] })) : (_jsx("div", { className: css.empty, children: "\u8BBE\u7F6E\u52A0\u8F7D\u4E2D\u2026" })) }), _jsxs("div", { className: kitCss.cardGrid, children: [_jsx(Card, { title: "\u7EAF\u672C\u5730\u529F\u80FD", children: _jsx("div", { className: css.chipGrid, children: LOCAL_FEATURES.map(f => _jsxs("span", { className: css.localChip, children: ["\uD83D\uDD12 ", f] }, f)) }) }), _jsx(Card, { title: "AI \u529F\u80FD\uFF08\u51FA\u7F51\uFF09", children: _jsx("div", { className: css.aiList, children: AI_FEATURES.map(f => (_jsxs("div", { className: css.aiRow, children: [_jsxs("span", { className: css.aiName, children: ["\u2601\uFE0F ", f.name] }), _jsx("span", { className: css.aiDesc, children: f.desc })] }, f.name))) }) })] }), _jsxs(Card, { title: "\u9690\u79C1\u4F53\u68C0\uFF08\u654F\u611F\u4FE1\u606F\u626B\u63CF\uFF09", children: [loading && !scan && _jsx("div", { className: css.empty, children: "\u626B\u63CF\u7ED3\u679C\u52A0\u8F7D\u4E2D\u2026" }), !loading && !scan && !error && _jsx("div", { className: css.empty, children: "\u6700\u65B0\u626B\u63CF\u7ED3\u679C\u8BF7\u524D\u5F80\u300C\u9690\u79C1\u4F53\u68C0\u300D\u9875\u70B9\u51FB\u626B\u63CF\u540E\u5C55\u793A" }), error && _jsx("div", { className: css.error, children: error }), scan && (_jsxs(_Fragment, { children: [_jsxs("div", { className: css.scanSummary, children: [_jsxs("span", { className: css.stat, children: [_jsx("b", { children: scan.total_hits }), " \u547D\u4E2D"] }), _jsxs("span", { className: css.stat, children: [_jsx("b", { children: scan.involved_sessions }), " \u4F1A\u8BDD"] })] }), state && (_jsxs("div", { className: css.audit, children: [_jsxs("div", { className: css.auditRow, children: [_jsx("span", { className: css.auditName, children: "AI \u603B\u8C03\u7528" }), _jsx("span", { className: css.auditCount, children: state.audit.total })] }), state.audit.byFeature.map(f => (_jsxs("div", { className: css.auditRow, children: [_jsx("span", { className: css.auditName, children: f.feature }), _jsxs("span", { className: css.auditCount, children: [f.count, " \u00B7 ", f.chars, " \u5B57\u7B26"] })] }, f.feature)))] })), _jsxs("div", { className: css.auditActions, children: [_jsx("button", { type: "button", className: css.btn, onClick: exportAudit, disabled: rows.length === 0, children: "\u5BFC\u51FA\u5BA1\u8BA1 CSV" }), _jsx("button", { type: "button", className: css.btn, onClick: () => { void clearAudit(); }, disabled: state?.audit.total === 0, children: "\u6E05\u7A7A\u5BA1\u8BA1" })] }), _jsx("div", { className: css.catList, children: scan.categories.map(c => (_jsxs("div", { className: css.catRow, children: [_jsx("span", { className: css.catIcon, children: c.icon }), _jsx("span", { className: css.catLabel, children: c.label }), _jsx("span", { className: css.catCount, children: c.count })] }, c.key))) }), scan.top_contacts.length > 0 && (_jsxs("div", { className: css.risk, children: [_jsx("div", { className: css.riskTitle, children: "\u9AD8\u98CE\u9669\u8054\u7CFB\u4EBA" }), _jsx("div", { className: css.chipGrid, children: scan.top_contacts.slice(0, 8).map(t => (_jsxs("span", { className: css.riskChip, children: [t.name, " \u00B7 ", t.count] }, t.username))) })] }))] }))] }), _jsx("p", { className: css.footnote, children: "\u8BF4\u660E\uFF1A\u654F\u611F\u5B57\u6BB5\u6253\u7801\u3001\u7981\u6B62\u51FA\u7F51\u4E0E AI \u8C03\u7528\u5BA1\u8BA1\u5747\u4E3A\u672C\u673A\u5373\u65F6\u751F\u6548\uFF1B\u672C\u5730\u6A21\u578B\u4F18\u5148\u5207\u6362\u4E3A\u540E\u7EED\u9879\u3002" })] }));
}
//# sourceMappingURL=PrivacyTrust.js.map