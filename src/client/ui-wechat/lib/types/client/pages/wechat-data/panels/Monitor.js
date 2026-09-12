import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 群监控面板 — 只读实时监控仪表盘：群热度、今日/当月消息、近期消息流
 * （会话/日历/消息 Remote 轮询，无需原生 Hook；自动刷新可开关）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ListSkeleton } from "./hooks.js";
import { apiGetDailyCounts, apiGetMessages, apiGetSessions, readRenderCache, writeRenderCache } from "../api.js";
import { Card, PanelHeader, StatCard, StatGrid } from "../ui/kit.js";
import kitCss from '../ui/kit.module.css';
import css from './monitor.module.css';
const REFRESH_VISIBLE_MS = 3000;
const REFRESH_HIDDEN_MS = 10_000;
const HEAT_DAYS = 14;
function fmtTime(ts) {
    if (!ts)
        return '—';
    const d = new Date(ts * 1000);
    if (Number.isNaN(d.getTime()))
        return '—';
    const p = (n) => String(n).padStart(2, '0');
    return String(d.getFullYear()) + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
/**
 * Render the group monitor dashboard.
 * @param props - optional chat navigation callback (message click jumps there).
 * @returns the monitor element tree.
 */
export function MonitorPanel({ onOpenChat } = {}) {
    const [groups, setGroups] = useState([]);
    const [selected, setSelected] = useState('');
    const [counts, setCounts] = useState({});
    const [messages, setMessages] = useState([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [auto, setAuto] = useState(false);
    const timerRef = useRef(null);
    const selectedRef = useRef('');
    const loadGroups = useCallback(async () => {
        try {
            const env = await apiGetSessions({ limit: 500 });
            const gs = env.sessions.filter(s => s.type === 'group');
            setGroups(gs);
            // 不自动选中第一个群并立刻拉取日历/消息；由用户点击群聊后再按需加载。
        }
        catch (e) {
            setError(e.message);
        }
    }, []);
    const loadGroup = useCallback(async (username) => {
        if (!username)
            return;
        setLoading(true);
        setError(null);
        try {
            // 先用上次渲染的日历 + 消息缓存,后台再同步
            const cached = readRenderCache('monitor:' + username);
            if (cached) {
                setCounts(cached.counts);
                setMessages(cached.messages);
                setLoading(false);
            }
            const now = new Date();
            const year = now.getFullYear();
            const month = now.getMonth() + 1;
            const [cal, msgs] = await Promise.all([
                apiGetDailyCounts({ username, year, month }),
                apiGetMessages({ talker: username, limit: 12 }),
            ]);
            // A stale response must never overwrite the currently selected group.
            if (selectedRef.current !== username)
                return;
            setCounts(cal.counts);
            setMessages(msgs.messages);
            writeRenderCache('monitor:' + username, { counts: cal.counts, messages: msgs.messages });
        }
        catch (e) {
            if (selectedRef.current === username)
                setError(e.message);
        }
        finally {
            if (selectedRef.current === username)
                setLoading(false);
        }
    }, []);
    useEffect(() => { void loadGroups(); }, [loadGroups]);
    useEffect(() => { selectedRef.current = selected; }, [selected]);
    useEffect(() => { if (selected)
        void loadGroup(selected); }, [selected, loadGroup]);
    useEffect(() => {
        if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
        }
        const start = () => {
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
            if (!auto || !selected)
                return;
            const ms = document.visibilityState === 'visible' ? REFRESH_VISIBLE_MS : REFRESH_HIDDEN_MS;
            timerRef.current = setInterval(() => { void loadGroup(selected); }, ms);
        };
        start();
        const onVis = () => { void loadGroup(selected); start(); };
        document.addEventListener('visibilitychange', onVis);
        return () => {
            document.removeEventListener('visibilitychange', onVis);
            if (timerRef.current) {
                clearInterval(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [auto, selected, loadGroup]);
    // Host push: the realtime sync decrypted a WAL increment into the snapshot —
    // refresh the selected group (and the roster) immediately, independent of the
    // auto poll, so fresh counts/messages appear without waiting for the interval.
    useEffect(() => {
        const onUpdated = () => {
            void loadGroups();
            if (selectedRef.current)
                void loadGroup(selectedRef.current);
        };
        window.addEventListener('dsh-wechat-data-updated', onUpdated);
        return () => { window.removeEventListener('dsh-wechat-data-updated', onUpdated); };
    }, [loadGroups, loadGroup]);
    const monthTotal = Object.values(counts).reduce((a, b) => a + b, 0);
    const activeDays = Object.values(counts).filter(n => n > 0).length;
    const now = new Date();
    const todayKey = String(now.getDate());
    const todayCount = counts[todayKey] ?? 0;
    const heat = [];
    const today = now.getDate();
    for (let i = Math.max(1, today - HEAT_DAYS + 1); i <= today; i++) {
        heat.push({ d: i, c: counts[String(i)] ?? 0, isToday: i === today });
    }
    const heatMax = Math.max(1, ...heat.map(h => h.c));
    const selGroup = groups.find(g => g.username === selected);
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u7FA4\u6D3B\u8DC3\u76D1\u63A7", desc: `只读仪表盘 · 自动刷新 ${auto ? '开' : '关'}`, actions: (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: css.chip, "data-on": auto || undefined, onClick: () => { setAuto(v => !v); }, children: auto ? '⏸ 暂停轮询' : '▶ 自动刷新' }), _jsx("button", { type: "button", className: css.chip, onClick: () => { if (selected)
                                void loadGroup(selected); }, disabled: loading, children: "\u5237\u65B0" })] })) }), _jsxs(StatGrid, { children: [_jsx(StatCard, { icon: "\uD83D\uDC65", value: groups.length, label: "\u7FA4" }), _jsx(StatCard, { icon: "\uD83D\uDCC5", value: `${todayCount} 条`, label: "\u4ECA\u65E5", tone: "green" }), _jsx(StatCard, { icon: "\uD83D\uDDD3\uFE0F", value: `${monthTotal} 条`, label: "\u672C\u6708", tone: "blue" }), _jsx(StatCard, { icon: "\uD83D\uDD25", value: `${activeDays} 天`, label: "\u6D3B\u8DC3", tone: "amber" })] }), _jsxs("div", { className: css.chipRow, children: [groups.map(g => (_jsx("button", { type: "button", className: css.chip, "data-on": selected === g.username || undefined, onClick: () => { setSelected(g.username); }, children: g.displayName }, g.username))), groups.length === 0 && _jsx("span", { className: css.note, children: "\u6682\u65E0\u7FA4\u804A\u4F1A\u8BDD" }), groups.length > 0 && !selected && _jsx("span", { className: css.note, children: "\u70B9\u51FB\u4E0A\u65B9\u7FA4\u804A\u67E5\u770B\u76D1\u63A7" })] }), error && _jsxs("div", { className: css.note, children: ["\u26A0\uFE0F ", error] }), _jsxs("div", { className: kitCss.cardGrid, children: [_jsx(Card, { title: `${selGroup ? selGroup.displayName : '群'} · 近 ${String(HEAT_DAYS)} 天消息热力`, children: _jsx("div", { className: css.heatWrap, children: heat.map(h => (_jsxs("div", { className: css.heatCol, title: 'Day ' + String(h.d) + ': ' + String(h.c) + ' 条', children: [_jsx("span", { className: css.heatValue, children: h.c > 0 ? String(h.c) : '' }), _jsx("div", { className: css.heatTrack, children: _jsx("div", { className: css.heatBar, "data-today": h.isToday || undefined, style: { height: String(Math.max(3, Math.round((h.c / heatMax) * 100))) + '%' } }) }), _jsx("span", { className: css.heatLabel, children: String(h.d) })] }, String(h.d)))) }) }), _jsx(Card, { title: "\u8FD1\u671F\u6D88\u606F", extra: selGroup ? (_jsx("button", { type: "button", className: css.chip, onClick: () => { onOpenChat?.(selGroup.username); }, disabled: !onOpenChat, children: "\u6253\u5F00\u5B8C\u6574\u4F1A\u8BDD" })) : undefined, children: _jsxs("div", { className: css.msgList, children: [messages.map(m => (_jsxs("button", { type: "button", className: css.msgRow, onClick: () => { onOpenChat?.(selected, m.localId); }, disabled: !onOpenChat, title: onOpenChat ? '跳转到该消息' : undefined, children: [_jsx("span", { className: css.msgName, children: m.senderName || (m.isSender ? '我' : '成员') }), _jsx("span", { className: css.msgTime, children: fmtTime(m.createTime) }), _jsx("span", { className: css.msgText, children: m.displayText ?? m.msgContent ?? '' })] }, String(m.localId)))), messages.length === 0 && !loading && _jsx("div", { className: css.note, children: "\u6682\u65E0\u6D88\u606F" }), loading && messages.length === 0 && _jsx(ListSkeleton, { rows: 5 })] }) })] })] }));
}
//# sourceMappingURL=Monitor.js.map