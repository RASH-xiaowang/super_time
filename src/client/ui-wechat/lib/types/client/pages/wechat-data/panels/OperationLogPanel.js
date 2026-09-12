import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 操作日志板块：元数据监控 / 筛选 / 导出（独立面板，从设置抽出）。
 * 仅记录操作元数据（时间/类型/动作/对象/结果/上下文），永不保存会话内容。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives';
import { useLazySentinel, usePagedList, ListSentinel } from "./hooks.js";
import { apiClearOperationLog, apiGetOperationLog } from "../api.js";
import { Badge, Card, DataTable, PanelHeader, SearchInput, Segmented, Select, Toolbar } from "../ui/kit.js";
import css from './oplog.module.css';
const OP_CATEGORY_LABEL = {
    settings: '设置', keys: '密钥', sync: '解密/同步', export: '导出', delete: '删除',
    backup: '备份', edit: '编辑', task: '任务', error: '异常',
};
const OP_STATUS_LABEL = { ok: '成功', fail: '失败', skip: '跳过' };
const STATUS_FILTERS = [
    { value: '', label: '全部' },
    { value: 'ok', label: '成功' },
    { value: 'fail', label: '失败' },
    { value: 'skip', label: '跳过' },
];
function opStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function opTime(ts) {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}
function opDownload(name, mime, content) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
function opCsvCell(v) {
    return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
/** 状态徽标颜色。 */
function statusClass(status) {
    return (status === 'ok' ? css.stOk : status === 'fail' ? css.stFail : css.stSkip) ?? '';
}
/** 操作日志板块。 */
export function OperationLogPanel() {
    const [opRows, setOpRows] = useState([]);
    const [opTotal, setOpTotal] = useState(0);
    const [opLoading, setOpLoading] = useState(false);
    const [opMsg, setOpMsg] = useState(null);
    const [opFrom, setOpFrom] = useState('');
    const [opTo, setOpTo] = useState('');
    const [opCat, setOpCat] = useState('');
    const [opStatus, setOpStatus] = useState('');
    const [opSearch, setOpSearch] = useState('');
    const opScrollRef = useRef(null);
    const buildQuery = useCallback((offset, limit) => {
        const q = { limit, offset };
        if (opFrom !== '')
            q.from = new Date(`${opFrom}T00:00:00`).getTime();
        if (opTo !== '')
            q.to = new Date(`${opTo}T23:59:59`).getTime();
        if (opCat !== '')
            q.categories = [opCat];
        if (opStatus !== '')
            q.status = opStatus;
        return q;
    }, [opFrom, opTo, opCat, opStatus]);
    const pager = usePagedList({
        pageSize: 100,
        fetchPage: async (offset, limit) => {
            const snap = await apiGetOperationLog(buildQuery(offset, limit));
            return { items: snap.items, total: snap.total };
        },
    });
    const searching = opSearch.trim() !== '';
    useEffect(() => {
        setOpMsg(null);
        if (searching) {
            let cancelled = false;
            setOpLoading(true);
            void apiGetOperationLog(buildQuery(0, 500))
                .then((snap) => {
                if (cancelled)
                    return;
                setOpRows(snap.items);
                setOpTotal(snap.total);
            })
                .catch((e) => { if (!cancelled)
                setOpMsg({ kind: 'err', text: '✗ 读取操作日志失败：' + e.message }); })
                .finally(() => { if (!cancelled)
                setOpLoading(false); });
            return () => { cancelled = true; };
        }
        pager.reset();
        return undefined;
    }, [searching, buildQuery, pager.reset]);
    useEffect(() => {
        if (searching)
            return;
        setOpRows(pager.items);
        setOpTotal(pager.total);
        setOpLoading(pager.loading);
        if (pager.error)
            setOpMsg({ kind: 'err', text: '✗ 读取操作日志失败：' + pager.error });
    }, [searching, pager.items, pager.total, pager.loading, pager.error]);
    const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore)
        pager.loadMore(); }, '600px 0px', () => opScrollRef.current);
    const refresh = useCallback(() => {
        setOpMsg(null);
        if (searching) {
            setOpLoading(true);
            void apiGetOperationLog(buildQuery(0, 500))
                .then((snap) => { setOpRows(snap.items); setOpTotal(snap.total); })
                .catch((e) => { setOpMsg({ kind: 'err', text: '✗ 读取操作日志失败：' + e.message }); })
                .finally(() => { setOpLoading(false); });
        }
        else {
            pager.reset();
        }
    }, [searching, buildQuery, pager.reset]);
    const summary = useMemo(() => {
        let ok = 0;
        let fail = 0;
        let skip = 0;
        for (const r of opRows) {
            if (r.status === 'ok')
                ok++;
            else if (r.status === 'fail')
                fail++;
            else
                skip++;
        }
        return { ok, fail, skip };
    }, [opRows]);
    // client-side keyword filter on the loaded page (action / target / detail)
    const rows = useMemo(() => {
        const kw = opSearch.trim().toLowerCase();
        if (!kw)
            return opRows;
        return opRows.filter(r => [r.action, r.target, r.detail].some(v => v.toLowerCase().includes(kw)));
    }, [opRows, opSearch]);
    const exportOpTxt = () => {
        const header = '微信数据面板 · 操作日志\n时间\t类型\t操作\t对象\t结果\t上下文\n';
        const lines = rows.map(r => [opTime(r.ts), OP_CATEGORY_LABEL[r.category], r.action, r.target || '—', OP_STATUS_LABEL[r.status], r.detail || '—'].join('\t'));
        opDownload(`操作日志_${opStamp()}.txt`, 'text/plain;charset=utf-8', header + lines.join('\n'));
    };
    const exportOpCsv = () => {
        const header = '时间,类型,操作,对象,结果,上下文\n';
        const lines = rows.map(r => [opTime(r.ts), OP_CATEGORY_LABEL[r.category], r.action, r.target || '—', OP_STATUS_LABEL[r.status], r.detail || '—'].map(opCsvCell).join(','));
        opDownload(`操作日志_${opStamp()}.csv`, 'text/csv;charset=utf-8', '\ufeff' + header + lines.join('\n'));
    };
    const clearOpLog = async () => {
        if (!window.confirm('确定清空全部操作日志？该操作不可恢复。'))
            return;
        setOpLoading(true);
        try {
            const r = await apiClearOperationLog();
            if (r.ok) {
                setOpRows([]);
                setOpTotal(0);
                setOpMsg({ kind: 'ok', text: `✓ 已清空 ${r.removed} 条` });
            }
            else
                setOpMsg({ kind: 'err', text: '✗ 清空失败' });
        }
        catch (e) {
            setOpMsg({ kind: 'err', text: '✗ ' + e.message });
        }
        finally {
            setOpLoading(false);
        }
    };
    const opCols = [
        {
            id: 'time',
            header: '时间',
            cell: r => _jsx("span", { className: css.tdTime, children: opTime(r.ts) }),
            sortValue: r => r.ts,
        },
        {
            id: 'category',
            header: '类型',
            cell: r => _jsx("span", { className: css.tdType, children: OP_CATEGORY_LABEL[r.category] }),
            sortValue: r => OP_CATEGORY_LABEL[r.category],
        },
        {
            id: 'action',
            header: '操作',
            cell: r => _jsx("span", { className: css.tdAction, children: r.action }),
            sortValue: r => r.action,
        },
        {
            id: 'target',
            header: '对象',
            cell: r => _jsx("span", { title: r.target, children: r.target || '—' }),
            sortValue: r => r.target || '',
        },
        {
            id: 'status',
            header: '结果',
            cell: r => _jsx("span", { className: clsx(css.st, statusClass(r.status)), children: OP_STATUS_LABEL[r.status] }),
            sortValue: r => OP_STATUS_LABEL[r.status],
        },
        {
            id: 'detail',
            header: '上下文',
            cell: r => _jsx("span", { title: r.detail, children: r.detail || '—' }),
            sortValue: r => r.detail || '',
        },
    ];
    return (_jsxs("section", { className: css.root, style: { flex: '1 1 auto', minHeight: 0, height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--nm-bg-card)', border: '1px solid var(--nm-border)', borderRadius: 14, overflow: 'hidden' }, children: [_jsx(PanelHeader, { title: (_jsxs(_Fragment, { children: [_jsx("span", { className: css.hdIcon, children: '\u2699' }), "\u64CD\u4F5C\u65E5\u5FD7", _jsxs("span", { className: css.hdBadge, children: [_jsx(StateDot, { state: opTotal > 0 ? 'done' : 'warning' }), opTotal, " \u6761"] })] })), desc: "\u4EC5\u8BB0\u5F55\u64CD\u4F5C\u5143\u6570\u636E\uFF08\u65F6\u95F4/\u7C7B\u578B/\u52A8\u4F5C/\u5BF9\u8C61/\u7ED3\u679C/\u4E0A\u4E0B\u6587\uFF09\uFF0C\u6C38\u4E0D\u4FDD\u5B58\u4F1A\u8BDD\u5185\u5BB9\uFF1B\u6700\u591A\u663E\u793A 500 \u6761\u3002", actions: (_jsxs(_Fragment, { children: [_jsxs(Badge, { tone: "green", children: ["\u6210\u529F ", summary.ok] }), _jsxs(Badge, { tone: "red", children: ["\u5931\u8D25 ", summary.fail] }), _jsxs(Badge, { tone: "amber", children: ["\u8DF3\u8FC7 ", summary.skip] })] })) }), _jsx(Toolbar, { left: (_jsxs(_Fragment, { children: [_jsxs("div", { className: css.range, children: [_jsx("input", { className: css.dateInput, type: "date", value: opFrom, onChange: (e) => { setOpFrom(e.target.value); }, "aria-label": "\u8D77\u59CB\u65E5\u671F" }), _jsx("span", { className: css.rangeSep, children: "\u81F3" }), _jsx("input", { className: css.dateInput, type: "date", value: opTo, onChange: (e) => { setOpTo(e.target.value); }, "aria-label": "\u7ED3\u675F\u65E5\u671F" })] }), _jsx(Select, { value: opCat, onChange: (v) => { setOpCat(v); }, options: [{ value: '', label: '全部分类' }, ...Object.keys(OP_CATEGORY_LABEL).map(c => ({ value: c, label: OP_CATEGORY_LABEL[c] }))], ariaLabel: "\u5206\u7C7B\u7B5B\u9009" }), _jsx(Segmented, { options: STATUS_FILTERS.map(f => ({ value: f.value, label: f.label })), value: opStatus, onChange: (v) => { setOpStatus(v); }, ariaLabel: "\u7ED3\u679C\u7B5B\u9009" })] })), right: (_jsxs(_Fragment, { children: [_jsx(SearchInput, { value: opSearch, onChange: (v) => { setOpSearch(v); }, placeholder: "\u641C\u7D22\u64CD\u4F5C/\u5BF9\u8C61/\u4E0A\u4E0B\u6587", ariaLabel: "\u641C\u7D22\u64CD\u4F5C\u65E5\u5FD7" }), _jsx(Button, { size: "sm", variant: "outline", className: clsx(css.btnFx, css.btnFixedSm), icon: opLoading ? _jsx("span", { className: css.spin }) : undefined, onClick: refresh, disabled: opLoading, children: opLoading ? '加载中…' : '刷新' }), _jsx(Button, { size: "sm", variant: "outline", className: clsx(css.btnFx, css.btnFixedSm), onClick: exportOpTxt, disabled: rows.length === 0, children: "\u5BFC\u51FA TXT" }), _jsx(Button, { size: "sm", variant: "outline", className: clsx(css.btnFx, css.btnFixedSm), onClick: exportOpCsv, disabled: rows.length === 0, children: "\u5BFC\u51FA CSV" }), _jsx(Button, { size: "sm", variant: "outline", className: clsx(css.btnFx, css.btnFixedSm), onClick: () => { void clearOpLog(); }, disabled: opLoading || opTotal === 0, children: "\u6E05\u7A7A" })] })) }), opMsg && _jsx("div", { className: clsx(css.notice, opMsg.kind === 'ok' ? css.noticeOk : css.noticeErr), children: opMsg.text }), _jsxs(Card, { flush: true, children: [_jsx(DataTable, { columns: opCols, rows: rows, getRowId: r => String(r.id), loading: opLoading && rows.length === 0, emptyTitle: opLoading ? '加载中…' : '暂无操作日志，点击「刷新」后分页显示' }), !searching && pager.hasMore && _jsx(ListSentinel, { refFn: loadMoreRef })] })] }));
}
//# sourceMappingURL=OperationLogPanel.js.map