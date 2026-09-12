import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 每日总结面板 — React 版，忠实迁移 DailySummary + DailySummaryForm：
 * 按日期生成总结 + 定时任务 CRUD（群聊选择/关注成员/分析格式/自定义提示词/
 * 定时时间/启停/复制为新任务）+ 历史记录查看/复制/删除。走 Remote，无 HTTP。
 * 每个按钮都提供结果反馈：全局 toast（成功/失败/提示）+ 逐动作 loading 态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiDeleteSummaryRecord, apiDeleteSummaryTask, apiGenerateDailySummary, apiGetContacts, apiGetSessions, apiListLlmModels, apiListLlmProviders, apiListSummaryRecords, apiListSummaryTasks, apiRunSummaryTask, apiSaveSummaryTask, apiToggleSummaryTask, readRenderCache, writeRenderCache, } from "../api.js";
import { Badge, PanelHeader } from "../ui/kit.js";
import css from './daily-summary.module.css';
const FORMATS = [
    { key: 'brief', label: '简洁总结', desc: '3–5 句话概括当天聊天的重点内容' },
    { key: 'detailed', label: '详细总结', desc: '按主题分点，包含关键事件、话题与结论' },
    { key: 'bullets', label: '要点列表', desc: '用要点列表提炼当天核心信息' },
    { key: 'story', label: '叙事总结', desc: '以第三人称叙述当天交流的来龙去脉' },
    { key: 'custom', label: '自定义格式', desc: '使用自定义提示词模板（支持 {date} {group} {targets}）' },
];
const EMPTY_FORM = { groupUsername: '', groupName: '', targetAll: true, targetUsers: [], format: 'brief', customPrompt: '', scheduleTime: '08:00', enabled: true };
const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '');
/**
 * Render the daily-summary panel.
 * @returns the daily-summary element tree.
 */
