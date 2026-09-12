import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 资金账本面板 — 转账/红包按月汇总：收入/支出/净额、联系人排行、红包手气、
 * 异常清单，支持 CSV 导出。金额来自本机消息解析，全部本地计算。
 */
import { useCallback, useEffect, useState } from 'react';
import { ListSentinel, useProgressiveList } from "./hooks.js";
import { apiGetLedger, readRenderCache, writeRenderCache } from "../api.js";
import { Card, CellPrimary, DataTable, Mono, PanelHeader, StatCard, StatGrid } from "../ui/kit.js";
import kitCss from '../ui/kit.module.css';
import css from './ledger.module.css';
const DIR_LABEL = {
    in: '收到',
    out: '发出',
    unknown: '未知',
};
function fmtMoney(n) {
    return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/**
 * Render the funds ledger panel.
 * @param props - optional chat navigation callback.
 * @returns the ledger element tree.
 */
export function LedgerPanel({ onOpenChat } = {}) {
    const [month, setMonth] = useState('');
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const load = useCallback(async (m) => {
        setLoading(true);
        setError(null);
        const key = 'ledger:' + (m || 'all');
        const cached = readRenderCache(key);
        if (cached)
            setData(cached);
        try {
            const r = await apiGetLedger(m ? { month: m } : undefined);
            setData(r);
            writeRenderCache(key, r);
        }
        catch (e) {
            if (!cached)
                setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { void load(month); }, [month, load]);
    const exportCsv = useCallback(() => {
        if (!data)
            return;
        const lines = ['联系人,方向,笔数,金额'];
        for (const r of data.byContact) {
            lines.push(`${r.name},${DIR_LABEL[r.direction]},${r.count},${r.amount.toFixed(2)}`);
        }
        const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `微信资金账本_${data.month || '全部'}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
        setNotice('已导出 CSV');
        window.setTimeout(() => { setNotice(null); }, 3000);
    }, [data]);
    const net = data ? data.summary.totalAmountIn - data.summary.totalAmountOut : 0;
    const { count: contactCount, sentinelRef } = useProgressiveList(data?.byContact.length ?? 0, 80);
    /** 联系人资金排行列（本页排序）。 */
    const contactCols = [
        {
            id: 'name',
            header: '联系人',
            cell: r => (r.username
                ? _jsx("button", { type: "button", className: css.link, onClick: () => { onOpenChat?.(r.username); }, title: r.username, children: r.name })
                : _jsx(CellPrimary, { children: r.name })),
            sortValue: r => r.name,
        },
        {
            id: 'direction',
            header: '方向',
            cell: r => _jsx("span", { className: css.dirBadge, "data-kind": r.direction, children: DIR_LABEL[r.direction] }),
            sortValue: r => DIR_LABEL[r.direction],
        },
        {
            id: 'count',
            header: '笔数',
            cell: r => r.count,
            sortValue: r => r.count,
            align: 'right',
        },
        {
            id: 'amount',
            header: '金额',
            cell: r => _jsxs(Mono, { children: ["\u00A5 ", fmtMoney(r.amount)] }),
            sortValue: r => r.amount,
            align: 'right',
        },
    ];
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u8D44\u91D1\u8D26\u672C", desc: "\u8F6C\u8D26/\u7EA2\u5305\u6309\u6708\u6C47\u603B \u00B7 \u91D1\u989D\u6765\u81EA\u672C\u673A\u6D88\u606F\u89E3\u6790 \u00B7 \u4EC5\u672C\u5730\u8BA1\u7B97", actions: (_jsxs(_Fragment, { children: [_jsx("input", { type: "month", className: css.input, value: month, onChange: (e) => { setMonth(e.target.value); }, "aria-label": "\u8D26\u672C\u6708\u4EFD" }), _jsx("button", { type: "button", className: css.btn, onClick: () => { setMonth(''); }, "data-active": month === '' || undefined, children: "\u5168\u90E8" }), _jsx("button", { type: "button", className: css.btn, onClick: exportCsv, disabled: !data, children: "\u5BFC\u51FA CSV" })] })) }), notice && _jsx("div", { className: css.notice, children: notice }), error && _jsx("div", { className: css.error, role: "alert", children: error }), loading && !data && _jsx("div", { className: css.empty, children: "\u6B63\u5728\u7EDF\u8BA1\u8D44\u91D1\u8D26\u672C\u2026" }), data && (_jsxs(_Fragment, { children: [_jsxs(StatGrid, { children: [_jsx(StatCard, { icon: "\uD83D\uDCB0", value: `¥ ${fmtMoney(data.summary.totalAmountIn)}`, label: "\u603B\u6536\u5165", tone: "green" }), _jsx(StatCard, { icon: "\uD83D\uDCB8", value: `¥ ${fmtMoney(data.summary.totalAmountOut)}`, label: "\u603B\u652F\u51FA", tone: "red" }), _jsx(StatCard, { icon: "\uD83E\uDDEE", value: `¥ ${fmtMoney(net)}`, label: "\u51C0\u989D", tone: net >= 0 ? 'green' : 'red' }), _jsx(StatCard, { icon: "\uD83D\uDD01", value: `${data.summary.transfers} 笔`, label: "\u8F6C\u8D26" }), _jsx(StatCard, { icon: "\uD83E\uDDE7", value: `${data.summary.redpacketsReceived} 个 · ¥ ${fmtMoney(data.summary.redpacketAmountReceived)}`, label: "\u7EA2\u5305\u6536\u5230", tone: "purple" }), _jsx(StatCard, { icon: "\uD83D\uDCE4", value: `${data.summary.redpacketsSent} 个 · ¥ ${fmtMoney(data.summary.redpacketAmountSent)}`, label: "\u7EA2\u5305\u53D1\u51FA", tone: "blue" })] }), _jsxs("div", { className: kitCss.cardGrid, children: [_jsx(Card, { title: `联系人资金排行 Top ${data.byContact.length}`, flush: true, children: data.byContact.length === 0 ? (_jsx("div", { className: css.empty, children: "\u6682\u65E0\u8F6C\u8D26/\u7EA2\u5305\u8D44\u91D1\u5F80\u6765" })) : (_jsxs(_Fragment, { children: [_jsx(DataTable, { columns: contactCols, rows: data.byContact.slice(0, contactCount), getRowId: (r, i) => `${r.username}:${r.direction}:${i}` }), data.byContact.length > contactCount && _jsx(ListSentinel, { refFn: sentinelRef })] })) }), _jsx(Card, { title: "\u7EA2\u5305\u624B\u6C14", children: _jsxs("div", { className: css.rpStats, children: [_jsxs("div", { className: css.rpRow, children: [_jsx("span", { children: "\u6536\u5230" }), _jsxs("b", { children: [data.redpacket.receivedCount, " \u4E2A"] })] }), _jsxs("div", { className: css.rpRow, children: [_jsx("span", { children: "\u6536\u5230\u91D1\u989D" }), _jsxs("b", { children: ["\u00A5 ", fmtMoney(data.redpacket.receivedAmount)] })] }), _jsxs("div", { className: css.rpRow, children: [_jsx("span", { children: "\u6700\u4F73\u624B\u6C14" }), _jsxs("b", { children: ["\u00A5 ", fmtMoney(data.redpacket.bestAmount)] })] }), _jsxs("div", { className: css.rpRow, children: [_jsx("span", { children: "\u5E73\u5747\u6BCF\u4E2A" }), _jsxs("b", { children: ["\u00A5 ", fmtMoney(data.redpacket.avgAmount)] })] }), _jsxs("div", { className: css.rpRow, children: [_jsx("span", { children: "\u53D1\u51FA" }), _jsxs("b", { children: [data.redpacket.sentCount, " \u4E2A"] })] }), _jsxs("div", { className: css.rpRow, children: [_jsx("span", { children: "\u53D1\u51FA\u91D1\u989D" }), _jsxs("b", { children: ["\u00A5 ", fmtMoney(data.redpacket.sentAmount)] })] })] }) })] }), _jsx(Card, { title: "\u5F02\u5E38\u63D0\u9192", children: data.warnings.length === 0 ? (_jsx("div", { className: css.empty, children: "\u6682\u65E0\u5F02\u5E38\uFF08\u8F6C\u8D26\u8D85\u65F6/\u7EA2\u5305\u9000\u56DE\uFF09" })) : (_jsx("div", { className: css.warnList, children: data.warnings.map((w, i) => (_jsxs("div", { className: css.warn, children: [_jsx("span", { className: css.warnIcon, children: "\u26A0\uFE0F" }), _jsxs("div", { className: css.warnBody, children: [_jsxs("div", { className: css.warnTitle, children: [w.label, " \u00B7 ", w.name || w.username || '—'] }), _jsxs("div", { className: css.warnMeta, children: ["\u00A5 ", fmtMoney(w.amount ?? 0)] })] })] }, `${w.kind}:${i}`))) })) })] }))] }));
}
//# sourceMappingURL=Ledger.js.map