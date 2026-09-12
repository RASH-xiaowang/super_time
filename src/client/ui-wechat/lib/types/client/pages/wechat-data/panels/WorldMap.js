import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * friend 地区世界地图.
 *
 * 世界层有两种视图：联网时优先用 ECharts 渲染真实世界地理地图（中文国名 GeoJSON，
 * 按好友数分级填色、悬停提示、点击国家下钻）；GeoJSON 不可达或用户切换后回退到
 * 自绘的等距圆柱 SVG 世界地图（粗略大陆剪影 + 涟漪标记）。下钻到「中国」时按省份
 * 渲染 ECharts 中国地图（对应 3D 中国地图下钻示例的交互），省份点击后再落到省/市的
 * 方块图。其它国家/城市的下钻仍用空间叙利化的方块图（treemap），悬停城市块在旁展示
 * 好友头像与标签。支持鼠标滚轮缩放、拖拽平移，以及「聚焦中国」／「重置视图」。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiGetAvatarsLocal, apiGetRegionMap } from "../api.js";
import { useWechatDataUpdated } from "./hooks.js";
import { squarify } from "./treemap.js";
import { ChinaMap } from "./ChinaMap.js";
import { CityMap } from "./CityMap.js";
import { FriendAvatarRail } from "./FriendAvatarRail.js";
import { GeoEchartsMap } from "./GeoEchartsMap.js";
import { ProvinceMap } from "./ProvinceMap.js";
import { WORLD_GEO_URLS, fetchFirstJson, worldChildByName, worldFeatureName } from "./world-map-data.js";
import { collectSubtreeFriends } from "./region-friends.js";
import { CHINA_BBOX, CHINA_OUTLINE, CONTINENTS, MAP_H, MAP_W, countryCenter, project, projectBBox, provinceAdcode, provinceCenter, smoothClosedPath, } from "./world-geo.js";
import css from './world-map.module.css';
/** Pick the display name for a friend. */
function friendName(f) {
    return f.displayName || f.remark || f.nickName;
}
/** Clamp a view so the map cannot be panned off-screen. */
function clampView(v) {
    const k = Math.min(12, Math.max(1, v.k));
    const maxTx = MAP_W * (k - 1);
    const maxTy = MAP_H * (k - 1);
    return {
        k,
        tx: Math.min(0, Math.max(-maxTx, v.tx)),
        ty: Math.min(0, Math.max(-maxTy, v.ty)),
    };
}
/** Interpolate the space-capsule accent cyan -> violet by friend density. */
function densityColor(ratio) {
    const t = Math.max(0, Math.min(1, ratio));
    const r = Math.round(168 * t);
    const g = Math.round(240 + (85 - 240) * t);
    const b = Math.round(255 + (247 - 255) * t);
    return `rgb(${r}, ${g}, ${b})`;
}
/** Bbox-fit projection that fills the viewBox with mainland China. */
const chinaProject = (lon, lat) => projectBBox(lon, lat, CHINA_BBOX);
/**
 * Render the world-region map.
 * @returns the world-map element tree.
 */
