import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 社交图谱面板 — Obsidian 风格重设计
 * 顶部工具条 + 头像节点图谱画布 + 右侧折叠控制面板(统计/选中详情/圈子聚焦/筛选/外观/布局)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGetAvatar, apiGetGraph, readRenderCache, writeRenderCache } from "../api.js";
import { buildGraph, communityColor, connectedEdgesOf, DEFAULT_GRAPH_SETTINGS, groupCommunities, localGraph, sharedGroupNames } from "./graph-model.js";
import { EchartsGraphCanvas } from "./EchartsGraphCanvas.js";
import { PanelHeader, Select } from "../ui/kit.js";
import css from './graph.module.css';
function Slider({ label, value, min, max, step, onChange, fmt, disabled }) {
    return (_jsxs("label", { className: css.ctlRow, "data-disabled": disabled || undefined, children: [_jsx("span", { className: css.ctlLabel, children: label }), _jsx("input", { type: "range", min: min, max: max, step: step, value: value, onChange: (e) => { onChange(Number(e.target.value)); }, className: css.ctlRange, disabled: disabled || undefined }), _jsx("span", { className: css.ctlValue, children: fmt ? fmt(value) : String(value) })] }));
}
function Toggle({ label, checked, onChange }) {
    return (_jsxs("button", { type: "button", className: css.ctlToggle, "data-on": checked || undefined, onClick: () => { onChange(!checked); }, children: [_jsx("span", { className: css.ctlTrack, children: _jsx("i", { className: css.ctlKnob }) }), _jsx("span", { children: label })] }));
}
/**
 * 社交关系图谱加载画面 — 太空舱风格:旋转光环 + 脉动核心 + 环绕节点,
 * 暗示节点/连线/圈子正在成形。
 */
function GraphLoading() {
    const nodes = Array.from({ length: 8 });
    return (_jsxs("div", { className: css.graphLoading, "aria-busy": "true", children: [_jsxs("div", { className: css.graphLoadingOrbit, children: [_jsx("div", { className: css.graphLoadingRing }), _jsx("div", { className: css.graphLoadingCore }), _jsx("div", { className: css.graphLoadingNodes, children: nodes.map((_, i) => (_jsx("span", { className: css.graphLoadingNode, style: { '--a': `${i * 45}deg`, '--i': i } }, i))) })] }), _jsx("div", { className: css.graphLoadingLabel, children: "\u6B63\u5728\u6784\u5EFA\u793E\u4EA4\u5173\u7CFB\u56FE\u8C31\u2026" }), _jsx("div", { className: css.graphLoadingSub, children: "\u6B63\u5728\u52A0\u8F7D\u8282\u70B9 \u00B7 \u8FDE\u7EBF \u00B7 \u5708\u5B50" })] }));
}
/**
 * Render the social graph panel.
 * @param props - optional cross-panel chat opener (查看聊天).
 * @returns the graph element tree.
 */
