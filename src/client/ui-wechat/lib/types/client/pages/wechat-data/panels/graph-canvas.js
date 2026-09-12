import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 社交图谱画布 — Obsidian 风格(世界坐标 + 视口变换)
 * 布局固定于 2400×1600 世界空间,画布只是视口窗口:
 * 可平移/缩放查看全图,布局不随容器尺寸变化、无画布大小限制。
 */
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { apiGetAvatarsLocal, apiGetAvatar } from "../api.js";
import { communityColor, communityOf, neighboursOf, rankNodes } from "./graph-model.js";
import { buildPoster, getPosterLayout, posterToDataUrl } from "./graph-poster.js";
import css from './graph.module.css';
/** 头像地图:username → data URL;失败自动重试(最多 3 次,间隔 1.5s)。 */
const avatarCache = new Map();
const avatarAttempts = new Map();
function loadAvatar(username, onDone) {
    if (avatarCache.has(username)) {
        onDone();
        return;
    }
    avatarCache.set(username, '');
    const attempt = (avatarAttempts.get(username) ?? 0) + 1;
    avatarAttempts.set(username, attempt);
    void apiGetAvatar({ username })
        .then((r) => {
        const url = r.data || r.url || '';
        avatarCache.set(username, url);
        if (url)
            onDone();
    })
        .catch(() => {
        if (attempt < 3) {
            window.setTimeout(() => { loadAvatar(username, onDone); }, 1500 * attempt);
        }
    })
        .finally(() => { onDone(); });
}
/** 默认节点种类文案:微信联系/群/公众号映射(保持原画布行为)。 */
function defaultKindLabel(g) {
    return g.kind === 'group' ? '群聊' : g.kind === 'self' ? '我' : g.isOfficial ? '公众号' : (g.isFriend ? '好友' : '群友');
}
/** 主题背景色:同步读取 DSH 主题变量(--nm-bg-0),5 秒内复用。 */
const themeBgCache = { bg: '', at: 0 };
function themeBackground() {
    const now = Date.now();
    if (now - themeBgCache.at > 5000 || themeBgCache.bg === '') {
        try {
            themeBgCache.bg = (getComputedStyle(document.documentElement).getPropertyValue('--nm-bg-0') || '').trim();
        }
        catch { /* ignore */ }
        themeBgCache.at = now;
    }
    return themeBgCache.bg;
}
/** 社区晕影精灵:预渲染径向渐变(颜色→128px 淡出圆),绘制时按需缩放。 */
const glowSpriteCache = new Map();
function glowSprite(color) {
    let c = glowSpriteCache.get(color);
    if (c)
        return c;
    c = document.createElement('canvas');
    c.width = 128;
    c.height = 128;
    const g = c.getContext('2d');
    if (g) {
        const grad = g.createRadialGradient(64, 64, 6, 64, 64, 64);
        grad.addColorStop(0, color);
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = grad;
        g.fillRect(0, 0, 128, 128);
    }
    glowSpriteCache.set(color, c);
    return c;
}
/** 点 p 到线段 ab 的距离(悬停边探测用)。 */
function distToSegment(p, a, b) {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    if (len2 < 1e-6)
        return Math.hypot(p.x - a.x, p.y - a.y);
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t));
}
/** 布局常量:世界四周留白。 */
const PAD = 160;
/** 世界尺寸:布局不绑定可视画布,视口只是窗口,可缩放/平移查看全图。 */
const WORLD = { w: 2400, h: 1600 };
/** 缩放范围:缩小不再限制在 0.35(可一直缩到接近点阵),放大封顶 4×。 */
const ZOOM_MIN = 0.02;
const ZOOM_MAX = 4;
/** 连线粗细默认值(与 graph-model DEFAULT_GRAPH_SETTINGS.edgeWidth 一致)。 */
const EDGE_WIDTH_DEFAULT = 1.25;
/** 边端点哈希:决定这条弧线弯曲方向的确定性符号(同一条边恒定,不同边散开)。 */
function edgeSeed(a, b) {
    let h = 7;
    for (let i = 0; i < a.length; i++)
        h = (h * 31 + a.charCodeAt(i)) | 0;
    for (let i = 0; i < b.length; i++)
        h = (h * 31 + b.charCodeAt(i)) | 0;
    return h;
}
/** 节点 id → 稳定的 [0,1) 抖动:打破孤立节点的规整外环,重新布局间保持一致。 */
function idJitter(id) {
    let h = 7;
    for (let i = 0; i < id.length; i++)
        h = (h * 33 + id.charCodeAt(i)) | 0;
    return (h >>> 0) / 0xffffffff;
}
/**
 * Render the social graph canvas (screen-space, robust).
 * @param props - graph / theme / selection callbacks.
 */