export function WorldMapPanel() {
    const [map, setMap] = useState(null);
    const [error, setError] = useState(null);
    // Drill path: [] = world map; [country]; [country, province].
    const [path, setPath] = useState([]);
    // Hovered leaf city (friends shown beside) within the treemap.
    const [hoverCity, setHoverCity] = useState(null);
    const [avatars, setAvatars] = useState({});
    const [view, setView] = useState({ k: 1, tx: 0, ty: 0 });
    const [hoverRegion, setHoverRegion] = useState(null);
    const canvasRef = useRef(null);
    const mapRef = useRef(null);
    const [box, setBox] = useState({ w: 0, h: 0 });
    const [mapSize, setMapSize] = useState({ w: 0, h: 0 });
    const [chinaFallback, setChinaFallback] = useState(false);
    const [provinceFallback, setProvinceFallback] = useState(false);
    const [cityFallback, setCityFallback] = useState(false);
    const [worldGeo, setWorldGeo] = useState(null);
    const worldGeoRef = useRef(null);
    const dragRef = useRef(null);
    const load = useCallback(async () => {
        setError(null);
        try {
            const m = await apiGetRegionMap();
            setMap(m);
        }
        catch (e) {
            setError(e.message);
        }
    }, []);
    useEffect(() => { void load(); }, [load]);
    useWechatDataUpdated(() => { void load(); });
    const level = path.length;
    const onWorldMap = level === 0;
    const focused = onWorldMap ? null : path[path.length - 1] ?? null;
    const chinaMode = !onWorldMap && focused?.key === '中国';
    // A province under 中国 (path [中国, 广西]) renders a city-level ECharts map.
    const provinceNode = !onWorldMap && level === 2 && path[0]?.key === '中国' ? focused : null;
    const provinceAd = provinceNode ? provinceAdcode(provinceNode.name) : null;
    const provinceMode = provinceAd !== null;
    const showProvinceMap = provinceMode && !provinceFallback;
    // A city under a Chinese province (path [中国, 广西, 南宁]) renders a district map.
    const cityNode = !onWorldMap && level === 3 && path[0]?.key === '中国' ? focused : null;
    const cityProvinceAd = cityNode && path[1] ? provinceAdcode(path[1].name) : null;
    const cityMode = cityProvinceAd !== null;
    const showCityMap = cityMode && !cityFallback;
    const worldEchartsReady = onWorldMap && worldGeo?.ok === true;
    const showWorldEcharts = worldEchartsReady;
    const showWorldSvg = onWorldMap && !showWorldEcharts;
    // A geographic SVG map is rendered for the world level before the ECharts map
    // is ready or when it fails; it is never offered as a manual view toggle.
    const showGeoMap = showWorldSvg || (chinaMode && chinaFallback);
    // The ECharts map is the default China view; it falls back to the SVG map when offline.
    const showChinaEcharts = chinaMode && !chinaFallback;
    // Everything else (non-China countries, cities, unknown provinces) uses the squarified treemap.
    const showTreemap = !onWorldMap && !chinaMode && !showProvinceMap && !showCityMap;
    const children = focused?.children ?? [];
    // Contacts of the whole current subtree, split across the two side rails.
    const levelFriends = useMemo(() => collectSubtreeFriends(onWorldMap ? map?.world : focused), [onWorldMap, map, focused]);
    const halfFriends = Math.ceil(levelFriends.length / 2);
    const leftFriends = levelFriends.slice(0, halfFriends);
    const rightFriends = levelFriends.slice(halfFriends);
    // Probe the world GeoJSON once per session visit (kept in a ref so a fetch
    // failure does not retry in a loop); the SVG map stays visible until ready.
    useEffect(() => {
        if (!onWorldMap)
            return;
        const cached = worldGeoRef.current;
        if (cached) {
            setWorldGeo(cached);
            return;
        }
        let alive = true;
        void fetchFirstJson(WORLD_GEO_URLS)
            .then((data) => {
            worldGeoRef.current = { ok: true, data };
            if (alive)
                setWorldGeo({ ok: true, data });
        })
            .catch(() => {
            worldGeoRef.current = { ok: false };
            if (alive)
                setWorldGeo({ ok: false });
        });
        return () => { alive = false; };
    }, [onWorldMap]);
    // Measure the treemap canvas (present only when the treemap is shown).
    useEffect(() => {
        if (!showTreemap)
            return;
        const el = canvasRef.current;
        if (!el)
            return;
        const measure = () => {
            const r = el.getBoundingClientRect();
            setBox({ w: Math.max(0, r.width), h: Math.max(0, r.height) });
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => { ro.disconnect(); };
    }, [showTreemap, map]);
    // Measure the map container (world level or China province level).
    useEffect(() => {
        if (!showGeoMap)
            return;
        const el = mapRef.current;
        if (!el)
            return;
        const measure = () => {
            const r = el.getBoundingClientRect();
            setMapSize({ w: Math.max(0, r.width), h: Math.max(0, r.height) });
        };
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => { ro.disconnect(); };
    }, [showGeoMap, map]);
    // Native (non-passive) wheel listener so the map can zoom without scrolling.
    useEffect(() => {
        if (!showGeoMap)
            return;
        const el = mapRef.current;
        if (!el)
            return;
        const onWheel = (e) => {
            e.preventDefault();
            const r = el.getBoundingClientRect();
            const mx = ((e.clientX - r.left) / r.width) * MAP_W;
            const my = ((e.clientY - r.top) / r.height) * MAP_H;
            setView((v) => {
                const factor = e.deltaY < 0 ? 1.15 : 0.87;
                const k2 = Math.min(12, Math.max(1, v.k * factor));
                const scale = k2 / v.k;
                return clampView({ k: k2, tx: mx - (mx - v.tx) * scale, ty: my - (my - v.ty) * scale });
            });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => { el.removeEventListener('wheel', onWheel); };
    }, [showGeoMap, map]);
    // Reset the view (and hover) whenever the geo source or the snapshot changes.
    useEffect(() => {
        setView({ k: 1, tx: 0, ty: 0 });
        setHoverRegion(null);
        setHoverCity(null);
        setChinaFallback(false);
        setProvinceFallback(false);
        setCityFallback(false);
    }, [onWorldMap, chinaMode, map]);
    // Lay out the current drill level as a treemap (province -> city, or city list).
    const slots = useMemo(() => {
        if (!showTreemap || !focused || box.w <= 0 || box.h <= 0)
            return [];
        const items = children.map(n => ({ value: n.count }));
        const rects = squarify(items, { x: 0, y: 0, w: box.w, h: box.h });
        return children.map((node, i) => {
            const r = rects[i];
            return r ? { node, x: r.x, y: r.y, w: r.w, h: r.h } : { node, x: 0, y: 0, w: 0, h: 0 };
        });
    }, [showTreemap, focused, children, box]);
    // Load avatars for the hovered city's friends.
    useEffect(() => {
        if (!hoverCity || hoverCity.friends.length === 0)
            return;
        let alive = true;
        void apiGetAvatarsLocal({ usernames: hoverCity.friends.map(f => f.username) })
            .then((r) => { if (alive)
            setAvatars(r); })
            .catch(() => { if (alive)
            setAvatars({}); });
        return () => { alive = false; };
    }, [hoverCity]);
    // Geo source: world countries, or China's provinces.
    const geoRegions = onWorldMap ? (map?.world.children ?? []) : (chinaMode ? children : []);
    const geoCenter = onWorldMap ? countryCenter : provinceCenter;
    const geoMax = geoRegions.reduce((a, c) => Math.max(a, c.count), 0) || 1;
    const geoRipple = new Set(geoRegions.slice().sort((a, b) => b.count - a.count).slice(0, 3).map(c => c.key));
    const geoMarkers = useMemo(() => geoRegions.map(c => ({ node: c, center: geoCenter(c.name) })), [geoRegions, geoCenter]);
    const located = geoMarkers.filter(m => m.center !== null);
    const activeProj = chinaMode ? chinaProject : project;
    const backdropPaths = useMemo(() => {
        if (onWorldMap)
            return CONTINENTS.map(c => smoothClosedPath(c.points));
        if (chinaMode)
            return [smoothClosedPath(CHINA_OUTLINE, chinaProject)];
        return [];
    }, [onWorldMap, chinaMode]);
    const graticule = useMemo(() => {
        if (onWorldMap) {
            const lines = [];
            for (let lon = -180; lon <= 180; lon += 30) {
                const a = project(lon, 90);
                const b = project(lon, -90);
                lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
            }
            for (let lat = -60; lat <= 60; lat += 30) {
                const a = project(-180, lat);
                const b = project(180, lat);
                lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
            }
            return lines;
        }
        if (chinaMode) {
            const lines = [];
            for (let lon = CHINA_BBOX.lonMin; lon <= CHINA_BBOX.lonMax; lon += 10) {
                const a = chinaProject(lon, CHINA_BBOX.latMax);
                const b = chinaProject(lon, CHINA_BBOX.latMin);
                lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
            }
            for (let lat = CHINA_BBOX.latMin; lat <= CHINA_BBOX.latMax; lat += 10) {
                const a = chinaProject(CHINA_BBOX.lonMin, lat);
                const b = chinaProject(CHINA_BBOX.lonMax, lat);
                lines.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });
            }
            return lines;
        }
        return [];
    }, [onWorldMap, chinaMode]);
    const goUp = () => {
        setPath(p => p.slice(0, Math.max(0, p.length - 1)));
        setHoverCity(null);
    };
    const zoomInto = (node) => {
        setPath(p => [...p, node]);
        setHoverCity(null);
        setHoverRegion(null);
    };
    const goWorld = () => {
        setPath([]);
        setHoverCity(null);
    };
    /** Switch the world level back to the automatic SVG fallback when ECharts init fails. */
    const fallbackWorldEcharts = () => {
        worldGeoRef.current = { ok: false };
        setWorldGeo({ ok: false });
    };
    /** Drill from a province map into a city and immediately show its friends. */
    const openCity = (node) => {
        setPath(p => [...p, node]);
        setHoverCity(node);
        setHoverRegion(null);
    };
    const focusChina = () => {
        const hit = countryCenter('中国');
        if (!hit)
            return;
        const p = project(hit[0], hit[1]);
        setHoverRegion(null);
        setView(clampView({ k: 4, tx: MAP_W / 2 - p.x * 4, ty: MAP_H / 2 - p.y * 4 }));
    };
    const resetView = () => {
        setHoverRegion(null);
        setView({ k: 1, tx: 0, ty: 0 });
    };
    const projectView = (lon, lat) => {
        const p = activeProj(lon, lat);
        return {
            x: ((p.x * view.k + view.tx) / MAP_W) * mapSize.w,
            y: ((p.y * view.k + view.ty) / MAP_H) * mapSize.h,
        };
    };
    const onPointerDown = (e) => {
        if (view.k === 1)
            return;
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = { startX: e.clientX, startY: e.clientY, tx: view.tx, ty: view.ty };
    };
    const onPointerMove = (e) => {
        const d = dragRef.current;
        if (!d || mapSize.w === 0)
            return;
        const dx = ((e.clientX - d.startX) / mapSize.w) * MAP_W;
        const dy = ((e.clientY - d.startY) / mapSize.h) * MAP_H;
        setView(v => clampView({ ...v, tx: d.tx + dx, ty: d.ty + dy }));
    };
    const onPointerUp = () => { dragRef.current = null; };
    return (_jsxs("div", { className: css.wrap, children: [_jsxs("div", { className: css.toolbar, children: [_jsx("span", { className: css.title, children: "\uD83C\uDF0D \u597D\u53CB\u5730\u533A\u5206\u5E03" }), _jsxs("div", { className: css.breadcrumb, children: [_jsx("button", { type: "button", className: css.crumb, onClick: goWorld, children: "\u4E16\u754C" }), path.map((n, i) => (_jsxs("span", { className: css.crumbSeg, children: [_jsx("span", { className: css.crumbSep, children: "\u203A" }), _jsx("button", { type: "button", className: css.crumb, onClick: () => { setPath(path.slice(0, i + 1)); setHoverCity(null); }, children: n.name })] }, n.key)))] }), onWorldMap && showWorldSvg && (_jsxs("span", { className: css.viewCtrls, children: [_jsx("button", { type: "button", className: css.back, onClick: focusChina, children: "\u805A\u7126\u4E2D\u56FD" }), _jsx("button", { type: "button", className: css.back, onClick: resetView, children: "\u91CD\u7F6E" })] })), _jsxs("span", { className: css.meta, children: ["\u5171 ", map?.total ?? 0, " \u4F4D\u597D\u53CB\u6709\u5730\u533A", map && map.unknown > 0 ? ` · ${map.unknown} 位未填地区` : ''] })] }), error && _jsx("div", { className: css.error, children: error }), !map && !error && _jsx("div", { className: css.loading, children: "\u6B63\u5728\u89E3\u6790\u597D\u53CB\u5730\u533A\u2026" }), map && showGeoMap && (_jsxs("div", { className: css.stage, children: [_jsx(FriendAvatarRail, { side: "left", friends: leftFriends, avatars: avatars }), _jsxs("div", { ref: mapRef, className: css.map, onPointerDown: onPointerDown, onPointerMove: onPointerMove, onPointerUp: onPointerUp, onPointerLeave: onPointerUp, children: [_jsxs("svg", { className: css.mapSvg, viewBox: `0 0 ${MAP_W} ${MAP_H}`, preserveAspectRatio: "none", "aria-hidden": "true", children: [_jsxs("defs", { children: [_jsxs("radialGradient", { id: "ov-land", cx: "50%", cy: "40%", r: "75%", children: [_jsx("stop", { offset: "0%", stopColor: "rgba(0,240,255,0.20)" }), _jsx("stop", { offset: "100%", stopColor: "rgba(0,240,255,0.05)" })] }), _jsxs("radialGradient", { id: "ov-glow", cx: "32%", cy: "26%", r: "80%", children: [_jsx("stop", { offset: "0%", stopColor: "rgba(0,240,255,0.18)" }), _jsx("stop", { offset: "100%", stopColor: "rgba(0,240,255,0)" })] })] }), _jsxs("g", { transform: `translate(${view.tx} ${view.ty}) scale(${view.k})`, children: [graticule.map((l, i) => (_jsx("line", { className: css.grat, x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2 }, i))), backdropPaths.map((d, i) => (_jsx("path", { className: css.land, fill: "url(#ov-land)", d: d }, i)))] }), _jsx("rect", { className: css.mapGlow, width: MAP_W, height: MAP_H, fill: "url(#ov-glow)" })] }), located.map(({ node, center }) => {
                                const c = center;
                                const px = projectView(c[0], c[1]);
                                const ratio = node.count / geoMax;
                                const r = 7 + 13 * Math.sqrt(ratio);
                                const ripple = geoRipple.has(node.key);
                                return (_jsxs("button", { type: "button", className: css.mapMarker, style: { left: px.x, top: px.y, width: r * 2, height: r * 2 }, onPointerDown: (e) => { e.stopPropagation(); }, onMouseEnter: () => { setHoverRegion({ node, x: px.x, y: px.y }); }, onMouseLeave: () => { setHoverRegion(null); }, onClick: () => { zoomInto(node); }, title: `${node.name} · ${node.count} 位好友`, children: [ripple && _jsx("span", { className: css.mapRipple }), _jsx("span", { className: css.mapDot, style: { '--dot-color': densityColor(ratio) } }), ripple && _jsx("span", { className: css.mapName, children: node.name }), ripple && _jsx("span", { className: css.mapCount, children: node.count })] }, node.key));
                            }), hoverRegion && (_jsxs("div", { className: css.mapTip, style: {
                                    left: hoverRegion.x,
                                    top: hoverRegion.y,
                                    transform: hoverRegion.x > mapSize.w - 190 ? 'translate(calc(-100% - 14px), -50%)' : 'translate(14px, -50%)',
                                }, children: [_jsxs("div", { className: css.mapTipHd, children: [hoverRegion.node.name, _jsxs("span", { children: [hoverRegion.node.count, " \u4F4D\u597D\u53CB"] })] }), _jsx("div", { className: css.mapTipBody, children: hoverRegion.node.children.slice(0, 3).map(p => (_jsxs("span", { className: css.mapTipRow, children: [p.name, " ", p.count] }, p.key))) }), _jsx("div", { className: css.mapTipHint, children: "\u70B9\u51FB\u4E0B\u94BB\u67E5\u770B\u4E0B\u4E00\u7EA7" })] })), located.length === 0 && (_jsx("div", { className: css.mapEmpty, children: "\u6CA1\u6709\u53EF\u5B9A\u4F4D\u7684\u5730\u533A\u6570\u636E" })), _jsxs("div", { className: css.mapLegend, children: [_jsx("span", { className: css.legendTitle, children: "\u597D\u53CB\u6570" }), _jsx("span", { className: css.legendSwatch, style: { background: densityColor(0) } }), _jsx("span", { className: css.legendBar }), _jsx("span", { className: css.legendSwatch, style: { background: densityColor(1) } }), _jsx("span", { className: css.legendHint, children: "\u6EDA\u8F6E\u7F29\u653E \u00B7 \u62D6\u62FD\u5E73\u79FB" })] }), path.length > 0 && (_jsx("button", { type: "button", className: css.backOverlay, onClick: goUp, children: "\u2190 \u4E0A\u4E00\u7EA7" }))] }), _jsx(FriendAvatarRail, { side: "right", friends: rightFriends, avatars: avatars })] })), map && showWorldEcharts && (_jsxs("div", { className: css.stage, children: [_jsx(FriendAvatarRail, { side: "left", friends: leftFriends, avatars: avatars }), _jsx(GeoEchartsMap, { node: map.world, mapName: "world", urls: WORLD_GEO_URLS, geo: worldGeo.data, featureName: worldFeatureName, featureLabel: worldFeatureName, childByKey: key => worldChildByName(map.world.children, key), onDrill: zoomInto, onFallback: fallbackWorldEcharts }), _jsx("div", { className: css.mapHint, children: "\u6EDA\u8F6E\u7F29\u653E \u00B7 \u62D6\u62FD\u5E73\u79FB \u00B7 \u70B9\u51FB\u56FD\u5BB6\u4E0B\u94BB" }), _jsx(FriendAvatarRail, { side: "right", friends: rightFriends, avatars: avatars })] })), map && showChinaEcharts && (_jsxs("div", { className: css.stage, children: [_jsx(FriendAvatarRail, { side: "left", friends: leftFriends, avatars: avatars }), _jsx(ChinaMap, { node: focused, onDrill: zoomInto, onFallback: () => { setChinaFallback(true); }, overlay: path.length > 0 ? (_jsx("button", { type: "button", className: css.backOverlay, onClick: goUp, children: "\u2190 \u4E0A\u4E00\u7EA7" })) : null }), _jsx(FriendAvatarRail, { side: "right", friends: rightFriends, avatars: avatars })] })), map && showProvinceMap && provinceNode && provinceAd && (_jsxs("div", { className: css.stage, children: [_jsx(FriendAvatarRail, { side: "left", friends: leftFriends, avatars: avatars }), _jsx(ProvinceMap, { node: provinceNode, adcode: provinceAd, onDrill: openCity, onFallback: () => { setProvinceFallback(true); }, overlay: path.length > 0 ? (_jsx("button", { type: "button", className: css.backOverlay, onClick: goUp, children: "\u2190 \u4E0A\u4E00\u7EA7" })) : null }), _jsx("div", { className: css.mapHint, children: "\u6EDA\u8F6E\u7F29\u653E \u00B7 \u62D6\u62FD\u5E73\u79FB \u00B7 \u70B9\u51FB\u57CE\u5E02\u67E5\u770B\u597D\u53CB" }), _jsx(FriendAvatarRail, { side: "right", friends: rightFriends, avatars: avatars })] })), map && showCityMap && cityNode && cityProvinceAd && (_jsxs("div", { className: css.stage, children: [_jsx(FriendAvatarRail, { side: "left", friends: leftFriends, avatars: avatars }), _jsx(CityMap, { node: cityNode, provinceAdcode: cityProvinceAd, onFallback: () => { setCityFallback(true); }, overlay: path.length > 0 ? (_jsx("button", { type: "button", className: css.backOverlay, onClick: goUp, children: "\u2190 \u4E0A\u4E00\u7EA7" })) : null }), _jsx("div", { className: css.mapHint, children: "\u6EDA\u8F6E\u7F29\u653E \u00B7 \u62D6\u62FD\u5E73\u79FB \u00B7 \u70B9\u51FB\u533A\u53BF\u67E5\u770B\u597D\u53CB" }), _jsx(FriendAvatarRail, { side: "right", friends: rightFriends, avatars: avatars })] })), map && showTreemap && (_jsxs("div", { className: css.stage, children: [_jsx(FriendAvatarRail, { side: "left", friends: leftFriends, avatars: avatars }), children.length > 0 && (_jsxs("div", { ref: canvasRef, className: css.canvas, children: [slots.map((s) => {
                                const isLeaf = s.node.children.length === 0;
                                const isHovered = hoverCity?.key === s.node.key;
                                return (_jsxs("button", { type: "button", className: css.cell, "data-leaf": isLeaf || undefined, "data-hovered": isHovered || undefined, style: { left: s.x, top: s.y, width: s.w, height: s.h }, onMouseEnter: () => { if (isLeaf)
                                        setHoverCity(s.node); }, onClick: () => { if (!isLeaf)
                                        zoomInto(s.node); }, title: `${s.node.name} · ${s.node.count} 位好友`, children: [_jsx("span", { className: css.cellName, children: s.node.name }), _jsx("span", { className: css.cellCount, children: s.node.count })] }, s.node.key));
                            }), slots.length === 0 && box.w > 0 && _jsx("div", { className: css.empty, children: "\u6CA1\u6709\u5B50\u677F\u5757" }), path.length > 0 && (_jsx("button", { type: "button", className: css.backOverlay, onClick: goUp, children: "\u2190 \u4E0A\u4E00\u7EA7" }))] })), children.length === 0 && !hoverCity && _jsx("div", { className: css.empty, children: "\u6CA1\u6709\u5B50\u677F\u5757" }), hoverCity && hoverCity.friends.length > 0 && (_jsxs("div", { className: css.friends, children: [_jsxs("div", { className: css.friendsHd, children: [_jsx("span", { children: hoverCity.name }), _jsxs("span", { className: css.friendsCount, children: [hoverCity.friends.length, " \u4F4D\u597D\u53CB"] })] }), _jsx("div", { className: css.friendGrid, children: hoverCity.friends.map(f => (_jsxs("div", { className: css.friend, title: f.username, children: [_jsx("span", { className: css.avatarWrap, children: avatars[f.username] ? (_jsx("img", { className: css.avatar, src: avatars[f.username], alt: "" })) : (_jsx("span", { className: css.avatarFallback, children: friendName(f).slice(0, 1) })) }), _jsx("span", { className: css.friendLabel, children: friendName(f) })] }, f.username))) })] })), children.length === 0 && path.length > 0 && (_jsx("button", { type: "button", className: css.backOverlay, onClick: goUp, children: "\u2190 \u4E0A\u4E00\u7EA7" })), _jsx(FriendAvatarRail, { side: "right", friends: rightFriends, avatars: avatars })] }))] }));
}
//# sourceMappingURL=WorldMap.js.map