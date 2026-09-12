import { jsxs as _jsxs, jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 年度总结面板 — 忠实迁移 AnnualSummary：年份选择 + 年度报告（Hero/人物标签/
 * 周活跃热力图/月度/消息类型/高频短语/表情宇宙/人际榜/首末句）。仅本地计算。
 */
import { useCallback, useEffect, useState } from 'react';
import { apiExportAnnualReport, apiGetAnnual, apiGetAnnualReport, pickDirectory, readRenderCache, writeRenderCache } from "../api.js";
import { ListSkeleton } from "./hooks.js";
import { Card, PanelHeader, Segmented, Toolbar } from "../ui/kit.js";
import kitCss from '../ui/kit.module.css';
import css from './list-panel.module.css';
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
/** 百分比展示。 */
function pct(n) { return `${Math.round((n || 0) * 100)}%`; }
/** 数字缩写。 */
function fmtNum(n) { if (n >= 10000)
    return (n / 10000).toFixed(1) + 'w'; if (n >= 1000)
    return (n / 1000).toFixed(1) + 'k'; return String(n); }
/** FancyUI-style Marquee: a horizontally auto-scrolling row, pause on hover, edge fade. */
function Marquee({ reverse, duration, children }) {
    return (_jsxs("div", { className: css.marquee, children: [_jsxs("div", { className: css.marqueeTrack, "data-reverse": reverse || undefined, style: { animationDuration: `${duration ?? 20}s` }, children: [children, children] }), _jsx("div", { className: css.marqueeMaskL, "aria-hidden": "true" }), _jsx("div", { className: css.marqueeMaskR, "aria-hidden": "true" })] }));
}
/** Marquee card tile (ReviewCard-style content: icon / title / meta). */
function MarqueeCard({ icon, title, meta }) {
    return (_jsxs("div", { className: css.marqueeCard, children: [icon && _jsx("span", { className: css.marqueeCardIcon, children: icon }), _jsxs("div", { className: css.marqueeCardBody, children: [_jsx("div", { className: css.marqueeCardTitle, children: title }), _jsx("div", { className: css.marqueeCardMeta, children: meta })] })] }));
}
/** Split an array into rows of n for marquee layout. */
function splitRows(arr, n) {
    const rows = [];
    for (let i = 0; i < arr.length; i += n)
        rows.push(arr.slice(i, i + n));
    return rows;
}
/** FancyUI-style Focus: a prominent typographic sentence (eyebrow + statement). */
function Focus({ sentence, eyebrow }) {
    return (_jsxs("div", { className: css.focus, children: [eyebrow !== undefined && _jsx("div", { className: css.focusEyebrow, children: eyebrow }), _jsx("div", { className: css.focusSentence, children: sentence })] }));
}
/** 渲染年度总结长图（Canvas 海报），返回 canvas。 */
function drawAnnualPoster(r) {
    const W = 1200;
    const H = 1900;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');
    if (!ctx)
        return c;
    const accent = '#22d3ee';
    const fg = '#e6ebf2';
    const muted = '#8ea3b8';
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#0b0e13');
    bg.addColorStop(1, '#101a26');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'left';
    let y = 90;
    const title = String(r.year) + ' 微信年度总结';
    ctx.font = '800 56px sans-serif';
    ctx.fillStyle = accent;
    ctx.fillText(title, 70, y);
    y += 26;
    ctx.font = '400 18px sans-serif';
    ctx.fillStyle = muted;
    ctx.fillText('总消息 ' + fmtNum(r.total) + ' 条 · 活跃 ' + String(r.active_days) + ' 天 · 文字 ' + fmtNum(r.text_chars) + ' 字 · 日均 ' + String(r.daily_avg) + ' 条', 70, y);
    y += 40;
    if (r.persona_tags.length > 0) {
        ctx.font = '600 20px sans-serif';
        ctx.fillStyle = fg;
        ctx.fillText('人物标签', 70, y);
        y += 34;
        ctx.font = '500 17px sans-serif';
        let px = 70;
        for (const t of r.persona_tags) {
            const w = ctx.measureText('#' + t).width + 26;
            ctx.fillStyle = 'rgba(34,211,238,0.12)';
            roundRect(ctx, px, y - 24, w, 30, 15);
            ctx.fill();
            ctx.fillStyle = accent;
            ctx.fillText('#' + t, px + 13, y - 4);
            px += w + 10;
        }
        y += 40;
    }
    const section = (t) => {
        ctx.font = '800 30px sans-serif';
        ctx.fillStyle = fg;
        ctx.fillText(t, 70, y);
        y += 26;
        ctx.fillStyle = accent;
        ctx.fillRect(70, y, 70, 4);
        y += 34;
    };
    section('类型占比');
    const shares = [
        ['文字', r.text_share], ['深夜', r.night_share], ['清晨', r.morning_share], ['周末', r.weekend_share], ['群聊', r.group_share],
    ];
    const maxShare = Math.max(0.01, ...shares.map(s2 => s2[1]));
    for (const [label, v] of shares) {
        ctx.font = '500 20px sans-serif';
        ctx.fillStyle = fg;
        ctx.fillText(label, 70, y);
        const bx = 190;
        ctx.fillStyle = 'rgba(255,255,255,0.08)';
        ctx.fillRect(bx, y - 16, 620, 14);
        ctx.fillStyle = accent;
        ctx.fillRect(bx, y - 16, Math.max(6, (v / maxShare) * 620), 14);
        ctx.fillStyle = muted;
        ctx.textAlign = 'right';
        ctx.fillText(String(Math.round(v * 100)) + '%', W - 70, y);
        ctx.textAlign = 'left';
        y += 44;
    }
    y += 8;
    section('周活跃热力图（星期 × 小时）');
    const heatMax = Math.max(1, ...r.heat);
    const cell = 38;
    const hx = 70;
    const hy = y;
    for (let i = 0; i < r.heat.length; i++) {
        const v = r.heat[i] ?? 0;
        const col = i % 24;
        const row = Math.floor(i / 24);
        ctx.fillStyle = 'rgba(34,211,238,' + String(v > 0 ? Math.max(0.08, v / heatMax) : 0.03) + ')';
        ctx.fillRect(hx + col * cell, hy + row * cell, cell - 3, cell - 3);
    }
    ctx.font = '500 14px sans-serif';
    ctx.fillStyle = muted;
    for (let d = 0; d < 7; d++) {
        ctx.fillText(WEEKDAYS[d] ?? '', hx - 34, hy + d * cell + cell - 8);
    }
    y += 7 * cell + 34;
    section('月度活跃');
    const monthlyMax = Math.max(1, ...r.monthly);
    const barH = 200;
    for (let i = 0; i < 12; i++) {
        const v = r.monthly[i] ?? 0;
        const bw = 72;
        const bx = 70 + i * 92;
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.fillRect(bx, y + barH, bw, -barH);
        const h = Math.max(6, (v / monthlyMax) * barH);
        ctx.fillStyle = 'rgba(34,211,238,0.7)';
        ctx.fillRect(bx, y + barH - h, bw, h);
        ctx.font = '500 15px sans-serif';
        ctx.fillStyle = muted;
        ctx.textAlign = 'center';
        ctx.fillText(String(i + 1), bx + bw / 2, y + barH + 26);
        ctx.textAlign = 'left';
    }
    y += barH + 56;
    if (r.top_phrases.length > 0) {
        section('高频短语');
        ctx.font = '500 18px sans-serif';
        let px = 70;
        let py = y;
        for (const ph of r.top_phrases.slice(0, 12)) {
            const label = ph.phrase + '(' + String(ph.count) + ')';
            const w = ctx.measureText(label).width + 22;
            if (px + w > W - 70) {
                px = 70;
                py += 38;
            }
            ctx.fillStyle = 'rgba(255,255,255,0.07)';
            roundRect(ctx, px, py - 22, w, 30, 15);
            ctx.fill();
            ctx.fillStyle = fg;
            ctx.fillText(label, px + 11, py - 2);
            px += w + 8;
        }
        y = py + 40;
    }
    if (r.top_emoji.length > 0) {
        section('表情宇宙');
        ctx.font = '500 22px sans-serif';
        ctx.fillStyle = fg;
        ctx.fillText(r.top_emoji.slice(0, 8).map(e => e.emoji + '×' + String(e.count)).join('  '), 70, y);
        y += 36;
    }
    const rank = (t, items) => {
        section(t);
        const max = Math.max(1, items[0]?.count ?? 1);
        for (const it of items.slice(0, 8)) {
            ctx.font = '500 19px sans-serif';
            ctx.fillStyle = fg;
            ctx.fillText(it.name || it.username, 70, y);
            ctx.fillStyle = 'rgba(255,255,255,0.08)';
            ctx.fillRect(330, y - 14, 480, 12);
            ctx.fillStyle = accent;
            ctx.fillRect(330, y - 14, Math.max(6, (it.count / max) * 480), 12);
            ctx.fillStyle = muted;
            ctx.textAlign = 'right';
            ctx.fillText(String(it.count) + ' 条', W - 70, y);
            ctx.textAlign = 'left';
            y += 38;
        }
        y += 10;
    };
    if (r.top_contacts.length > 0)
        rank('聊得最多的人', r.top_contacts);
    if (r.top_groups.length > 0)
        rank('最活跃的群聊', r.top_groups);
    section('年度首尾句');
    ctx.font = '400 20px sans-serif';
    ctx.fillStyle = muted;
    ctx.fillText('首句', 70, y);
    y += 30;
    ctx.fillStyle = fg;
    ctx.fillText(trunc(r.first_message ?? '', 44), 70, y);
    y += 38;
    ctx.fillStyle = muted;
    ctx.fillText('末句', 70, y);
    y += 30;
    ctx.fillStyle = fg;
    ctx.fillText(trunc(r.last_message ?? '', 44), 70, y);
    ctx.font = '500 16px sans-serif';
    ctx.fillStyle = muted;
    ctx.textAlign = 'center';
    ctx.fillText('由 deepseek-harness · 本地解密生成', W / 2, H - 40);
    ctx.textAlign = 'left';
    return c;
}
function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + rr, rr);
    ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
    ctx.arcTo(x, y + h, x + rr, y + h, rr);
    ctx.arcTo(x, y + h - rr, x, y + h, rr);
    ctx.closePath();
}
function trunc(s, n) {
    return s.length > n ? s.slice(0, n) + '…' : s;
}
/**
 * Render the annual-summary panel.
 * @returns the annual element tree.
 */