export function DailySummaryPanel() {
    const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
    const [result, setResult] = useState(null);
    const [meta, setMeta] = useState('');
    const [error, setError] = useState(null);
    const [tasks, setTasks] = useState([]);
    const [records, setRecords] = useState([]);
    const [groups, setGroups] = useState([]);
    const [members, setMembers] = useState([]);
    const [form, setForm] = useState(EMPTY_FORM);
    const [formOpen, setFormOpen] = useState(false);
    const [previewId, setPreviewId] = useState(null);
    const previewRef = useRef(null);
    const [view, setView] = useState('tasks');
    const [dailyStats, setDailyStats] = useState(null);
    const [providers, setProviders] = useState([]);
    const [models, setModels] = useState([]);
    const [selProvider, setSelProvider] = useState('');
    const [selModel, setSelModel] = useState('');
    // Toast + per-action busy feedback
    const [toasts, setToasts] = useState([]);
    const toastSeq = useRef(0);
    const [busyKeys, setBusyKeys] = useState(new Set());
    const isBusy = useCallback((key) => busyKeys.has(key), [busyKeys]);
    const notify = useCallback((kind, text) => {
        const id = ++toastSeq.current;
        setToasts(prev => [...prev, { id, kind, text }]);
        window.setTimeout(() => { setToasts(prev => prev.filter(t => t.id !== id)); }, 3200);
    }, []);
    const withBusy = useCallback(async (key, fn) => {
        setBusyKeys((prev) => { const n = new Set(prev); n.add(key); return n; });
        try {
            return await fn();
        }
        finally {
            setBusyKeys((prev) => { const n = new Set(prev); n.delete(key); return n; });
        }
    }, []);
    const showRecordPreview = useCallback((r) => {
        setResult(r.summary);
        setMeta(`${r.groupUsername} / ${r.summaryDate} · ${r.messageCount} 条 · ${r.status}`);
        setPreviewId(r.id);
        setDailyStats(null);
        requestAnimationFrame(() => previewRef.current?.scrollIntoView({ block: 'start' }));
    }, []);
    const copyResult = useCallback(() => {
        if (!result) {
            notify('info', '暂无可复制的总结内容');
            return;
        }
        void navigator.clipboard.writeText(result).then(() => { notify('ok', '已复制总结到剪贴板'); }).catch(() => { notify('err', '复制失败'); });
    }, [result, notify]);
    const loadTasks = useCallback(async () => {
        try {
            const t = await apiListSummaryTasks();
            setTasks(t.items);
            const r = await apiListSummaryRecords();
            setRecords(r.items);
        }
        catch { /* keep */ }
    }, []);
    const loadGroups = useCallback(async () => {
        try {
            const cached = readRenderCache('daily-summary-groups');
            if (cached)
                setGroups(cached);
            const env = await apiGetSessions({ limit: 500 });
            const gs = env.sessions
                .filter(s => s.type === 'group' || s.username.endsWith('@chatroom'))
                .map(s => ({ username: s.username, name: s.displayName || s.username }));
            setGroups(gs);
            writeRenderCache('daily-summary-groups', gs);
        }
        catch { /* keep */ }
    }, []);
    useEffect(() => { void loadTasks(); }, [loadTasks]);
    // 群聊列表与模型提供方只在使用到时才加载：手动生成视图 / 打开任务表单时。
    useEffect(() => { if (view === 'generate')
        void loadGroups(); }, [view, loadGroups]);
    useEffect(() => {
        if (view !== 'generate' || providers.length > 0)
            return;
        void apiListLlmProviders().then((env) => {
            const ps = env.providers;
            setProviders(ps);
            const first = ps[0];
            if (first && !selProvider)
                setSelProvider(first.id);
        }).catch(() => { });
    }, [view, providers.length]);
    useEffect(() => {
        if (!selProvider) {
            setModels([]);
            return;
        }
        void apiListLlmModels({ provider: selProvider }).then((env) => {
            const ms = env.models;
            setModels(ms);
            const first = ms[0];
            if (first && !selModel)
                setSelModel(first.id);
        }).catch(() => { setModels([]); });
    }, [selProvider]);
    const loadMembers = useCallback(async (groupUsername) => {
        setMembers([]);
        if (!groupUsername)
            return;
        try {
            const env = await apiGetContacts();
            const list = env.contacts
                .filter(c => c.category === 'member' && c.groupUsername === groupUsername)
                .map(c => ({ username: c.username, name: c.displayName || c.username }));
            setMembers(list);
        }
        catch { /* keep */ }
    }, []);
    const generate = async () => {
        setError(null);
        await withBusy('generate', async () => {
            try {
                const opts = { date };
                if (selProvider)
                    opts.provider = selProvider;
                if (selModel)
                    opts.model = selModel;
                const res = await apiGenerateDailySummary(opts);
                setResult(res.summary);
                setMeta(`覆盖 ${res.sessions} 个会话 / ${res.messages} 条消息`);
                setDailyStats({ total: res.total, types: res.types, hourly: res.hourly, topSessions: res.topSessions, sessions: res.sessions });
                notify('ok', `总结已生成：覆盖 ${res.sessions} 个会话 / ${res.messages} 条消息`);
                requestAnimationFrame(() => previewRef.current?.scrollIntoView({ block: 'start' }));
            }
            catch (e) {
                setError(e.message);
                notify('err', e.message || '生成失败');
            }
        });
    };
    const openNew = () => { setForm({ ...EMPTY_FORM }); setFormOpen(true); void loadGroups(); };
    const formFromTask = (t, withId) => {
        const base = {
            groupUsername: t.groupUsername,
            groupName: t.groupName || t.groupUsername,
            targetAll: t.targetUsers.length === 0,
            targetUsers: t.targetUsers,
            format: t.format || 'brief',
            customPrompt: t.customPrompt || '',
            scheduleTime: t.scheduleTime || '08:00',
            enabled: t.enabled,
        };
        if (withId)
            base.id = t.id;
        return base;
    };
    const openEdit = (t) => {
        setForm(formFromTask(t, true));
        setFormOpen(true);
        void loadGroups();
        void loadMembers(t.groupUsername);
    };
    const duplicate = (t) => {
        setForm(formFromTask(t, false));
        setFormOpen(true);
        void loadGroups();
        void loadMembers(t.groupUsername);
    };
    const toggleTarget = (username) => {
        setForm((f) => {
            const has = f.targetUsers.includes(username);
            return { ...f, targetUsers: has ? f.targetUsers.filter(u => u !== username) : [...f.targetUsers, username] };
        });
    };
    const saveTask = async () => {
        if (!form.groupUsername.trim())
            return;
        await withBusy('save', async () => {
            setError(null);
            try {
                const task = {
                    groupUsername: form.groupUsername.trim(),
                    groupName: form.groupName.trim() || form.groupUsername.trim(),
                    targetUsers: form.targetAll ? [] : form.targetUsers,
                    format: form.format,
                    customPrompt: form.customPrompt.trim(),
                    scheduleTime: form.scheduleTime,
                    enabled: form.enabled,
                    lastStatus: '',
                    lastError: '',
                };
                if (form.id !== undefined)
                    task.id = form.id;
                const r = await apiSaveSummaryTask({ task });
                if (!r.ok) {
                    notify('err', r.error ?? '保存失败');
                    setError(r.error ?? '保存失败');
                }
                else {
                    setFormOpen(false);
                    notify('ok', form.id ? '任务已更新' : '任务已创建');
                    await loadTasks();
                }
            }
            catch (e) {
                notify('err', e.message || '保存失败');
            }
        });
    };
    const runTask = async (id) => {
        await withBusy(`run:${id}`, async () => {
            try {
                const r = await apiRunSummaryTask({ id });
                if (!r.ok)
                    notify('err', r.error ?? '运行失败');
                else
                    notify('ok', r.messageCount != null ? `运行成功，生成 ${r.messageCount} 条消息总结` : '运行成功');
                await loadTasks();
            }
            catch (e) {
                notify('err', e.message || '运行失败');
            }
        });
    };
    const toggleTask = async (id, enabled) => {
        await withBusy(`toggle:${id}`, async () => {
            try {
                await apiToggleSummaryTask({ id, enabled });
                notify('ok', enabled ? '任务已启用' : '任务已停用');
                await loadTasks();
            }
            catch (e) {
                notify('err', e.message || '操作失败');
            }
        });
    };
    const copyRecord = async (r) => {
        await withBusy(`copy:${r.id}`, async () => {
            try {
                await navigator.clipboard.writeText(r.summary || '');
                notify('ok', '已复制总结到剪贴板');
            }
            catch {
                notify('err', '复制失败');
            }
        });
    };
    const deleteTask = async (id) => {
        if (!window.confirm('删除该总结任务？此操作不可撤销。'))
            return;
        await withBusy(`del:${id}`, async () => {
            try {
                await apiDeleteSummaryTask({ id });
                notify('ok', '任务已删除');
                await loadTasks();
            }
            catch (e) {
                notify('err', e.message || '删除失败');
            }
        });
    };
    const deleteRecord = async (id) => {
        if (!window.confirm('删除该总结记录？此操作不可撤销。'))
            return;
        await withBusy(`delrec:${id}`, async () => {
            try {
                await apiDeleteSummaryRecord({ id });
                notify('ok', '记录已删除');
                if (previewId === id) {
                    setResult(null);
                    setPreviewId(null);
                    setMeta('');
                }
                await loadTasks();
            }
            catch (e) {
                notify('err', e.message || '删除失败');
            }
        });
    };
    const avgLen = useMemo(() => (records.length > 0 ? Math.round(records.reduce((a, r) => a + (r.summary || '').length, 0) / records.length) : 0), [records]);
    const isGenerating = isBusy('generate');
    const renderBusy = (key, idle, busy) => (isBusy(key)
        ? _jsxs(_Fragment, { children: [_jsx("span", { className: css.spin }), busy] })
        : idle);
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u6BCF\u65E5\u603B\u7ED3", desc: "\u5B9A\u65F6\u603B\u7ED3\u4EFB\u52A1 + \u5386\u53F2\u8BB0\u5F55\uFF08DSH LLM\uFF09", actions: (_jsxs(_Fragment, { children: [_jsxs(Badge, { tone: "cyan", children: [tasks.length, " \u4EFB\u52A1"] }), _jsxs(Badge, { tone: "purple", children: [records.length, " \u8BB0\u5F55"] })] })) }), error && _jsxs("div", { className: css.errBanner, children: ["\u26A0\uFE0F ", error] }), toasts.length > 0 && (_jsx("div", { className: css.toasts, children: toasts.map(t => (_jsxs("div", { className: [css.toast, t.kind === 'ok' ? css.ok : t.kind === 'err' ? css.err : css.info].join(' '), children: [_jsx("span", { className: css.toastDot }), _jsx("span", { children: t.text })] }, t.id))) })), _jsxs("div", { className: css.tabBar, children: [_jsx("button", { type: "button", className: css.tabBtn, "data-active": view === 'tasks' || undefined, onClick: () => { setView('tasks'); }, children: "\u5B9A\u65F6\u4EFB\u52A1" }), _jsx("button", { type: "button", className: css.tabBtn, "data-active": view === 'records' || undefined, onClick: () => { setView('records'); }, children: "\u5386\u53F2\u8BB0\u5F55" }), _jsx("button", { type: "button", className: css.tabBtn, "data-active": view === 'generate' || undefined, onClick: () => { setView('generate'); }, children: "\u624B\u52A8\u751F\u6210" })] }), _jsxs("div", { className: css.scroll, children: [view === 'tasks' && (_jsxs("div", { className: css.sideCard, children: [_jsxs("div", { className: css.cardTitle, children: ["\u5B9A\u65F6\u603B\u7ED3\u4EFB\u52A1 ", _jsxs("span", { className: css.cardCount, children: ["\u5171 ", tasks.length, " \u4E2A"] })] }), _jsxs("div", { className: css.sideList, children: [tasks.length === 0 && _jsx("div", { className: css.empty, children: "\u8FD8\u6CA1\u6709\u5B9A\u65F6\u4EFB\u52A1\uFF0C\u70B9\u4E0B\u65B9\u201C\u65B0\u5EFA\u4EFB\u52A1\u201D\u521B\u5EFA\u3002" }), tasks.map(t => (_jsxs("div", { className: css.taskRow, children: [_jsxs("div", { className: css.taskInfo, children: [_jsx("div", { className: css.taskName, children: t.groupName || t.groupUsername }), _jsxs("div", { className: css.taskMeta, children: ["\u23F0 ", t.scheduleTime, " \u00B7 ", FORMATS.find(f => f.key === t.format)?.label ?? t.format] }), _jsxs("div", { className: css.taskChips, children: [_jsx("span", { className: [css.statBadge, t.enabled ? css.on : css.off].join(' '), children: t.enabled ? '启用' : '停用' }), t.lastStatus === 'done' && _jsx("span", { className: [css.statBadge, css.done].join(' '), children: "\u4E0A\u6B21\u8FD0\u884C\u6210\u529F" }), t.lastStatus === 'error' && _jsx("span", { className: [css.statBadge, css.fail].join(' '), children: "\u4E0A\u6B21\u8FD0\u884C\u5931\u8D25" }), t.lastStatus && t.lastStatus !== 'done' && t.lastStatus !== 'error' && _jsxs("span", { className: [css.statBadge, css.on].join(' '), children: ["\u4E0A\u6B21 ", t.lastStatus] }), t.lastRunAt && _jsx("span", { className: css.statBadge, children: fmtTime(t.lastRunAt) })] })] }), _jsxs("div", { className: css.taskActions, children: [_jsx("button", { type: "button", className: css.catBtn, onClick: () => { void runTask(t.id); }, disabled: isBusy(`run:${t.id}`), children: renderBusy(`run:${t.id}`, '运行', '运行中') }), _jsx("button", { type: "button", className: css.catBtn, onClick: () => { openEdit(t); }, children: "\u7F16\u8F91" }), _jsx("button", { type: "button", className: css.catBtn, onClick: () => { duplicate(t); }, children: "\u590D\u5236" }), _jsx("button", { type: "button", className: css.catBtn, onClick: () => { void toggleTask(t.id, !t.enabled); }, disabled: isBusy(`toggle:${t.id}`), children: renderBusy(`toggle:${t.id}`, t.enabled ? '停用' : '启用', t.enabled ? '停用中' : '启用中') }), _jsx("button", { type: "button", className: css.catBtn, onClick: () => { void deleteTask(t.id); }, disabled: isBusy(`del:${t.id}`), children: renderBusy(`del:${t.id}`, '删除', '删除中') })] })] }, t.id))), _jsx("button", { type: "button", className: css.catBtn, "data-active": "true", style: { alignSelf: 'center' }, onClick: openNew, children: "\uFF0B \u65B0\u5EFA\u4EFB\u52A1" })] })] })), view === 'records' && (_jsxs("div", { className: css.dsLayout, children: [_jsx("div", { className: css.dsMain, children: _jsxs("div", { className: css.sideCard, children: [_jsxs("div", { className: css.cardTitle, children: ["\u5386\u53F2\u8BB0\u5F55 ", _jsxs("span", { className: css.cardCount, children: ["\u5171 ", records.length, " \u6761 \u00B7 \u5E73\u5747 ", avgLen, " \u5B57"] })] }), _jsxs("div", { className: css.sideList, children: [records.length === 0 && _jsx("div", { className: css.empty, children: "\u8FD8\u6CA1\u6709\u5386\u53F2\u603B\u7ED3\u3002\u5B9A\u65F6\u4EFB\u52A1\u8FD0\u884C\u6216\u624B\u52A8\u751F\u6210\u540E\u4F1A\u81EA\u52A8\u5B58\u5165\u8FD9\u91CC\u3002" }), records.map(r => (_jsxs("div", { className: css.taskRow, children: [_jsxs("div", { className: css.taskInfo, children: [_jsxs("div", { className: css.taskName, children: [r.groupName || r.groupUsername, " / ", r.summaryDate] }), _jsxs("div", { className: css.taskMeta, children: [r.messageCount, " \u6761 \u00B7 ", r.status] }), _jsxs("div", { className: css.taskChips, children: [_jsx("span", { className: [css.statBadge, r.status === 'done' ? css.done : r.status === 'error' ? css.fail : css.on].join(' '), children: r.status === 'done' ? '已完成' : r.status === 'error' ? '失败' : r.status }), previewId === r.id && _jsx("span", { className: [css.statBadge, css.on].join(' '), children: "\u6B63\u5728\u9884\u89C8" })] })] }), _jsxs("div", { className: css.taskActions, children: [_jsx("button", { type: "button", className: css.catBtn, "data-active": previewId === r.id || undefined, onClick: () => { showRecordPreview(r); }, children: "\u9884\u89C8" }), _jsx("button", { type: "button", className: css.catBtn, onClick: () => { void copyRecord(r); }, disabled: isBusy(`copy:${r.id}`), children: renderBusy(`copy:${r.id}`, '复制总结', '复制中') }), _jsx("button", { type: "button", className: css.catBtn, onClick: () => { void deleteRecord(r.id); }, disabled: isBusy(`delrec:${r.id}`), children: renderBusy(`delrec:${r.id}`, '删除', '删除中') })] })] }, r.id)))] })] }) }), _jsx("div", { className: css.dsSide, children: result ? (_jsxs("div", { className: css.previewCard, ref: previewRef, children: [_jsxs("div", { className: css.previewHd, children: [_jsx("span", { className: css.previewTitle, children: "\u603B\u7ED3\u9884\u89C8" }), meta && _jsx("span", { className: css.previewMetaChip, title: meta, children: meta })] }), _jsx("div", { className: css.previewBody, children: _jsx("div", { className: css.summaryText, children: result }) }), _jsx("div", { className: css.previewActions, children: _jsx("button", { type: "button", className: css.catBtn, onClick: copyResult, children: "\u590D\u5236\u603B\u7ED3" }) })] })) : (_jsxs("div", { className: css.sideCard, children: [_jsx("div", { className: css.cardTitle, children: "\u603B\u7ED3\u9884\u89C8" }), _jsx("div", { className: css.sideList, children: _jsx("div", { className: css.empty, children: "\u5728\u5DE6\u4FA7\u9009\u62E9\u4E00\u6761\u8BB0\u5F55\u5373\u53EF\u9884\u89C8\u5185\u5BB9" }) })] })) })] })), view === 'generate' && (_jsx("div", { className: css.dsLayout, children: _jsxs("div", { className: css.dsMain, children: [_jsxs("div", { className: css.panelCard, children: [_jsx("div", { className: css.cardTitle, children: "\u624B\u52A8\u751F\u6210" }), _jsxs("div", { className: css.cardBody, children: [_jsxs("div", { className: css.searchWrap, style: { marginBottom: 8 }, children: [_jsx("label", { className: css.fieldLabel, children: "\u6A21\u578B" }), _jsxs("select", { className: css.search, value: selProvider, onChange: (e) => { setSelProvider(e.target.value); setSelModel(''); }, children: [_jsx("option", { value: "", children: "\u63D0\u4F9B\u65B9\u2026" }), providers.map(p => _jsx("option", { value: p.id, children: p.name }, p.id))] }), _jsxs("select", { className: css.search, value: selModel, onChange: (e) => { setSelModel(e.target.value); }, disabled: !selProvider, children: [_jsx("option", { value: "", children: "\u6A21\u578B\u2026" }), models.map(m => _jsx("option", { value: m.id, children: m.name }, m.id))] }), _jsx("span", { className: css.rowNote, children: "\u5BC6\u94A5\u4E0E\u63D0\u4F9B\u65B9\u5728\u201C\u8BBE\u7F6E \u2192 \u6A21\u578B\u201D\u914D\u7F6E\u3002" })] }), _jsxs("div", { className: css.searchWrap, children: [_jsx("label", { className: css.fieldLabel, children: "\u65E5\u671F" }), _jsx("input", { type: "date", value: date, onChange: (e) => { setDate(e.target.value); }, className: css.search }), _jsx("button", { type: "button", className: css.catBtn, "data-active": "true", onClick: () => { void generate(); }, disabled: isGenerating, children: renderBusy('generate', '生成总结', '生成中…') })] })] })] }), dailyStats && (_jsxs("div", { className: css.sideCard, children: [_jsxs("div", { className: css.cardTitle, children: ["\u5F53\u65E5\u6982\u89C8 ", _jsxs("span", { className: css.cardCount, children: ["\u5171 ", dailyStats.total, " \u6761\u6D88\u606F"] })] }), _jsxs("div", { className: css.sideList, children: [_jsxs("div", { className: css.statChips, children: [_jsxs("span", { className: css.statChip, children: ["\u6D88\u606F ", _jsx("b", { children: dailyStats.total })] }), _jsxs("span", { className: css.statChip, children: ["\u4F1A\u8BDD ", _jsx("b", { children: dailyStats.sessions })] }), (dailyStats.types['图片'] ?? 0) > 0 && (_jsxs("span", { className: css.statChip, children: ["\u56FE\u7247 ", _jsx("b", { children: dailyStats.types['图片'] })] })), (dailyStats.types['视频'] ?? 0) > 0 && _jsxs("span", { className: css.statChip, children: ["\u89C6\u9891 ", _jsx("b", { children: dailyStats.types['视频'] })] }), (dailyStats.types['链接'] ?? 0) > 0 && _jsxs("span", { className: css.statChip, children: ["\u94FE\u63A5 ", _jsx("b", { children: dailyStats.types['链接'] })] })] }), dailyStats.topSessions.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: css.subHd, children: "\u6700\u6D3B\u8DC3\u7684\u4F1A\u8BDD" }), dailyStats.topSessions.slice(0, 5).map((ts, i) => {
                                                            const name = groups.find(g => g.username === ts.username)?.name ?? ts.username;
                                                            const base = dailyStats.topSessions[0]?.count ?? 1;
                                                            return (_jsxs("div", { className: css.barRow, children: [_jsxs("span", { className: css.barLabel, children: [i + 1, ". ", name] }), _jsx("div", { className: css.barTrack, children: _jsx("div", { className: css.barFill, style: { width: `${(ts.count / base) * 100}%` } }) }), _jsxs("span", { className: css.barValue, children: [ts.count, " \u6761"] })] }, ts.username));
                                                        })] })), _jsx("div", { className: css.subHd, children: "24 \u5C0F\u65F6\u6D3B\u8DC3\u5206\u5E03" }), _jsx("div", { className: css.dsHourBars, children: dailyStats.hourly.map((n, h) => {
                                                        const max = Math.max(1, ...dailyStats.hourly);
                                                        return (_jsx("div", { className: css.dsHourCol, title: `${h}:00 · ${n} 条`, children: _jsx("div", { className: css.dsHourFill, style: { height: `${Math.max(3, (n / max) * 46)}px` } }) }, h));
                                                    }) })] })] })), isGenerating && _jsxs("div", { className: css.empty, children: [_jsx("span", { className: css.spin }), "\u6B63\u5728\u6536\u96C6\u5F53\u65E5\u6D88\u606F\u5E76\u751F\u6210\u603B\u7ED3\u2026"] }), !isGenerating && result && (_jsxs("div", { className: css.previewCard, ref: previewRef, children: [_jsxs("div", { className: css.previewHd, children: [_jsx("span", { className: css.previewTitle, children: "\u603B\u7ED3\u9884\u89C8" }), meta && _jsx("span", { className: css.previewMetaChip, title: meta, children: meta })] }), _jsx("div", { className: css.previewBody, children: _jsx("div", { className: css.summaryText, children: result }) }), _jsxs("div", { className: css.previewActions, children: [_jsx("button", { type: "button", className: css.catBtn, onClick: copyResult, children: "\u590D\u5236\u603B\u7ED3" }), _jsx("button", { type: "button", className: css.catBtn, onClick: () => { void generate(); }, disabled: isGenerating, children: renderBusy('generate', '重新生成', '生成中…') })] })] }))] }) }))] }), formOpen && (_jsx("div", { className: css.overlay, onClick: () => { setFormOpen(false); }, role: "dialog", children: _jsxs("div", { className: css.formDialog, onClick: (e) => { e.stopPropagation(); }, children: [_jsxs("div", { className: css.formHd, children: [_jsx("span", { className: css.hdTitle, children: form.id ? '编辑任务' : '新建任务' }), _jsx("button", { type: "button", className: css.catBtn, onClick: () => { setFormOpen(false); }, "aria-label": "\u5173\u95ED", children: "\u00D7" })] }), _jsxs("div", { className: css.formBody, children: [_jsx("div", { className: css.formHd, children: _jsx("span", { className: css.hdCount, children: "\u7FA4\u804A" }) }), _jsxs("select", { className: css.search, value: form.groupUsername, onChange: (e) => {
                                        const v = e.target.value;
                                        setForm(f => ({ ...f, groupUsername: v, groupName: groups.find(g => g.username === v)?.name ?? v }));
                                        void loadMembers(v);
                                    }, children: [_jsx("option", { value: "", children: "\u9009\u62E9\u7FA4\u804A\u2026" }), groups.map(g => _jsx("option", { value: g.username, children: g.name }, g.username))] }), _jsx("div", { className: css.formHd, style: { marginTop: 8 }, children: _jsx("span", { className: css.hdCount, children: "\u5173\u6CE8\u6210\u5458" }) }), _jsxs("label", { className: css.fileMeta, style: { display: 'flex', alignItems: 'center', gap: 6 }, children: [_jsx("input", { type: "checkbox", checked: form.targetAll, onChange: (e) => { setForm(f => ({ ...f, targetAll: e.target.checked, targetUsers: e.target.checked ? [] : f.targetUsers })); } }), "\u5168\u90E8\u6210\u5458"] }), !form.targetAll && form.groupUsername && (_jsxs("div", { style: { display: 'flex', flexWrap: 'wrap', gap: 5, maxHeight: 120, overflowY: 'auto', padding: 4 }, children: [members.length === 0 && _jsx("span", { className: css.fileMeta, children: "\u672A\u8BFB\u53D6\u5230\u7FA4\u6210\u5458\uFF0C\u53EF\u91CD\u65B0\u9009\u62E9\u7FA4\u804A\u91CD\u8BD5" }), members.map(m => (_jsx("button", { type: "button", className: css.catBtn, "data-active": form.targetUsers.includes(m.username) || undefined, onClick: () => { toggleTarget(m.username); }, children: m.name }, m.username)))] })), !form.targetAll && _jsxs("div", { className: css.fileMeta, children: ["\u5DF2\u5173\u6CE8 ", form.targetUsers.length, " \u4F4D\u6210\u5458"] }), _jsx("div", { className: css.formHd, style: { marginTop: 8 }, children: _jsx("span", { className: css.hdCount, children: "\u5206\u6790\u683C\u5F0F" }) }), _jsx("div", { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 6 }, children: FORMATS.map(f => (_jsxs("label", { className: css.formatCard, "data-on": form.format === f.key || undefined, style: { cursor: 'pointer', padding: 8, border: '1px solid var(--wc-border)', borderRadius: 8 }, children: [_jsx("input", { type: "radio", name: "ds-format", style: { display: 'none' }, checked: form.format === f.key, onChange: () => { setForm(x => ({ ...x, format: f.key })); } }), _jsx("div", { className: css.fileName, children: f.label }), _jsx("div", { className: css.fileMeta, children: f.desc })] }, f.key))) }), form.format === 'custom' && (_jsxs(_Fragment, { children: [_jsx("div", { className: css.hd, style: { marginTop: 8 }, children: _jsx("span", { className: css.hdCount, children: "\u81EA\u5B9A\u4E49\u63D0\u793A\u8BCD\u6A21\u677F" }) }), _jsx("textarea", { className: css.search, rows: 4, style: { resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.6 }, placeholder: '支持占位符：{date} {group} {targets}；例如：请用表格形式总结 {group} 在 {date} 的聊天，成员：{targets}', value: form.customPrompt, onChange: (e) => { setForm(f => ({ ...f, customPrompt: e.target.value })); } })] })), _jsx("div", { className: css.formHd, style: { marginTop: 8 }, children: _jsx("span", { className: css.hdCount, children: "\u5B9A\u65F6\u8BBE\u7F6E" }) }), _jsxs("div", { style: { display: 'flex', gap: 10, alignItems: 'center' }, children: [_jsx("input", { type: "time", value: form.scheduleTime, onChange: (e) => { setForm(f => ({ ...f, scheduleTime: e.target.value })); }, className: css.search, style: { width: 120 } }), _jsxs("label", { className: css.fileMeta, style: { display: 'flex', alignItems: 'center', gap: 6 }, children: [_jsx("input", { type: "checkbox", checked: form.enabled, onChange: (e) => { setForm(f => ({ ...f, enabled: e.target.checked })); } }), form.enabled ? '已启用' : '已暂停'] })] }), _jsx("div", { className: css.searchWrap, style: { marginTop: 12 }, children: _jsx("button", { type: "button", className: css.catBtn, "data-active": "true", onClick: () => { void saveTask(); }, disabled: isBusy('save') || !form.groupUsername.trim(), children: renderBusy('save', form.id ? '保存修改' : '保存任务', '保存中…') }) })] })] }) }))] }));
}
//# sourceMappingURL=DailySummary.js.map