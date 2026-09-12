import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 记录面板 — 仪表盘重设计版：6 种记录类型 + Hero 头 + 类型页签 + 筛选工具栏
 * + 卡片化表格（粘性表头/斑马 hover/状态徽章）+ 分页加载 + CSV 导出 + 跳转定位。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ListSkeleton } from "./hooks.js";
import { apiExportCsv, apiGetRecords, readRenderCache, writeRenderCache } from "../api.js";
import { Badge, Card, PanelHeader, SearchInput, Segmented, Toolbar } from "../ui/kit.js";
import css from './records.module.css';
const KIND_META = {
    revokes: { label: '撤回消息', desc: '本地撤回缓存记录，点击会话可跳转定位', icon: '↩️' },
    transfers: { label: '转账记录', desc: '微信转账明细，点击会话可跳转', icon: '💳' },
    redpackets: { label: '红包记录', desc: '微信红包明细，点击会话可跳转', icon: '🧧' },
    finder: { label: '视频号', desc: '视频号直播 / 用户页记录', icon: '📺' },
    miniprograms: { label: '小程序', desc: '已使用的小程序联系人', icon: '🧩' },
    friendverifications: { label: '好友验证', desc: '新朋友 / 好友验证消息', icon: '👥' },
};
const KINDS = ['revokes', 'transfers', 'redpackets', 'finder', 'miniprograms', 'friendverifications'];
const TIME_KINDS = {
    revokes: true, transfers: true, redpackets: false, finder: false, miniprograms: true, friendverifications: true,
};
function shortUser(u) {
    const s = String(u ?? '').trim();
    if (!s)
        return '—';
    return s.length > 32 ? s.slice(0, 30) + '…' : s;
}
function fmtTime(ts) {
    const n = Number(ts);
    if (!n)
        return '—';
    const d = new Date(n * 1000);
    if (isNaN(d.getTime()))
        return '—';
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function dateToTs(v, endOfDay) {
    if (!v)
        return 0;
    const d = new Date(v + (endOfDay ? 'T23:59:59' : 'T00:00:00'));
    return Number.isNaN(d.getTime()) ? 0 : Math.floor(d.getTime() / 1000);
}
function transferSubType(v) {
    const map = {
        '1': { label: '微信支付', tone: 'info' }, '2': { label: '群收款', tone: 'muted' }, '3': { label: '转账', tone: 'success' },
        '4': { label: '二维码收款', tone: 'info' }, '5': { label: '收款', tone: 'success' }, '6': { label: 'AA收款', tone: 'muted' },
        '7': { label: '面对面', tone: 'muted' }, '8': { label: '公众号支付', tone: 'info' },
    };
    return map[String(v)] ?? { label: `类型 ${String(v)}`, tone: 'muted' };
}
function hbStatus(v) {
    const map = {
        '0': { label: '未知', tone: 'muted' }, '1': { label: '正常', tone: 'success' }, '2': { label: '已退回', tone: 'danger' }, '3': { label: '已领完', tone: 'warn' },
    };
    return map[String(v)] ?? { label: `状态 ${String(v)}`, tone: 'muted' };
}
function liveStatus(v) {
    const map = {
        '1': { label: '直播中', tone: 'success' }, '2': { label: '已结束', tone: 'muted' }, '3': { label: '预告', tone: 'info' },
    };
    return map[String(v)] ?? { label: `状态 ${String(v)}`, tone: 'muted' };
}
const toneClass = (tone) => `badge${tone.charAt(0).toUpperCase()}${tone.slice(1)}`;
export function RecordsPanel({ onOpenChat }) {
    const [kind, setKind] = useState('revokes');
    const [items, setItems] = useState([]);
    const [total, setTotal] = useState(0);
    const [totals, setTotals] = useState({});
    const [keyword, setKeyword] = useState('');
    const [fromDate, setFromDate] = useState('');
    const [toDate, setToDate] = useState('');
    const [direction, setDirection] = useState('desc');
    const lastQueryKeyRef = useRef('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [page, setPage] = useState(0);
    const [exporting, setExporting] = useState(false);
    const [notice, setNotice] = useState(null);
    const searchTimer = useRef(null);
    const PAGE = 50;
    const notify = (text) => {
        setNotice(text);
        setTimeout(() => { setNotice(null); }, 4000);
    };
    const load = useCallback(async (reset) => {
        if (reset)
            setPage(0);
        setError(null);
        const cacheKey = 'records:' + kind + ':' + keyword.trim() + ':' + fromDate + ':' + toDate + ':' + direction;
        if (reset) {
            const cached = readRenderCache(cacheKey);
            if (cached) {
                setItems(cached);
                setTotal(cached.length);
                setPage(0);
                setLoading(false);
            }
            else {
                setLoading(true);
            }
        }
        try {
            const nextPage = reset ? 0 : page + 1;
            const opts = { kind, limit: PAGE, offset: nextPage * PAGE, direction };
            const term = keyword.trim();
            if (term)
                opts.q = term;
            if (TIME_KINDS[kind]) {
                const fromTs = dateToTs(fromDate, 0);
                const toTs = dateToTs(toDate, 1);
                if (fromTs > 0)
                    opts.from = fromTs;
                if (toTs > 0)
                    opts.to = toTs;
            }
            const env = await apiGetRecords(opts);
            const list = env.items ?? [];
            setItems(prev => (reset ? list : [...prev, ...list]));
            const t = env.total ?? list.length;
            setTotal(t);
            setTotals(prev => ({ ...prev, [kind]: t }));
            setPage(nextPage);
            if (reset && list.length > 0)
                writeRenderCache(cacheKey, list);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, [kind, page, keyword, fromDate, toDate, direction]);
    const queryKey = keyword.trim() + '|' + fromDate + '|' + toDate + '|' + direction;
    useEffect(() => {
        if (queryKey === lastQueryKeyRef.current)
            return;
        lastQueryKeyRef.current = queryKey;
        if (searchTimer.current)
            clearTimeout(searchTimer.current);
        searchTimer.current = setTimeout(() => { void load(true); }, 400);
        return () => { if (searchTimer.current)
            clearTimeout(searchTimer.current); };
    }, [queryKey, load]);
    const switchKind = (k) => {
        if (k === kind)
            return;
        setKind(k);
        setKeyword('');
        lastQueryKeyRef.current = '';
        setItems([]);
        setTotal(0);
        setPage(0);
        void load(true);
    };
    useEffect(() => { void load(true); }, [kind]);
    const doExport = async () => {
        setExporting(true);
        try {
            const r = await apiExportCsv({ kind: 'records', recordsKind: kind });
            notify(`已导出 ${r.count} 条 → ${r.path}`);
        }
        catch (e) {
            notify('导出失败: ' + e.message);
        }
        finally {
            setExporting(false);
        }
    };
    const open = (username, localId) => {
        if (!username)
            return;
        onOpenChat?.(String(username), localId != null ? Number(localId) : undefined);
    };
    const meta = KIND_META[kind];
    const td = (children, key, cls = '') => (_jsx("td", { className: cls, children: children }, key));
    const linkTd = (username, localId, key = 's', label) => (_jsx("td", { children: username ? _jsx("button", { type: "button", className: css.link, onClick: () => { open(username, localId); }, title: String(username), children: shortUser(label || username) }) : _jsx("span", { className: css.muted, children: "\u2014" }) }, key));
    const mono = (v, key = 'm') => _jsx("td", { className: css.mono, children: v == null ? '—' : String(v) }, key);
    const timeTd = (ts, key = 't') => _jsx("td", { className: css.muted, children: fmtTime(ts) }, key);
    const badge = (label, tone, key = 'b') => {
        const cls = css[toneClass(tone)] ?? css.badgeMuted;
        return _jsx("td", { children: _jsx("span", { className: `${css.badge} ${cls}`, children: label }) }, key);
    };
    const head = (cols) => (_jsx("thead", { children: _jsx("tr", { children: cols.map(c => _jsx("th", { children: c }, c)) }) }));
    const renderTable = () => {
        switch (kind) {
            case 'revokes':
                return (_jsxs("table", { className: css.table, children: [head(['会话', '消息 ID', '批次 ID', '时间']), _jsx("tbody", { children: items.map((it, i) => (_jsxs("tr", { children: [linkTd(it.session_name, it.msg_local_id, 's', it.session_display), mono(it.msg_local_id, 'm'), mono(it.batch_id, 'b'), timeTd(it.msg_create_time)] }, i))) })] }));
            case 'transfers':
                return (_jsxs("table", { className: css.table, children: [head(['会话', '类型', '收款方', '付款方', '时间']), _jsx("tbody", { children: items.map((it, i) => { const st = transferSubType(it.pay_sub_type); return (_jsxs("tr", { children: [linkTd(it.session_name, undefined, 's', it.session_display), badge(st.label, st.tone, 'b'), td(_jsx("span", { className: css.muted, children: shortUser(it.receiver_display || it.pay_receiver) }), 'r'), td(_jsx("span", { className: css.muted, children: shortUser(it.payer_display || it.pay_payer) }), 'p'), timeTd(it.begin_transfer_time)] }, i)); }) })] }));
            case 'redpackets':
                return (_jsxs("table", { className: css.table, children: [head(['会话', '发送者', '状态', '类型', '消息 ID']), _jsx("tbody", { children: items.map((it, i) => { const st = hbStatus(it.hb_status); return (_jsxs("tr", { children: [linkTd(it.session_name, undefined, 's', it.session_display), td(_jsx("span", { className: css.muted, children: shortUser(it.sender_display || it.sender_user_name) }), 'n'), badge(st.label, st.tone, 'b'), td(_jsx("span", { className: css.muted, children: Number(it.hb_type) === 0 ? '普通红包' : `类型 ${String(it.hb_type)}` }), 't'), mono(it.message_server_id, 'm')] }, i)); }) })] }));
            case 'finder':
                return (_jsxs("table", { className: css.table, children: [head(['视频号', '直播状态', '回放', '直播 ID']), _jsx("tbody", { children: items.map((it, i) => { const st = liveStatus(it.live_status); return (_jsxs("tr", { children: [td(_jsx("span", { className: css.muted, children: shortUser(it.username_display || it.finder_username) }), 'n'), badge(st.label, st.tone, 'b'), td(_jsx("span", { className: css.muted, children: Number(it.replay_status) === 1 ? '有回放' : '—' }), 'r'), mono(it.finder_live_id, 'id')] }, i)); }) })] }));
            case 'miniprograms':
                return (_jsxs("table", { className: css.table, children: [head(['名称', '用户名', 'AppID', '更新时间']), _jsx("tbody", { children: items.map((it, i) => (_jsxs("tr", { children: [td(_jsx("span", { children: String(it.nickname ?? '') || '（未命名）' }), 'n'), td(_jsx("span", { className: css.muted, children: shortUser(it.user_name) }), 'u'), mono(it.app_id, 'a'), timeTd(it.last_update_time)] }, i))) })] }));
            default:
                return (_jsxs("table", { className: css.table, children: [head(['用户', '备注', '验证消息', '类型', '时间']), _jsx("tbody", { children: items.map((it, i) => { const mine = Number(it.is_sender_) === 1; return (_jsxs("tr", { children: [td(_jsx("span", { className: css.muted, children: shortUser(it.user_display || it.user_name_) }), 'u'), td(_jsx("span", { className: css.muted, children: String(it.remark_ ?? '') || '—' }), 'r'), td(_jsx("span", { className: css.ellipsis, children: String(it.content_ ?? '') || '—' }), 'v'), badge(mine ? '我发出的' : '收到的', mine ? 'info' : 'muted', 't'), timeTd(it.timestamp_)] }, i)); }) })] }));
        }
    };
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: _jsxs(_Fragment, { children: [_jsx("span", { className: css.hdIcon, children: meta.icon }), meta.label] }), desc: meta.desc, actions: _jsxs(Badge, { tone: "cyan", children: ["\u5171 ", total.toLocaleString(), " \u6761"] }) }), _jsx(Toolbar, { left: (_jsx(Segmented, { options: KINDS.map(k => ({
                        value: k,
                        label: `${KIND_META[k].icon} ${KIND_META[k].label}${totals[k] != null && totals[k] > 0 ? ` (${totals[k]})` : ''}`,
                    })), value: kind, onChange: (v) => { switchKind(v); }, ariaLabel: "\u8BB0\u5F55\u5206\u7C7B" })) }), _jsx(Toolbar, { left: (_jsxs(_Fragment, { children: [_jsx(SearchInput, { value: keyword, onChange: (v) => { setKeyword(v); }, onEnter: () => { void load(true); }, placeholder: "\u641C\u7D22\u4F1A\u8BDD / \u7528\u6237 / ID\u2026", ariaLabel: "\u641C\u7D22\u8BB0\u5F55" }), TIME_KINDS[kind] && (_jsxs(_Fragment, { children: [_jsx("input", { type: "date", className: css.input, value: fromDate, onChange: (e) => { setFromDate(e.target.value); }, title: "\u5F00\u59CB\u65E5\u671F" }), _jsx("span", { className: css.dateSep, children: "\u81F3" }), _jsx("input", { type: "date", className: css.input, value: toDate, onChange: (e) => { setToDate(e.target.value); }, title: "\u7ED3\u675F\u65E5\u671F" })] }))] })), right: (_jsxs(_Fragment, { children: [_jsx(Segmented, { options: [{ value: 'desc', label: '新→旧' }, { value: 'asc', label: '旧→新' }], value: direction, onChange: (v) => { setDirection(v); }, ariaLabel: "\u6392\u5E8F\u65B9\u5411" }), _jsx("button", { type: "button", className: css.btn, onClick: () => { void load(true); }, disabled: loading, children: "\u641C\u7D22" }), _jsx("button", { type: "button", className: css.btn, onClick: () => { void doExport(); }, disabled: exporting, children: exporting ? '导出中…' : '导出 CSV' })] })) }), notice && _jsx("div", { className: css.notice, children: notice }), _jsxs(Card, { flush: true, children: [error && _jsxs("div", { className: css.empty, children: ["\u26A0\uFE0F ", error] }), loading && items.length === 0 && _jsx(ListSkeleton, { rows: 10 }), !loading && !error && items.length === 0 && _jsxs("div", { className: css.empty, children: ["\u6682\u65E0", meta.label, "\u8BB0\u5F55"] }), !loading && !error && items.length > 0 && (_jsx("div", { className: css.tableScroll, children: renderTable() })), !loading && !error && items.length > 0 && items.length < total && (_jsx("div", { style: { display: 'flex', justifyContent: 'center', padding: 12 }, children: _jsx("button", { type: "button", className: css.loadMore, onClick: () => { void load(false); }, disabled: loading, children: `加载更多（${items.length}/${total}）` }) }))] })] }));
}
//# sourceMappingURL=Records.js.map