export const GraphCanvas = forwardRef(function GraphCanvas({ graph, dark = false, selectedId, onSelect, settings, selfUsername, avatarMode = 'avatar', kindLabelOf = defaultKindLabel, pinnedIds = new Set(), onTogglePin, focusCommunity = null, hoverCommunity = null, onOpenChat, onFocusNode, }, ref) {
    const wrapRef = useRef(null);
    const canvasRef = useRef(null);
    const graphRef = useRef(graph);
    const darkRef = useRef(dark);
    const settingsRef = useRef(settings);
    const hoverRef = useRef(null);
    const selectedRef = useRef(selectedId);
    const dragRef = useRef(null);
    /** 按下以来累计位移(移动 <4px 视为点击,否则视为拖拽,防误触)。 */
    const movedRef = useRef(0);
    const phaseRef = useRef('idle');
    const posRef = useRef(new Map());
    const sizeRef = useRef({ w: 0, h: 0, dpr: 1 });
    /** 世界尺寸:布局/仿真/碰撞都在世界坐标内进行,与视口尺寸无关。 */
    const worldRef = useRef({ w: WORLD.w, h: WORLD.h });
    /** 视图变换:平移 + 缩放(dx/dy 屏幕偏移,scale 缩放比)。 */
    const viewRef = useRef({ dx: 0, dy: 0, scale: 1 });
    const panRef = useRef(null);
    const rafRef = useRef(0);
    const imgCacheRef = useRef(new Map());
    /** 头像精灵缓存:预渲染成圆形离屏 canvas(避免每帧 save/clip/drawImage/restore)。 */
    const spriteRef = useRef(new Map());
    const runningRef = useRef(false);
    const resRef = useRef(true);
    const hiTimerRef = useRef(0);
    /** 首次 fitView 标记(参数变化不重排)。 */
    const fitDoneRef = useRef(false);
    /** 力导向步进:每帧衰减,低于阈值停止仿真(防永久抖动)。 */
    const stepRef = useRef(0.1);
    /** 首次布局是否已布盘(后续参数变化保留位置,只重新收敛)。 */
    const laidOutRef = useRef(false);
    /** 力度参数签名:布局几何只随这四个参数变化重排(其他设置变化保留位置)。 */
    const layoutSigRef = useRef('');
    /** 固定节点集合:力导向/拖拽联动均视为锚点(重新布局保留其位置)。 */
    const pinnedRef = useRef(pinnedIds);
    /** 节点间距倍率(布局收敛后的硬分离/拖拽推挤也用同一系数)。 */
    const gapKRef = useRef(settings.nodeGap);
    /** 节点大小倍率(外观参数:基础半径 × nodeScale,绘制/碰撞统一在此应用)。 */
    const nodeScaleRef = useRef(settings.nodeScale);
    const focusCommRef = useRef(focusCommunity);
    const hoverCommRef = useRef(hoverCommunity);
    /** 节点权重排名(LOD 标签预算:高权重节点优先显示)。 */
    const rankRef = useRef(new Map());
    /** 节点 id → 社区(聚焦淡出查表)。 */
    const commOfRef = useRef(new Map());
    /** 社区晕影:布局收敛后按社区包围盒计算(绘制在最底层,让圈子一眼可见)。 */
    const glowRef = useRef([]);
    /** 相机动画 rAF id(居中/适应/缩放走缓动,交互打断)。 */
    const camRafRef = useRef(0);
    /** 悬停中的边(高亮 + tooltip 显示共同群数)。 */
    const hoverEdgeRef = useRef(null);
    /** 小地图 canvas + 拖动擦洗状态。 */
    const miniRef = useRef(null);
    const miniScrubRef = useRef(false);
    /** 小地图重绘节流(交互期 60fps 时不逐帧全量画点,~6fps 足够)。 */
    const miniAtRef = useRef(0);
    /** 导出期间跳过小地图重绘(exportPng/poster 临时改 canvas 尺寸)。 */
    const inExportRef = useRef(false);
    /** 出生动画:播放动画时节点按权重序逐个出现(从「我」开始,每 50ms 一个)。 */
    const revealRef = useRef(null);
    const revealOrderRef = useRef([]);
    const revealIdxRef = useRef(new Map());
    const revealRafRef = useRef(0);
    /** 导出/海报时的标签数量上限(仅导出期生效;null = 不限制)。 */
    const labelCapRef = useRef(null);
    /** 导出高亮模式:导出/海报期间把全部连线按「高亮状态」渲染(亮蓝加粗 + 光晕)。 */
    const exportHighlightRef = useRef(false);
    /** 力导向仿真状态(布局收敛用):pos/vel/alpha/力度参数。 */
    const simStateRef = useRef(null);
    /** 布局仿真计数器(超时兜底)。 */
    const layoutStepRef = useRef(0);
    /** 布局收敛循环 rAF id。 */
    const layoutRafRef = useRef(0);
    /** 拖拽邻域回稳状态:松手后邻居弹性落位(被拖节点保持不动)。 */
    const settleRef = useRef(null);
    /** 拖拽回稳循环 rAF id。 */
    const settleRafRef = useRef(0);
    /** 松手后启动邻居回弹:速度按阻尼衰减,跑 40 帧以内自然静息。 */
    const startSettle = () => {
        if (settleRef.current)
            return;
        const drag = dragRef.current;
        if (!drag)
            return;
        const dragId = drag.id;
        const ids = new Set();
        const vel = new Map();
        const nodeMap = new Map(nodes().map(g => [g.id, g]));
        for (const e of graphRef.current.edges) {
            if (e.source === dragId)
                ids.add(e.target);
            else if (e.target === dragId)
                ids.add(e.source);
        }
        // 松手惯性:以最后一帧拖拽位移的一小部分作为初始速度,邻居滑行减速而非骤停
        const ldx = drag.ldx;
        const ldy = drag.ldy;
        for (const id of ids) {
            vel.set(id, {
                x: Math.max(-12, Math.min(12, ldx * 0.2)),
                y: Math.max(-12, Math.min(12, ldy * 0.2)),
            });
        }
        if (ids.size === 0)
            return;
        settleRef.current = { ids, vel, frames: 0, nodeMap };
        const step = () => {
            settleRafRef.current = 0;
            const st = settleRef.current;
            if (!st)
                return;
            st.frames += 1;
            const pd = posOf(dragId);
            // 一跳邻居 vs 被拖节点:边拉出弹性带则向被拖节点加速,阻尼渐止
            for (const id of st.ids) {
                if (id === dragId)
                    continue;
                if (id === 'self' || pinnedRef.current.has(id))
                    continue;
                const p = posOf(id);
                const v = st.vel.get(id);
                if (!v)
                    continue;
                const dx = pd.x - p.x;
                const dy = pd.y - p.y;
                // 边目标距离(与 dragPull 同款弹性带)
                let target = 150;
                for (const e of graphRef.current.edges) {
                    if ((e.source === dragId && e.target === id) || (e.target === dragId && e.source === id)) {
                        target = e.dist;
                        break;
                    }
                }
                const d = Math.sqrt(dx * dx + dy * dy) || 1;
                const slack = d - target * 1.12;
                if (slack > 6) {
                    // 拖离了弹性带:弹簧牵引(向被拖节点),力随 slack 增长并封顶
                    const f = Math.min(2.2, slack * 0.045);
                    v.x += (dx / d) * f;
                    v.y += (dy / d) * f;
                }
                // 阻尼
                v.x *= 0.82;
                v.y *= 0.82;
                p.x += v.x;
                p.y += v.y;
            }
            // 一跳 ↔ 二跳:回稳期把被拖拽拉长的第二圈边也回正(只动一跳侧,力小,
            // 二跳及以上仍不泄漏)——松手后不会留下一圈被扯开的悬空边
            for (const e of graphRef.current.edges) {
                const inA = st.ids.has(e.source);
                const inB = st.ids.has(e.target);
                if (inA === inB)
                    continue;
                const id = inA ? e.source : e.target;
                if (id === dragId || id === 'self' || pinnedRef.current.has(id))
                    continue;
                const other = inA ? e.target : e.source;
                if (other === dragId)
                    continue;
                const p = posOf(id);
                const v = st.vel.get(id);
                if (!v)
                    continue;
                const p2 = posOf(other);
                const ox = p2.x - p.x;
                const oy = p2.y - p.y;
                const od = Math.sqrt(ox * ox + oy * oy) || 1;
                const g1 = st.nodeMap.get(id);
                const g2 = st.nodeMap.get(other);
                const target2 = Math.max(e.dist, (g1 ? radiusOf(g1) : 10) + (g2 ? radiusOf(g2) : 10) + 6);
                const slack2 = od - target2;
                if (Math.abs(slack2) > 10) {
                    const f = Math.max(-0.9, Math.min(0.9, slack2 * 0.02));
                    v.x += (ox / od) * f;
                    v.y += (oy / od) * f;
                }
            }
            scheduleDraw();
            const settled = st.frames >= 56 || (st.frames > 18 && [...st.ids].every((id) => {
                const p = posOf(id);
                const dx = pd.x - p.x;
                const dy = pd.y - p.y;
                return Math.sqrt(dx * dx + dy * dy) < targetDist(id) * 1.25;
            }));
            if (!settled) {
                settleRafRef.current = requestAnimationFrame(step);
            }
            else {
                // 收尾:全局硬分离 + 世界跟随内容(「我」保持中心),移除状态
                resolveOverlaps();
                refreshWorld();
                settleRef.current = null;
            }
        };
        const targetDist = (id) => {
            for (const e of graphRef.current.edges) {
                if ((e.source === dragId && e.target === id) || (e.target === dragId && e.source === id))
                    return e.dist;
            }
            return 150;
        };
        settleRafRef.current = requestAnimationFrame(step);
    };
    /** 布局收敛循环:每帧一步 simStep,完成后停止。 */
    const startLayout = () => {
        const step = () => {
            layoutRafRef.current = 0;
            if (!simStateRef.current)
                return;
            simStep();
            scheduleDraw();
            // simStep 不会清空仿真状态(收敛只改 alpha/位置),无需重复判空。
            layoutRafRef.current = requestAnimationFrame(step);
        };
        if (layoutRafRef.current)
            cancelAnimationFrame(layoutRafRef.current);
        layoutRafRef.current = requestAnimationFrame(step);
    };
    const [hoverInfo, setHoverInfo] = useState(null);
    /** 悬停边详情(共同群数/亲密度)。 */
    const [hoverEdgeInfo, setHoverEdgeInfo] = useState(null);
    /** 右键菜单:记录世界内节点(空白处为 null)与屏幕位置。 */
    const [menu, setMenu] = useState(null);
    /** tooltip DOM 引用:位置用 ref 直写(避免每帧 React 重渲染)。 */
    const tipRef = useRef(null);
    /** 边详情 tooltip DOM 引用。 */
    const edgeTipRef = useRef(null);
    graphRef.current = graph;
    darkRef.current = dark;
    selectedRef.current = selectedId;
    settingsRef.current = settings;
    pinnedRef.current = pinnedIds;
    gapKRef.current = settings.nodeGap;
    nodeScaleRef.current = settings.nodeScale;
    focusCommRef.current = focusCommunity;
    hoverCommRef.current = hoverCommunity;
    /** 节点有效半径 = 基础半径 × 节点大小倍率(唯一入口,避免各处漏乘)。 */
    const radiusOf = (g) => (g?.radius ?? 10) * nodeScaleRef.current;
    const nodes = () => graphRef.current.nodes;
    const posOf = (id) => {
        // 布局仿真期间:读仿真的实时位置(可见的展开动画)
        const sim = simStateRef.current;
        if (sim) {
            const idx = sim.idOf.get(id);
            if (idx !== undefined) {
                const sp = sim.pos[idx];
                if (sp)
                    return sp;
            }
        }
        let p = posRef.current.get(id);
        if (!p) {
            p = { x: Math.random() * 500 + 100, y: Math.random() * 400 + 100 };
            posRef.current.set(id, p);
        }
        return p;
    };
    /** 出生动画可见性:「我」始终可见;未激活时全部可见。 */
    const isRevealed = (id) => {
        const r = revealRef.current;
        if (!r || id === 'self')
            return true;
        const idx = revealIdxRef.current.get(id);
        return idx !== undefined && idx < r.count;
    };
    /** 节点出生时刻(-1 = 非出生中)。 */
    const birthOf = (id) => revealRef.current?.birth.get(id) ?? -1;
    /** 出生缩放:easeOutBack 轻微过冲(0→1.1→1)。 */
    const birthScale = (id) => {
        const t0 = birthOf(id);
        if (t0 < 0)
            return 1;
        const t = Math.min(1, (performance.now() - t0) / 420);
        if (t >= 1)
            return 1;
        const c1 = 1.70158;
        const c3 = c1 + 1;
        return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
    };
    /** 出生透明度:0.15→1 淡入。 */
    const birthAlpha = (id) => {
        const t0 = birthOf(id);
        if (t0 < 0)
            return 1;
        const t = Math.min(1, (performance.now() - t0) / 320);
        return 0.15 + 0.85 * t;
    };
    /** 绘制位置:出生中的节点从「我」飞向真实位置(easeOutCubic)。 */
    const posForDraw = (id) => {
        const r = revealRef.current;
        if (!r || id === 'self')
            return posOf(id);
        const t0 = r.birth.get(id);
        if (t0 === undefined)
            return posOf(id);
        const t = Math.min(1, (performance.now() - t0) / 520);
        if (t >= 1)
            return posOf(id);
        const e = 1 - Math.pow(1 - t, 3);
        const sp = posOf('self');
        const p = posOf(id);
        return { x: sp.x + (p.x - sp.x) * e, y: sp.y + (p.y - sp.y) * e };
    };
    /** 完成出生动画:交互/导出前把所有节点立即全部显示。 */
    const completeReveal = () => {
        if (revealRef.current) {
            if (revealRafRef.current)
                cancelAnimationFrame(revealRafRef.current);
            revealRafRef.current = 0;
            revealRef.current = null;
            scheduleDraw();
        }
    };
    /** 力导向布局(参考 st_control GraphCanvas):社区分组预热环形摆放,
     * 之后由 frame step 逐帧积分收敛(d3 语义:link/charge/collide/center)。
     * preserve=true 时保留当前布局位置作初始状态(力度微调时平滑重排)。 */
    const layoutDisc = (preserve = false) => {
        const nd = nodes();
        const es = graphRef.current.edges;
        if (nd.length === 0)
            return;
        // 布局中心跟随当前世界(「我」可拖拽后,世界中心就是它的当前位置):
        // 播放动画/重新布局不再把「我」跳回固定的 2400×1600 原点
        const cx = worldRef.current.w / 2;
        const cy = worldRef.current.h / 2;
        const idOf = new Map(nd.map((g, i) => [g.id, i]));
        // 初始位置:preserve=沿用当前位置(只补缺失节点);
        // 否则社区预热:按 community 分组环形摆放(接近力导向稳态,收敛 tick 从数百降到数十)
        const self = nd.find(g => g.id === 'self');
        if (!preserve) {
            const others = nd.filter(g => g.id !== 'self');
            const byComm = new Map();
            for (const o of others) {
                const c = o.community;
                let list = byComm.get(c);
                if (!list) {
                    list = [];
                    byComm.set(c, list);
                }
                list.push(o);
            }
            const commGroups = [...byComm.entries()];
            commGroups.sort((a, b) => b[1].length - a[1].length);
            const groupCount = Math.max(commGroups.length, 1);
            // 预热间距按「碰撞最小间距」换算:同社区成员在各自规模的自适应网格中
            // 展开,不再挤爆 collide 推力(大社区叠成单团 → 速度指数爆炸 → 全图 NaN)。
            const avgR = (() => {
                let sum = 0;
                for (const o of others)
                    sum += radiusOf(o);
                return sum / Math.max(1, others.length);
            })();
            const spacing = avgR * 2 + 4 + 14 * gapKRef.current;
            // 每个社区沿圆周排布,圈心半径按成员数展开(避免社区互相重叠)
            const crowdR = (count) => (Math.sqrt(Math.max(count, 1)) / 2 + 1.5) * spacing;
            const maxCrowdR = commGroups.reduce((max, [, list]) => Math.max(max, crowdR(list.length)), 0);
            const orbit = 500 + maxCrowdR;
            // 分楔 + 社区网格预热:各社区占一个扇区,成员按矩形格展开(不重叠),
            // 格子随社区角度旋转,成员绕社区中心旋转
            const sector = (Math.PI * 2) / groupCount;
            commGroups.forEach(([, list], gi) => {
                const angle0 = gi * sector + sector * 0.2;
                const centerAngle = angle0 + sector * 0.4;
                const ccx = cx + Math.cos(centerAngle) * orbit;
                const ccy = cy + Math.sin(centerAngle) * orbit;
                const size = Math.ceil(Math.sqrt(list.length));
                const cosA = Math.cos(angle0);
                const sinA = Math.sin(angle0);
                list.forEach((o, i) => {
                    const col = i % size;
                    const row = Math.floor(i / size);
                    const lx = (col - (size - 1) / 2) * spacing;
                    const ly = (row - (size - 1) / 2) * spacing;
                    const p = posOf(o.id);
                    p.x = ccx + lx * cosA - ly * sinA;
                    p.y = ccy + lx * sinA + ly * cosA;
                });
            });
        }
        else {
            // 补缺失节点(新加入的):随机小半径
            const scale = Math.sqrt(Math.max(nd.length, 10)) * 40;
            for (const g of nd) {
                if (g.id === 'self' || posRef.current.has(g.id))
                    continue;
                const p = posOf(g.id);
                const a = Math.random() * Math.PI * 2;
                const rr = (0.2 + Math.random() * 0.8) * scale;
                p.x = cx + Math.cos(a) * rr;
                p.y = cy + Math.sin(a) * rr;
            }
        }
        if (self) {
            const p = posOf(self.id);
            p.x = cx;
            p.y = cy;
        }
        // 仿真状态:位置 + 速度(velocity Verlet 积分用)
        const fp = new Array(nd.length);
        const fv = new Array(nd.length);
        for (let i = 0; i < nd.length; i++) {
            const g = nd[i];
            if (!g)
                continue;
            const p = posOf(g.id);
            fp[i] = { x: p.x, y: p.y };
            fv[i] = { x: 0, y: 0 };
        }
        // 簇色:参考实现语义——节点 community 着色(社区检测在 graph-model 完成),
        // 画布侧直接用 g.community,无需额外缓存。
        simStateRef.current = {
            nd,
            es,
            idOf,
            pos: fp,
            vel: fv,
            alpha: 1,
            // 力度参数(布局时读取一次)
            // 钳制范围与面板滑杆范围一致(此前排斥力滑杆到 8 但内部只生效到 6)
            attractK: Math.min(Math.max(settingsRef.current.forceAttraction, 0.1), 5),
            repelK: Math.min(Math.max(settingsRef.current.forceRepulsion, 0.1), 12),
            centriK: Math.min(Math.max(settingsRef.current.forceCentripetal, 0), 5),
            edgeLenK: Math.min(Math.max(settingsRef.current.forceEdgeLength, 0.2), 4),
            gapK: Math.min(Math.max(settingsRef.current.nodeGap, 0.4), 3.5),
            commRepelK: Math.min(Math.max(settingsRef.current.communitySeparation, 0.3), 5),
            cx, cy,
            repBase: (() => {
                let radSum = 0;
                for (const g of nd)
                    radSum += radiusOf(g);
                return (radSum / Math.max(1, nd.length)) * 2.6;
            })(),
        };
        // 启动逐帧积分(所有节点参与,含外围)
        layoutStepRef.current = 0;
        startLayout();
    };
    /** d3-force 单步积分:全节点斥力 + 边弹簧 + 向心 + velocity Verlet 更新。 */
    const simStep = () => {
        const sim = simStateRef.current;
        if (!sim)
            return;
        const { pos, vel, nd, es, idOf } = sim;
        const n = nd.length;
        const alpha = sim.alpha;
        if (alpha <= 0.001) {
            finishLayout();
            return;
        }
        const at = (i) => {
            const p = pos[i];
            if (!p)
                throw new Error('layout index');
            return p;
        };
        const av = (i) => {
            const v = vel[i];
            if (!v)
                throw new Error('vel index');
            return v;
        };
        // 1) 斥力(力 ∝ 1/d;重叠时 collide 推开)
        //    基准 950;带 1100px 距离截断(超过即失效):长程斥力+弱向心会逃逸成
        //    1 万 px 宽的巨环,截断保证布局有界、紧凑,fit 视图时节点始终可读
        const repQ = 950 * sim.repelK;
        const REPEL_RANGE = 1100;
        // 节点最小间距(碰撞):两圆之间保留舒适呼吸带,随「节点间距」倍率缩放
        const gap = 4 + 14 * sim.gapK;
        const minSep = (ri, rj) => ri + rj + gap;
        // 空间网格(性能核心):斥力/碰撞从 O(n²) 降为近线性——
        // 网格尺寸 = 截断半径/2,5×5 邻域扫描恰好覆盖 1100px 内的全部节点对;
        // 1 万节点从每帧 5 千万次配对降到 ~25 万次
        const CELL = REPEL_RANGE / 2;
        const grid = new Map();
        for (let i = 0; i < n; i++) {
            const p = at(i);
            const key = (Math.floor(p.x / CELL) + 8192) * 16384 + (Math.floor(p.y / CELL) + 8192);
            let arr = grid.get(key);
            if (!arr) {
                arr = [];
                grid.set(key, arr);
            }
            arr.push(i);
        }
        for (let i = 0; i < n; i++) {
            const pi = at(i);
            const vi = av(i);
            const ri = radiusOf(nd[i]);
            const ci = nd[i]?.community ?? -1;
            const gx = Math.floor(pi.x / CELL);
            const gy = Math.floor(pi.y / CELL);
            for (let dzx = -2; dzx <= 2; dzx++) {
                for (let dzy = -2; dzy <= 2; dzy++) {
                    const arr = grid.get((gx + dzx + 8192) * 16384 + (gy + dzy + 8192));
                    if (!arr)
                        continue;
                    for (const j of arr) {
                        if (j <= i)
                            continue;
                        const pj = at(j);
                        const vj = av(j);
                        const rj = radiusOf(nd[j]);
                        const dx = pi.x - pj.x;
                        const dy = pi.y - pj.y;
                        const d2 = dx * dx + dy * dy;
                        if (d2 > REPEL_RANGE * REPEL_RANGE)
                            continue;
                        const d = Math.sqrt(d2) || 0.1;
                        const minD = minSep(ri, rj);
                        // 跨社区排斥:不同圈子的节点对额外推开,圈子之间自然留白
                        const cj = nd[j]?.community ?? -1;
                        // 圈子(≥0)与中性节点(-1)也互相排斥:孤立节点不会落进圈子内部
                        const cross = ci !== cj ? sim.commRepelK : 1;
                        const pushBase = repQ * alpha * 14 * cross;
                        if (d2 < minD * minD) {
                            // 碰撞(collide):推开到刚好不覆盖;推力带上限(大团挤在预热
                            // 圈内时,裸碰撞曾让速度指数爆炸 → 全图 NaN)
                            const push = Math.min((minD - d) * 0.5 * alpha, 22 * alpha + 2);
                            const ux = dx / d;
                            const uy = dy / d;
                            vi.x += ux * push;
                            vi.y += uy * push;
                            vj.x -= ux * push;
                            vj.y -= uy * push;
                        }
                        else {
                            // charge 斥力(∝ 1/d,距离截断):把团撑开但不逃逸
                            const push = pushBase / Math.max(d, 8) * (1 - d / REPEL_RANGE);
                            const ux = dx / d;
                            const uy = dy / d;
                            vi.x += ux * push;
                            vi.y += uy * push;
                            vj.x -= ux * push;
                            vj.y -= uy * push;
                        }
                    }
                }
            }
        }
        // 2) 边弹簧(参考实现 link 模型:强度 = e.strength ?? 1/min(度) × 吸引力,
        //    「我」的枢纽边随亲密度 strength 指数增强)
        const degree = new Map();
        const bump = (id) => { degree.set(id, (degree.get(id) ?? 0) + 1); };
        for (const e of es) {
            bump(e.source);
            bump(e.target);
        }
        const linkK = 0.35 * sim.attractK;
        for (const e of es) {
            const ia = idOf.get(e.source);
            const ib = idOf.get(e.target);
            if (ia === undefined || ib === undefined)
                continue;
            const pa = at(ia);
            const pb = at(ib);
            const va = av(ia);
            const vb = av(ib);
            const dx = pb.x - pa.x;
            const dy = pb.y - pa.y;
            const d = Math.sqrt(dx * dx + dy * dy) || 1;
            const ra = radiusOf(nd[ia]);
            const rb = radiusOf(nd[ib]);
            // 目标距离:弹簧 dist × 力度,但保底两半径之和 ×3.2(团内也不会挤成球);
            // 下限随「节点间距」倍率缩放(强关系边也不会贴死)
            const target = Math.max(e.dist * sim.edgeLenK * 1.35, ra + rb + 42 * sim.gapK);
            const strength = e.strength ?? 1 / Math.min(degree.get(e.source) ?? 1, degree.get(e.target) ?? 1);
            const f = ((d - target) / d) * linkK * strength * alpha;
            va.x += dx * f;
            va.y += dy * f;
            vb.x -= dx * f;
            vb.y -= dy * f;
        }
        // 3) 向心(弱):把整图拉近「我」,防止漂移——保持低强度,给散开留空间。
        //    每节点 ±28% 稳定抖动:孤立节点(无连线)散成自然云团,而不是排成正圆环
        const centri = 0.014 * sim.centriK * alpha;
        for (let i = 0; i < n; i++) {
            const gid = nd[i]?.id ?? '';
            if (gid === 'self' || pinnedRef.current.has(gid))
                continue;
            const p = at(i);
            const v = av(i);
            const pull = centri * (0.72 + 0.56 * idJitter(gid));
            v.x += (sim.cx - p.x) * pull;
            v.y += (sim.cy - p.y) * pull;
        }
        // 4) velocity Verlet:速度集成(受 alpha 冷却),位置更新
        const decay = 0.68;
        const MAX_SPEED = 60;
        const MAX_COORD = 800_000;
        for (let i = 0; i < n; i++) {
            const gid = nd[i]?.id ?? '';
            if (gid === 'self' || pinnedRef.current.has(gid))
                continue;
            const p = at(i);
            const v = av(i);
            v.x *= decay;
            v.y *= decay;
            // 硬保险:速度/坐标钳制。布局预热或大社区拥挤时,叠加的 collide 推力
            // 曾指数爆炸到 Infinity(→ 全图 NaN、画布空白);钳制保证仿真有界,
            // 坐标上限同时落在空间网格覆盖域内(否则斥力静默丢失)。
            const speed = Math.sqrt(v.x * v.x + v.y * v.y);
            if (speed > MAX_SPEED) {
                const k = MAX_SPEED / speed;
                v.x *= k;
                v.y *= k;
            }
            p.x += v.x;
            p.y += v.y;
            if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
                p.x = sim.cx + Math.random() * 40 - 20;
                p.y = sim.cy + Math.random() * 40 - 20;
                v.x = 0;
                v.y = 0;
                continue;
            }
            if (Math.abs(p.x) > MAX_COORD || Math.abs(p.y) > MAX_COORD) {
                p.x = sim.cx + Math.random() * 1200 - 600;
                p.y = sim.cy + Math.random() * 1200 - 600;
                v.x = 0;
                v.y = 0;
            }
        }
        // 冷却(较慢:让斥力有充分时间把团撑开,图更疏朗;0.987 ≈ 520 步收敛)
        sim.alpha *= 0.987;
        layoutStepRef.current += 1;
        if (layoutStepRef.current > 900) {
            // 超时兜底:收尾(不无限跑)
            finishLayout();
            return;
        }
    };
    /** 布局收敛收尾:包围盒居中对齐 → 世界自适应 → 硬分离 → 画一帧。 */
    const finishLayout = () => {
        const sim = simStateRef.current;
        if (!sim)
            return;
        simStateRef.current = null;
        const nd = nodes();
        const { pos } = sim;
        for (let i = 0; i < nd.length; i++) {
            const g = nd[i];
            if (!g)
                continue;
            const p = pos[i];
            if (!p)
                continue;
            const out = posOf(g.id);
            out.x = p.x;
            out.y = p.y;
        }
        if (nd.length === 0)
            return;
        const cx = sim.cx;
        const cy = sim.cy;
        // 包围盒居中对齐,世界扩到包围盒+PAD(不再裁剪内容)
        let minX = cx;
        let maxX = cx;
        let minY = cy;
        let maxY = cy;
        for (const g of nd) {
            const p = posOf(g.id);
            minX = Math.min(minX, p.x);
            maxX = Math.max(maxX, p.x);
            minY = Math.min(minY, p.y);
            maxY = Math.max(maxY, p.y);
        }
        const w = Math.max(400, maxX - minX + PAD * 2);
        const h = Math.max(400, maxY - minY + PAD * 2);
        const ox = w / 2 - (minX + maxX) / 2;
        const oy = h / 2 - (minY + maxY) / 2;
        for (const g of nd) {
            const p = posOf(g.id);
            p.x += ox;
            p.y += oy;
        }
        worldRef.current = { w, h };
        // 布局后多遍全节点硬分离:清除残余重叠并保证最小间距
        for (let pass = 0; pass < 4; pass++)
            resolveOverlaps();
        // 硬分离会推开节点:按新包围盒重新居中和扩世界,再补一轮分离(避免贴边)
        let minX2 = Infinity;
        let maxX2 = -Infinity;
        let minY2 = Infinity;
        let maxY2 = -Infinity;
        for (const g of nd) {
            const p = posOf(g.id);
            minX2 = Math.min(minX2, p.x);
            maxX2 = Math.max(maxX2, p.x);
            minY2 = Math.min(minY2, p.y);
            maxY2 = Math.max(maxY2, p.y);
        }
        const w2 = Math.max(400, (maxX2 - minX2) + PAD * 2);
        const h2 = Math.max(400, (maxY2 - minY2) + PAD * 2);
        const ox2 = w2 / 2 - (minX2 + maxX2) / 2;
        const oy2 = h2 / 2 - (minY2 + maxY2) / 2;
        for (const g of nd) {
            const p = posOf(g.id);
            p.x += ox2;
            p.y += oy2;
        }
        worldRef.current = { w: w2, h: h2 };
        for (let pass = 0; pass < 2; pass++)
            resolveOverlaps();
        // 「我」固定在图谱中央:吸附到世界中心,邻居再让位一轮(不与其重叠)
        const selfN = nd.find(g => g.id === 'self');
        if (selfN) {
            const sp = posOf('self');
            sp.x = worldRef.current.w / 2;
            sp.y = worldRef.current.h / 2;
            resolveOverlaps();
        }
        recomputeGlows();
        miniAtRef.current = 0;
        fitView();
    };
    /** 社区晕影重算:按当前节点位置计算每圈一枚柔光圆(成员数 ≥3 才成圈)。 */
    const recomputeGlows = () => {
        const nd = nodes();
        const byComm = new Map();
        for (const g of nd) {
            if (g.community < 0)
                continue;
            const p = posOf(g.id);
            let arr = byComm.get(g.community);
            if (!arr) {
                arr = [];
                byComm.set(g.community, arr);
            }
            arr.push({ x: p.x, y: p.y, r: radiusOf(g) });
        }
        const glows = [];
        for (const [c, members] of byComm) {
            if (members.length < 3)
                continue;
            let minX = Infinity;
            let maxX = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;
            for (const m of members) {
                minX = Math.min(minX, m.x - m.r);
                maxX = Math.max(maxX, m.x + m.r);
                minY = Math.min(minY, m.y - m.r);
                maxY = Math.max(maxY, m.y + m.r);
            }
            glows.push({
                x: (minX + maxX) / 2,
                y: (minY + maxY) / 2,
                r: Math.max(maxX - minX, maxY - minY) / 2 + 52,
                c,
            });
        }
        glowRef.current = glows;
    };
    /** 抓取节点时的轻量冻结:把仿真位置写回但不硬分离、不 fitView,
     *  避免布局动画进行中抓取时整图突然跳变/重排。 */
    const freezeLayout = () => {
        const sim = simStateRef.current;
        if (!sim)
            return;
        simStateRef.current = null;
        const nd = nodes();
        for (let i = 0; i < nd.length; i++) {
            const g = nd[i];
            if (!g)
                continue;
            const p = sim.pos[i];
            if (!p)
                continue;
            const out = posOf(g.id);
            out.x = p.x;
            out.y = p.y;
        }
        refreshWorld();
        recomputeGlows();
        scheduleDraw();
    };
    /** 锚点节点:拖拽中的节点、固定节点或「我」不参与移动,只影响他人。 */
    const isAnchor = (id) => id === 'self' || dragRef.current?.id === id || pinnedRef.current.has(id);
    /**
     * 硬分离:与收敛步进无关,重叠节点直接推开到刚好不覆盖(保留舒适间距),
     * 保证任意状态下节点间互不重叠且距离合适。拖拽中的节点是锚点:
     * 其路径上的节点被强推(拖拽推挤感),拖拽节点本身不受影响。
     */
    const resolveOverlaps = () => {
        const nd = nodes();
        const sim = nd;
        // 最终硬分离间距:与仿真碰撞一致(4 + 14×倍率),收敛后节点不再贴脸
        const gap = 4 + 14 * gapKRef.current;
        // 空间网格(同 simStep):分离检查只做局部配对,大图从 O(n²) 降到近线性
        const CELL = 140;
        const gmap = new Map();
        for (let i = 0; i < sim.length; i++) {
            const g = sim[i];
            if (!g)
                continue;
            const p = posOf(g.id);
            const key = (Math.floor(p.x / CELL) + 8192) * 16384 + (Math.floor(p.y / CELL) + 8192);
            let arr = gmap.get(key);
            if (!arr) {
                arr = [];
                gmap.set(key, arr);
            }
            arr.push(i);
        }
        // 需要分离的节点对必然半径和+gap ≤ ~100px,同格或邻格(3×3)足够
        for (let i = 0; i < sim.length; i++) {
            const g1 = sim[i];
            if (!g1)
                continue;
            const p1 = posOf(g1.id);
            const aFix = isAnchor(g1.id);
            const gx = Math.floor(p1.x / CELL);
            const gy = Math.floor(p1.y / CELL);
            for (let dzx = -1; dzx <= 1; dzx++) {
                for (let dzy = -1; dzy <= 1; dzy++) {
                    const arr = gmap.get((gx + dzx + 8192) * 16384 + (gy + dzy + 8192));
                    if (!arr)
                        continue;
                    for (const j of arr) {
                        if (j <= i)
                            continue;
                        const g2 = sim[j];
                        if (!g2)
                            continue;
                        const p2 = posOf(g2.id);
                        const bFix = isAnchor(g2.id);
                        if (aFix && bFix)
                            continue;
                        const dx = p2.x - p1.x;
                        const dy = p2.y - p1.y;
                        const d2 = dx * dx + dy * dy;
                        const need = radiusOf(g1) + radiusOf(g2) + gap;
                        if (d2 >= need * need)
                            continue;
                        const d = Math.sqrt(d2) || 0.01;
                        const push = (need - d) / 2;
                        const ux = dx / d;
                        const uy = dy / d;
                        // 不做世界边界 clamp:分离后再量包围盒定世界(否则被挤成贴着边界的"外框")
                        if (!aFix) {
                            p1.x -= ux * push;
                            p1.y -= uy * push;
                        }
                        if (!bFix) {
                            p2.x += ux * push;
                            p2.y += uy * push;
                        }
                    }
                }
            }
        }
        // 拖拽推挤:被拖拽节点靠近时,把对方(核心圈内)整体推开,锚点不动(无边界墙)
        if (dragRef.current) {
            const dragIdNow = dragRef.current.id;
            const gd = nd.find(g => g.id === dragIdNow);
            if (gd) {
                const pd = posOf(dragIdNow);
                for (const g2 of nd) {
                    if (g2.id === dragIdNow)
                        continue;
                    if (g2.id === 'self' || pinnedRef.current.has(g2.id))
                        continue;
                    const p2 = posOf(g2.id);
                    const dx = p2.x - pd.x;
                    const dy = p2.y - pd.y;
                    const d2 = dx * dx + dy * dy;
                    const need = radiusOf(gd) + radiusOf(g2) + 18 + 14 * gapKRef.current;
                    if (d2 >= need * need)
                        continue;
                    const d = Math.sqrt(d2) || 0.01;
                    const push = need - d;
                    const ux = dx / d;
                    const uy = dy / d;
                    p2.x += ux * push;
                    p2.y += uy * push;
                }
            }
        }
    };
    /**
     * 拖拽联动(实时跟随 + 距离校正):与被拖节点相连的一跳邻居
     * ① 按拖拽位移的 62% 同帧同步移动(拖动即跟着走,不滞后);
     * ② 边距离偏离目标带时弹簧校正(拉爆/挤死都会回正)。
     * 二跳及以上不联动(杜绝整图泄漏);无关节点只被邻域碰撞推开。
     * 松手后由 startSettle 收尾。
     */
    const dragPull = (delta) => {
        const dragId = dragRef.current?.id;
        if (!dragId || settingsRef.current.lockLayout)
            return;
        if (Math.abs(delta.x) < 1e-6 && Math.abs(delta.y) < 1e-6)
            return;
        const nd = nodes();
        const pd = posOf(dragId);
        const gd = nd.find(g => g.id === dragId);
        const rad = gd ? radiusOf(gd) : 12;
        for (const e of graphRef.current.edges) {
            const other = e.source === dragId ? e.target : e.target === dragId ? e.source : null;
            if (!other || other === dragId)
                continue;
            if (other === 'self' || pinnedRef.current.has(other))
                continue;
            const og = nd.find(g => g.id === other);
            if (!og)
                continue;
            const p = posOf(other);
            // 1) 实时跟随:强关系(在自然带内)跟得紧,已被拉远的弱边自然滞后,
            //    橡皮筋感更真实——贴身邻居 0.68×,拉远后衰减到 0.3× 下限
            const target = Math.max(e.dist, rad + radiusOf(og) + 6);
            const dx = pd.x - p.x;
            const dy = pd.y - p.y;
            const d = Math.sqrt(dx * dx + dy * dy) || 1;
            const stretch = Math.max(0, d - target);
            const ratio = 0.68 * Math.max(0.3, 1 - stretch / 700);
            p.x += delta.x * ratio;
            p.y += delta.y * ratio;
            // 2) 距离校正:目标距离(边目标或最近安全距离),带外 ±6 才校正
            const slack = d - target;
            if (Math.abs(slack) > 6) {
                const f = Math.max(-1.6, Math.min(1.6, slack * 0.06));
                p.x += (dx / d) * f;
                p.y += (dy / d) * f;
            }
        }
    };
    /**
     * 局部硬分离(拖拽期间):只检查被拖节点周围 R 范围内的节点对,
     * 重叠才推开——无关节点完全不动,不扰动全图。拖拽节点是锚点。
     */
    const resolveOverlapsNear = (centerId) => {
        const nd = nodes();
        const gd = nd.find(g => g.id === centerId);
        if (!gd)
            return;
        const cp = posOf(centerId);
        const R = 220 + radiusOf(gd);
        // 邻域集合:距被拖节点 R 内的节点(不含锚点自身)
        const near = [];
        for (const g of nd) {
            if (g.id === centerId)
                continue;
            const p = posOf(g.id);
            const dx = p.x - cp.x;
            const dy = p.y - cp.y;
            if (dx * dx + dy * dy <= R * R)
                near.push({ p, r: radiusOf(g), anchor: g.id === 'self' || pinnedRef.current.has(g.id) });
        }
        const pts = [
            { p: cp, r: radiusOf(gd), anchor: true },
            // 固定节点同样是锚点:拖拽路过时不把它们推开
            ...near,
        ];
        const gap = 4 + 12 * gapKRef.current;
        for (let i = 0; i < pts.length; i++) {
            const a = pts[i];
            if (!a)
                continue;
            for (let j = i + 1; j < pts.length; j++) {
                const b = pts[j];
                if (!b)
                    continue;
                const dx = b.p.x - a.p.x;
                const dy = b.p.y - a.p.y;
                const d2 = dx * dx + dy * dy;
                const need = a.r + b.r + gap;
                if (d2 >= need * need)
                    continue;
                const d = Math.sqrt(d2) || 0.01;
                const push = (need - d) / 2;
                const ux = dx / d;
                const uy = dy / d;
                if (!a.anchor) {
                    a.p.x -= ux * push;
                    a.p.y -= uy * push;
                }
                if (!b.anchor) {
                    b.p.x += ux * push;
                    b.p.y += uy * push;
                }
            }
        }
        pushAwayFromSelf(centerId);
    };
    /** 「我」软墙:被拖节点不能与永久中心重叠(双方都是锚点,只挪被拖节点)。 */
    const pushAwayFromSelf = (centerId) => {
        const nd = nodes();
        const gd = nd.find(g => g.id === centerId);
        const selfN = nd.find(g => g.id === 'self');
        if (!gd || !selfN)
            return;
        const cp = posOf(centerId);
        const sp = posOf('self');
        const dxs = cp.x - sp.x;
        const dys = cp.y - sp.y;
        const ds = Math.sqrt(dxs * dxs + dys * dys) || 0.01;
        const needS = radiusOf(gd) + radiusOf(selfN) + 8 + 12 * gapKRef.current;
        if (ds < needS) {
            cp.x = sp.x + (dxs / ds) * needS;
            cp.y = sp.y + (dys / ds) * needS;
        }
    };
    /** 位图分辨率切换:静止=2×CSS 高清,交互/仿真=1×CSS(流畅)。 */
    const setRes = (hi) => {
        const canvas = canvasRef.current;
        if (!canvas)
            return;
        const size = sizeRef.current;
        if (size.w <= 0)
            return;
        const scale = hi ? 2 : 1;
        const w = Math.max(1, Math.round(size.w * scale));
        const h = Math.max(1, Math.round(size.h * scale));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        resRef.current = hi;
    };
    /** 交互结束后延迟恢复高清(时间防抖)。 */
    const scheduleHi = () => {
        if (hiTimerRef.current)
            window.clearTimeout(hiTimerRef.current);
        hiTimerRef.current = window.setTimeout(() => {
            hiTimerRef.current = 0;
            setRes(true);
            scheduleDraw();
        }, 350);
    };
    /** 头像精灵:把头像一次性渲染成圆形离屏 canvas(按半径缓存,避免每帧 clip 重绘)。 */
    const avatarSprite = (id, _url, r) => {
        // 半径取整 + 2px 步进:缩放动画时精灵可复用,而不是每个浮点半径重建一次
        const rk = Math.max(6, Math.round(r / 2) * 2);
        const cur = spriteRef.current.get(id);
        if (cur && cur.r === rk)
            return cur.c;
        const img = imgCacheRef.current.get(id);
        if (!img || !img.complete || img.naturalWidth === 0)
            return null;
        const dpr = 2;
        const w = Math.max(8, Math.round(rk * 2 * dpr));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = w;
        const cx = c.getContext('2d');
        if (!cx)
            return null;
        cx.beginPath();
        cx.arc(w / 2, w / 2, w / 2, 0, Math.PI * 2);
        cx.clip();
        cx.drawImage(img, 0, 0, w, w);
        spriteRef.current.set(id, { c, r: rk });
        return c;
    };
    /**
     * 绘制一帧。viewOverride 仅导出时使用(导出需要自动取景,不依赖当前视口);
     * 屏幕绘制不传,走 viewRef。
     */
    const draw = (viewOverride) => {
        const canvas = canvasRef.current;
        if (!canvas)
            return;
        const size = sizeRef.current;
        if (size.w <= 0)
            return;
        const ctx = canvas.getContext('2d');
        if (!ctx)
            return;
        ctx.setTransform(canvas.width / size.w, 0, 0, canvas.height / size.h, 0, 0);
        const v = viewOverride ?? viewRef.current;
        const darkMode = darkRef.current;
        const selected = selectedRef.current;
        const hover = hoverRef.current;
        // 焦点:拖拽中的节点优先(橡皮筋应力可见),其次悬停,最后选中
        const focus = dragRef.current?.id ?? hover ?? selected;
        const neigh = focus ? neighboursOf(graphRef.current, focus) : new Set();
        try {
            const bg = darkMode ? (themeBackground() || '#0a1025') : '#fafafa';
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, size.w, size.h);
            const s = settingsRef.current;
            // 背景网格(屏幕空间,随视图平移):Obsidian 式低调点阵
            if (s.showGrid) {
                const step = 40;
                const ox = ((v.dx % step) + step) % step;
                const oy = ((v.dy % step) + step) % step;
                ctx.fillStyle = darkMode ? 'rgba(150,170,190,0.10)' : 'rgba(70,90,110,0.12)';
                ctx.beginPath();
                for (let x = -ox; x < size.w; x += step) {
                    for (let y = -oy; y < size.h; y += step) {
                        ctx.moveTo(x + 0.5, y + 0.5);
                        ctx.rect(x - 0.6, y - 0.6, 1.2, 1.2);
                    }
                }
                ctx.fill();
            }
            // 视图变换:平移 + 缩放(节点/连线整体跟随)
            ctx.translate(v.dx, v.dy);
            ctx.scale(v.scale, v.scale);
            // 社区晕影(圈子底色):位于节点最底层;社区聚焦时只保留焦点圈
            if (glowRef.current.length > 0) {
                const foci = focusCommRef.current;
                const hovc = hoverCommRef.current;
                for (const gl of glowRef.current) {
                    if (foci !== null && gl.c !== foci)
                        continue;
                    if (foci === null && hovc !== null && gl.c !== hovc)
                        continue;
                    let alpha = darkMode ? 0.26 : 0.18;
                    if (gl.c === foci)
                        alpha = darkMode ? 0.5 : 0.4;
                    else if (gl.c === hovc)
                        alpha = darkMode ? 0.42 : 0.34;
                    ctx.globalAlpha = alpha;
                    ctx.drawImage(glowSprite(communityColor(gl.c)), gl.x - gl.r, gl.y - gl.r, gl.r * 2, gl.r * 2);
                }
                ctx.globalAlpha = 1;
            }
            // 聚焦晕:有焦点(悬停/选中)时,在焦点节点周围画淡光晕(拉出视觉中心)
            if (focus) {
                const fp = posOf(focus);
                const fr = (() => {
                    const focG = graphRef.current.nodes.find(n => n.id === focus);
                    return (focG ? radiusOf(focG) : 14) * viewRef.current.scale;
                })();
                const gr = 120 + fr * 2;
                const grd = ctx.createRadialGradient(fp.x, fp.y, fr, fp.x, fp.y, gr);
                grd.addColorStop(0, darkMode ? 'rgba(34,170,240,0.10)' : 'rgba(34,140,220,0.10)');
                grd.addColorStop(1, 'rgba(0,0,0,0)');
                ctx.fillStyle = grd;
                ctx.beginPath();
                ctx.arc(fp.x, fp.y, gr, 0, Math.PI * 2);
                ctx.fill();
            }
            // 视口裁剪:只绘制可见世界矩形内的内容(放大时省几个数量级的绘制)
            const m = 140;
            const vx0 = -v.dx / v.scale - m;
            const vy0 = -v.dy / v.scale - m;
            const vx1 = (size.w - v.dx) / v.scale + m;
            const vy1 = (size.h - v.dy) / v.scale + m;
            // 连线:弧形双向链接(两道:先分组批处理 stroke,再分组批处理箭头)
            //   亲密度(蓝,中等)=我↔好友;共同群(灰,细)=好友↔好友;聚焦时非活跃淡出
            const wMax = Math.log10(6000);
            const nodeR = new Map();
            for (const gn of graphRef.current.nodes)
                nodeR.set(gn.id, radiusOf(gn));
            const nodeW = new Map();
            for (const gn of graphRef.current.nodes)
                nodeW.set(gn.id, gn.weight);
            // 按 (active, intimacy, 线宽档) 分组,组内合并为单条 path 一次 stroke
            // (数千条边时 stroke 调用从 O(E) 降到 O(档位数),参考实现的主要性能优化)
            const edgeGroups = new Map();
            const arrowGroups = new Map();
            for (const e of graphRef.current.edges) {
                // 出生动画:两端都出现后才画边(边随节点一起"长出来")
                if (!isRevealed(e.source) || !isRevealed(e.target))
                    continue;
                const p1 = posForDraw(e.source);
                const p2 = posForDraw(e.target);
                // 两端都在视口外 → 跳过
                if ((p1.x < vx0 && p2.x < vx0) || (p1.x > vx1 && p2.x > vx1) || (p1.y < vy0 && p2.y < vy0) || (p1.y > vy1 && p2.y > vy1))
                    continue;
                const isHoverEdge = hoverEdgeRef.current !== null &&
                    ((hoverEdgeRef.current.source === e.source && hoverEdgeRef.current.target === e.target) ||
                        (hoverEdgeRef.current.source === e.target && hoverEdgeRef.current.target === e.source));
                // 导出高亮模式:所有连线都按「高亮状态」渲染(亮蓝加粗 + 光晕)
                const active = exportHighlightRef.current || isHoverEdge || !!(focus && (e.source === focus || e.target === focus));
                const intimacy = e.kind === 'intimacy';
                const strength = Math.log10(Math.max(1, e.weight)) / wMax;
                const bw = intimacy
                    ? s.edgeWidth * (0.5 + strength * 1.8)
                    : s.edgeWidth * (0.4 + strength * 1.1);
                // 社区聚焦/悬停:两端点都在圈内才保留,圈外线淡出
                let commFade = 1;
                const fci = focusCommRef.current;
                const hci = hoverCommRef.current;
                if (fci !== null) {
                    commFade = commOfRef.current.get(e.source) === fci && commOfRef.current.get(e.target) === fci ? 1 : 0.10;
                }
                else if (hci !== null) {
                    commFade = commOfRef.current.get(e.source) === hci && commOfRef.current.get(e.target) === hci ? 1 : 0.22;
                }
                // 远景(缩小查看全图)时弱边继续变淡,聚焦时醒目
                const zoomFade = 0.55 + 0.45 * Math.min(1, Math.max(0, (v.scale - 0.4) / 1.4));
                const fade = exportHighlightRef.current ? 1 : ((focus && !active) ? 0.18 : 1) * commFade * zoomFade;
                // 线宽:概览保底 1.1px 屏宽;悬停/选中(stop)时 2.1× 加粗
                // 最小屏宽随「连线粗细」滑杆缩放(默认 1.25× 时仍为 1.1px),
                // 否则概览下所有边都被顶到同一 1.1px,滑杆失效
                const lw = Math.max((1.1 * s.edgeWidth / EDGE_WIDTH_DEFAULT) / v.scale, bw * (active ? 2.1 : fade));
                // 弧线(二次贝塞尔):端点收缩到节点圆周
                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;
                const len = Math.sqrt(dx * dx + dy * dy);
                if (len < 1e-3)
                    continue;
                const sign = (edgeSeed(e.source, e.target) % 2 === 0) ? 1 : -1;
                const bend = Math.max(28, len * 0.22) * sign;
                const mx = (p1.x + p2.x) / 2 - (dy / len) * bend;
                const my = (p1.y + p2.y) / 2 + (dx / len) * bend;
                const r1 = nodeR.get(e.source) ?? 10;
                const r2 = nodeR.get(e.target) ?? 10;
                const u1x = mx - p1.x;
                const u1y = my - p1.y;
                const u2x = mx - p2.x;
                const u2y = my - p2.y;
                const l1u = Math.sqrt(u1x * u1x + u1y * u1y) || 1;
                const l2u = Math.sqrt(u2x * u2x + u2y * u2y) || 1;
                const sx = p1.x + (u1x / l1u) * (r1 + 2);
                const sy = p1.y + (u1y / l1u) * (r1 + 2);
                const ex = p2.x + (u2x / l2u) * (r2 + 2);
                const ey = p2.y + (u2y / l2u) * (r2 + 2);
                const key = `${active ? 'a' : 'n'}${intimacy ? 's' : 'e'}${fade < 1 ? 'f' : 'n'}${Math.round(lw * 4) / 4}`;
                let eg = edgeGroups.get(key);
                if (!eg) {
                    eg = [];
                    edgeGroups.set(key, eg);
                }
                const seg = len < r1 + r2 + 34
                    ? { sx0: sx, sy0: sy, cx0: ex, cy0: ey, ex0: ex, ey0: ey }
                    : { sx0: sx, sy0: sy, cx0: mx, cy0: my, ex0: ex, ey0: ey };
                eg.push(seg);
                if (s.showArrows && len > r1 + r2 + 12) {
                    let ag = arrowGroups.get(key);
                    if (!ag) {
                        ag = [];
                        arrowGroups.set(key, ag);
                    }
                    // 每条边只画一个箭头:从权重轻的一端指向重的一端(避免双向箭头噪音)
                    const towardTarget = (nodeW.get(e.target) ?? 0) > (nodeW.get(e.source) ?? 0);
                    ag.push(towardTarget
                        ? { ux: u1x / l1u, uy: u1y / l1u, tipX: sx, tipY: sy }
                        : { ux: u2x / l2u, uy: u2y / l2u, tipX: ex, tipY: ey });
                }
            }
            // 悬停/选中的活跃连线先描一道宽而淡的蓝色光晕(焦点结构一眼可见)
            for (const [key, list] of edgeGroups) {
                if (!key.startsWith('a'))
                    continue;
                ctx.strokeStyle = 'rgba(34,170,240,0.20)';
                ctx.lineWidth = Number(key.slice(4)) * 2.6;
                ctx.beginPath();
                for (const g of list) {
                    ctx.moveTo(g.sx0, g.sy0);
                    ctx.quadraticCurveTo(g.cx0, g.cy0, g.ex0, g.ey0);
                }
                ctx.stroke();
            }
            for (const [key, list] of edgeGroups) {
                const active = key.startsWith('a');
                const intimacy = key[1] === 's';
                const faded = key[2] === 'f';
                const lw = Number(key.slice(4));
                ctx.strokeStyle = active
                    ? 'rgba(34,170,240,0.98)'
                    : intimacy
                        ? faded ? 'rgba(90,175,235,0.08)' : 'rgba(90,175,235,0.20)'
                        : faded ? 'rgba(150,165,180,0.13)' : 'rgba(150,165,180,0.44)';
                ctx.lineWidth = lw;
                ctx.beginPath();
                for (const g of list) {
                    ctx.moveTo(g.sx0, g.sy0);
                    ctx.quadraticCurveTo(g.cx0, g.cy0, g.ex0, g.ey0);
                }
                ctx.stroke();
            }
            if (s.showArrows) {
                for (const [key, list] of arrowGroups) {
                    const active = key.startsWith('a');
                    const intimacy = key[1] === 's';
                    const faded = key[2] === 'f';
                    ctx.fillStyle = active
                        ? 'rgba(34,170,240,0.98)'
                        : intimacy
                            ? faded ? 'rgba(90,175,235,0.12)' : 'rgba(90,175,235,0.30)'
                            : faded ? 'rgba(150,165,180,0.16)' : 'rgba(150,165,180,0.52)';
                    const lw = Number(key.slice(4));
                    // 箭头按屏幕恒定尺寸(随缩放保持不变):概览下不再 0.45px 不可见、放大后不过大
                    const size = Math.min(7, Math.max(3.5, lw * v.scale * 2.2)) / v.scale;
                    ctx.beginPath();
                    for (const a of list) {
                        const bx = -a.uy;
                        const by = a.ux;
                        ctx.moveTo(a.tipX, a.tipY);
                        ctx.lineTo(a.tipX - a.ux * size + bx * size * 0.5, a.tipY - a.uy * size + by * size * 0.5);
                        ctx.lineTo(a.tipX - a.ux * size - bx * size * 0.5, a.tipY - a.uy * size - by * size * 0.5);
                        ctx.closePath();
                    }
                    ctx.fill();
                }
            }
            // 节点(「节点模糊」开启时对全部节点/头像/名字做高斯模糊,连线保持清晰)
            if (s.blurNodes > 0)
                ctx.filter = `blur(${s.blurNodes}px)`;
            for (const g of graphRef.current.nodes) {
                // 出生动画:未出现的节点不绘制
                if (!isRevealed(g.id))
                    continue;
                const p = posForDraw(g.id);
                // 视口外节点跳过(半径+标签留白)
                const cull = 100 + Math.max(4, radiusOf(g));
                if (p.x < vx0 - cull || p.x > vx1 + cull || p.y < vy0 - cull || p.y > vy1 + cull)
                    continue;
                const isSel = g.id === selected || dragRef.current?.id === g.id;
                const isHov = g.id === hover;
                const isSelf = g.id === 'self';
                let dim = !exportHighlightRef.current && !!(focus && g.id !== focus && !neigh.has(g.id)) && !isSel && !isHov;
                // 社区聚焦/悬停:圈内节点保持,圈外淡出
                const ownComm = commOfRef.current.get(g.id);
                const focusingComm = focusCommRef.current !== null;
                const targetComm = focusingComm ? focusCommRef.current : hoverCommRef.current;
                if (targetComm !== null && ownComm !== targetComm)
                    dim = true;
                // 社区色(未分组 = 中性灰;头像节点也用同色描边,圈子一眼可见)
                const commColor = g.community >= 0 ? communityColor(g.community) : (darkMode ? 'rgba(160,170,185,0.6)' : 'rgba(120,132,148,0.6)');
                ctx.globalAlpha = (dim ? 0.25 : 1) * birthAlpha(g.id);
                // 聚焦节点放大(Obsidian 悬停放大感)
                const boost = (isSel || isHov) ? 1.15 : 1;
                // 概览兜底:屏幕半径下限随 nodeScale 缩放且按节点自身半径倍率(≤4×)封顶——
                // 小节点抬到自身 4 倍、大节点保持更大,消息量差异在概览下清晰可见
                const rBase = Math.max(4, radiusOf(g)) * boost * birthScale(g.id);
                const floorScreen = 9 * nodeScaleRef.current;
                const natural = Math.max(0.01, rBase * v.scale);
                const floorK = Math.min(floorScreen, natural * 4);
                const r = rBase * Math.max(1, floorK / natural);
                if (isSel || isHov) {
                    ctx.strokeStyle = 'rgba(34,170,240,0.95)';
                    ctx.lineWidth = 1.8;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, r + 4, 0, Math.PI * 2);
                    ctx.stroke();
                }
                else {
                    // 常驻社区色描边(参考实现:圈子色一眼可见,含头像节点)
                    ctx.strokeStyle = commColor;
                    ctx.lineWidth = dim ? 0.8 : 1.4;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, r - 0.6, 0, Math.PI * 2);
                    ctx.stroke();
                }
                if (isSelf) {
                    // 「我」:头像优先(本地 data URL,圆形剪裁),保留蓝色光晕环;无头像用白圆+「我」
                    const selfUrl = avatarCache.get(g.id) ?? '';
                    let selfImg = selfUrl ? imgCacheRef.current.get(g.id) : undefined;
                    if (selfUrl && !selfImg) {
                        const im = new Image();
                        im.onload = () => { scheduleDraw(); };
                        im.src = selfUrl;
                        imgCacheRef.current.set(g.id, im);
                        selfImg = im;
                    }
                    const selfSprite = selfUrl ? avatarSprite(g.id, selfUrl, r) : null;
                    if (selfSprite) {
                        // 头像 + 双环光晕(头像底有白色垫圈)
                        ctx.fillStyle = darkMode ? 'rgba(232,236,244,0.92)' : 'rgba(255,255,255,0.92)';
                        ctx.beginPath();
                        ctx.arc(p.x, p.y, r + 1.2, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.drawImage(selfSprite, p.x - r, p.y - r, r * 2, r * 2);
                        ctx.strokeStyle = 'rgba(34,170,240,0.85)';
                        ctx.lineWidth = 2;
                        ctx.beginPath();
                        ctx.arc(p.x, p.y, r * 1.08, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.strokeStyle = 'rgba(34,170,240,0.22)';
                        ctx.lineWidth = 3.4;
                        ctx.beginPath();
                        ctx.arc(p.x, p.y, r * 1.26, 0, Math.PI * 2);
                        ctx.stroke();
                    }
                    else {
                        // 无头像:白圆 + 「我」字 + 双环
                        ctx.fillStyle = darkMode ? '#e8ecf4' : '#1c2434';
                        ctx.beginPath();
                        ctx.arc(p.x, p.y, r * 0.95, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.strokeStyle = 'rgba(34,170,240,0.75)';
                        ctx.lineWidth = 1.6;
                        ctx.beginPath();
                        ctx.arc(p.x, p.y, r * 1.08, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.strokeStyle = 'rgba(34,170,240,0.22)';
                        ctx.lineWidth = 3;
                        ctx.beginPath();
                        ctx.arc(p.x, p.y, r * 1.22, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.fillStyle = darkMode ? '#1c2434' : '#f5f7fa';
                        ctx.font = '700 ' + String(Math.max(10, r * 0.85)) + 'px sans-serif';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText('我', p.x, p.y);
                    }
                    // 「我」固定徽标
                    if (pinnedRef.current.has(g.id)) {
                        const px = p.x + r * 0.95;
                        const py = p.y - r * 0.95;
                        ctx.fillStyle = darkMode ? '#24314a' : '#ffffff';
                        ctx.strokeStyle = 'rgba(34,170,240,0.95)';
                        ctx.lineWidth = 1.2;
                        ctx.beginPath();
                        ctx.arc(px, py, 5, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.stroke();
                        ctx.fillStyle = '#22aaf0';
                        ctx.beginPath();
                        ctx.arc(px, py, 1.6, 0, Math.PI * 2);
                        ctx.fill();
                    }
                    ctx.globalAlpha = 1;
                    // 「我」的标签同样受「全部标签」开关约束(选中/悬停时始终显示)
                    if (s.showLabels || isSel || isHov) {
                        ctx.font = '12px sans-serif';
                        ctx.textAlign = 'left';
                        ctx.textBaseline = 'middle';
                        ctx.globalAlpha = settingsRef.current.labelOpacity;
                        ctx.fillStyle = darkMode ? 'rgba(230,234,240,0.95)' : 'rgba(45,55,72,0.95)';
                        ctx.fillText(g.label, p.x + r + 8, p.y);
                        ctx.globalAlpha = 1;
                    }
                    continue;
                }
                const avatarUrl = avatarCache.get(g.id) ?? '';
                let img = avatarUrl ? imgCacheRef.current.get(g.id) : undefined;
                if (avatarUrl && !img) {
                    const im = new Image();
                    im.onload = () => { scheduleDraw(); };
                    im.src = avatarUrl;
                    imgCacheRef.current.set(g.id, im);
                    img = im;
                }
                const sprite = avatarUrl ? avatarSprite(g.id, avatarUrl, r) : null;
                if (sprite) {
                    ctx.drawImage(sprite, p.x - r, p.y - r, r * 2, r * 2);
                }
                else if (!img || !img.complete || img.naturalWidth === 0) {
                    // 社区色(参考实现 communityColor;未分组 = 中性灰)
                    const comm = g.community;
                    const small = g.weight < 40;
                    if (small) {
                        // 低活跃节点(弱关系):小暗色点
                        ctx.globalAlpha = dim ? 0.18 : 0.5;
                        ctx.fillStyle = comm >= 0
                            ? communityColor(comm)
                            : (darkMode ? 'rgba(170,180,195,0.75)' : 'rgba(70,82,98,0.75)');
                        ctx.beginPath();
                        ctx.arc(p.x, p.y, Math.max(3, r * 0.6), 0, Math.PI * 2);
                        ctx.fill();
                        ctx.globalAlpha = 1;
                    }
                    else {
                        // 正常节点:社区色圆 + 首字母
                        ctx.globalAlpha = dim ? 0.35 : 1;
                        ctx.fillStyle = comm >= 0
                            ? communityColor(comm)
                            : (darkMode ? 'rgba(180,190,205,0.9)' : 'rgba(55,66,82,0.9)');
                        ctx.beginPath();
                        ctx.arc(p.x, p.y, r * 0.92, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.fillStyle = 'rgba(255,255,255,0.92)';
                        ctx.font = '700 ' + String(Math.max(8, r * 0.8)) + 'px sans-serif';
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.fillText((g.label || '?').slice(0, 1).toUpperCase(), p.x, p.y + 0.5);
                        ctx.globalAlpha = 1;
                    }
                }
                // stub(知识库未解析 [[目标]]):虚线轮廓标识
                if (g.stub === true) {
                    ctx.globalAlpha = dim ? 0.4 : 0.95;
                    ctx.setLineDash([3, 3]);
                    ctx.strokeStyle = (darkMode ? 'rgba(235,238,244,0.9)' : 'rgba(90,100,115,0.9)');
                    ctx.lineWidth = 1.5;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, r * 0.92, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.globalAlpha = 1;
                }
                ctx.globalAlpha = 1;
                // 固定徽标:右上角白底蓝点(钉子语义)
                if (pinnedRef.current.has(g.id)) {
                    const px = p.x + r * 0.9;
                    const py = p.y - r * 0.9;
                    ctx.fillStyle = darkMode ? '#24314a' : '#ffffff';
                    ctx.strokeStyle = 'rgba(34,170,240,0.95)';
                    ctx.lineWidth = 1.2;
                    ctx.beginPath();
                    ctx.arc(px, py, 5, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.stroke();
                    ctx.fillStyle = '#22aaf0';
                    ctx.beginPath();
                    ctx.arc(px, py, 1.6, 0, Math.PI * 2);
                    ctx.fill();
                }
                // 标签:仅「全部标签」开启时绘制;关闭时除选中/悬停节点外一律不画
                // (此前按权重排名"偷跑"显示前 36 名标签,与开关语义冲突)
                const rank = rankRef.current.get(g.id) ?? Number.MAX_SAFE_INTEGER;
                // 概览(scale<0.85)时前 12 名关键节点用"屏幕字号"标签,保证节点信息始终可读
                const screenLabel = v.scale < 0.85 && rank <= 12;
                // 导出期可用 labelCapRef 限制标签数量(海报只标关键人物,避免全量文字糊成一片)
                if ((s.showLabels && (labelCapRef.current === null || rank <= labelCapRef.current)) || isSel || isHov) {
                    const label = g.label.length > 16 ? g.label.slice(0, 16) + '…' : g.label;
                    // 「全部标签」开启且缩小时:普通标签也有 8px 屏幕字号下限(否则 4px 不可读)
                    const labelFont = screenLabel
                        ? `${(Math.max(12, 12 * v.scale) / v.scale).toFixed(1)}px`
                        : (v.scale < 0.85 && s.showLabels ? `${(8 / v.scale).toFixed(1)}px` : '12px');
                    ctx.font = labelFont + ' sans-serif';
                    ctx.textAlign = 'left';
                    ctx.textBaseline = 'middle';
                    if (isSel || isHov) {
                        const tw = ctx.measureText(label).width;
                        const chipA = darkMode ? 0.62 : 0.85;
                        const chipBg = darkMode ? 'rgba(16,22,34,1)' : 'rgba(255,255,255,1)';
                        ctx.globalAlpha = chipA;
                        ctx.fillStyle = chipBg;
                        ctx.beginPath();
                        const chip1x = p.x + r + 4;
                        const chip1y = p.y - 9;
                        if (typeof ctx.roundRect === 'function') {
                            ctx.roundRect(chip1x, chip1y, tw + 10, 18, 5);
                        }
                        else {
                            ctx.rect(chip1x, chip1y, tw + 10, 18);
                        }
                        ctx.fill();
                        ctx.globalAlpha = 1;
                    }
                    ctx.globalAlpha = settingsRef.current.labelOpacity;
                    ctx.fillStyle = darkMode ? 'rgba(230,234,240,0.95)' : 'rgba(45,55,72,0.95)';
                    ctx.fillText(label, p.x + r + (isSel || isHov ? 9 : 6), p.y);
                    ctx.globalAlpha = 1;
                }
            }
            if (s.blurNodes > 0)
                ctx.filter = 'none';
        }
        catch (e) {
            ctx.setTransform(canvas.width / size.w, 0, 0, canvas.height / size.h, 0, 0);
            ctx.fillStyle = '#f43f5e';
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillText('绘图错误: ' + e.message, 16, 30);
        }
        // 小地图节流重绘(布局收尾会强制刷新)
        const nowMs = performance.now();
        if (nowMs - miniAtRef.current > 160) {
            miniAtRef.current = nowMs;
            drawMinimap();
        }
    };
    const scheduleDraw = () => {
        if (!rafRef.current)
            rafRef.current = requestAnimationFrame(() => { rafRef.current = 0; draw(); });
    };
    /** 主循环:绘制驱动(布局由 layoutDisc 单独负责;此处仅静止渲染一帧)。 */
    const loop = () => {
        if (!runningRef.current)
            return;
        draw();
        rafRef.current = 0;
        runningRef.current = false;
        // 静止:恢复全高清并重绘一帧
        setRes(true);
        draw();
    };
    const start = () => {
        if (!runningRef.current) {
            runningRef.current = true;
            setRes(false);
            rafRef.current = requestAnimationFrame(loop);
        }
    };
    const stop = () => {
        runningRef.current = false;
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
    };
    const ensureSize = () => {
        const canvas = canvasRef.current;
        if (!canvas)
            return;
        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        if (cw > 0 && ch > 0) {
            const prev = sizeRef.current;
            if (Math.abs(cw - prev.w) > 0.5 || Math.abs(ch - prev.h) > 0.5) {
                sizeRef.current = { w: cw, h: ch, dpr: 1 };
                setRes(resRef.current);
                if (!laidOutRef.current) {
                    layoutDisc();
                    laidOutRef.current = true;
                }
            }
        }
    };
    /** 相机动画取消(交互打断)。 */
    const cancelCam = () => {
        if (camRafRef.current) {
            cancelAnimationFrame(camRafRef.current);
            camRafRef.current = 0;
        }
    };
    /** 视口缓动动画:目标 dx/dy/scale,340ms ease-out-cubic。 */
    const animateView = (dx, dy, scale, ms = 340) => {
        cancelCam();
        const from = { ...viewRef.current };
        setRes(false);
        const t0 = performance.now();
        const step = () => {
            camRafRef.current = 0;
            const t = Math.min(1, (performance.now() - t0) / ms);
            const e = 1 - Math.pow(1 - t, 3);
            viewRef.current.dx = from.dx + (dx - from.dx) * e;
            viewRef.current.dy = from.dy + (dy - from.dy) * e;
            viewRef.current.scale = from.scale + (scale - from.scale) * e;
            draw();
            if (t < 1) {
                camRafRef.current = requestAnimationFrame(step);
            }
            else {
                setRes(true);
                draw();
            }
        };
        camRafRef.current = requestAnimationFrame(step);
    };
    /** 计算「整图可见」的目标视图(供 fitView/动画共用)。 */
    const fitTarget = () => {
        const vw = sizeRef.current.w;
        const vh = sizeRef.current.h;
        const world = worldRef.current;
        const sc = Math.min((vw - 24) / world.w, (vh - 24) / world.h, 1.6);
        const scale = Math.max(ZOOM_MIN, sc);
        return {
            scale,
            dx: vw / 2 - (world.w / 2) * scale,
            dy: vh / 2 - (world.h / 2) * scale,
        };
    };
    const fitView = () => {
        const vw = sizeRef.current.w;
        const vh = sizeRef.current.h;
        if (vw <= 0 || vh <= 0)
            return;
        // 只适配视图(布局由 layoutDisc 在数据/参数变化时负责)
        const t = fitTarget();
        viewRef.current.scale = t.scale;
        viewRef.current.dx = t.dx;
        viewRef.current.dy = t.dy;
        draw();
    };
    /** 小地图投影:等比例缩放 + 居中(letterbox),保证任何形状不被拉伸变椭圆。 */
    const miniFit = () => {
        const mc = miniRef.current;
        const cw = mc?.clientWidth || 1;
        const ch = mc?.clientHeight || 1;
        const world = worldRef.current;
        const sc = Math.min(cw / world.w, ch / world.h);
        return { sc, ox: (cw - world.w * sc) / 2, oy: (ch - world.h * sc) / 2 };
    };
    /** 小地图:全图 dot 俯视 + 视口矩形;拖动擦洗移动视图。 */
    const drawMinimap = () => {
        const mc = miniRef.current;
        if (!mc || inExportRef.current)
            return;
        const cw = mc.clientWidth;
        const ch = mc.clientHeight;
        if (cw <= 0 || ch <= 0)
            return;
        const dpr = 2;
        if (mc.width !== Math.round(cw * dpr) || mc.height !== Math.round(ch * dpr)) {
            mc.width = Math.round(cw * dpr);
            mc.height = Math.round(ch * dpr);
        }
        const mctx = mc.getContext('2d');
        if (!mctx)
            return;
        mctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        mctx.clearRect(0, 0, cw, ch);
        const { sc, ox, oy } = miniFit();
        const nd = nodes();
        const sel = selectedRef.current;
        for (const g of nd) {
            // 出生动画:未出现的节点在小地图上也隐藏
            if (!isRevealed(g.id))
                continue;
            const p = posOf(g.id);
            const x = ox + p.x * sc;
            const y = oy + p.y * sc;
            if (g.id === 'self') {
                mctx.fillStyle = '#22aaf0';
                mctx.fillRect(x - 2.4, y - 2.4, 4.8, 4.8);
            }
            else if (sel === g.id) {
                mctx.fillStyle = '#ffffff';
                mctx.strokeStyle = 'rgba(34,170,240,0.95)';
                mctx.lineWidth = 1;
                mctx.fillRect(x - 2.6, y - 2.6, 5.2, 5.2);
                mctx.strokeRect(x - 2.6, y - 2.6, 5.2, 5.2);
            }
            else {
                mctx.fillStyle = g.community >= 0 ? communityColor(g.community) : 'rgba(150,160,175,0.75)';
                mctx.fillRect(x - 1.2, y - 1.2, 2.4, 2.4);
            }
        }
        // 视口矩形
        const v = viewRef.current;
        const vx0 = ox + (-v.dx / v.scale) * sc;
        const vy0 = oy + (-v.dy / v.scale) * sc;
        const vr = Math.max(2, (sizeRef.current.w / v.scale) * sc);
        const vb = Math.max(2, (sizeRef.current.h / v.scale) * sc);
        mctx.strokeStyle = 'rgba(34,170,240,0.9)';
        mctx.lineWidth = 1;
        mctx.strokeRect(vx0 + 0.5, vy0 + 0.5, vr, vb);
    };
    /** 小地图点击/拖动 → 视图中心跳到该世界点。 */
    const miniCenter = (ev) => {
        const mc = miniRef.current;
        if (!mc)
            return;
        const rect = mc.getBoundingClientRect();
        const { sc, ox, oy } = miniFit();
        const wx = ((ev.clientX - rect.left) - ox) / sc;
        const wy = ((ev.clientY - rect.top) - oy) / sc;
        const vw = sizeRef.current.w;
        const vh = sizeRef.current.h;
        if (vw <= 0 || vh <= 0)
            return;
        const v = viewRef.current;
        v.dx = vw / 2 - wx * v.scale;
        v.dy = vh / 2 - wy * v.scale;
        scheduleDraw();
        drawMinimap();
    };
    /** 世界跟随内容:按节点包围盒重定世界尺寸,并让「我」保持世界中心
     * (内容平移 + 相机反补偿,画面不动)——拖到任意远之后小地图/适应视图仍准确。 */
    const refreshWorld = () => {
        const nd = nodes();
        if (nd.length === 0)
            return;
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (const g of nd) {
            const p = posOf(g.id);
            const rr = radiusOf(g);
            minX = Math.min(minX, p.x - rr);
            maxX = Math.max(maxX, p.x + rr);
            minY = Math.min(minY, p.y - rr);
            maxY = Math.max(maxY, p.y + rr);
        }
        if (!Number.isFinite(minX))
            return;
        const w = Math.max(400, maxX - minX + PAD * 2);
        const h = Math.max(400, maxY - minY + PAD * 2);
        const self = nd.find(g => g.id === 'self');
        const px = self ? posOf(self.id).x : (minX + maxX) / 2;
        const py = self ? posOf(self.id).y : (minY + maxY) / 2;
        const dx = w / 2 - px;
        const dy = h / 2 - py;
        if (dx !== 0 || dy !== 0) {
            for (const g of nd) {
                const p = posOf(g.id);
                p.x += dx;
                p.y += dy;
            }
            viewRef.current.dx -= dx * viewRef.current.scale;
            viewRef.current.dy -= dy * viewRef.current.scale;
        }
        worldRef.current = { w, h };
        miniAtRef.current = 0;
    };
    useImperativeHandle(ref, () => {
        // 渲染完整朋友圈海报(统计/圈子/图例全含),返回海报画布,供 renderPoster(JPEG)/exportPng(PNG) 共用
        const renderPosterCanvas = (ratio, style) => {
            // 导出前完成出生动画(确保导出全图)
            completeReveal();
            const canvas = canvasRef.current;
            if (!canvas)
                throw new Error('画布未就绪');
            // 1) 计算世界包围盒(含半径),图层按海报图谱卡尺寸等比取景
            const nd = nodes();
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const g of nd) {
                const p = posOf(g.id);
                const rr = radiusOf(g);
                minX = Math.min(minX, p.x - rr - 6);
                maxX = Math.max(maxX, p.x + rr + 6);
                minY = Math.min(minY, p.y - rr - 6);
                maxY = Math.max(maxY, p.y + rr + 6);
            }
            if (!Number.isFinite(minX))
                throw new Error('无数据');
            const gw = Math.max(maxX - minX, 1);
            const gh = Math.max(maxY - minY, 1);
            // 圈子概览(按成员数降序,全量,含颜色/人数/成员名)—— 提前计算以便布局自适应展示全部圈子
            const commMap = new Map();
            for (const g of nd) {
                if (g.kind === 'self' || g.community < 0)
                    continue;
                const e = commMap.get(g.community) ?? { count: 0, labels: [] };
                e.count += 1;
                if (e.labels.length < 2)
                    e.labels.push(g.label);
                commMap.set(g.community, e);
            }
            const communities = [...commMap.entries()]
                .sort((a, b) => b[1].count - a[1].count)
                .map(([cid, c]) => ({
                color: communityColor(cid),
                count: c.count,
                names: c.labels.join('、'),
            }));
            const layout = getPosterLayout(ratio, communities.length);
            const fit = Math.min(layout.graphW / gw, layout.graphH / gh);
            const LW = Math.max(1, Math.round(gw * fit));
            const LH = Math.max(1, Math.round(gh * fit));
            // 图层绘制到临时 canvas(分辨率:逻辑 × 6,保证清晰)
            const layer = document.createElement('canvas');
            const LSCALE = 6;
            layer.width = LW * LSCALE;
            layer.height = LH * LSCALE;
            const lctx = layer.getContext('2d');
            if (!lctx)
                throw new Error('无法创建画布');
            lctx.setTransform(LSCALE, 0, 0, LSCALE, 0, 0);
            lctx.fillStyle = style === 'dark' ? '#0a1025' : style === 'neon' ? '#0d0a22' : '#1a2030';
            lctx.fillRect(0, 0, LW, LH);
            // 视口:把图层中心对齐到世界包围盒中心
            const vcx = (minX + maxX) / 2;
            const vcy = (minY + maxY) / 2;
            // 图层视图按真实比例缩放适配整图(此前 scale=1 会把图层外的大半节点裁掉)
            const viewScale = Math.min(LW / gw, LH / gh);
            const view = { dx: LW / 2 - vcx * viewScale, dy: LH / 2 - vcy * viewScale, scale: viewScale };
            // 2) 把当前 canvas 位图暂存,临时换尺寸/视图绘制图层
            const prevW = canvas.width;
            const prevH = canvas.height;
            const prevSize = { ...sizeRef.current };
            const prevView = { ...viewRef.current };
            sizeRef.current = { w: LW, h: LH, dpr: 1 };
            canvas.width = LW * LSCALE;
            canvas.height = LH * LSCALE;
            viewRef.current = view;
            const saved = { dark: darkRef.current };
            darkRef.current = style !== 'light';
            exportHighlightRef.current = true;
            inExportRef.current = true;
            try {
                draw();
                const lctx2 = canvas.getContext('2d');
                if (lctx2) {
                    lctx.setTransform(LSCALE, 0, 0, LSCALE, 0, 0);
                    lctx.drawImage(canvas, 0, 0, LW, LH);
                }
            }
            finally {
                // 恢复
                darkRef.current = saved.dark;
                exportHighlightRef.current = false;
                canvas.width = prevW;
                canvas.height = prevH;
                sizeRef.current = prevSize;
                viewRef.current = prevView;
                inExportRef.current = false;
                draw();
            }
            // 3) 海报排版(风格化,发朋友圈)
            const date = new Date();
            const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
            const isPeople = settingsRef.current.mode === 'people';
            const msgTotal = nd.reduce((a, g) => a + (g.intimacy ?? 0), 0);
            const msgStr = msgTotal >= 10000 ? `${(msgTotal / 10000).toFixed(1)}万` : String(msgTotal);
            const stats = isPeople
                ? [
                    { label: '展示好友', value: String(nd.filter(n => n.kind !== 'self').length) },
                    { label: '连线', value: String(graphRef.current.edges.length) },
                    { label: '圈子', value: String(graphRef.current.communityCount) },
                    { label: '消息量', value: msgStr },
                ]
                : [
                    { label: '展示群聊', value: String(nd.filter(n => n.kind !== 'self').length) },
                    { label: '连线', value: String(graphRef.current.edges.length) },
                    { label: '圈子', value: String(graphRef.current.communityCount) },
                    { label: '消息量', value: msgStr },
                ];
            // 最亲近 TOP6(按消息量降序,带头像精灵)
            const topRelations = [...nd]
                .filter(n => n.kind !== 'self')
                .sort((a, b) => (b.intimacy ?? 0) - (a.intimacy ?? 0))
                .slice(0, 6)
                .map(n => ({
                name: n.label,
                msg: n.intimacy ?? n.weight,
                sprite: avatarSprite(n.id, avatarCache.get(n.id) ?? '', 26),
            }));
            const poster = buildPoster({
                graphLayer: layer,
                ratio,
                style,
                tag: 'WECHAT SOCIAL GRAPH',
                title: '我的微信社交图谱',
                subtitle: `${isPeople ? '群友圈子' : '群聊网络'} · 数据来自本地微信记录 · ${dateStr}`,
                stats,
                topRelations,
                communities,
                blurNodes: settingsRef.current.blurNodes,
                legend: isPeople
                    ? '● 颜色 = 圈子　— 蓝线 = 社交连线(高亮)　◍ 大小 = 消息量'
                    : '● 颜色 = 圈子　— 蓝线 = 群聊连线(高亮)　◍ 大小 = 消息量',
                footer: `由 DeepSeek Harness 生成 · ${dateStr}`,
            });
            return poster;
        };
        return {
            // 适应视图(带相机缓动)
            fitView: () => {
                const t = fitTarget();
                if (sizeRef.current.w > 0)
                    animateView(t.dx, t.dy, t.scale);
            },
            // 播放动画 = 出生动画 + 力导向:从「我」开始,节点按权重序逐个
            // 从中心飞出生长到各自位置(视角不变),期间布局持续收敛
            runAnimation: () => {
                const nd = nodes();
                if (nd.length === 0)
                    return;
                if (revealRafRef.current)
                    cancelAnimationFrame(revealRafRef.current);
                revealRafRef.current = 0;
                const birth = new Map([['self', performance.now()]]);
                revealRef.current = { count: 1, total: nd.length, birth, startAt: performance.now() };
                layoutDisc(true);
                scheduleDraw();
                const step = () => {
                    revealRafRef.current = 0;
                    const r = revealRef.current;
                    if (!r)
                        return;
                    const now = performance.now();
                    if (r.count < r.total) {
                        // 时间基准出生:每 50ms 一个节点;慢帧时一次补足到当前时刻
                        const target = Math.min(r.total, 1 + Math.floor((now - r.startAt) / 50));
                        while (r.count < target) {
                            const id = revealOrderRef.current[r.count];
                            if (id)
                                r.birth.set(id, now);
                            r.count += 1;
                        }
                        scheduleDraw();
                        revealRafRef.current = requestAnimationFrame(step);
                        return;
                    }
                    // 全部出现:等最后一个出生动画播完再清理状态
                    let last = 0;
                    for (const t of r.birth.values())
                        last = Math.max(last, t);
                    if (now - last > 620) {
                        revealRef.current = null;
                        scheduleDraw();
                        return;
                    }
                    revealRafRef.current = requestAnimationFrame(step);
                };
                revealRafRef.current = requestAnimationFrame(step);
            },
            // 重新布局 = 清空位置,随机起点重新摆放(保留固定节点)
            relayout: () => {
                const nd = nodes();
                for (const n of nd) {
                    if (pinnedRef.current.has(n.id))
                        continue;
                    posRef.current.delete(n.id);
                }
                layoutDisc(false);
            },
            exportSvg: () => {
                // 导出前完成出生动画(确保导出全图)
                completeReveal();
                // 以世界坐标生成完整 SVG:社区光晕/连线/头像/圈色描边/字母/徽标/标签,
                // 与画布现有效果保持一致
                const nd = nodes();
                const es = graphRef.current.edges;
                let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
                for (const g of nd) {
                    const p = posOf(g.id);
                    minX = Math.min(minX, p.x - 40);
                    maxX = Math.max(maxX, p.x + 40);
                    minY = Math.min(minY, p.y - 40);
                    maxY = Math.max(maxY, p.y + 40);
                }
                if (!Number.isFinite(minX))
                    return '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"/>';
                const darkMode = darkRef.current;
                const s = settingsRef.current;
                const parts = [];
                parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX.toFixed(0)} ${minY.toFixed(0)} ${(maxX - minX).toFixed(0)} ${(maxY - minY).toFixed(0)}" width="${(maxX - minX).toFixed(0)}" height="${(maxY - minY).toFixed(0)}" style="background:${darkMode ? '#0a1025' : '#fafafa'}">`);
                // 背景网格(跟随「背景网格」开关,与画布一致)
                if (s.showGrid) {
                    parts.push(`<defs><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="${darkMode ? 'rgba(150,170,190,0.10)' : 'rgba(70,90,110,0.12)'}"/></pattern></defs>`);
                    parts.push(`<rect x="${minX.toFixed(0)}" y="${minY.toFixed(0)}" width="${(maxX - minX).toFixed(0)}" height="${(maxY - minY).toFixed(0)}" fill="url(#grid)"/>`);
                }
                // 节点模糊(跟随「节点模糊」开关:节点元素全部高斯模糊,连线保持清晰)
                if (s.blurNodes > 0) {
                    parts.push(`<filter id="nblur" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="${s.blurNodes}"/></filter>`);
                }
                // 社区晕影(与画布一致:每圈一枚柔光圆)
                for (const gl of glowRef.current) {
                    const col = communityColor(gl.c);
                    parts.push(`<defs><radialGradient id="glow${gl.c}"><stop offset="0%" stop-color="${col}" stop-opacity="${darkMode ? 0.5 : 0.38}"/><stop offset="100%" stop-color="${col}" stop-opacity="0"/></radialGradient></defs>`);
                    parts.push(`<circle cx="${gl.x.toFixed(1)}" cy="${gl.y.toFixed(1)}" r="${gl.r.toFixed(1)}" fill="url(#glow${gl.c})"/>`);
                }
                const wMax = Math.log10(6000);
                const svgNodeW = new Map();
                for (const gn of nd)
                    svgNodeW.set(gn.id, gn.weight);
                for (const e of es) {
                    const p1 = posOf(e.source);
                    const p2 = posOf(e.target);
                    // 弧形(与画布一致):哈希方向 + 22% 弯度,双向箭头用 marker 简化
                    const dx = p2.x - p1.x;
                    const dy = p2.y - p1.y;
                    const len = Math.sqrt(dx * dx + dy * dy);
                    if (len < 1e-3)
                        continue;
                    const sign = (edgeSeed(e.source, e.target) % 2 === 0) ? 1 : -1;
                    const bend = Math.max(28, len * 0.22) * sign;
                    const mx = (p1.x + p2.x) / 2 - (dy / len) * bend;
                    const my = (p1.y + p2.y) / 2 + (dx / len) * bend;
                    // 高亮状态渲染:亮蓝 + 2.1× 加粗 + 宽光晕(与画布悬停/选中一致)
                    const intimacy = e.kind === 'intimacy';
                    const strength = Math.log10(Math.max(1, e.weight)) / wMax;
                    const bw = intimacy
                        ? s.edgeWidth * (0.5 + strength * 1.8)
                        : s.edgeWidth * (0.4 + strength * 1.1);
                    const strokeW = Math.max(1.1 * s.edgeWidth / EDGE_WIDTH_DEFAULT, bw * 2.1);
                    const col = 'rgba(34,170,240,0.95)';
                    const path = `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
                    parts.push(`<path d="${path}" fill="none" stroke="rgba(34,170,240,0.18)" stroke-width="${(strokeW * 2.6).toFixed(1)}"/>`);
                    parts.push(`<path d="${path}" fill="none" stroke="${col}" stroke-width="${strokeW.toFixed(1)}"/>`);
                    // 单箭头(跟随「箭头」开关):从权重轻的一端指向重的一端,与画布一致
                    if (s.showArrows && len > 40) {
                        const r1 = 10;
                        const r2 = 10;
                        const u1x = mx - p1.x;
                        const u1y = my - p1.y;
                        const u2x = mx - p2.x;
                        const u2y = my - p2.y;
                        const l1u = Math.sqrt(u1x * u1x + u1y * u1y) || 1;
                        const l2u = Math.sqrt(u2x * u2x + u2y * u2y) || 1;
                        const sx = p1.x + (u1x / l1u) * r1;
                        const sy = p1.y + (u1y / l1u) * r1;
                        const ex = p2.x + (u2x / l2u) * r2;
                        const ey = p2.y + (u2y / l2u) * r2;
                        const size = Math.min(7, Math.max(3.5, strokeW * 2.2));
                        const towardTarget = (svgNodeW.get(e.target) ?? 0) > (svgNodeW.get(e.source) ?? 0);
                        const tipX = towardTarget ? sx : ex;
                        const tipY = towardTarget ? sy : ey;
                        const ux = towardTarget ? u1x / l1u : u2x / l2u;
                        const uy = towardTarget ? u1y / l1u : u2y / l2u;
                        parts.push(`<path d="M ${tipX.toFixed(1)} ${tipY.toFixed(1)} L ${(tipX - ux * size - uy * size * 0.5).toFixed(1)} ${(tipY - uy * size + ux * size * 0.5).toFixed(1)} M ${tipX.toFixed(1)} ${tipY.toFixed(1)} L ${(tipX - ux * size + uy * size * 0.5).toFixed(1)} ${(tipY - uy * size - ux * size * 0.5).toFixed(1)}" stroke="${col}" stroke-width="1.2" fill="none"/>`);
                    }
                }
                const labelOpacity = s.labelOpacity;
                const blurAttr = s.blurNodes > 0 ? ' filter="url(#nblur)"' : '';
                for (const g of nd) {
                    const p = posOf(g.id);
                    const isSelf = g.id === 'self';
                    const rr = radiusOf(g);
                    const cx = p.x.toFixed(1);
                    const cy = p.y.toFixed(1);
                    const commCol = g.community >= 0 ? communityColor(g.community) : (darkMode ? 'rgba(170,180,195,0.9)' : 'rgba(55,66,82,0.9)');
                    // 头像优先:有 data URL 的节点嵌入 image + 圆形剪裁(与画布一致)
                    const avatarUrl = avatarCache.get(isSelf ? 'self' : g.id);
                    const img = avatarUrl ? imgCacheRef.current.get(g.id) : undefined;
                    if (avatarUrl && img && img.complete && img.naturalWidth > 0) {
                        const clipId = `ava${g.id.replace(/[^a-zA-Z0-9]/g, '')}`;
                        parts.push(`<defs><clipPath id="${clipId}"><circle cx="${cx}" cy="${cy}" r="${rr.toFixed(1)}"/></clipPath></defs>`);
                        if (isSelf) {
                            // 「我」:白垫圈 + 头像 + 双蓝环(与画布一致)
                            parts.push(`<circle cx="${cx}" cy="${cy}" r="${(rr + 1.2).toFixed(1)}" fill="${darkMode ? 'rgba(232,236,244,0.92)' : 'rgba(255,255,255,0.92)'}"${blurAttr}/>`);
                            parts.push(`<image href="${avatarUrl}" x="${(p.x - rr).toFixed(1)}" y="${(p.y - rr).toFixed(1)}" width="${(rr * 2).toFixed(1)}" height="${(rr * 2).toFixed(1)}" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice"${blurAttr}/>`);
                            parts.push(`<circle cx="${cx}" cy="${cy}" r="${(rr * 1.08).toFixed(1)}" fill="none" stroke="rgba(34,170,240,0.85)" stroke-width="2"${blurAttr}/>`);
                            parts.push(`<circle cx="${cx}" cy="${cy}" r="${(rr * 1.26).toFixed(1)}" fill="none" stroke="rgba(34,170,240,0.22)" stroke-width="3.4"${blurAttr}/>`);
                        }
                        else {
                            parts.push(`<image href="${avatarUrl}" x="${(p.x - rr).toFixed(1)}" y="${(p.y - rr).toFixed(1)}" width="${(rr * 2).toFixed(1)}" height="${(rr * 2).toFixed(1)}" clip-path="url(#${clipId})" preserveAspectRatio="xMidYMid slice"${blurAttr}/>`);
                            // 社区色描边(头像节点也带圈子色,与画布一致)
                            parts.push(`<circle cx="${cx}" cy="${cy}" r="${(rr - 0.6).toFixed(1)}" fill="none" stroke="${commCol}" stroke-width="1.4"${blurAttr}/>`);
                        }
                    }
                    else if (isSelf) {
                        // 无头像「我」:白圆 + 「我」字 + 双环
                        parts.push(`<circle cx="${cx}" cy="${cy}" r="${(rr * 0.95).toFixed(1)}" fill="${darkMode ? '#e8ecf4' : '#1c2434'}"${blurAttr}/>`);
                        parts.push(`<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="${Math.max(10, rr * 0.85).toFixed(1)}" font-weight="700" fill="${darkMode ? '#1c2434' : '#f5f7fa'}"${blurAttr}>我</text>`);
                        parts.push(`<circle cx="${cx}" cy="${cy}" r="${(rr * 1.08).toFixed(1)}" fill="none" stroke="rgba(34,170,240,0.75)" stroke-width="1.6"${blurAttr}/>`);
                        parts.push(`<circle cx="${cx}" cy="${cy}" r="${(rr * 1.22).toFixed(1)}" fill="none" stroke="rgba(34,170,240,0.22)" stroke-width="3"${blurAttr}/>`);
                    }
                    else {
                        // 社区色圆 + 首字母(与画布一致)
                        parts.push(`<circle cx="${cx}" cy="${cy}" r="${(rr * 0.92).toFixed(1)}" fill="${commCol}"${blurAttr}/>`);
                        parts.push(`<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="${Math.max(8, rr * 0.8).toFixed(1)}" font-weight="700" fill="rgba(255,255,255,0.92)"${blurAttr}>${((g.label || '?').slice(0, 1)).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`);
                    }
                    // 固定徽标(白底蓝点,与画布一致)
                    if (pinnedRef.current.has(g.id)) {
                        const bx = p.x + rr * 0.9;
                        const by = p.y - rr * 0.9;
                        parts.push(`<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="5" fill="${darkMode ? '#24314a' : '#ffffff'}" stroke="rgba(34,170,240,0.95)" stroke-width="1.2"${blurAttr}/>`);
                        parts.push(`<circle cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="1.6" fill="#22aaf0"${blurAttr}/>`);
                    }
                    // 标签严格跟随「全部标签」开关:关闭时导出也不带任何标签(含「我」)
                    const showLabel = s.showLabels;
                    if (showLabel) {
                        const label = g.label.length > 16 ? g.label.slice(0, 16) + '…' : g.label;
                        parts.push(`<text x="${(p.x + rr + 6).toFixed(1)}" y="${cy}" dominant-baseline="middle" font-size="12" fill-opacity="${labelOpacity}" fill="${darkMode ? '#dfe6f0' : '#374151'}"${blurAttr}>${label.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</text>`);
                    }
                }
                parts.push('</svg>');
                return parts.join('\n');
            },
            /** 导出朋友圈海报:渲染图谱图层(自动取景,头像)+ 海报排版,返回 data URL。 */
            exportPng: async (ratio, style) => posterToDataUrl(renderPosterCanvas(ratio, style), 'png'),
            renderPoster: async (ratio, style, format = 'jpeg') => posterToDataUrl(renderPosterCanvas(ratio, style), format),
            centerOn: (id) => {
                const g = nodes().find(x => x.id === id);
                if (!g)
                    return;
                const p = posOf(id);
                const w = sizeRef.current.w;
                const h = sizeRef.current.h;
                if (w <= 0 || h <= 0)
                    return;
                const vw = viewRef.current.scale;
                animateView(w / 2 - p.x * vw, h / 2 - p.y * vw, vw, 420);
            },
        };
    }, []);
    useEffect(() => {
        // 预计算 LOD 排名与社区查表(绘制帧只读 ref)
        rankRef.current = rankNodes(graph);
        commOfRef.current = communityOf(graph);
        glowRef.current = [];
        // 出生顺序:「我」最先,其余按权重降序(最亲近的先出现)
        const order = [
            'self',
            ...graph.nodes
                .filter(n => n.id !== 'self')
                .sort((a, b) => b.weight - a.weight)
                .map(n => n.id),
        ];
        revealOrderRef.current = order;
        revealIdxRef.current = new Map(order.map((id, i) => [id, i]));
        // 图结构变化时若正在播放出生动画,直接完成(避免顺序越界)
        if (revealRef.current)
            revealRef.current.count = order.length;
        // 图数据/参数变化:首次布局;之后图身份(好友/群组模式)变化或力度参数变化时
        // 重新布局。深度过滤(localGraph 子图)不触发重排——只显示子集,保留原布局。
        if (sizeRef.current.w > 0 && !laidOutRef.current) {
            layoutDisc();
            laidOutRef.current = true;
        }
        stepRef.current = 0.002;
        const sorted = [...graph.nodes].sort((a, b) => b.weight - a.weight);
        start();
        // 首次进入:尺寸稳定后强制居中重排(消除任何历史视图偏移);参数变化时保留位置
        const firstFit = !fitDoneRef.current;
        if (firstFit)
            fitDoneRef.current = true;
        const fitTimer = window.setTimeout(() => { if (firstFit)
            fitView(); }, 300);
        // 头像预加载:全部节点一次批量读取(本机 head_image 为 129–140px 小图,
        // 250 个约 1–2MB;此前资源耗尽源于无限重拉循环,已修复)。
        // 缺失者走逐个补偿池(并发 4、失败重试 ≤3)。
        if (avatarMode === 'avatar') {
            const ids = selfUsername && selfUsername !== 'self'
                ? [selfUsername, ...sorted.map(n => n.id)]
                : sorted.map(n => n.id);
            const missing = [];
            void apiGetAvatarsLocal({ usernames: ids })
                .then((map) => {
                for (const [u, url] of Object.entries(map)) {
                    if (!avatarCache.has(u) && url)
                        avatarCache.set(u, url);
                    // 「我」的 wxid 命中 → 同步到 'self' key(绘制端按节点 id 查询)
                    if (u === selfUsername && url && !avatarCache.has('self'))
                        avatarCache.set('self', url);
                }
                scheduleDraw();
                for (const u of ids) {
                    if (!avatarCache.has(u) || avatarCache.get(u) === '')
                        missing.push(u);
                }
                startPool(missing);
            })
                .catch(() => {
                // 批量读取失败(资源紧张):延迟一次逐个补偿,不再无限重启池
                window.setTimeout(() => { startPool(ids); }, 2000);
            });
        }
        function startPool(poolIds) {
            let slot = 0;
            let done = 0;
            const pump = () => {
                while (slot < Math.min(4, poolIds.length)) {
                    const id = poolIds[slot];
                    slot += 1;
                    if (!id)
                        continue;
                    loadAvatar(id, () => {
                        // 「我」的 wxid 补偿命中 → 同步 'self'
                        if (id === selfUsername) {
                            const url = avatarCache.get(id);
                            if (url && !avatarCache.has('self'))
                                avatarCache.set('self', url);
                        }
                        done += 1;
                        if (done % 6 === 0)
                            scheduleDraw();
                        pump();
                    });
                }
            };
            pump();
        }
        return () => { window.clearTimeout(fitTimer); };
    }, [graph]);
    useEffect(() => {
        // 布局签名检查:模式/结构(经 graph 身份)与力度/间距/分离度参数变化都触发重排。
        // 此前本逻辑只依赖 [graph],而力度滑杆不重建 graph,导致「力度」下参数无效果。
        // 深度过滤(localGraph 子图)只显示子集,不参与签名。
        const mode = settingsRef.current.mode;
        const structSig = `${settingsRef.current.nodeLimit}|${settingsRef.current.minCommon}|${settingsRef.current.friendsOnly}`;
        const forceSig = [
            settingsRef.current.forceCentripetal,
            settingsRef.current.forceRepulsion,
            settingsRef.current.forceAttraction,
            settingsRef.current.forceEdgeLength,
            settingsRef.current.nodeGap,
            settingsRef.current.communitySeparation,
        ].map(v => v.toFixed(3)).join(',');
        const idSig = `mode=${mode}|struct=${structSig}|force=${forceSig}`;
        if (laidOutRef.current && layoutSigRef.current !== idSig && layoutSigRef.current !== '' && !settingsRef.current.lockLayout) {
            // 仅力度变化(模式/结构没变)→ 保留位置继续收敛;模式切换 → 全新布局;
            // 结构变化(阈值/上限)→ 也保留位置(新边自然聚团,而不是炸重来)
            const prevMode = (layoutSigRef.current.match(/^mode=([^|]+)/)?.[1]) ?? '';
            const isFresh = prevMode !== mode;
            layoutDisc(!isFresh);
        }
        layoutSigRef.current = idSig;
    }, [graph, settings.forceCentripetal, settings.forceRepulsion, settings.forceAttraction,
        settings.forceEdgeLength, settings.nodeGap, settings.communitySeparation]);
    useEffect(() => {
        // 外观/选择/固定/圈子聚焦参数变化:图身份未变,仅重绘一帧
        // (结构参数走 [graph] 效果里的重布局路径)
        scheduleDraw();
    }, [settings, selectedId, pinnedIds, focusCommunity, hoverCommunity, dark]);
    useEffect(() => {
        ensureSize();
        const timer = window.setInterval(() => { ensureSize(); }, 600);
        const ob = new ResizeObserver(() => { ensureSize(); });
        if (wrapRef.current)
            ob.observe(wrapRef.current);
        start();
        return () => {
            stop();
            if (layoutRafRef.current)
                cancelAnimationFrame(layoutRafRef.current);
            layoutRafRef.current = 0;
            simStateRef.current = null;
            if (settleRafRef.current)
                cancelAnimationFrame(settleRafRef.current);
            settleRafRef.current = 0;
            settleRef.current = null;
            ob.disconnect();
            window.clearInterval(timer);
        };
    }, []);
    const toRect = (ev) => {
        const rect = canvasRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
        return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
    };
    const nodeAt = (pt) => {
        // 屏幕 → 世界坐标(视图变换)
        const v = viewRef.current;
        const wx = (pt.x - v.dx) / v.scale;
        const wy = (pt.y - v.dy) / v.scale;
        const nd = nodes();
        for (let i = nd.length - 1; i >= 0; i--) {
            const g = nd[i];
            if (!g)
                continue;
            if (!isRevealed(g.id))
                continue;
            const p = posForDraw(g.id);
            const dx = p.x - wx;
            const dy = p.y - wy;
            if (dx * dx + dy * dy <= (radiusOf(g) + 6) * (radiusOf(g) + 6))
                return g;
        }
        return null;
    };
    /** 悬停边探测:指针附近(屏幕 7px 内)的边,取最近的一条。 */
    const edgeAt = (pt) => {
        const v = viewRef.current;
        const wx = (pt.x - v.dx) / v.scale;
        const wy = (pt.y - v.dy) / v.scale;
        const thr = 7 / v.scale;
        let best = null;
        let bestD = thr;
        for (const e of graphRef.current.edges) {
            if (!isRevealed(e.source) || !isRevealed(e.target))
                continue;
            const p1 = posForDraw(e.source);
            const p2 = posForDraw(e.target);
            const d = distToSegment({ x: wx, y: wy }, p1, p2);
            if (d < bestD) {
                bestD = d;
                best = { source: e.source, target: e.target, weight: e.weight, kind: e.kind };
            }
        }
        return best;
    };
    const onPointerDown = (ev) => {
        // 只响应主键:右键交给菜单,中键不触发拖拽/平移(避免动作互相打架)
        if (ev.button !== 0)
            return;
        const pt = toRect(ev);
        movedRef.current = 0;
        cancelCam();
        // 交互打断出生动画:直接完成全部出现,进入正常操作
        completeReveal();
        // 拖拽/平移开始:清掉旧悬停状态与 tooltip,避免残留高亮和悬浮框干扰
        hoverRef.current = null;
        setHoverInfo(null);
        hideTip();
        hoverEdgeRef.current = null;
        setHoverEdgeInfo(null);
        hideEdgeTip();
        const g = nodeAt(pt);
        try {
            ;
            ev.target.setPointerCapture(ev.pointerId);
        }
        catch { /* pointer 已释放 */ }
        if (g) {
            // 「我」按下即选中,并与普通节点一样进入拖拽(松开后世界自动以它为中心重排)
            if (g.id === 'self')
                onSelect(g.id);
            // 布局动画中抓取:轻量冻结(写回位置,不硬分离/不 fitView),避免整图跳变
            if (simStateRef.current)
                freezeLayout();
            // 取消上一次的邻居回稳动画
            if (settleRafRef.current)
                cancelAnimationFrame(settleRafRef.current);
            settleRafRef.current = 0;
            settleRef.current = null;
            dragRef.current = { id: g.id, ldx: 0, ldy: 0 };
            phaseRef.current = 'drag';
            // 拖拽期间低分辨率重绘(每帧全量绘制,1×CSS 比 2× 快 4 倍)
            setRes(false);
            if (canvasRef.current)
                canvasRef.current.style.cursor = 'grabbing';
        }
        else {
            // 空白处:开始平移画布
            panRef.current = { px: pt.x, py: pt.y, vdx: viewRef.current.dx, vdy: viewRef.current.dy };
            phaseRef.current = 'pan';
            setRes(false);
            if (canvasRef.current)
                canvasRef.current.style.cursor = 'grabbing';
        }
    };
    const onDoubleClick = (ev) => {
        const pt = toRect(ev);
        const g = nodeAt(pt);
        const vw = sizeRef.current.w;
        if (g) {
            // 双击节点:放大并居中(细节查看)
            const p = posOf(g.id);
            const ns = Math.min(4, viewRef.current.scale * 1.5);
            animateView(vw / 2 - p.x * ns, sizeRef.current.h / 2 - p.y * ns, ns, 300);
        }
        else if (vw > 0) {
            // 双击空白:适应整图
            const t = fitTarget();
            animateView(t.dx, t.dy, t.scale, 300);
        }
    };
    const onPointerMove = (ev) => {
        const pt = toRect(ev);
        if (phaseRef.current === 'drag' && dragRef.current) {
            // Obsidian 式拖拽:节点跟手(世界坐标),视图只在拖到边缘时自动滚动,
            // 不缩放、不自动适应;周边节点只做局部让位,不动全图。
            movedRef.current += Math.abs(ev.movementX) + Math.abs(ev.movementY);
            const v = viewRef.current;
            const d = dragRef.current;
            const p = posOf(d.id);
            const nx = (pt.x - v.dx) / v.scale;
            const ny = (pt.y - v.dy) / v.scale;
            // 边缘自动滚动:指针靠近画布边缘时视图平移,被拖节点继续可拖
            // 平方根缓动:浅区慢起步、贴边明显加速,拖拽越界不突兀
            const EDGE = 46;
            const size = sizeRef.current;
            if (size.w > 0) {
                let sdx = 0;
                let sdy = 0;
                const ease = (t) => Math.sqrt(Math.min(1, Math.max(0, t)));
                if (pt.x < EDGE)
                    sdx = -ease((EDGE - pt.x) / EDGE) * 17 / v.scale;
                else if (pt.x > size.w - EDGE)
                    sdx = ease((pt.x - (size.w - EDGE)) / EDGE) * 17 / v.scale;
                if (pt.y < EDGE)
                    sdy = -ease((EDGE - pt.y) / EDGE) * 17 / v.scale;
                else if (pt.y > size.h - EDGE)
                    sdy = ease((pt.y - (size.h - EDGE)) / EDGE) * 17 / v.scale;
                if (sdx !== 0 || sdy !== 0) {
                    v.dx += sdx * v.scale;
                    v.dy += sdy * v.scale;
                }
            }
            // 本帧位置:被拖节点跟手(无 clamp);同帧位移传给一跳邻居实时跟随
            const delta = { x: nx - p.x, y: ny - p.y };
            d.ldx = delta.x;
            d.ldy = delta.y;
            p.x = nx;
            p.y = ny;
            if (settingsRef.current.lockLayout) {
                // 锁定布局:只移动被拖节点,不带动邻居、不做局部让位(布局冻结)
                pushAwayFromSelf(d.id);
            }
            else if (d.id === 'self') {
                // 拖「我」= 整图刚性平移:除「我」外所有节点同位移,保持彼此相对位置
                // (「我」已在本帧开头跟到光标,不能再加一次 delta,否则会与整体错位)
                // (不走橡皮筋联动,否则周围节点会被拖拢后再回稳重排)
                for (const g of nodes()) {
                    if (g.id === 'self')
                        continue;
                    const q = posOf(g.id);
                    q.x += delta.x;
                    q.y += delta.y;
                }
            }
            else {
                dragPull(delta);
                resolveOverlapsNear(d.id);
            }
            scheduleDraw();
            return;
        }
        if (phaseRef.current === 'pan' && panRef.current) {
            const pan = panRef.current;
            viewRef.current.dx = pan.vdx + (pt.x - pan.px);
            viewRef.current.dy = pan.vdy + (pt.y - pan.py);
            scheduleDraw();
            return;
        }
        const g = nodeAt(pt);
        const prev = hoverRef.current;
        // 边悬停:无节点命中时探测附近连线(悬停边高亮 + 详情)。
        // 仅当边的身份变化时 setState(同边移动只直写 tooltip DOM,零重渲染)。
        const prevEdge = hoverEdgeRef.current;
        const edge = g ? null : edgeAt(pt);
        hoverEdgeRef.current = edge;
        if (edge && !hoverInfo) {
            if (!prevEdge || prevEdge.source !== edge.source || prevEdge.target !== edge.target || prevEdge.kind !== edge.kind) {
                setHoverEdgeInfo(edge);
            }
            moveEdgeTip(pt.x, pt.y);
        }
        else if (hoverEdgeInfo) {
            setHoverEdgeInfo(null);
            hideEdgeTip();
        }
        hoverRef.current = g ? g.id : null;
        if (prev !== hoverRef.current) {
            // 悬停线移动时低分辨率,停留 350ms 后恢复高清
            setRes(false);
            scheduleHi();
            scheduleDraw();
            if (g) {
                // 悬停即时加载头像(应对未预载的外围节点)
                if (avatarMode === 'avatar')
                    loadAvatar(g.id, () => { scheduleDraw(); });
                setHoverInfo({
                    name: g.label,
                    id: g.id,
                    weight: g.intimacy ?? g.weight,
                    kind: kindLabelOf(g),
                    community: g.community,
                });
                moveTip(pt.x, pt.y);
            }
            else {
                setHoverInfo(null);
                hideTip();
            }
        }
        else if (g && hoverInfo) {
            // 悬停中:tooltip 跟随鼠标(不移入拖拽/平移阶段)— DOM 直写,零重渲染
            moveTip(pt.x, pt.y);
        }
    };
    /** tooltip 位置直写(DOM ref,不触发 React 渲染)。 */
    const moveTip = (x, y) => {
        const el = tipRef.current;
        if (!el)
            return;
        const maxX = (wrapRef.current?.clientWidth ?? 800) - 230;
        const maxY = (wrapRef.current?.clientHeight ?? 600) - 90;
        const tx = Math.min(x + 16, Math.max(8, maxX));
        const ty = Math.min(y + 14, Math.max(8, maxY));
        el.style.transform = `translate(${tx}px, ${ty}px)`;
    };
    const hideTip = () => {
        const el = tipRef.current;
        if (el)
            el.style.transform = 'translate(-9999px, -9999px)';
    };
    /** 边详情 tooltip 位置直写(与节点 tooltip 同款 DOM 操作)。 */
    const moveEdgeTip = (x, y) => {
        const el = edgeTipRef.current;
        if (!el)
            return;
        const maxX = (wrapRef.current?.clientWidth ?? 800) - 230;
        const maxY = (wrapRef.current?.clientHeight ?? 600) - 70;
        const tx = Math.min(x + 14, Math.max(8, maxX));
        const ty = Math.min(y + 26, Math.max(8, maxY));
        el.style.transform = `translate(${tx}px, ${ty}px)`;
    };
    const hideEdgeTip = () => {
        const el = edgeTipRef.current;
        if (el)
            el.style.transform = 'translate(-9999px, -9999px)';
    };
    const onPointerUp = (ev) => {
        if (phaseRef.current === 'drag') {
            phaseRef.current = 'idle';
            const id = dragRef.current?.id;
            if (id && movedRef.current < 4) {
                // 点击(未移动):选中,并让节点进入视野(视口外则居中)
                onSelect(id);
                const v = viewRef.current;
                const p2 = posOf(id);
                const vw = sizeRef.current.w;
                const vh = sizeRef.current.h;
                if (vw > 0) {
                    const sx = (p2.x - v.dx) * v.scale;
                    const sy = (p2.y - v.dy) * v.scale;
                    if (sx < 20 || sx > vw - 20 || sy < 20 || sy > vh - 20) {
                        v.dx = vw / 2 - p2.x * v.scale;
                        v.dy = vh / 2 - p2.y * v.scale;
                        scheduleDraw();
                    }
                }
                if (settleRafRef.current)
                    cancelAnimationFrame(settleRafRef.current);
                settleRafRef.current = 0;
                settleRef.current = null;
            }
            else {
                // 拖拽:启动邻居回稳(弹簧落位 + 惯性滑行,56 帧内自然静止),被拖节点保持新位置;
                // 先刷新一次世界(被拖节点在任意位置都合法),回稳结束后再刷
                // 拖「我」是整图刚性平移,相对位置不变,无需回稳
                if (!settingsRef.current.lockLayout && dragRef.current?.id !== 'self')
                    startSettle();
                refreshWorld();
            }
            scheduleHi();
            scheduleDraw();
        }
        else if (phaseRef.current === 'pan') {
            phaseRef.current = 'idle';
            // 空白处点击(未移动):清除选中(Obsidian 语义)
            if (movedRef.current < 4)
                onSelect(null);
            scheduleHi();
        }
        dragRef.current = null;
        panRef.current = null;
        if (canvasRef.current)
            canvasRef.current.style.cursor = 'grab';
        try {
            ;
            ev.target.releasePointerCapture(ev.pointerId);
        }
        catch { /* 未捕获或已释放 */ }
    };
    /** 滚轮缩放:以光标位置为中心(ZOOM_MIN–ZOOM_MAX);交互期低分辨率,静止恢复高清。 */
    const onWheel = (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        // 拖拽/平移期间忽略缩放:视口变化会让被拖节点按新视图换算而跳变
        if (phaseRef.current !== 'idle')
            return;
        cancelCam();
        const rect = canvasRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
        const px = ev.clientX - rect.left;
        const py = ev.clientY - rect.top;
        const v = viewRef.current;
        const factor = Math.exp(-ev.deltaY * 0.0016);
        const ns = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.scale * factor));
        const wx = (px - v.dx) / v.scale;
        const wy = (py - v.dy) / v.scale;
        v.dx = px - wx * ns;
        v.dy = py - wy * ns;
        v.scale = ns;
        ev.stopPropagation();
        setRes(false);
        scheduleDraw();
        scheduleHi();
    };
    /** 最新滚轮处理引用(原生非被动监听用,避免每次渲染重挂载)。 */
    const onWheelRef = useRef(null);
    onWheelRef.current = onWheel;
    /** 右键菜单:节点菜单(定位/聚焦/固定/聊天)或空白菜单(适应/清除选中)。 */
    const onContextMenu = (ev) => {
        ev.preventDefault();
        // 拖拽/平移进行中不弹菜单(避免与拖动动作打架)
        if (phaseRef.current !== 'idle')
            return;
        cancelCam();
        const pt = toRect(ev);
        const g = nodeAt(pt);
        setMenu({ x: pt.x, y: pt.y, nodeId: g ? g.id : null });
    };
    /** 菜单项执行并关闭。 */
    const menuDo = (fn) => {
        setMenu(null);
        fn();
    };
    useEffect(() => {
        const onKey = (e) => {
            const tag = e.target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA')
                return;
            if (e.key === 'Escape') {
                if (menu) {
                    setMenu(null);
                    return;
                }
                onSelect(null);
            }
            else if (e.key === '+' || e.key === '=')
                zoomBy(1.25);
            else if (e.key === '-')
                zoomBy(0.8);
            else if (e.key === '0' || e.key === 'f' || e.key === 'F') {
                const t = fitTarget();
                if (sizeRef.current.w > 0)
                    animateView(t.dx, t.dy, t.scale);
            }
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                const step = e.shiftKey ? 220 : 90;
                const v = viewRef.current;
                if (e.key === 'ArrowLeft')
                    v.dx += step;
                else if (e.key === 'ArrowRight')
                    v.dx -= step;
                else if (e.key === 'ArrowUp')
                    v.dy += step;
                else
                    v.dy -= step;
                scheduleDraw();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => { window.removeEventListener('keydown', onKey); };
    }, [onSelect, menu]);
    // 右键菜单:点击菜单外任意位置关闭
    useEffect(() => {
        if (!menu)
            return;
        const close = () => { setMenu(null); };
        window.addEventListener('pointerdown', close);
        return () => { window.removeEventListener('pointerdown', close); };
    }, [menu]);
    // 滚轮缩放走原生非被动监听:React 根节点的 wheel 是 passive,
    // 在合成事件里 preventDefault 会触发控制台告警
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas)
            return;
        const onNativeWheel = (ev) => {
            ev.preventDefault();
            onWheelRef.current?.(ev);
        };
        canvas.addEventListener('wheel', onNativeWheel, { passive: false });
        return () => { canvas.removeEventListener('wheel', onNativeWheel); };
    }, []);
    // 键盘缩放辅助:以画布中心为目标(带相机缓动)
    const zoomBy = (factor) => {
        const v = viewRef.current;
        const w = sizeRef.current.w;
        const h = sizeRef.current.h;
        if (w <= 0)
            return;
        const px = w / 2;
        const py = h / 2;
        const ns = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.scale * factor));
        const wx = (px - v.dx) / v.scale;
        const wy = (py - v.dy) / v.scale;
        animateView(px - wx * ns, py - wy * ns, ns, 260);
    };
    /** 小地图按下:开始擦洗并立即跳转(仅主键)。 */
    const onMiniDown = (ev) => {
        if (ev.button !== 0)
            return;
        miniScrubRef.current = true;
        miniCenter(ev);
        ev.target.setPointerCapture(ev.pointerId);
    };
    const onMiniUp = (ev) => {
        miniScrubRef.current = false;
        ev.target.releasePointerCapture(ev.pointerId);
    };
    /** 节点 id → 显示名(菜单/tooltip 用)。 */
    const labelOf = (id) => graphRef.current.nodes.find(n => n.id === id)?.label ?? id;
    const menuNode = menu?.nodeId ? graphRef.current.nodes.find(n => n.id === menu.nodeId) : undefined;
    const menuPinned = menuNode ? pinnedRef.current.has(menuNode.id) : false;
    const menuX = Math.min(menu?.x ?? 0, Math.max(0, (wrapRef.current?.clientWidth ?? 800) - 188));
    const menuY = Math.min(menu?.y ?? 0, Math.max(0, (wrapRef.current?.clientHeight ?? 600) - (menuNode ? 240 : 96)));
    return (_jsxs("div", { ref: wrapRef, style: { position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', borderRadius: 12 }, children: [_jsx("canvas", { ref: canvasRef, style: { display: 'block', width: '100%', height: '100%', cursor: 'grab', touchAction: 'none' }, onPointerDown: onPointerDown, onPointerMove: onPointerMove, onPointerUp: onPointerUp, onDoubleClick: onDoubleClick, onContextMenu: onContextMenu, onPointerLeave: () => {
                    hoverRef.current = null;
                    setHoverInfo(null);
                    hoverEdgeRef.current = null;
                    setHoverEdgeInfo(null);
                    if (canvasRef.current)
                        canvasRef.current.style.cursor = 'grab';
                    scheduleDraw();
                } }), _jsxs("div", { style: { position: 'absolute', top: 10, left: 12, pointerEvents: 'none', fontSize: 11, color: 'rgba(128,138,156,0.9)', fontFamily: 'var(--nm-font-mono, monospace)' }, children: [graph.nodes.length, " \u8282\u70B9 \u00B7 ", graph.edges.length, " \u8FDE\u7EBF \u00B7 \u70B9\u51FB\u9009\u4E2D / \u62D6\u62FD\u8282\u70B9 / \u6EDA\u8F6E\u7F29\u653E / \u53CC\u51FB\u805A\u7126 \u00B7 \u53F3\u952E\u66F4\u591A \u00B7 0 \u9002\u5E94"] }), _jsxs("div", { className: css.zoomCtl, role: "group", "aria-label": "\u7F29\u653E\u63A7\u5236", children: [_jsx("button", { type: "button", className: css.zoomBtn, "aria-label": "\u653E\u5927", title: "\u653E\u5927 (+)", onClick: () => { zoomBy(1.3); }, children: "+" }), _jsx("button", { type: "button", className: css.zoomBtn, "aria-label": "\u7F29\u5C0F", title: "\u7F29\u5C0F (\u2212)", onClick: () => { zoomBy(1 / 1.3); }, children: "\u2212" }), _jsx("button", { type: "button", className: css.zoomBtn, "aria-label": "\u9002\u5E94\u89C6\u56FE", title: "\u9002\u5E94\u89C6\u56FE (0)", onClick: () => { const t = fitTarget(); if (sizeRef.current.w > 0)
                            animateView(t.dx, t.dy, t.scale); }, children: "\u2922" })] }), _jsx("canvas", { ref: miniRef, className: css.minimap, "aria-label": "\u56FE\u8C31\u5C0F\u5730\u56FE", onContextMenu: (ev) => { ev.preventDefault(); }, onPointerDown: onMiniDown, onPointerMove: (ev) => { if (miniScrubRef.current)
                    miniCenter(ev); }, onPointerUp: onMiniUp }), menu && (_jsx("div", { className: css.ctxMenu, style: { left: menuX, top: menuY }, onPointerDown: (ev) => { ev.stopPropagation(); }, onContextMenu: (ev) => { ev.preventDefault(); }, children: menuNode ? (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: css.ctxItem, onClick: () => { menuDo(() => { onSelect(menuNode.id); const p = posOf(menuNode.id); const vw = sizeRef.current.w; if (vw > 0)
                                animateView(vw / 2 - p.x * viewRef.current.scale, sizeRef.current.h / 2 - p.y * viewRef.current.scale, viewRef.current.scale, 420); }); }, children: "\u5B9A\u4F4D\u5230\u5C4F\u5E55\u4E2D\u592E" }), _jsx("button", { type: "button", className: css.ctxItem, onClick: () => { menuDo(() => { onFocusNode?.(menuNode.id); }); }, children: "\u805A\u7126\u5468\u56F4 1 \u8DF3" }), menuNode.id !== 'self' && (_jsx("button", { type: "button", className: css.ctxItem, onClick: () => { menuDo(() => { onTogglePin?.(menuNode.id); }); }, children: menuPinned ? '取消固定 📌' : '固定位置 📌' })), onOpenChat && (_jsx("button", { type: "button", className: css.ctxItem, onClick: () => { menuDo(() => { onOpenChat(menuNode.id); }); }, children: "\u67E5\u770B\u804A\u5929\u8BB0\u5F55" })), _jsx("button", { type: "button", className: css.ctxItem, onClick: () => { menuDo(() => { onSelect(menuNode.id); }); }, children: "\u4EC5\u9009\u4E2D" }), _jsx("button", { type: "button", className: css.ctxItem, "data-danger": true, onClick: () => { menuDo(() => { onSelect(null); }); }, children: "\u6E05\u9664\u9009\u4E2D" })] })) : (_jsxs(_Fragment, { children: [_jsx("button", { type: "button", className: css.ctxItem, onClick: () => { menuDo(() => { const t = fitTarget(); if (sizeRef.current.w > 0)
                                animateView(t.dx, t.dy, t.scale); }); }, children: "\u9002\u5E94\u6574\u56FE" }), _jsx("button", { type: "button", className: css.ctxItem, onClick: () => { menuDo(() => { onSelect(null); }); }, children: "\u6E05\u9664\u9009\u4E2D" })] })) })), hoverInfo && (_jsxs("div", { ref: tipRef, style: {
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    transform: 'translate(-9999px, -9999px)',
                    pointerEvents: 'none',
                    padding: '6px 10px',
                    borderRadius: 10,
                    background: 'rgba(20,26,38,0.88)',
                    border: '1px solid rgba(34,170,240,0.25)',
                    color: '#e6ebf2',
                    fontSize: 12,
                    fontFamily: 'var(--nm-font-mono, monospace)',
                    backdropFilter: 'blur(6px)',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
                }, children: [_jsx("div", { style: { fontWeight: 700, marginBottom: 2 }, children: hoverInfo.name }), _jsxs("div", { style: { color: 'rgba(200,210,225,0.8)' }, children: [hoverInfo.kind, " \u00B7 \u6D88\u606F\u91CF ", hoverInfo.weight] }), hoverInfo.community >= 0 && (_jsxs("div", { style: { display: 'flex', gap: 5, alignItems: 'center', color: 'rgba(200,210,225,0.8)' }, children: [_jsx("i", { style: { width: 8, height: 8, borderRadius: 8, background: communityColor(hoverInfo.community), display: 'inline-block' } }), "\u793E\u533A #", hoverInfo.community + 1] })), _jsx("div", { style: { color: 'rgba(140,150,170,0.6)', fontSize: 10 }, children: hoverInfo.id })] })), hoverEdgeInfo && (_jsxs("div", { ref: edgeTipRef, style: {
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    transform: 'translate(-9999px, -9999px)',
                    pointerEvents: 'none',
                    padding: '5px 9px',
                    borderRadius: 9,
                    background: 'rgba(20,26,38,0.88)',
                    border: '1px solid rgba(34,170,240,0.22)',
                    color: '#dfe6f0',
                    fontSize: 11.5,
                    fontFamily: 'var(--nm-font-mono, monospace)',
                    backdropFilter: 'blur(6px)',
                    boxShadow: '0 4px 16px rgba(0,0,0,0.35)',
                }, children: [_jsx("span", { style: { fontWeight: 600 }, children: labelOf(hoverEdgeInfo.source) }), _jsx("span", { style: { color: 'rgba(160,172,190,0.8)', margin: '0 5px' }, children: "\u2194" }), _jsx("span", { style: { fontWeight: 600 }, children: labelOf(hoverEdgeInfo.target) }), _jsx("div", { style: { color: 'rgba(200,210,225,0.75)', marginTop: 2 }, children: hoverEdgeInfo.kind === 'intimacy' ? `你↔对方 · 亲密度 ${hoverEdgeInfo.weight}` : `共同群 ${hoverEdgeInfo.weight} 个` })] }))] }));
});
//# sourceMappingURL=graph-canvas.js.map