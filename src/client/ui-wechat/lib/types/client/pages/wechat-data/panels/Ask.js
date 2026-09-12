import { jsxs as _jsxs, Fragment as _Fragment, jsx as _jsx } from "react/jsx-runtime";
/**
 * 微信问答面板 — 基于本机聊天记录检索 + DSH LLM 生成回答，引用可点击跳转。
 * 检索在本机完成；AI 生成会调用当前配置的模型（出网提示见界面）。
 */
import { useCallback, useState } from 'react';
import { apiAskWechat, apiGetSessions } from "../api.js";
import { Badge, Card, PanelHeader, Select } from "../ui/kit.js";
import css from './ask.module.css';
const EXAMPLES = [
    '上周三我和李四聊了什么？',
    '谁答应过我下周交报告？',
    '最近一次转账给我的是谁？',
];
/**
 * Render the WeChat Q&A panel.
 * @param props - optional chat navigation callback.
 * @returns the ask panel element tree.
 */
export function AskPanel({ onOpenChat } = {}) {
    const [sessions, setSessions] = useState([]);
    const [scopeUsername, setScopeUsername] = useState('');
    const [from, setFrom] = useState('');
    const [to, setTo] = useState('');
    const [question, setQuestion] = useState('');
    const [result, setResult] = useState(null);
    const [error, setError] = useState(null);
    const [asking, setAsking] = useState(false);
    const loadSessions = useCallback(async () => {
        try {
            const env = await apiGetSessions({ limit: 500 });
            setSessions(env.sessions);
        }
        catch {
            /* 会话列表加载失败不阻塞提问 */
        }
    }, []);
    // 会话选项在用户实际打开范围选择器时再加载，不在进入页签时拉全量会话。
    // （Remote 侧带 30s 快照缓存，重复聚焦不会重复请求。）
    const ask = useCallback(async () => {
        const q = question.trim();
        if (!q || asking)
            return;
        setAsking(true);
        setError(null);
        try {
            const r = await apiAskWechat({
                question: q,
                ...(scopeUsername ? { username: scopeUsername } : {}),
                ...(from ? { from } : {}),
                ...(to ? { to } : {}),
            });
            setResult(r);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setAsking(false);
        }
    }, [question, asking, scopeUsername, from, to]);
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u5FAE\u4FE1\u95EE\u7B54", desc: "\u57FA\u4E8E\u672C\u673A\u5FAE\u4FE1\u804A\u5929\u8BB0\u5F55\u68C0\u7D22\u56DE\u7B54 \u00B7 \u5F15\u7528\u53EF\u70B9\u51FB\u8DF3\u8F6C\u539F\u6587", actions: (_jsxs(_Fragment, { children: [_jsxs(Badge, { tone: "cyan", children: [sessions.length, " \u53EF\u68C0\u7D22\u4F1A\u8BDD"] }), result && _jsxs(Badge, { tone: "purple", children: [result.citations.length, " \u5F15\u7528\u6765\u6E90"] }), result && _jsxs(Badge, { tone: "green", children: [result.answer.length, " \u56DE\u7B54\u5B57\u7B26"] })] })) }), _jsxs(Card, { title: "\u63D0\u95EE", children: [_jsxs("div", { className: css.row, children: [_jsx("label", { className: css.fieldLabel, htmlFor: "ask-scope", children: "\u4F1A\u8BDD\u8303\u56F4" }), _jsx(Select, { value: scopeUsername, onChange: (v) => { setScopeUsername(v); }, options: [{ value: '', label: '全部会话' }, ...sessions.map(s => ({ value: s.username, label: s.displayName || s.username }))], onOpen: () => { void loadSessions(); }, ariaLabel: "\u4F1A\u8BDD\u8303\u56F4" }), _jsx("label", { className: css.fieldLabel, htmlFor: "ask-from", children: "\u4ECE" }), _jsx("input", { id: "ask-from", className: css.input, type: "date", value: from, onChange: (e) => { setFrom(e.target.value); } }), _jsx("label", { className: css.fieldLabel, htmlFor: "ask-to", children: "\u5230" }), _jsx("input", { id: "ask-to", className: css.input, type: "date", value: to, onChange: (e) => { setTo(e.target.value); } })] }), _jsx("textarea", { className: css.textarea, value: question, onChange: (e) => { setQuestion(e.target.value); }, placeholder: "\u4F8B\u5982\uFF1A\u4E0A\u5468\u6211\u548C\u5F20\u4E09\u804A\u4E86\u4EC0\u4E48\uFF1F", rows: 4, "aria-label": "\u5FAE\u4FE1\u95EE\u7B54\u95EE\u9898" }), _jsxs("div", { className: css.actions, children: [_jsx("button", { type: "button", className: css.askBtn, onClick: () => { void ask(); }, disabled: !question.trim() || asking, children: asking ? '检索与生成中…' : '提问' }), (question.trim() || result || error) && (_jsx("button", { type: "button", className: css.clearBtn, onClick: () => { setQuestion(''); setResult(null); setError(null); }, children: "\u6E05\u7A7A" })), _jsx("span", { className: css.egress, children: "\uD83D\uDD12 \u68C0\u7D22\u5728\u672C\u673A\u5B8C\u6210\uFF1BAI \u751F\u6210\u4F1A\u628A\u68C0\u7D22\u7247\u6BB5\u53D1\u9001\u5230\u6240\u9009\u6A21\u578B\uFF08\u53EF\u5728\u300C\u9690\u79C1\u4E0E\u4FE1\u4EFB\u300D\u4E2D\u5173\u95ED\u51FA\u7F51\uFF09" })] })] }), error && _jsx("div", { className: css.error, role: "alert", children: error }), asking && _jsx("div", { className: css.loading, children: "\u6B63\u5728\u68C0\u7D22\u672C\u673A\u804A\u5929\u8BB0\u5F55\u5E76\u751F\u6210\u56DE\u7B54\u2026" }), result && !asking && (_jsxs(Card, { title: "\u56DE\u7B54", children: [_jsx("div", { className: css.answer, children: result.answer }), result.citations.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: css.citesTitle, children: "\u6765\u6E90\uFF08\u70B9\u51FB\u8DF3\u8F6C\u539F\u6587\uFF09" }), _jsx("div", { className: css.cites, children: result.citations.map((c, i) => (_jsxs("button", { type: "button", className: css.citeBtn, onClick: () => { onOpenChat?.(c.username, c.local_id); }, title: `${c.name} · ${c.time} · ${c.snippet}`, children: [_jsxs("span", { className: css.citeIdx, children: ["[", i + 1, "]"] }), _jsx("span", { className: css.citeName, children: c.name }), _jsx("span", { className: css.citeTime, children: c.time }), _jsx("span", { className: css.citeSnippet, children: c.snippet })] }, `${c.username}:${c.local_id}:${i}`))) })] }))] })), !result && !asking && !error && (_jsxs("div", { className: css.tip, children: [_jsx("div", { className: css.tipTitle, children: "\u53EF\u4EE5\u8FD9\u6837\u95EE\uFF08\u70B9\u51FB\u793A\u4F8B\u76F4\u63A5\u586B\u5145\uFF09" }), _jsx("div", { className: css.exampleGrid, children: EXAMPLES.map(ex => (_jsx("button", { type: "button", className: css.exampleBtn, onClick: () => { setQuestion(ex); setResult(null); setError(null); }, children: ex }, ex))) }), _jsx("p", { className: css.tipText, children: "\u56DE\u7B54\u4F1A\u9644\u4E0A\u53EF\u8DF3\u8F6C\u7684\u672C\u673A\u804A\u5929\u6765\u6E90\uFF1B\u68C0\u7D22\u5728\u672C\u673A\u5B8C\u6210\uFF0C\u4EC5\u628A\u68C0\u7D22\u7247\u6BB5\u53D1\u9001\u5230\u6240\u9009\u6A21\u578B\u3002" })] }))] }));
}
//# sourceMappingURL=Ask.js.map