export function GraphPanel({ onOpenChat }) {
    const [data, setData] = useState(() => readRenderCache('graph'));
    const [settings, setSettings] = useState({ ...DEFAULT_GRAPH_SETTINGS });
    // 默认跟随 DSH 主题:深色背景 + 主题变量色
    const [dark, setDark] = useState(() => (readRenderCache('graph-theme') ?? true));
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [selectedId, setSelectedId] = useState(null);
    const [railOpen, setRailOpen] = useState(true);
    const [search, setSearch] = useState('');
    // 固定节点(画布锚点;布局/拖拽联动都不移动)
    const [pinned, setPinned] = useState(() => new Set());
    // 圈子聚焦:选中一个圈子高亮,其余淡出(null=关闭)
    const [focusCommunity, setFocusCommunity] = useState(null);
    const [hoverCommunity, setHoverCommunity] = useState(null);
    // 选中详情头像
    const [selAvatar, setSelAvatar] = useState('');
    /** 数据已加载标记(稳定引用,避免 load 依赖 data 造成无限重拉循环)。 */
    const dataRef = useRef(data);
    // 海报导出选择:风格 + 比例
    const [posterStyle, setPosterStyle] = useState('dark');
    const [posterRatio, setPosterRatio] = useState('1:1');
    const [exporting, setExporting] = useState(false);
    const canvasRef = useRef(null);
    const patch = (p) => { setSettings(prev => ({ ...prev, ...p })); };
    const toggleTheme = () => { setDark((v) => { writeRenderCache('graph-theme', !v); return !v; }); };
    /** 恢复默认参数(含清除固定/聚焦/选中)。 */
    const isDefaultSettings = JSON.stringify(settings) === JSON.stringify(DEFAULT_GRAPH_SETTINGS);
    const restoreDefaults = () => {
        setSettings({ ...DEFAULT_GRAPH_SETTINGS });
        setPinned(new Set());
        setFocusCommunity(null);
        setHoverCommunity(null);
        setSelectedId(null);
    };
    const load = useCallback(async () => {
        setError(null);
        if (dataRef.current === null)
            setLoading(true);
        try {
            const env = await apiGetGraph();
            dataRef.current = env;
            setData(env);
            writeRenderCache('graph', env);
            // 性能:若用户未自定义「节点上限」,按候选节点数动态封顶(≤250),大图也流畅;
            // 一旦用户改过(非默认档),后续刷新不再覆盖。
            setSettings(prev => prev.nodeLimit === DEFAULT_GRAPH_SETTINGS.nodeLimit
                ? { ...prev, nodeLimit: Math.min(DEFAULT_GRAPH_SETTINGS.nodeLimit, Math.max(1, env.nodes.filter(n => n.kind !== 'group' && n.kind !== 'self').length)) }
                : prev);
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);
    // 性能:buildGraph 只随「结构参数」(模式/上限/阈值/仅好友)重建;
    // 外观参数(大小/粗细/标签等)由画布逐帧读取,拖动滑杆不再触发全量图重建
    const graph = useMemo(() => buildGraph(data, settings), [data, settings.mode, settings.nodeLimit, settings.minCommon, settings.friendsOnly]);
    // 深度过滤:有选中节点时以它为锚,否则自动锚定「我」——深度滑杆无需先选中即可生效
    const displayGraph = useMemo(() => {
        if (settings.depth > 0)
            return localGraph(graph, selectedId ?? 'self', settings.depth);
        return graph;
    }, [graph, selectedId, settings.depth]);
    const selected = useMemo(() => graph.nodes.find(n => n.id === selectedId) ?? null, [graph, selectedId]);
    // 洞察:最亲近(亲密度=消息量)、圈子概览(按成员数降序)、选中详情(共同群/相连关系)
    const topFriends = useMemo(() => [...graph.nodes].filter(n => n.kind !== 'self').sort((a, b) => (b.intimacy ?? 0) - (a.intimacy ?? 0) || b.weight - a.weight).slice(0, 5), [graph]);
    const communities = useMemo(() => groupCommunities(graph), [graph]);
    const selectedConnections = useMemo(() => (selectedId ? connectedEdgesOf(graph, selectedId) : []), [graph, selectedId]);
    const selectedGroupNames = useMemo(() => (selected ? sharedGroupNames(selected, data?.group_names) : []), [selected, data]);
    // 选中详情头像(「我」用 self wxid 查)
    useEffect(() => {
        const user = selectedId === 'self' ? (data?.self ?? '') : selectedId ?? '';
        if (!user || user === 'self') {
            setSelAvatar('');
            return;
        }
        let alive = true;
        void apiGetAvatar({ username: user })
            .then((r) => { if (alive)
            setSelAvatar(r.data || r.url || ''); })
            .catch(() => { if (alive)
            setSelAvatar(''); });
        return () => { alive = false; };
    }, [selectedId, data]);
    const togglePin = useCallback((id) => {
        setPinned((prev) => {
            const next = new Set(prev);
            if (next.has(id))
                next.delete(id);
            else
                next.add(id);
            return next;
        });
    }, []);
    /** 聚焦节点周围 1 跳(深度过滤 + 居中)。 */
    const focusNode = useCallback((id) => {
        setSelectedId(id);
        patch({ depth: 1 });
        canvasRef.current?.centerOn(id);
    }, []);
    const setMode = (mode) => {
        setFocusCommunity(null);
        patch({ mode });
    };
    // 搜索候选(名称/username 包含)
    const searchTerms = search.trim().toLowerCase();
    const searchHits = useMemo(() => {
        if (!searchTerms)
            return [];
        return graph.nodes.filter(n => n.label.toLowerCase().includes(searchTerms) || n.id.toLowerCase().includes(searchTerms)).slice(0, 8);
    }, [graph, searchTerms]);
    const locateSearch = (id) => {
        setSelectedId(id);
        canvasRef.current?.centerOn(id);
    };
    const doExportSvg = async () => {
        try {
            const svg = await canvasRef.current?.exportSvg() ?? '';
            if (!svg) {
                console.warn('SVG 导出失败:画布未就绪');
                return;
            }
            const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = '社交关系图谱.svg';
            a.click();
            setTimeout(() => { URL.revokeObjectURL(url); }, 2000);
        }
        catch (e) {
            console.error('SVG 导出失败', e);
        }
    };
    const doExportPng = async () => {
        try {
            const url = await canvasRef.current?.exportPng(posterRatio, posterStyle);
            if (!url)
                return;
            const a = document.createElement('a');
            a.href = url;
            a.download = `社交图谱-${posterStyle}-${posterRatio}.png`;
            a.click();
        }
        catch (e) {
            console.error('PNG 导出失败', e);
        }
    };
    /** 导出朋友圈海报:头像图谱 + 排版(风格/比例即时生效)。 */
    const doExportPoster = async () => {
        setExporting(true);
        try {
            const url = await canvasRef.current?.renderPoster(posterRatio, posterStyle);
            if (!url)
                return;
            const a = document.createElement('a');
            a.href = url;
            a.download = `社交图谱-${posterStyle}-${posterRatio}.jpg`;
            a.click();
        }
        catch (e) {
            console.error('海报导出失败', e);
        }
        finally {
            setExporting(false);
        }
    };
    const focusCommunityRow = focusCommunity !== null ? communities.find(c => c.id === focusCommunity) ?? null : null;
    return (_jsxs("div", { className: css.panel, "data-dark": dark || undefined, children: [_jsx(PanelHeader, { title: "\u793E\u4EA4\u5173\u7CFB\u56FE\u8C31", desc: selected ? selected.label + ' · ' + String(selected.intimacy ?? selected.weight) + ' 条消息' : `${graph.nodes.length} 节点 · ${graph.edges.length} 连线 · ${graph.communityCount} 圈子`, actions: (_jsxs(_Fragment, { children: [_jsxs("div", { className: css.searchWrap, children: [_jsx("input", { type: "text", value: search, onChange: (e) => { setSearch(e.target.value); }, placeholder: "\u641C\u7D22\u8282\u70B9\u2026", className: css.searchInput }), searchHits.length > 0 && (_jsx("div", { className: css.searchDrop, children: searchHits.map(hit => (_jsxs("button", { type: "button", className: css.searchHit, onClick: () => { locateSearch(hit.id); setSearch(''); }, children: [hit.label, _jsx("span", { className: css.searchHitId, children: hit.id })] }, hit.id))) })), searchTerms && searchHits.length === 0 && (_jsx("div", { className: css.searchDrop, children: _jsx("span", { className: css.searchEmpty, children: "\u65E0\u5339\u914D\u8282\u70B9" }) }))] }), _jsx("button", { type: "button", className: css.chip, onClick: () => { void load(); }, children: loading ? '刷新中…' : '⟳ 刷新' }), _jsx(Select, { value: posterStyle, onChange: (v) => { setPosterStyle(v); }, options: [
                                { value: 'dark', label: '深空' },
                                { value: 'light', label: '浅日' },
                                { value: 'neon', label: '霓虹' },
                            ], ariaLabel: "\u5BFC\u51FA\u98CE\u683C" }), _jsx(Select, { value: posterRatio, onChange: (v) => { setPosterRatio(v); }, options: [
                                { value: '1:1', label: '1:1 方图' },
                                { value: '3:4', label: '3:4 竖版' },
                                { value: '16:9', label: '16:9 横版' },
                            ], ariaLabel: "\u5BFC\u51FA\u6BD4\u4F8B" }), _jsx("button", { type: "button", className: css.chip, onClick: () => { void doExportPoster(); }, disabled: exporting, children: exporting ? '⏳ 导出中…' : '📤 发朋友圈' }), _jsx("button", { type: "button", className: css.chip, onClick: () => { void doExportSvg(); }, children: "SVG" }), _jsx("button", { type: "button", className: css.chip, onClick: () => { void doExportPng(); }, children: "PNG" }), _jsx("button", { type: "button", className: css.chip, onClick: toggleTheme, children: dark ? '☀️ 浅色' : '🌙 深色' }), _jsx("button", { type: "button", className: css.chip, onClick: () => { canvasRef.current?.fitView(); }, children: "\u9002\u5E94\u89C6\u56FE" }), _jsx("button", { type: "button", className: css.chip, "data-on": selectedId !== null, onClick: () => { setSelectedId(null); }, children: selectedId ? '清除选中' : '选中节点' }), _jsx("button", { type: "button", className: css.chip, onClick: () => { setRailOpen(v => !v); }, children: railOpen ? '◀ 面板' : '▶ 面板' })] })) }), _jsxs("div", { className: css.body, children: [_jsxs("div", { className: css.stage, children: [loading && !data && _jsx(GraphLoading, {}), error && _jsxs("div", { className: css.empty, children: ["\u26A0\uFE0F ", error] }), !loading && !error && data && graph.nodes.length === 0 && _jsx("div", { className: css.empty, children: "\u5F53\u524D\u6761\u4EF6\u4E0B\u6CA1\u6709\u53EF\u663E\u793A\u7684\u8282\u70B9,\u8BD5\u8BD5\u63D0\u9AD8\u8282\u70B9\u4E0A\u9650\u6216\u5173\u95ED\u300C\u4EC5\u597D\u53CB\u300D\u3002" }), data && graph.nodes.length > 0 && (_jsxs(_Fragment, { children: [_jsx(EchartsGraphCanvas, { ref: canvasRef, graph: displayGraph, dark: dark, selectedId: selectedId, onSelect: setSelectedId, settings: settings, selfUsername: data.self ?? undefined, pinnedIds: pinned, focusCommunity: focusCommunity, hoverCommunity: hoverCommunity, onOpenChat: onOpenChat, onFocusNode: focusNode }), _jsxs("div", { className: css.legend, children: [_jsxs("span", { children: [_jsx("i", { className: css.legendDot }), "\u989C\u8272 = \u5708\u5B50(\u793E\u533A)"] }), _jsxs("span", { children: [_jsx("i", { className: css.legendLine }), "\u7070\u7EBF = \u5171\u540C\u7FA4\u6570"] }), _jsxs("span", { children: [_jsx("i", { className: css.legendLineBlue }), "\u84DD\u7EBF = \u4E0E\u6211\u4EB2\u5BC6\u5EA6"] }), _jsxs("span", { children: [_jsx("i", { className: css.legendBar }), "\u534A\u5F84 = \u6D88\u606F\u91CF"] })] })] }))] }), railOpen && (_jsxs("aside", { className: css.rail, children: [_jsxs("div", { className: css.statRow, children: [_jsxs("span", { className: css.statChip, title: "\u5F53\u524D\u5C55\u793A\u8282\u70B9\u6570", children: [graph.nodes.length, " \u8282\u70B9"] }), _jsxs("span", { className: css.statChip, title: "\u5F53\u524D\u8FDE\u7EBF\u6570", children: [graph.edges.length, " \u8FDE\u7EBF"] }), _jsxs("span", { className: css.statChip, title: "\u793E\u533A\u68C0\u6D4B\u51FA\u7684\u5708\u5B50\u6570", children: [graph.communityCount, " \u5708\u5B50"] })] }), selected && (_jsxs("div", { className: css.detail, "data-focus": focusCommunity !== null || undefined, children: [_jsxs("div", { className: css.detailHd, children: [selAvatar ? (_jsx("img", { src: selAvatar, alt: "", className: css.detailAvatar })) : (_jsx("span", { className: css.detailAvatar, style: { background: selected.kind === 'self' ? 'var(--gp-accent)' : selected.community >= 0 ? communityColor(selected.community) : 'rgba(128,138,156,0.35)' }, children: selected.label.slice(0, 1).toUpperCase() })), _jsxs("div", { className: css.detailTitles, children: [_jsx("span", { className: css.detailName, children: selected.label }), _jsxs("span", { className: css.detailMeta, children: [selected.kind === 'group' ? '群聊' : selected.kind === 'self' ? '我' : selected.isOfficial ? '公众号' : (selected.isFriend ? '好友' : '群友'), " \u00B7 \u6D88\u606F\u91CF ", selected.intimacy ?? selected.weight, selected.sharedCount !== undefined ? ` · 共同 ${selected.sharedCount}` : ''] })] }), _jsx("button", { type: "button", className: css.detailClose, onClick: () => { setSelectedId(null); }, "aria-label": "\u5173\u95ED\u8BE6\u60C5", children: "\u00D7" })] }), selected.community >= 0 && (_jsxs("div", { className: css.detailMeta, style: { display: 'flex', gap: 6, alignItems: 'center' }, children: [_jsx("i", { style: { width: 10, height: 10, borderRadius: 10, background: communityColor(selected.community), display: 'inline-block' } }), "\u5708\u5B50 #", selected.community + 1, " \u00B7 ", communities.find(c => c.id === selected.community)?.members.length ?? 0, " \u4F4D"] })), _jsxs("div", { className: css.detailBtns, children: [_jsx("button", { type: "button", className: css.miniBtn, onClick: () => { focusNode(selected.id); }, children: "\uD83D\uDD0D \u805A\u7126 1 \u8DF3" }), selected.id !== 'self' && (_jsx("button", { type: "button", className: css.miniBtn, "data-on": pinned.has(selected.id) || undefined, onClick: () => { togglePin(selected.id); }, children: pinned.has(selected.id) ? '📌 已固定' : '📌 固定' })), onOpenChat && (_jsx("button", { type: "button", className: css.miniBtn, onClick: () => { onOpenChat(selected.id); }, children: "\uD83D\uDCAC \u67E5\u770B\u804A\u5929" }))] }), selectedGroupNames.length > 0 && (_jsxs(_Fragment, { children: [_jsx("div", { className: css.detailSub, children: "\u5171\u540C\u7FA4" }), _jsx("div", { className: css.detailChips, children: selectedGroupNames.map((g, gi) => (_jsx("span", { className: css.detailChip, title: g, children: g.length > 12 ? g.slice(0, 12) + '…' : g }, gi))) })] })), _jsxs("div", { className: css.detailSub, children: ["\u76F8\u8FDE\u5173\u7CFB (", selectedConnections.length, ")"] }), _jsx("div", { className: css.detailChips, children: selectedConnections.map(ce => (_jsxs("button", { type: "button", className: css.detailChip, onClick: () => { setSelectedId(ce.other?.id ?? null); }, title: ce.other?.label ?? '', children: [ce.other?.label ?? '?', _jsx("span", { className: css.rankW, children: ce.edge.weight })] }, ce.edge.source + ce.edge.target))) })] })), _jsxs("div", { className: css.railSection, children: [_jsx("div", { className: css.railTitle, children: "\u6700\u4EB2\u8FD1 \u00B7 \u6D88\u606F\u91CF" }), topFriends.map((n, i) => (_jsxs("button", { type: "button", className: css.rank, onClick: () => { setSelectedId(n.id); canvasRef.current?.centerOn(n.id); }, children: [_jsx("span", { className: css.rankNum, children: i + 1 }), _jsx("span", { className: css.rankName, children: n.label }), _jsx("span", { className: css.rankW, children: n.intimacy ?? n.weight })] }, n.id)))] }), communities.length > 0 && (_jsxs("div", { className: css.railSection, children: [_jsxs("div", { className: css.railTitle, children: ["\u5708\u5B50\u6982\u89C8 \u00B7 ", communities.length, " \u4E2A", focusCommunityRow && _jsx("button", { type: "button", className: css.clearChip, onClick: () => { setFocusCommunity(null); }, children: "\u6E05\u9664\u805A\u7126" })] }), communities.slice(0, 8).map(c => (_jsxs("button", { type: "button", className: css.rank, "data-on": focusCommunity === c.id || undefined, onClick: () => { setFocusCommunity(prev => prev === c.id ? null : c.id); }, onMouseEnter: () => { setHoverCommunity(c.id); }, onMouseLeave: () => { setHoverCommunity(null); }, children: [_jsx("span", { className: css.rankNum, style: { background: communityColor(c.id) }, children: c.members.length }), _jsxs("span", { className: css.rankName, children: [[...c.members].slice(0, 2).map(m => m.label).join('、'), c.members.length > 2 ? ` 等 ${c.members.length} 人` : ''] }), focusCommunity === c.id ? _jsx("span", { className: css.rankW, children: "\u805A\u7126\u4E2D" }) : null] }, c.id)))] })), _jsxs("div", { className: css.railSection, children: [_jsx("div", { className: css.railTitle, children: "\u6570\u636E" }), _jsxs("div", { className: css.seg, children: [_jsx("button", { type: "button", className: css.segBtn, "data-on": settings.mode === 'people' || undefined, onClick: () => { setMode('people'); }, children: "\u597D\u53CB\u7F51\u7EDC" }), _jsx("button", { type: "button", className: css.segBtn, "data-on": settings.mode === 'groups' || undefined, onClick: () => { setMode('groups'); }, children: "\u7FA4\u7EC4\u7F51\u7EDC" })] }), _jsx(Slider, { label: "\u8282\u70B9\u4E0A\u9650", value: settings.nodeLimit, min: 20, max: 10000, step: 20, onChange: (v) => { patch({ nodeLimit: v }); }, fmt: v => v >= 10000 ? '全部' : String(v) }), _jsx(Slider, { label: settings.mode === 'people' ? '共同群阈值 ≥' : '共同成员阈值 ≥', value: settings.minCommon, min: 1, max: 10, step: 1, onChange: (v) => { patch({ minCommon: v }); } }), settings.mode === 'people' && (_jsx(Toggle, { label: "\u4EC5\u663E\u793A\u597D\u53CB", checked: settings.friendsOnly, onChange: (v) => { patch({ friendsOnly: v }); } }))] }), _jsxs("div", { className: css.railSection, children: [_jsx("div", { className: css.railTitle, children: "\u5916\u89C2" }), _jsx(Toggle, { label: "\u7BAD\u5934", checked: settings.showArrows, onChange: (v) => { patch({ showArrows: v }); } }), _jsx(Toggle, { label: "\u5168\u90E8\u6807\u7B7E", checked: settings.showLabels, onChange: (v) => { patch({ showLabels: v }); } }), _jsx(Toggle, { label: "\u80CC\u666F\u7F51\u683C", checked: settings.showGrid, onChange: (v) => { patch({ showGrid: v }); } }), _jsx(Slider, { label: "\u8282\u70B9\u6A21\u7CCA", value: settings.blurNodes, min: 0, max: 12, step: 1, onChange: (v) => { patch({ blurNodes: v }); }, fmt: v => v === 0 ? '关闭' : String(v) + 'px' }), _jsx(Slider, { label: "\u6587\u672C\u900F\u660E\u5EA6", value: settings.labelOpacity, min: 0.05, max: 1, step: 0.05, onChange: (v) => { patch({ labelOpacity: v }); }, fmt: v => String(Math.round(v * 100)) + '%' }), _jsx(Slider, { label: "\u8282\u70B9\u5927\u5C0F", value: settings.nodeScale, min: 0.4, max: 4, step: 0.05, onChange: (v) => { patch({ nodeScale: v }); }, fmt: v => v.toFixed(2) + '×' }), _jsx(Slider, { label: "\u8FDE\u7EBF\u7C97\u7EC6", value: settings.edgeWidth, min: 0.3, max: 6, step: 0.1, onChange: (v) => { patch({ edgeWidth: v }); }, fmt: v => v.toFixed(1) }), _jsx("button", { type: "button", className: css.animBtn, onClick: () => { canvasRef.current?.runAnimation(); }, children: "\u64AD\u653E\u52A8\u753B" })] }), _jsxs("div", { className: css.railSection, children: [_jsx("div", { className: css.railTitle, children: "\u5E03\u5C40" }), _jsxs("div", { className: css.rowBtns, children: [_jsx("button", { type: "button", className: css.miniBtn, onClick: () => { canvasRef.current?.relayout(); }, children: "\u27F2 \u91CD\u65B0\u5E03\u5C40" }), _jsxs("button", { type: "button", className: css.miniBtn, disabled: pinned.size === 0, onClick: () => { setPinned(new Set()); }, children: ["\u6E05\u9664\u56FA\u5B9A", pinned.size > 0 ? ` (${pinned.size})` : ''] })] }), _jsx("button", { type: "button", className: css.miniBtn, disabled: isDefaultSettings, onClick: restoreDefaults, children: "\u21BA \u6062\u590D\u9ED8\u8BA4\u53C2\u6570" }), _jsx(Toggle, { label: "\u9501\u5B9A\u5E03\u5C40", checked: settings.lockLayout, onChange: (v) => { patch({ lockLayout: v }); } }), _jsx("div", { className: css.railHint, children: "\u300C\u6211\u300D\u4F4D\u4E8E\u56FE\u8C31\u4E2D;\u62D6\u62FD\u8282\u70B9\u8C03\u6574\u5E03\u5C40;\u9501\u5B9A\u5E03\u5C40\u540E\u7981\u6B62\u62D6\u62FD\u4E0E\u81EA\u52A8\u91CD\u6392,\u529B\u5EA6/\u5916\u89C2\u53C2\u6570\u53D8\u5316\u4ECD\u4F1A\u91CD\u65B0\u5E03\u5C40\u3002" })] }), _jsxs("div", { className: css.railSection, children: [_jsx("div", { className: css.railTitle, children: "\u6DF1\u5EA6\u8FC7\u6EE4" }), _jsx(Slider, { label: "\u90BB\u57DF\u6DF1\u5EA6", value: settings.depth, min: 0, max: 8, step: 1, onChange: (v) => { patch({ depth: v }); }, fmt: v => v === 0 ? '全部' : String(v) + ' 跳 (选中节点)' })] }), _jsxs("div", { className: css.railSection, children: [_jsx("div", { className: css.railTitle, children: "\u529B\u5EA6" }), _jsx(Slider, { label: "\u8282\u70B9\u95F4\u8DDD", value: settings.nodeGap, min: 0.4, max: 3.5, step: 0.05, onChange: (v) => { patch({ nodeGap: v }); }, fmt: v => v.toFixed(2) + '×', disabled: settings.lockLayout }), _jsx(Slider, { label: "\u5708\u5B50\u5206\u79BB\u5EA6", value: settings.communitySeparation, min: 0.3, max: 5, step: 0.1, onChange: (v) => { patch({ communitySeparation: v }); }, fmt: v => v.toFixed(1) + '×', disabled: settings.lockLayout }), _jsx(Slider, { label: "\u56FE\u8C31\u5411\u5FC3\u529B", value: settings.forceCentripetal, min: 0, max: 5, step: 0.05, onChange: (v) => { patch({ forceCentripetal: v }); }, fmt: v => v.toFixed(2) + '×', disabled: settings.lockLayout }), _jsx(Slider, { label: "\u8282\u70B9\u95F4\u7684\u6392\u65A5\u529B", value: settings.forceRepulsion, min: 0.1, max: 12, step: 0.1, onChange: (v) => { patch({ forceRepulsion: v }); }, fmt: v => v.toFixed(1) + '×', disabled: settings.lockLayout }), _jsx(Slider, { label: "\u76F8\u8FDE\u8282\u70B9\u7684\u5438\u5F15\u529B", value: settings.forceAttraction, min: 0.1, max: 5, step: 0.05, onChange: (v) => { patch({ forceAttraction: v }); }, fmt: v => v.toFixed(2) + '×', disabled: settings.lockLayout }), _jsx(Slider, { label: "\u8FDE\u7EBF\u957F\u5EA6", value: settings.forceEdgeLength, min: 0.2, max: 4, step: 0.05, onChange: (v) => { patch({ forceEdgeLength: v }); }, fmt: v => v.toFixed(2) + '×', disabled: settings.lockLayout }), settings.lockLayout && _jsx("div", { className: css.railHint, children: "\u5E03\u5C40\u5DF2\u9501\u5B9A,\u529B\u5EA6/\u95F4\u8DDD\u6ED1\u6746\u6682\u4E0D\u53EF\u8C03;\u5173\u95ED\u300C\u9501\u5B9A\u5E03\u5C40\u300D\u540E\u6062\u590D\u3002" })] }), _jsx("div", { className: css.railHint, children: "\u70B9\u51FB\u8282\u70B9\u9009\u4E2D\u5E76\u9AD8\u4EAE\u76F8\u90BB\u8282\u70B9\u4E0E\u8FDE\u7EBF;\u62D6\u62FD\u8282\u70B9\u8C03\u6574\u5E03\u5C40;\u6EDA\u8F6E\u7F29\u653E\u3001\u62D6\u62FD\u7A7A\u767D\u5E73\u79FB;\u9876\u90E8\u300C\u9002\u5E94\u89C6\u56FE\u300D\u7F29\u653E\u81F3\u5168\u56FE\u3002" })] }))] })] }));
}
//# sourceMappingURL=Graph.js.map