export function AnnualPanel() {
    const [years, setYears] = useState([]);
    const [year, setYear] = useState(0);
    const [report, setReport] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [notice, setNotice] = useState(null);
    const [expDir, setExpDir] = useState('');
    const [pickingDir, setPickingDir] = useState(false);
    useEffect(() => {
        apiGetAnnual()
            .then((env) => {
            const ys = env.years.filter(n => Number.isFinite(n) && n > 2000);
            setYears(ys);
            if (ys.length > 0)
                setYear(ys[0]);
        })
            .catch((e) => { setError(e.message); });
    }, []);
    const loadReport = useCallback(async (y) => {
        if (!y)
            return;
        setError(null);
        const cached = readRenderCache(`annual:${y}`);
        if (cached) {
            setReport(cached);
            setLoading(false);
        }
        else {
            setLoading(true);
        }
        try {
            const r = await apiGetAnnualReport({ year: y });
            setReport(r);
            writeRenderCache(`annual:${y}`, r);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, []);
    // 年度报告按需计算：选中/点击某个年份时才生成，不再进入页签就自动跑全量年度统计。
    const pickYear = useCallback((y) => {
        setYear(y);
        void loadReport(y);
    }, [loadReport]);
    const doExport = async (format) => {
        if (!year)
            return;
        try {
            const opts = { year, format };
            if (expDir)
                opts.dir = expDir;
            const r = await apiExportAnnualReport(opts);
            setNotice('已导出 ' + String(r.count) + ' 条 → ' + r.path);
            setTimeout(() => { setNotice(null); }, 5000);
        }
        catch (e) {
            setNotice('导出失败: ' + e.message);
        }
    };
    const chooseExportDir = async () => {
        if (pickingDir)
            return;
        setPickingDir(true);
        try {
            const dir = await pickDirectory();
            if (dir)
                setExpDir(dir);
        }
        finally {
            setPickingDir(false);
        }
    };
    const doExportPng = () => {
        if (!report)
            return;
        try {
            const canvas = drawAnnualPoster(report);
            const url = canvas.toDataURL('image/png');
            const a = document.createElement('a');
            a.href = url;
            a.download = '微信年度总结_' + String(report.year) + '.png';
            a.click();
            setTimeout(() => { URL.revokeObjectURL(url); }, 2000);
            setNotice('已生成年度总结长图，请查看下载');
            setTimeout(() => { setNotice(null); }, 5000);
        }
        catch (e) {
            setNotice('长图生成失败: ' + e.message);
        }
    };
    const heatMax = Math.max(1, ...(report?.heat ?? []));
    const monthlyMax = Math.max(1, ...(report?.monthly ?? []));
    const topContactShare = report?.top_contacts[0]?.share ?? 0;
    const topGroupShare = report?.top_groups[0]?.share ?? 0;
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u5E74\u5EA6\u603B\u7ED3", desc: "\u4ECE\u89E3\u5BC6\u6570\u636E\u4E2D\u751F\u6210\u7684\u5FAE\u4FE1\u5E74\u5EA6\u62A5\u544A \u00B7 \u4EC5\u672C\u5730\u8BA1\u7B97" }), _jsx(Toolbar, { left: years.length > 0 ? (_jsx(Segmented, { options: years.map(y => ({ value: String(y), label: String(y) })), value: String(year || ''), onChange: (v) => { pickYear(Number(v)); }, ariaLabel: "\u5E74\u5EA6\u9009\u62E9" })) : undefined, right: (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: css.catBtn, onClick: () => { void doExport('md'); }, children: "\u5BFC\u51FA MD" }), _jsx("button", { type: "button", className: css.catBtn, onClick: () => { void doExport('html'); }, children: "\u5BFC\u51FA HTML" }), _jsx("button", { type: "button", className: css.catBtn, onClick: () => { void doExport('json'); }, children: "\u5BFC\u51FA JSON" }), _jsx("button", { type: "button", className: css.catBtn, onClick: doExportPng, children: "\u5BFC\u51FA\u957F\u56FE PNG" }), _jsxs("button", { type: "button", className: css.catBtn, onClick: () => { void chooseExportDir(); }, disabled: pickingDir, children: ["\u9009\u62E9\u76EE\u5F55", expDir ? ' ✓' : ''] }), expDir && _jsx("span", { className: css.rowMeta, title: expDir, children: expDir })] })) }), notice && _jsx("div", { className: css.rowMeta, children: notice }), loading && !report && _jsx(ListSkeleton, { rows: 10 }), error && _jsxs("div", { className: css.empty, children: ["\u26A0\uFE0F ", error] }), !loading && !error && !report && years.length === 0 && _jsx("div", { className: css.empty, children: "\u8FD8\u6CA1\u6709\u53EF\u7EDF\u8BA1\u7684\u6D88\u606F\u6570\u636E" }), !loading && !error && !report && years.length > 0 && _jsx("div", { className: css.empty, children: "\u70B9\u51FB\u4E0A\u65B9\u5E74\u4EFD\u751F\u6210\u5E74\u5EA6\u62A5\u544A" }), !loading && !error && report && (_jsx("div", { className: css.scroll, children: _jsxs("div", { className: css.reportGrid, children: [_jsx(Card, { title: `${report.year} 年，你说了 ${fmtNum(report.total)} 条消息`, children: _jsxs("div", { className: css.cardBody, children: [_jsxs("div", { className: css.rowMeta, children: ["\u5728 ", report.active_days, " \u5929\u91CC\u7D2F\u8BA1\u5199\u4E0B ", fmtNum(report.text_chars), " \u5B57\uFF0C\u65E5\u5747 ", report.daily_avg, " \u6761"] }), _jsxs("div", { className: css.statChips, children: [_jsxs("span", { className: css.statChip, children: ["\u6D3B\u8DC3 ", _jsxs("b", { children: [report.active_days, " \u5929"] })] }), _jsxs("span", { className: css.statChip, children: ["\u6587\u5B57 ", _jsx("b", { children: pct(report.text_share) })] }), _jsxs("span", { className: css.statChip, children: ["\u6DF1\u591C ", _jsx("b", { children: pct(report.night_share) })] }), _jsxs("span", { className: css.statChip, children: ["\u6E05\u6668 ", _jsx("b", { children: pct(report.morning_share) })] }), _jsxs("span", { className: css.statChip, children: ["\u5468\u672B ", _jsx("b", { children: pct(report.weekend_share) })] }), _jsxs("span", { className: css.statChip, children: ["\u7FA4\u804A ", _jsx("b", { children: pct(report.group_share) })] })] }), _jsxs("div", { className: css.tagRow, children: [_jsx("span", { className: css.rowMeta, children: "\u4EBA\u7269\u6807\u7B7E\uFF1A" }), report.persona_tags.map(t => (_jsxs("span", { className: css.tagChip, children: ["#", t] }, t)))] })] }) }), _jsx(Card, { title: "\u5468\u6D3B\u8DC3\u70ED\u529B\u56FE\uFF08\u661F\u671F \u00D7 \u5C0F\u65F6\uFF09", children: _jsxs("div", { className: css.heatGrid, children: [WEEKDAYS.map(w => (_jsx("div", { className: css.rowMeta, children: w }, w))), report.heat.map((v, i) => (_jsx("div", { className: css.heatCell, title: `${WEEKDAYS[Math.floor(i / 24)]} ${i % 24}:00 · ${v} 条`, style: { background: `rgba(34, 211, 238, ${v > 0 ? Math.max(0.08, v / heatMax) : 0.03})` } }, i)))] }) }), _jsx(Card, { title: "\u6708\u5EA6\u6D3B\u8DC3", children: _jsx("div", { className: css.monthlyBar, children: report.monthly.map((m, i) => (_jsxs("div", { className: css.monthCol, title: `${i + 1}月 · ${m} 条`, children: [_jsx("div", { className: css.monthFill, style: { height: `${Math.max(2, (m / monthlyMax) * 60)}px` } }), _jsx("span", { className: css.rowMeta, children: i + 1 })] }, i))) }) }), _jsxs("div", { className: kitCss.cardGrid, children: [_jsx(Card, { title: "\u6D88\u606F\u7C7B\u578B", children: splitRows(Object.entries(report.kind_counts).map(([k, v]) => ({ k, v })), 3).map((row, ri) => (_jsx(Marquee, { reverse: ri % 2 === 1, duration: 18, children: row.map(item => _jsx(MarqueeCard, { title: item.k, meta: `${String(item.v)} 条` }, item.k)) }, ri))) }), _jsx(Card, { title: "\u9AD8\u9891\u77ED\u8BED", children: splitRows(report.top_phrases.slice(0, 12), 6).map((row, ri) => (_jsx(Marquee, { reverse: ri % 2 === 1, duration: 22, children: row.map(p => _jsx(MarqueeCard, { title: p.phrase, meta: `×${p.count}` }, p.phrase)) }, ri))) })] }), _jsxs("div", { className: kitCss.cardGrid, children: [_jsx(Card, { title: "\u8868\u60C5\u5B87\u5B99", children: splitRows(report.top_emoji.slice(0, 8), 4).map((row, ri) => (_jsx(Marquee, { reverse: ri % 2 === 1, duration: 16, children: row.map(e => _jsx(MarqueeCard, { icon: e.emoji, title: e.emoji, meta: `×${e.count}` }, e.emoji)) }, ri))) }), _jsxs(Card, { title: `${report.year} 的第一句与最后一句`, children: [_jsx(Focus, { eyebrow: "\u9996\u53E5", sentence: report.first_message ?? '—' }), _jsx(Focus, { eyebrow: "\u672B\u53E5", sentence: report.last_message ?? '—' })] })] }), _jsxs("div", { className: kitCss.cardGrid, children: [_jsx(Card, { title: `聊得最多的人（占全年 ${pct(topContactShare)}）`, children: report.top_contacts.map((c, i) => (_jsxs("div", { className: css.barRow, children: [_jsxs("span", { className: css.barLabel, children: [i + 1, ". ", c.name] }), _jsx("div", { className: css.barTrack, children: _jsx("div", { className: css.barFill, style: { width: `${(c.count / (report.top_contacts[0]?.count ?? 1)) * 100}%` } }) }), _jsxs("span", { className: css.barValue, children: [c.count, " \u6761"] })] }, c.username))) }), _jsx(Card, { title: `最活跃的群聊（占全年 ${pct(topGroupShare)}）`, children: report.top_groups.map((c, i) => (_jsxs("div", { className: css.barRow, children: [_jsxs("span", { className: css.barLabel, children: [i + 1, ". ", c.name] }), _jsx("div", { className: css.barTrack, children: _jsx("div", { className: css.barFill, style: { width: `${(c.count / (report.top_groups[0]?.count ?? 1)) * 100}%` } }) }), _jsxs("span", { className: css.barValue, children: [c.count, " \u6761"] })] }, c.username))) })] })] }) }))] }));
}
//# sourceMappingURL=Annual.js.map