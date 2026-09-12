import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 待办提取面板 — 从最近聊天中提取待办/提醒（DSH LLM 生成 JSON），本地持久化到
 * wechat_tasks.db；支持手动添加、完成/重开、删除、跳转来源会话。
 */
import { useCallback, useEffect, useState } from 'react';
import { apiAddTask, apiDeleteTask, apiExtractTasks, apiListTasks, apiSetTaskStatus, apiSyncHandoffTasks, readRenderCache, writeRenderCache } from "../api.js";
import { Badge, Card, EmptyState, PanelHeader, Toolbar } from "../ui/kit.js";
import css from './tasks.module.css';
function fmtDue(ts) {
    if (!ts)
        return '';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
/**
 * Render the task extraction panel.
 * @param props - optional chat navigation callback.
 * @returns the tasks element tree.
 */
export function TasksPanel({ onOpenChat } = {}) {
    const [tasks, setTasks] = useState(() => readRenderCache('tasks') ?? []);
    const [manualTitle, setManualTitle] = useState('');
    const [loading, setLoading] = useState(false);
    const [extracting, setExtracting] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const load = useCallback(async () => {
        setLoading(true);
        try {
            const r = await apiListTasks();
            setTasks(r.items);
            writeRenderCache('tasks', r.items);
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
    const notify = (text) => {
        setNotice(text);
        window.setTimeout(() => { setNotice(null); }, 3000);
    };
    const extract = useCallback(async () => {
        setExtracting(true);
        setError(null);
        try {
            const r = await apiExtractTasks({ days: 7 });
            notify(r.ok ? `已提取 ${r.added ?? 0} 条待办` : (r.error ?? '提取失败'));
            await load();
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setExtracting(false);
        }
    }, [load, notify]);
    const syncHandoff = useCallback(async () => {
        setSyncing(true);
        setError(null);
        try {
            const r = await apiSyncHandoffTasks();
            notify(r.ok ? `已导入 ${r.added ?? 0} 条原生提醒` : (r.error ?? '导入失败'));
            await load();
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setSyncing(false);
        }
    }, [load, notify]);
    const addManual = useCallback(async () => {
        const title = manualTitle.trim();
        if (!title)
            return;
        try {
            await apiAddTask({ title });
            setManualTitle('');
            notify('已添加待办');
            await load();
        }
        catch (e) {
            setError(e.message);
        }
    }, [manualTitle, load, notify]);
    const toggle = useCallback(async (t) => {
        const next = t.status === 'open' ? 'done' : 'open';
        try {
            await apiSetTaskStatus({ id: t.id, status: next });
            await load();
        }
        catch (e) {
            setError(e.message);
        }
    }, [load]);
    const remove = useCallback(async (id) => {
        try {
            await apiDeleteTask({ id });
            await load();
        }
        catch (e) {
            setError(e.message);
        }
    }, [load]);
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u5F85\u529E\u63D0\u53D6", desc: "\u6700\u8FD1 7 \u5929\u804A\u5929 \u2192 LLM \u63D0\u53D6\u5F85\u529E/\u63D0\u9192 \u00B7 \u672C\u5730\u5B58\u50A8", actions: (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: css.btn, onClick: () => { void extract(); }, disabled: extracting, children: extracting ? '提取中…' : '提取最近 7 天待办' }), _jsx("button", { type: "button", className: css.btn, onClick: () => { void syncHandoff(); }, disabled: syncing, children: syncing ? '导入中…' : '导入微信原生提醒' })] })) }), _jsx(Toolbar, { left: (_jsxs(_Fragment, { children: [_jsx("input", { type: "text", className: css.input, placeholder: "\u624B\u52A8\u6DFB\u52A0\u5F85\u529E\uFF08\u56DE\u8F66\u786E\u8BA4\uFF09", value: manualTitle, onChange: (e) => { setManualTitle(e.target.value); }, onKeyDown: (e) => { if (e.key === 'Enter')
                                void addManual(); }, "aria-label": "\u624B\u52A8\u6DFB\u52A0\u5F85\u529E" }), _jsx("button", { type: "button", className: css.btn, onClick: () => { void addManual(); }, disabled: !manualTitle.trim(), children: "\u6DFB\u52A0" })] })) }), notice && _jsx("div", { className: css.notice, children: notice }), error && _jsx("div", { className: css.error, role: "alert", children: error }), loading && _jsx("div", { className: css.empty, children: "\u52A0\u8F7D\u4E2D\u2026" }), !loading && tasks.length === 0 && !error && _jsx(EmptyState, { icon: "\u2705", title: "\u6682\u65E0\u5F85\u529E", desc: "\u70B9\u51FB\u53F3\u4E0A\u89D2\u300C\u63D0\u53D6\u6700\u8FD1 7 \u5929\u5F85\u529E\u300D\u81EA\u52A8\u751F\u6210" }), _jsx(Card, { flush: true, children: _jsx("div", { className: css.list, children: tasks.map(t => (_jsxs("div", { className: css.taskRow, "data-status": t.status, children: [_jsxs("div", { className: css.taskInfo, children: [_jsx("div", { className: css.taskTitle, children: t.title }), _jsxs("div", { className: css.taskMeta, children: [fmtDue(t.dueAt) ? `到期 ${fmtDue(t.dueAt)}` : '未设置到期', t.sourceUsername ? (_jsx("button", { type: "button", className: css.linkBtn, onClick: () => { onOpenChat?.(t.sourceUsername ?? '', t.sourceLocalId); }, children: "\u6765\u6E90\u4F1A\u8BDD" })) : null] })] }), _jsxs("div", { className: css.taskActions, children: [_jsx(Badge, { tone: t.status === 'open' ? 'cyan' : 'green', children: t.status === 'open' ? '待办' : '已完成' }), _jsx("button", { type: "button", className: css.btn, onClick: () => { void toggle(t); }, children: t.status === 'open' ? '完成' : '重开' }), _jsx("button", { type: "button", className: css.btn, onClick: () => { void remove(t.id); }, children: "\u5220\u9664" })] })] }, t.id))) }) })] }));
}
//# sourceMappingURL=Tasks.js.map