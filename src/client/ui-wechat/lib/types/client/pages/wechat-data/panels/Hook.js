import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 原图能力自检面板 — 图片链路本地化说明与自检（密钥/数据库路径/解密能力），
 * 高清原图获取走本地缓存与解码，不依赖任何原生注入或桥接。
 */
import { useEffect, useState } from 'react';
import { LazyMount } from "./hooks.js";
import { apiGetDbHealth, apiGetStorageStats, apiGetWechatConfig, readRenderCache, writeRenderCache } from "../api.js";
import { Card, PanelHeader, StatCard, StatGrid } from "../ui/kit.js";
import css from './list-panel.module.css';
function fmtBytes(n) {
    if (n <= 0)
        return '0 B';
    if (n < 1048576)
        return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
}
/**
 * Render the original-image capability self-check panel.
 * @param props - optional tab navigation callback for quick jumps.
 * @returns the panel element tree.
 */
export function HookPanel({ onNavigate } = {}) {
    const [cfg, setCfg] = useState(() => readRenderCache('hook-config'));
    const [health, setHealth] = useState(null);
    const [storage, setStorage] = useState(null);
    const [error, setError] = useState(null);
    const [loading, setLoading] = useState(true);
    const [statsVisible, setStatsVisible] = useState(false);
    useEffect(() => {
        const cached = readRenderCache('hook-config');
        if (cached)
            setCfg(cached);
        apiGetWechatConfig()
            .then((c) => { setCfg(c); writeRenderCache('hook-config', c); })
            .catch((e) => { setError(e.message); })
            .finally(() => { setLoading(false); });
    }, []);
    // 健康/存储统计较重：滚动到统计区块附近时才计算，不阻塞页签首屏。
    useEffect(() => {
        if (!statsVisible)
            return;
        let alive = true;
        apiGetDbHealth().then((h) => { if (alive)
            setHealth(h); }).catch(() => { });
        apiGetStorageStats().then((s) => { if (alive)
            setStorage(s); }).catch(() => { });
        return () => { alive = false; };
    }, [statsVisible]);
    const hasKeys = Boolean(cfg && (cfg.key_format || cfg.db_dir));
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: "\u539F\u56FE\u80FD\u529B\u81EA\u68C0", desc: "\u672C\u5730\u89E3\u7801 \u00B7 \u65E0\u6CE8\u5165 / \u65E0\u6865\u63A5" }), _jsxs("div", { className: css.scroll, children: [_jsx(Card, { title: "\u56FE\u7247\u5982\u4F55\u672C\u5730\u89E3\u7801\uFF1F", children: _jsx("div", { className: css.entryA, children: "\u5FAE\u4FE1 4.x \u7684\u6D88\u606F\u56FE\u7247\u901A\u8FC7\u300C\u5DF2\u89E3\u7801\u7F13\u5B58 \u2192 .dat \u89E3\u5BC6 \u2192 hardlink \u5B9A\u4F4D\u300D\u94FE\u8DEF\u5728\u672C\u5730\u5B8C\u6210\u8BFB\u53D6\u4E0E\u89E3\u7801 \uFF08DSH \u56FE\u7247\u63A5\u53E3\uFF0C\u5BC6\u94A5\u6765\u81EA\u672C\u673A\u81EA\u52A8\u626B\u63CF\u6216\u624B\u52A8\u914D\u7F6E\uFF09\u3002\u9AD8\u6E05\u539F\u56FE\u4F9D\u8D56\u672C\u673A\u7F13\u5B58\u4E0E\u7CFB\u7EDF\u89E3\u7801\u5668 \uFF08wxgf/HEVC \u652F\u6301\uFF09\uFF1B\u672C\u9875\u4E0D\u8FDB\u884C\u4EFB\u4F55\u8FDB\u7A0B\u6CE8\u5165\u3002" }) }), _jsxs(StatGrid, { children: [_jsx(StatCard, { icon: "\uD83D\uDD11", value: hasKeys ? '已配置' : '待配置', label: "\u56FE\u7247\u5BC6\u94A5", tone: hasKeys ? 'green' : 'amber' }), _jsx(StatCard, { icon: "\uD83D\uDDC4\uFE0F", value: cfg?.db_dir || '—', label: "\u6570\u636E\u5E93\u8DEF\u5F84" }), _jsx(StatCard, { icon: "\uD83E\uDDEC", value: cfg?.key_format || '—', label: "\u5BC6\u94A5\u683C\u5F0F" }), _jsx(StatCard, { icon: "\uD83D\uDEAB", value: "\u4E0D\u542F\u7528", label: "\u6CE8\u5165\u80FD\u529B", tone: "red" })] }), _jsx(LazyMount, { onShow: () => { setStatsVisible(true); }, children: _jsxs(StatGrid, { children: [_jsx(StatCard, { icon: "\uD83D\uDDBC\uFE0F", value: health ? `${health.decodedImagesCount.toLocaleString()} 张 · ${fmtBytes(health.decodedImagesBytes)}` : '统计中…', label: "\u89E3\u7801\u7F13\u5B58", tone: "purple" }), _jsx(StatCard, { icon: "\uD83D\uDCBE", value: storage ? `${storage.total_count.toLocaleString()} 项 · ${fmtBytes(storage.total_size)}` : '统计中…', label: "\u5A92\u4F53\u8D44\u6E90", tone: "blue" }), _jsx(StatCard, { icon: "\u26A1", value: hasKeys ? '密钥就绪 · 可本地解码' : '仅 CDN 缩略图', label: "\u672C\u5730\u56FE\u7247\u94FE\u8DEF", tone: hasKeys ? 'green' : 'red' })] }) }), (onNavigate || health || storage) && (_jsxs("div", { className: css.row, style: { gap: 8, flexWrap: 'wrap' }, children: [onNavigate && _jsx("button", { type: "button", className: css.catBtn, onClick: () => { onNavigate('files'); }, children: "\u67E5\u770B\u6587\u4EF6\u8D44\u4EA7" }), onNavigate && _jsx("button", { type: "button", className: css.catBtn, onClick: () => { onNavigate('storage'); }, children: "\u67E5\u770B\u5B58\u50A8\u5360\u7528" }), onNavigate && _jsx("button", { type: "button", className: css.catBtn, onClick: () => { onNavigate('settings'); }, children: "\u524D\u5F80\u8BBE\u7F6E" })] })), loading && !error && _jsx("div", { className: css.empty, children: "\u6B63\u5728\u8BFB\u53D6\u914D\u7F6E\u2026" }), error && _jsxs("div", { className: css.empty, children: ["\u26A0\uFE0F ", error] }), cfg && cfg.db_dir && (_jsx(Card, { title: "\u5F53\u524D\u56FE\u7247\u80FD\u529B", children: _jsx("div", { className: css.entryA, children: "\u00B7 \u5DF2\u914D\u7F6E\u56FE\u7247\u5BC6\u94A5\u65F6\uFF0C\u6D88\u606F\u56FE\u7247\u53EF\u6309 MD5 \u8D70\u300C\u5DF2\u89E3\u7801\u7F13\u5B58 \u2192 .dat \u89E3\u5BC6 \u2192 hardlink \u5B9A\u4F4D\u300D\u94FE\u8DEF\uFF08DSH \u56FE\u7247\u63A5\u53E3\uFF09\u3002 \u00B7 \u672A\u914D\u7F6E\u5BC6\u94A5\u65F6\uFF0C\u4EC5\u80FD\u5C55\u793A CDN \u7F29\u7565\u56FE\uFF1B\u5EFA\u8BAE\u5728\u300C\u8BBE\u7F6E\u300D\u4E2D\u914D\u7F6E\u56FE\u7247 AES \u5BC6\u94A5\u4E0E XOR \u503C\u3002 \u00B7 \u539F\u56FE\uFF08wxgf/HEVC\uFF09\u9700\u7CFB\u7EDF\u89E3\u7801\u5668\uFF1B\u53EF\u7528\u7F29\u7565\u56FE _t/_h \u515C\u5E95\u3002" }) }))] })] }));
}
//# sourceMappingURL=Hook.js.map