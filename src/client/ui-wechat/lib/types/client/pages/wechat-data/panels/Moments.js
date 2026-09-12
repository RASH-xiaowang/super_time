import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 朋友圈面板 — React 版，忠实迁移 WeChatPanel 的 moments 页签：工具栏
 * （搜索/刷新/导出）、洞察统计、按日期分组的时间线卡片（文本/媒体/位置/
 * 链接/点赞/评论）。数据经 DSH 后端 Remote（sns.db content XML 解析），
 * 无 HTTP 依赖。
 *
 * Enhancements over the legacy panel:
 * - media-type filter chips + expanded search scope (likes/comments/公众号名/URL)
 * - likes count badge + expandable list, comments with time, reply quote, expand
 * - long-text expand/collapse
 * - lightbox zoom/pan, keyboard nav, per-image save, failure placeholder, thumbs
 * - inline video playback via the offline cached container (base64 data URL)
 * - single pagination control (infinite scroll + "load all")
 */
import { Fragment, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ListSentinel, ListSkeleton, useProgressiveList } from "./hooks.js";
import { readRenderCache, writeRenderCache } from "../api.js";
import { useWechatDataUpdated } from "./hooks.js";
import { apiDecryptAllDatabases, apiExportMoments, apiGetArticleCover, apiGetAvatar, apiGetMoments, apiGetMomentsAuthors, apiGetMomentsMonthly, apiGetSelfUsername, apiGetSnsImageDataUrl, apiGetSnsVideoCoverDataUrl, apiGetSnsVideoDataUrl, apiOpenPath, pickDirectory, snsMediaCacheGet, snsMediaCacheGetMany, snsMediaCacheSet } from "../api.js";
import { PanelHeader, SearchInput, Segmented } from "../ui/kit.js";
import css from './moments.module.css';
const avatarCache = new Map();
const MEDIA_LABELS = {
    all: '全部',
    image: '图片',
    video: '视频',
    link: '链接',
    location: '位置',
    text: '纯文字',
};
/** Stable cache key for one SNS image (md5 first, timelineId+mediaId fallback). */
function imgKey(im) {
    if (im.md5)
        return im.md5;
    if (im.timelineId && im.id)
        return im.timelineId + ':' + im.id;
    return '';
}
/** Compact relative label for a comment timestamp (tz-safe wall clock). */
function fmtCommentTime(ts) {
    if (!ts)
        return '';
    const diff = Date.now() - ts * 1000;
    if (diff < 60000)
        return '刚刚';
    if (diff < 3600000)
        return `${Math.floor(diff / 60000)}分钟前`;
    if (diff < 86400000)
        return `${Math.floor(diff / 3600000)}小时前`;
    if (diff < 172800000)
        return '昨天';
    const d = new Date(ts * 1000);
    return `${d.getMonth() + 1}-${d.getDate()}`;
}
/** Format a timestamp as HH:MM for the sync status label. */
function fmtSyncTime(ts) {
    if (!ts)
        return '';
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
/** Find the original comment a reply targets within the same card (best effort). */
function replyTarget(m, c) {
    if (!c.to_username || c.to_username === m.username)
        return undefined;
    for (const other of m.comments) {
        if (other.username === c.to_username && other.content)
            return other;
    }
    return undefined;
}
/** 朋友圈作者头像：本地 head_image 优先，失败回退首字色块。 */
function MomentsAvatar({ username, name }) {
    const [src, setSrc] = useState(avatarCache.get(username) ?? null);
    useEffect(() => {
        if (src !== null)
            return;
        let cancelled = false;
        const opts = { username };
        if (name)
            opts.nickname = name;
        apiGetAvatar(opts)
            .then((r) => {
            const v = r.kind === 'data' ? (r.data ?? null) : (r.kind === 'url' ? (r.url ?? null) : null);
            avatarCache.set(username, v ?? '');
            if (!cancelled)
                setSrc(v);
        })
            .catch(() => {
            avatarCache.set(username, '');
            if (!cancelled)
                setSrc(null);
        });
        return () => { cancelled = true; };
    }, [username, name, src]);
    if (src)
        return _jsx("img", { src: src, alt: "", className: css.avatarImg, loading: "lazy", referrerPolicy: "no-referrer" });
    return _jsx("div", { className: css.avatar, children: (name || '?').slice(0, 1).toUpperCase() });
}
/** 16px mini avatar for likes/comments (缓存与 40px 大头像共享，避免重复请求)。 */
function MomentsMiniAvatar({ username, name }) {
    const [src, setSrc] = useState(avatarCache.get(username) ?? null);
    useEffect(() => {
        if (src !== null)
            return;
        let cancelled = false;
        apiGetAvatar({ username, nickname: name }).then((r) => {
            const v = r.kind === 'data' ? (r.data ?? null) : (r.kind === 'url' ? (r.url ?? null) : null);
            avatarCache.set(username, v ?? '');
            if (!cancelled)
                setSrc(v);
        }).catch(() => { avatarCache.set(username, ''); if (!cancelled)
            setSrc(null); });
        return () => { cancelled = true; };
    }, [username, name, src]);
    if (src)
        return _jsx("img", { src: src, alt: "", className: css.miniAvatar, loading: "lazy", referrerPolicy: "no-referrer" });
    return _jsx("span", { className: css.miniAvatarFallback, children: (name || '?').slice(0, 1).toUpperCase() });
}
/** 按日期分组（YYYY-MM-DD），组内保持原有顺序。 */
function groupByDate(moments) {
    const map = new Map();
    for (const m of moments) {
        const d = m.ts ? new Date(m.ts * 1000) : null;
        const key = d && !isNaN(d.getTime()) ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '未知日期';
        const arr = map.get(key) ?? [];
        arr.push(m);
        map.set(key, arr);
    }
    return Array.from(map.entries()).map(([day, items]) => ({ day, items }));
}
/**
 * Render the moments (朋友圈) panel.
 * @param props - optional author filter (from contact profile "TA 的朋友圈")
 *   and a callback to clear it.
 * @returns the moments element tree.
 */
export function MomentsPanel({ author, onClearAuthor }) {
    const [moments, setMoments] = useState([]);
    const [search, setSearch] = useState('');
    const deferredSearch = useDeferredValue(search);
    const [mediaFilter, setMediaFilter] = useState('all');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [total, setTotal] = useState(0);
    const [monthlyData, setMonthlyData] = useState([]);
    const [privacy, setPrivacy] = useState(false);
    const [expandedTextByCard, setExpandedTextByCard] = useState(new Set());
    const [expandedSocialByCard, setExpandedSocialByCard] = useState(new Set());
    const [commentCounts, setCommentCounts] = useState({});
    const [commentSortByCard, setCommentSortByCard] = useState({});
    const [selfUsername, setSelfUsername] = useState(null);
    const [fullAuthors, setFullAuthors] = useState(null);
    const [monthlyDataForAuthor, setMonthlyDataForAuthor] = useState([]);
    const [onlyMineComments, setOnlyMineComments] = useState(false);
    const [videoSrcs, setVideoSrcs] = useState({});
    const [videoFailed, setVideoFailed] = useState(new Set());
    const videoFetching = useRef(new Set());
    const [monthFilter, setMonthFilter] = useState(null);
    const [mineFilter, setMineFilter] = useState('all');
    const [authorFilter, setAuthorFilter] = useState(null);
    const [showAllAuthors, setShowAllAuthors] = useState(false);
    const [sortOrder, setSortOrder] = useState('desc');
    const [dateFrom, setDateFrom] = useState('');
    const [dateTo, setDateTo] = useState('');
    const [detail, setDetail] = useState(null);
    const [viewer, setViewer] = useState(null);
    const [viewZoom, setViewZoom] = useState(1);
    const [viewPan, setViewPan] = useState({ x: 0, y: 0 });
    const [viewFailed, setViewFailed] = useState(false);
    const [viewRotate, setViewRotate] = useState(0);
    const [viewOriginal, setViewOriginal] = useState(false);
    const dragRef = useRef(null);
    const pinchRef = useRef(null);
    const lightboxWrapRef = useRef(null);
    const viewZoomRef = useRef(1);
    const [exportOpen, setExportOpen] = useState(false);
    const [expFormat, setExpFormat] = useState('html');
    const [expFrom, setExpFrom] = useState('');
    const [expTo, setExpTo] = useState('');
    const [expDir, setExpDir] = useState('');
    const [expImages, setExpImages] = useState(false);
    const [expZip, setExpZip] = useState(false);
    const [syncing, setSyncing] = useState(false);
    const [lastSync, setLastSync] = useState(0);
    const [pickingDir, setPickingDir] = useState(false);
    const [exporting, setExporting] = useState(false);
    const [notice, setNotice] = useState(null);
    const [exportedPath, setExportedPath] = useState(null);
    const [snsImgs, setSnsImgs] = useState({});
    const snsFetched = useRef(new Set());
    const [articleCovers, setArticleCovers] = useState({});
    const coverAttempts = useRef(new Map());
    const [coverTick, setCoverTick] = useState(0);
    const [failedImgs, setFailedImgs] = useState(new Set());
    const countRef = useRef(0);
    const totalRef = useRef(0);
    const [loadingAll, setLoadingAll] = useState(false);
    const load = useCallback(async (reset = true) => {
        setError(null);
        // 渲染缓存按“全量/该作者”上下文分开存储，避免刷新后串用上次过滤视图的缓存。
        const cacheKey = 'moments:' + (author || 'all');
        if (reset) {
            // 先用上次渲染的列表秒开,后台同步最新分页
            const cached = readRenderCache(cacheKey);
            if (cached && cached.length > 0) {
                setMoments(cached);
                countRef.current = cached.length;
                setTotal(cached.length);
                setLoading(false);
            }
            else {
                setLoading(true);
            }
        }
        try {
            const opts = { limit: 500 };
            if (!reset)
                opts.offset = countRef.current;
            if (author)
                opts.author = author;
            const env = await apiGetMoments(opts);
            setMoments(prev => (reset ? env.moments : [...prev, ...env.moments]));
            countRef.current = reset ? env.moments.length : countRef.current + env.moments.length;
            setTotal(env.total);
            totalRef.current = env.total;
            if (reset)
                writeRenderCache(cacheKey, env.moments.slice(0, 200));
            // Full-history monthly distribution only on (re)load — not per page.
            if (reset) {
                void apiGetMomentsMonthly(author ? { author } : undefined)
                    .then((rows) => { setMonthlyData(rows); })
                    .catch(() => { });
            }
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            setLoading(false);
        }
    }, [author]);
    useEffect(() => { void load(); }, [load]);
    // 拉取当前账号自己的 username，用于「仅看我的回复」。
    useEffect(() => {
        void apiGetSelfUsername().then((u) => { setSelfUsername(u || null); }).catch(() => { });
    }, []);
    // 拉取全量作者条数（反映全量排名）。
    useEffect(() => {
        void apiGetMomentsAuthors().then((list) => { setFullAuthors(list); }).catch(() => { });
    }, []);
    // 选中某作者（作者牌）时，按该作者重算「全部月份动态」；清除后回退到全量月度数据。
    useEffect(() => {
        if (!authorFilter) {
            setMonthlyDataForAuthor([]);
            return;
        }
        let cancelled = false;
        setMonthlyDataForAuthor([]); // 先清空，避免显示上一个作者的数据
        void apiGetMomentsMonthly({ authorName: authorFilter })
            .then((rows) => { if (!cancelled)
            setMonthlyDataForAuthor(rows); })
            .catch(() => { if (!cancelled)
            setMonthlyDataForAuthor([]); }); // 失败时也清空，触发 fallback 聚合
        return () => { cancelled = true; };
    }, [authorFilter]);
    /** 一次性拉取剩余全部朋友圈（每页 500 串行，避免压垮后端 XML 解析）。 */
    const loadAll = useCallback(async () => {
        if (loadingAll)
            return;
        setLoadingAll(true);
        setError(null);
        moreInFlight.current = true;
        try {
            while (countRef.current < totalRef.current) {
                const opts = { limit: 500, offset: countRef.current };
                if (author)
                    opts.author = author;
                const env = await apiGetMoments(opts);
                if (env.moments.length === 0)
                    break;
                setMoments(prev => [...prev, ...env.moments]);
                countRef.current += env.moments.length;
                totalRef.current = env.total;
                setTotal(env.total);
            }
        }
        catch (e) {
            setError(e.message);
        }
        finally {
            moreInFlight.current = false;
            setLoadingAll(false);
        }
    }, [author, loadingAll]);
    // 数据落地后安静刷新：空列表时全量加载；已加载时做「增量刷新」——拉取最新一页，
    // 只把尚未出现过的新动态前插，不折叠已有列表（避免滚动大跳动）。
    useWechatDataUpdated(() => {
        if (moments.length === 0) {
            void load();
            return;
        }
        void (async () => {
            try {
                const env = await apiGetMoments({ limit: 200, author: author || undefined });
                const existing = new Set(moments.map(m => m.tid));
                const fresh = env.moments.filter(m => !existing.has(m.tid));
                if (fresh.length > 0) {
                    setMoments(prev => [...fresh, ...prev]);
                    writeRenderCache('moments:' + (author || 'all'), [...fresh, ...moments].slice(0, 200));
                }
                setTotal(env.total);
                totalRef.current = env.total;
            }
            catch { /* 增量刷新失败时静默，保持当前列表 */ }
        })();
    });
    // 懒加载媒体：只有图片/视频封面的占位块接近视口时才解密（IntersectionObserver），
    // 避免一次性解密数百张离线图片造成卡顿；已取到的 data URL 通过 snsImgs 合入。
    const scrollRef = useRef(null);
    const mediaKeySpec = useRef(new Map());
    const mediaQueue = useRef([]);
    const mediaFetching = useRef(false);
    const mediaObserved = useRef(null);
    const drainMedia = async () => {
        if (mediaFetching.current)
            return;
        mediaFetching.current = true;
        try {
            while (mediaQueue.current.length > 0) {
                const batch = mediaQueue.current.splice(0, 8);
                const updates = {};
                await Promise.all(batch.map(async (it) => {
                    const opts = { md5: it.md5 };
                    if (it.timelineId)
                        opts.timelineId = it.timelineId;
                    if (it.mediaId)
                        opts.mediaId = it.mediaId;
                    try {
                        const cached = await snsMediaCacheGet(it.key);
                        if (cached) {
                            updates[it.key] = cached;
                            return;
                        }
                        const r = it.kind === 'video'
                            ? await apiGetSnsVideoCoverDataUrl(opts)
                            : await apiGetSnsImageDataUrl(opts);
                        if (r.url) {
                            updates[it.key] = r.url;
                            void snsMediaCacheSet(it.key, r.url);
                        }
                    }
                    catch { /* 保留缩略图/CDN 兜底 */ }
                }));
                if (Object.keys(updates).length > 0)
                    setSnsImgs(prev => ({ ...prev, ...updates }));
            }
        }
        finally {
            mediaFetching.current = false;
        }
    };
    useEffect(() => {
        if (typeof IntersectionObserver === 'undefined') {
            // 兜底：不支持 IO 时退回整页解密已挂载的媒体。
            const all = Array.from(mediaKeySpec.current.entries());
            for (const [key, spec] of all) {
                if (snsFetched.current.has(key))
                    continue;
                snsFetched.current.add(key);
                mediaQueue.current.push({ key, ...spec });
            }
            void drainMedia();
            return;
        }
        const ob = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (!e.isIntersecting)
                    continue;
                const el = e.target;
                const key = el.dataset.snsKey || '';
                if (!key || snsFetched.current.has(key))
                    continue;
                const spec = mediaKeySpec.current.get(key);
                if (!spec)
                    continue;
                snsFetched.current.add(key);
                mediaQueue.current.push({ key, ...spec });
                void drainMedia();
            }
        }, { root: scrollRef.current, rootMargin: '480px 0px' });
        mediaObserved.current = ob;
        return () => { ob.disconnect(); mediaObserved.current = null; };
    }, []);
    // 公众号文章封面兜底：本地 SNS 缓存没有时，抓取文章页 og:image 转 data URL；
    // 失败后自动重试（最多 3 次），避免首次加载失败只能靠刷新才能显示。
    useEffect(() => {
        const todo = [];
        for (const m of moments) {
            if (m.contentType !== 3 || !m.link_url)
                continue;
            const cover = m.images[0];
            const localKey = cover ? imgKey(cover) : '';
            if (localKey && snsImgs[localKey])
                continue;
            if (articleCovers[m.link_url])
                continue;
            const attempt = coverAttempts.current.get(m.link_url) ?? 0;
            if (attempt >= 3)
                continue;
            coverAttempts.current.set(m.link_url, attempt + 1);
            todo.push(m.link_url);
        }
        for (const url of todo) {
            void apiGetArticleCover({ contentUrl: url })
                .then((r) => {
                if (r.url) {
                    setArticleCovers(prev => ({ ...prev, [url]: r.url ?? '' }));
                }
                else {
                    setTimeout(() => { setCoverTick(t => t + 1); }, 2500);
                }
            })
                .catch(() => {
                setTimeout(() => { setCoverTick(t => t + 1); }, 2500);
            });
        }
    }, [moments, snsImgs, articleCovers, coverTick]);
    // Search scope is intentionally broader than the legacy author/text/location set:
    // it also matches link title/url, 公众号 source, liker nicknames and comment text.
    const filtered = useMemo(() => {
        const q = deferredSearch.trim().toLowerCase();
        if (!q)
            return moments;
        return moments.filter(m => m.author.toLowerCase().includes(q)
            || m.text.toLowerCase().includes(q)
            || m.location.toLowerCase().includes(q)
            || m.link_title.toLowerCase().includes(q)
            || (m.link_url ?? '').toLowerCase().includes(q)
            || (m.sourceNickName ?? '').toLowerCase().includes(q)
            || (m.publicUserName ?? '').toLowerCase().includes(q)
            || m.likes.some(l => (l.nickname || l.username).toLowerCase().includes(q))
            || m.comments.some(c => (c.nickname || c.username).toLowerCase().includes(q) || c.content.toLowerCase().includes(q)));
    }, [moments, deferredSearch]);
    const mediaFiltered = useMemo(() => {
        if (mediaFilter === 'all')
            return filtered;
        return filtered.filter((m) => {
            switch (mediaFilter) {
                case 'image': return m.images.length > 0;
                case 'video': return m.videos.length > 0;
                case 'link': return !!m.link_title || m.contentType === 3 || m.contentType === 28;
                case 'location': return !!m.location;
                case 'text': return m.images.length === 0 && m.videos.length === 0 && !m.link_title;
                default: return true;
            }
        });
    }, [filtered, mediaFilter]);
    // 独立作者筛选（作者 chips）：按显示名精确匹配，不污染搜索框。
    const authorScoped = useMemo(() => {
        if (!authorFilter)
            return mediaFiltered;
        return mediaFiltered.filter(m => m.author === authorFilter);
    }, [mediaFiltered, authorFilter]);
    // 只看我 / 只看他人 scope.
    const mineFiltered = useMemo(() => {
        if (mineFilter === 'all')
            return authorScoped;
        return authorScoped.filter(m => (mineFilter === 'mine' ? m.is_self : !m.is_self));
    }, [authorScoped, mineFilter]);
    // 月度时间导航：选中某个月时只看该月（基于 ts 的 YYYY-MM 键）。
    const monthFiltered = useMemo(() => {
        if (monthFilter === null)
            return mineFiltered;
        return mineFiltered.filter((m) => {
            if (!m.ts)
                return false;
            const d = new Date(m.ts * 1000);
            const k = String(d.getFullYear()) + '-' + String(d.getMonth() + 1).padStart(2, '0');
            return k === monthFilter;
        });
    }, [mineFiltered, monthFilter]);
    // 自由日期范围筛选（YYYY-MM-DD）。
    const dateScoped = useMemo(() => {
        const from = dateFrom ? Math.floor(new Date(dateFrom + 'T00:00:00').getTime() / 1000) : 0;
        const to = dateTo ? Math.floor(new Date(dateTo + 'T23:59:59').getTime() / 1000) : 0;
        if (!from && !to)
            return monthFiltered;
        return monthFiltered.filter(m => (from <= 0 || m.ts >= from) && (to <= 0 || m.ts <= to));
    }, [monthFiltered, dateFrom, dateTo]);
    // 时间排序（默认最新在前）；用了拷贝，避免原地改动 memos 返回的数组。
    const scoped = useMemo(() => {
        const arr = [...dateScoped];
        if (sortOrder === 'asc')
            arr.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        else
            arr.sort((a, b) => (b.ts || 0) - (a.ts || 0));
        return arr;
    }, [monthFiltered, sortOrder]);
    const insight = useMemo(() => {
        const count = (p) => moments.filter(p).length;
        return {
            withImages: count(m => m.images.length > 0),
            withVideos: count(m => m.videos.length > 0),
            withLocation: count(m => !!m.location),
            withLink: count(m => !!m.link_title),
        };
    }, [moments]);
    const topAuthors = useMemo(() => {
        // 优先用全量作者条数（SQL 聚合，真实反映全量排名）；查询失败则回退到已加载子集统计。
        if (fullAuthors && fullAuthors.length > 0)
            return fullAuthors.slice(0, 20).map(a => [a.name, a.count]);
        const map = new Map();
        for (const m of moments)
            map.set(m.author, (map.get(m.author) ?? 0) + 1);
        return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
    }, [fullAuthors, moments]);
    const monthly = useMemo(() => {
        // 选中作者时使用该作者的全量月度分布；否则用全量（或 prop 作者）的月度分布。
        const raw = authorFilter ? monthlyDataForAuthor : monthlyData;
        if (raw.length > 0) {
            return [...raw].sort((a, b) => a.month.localeCompare(b.month)).map(m => ({ key: m.month, label: m.month, count: m.count }));
        }
        // Fallback: aggregate the currently-loaded page (e.g. monthly fetch failed).
        const map = new Map();
        const scope = authorFilter ? moments.filter(m => m.author === authorFilter) : moments;
        for (const m of scope) {
            if (!m.ts)
                continue;
            const d = new Date(m.ts * 1000);
            const k = String(d.getFullYear()) + '-' + String(d.getMonth() + 1).padStart(2, '0');
            map.set(k, (map.get(k) ?? 0) + 1);
        }
        return [...map.keys()].sort().map(k => ({ key: k, label: k, count: map.get(k) ?? 0 }));
    }, [monthlyData, monthlyDataForAuthor, authorFilter, moments]);
    const monthMax = Math.max(1, ...monthly.map(m => m.count));
    const groups = useMemo(() => groupByDate(scoped), [scoped]);
    const { count: grpCount, sentinelRef: grpSentinel } = useProgressiveList(groups.length, 25);
    const moreRef = useRef(null);
    const moreInFlight = useRef(false);
    // 新渲染/新分组挂载后再观察对应的媒体占位块。
    useEffect(() => {
        const root = scrollRef.current;
        const ob = mediaObserved.current;
        if (!root || !ob)
            return;
        root.querySelectorAll('[data-sns-key]').forEach((el) => {
            if (!el.dataset.snsObs) {
                el.dataset.snsObs = '1';
                ob.observe(el);
            }
        });
    }, [groups, grpCount]);
    // 进入面板时从 IndexedDB 恢复已解密媒体：命中即秒显，不再并发解密。
    useEffect(() => {
        const keys = [];
        const seen = new Set();
        for (const m of moments) {
            for (const im of m.images) {
                const k = imgKey(im);
                if (k && !seen.has(k) && !snsFetched.current.has(k)) {
                    seen.add(k);
                    keys.push(k);
                }
            }
            for (const v of m.videos) {
                const k = v.md5 ? 'v:' + v.md5 : (v.timelineId && v.id ? 'v:' + v.timelineId + ':' + v.id : '');
                if (k && !seen.has(k) && !snsFetched.current.has(k)) {
                    seen.add(k);
                    keys.push(k);
                }
            }
            for (const c of m.comments) {
                const k = c.image?.md5 || '';
                if (k && !seen.has(k) && !snsFetched.current.has(k)) {
                    seen.add(k);
                    keys.push(k);
                }
            }
        }
        if (keys.length === 0)
            return;
        void snsMediaCacheGetMany(keys).then((cached) => {
            const found = Object.keys(cached);
            if (found.length === 0)
                return;
            for (const k of found)
                snsFetched.current.add(k);
            setSnsImgs(prev => ({ ...prev, ...cached }));
        });
    }, [moments]);
    // 滚动到底部附近时自动加载下一页朋友圈（懒加载分页）。
    useEffect(() => {
        const el = moreRef.current;
        if (!el || typeof IntersectionObserver === 'undefined')
            return;
        const ob = new IntersectionObserver((entries) => {
            for (const e of entries) {
                if (e.isIntersecting && !moreInFlight.current && moments.length < total) {
                    moreInFlight.current = true;
                    void load(false).finally(() => { moreInFlight.current = false; });
                }
            }
        }, { root: scrollRef.current, rootMargin: '400px 0px' });
        ob.observe(el);
        return () => { ob.disconnect(); };
    }, [moments.length, total, load]);
    const curImg = viewer ? viewer.images[viewer.index] : undefined;
    // Reset lightbox transform/failed state whenever a viewer opens or its index moves.
    useEffect(() => {
        setViewZoom(1);
        setViewPan({ x: 0, y: 0 });
        setViewFailed(false);
        setViewRotate(0);
        setViewOriginal(false);
    }, [viewer]);
    // Keep a ref mirror of the zoom for the native wheel listener (attached once per open).
    useEffect(() => { viewZoomRef.current = viewZoom; }, [viewZoom]);
    // Native non-passive wheel listener: React's onWheel is passive, so preventDefault
    // would be ignored letting the page scroll behind the lightbox; this suppresses it.
    useEffect(() => {
        const el = lightboxWrapRef.current;
        if (!el || !viewer)
            return;
        const onWheel = (e) => {
            e.preventDefault();
            const cur = viewZoomRef.current;
            const n = Math.min(5, Math.max(1, cur * (e.deltaY < 0 ? 1.1 : 0.9)));
            setViewZoom(n);
            if (n === 1)
                setViewPan({ x: 0, y: 0 });
        };
        el.addEventListener('wheel', onWheel, { passive: false });
        return () => { el.removeEventListener('wheel', onWheel); };
    }, [viewer]);
    // 灯箱当前图离线解码缺失时按需解析（与卡片共用 key：md5 或 timelineId:mediaId），并清除失败态。
    useEffect(() => {
        const im = viewer ? viewer.images[viewer.index] : undefined;
        if (!im)
            return;
        const key = imgKey(im);
        if (!key || snsImgs[key] || snsFetched.current.has(key))
            return;
        snsFetched.current.add(key);
        void apiGetSnsImageDataUrl({ md5: im.md5 || '', timelineId: im.timelineId, mediaId: im.id })
            .then((r) => {
            if (r.url) {
                setSnsImgs(prev => ({ ...prev, [key]: r.url }));
                setViewFailed(false);
            }
        })
            .catch(() => { });
    }, [viewer, snsImgs]);
    // Keyboard control while the lightbox is open: Esc closes, arrows switch image.
    useEffect(() => {
        if (!viewer)
            return;
        const onKey = (e) => {
            if (e.key === 'Escape') {
                setViewer(null);
                return;
            }
            if (e.key === 'ArrowLeft')
                setViewer(v => (v ? { ...v, index: Math.max(0, v.index - 1) } : v));
            if (e.key === 'ArrowRight')
                setViewer(v => (v ? { ...v, index: Math.min(v.images.length - 1, v.index + 1) } : v));
        };
        window.addEventListener('keydown', onKey);
        return () => { window.removeEventListener('keydown', onKey); };
    }, [viewer]);
    // Esc also closes the single-moment detail overlay.
    useEffect(() => {
        if (!detail)
            return;
        const onKey = (e) => { if (e.key === 'Escape')
            setDetail(null); };
        window.addEventListener('keydown', onKey);
        return () => { window.removeEventListener('keydown', onKey); };
    }, [detail]);
    // Save the currently displayed image (data URL → download).
    const saveCurrentImage = () => {
        const src = (curImg && snsImgs[imgKey(curImg)]) || curImg?.url || curImg?.thumb || '';
        if (!src)
            return;
        let ext = 'jpg';
        const dataMatch = src.match(/^data:image\/(\w+)[;,]/);
        if (dataMatch)
            ext = dataMatch[1] === 'jpeg' ? 'jpg' : (dataMatch[1] ?? 'jpg');
        else {
            try {
                const path = new URL(src, location.href).pathname;
                const seg = path.split('.').pop()?.toLowerCase() ?? '';
                if (/^[a-z0-9]{2,5}$/.test(seg))
                    ext = seg;
            }
            catch { /* keep jpg */ }
        }
        const a = document.createElement('a');
        a.href = src;
        a.download = 'moments-' + String(viewer?.index ?? 0) + '.' + ext;
        document.body.appendChild(a);
        a.click();
        a.remove();
    };
    const setViewerIndex = (index) => {
        setViewer(v => (v ? { ...v, index: Math.max(0, Math.min(v.images.length - 1, index)) } : v));
    };
    // Copy the currently displayed image's source (CDN url preferred, else data URL).
    const copyCurrentLink = () => {
        const src = curImg?.url || curImg?.thumb || (curImg && snsImgs[imgKey(curImg)]) || '';
        if (!src)
            return;
        const clip = navigator.clipboard;
        if (clip && typeof clip.writeText === 'function') {
            void clip.writeText(src).then(() => { setNotice('已复制图片链接'); }).catch(() => { });
        }
        else {
            setNotice('当前环境不支持复制');
        }
    };
    const openExport = () => { setExportOpen(true); };
    // Copy arbitrary text to the clipboard.
    const copyText = (text) => {
        if (!text)
            return;
        const clip = navigator.clipboard;
        if (clip && typeof clip.writeText === 'function') {
            void clip.writeText(text).then(() => { setNotice('已复制'); }).catch(() => { });
        }
        else {
            setNotice('当前环境不支持复制');
        }
    };
    // 手动重新同步：触发宿主重解密并派发更新事件（面板随后刷新）。
    const doSync = async () => {
        if (syncing)
            return;
        setSyncing(true);
        setNotice(null);
        try {
            await apiDecryptAllDatabases();
            setLastSync(Date.now());
            window.dispatchEvent(new Event('dsh-wechat-data-updated'));
            void load();
            setNotice('已重新同步解密数据');
            setTimeout(() => { setNotice(null); }, 6000);
        }
        catch (e) {
            setNotice('同步失败: ' + e.message);
        }
        finally {
            setSyncing(false);
        }
    };
    const pickDir = async () => {
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
    const doExport = async () => {
        setExporting(true);
        setNotice(null);
        try {
            const opts = { format: expFormat };
            // username = 微信用户名（user_name，深链“TA 的朋友圈”）；authorName = 作者显示名（作者牌）。
            if (author)
                opts.username = author;
            if (authorFilter)
                opts.authorName = authorFilter;
            const term = search.trim();
            if (term)
                opts.q = term;
            // 导出与列表当前筛选一致（媒体类型/月份/范围）。
            if (mediaFilter !== 'all')
                opts.media = mediaFilter;
            if (monthFilter)
                opts.month = monthFilter;
            if (mineFilter !== 'all')
                opts.mine = mineFilter;
            if (expImages)
                opts.images = true;
            if (expZip)
                opts.zip = true;
            if (expFrom)
                opts.from = Math.floor(new Date(expFrom + 'T00:00:00').getTime() / 1000);
            if (expTo)
                opts.to = Math.floor(new Date(expTo + 'T23:59:59').getTime() / 1000);
            if (expDir)
                opts.dir = expDir;
            const r = await apiExportMoments(opts);
            setNotice('已导出 ' + String(r.count) + ' 条动态 → ' + r.path);
            setExportedPath(r.path);
            setExportOpen(false);
            setTimeout(() => { setNotice(null); }, 6000);
        }
        catch (e) {
            setNotice('导出失败: ' + e.message);
        }
        finally {
            setExporting(false);
        }
    };
    // Fetch the cached .mp4 body lazily on first play click (prefer offline, fall
    // back to the CDN URL); mark failures once so a missing file isn't retried.
    const loadVideo = useCallback((vk, v) => {
        if (!vk || videoSrcs[vk] || videoFetching.current.has(vk))
            return;
        videoFetching.current.add(vk);
        void (async () => {
            const fallback = v.url || '';
            try {
                const r = await apiGetSnsVideoDataUrl({ md5: v.md5, timelineId: v.timelineId, mediaId: v.id });
                const src = r.url || fallback;
                if (src)
                    setVideoSrcs(prev => ({ ...prev, [vk]: src }));
                else
                    setVideoFailed(prev => new Set(prev).add(vk));
            }
            catch {
                if (fallback)
                    setVideoSrcs(prev => ({ ...prev, [vk]: fallback }));
                else
                    setVideoFailed(prev => new Set(prev).add(vk));
            }
            finally {
                videoFetching.current.delete(vk);
            }
        })();
    }, [videoSrcs]);
    // Request fullscreen on the video inside a playing tile (best effort).
    const fullscreenVideo = (el) => {
        const v = el?.querySelector('video');
        if (v && typeof v.requestFullscreen === 'function')
            void v.requestFullscreen().catch(() => { });
    };
    // Save a video data URL / CDN src to disk.
    const downloadVideo = (src, name) => {
        if (!src)
            return;
        const a = document.createElement('a');
        a.href = src;
        a.download = (name ? 'moments-video-' + name.slice(0, 12) : 'moments-video') + '.mp4';
        document.body.appendChild(a);
        a.click();
        a.remove();
    };
    const toggleText = (tid) => {
        setExpandedTextByCard((prev) => {
            const next = new Set(prev);
            if (next.has(tid))
                next.delete(tid);
            else
                next.add(tid);
            return next;
        });
    };
    const toggleSocial = (tid) => {
        setExpandedSocialByCard((prev) => {
            const next = new Set(prev);
            if (next.has(tid))
                next.delete(tid);
            else
                next.add(tid);
            return next;
        });
    };
    const clearFilters = () => { setSearch(''); setMediaFilter('all'); setMonthFilter(null); setMineFilter('all'); setAuthorFilter(null); setDateFrom(''); setDateTo(''); };
    return (_jsxs("div", { className: css.panel, children: [_jsx(PanelHeader, { title: (_jsxs(_Fragment, { children: ["\u670B\u53CB\u5708", _jsxs("span", { className: css.count, children: ["\u5171 ", total, " \u6761"] }), author && onClearAuthor && (_jsxs("button", { type: "button", className: css.btn, onClick: onClearAuthor, title: "\u8FD4\u56DE\u5168\u90E8\u52A8\u6001", children: ["\u2715 \u4EC5\u770B ", author] }))] })), actions: (_jsxs(_Fragment, { children: [_jsx(SearchInput, { value: search, onChange: (v) => { setSearch(v); }, placeholder: "\u641C\u7D22\u4F5C\u8005 / \u5185\u5BB9 / \u4F4D\u7F6E / \u8BC4\u8BBA", ariaLabel: "\u641C\u7D22\u670B\u53CB\u5708" }), _jsx("button", { type: "button", className: css.btn, "data-on": privacy || undefined, onClick: () => { setPrivacy(v => !v); }, title: "\u9690\u79C1\u6A21\u5F0F\uFF1A\u6A21\u7CCA\u5934\u50CF\u4E0E\u5185\u5BB9\uFF0C\u60AC\u505C\u67E5\u770B", children: "\uD83D\uDD12 \u9690\u79C1" }), _jsx("button", { type: "button", className: css.btn, onClick: () => { void load(); }, disabled: loading, children: "\u5237\u65B0" }), _jsx("button", { type: "button", className: css.btn, "data-on": syncing || undefined, onClick: () => { void doSync(); }, disabled: syncing, children: syncing ? '同步中…' : '↻ 同步' }), lastSync > 0 && _jsxs("span", { className: css.syncStatus, title: "\u6700\u8FD1\u4E00\u6B21\u624B\u52A8\u91CD\u540C\u6B65\u65F6\u95F4", children: ["\u6700\u8FD1\u540C\u6B65 ", fmtSyncTime(lastSync)] }), _jsx("button", { type: "button", className: css.btn, onClick: openExport, children: "\u5BFC\u51FA" })] })) }), _jsxs("div", { className: css.layout, children: [_jsxs("aside", { className: css.sidebar, children: [_jsxs("div", { className: css.filterPanel, children: [topAuthors.length > 0 && (_jsxs("div", { className: css.filterGroup, children: [_jsx("span", { className: css.filterLabel, children: "\u4F5C\u8005" }), _jsxs("div", { className: css.filterChips, children: [(showAllAuthors ? topAuthors : topAuthors.slice(0, 8)).map(([name, count]) => (_jsxs("button", { type: "button", className: css.authorChip, "data-on": authorFilter === name || undefined, title: authorFilter === name ? '清除 ' + name : '只看 ' + name, onClick: () => { setAuthorFilter(authorFilter === name ? null : name); }, children: [_jsx("span", { className: css.chipName, children: name }), _jsx("span", { className: css.chipCount, children: String(count) })] }, name))), topAuthors.length > 8 && (_jsx("button", { type: "button", className: css.authorChip, onClick: () => { setShowAllAuthors(v => !v); }, title: showAllAuthors ? '收起作者' : '更多作者', children: showAllAuthors ? '↑ 收起' : '… 更多作者' })), authorFilter && _jsxs("button", { type: "button", className: css.authorChip, "data-on": "", onClick: () => { setAuthorFilter(null); }, title: "\u6E05\u9664\u4F5C\u8005\u7B5B\u9009", children: ["\u2715 ", authorFilter] })] })] })), _jsxs("div", { className: css.filterGroup, children: [_jsx("span", { className: css.filterLabel, children: "\u7C7B\u578B" }), _jsx(Segmented, { options: Object.keys(MEDIA_LABELS).map(f => ({ value: f, label: MEDIA_LABELS[f] })), value: mediaFilter, onChange: (v) => { setMediaFilter(v); }, ariaLabel: "\u5A92\u4F53\u7C7B\u578B\u7B5B\u9009" })] }), _jsxs("div", { className: css.filterGroup, children: [_jsx("span", { className: css.filterLabel, children: "\u8303\u56F4" }), _jsx(Segmented, { options: [
                                                    { value: 'all', label: '全部' },
                                                    { value: 'mine', label: '我' },
                                                    { value: 'others', label: '他人' },
                                                ], value: mineFilter, onChange: (v) => { setMineFilter(v); }, ariaLabel: "\u8303\u56F4\u7B5B\u9009" })] }), _jsxs("div", { className: css.filterGroup, children: [_jsx("span", { className: css.filterLabel, children: "\u6392\u5E8F" }), _jsx(Segmented, { options: [
                                                    { value: 'desc', label: '最新在前' },
                                                    { value: 'asc', label: '最早在前' },
                                                ], value: sortOrder, onChange: (v) => { setSortOrder(v); }, ariaLabel: "\u6392\u5E8F\u65B9\u5411" })] }), _jsxs("div", { className: css.filterGroup, children: [_jsx("span", { className: css.filterLabel, children: "\u65F6\u95F4" }), _jsxs("div", { className: css.filterChips, children: [_jsx("input", { type: "date", value: dateFrom, onChange: (e) => { setDateFrom(e.target.value); }, className: css.dateInput }), _jsx("span", { className: css.filterLabel, style: { width: 'auto' }, children: "\u81F3" }), _jsx("input", { type: "date", value: dateTo, onChange: (e) => { setDateTo(e.target.value); }, className: css.dateInput }), (dateFrom || dateTo) && _jsx("button", { type: "button", className: css.segChip, onClick: () => { setDateFrom(''); setDateTo(''); }, title: "\u6E05\u9664\u65F6\u95F4", children: "\u2715" })] })] }), monthFilter && (_jsxs("div", { className: css.filterGroup, children: [_jsx("span", { className: css.filterLabel, children: "\u6708\u4EFD" }), _jsx("div", { className: css.segTrack, children: _jsxs("button", { type: "button", className: css.segChip, "data-on": "", onClick: () => { setMonthFilter(null); }, title: "\u6E05\u9664\u6708\u4EFD\u7B5B\u9009", children: ["\u2715 ", monthFilter] }) })] })), (search || mediaFilter !== 'all' || monthFilter !== null || mineFilter !== 'all' || authorFilter !== null) && (_jsx("button", { type: "button", className: css.clearBtn, onClick: clearFilters, title: "\u6E05\u9664\u6240\u6709\u7B5B\u9009", children: "\u2715 \u6E05\u9664" }))] }), _jsxs("div", { className: css.monthCard, children: [_jsxs("div", { className: css.monthTitle, children: [_jsxs("span", { children: ["\u5168\u90E8\u6708\u4EFD\u52A8\u6001", authorFilter ? '（作者：' + authorFilter + '）' : '', "\uFF08", monthly.length, " \u4E2A\u6708\uFF09"] }), _jsx("span", { className: css.monthHint, children: "\u70B9\u51FB\u67F1\u6761\u6309\u6708\u4EFD\u7B5B\u9009" }), monthFilter && _jsx("span", { className: css.monthHint, children: moments.length < total ? '（结果仅覆盖已加载部分）' : null }), monthFilter && _jsxs("button", { type: "button", className: css.textToggle, onClick: () => { setMonthFilter(null); }, children: ["\u2715 \u6E05\u9664 ", monthFilter] })] }), _jsx("div", { className: css.monthBars, children: monthly.map(m => (_jsxs("div", { className: [css.monthCol, m.key === monthFilter ? css.monthColActive : ''].filter(Boolean).join(' '), children: [_jsx("span", { className: css.monthValue, children: m.count > 0 ? String(m.count) : '' }), _jsx("div", { className: css.monthFill, "data-peak": m.count === monthMax || undefined, "data-on": m.key === monthFilter || undefined, title: m.key + ' ' + String(m.count) + ' 条', role: "button", onClick: () => { setMonthFilter(m.key === monthFilter ? null : m.key); }, style: { height: String(Math.max(2, Math.round((m.count / monthMax) * 30))) + 'px' } }), _jsx("span", { className: css.monthLabel, children: m.label })] }, m.key))) })] }), _jsxs("div", { className: css.insight, children: [_jsxs("div", { className: css.stat, children: [_jsx("span", { className: css.statIcon, children: "\uD83D\uDCCA" }), _jsx("span", { className: css.statNum, title: "\u670D\u52A1\u7AEF\u5168\u91CF\u52A8\u6001\u6570", children: String(total) }), _jsx("span", { className: css.statLabel, children: "\u603B\u52A8\u6001" })] }), _jsxs("div", { className: css.stat, children: [_jsx("span", { className: css.statIcon, children: "\uD83D\uDDBC" }), _jsx("span", { className: css.statNum, children: insight.withImages }), _jsx("span", { className: css.statLabel, children: "\u542B\u56FE\u7247" })] }), _jsxs("div", { className: css.stat, children: [_jsx("span", { className: css.statIcon, children: "\uD83C\uDFAC" }), _jsx("span", { className: css.statNum, children: insight.withVideos }), _jsx("span", { className: css.statLabel, children: "\u542B\u89C6\u9891" })] }), _jsxs("div", { className: css.stat, children: [_jsx("span", { className: css.statIcon, children: "\uD83D\uDCCD" }), _jsx("span", { className: css.statNum, children: insight.withLocation }), _jsx("span", { className: css.statLabel, children: "\u5E26\u4F4D\u7F6E" })] }), _jsxs("div", { className: css.stat, children: [_jsx("span", { className: css.statIcon, children: "\uD83D\uDD17" }), _jsx("span", { className: css.statNum, children: insight.withLink }), _jsx("span", { className: css.statLabel, children: "\u5206\u4EAB\u94FE\u63A5" })] })] })] }), _jsxs("div", { className: css.main, children: [_jsxs("div", { ref: scrollRef, className: css.scroll, children: [moments.length < total && _jsxs("div", { className: css.insightNote, children: ["\u7EDF\u8BA1\u4E2D\u7684\u56FE\u7247/\u89C6\u9891/\u4F4D\u7F6E/\u94FE\u63A5\u4E3A\u5DF2\u52A0\u8F7D\u90E8\u5206\uFF1B\u5168\u91CF ", total, " \u6761\u3002"] }), search && moments.length < total && !loading && !error && (_jsxs("div", { className: css.searchBanner, children: [_jsxs("span", { children: ["\u641C\u7D22\u4EC5\u8986\u76D6\u5DF2\u52A0\u8F7D ", moments.length, " / ", total, " \u6761"] }), _jsx("button", { type: "button", className: css.btn, onClick: () => { void loadAll(); }, disabled: loadingAll, children: loadingAll ? '加载中…' : '加载全部以覆盖全量' })] })), loading && moments.length === 0 && _jsx(ListSkeleton, { rows: 10 }), error && _jsxs("div", { className: css.empty, children: ["\u26A0\uFE0F \u670B\u53CB\u5708\u6570\u636E\u52A0\u8F7D\u5931\u8D25\uFF08", error, "\uFF09"] }), !loading && !error && groups.length === 0 && (_jsx("div", { className: css.empty, children: (() => {
                                            if (search && mediaFilter === 'all' && monthFilter === null && mineFilter === 'all' && authorFilter === null) {
                                                return moments.length < total ? '已加载范围无匹配（共 ' + String(total) + ' 条，当前只加载了 ' + String(moments.length) + ' 条）' : '无匹配动态';
                                            }
                                            if (search)
                                                return '无匹配动态';
                                            if (mediaFilter !== 'all' || monthFilter !== null || mineFilter !== 'all' || authorFilter !== null || dateFrom || dateTo)
                                                return '当前筛选无匹配动态';
                                            return '暂无朋友圈动态';
                                        })() })), !loading && !error && groups.slice(0, grpCount).map(g => (_jsxs("div", { className: css.dayGroup, children: [_jsx("div", { className: css.dayLabel, children: g.day }), g.items.map((m) => {
                                                const cover = m.images[0];
                                                const isArticle = m.contentType === 3;
                                                const coverSrc = (cover && imgKey(cover) && snsImgs[imgKey(cover)]) || (m.link_url && articleCovers[m.link_url]) || cover?.thumb || cover?.url || '';
                                                const textExpanded = expandedTextByCard.has(m.tid);
                                                const socialExpanded = expandedSocialByCard.has(m.tid);
                                                const commentShown = commentCounts[m.tid] ?? 5;
                                                const commentSort = commentSortByCard[m.tid] ?? 'asc';
                                                let commentList = commentSort === 'desc' ? [...m.comments].reverse() : m.comments;
                                                if (onlyMineComments && selfUsername)
                                                    commentList = commentList.filter(c => c.username === selfUsername);
                                                const visibleComments = commentList.slice(0, Math.min(commentShown, commentList.length));
                                                return (_jsxs("div", { className: [css.card, privacy ? css.blurCard : ''].filter(Boolean).join(' '), children: [_jsx("div", { className: css.avatarClick, role: "button", title: "\u67E5\u770B\u8BE6\u60C5", onClick: () => { setDetail({ m }); }, children: _jsx(MomentsAvatar, { username: m.username, name: m.author || '?' }) }), _jsxs("div", { className: css.body, children: [_jsxs("div", { className: css.meta, role: "button", title: "\u67E5\u770B\u8BE6\u60C5", onClick: () => { setDetail({ m }); }, children: [_jsx("span", { className: css.author, children: m.author || '未知' }), m.is_self && _jsx("span", { className: css.selfTag, children: "\u6211" })] }), m.text && (_jsxs("div", { className: css.content, children: [textExpanded || m.text.length <= 200 ? m.text : m.text.slice(0, 200) + '…', m.text.length > 200 && (_jsx("button", { type: "button", className: css.textToggle, onClick: () => { toggleText(m.tid); }, children: textExpanded ? '收起' : '展开' }))] })), m.images.length > 0 && !isArticle && (_jsx("div", { className: [css.images, m.images.length === 1 ? css.imagesSingle : ''].filter(Boolean).join(' '), children: m.images.map((im, ii) => {
                                                                        const key = imgKey(im);
                                                                        const dataSrc = key ? snsImgs[key] : undefined;
                                                                        const fk = m.tid + ':' + String(ii);
                                                                        const failed = failedImgs.has(fk);
                                                                        if (key)
                                                                            mediaKeySpec.current.set(key, { md5: im.md5 || '', timelineId: im.timelineId, mediaId: im.id, kind: 'img' });
                                                                        const haveSrc = !!(dataSrc || im.thumb || im.url);
                                                                        return (_jsx("div", { className: css.imgWrap, onClick: () => { setViewer({ images: m.images, index: ii, author: m.author }); }, role: "button", title: "\u70B9\u51FB\u67E5\u770B\u5927\u56FE", "data-sns-key": key || undefined, "data-sns-md5": im.md5 || undefined, "data-sns-tid": im.timelineId || undefined, "data-sns-mid": im.id || undefined, children: haveSrc && (!failed || dataSrc) ? (_jsx("img", { src: dataSrc || im.thumb || im.url || '', alt: "", loading: "lazy", decoding: "async", referrerPolicy: "no-referrer", className: css.img, onError: () => {
                                                                                    // 如果当前src是CDN URL（非data URL），标记为失败
                                                                                    // 避免反复尝试无法访问的CDN URL
                                                                                    const currentSrc = dataSrc || im.thumb || im.url || '';
                                                                                    if (!currentSrc.startsWith('data:')) {
                                                                                        setFailedImgs(prev => new Set(prev).add(fk));
                                                                                    }
                                                                                } }, dataSrc ? 'd' : 'c')) : (_jsx("div", { className: css.imgFallback, children: failed ? (_jsxs("div", { className: css.imgFallbackContent, children: [_jsx("span", { className: css.imgFallbackIcon, children: "\uD83D\uDDBC" }), _jsx("span", { className: css.imgFallbackText, children: "\u56FE\u7247\u52A0\u8F7D\u5931\u8D25" }), _jsx("span", { className: css.imgFallbackHint, children: "\u672C\u5730\u7F13\u5B58\u672A\u627E\u5230" })] })) : '加载中' })) }, fk));
                                                                    }) })), m.videos.length > 0 && (_jsx("div", { className: css.videos, children: m.videos.map((v, vi) => {
                                                                        const vk = v.md5 ? 'v:' + v.md5 : (v.timelineId && v.id ? 'v:' + v.timelineId + ':' + v.id : '');
                                                                        const vCover = (vk ? snsImgs[vk] : undefined) || v.thumb || '';
                                                                        if (vk)
                                                                            mediaKeySpec.current.set(vk, { md5: v.md5 || '', timelineId: v.timelineId, mediaId: v.id, kind: 'video' });
                                                                        const src = vk ? videoSrcs[vk] : undefined;
                                                                        const playing = !!src;
                                                                        return (_jsx("div", { className: [css.videoTile, playing ? css.videoTilePlaying : ''].filter(Boolean).join(' '), title: v.url || v.md5 || '', "data-sns-key": vk || undefined, "data-sns-md5": v.md5 || undefined, "data-sns-tid": v.timelineId || undefined, "data-sns-mid": v.id || undefined, role: playing ? undefined : 'button', onClick: playing ? undefined : () => { loadVideo(vk, v); }, children: playing ? (_jsxs(_Fragment, { children: [_jsx("video", { className: css.videoPlayer, src: src, controls: true, autoPlay: true, poster: vCover || '' }), _jsx("button", { type: "button", className: css.fullscreenBtn, title: "\u5168\u5C4F", onClick: (e) => { e.stopPropagation(); fullscreenVideo(e.currentTarget.closest('.videoTile')); }, children: "\u26F6" }), _jsx("button", { type: "button", className: css.fullscreenBtn, style: { right: '46px' }, title: "\u4FDD\u5B58\u89C6\u9891", onClick: (e) => { e.stopPropagation(); downloadVideo(src, v.md5); }, children: "\u2B73" })] })) : vCover ? (_jsxs(_Fragment, { children: [_jsx("img", { className: css.videoCover, src: vCover, alt: "", loading: "lazy", decoding: "async", referrerPolicy: "no-referrer", onError: (e) => {
                                                                                            // 如果当前src是CDN URL（非data URL），隐藏图片
                                                                                            if (!vCover.startsWith('data:')) {
                                                                                                e.currentTarget.style.display = 'none';
                                                                                            }
                                                                                        } }), _jsx("span", { className: css.videoPlayBadge, children: "\u25B6" }), v.duration > 0 && _jsxs("span", { className: css.videoDur, children: [Math.round(v.duration), "s"] })] })) : (_jsxs(_Fragment, { children: [_jsx("span", { className: css.videoBadge, children: videoFailed.has(vk) ? '×' : '▶' }), v.duration > 0 && _jsxs("span", { className: css.videoDur, children: [Math.round(v.duration), "s"] })] })) }, vi));
                                                                    }) })), m.link_title && (_jsxs("div", { className: css.linkCard, children: [cover ? (_jsx("div", { className: css.linkCover, children: _jsx("img", { src: coverSrc, alt: "", referrerPolicy: "no-referrer", onError: (e) => {
                                                                                    // 如果当前src是CDN URL（非data URL），隐藏图片
                                                                                    if (!coverSrc.startsWith('data:')) {
                                                                                        e.currentTarget.style.display = 'none';
                                                                                    }
                                                                                } }, coverSrc.startsWith('data:') ? 'd' : 'c') })) : null, _jsxs("div", { className: css.linkBody, children: [m.link_url
                                                                                    ? _jsx("a", { className: css.linkTitle, href: m.link_url, target: "_blank", rel: "noopener noreferrer", children: m.link_title })
                                                                                    : _jsx("span", { className: css.linkTitle, children: m.link_title }), _jsx("div", { className: css.linkSub, children: m.sourceNickName ? '公众号 · ' + m.sourceNickName : (m.contentType === 28 ? '视频号' : '链接') })] })] })), m.location && (_jsx("div", { className: css.tags, children: _jsxs("span", { className: css.tag, children: ["\uD83D\uDCCD ", m.location] }) })), (m.likes.length > 0 || m.comments.length > 0) && (_jsxs("div", { className: css.social, children: [m.likes.length > 0 && (_jsxs("div", { className: css.likesRow, children: [_jsxs("span", { className: css.likesCount, children: ["\u2764 ", m.likes.length] }), _jsxs("span", { className: css.likeNames, children: [(() => {
                                                                                            const names = socialExpanded ? m.likes : m.likes.slice(0, 8);
                                                                                            return names.map((l, idx) => (_jsxs(Fragment, { children: [_jsx("span", { className: css.clickableName, title: '只看 ' + (l.nickname || l.username), onClick: (e) => { e.stopPropagation(); setAuthorFilter(l.nickname || l.username || null); }, children: l.nickname || l.username || '未知' }), idx < names.length - 1 ? '、' : null] }, idx)));
                                                                                        })(), !socialExpanded && m.likes.length > 8 ? ' 等' : '', m.likes.length > 8 && (_jsx("button", { type: "button", className: css.textToggle, onClick: () => { toggleSocial(m.tid); }, children: socialExpanded ? '收起' : '展开全部 ' + String(m.likes.length) + ' 人' }))] })] })), m.comments.length > 0 && (_jsxs("div", { className: css.comments, children: [m.comments.length > 1 && (_jsxs("div", { className: css.commentsHead, children: [_jsxs("span", { className: css.commentsTitle, children: ["\u8BC4\u8BBA ", m.comments.length] }), _jsxs("div", { className: css.commentsHeadActs, children: [selfUsername && (_jsx("button", { type: "button", className: css.textToggle, "data-on": onlyMineComments || undefined, onClick: () => { setOnlyMineComments(v => !v); }, children: "\u4EC5\u770B\u6211\u7684" })), _jsx("button", { type: "button", className: css.textToggle, onClick: () => { setCommentSortByCard(prev => ({ ...prev, [m.tid]: commentSort === 'asc' ? 'desc' : 'asc' })); }, children: commentSort === 'asc' ? '最新在前' : '最早在前' }), _jsx("button", { type: "button", className: css.textToggle, onClick: () => { copyText(m.comments.map(c => ((c.nickname || c.username) + '：' + (c.content || '')).trim()).join('\n')); }, children: "\u590D\u5236" })] })] })), visibleComments.map((c, ci) => {
                                                                                    const target = replyTarget(m, c);
                                                                                    return (_jsxs("div", { className: css.comment, children: [_jsx("span", { className: css.commentName, title: '只看 ' + (c.nickname || c.username), onClick: (e) => { e.stopPropagation(); setAuthorFilter(c.nickname || c.username || null); }, children: c.nickname || c.username || '未知' }), c.to_username && c.to_username !== m.username && (_jsxs("span", { className: css.commentReply, children: ["\u56DE\u590D ", c.to_nickname || c.to_username, target ? '：' : ''] })), target && _jsxs("span", { className: css.commentQuote, children: ["\u201C", target.content.slice(0, 40), "\u201D"] }), _jsx("span", { className: css.commentText, children: c.content || '' }), c.image && (() => {
                                                                                                const img = c.image;
                                                                                                const cdata = (img.md5 && snsImgs[img.md5]) || '';
                                                                                                const cfk = m.tid + ':c' + String(ci);
                                                                                                const cfailed = failedImgs.has(cfk);
                                                                                                if (img.md5)
                                                                                                    mediaKeySpec.current.set(img.md5, { md5: img.md5, kind: 'comment' });
                                                                                                if (cdata || img.thumb || img.url)
                                                                                                    return (_jsx("img", { src: cdata || img.thumb || img.url || '', alt: "", loading: "lazy", decoding: "async", referrerPolicy: "no-referrer", className: css.commentImg, "data-sns-key": img.md5 || undefined, "data-sns-md5": img.md5 || undefined, onClick: () => { setViewer({ images: [{ thumb: img.thumb, url: img.url, md5: img.md5 }], index: 0, author: (c.nickname || c.username || '') }); }, onError: () => {
                                                                                                            // 如果当前src是CDN URL（非data URL），标记为失败
                                                                                                            const currentSrc = cdata || img.thumb || img.url || '';
                                                                                                            if (!currentSrc.startsWith('data:')) {
                                                                                                                setFailedImgs(prev => new Set(prev).add(cfk));
                                                                                                            }
                                                                                                        } }, cdata ? 'd' : 'c'));
                                                                                                return !cfailed ? _jsx("span", { className: css.commentImgFallback, children: "[\u56FE]" }) : null;
                                                                                            })(), c.ts > 0 && _jsx("span", { className: css.commentTime, children: fmtCommentTime(c.ts) })] }, ci));
                                                                                }), m.comments.length > commentShown && (_jsxs("button", { type: "button", className: css.textToggle, onClick: () => { setCommentCounts(prev => ({ ...prev, [m.tid]: Math.min(m.comments.length, commentShown + 10) })); }, children: ["\u52A0\u8F7D\u66F4\u591A\u8BC4\u8BBA\uFF08\u5269\u4F59 ", String(m.comments.length - commentShown), " \u6761\uFF09"] }))] }))] })), _jsxs("div", { className: css.timeRow, children: [_jsx("span", { className: css.time, children: m.time }), m.is_self && _jsx("span", { className: css.delIcon, children: "\uD83D\uDDD1" })] })] })] }, m.tid));
                                            })] }, g.day))), !loading && !error && moments.length > 0 && moments.length < total && (_jsx("div", { className: css.moreRow, children: _jsx("button", { type: "button", className: css.moreBtn, onClick: () => { void loadAll(); }, disabled: loadingAll, children: loadingAll ? '加载中…' : `加载全部（剩余 ${total - moments.length} 条）` }) })), !loading && !error && groups.length > grpCount && _jsx(ListSentinel, { refFn: grpSentinel })] }), createPortal(_jsx("button", { type: "button", className: css.backTop, style: { position: 'fixed', right: '30px', bottom: '28px', zIndex: 2147483000 }, onClick: () => { scrollRef.current?.scrollTo({ top: 0, behavior: 'smooth' }); if (window.scrollY > 0)
                                    window.scrollTo({ top: 0, behavior: 'smooth' }); }, title: "\u56DE\u5230\u9876\u90E8", "aria-label": "\u56DE\u5230\u9876\u90E8", children: "\u2191" }), document.body)] })] }), notice && _jsx("div", { className: css.hint, children: notice }), exportedPath && (_jsxs("div", { className: css.exportResult, children: [_jsxs("span", { className: css.exportResultPath, title: exportedPath, children: ["\uD83D\uDCC4 ", exportedPath] }), _jsx("button", { type: "button", className: css.btn, onClick: () => { void apiOpenPath(exportedPath).catch(() => { setNotice('无法打开文件'); }); }, children: "\u6253\u5F00\u5BFC\u51FA\u6587\u4EF6" })] })), viewer && createPortal(_jsx("div", { className: [css.overlay, css.overlayTop].join(' '), onClick: () => { setViewer(null); }, role: "dialog", children: _jsxs("div", { className: css.lightbox, onClick: (e) => { e.stopPropagation(); }, children: [_jsxs("div", { className: css.lightboxHead, children: [_jsxs("span", { children: [viewer.author, " \u00B7 ", String(viewer.index + 1), "/", String(viewer.images.length)] }), _jsxs("div", { className: css.lightboxHeadActions, children: [_jsx("button", { type: "button", className: css.btn, onClick: copyCurrentLink, disabled: !((curImg?.url) || (curImg && snsImgs[imgKey(curImg)]) || curImg?.thumb), title: "\u590D\u5236\u94FE\u63A5", children: "\u590D\u5236" }), _jsx("button", { type: "button", className: css.btn, onClick: saveCurrentImage, disabled: !((curImg && snsImgs[imgKey(curImg)]) || curImg?.url || curImg?.thumb), title: "\u4FDD\u5B58\u5230\u672C\u5730", children: "\u4FDD\u5B58" }), _jsx("button", { type: "button", className: css.btn, "data-on": viewOriginal || undefined, onClick: () => { setViewOriginal(v => !v); }, disabled: !curImg?.url, title: viewOriginal ? '当前为原始链接，点按回离线解码图' : '切换为原始链接', children: "\u539F\u56FE" }), _jsx("button", { type: "button", className: css.btn, onClick: () => { setViewRotate(r => (r + 90) % 360); }, title: "\u65CB\u8F6C90\u00B0", children: "\u21BB" }), _jsx("button", { type: "button", className: css.btn, onClick: () => { setViewZoom(1); setViewPan({ x: 0, y: 0 }); }, disabled: viewZoom === 1, title: "\u91CD\u7F6E\u7F29\u653E", children: "1:1" }), _jsx("button", { type: "button", className: css.btn, onClick: () => { setViewer(null); }, "aria-label": "\u5173\u95ED", children: "\u00D7" })] })] }), _jsx("div", { ref: lightboxWrapRef, className: css.lightboxImgWrap, onDoubleClick: () => { setViewZoom(z => (z === 1 ? 2.5 : 1)); setViewPan({ x: 0, y: 0 }); }, onTouchStart: (e) => {
                                const a = e.touches[0];
                                const b = e.touches[1];
                                if (e.touches.length === 2 && a && b) {
                                    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
                                    pinchRef.current = { dist: d, zoom: viewZoomRef.current };
                                }
                            }, onTouchMove: (e) => {
                                const p = pinchRef.current;
                                const a = e.touches[0];
                                const b = e.touches[1];
                                if (p && e.touches.length === 2 && a && b) {
                                    const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
                                    const n = Math.min(5, Math.max(1, p.zoom * (d / p.dist)));
                                    setViewZoom(n);
                                    if (n === 1)
                                        setViewPan({ x: 0, y: 0 });
                                }
                            }, onTouchEnd: () => { pinchRef.current = null; }, onMouseDown: (e) => {
                                if (viewZoom <= 1)
                                    return;
                                dragRef.current = { sx: e.clientX, sy: e.clientY, ox: viewPan.x, oy: viewPan.y };
                            }, onMouseMove: (e) => {
                                const d = dragRef.current;
                                if (d)
                                    setViewPan({ x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) });
                            }, onMouseUp: () => { dragRef.current = null; }, onMouseLeave: () => { dragRef.current = null; }, style: { cursor: viewZoom > 1 ? 'move' : 'zoom-in' }, children: viewFailed ? (_jsx("div", { className: css.lightboxFail, children: "\u56FE\u7247\u52A0\u8F7D\u5931\u8D25" })) : (_jsx("img", { src: viewOriginal ? ((curImg?.url) || (curImg && snsImgs[imgKey(curImg)]) || curImg?.thumb || '') : ((curImg && snsImgs[imgKey(curImg)]) || curImg?.url || curImg?.thumb || ''), alt: "", referrerPolicy: "no-referrer", draggable: false, className: css.lightboxImg, style: { transform: 'rotate(' + String(viewRotate) + 'deg) scale(' + String(viewZoom) + ') translate(' + String(viewPan.x) + 'px,' + String(viewPan.y) + 'px)' }, onError: () => {
                                    // 如果当前src是CDN URL（非data URL），标记为失败
                                    const currentSrc = viewOriginal ? ((curImg?.url) || (curImg && snsImgs[imgKey(curImg)]) || curImg?.thumb || '') : ((curImg && snsImgs[imgKey(curImg)]) || curImg?.url || curImg?.thumb || '');
                                    if (!currentSrc.startsWith('data:')) {
                                        setViewFailed(true);
                                    }
                                } })) }), _jsxs("div", { className: css.lightboxNav, children: [_jsx("button", { type: "button", className: css.btn, disabled: viewer.index <= 0, onClick: () => { setViewerIndex(viewer.index - 1); }, children: "\u2039 \u4E0A\u4E00\u5F20" }), _jsx("button", { type: "button", className: css.btn, disabled: viewer.index >= viewer.images.length - 1, onClick: () => { setViewerIndex(viewer.index + 1); }, children: "\u4E0B\u4E00\u5F20 \u203A" })] }), viewer.images.length > 1 && (_jsx("div", { className: css.lightboxThumbs, children: viewer.images.map((im, i) => {
                                const t = (snsImgs[imgKey(im)] || im.thumb || im.url || '');
                                return (_jsx("img", { src: t || '', alt: "", className: [css.lightboxThumb, i === viewer.index ? css.lightboxThumbActive : ''].filter(Boolean).join(' '), onClick: () => { setViewerIndex(i); }, onError: (e) => {
                                        // 如果当前src是CDN URL（非data URL），隐藏缩略图
                                        if (!t.startsWith('data:')) {
                                            e.currentTarget.style.display = 'none';
                                        }
                                    } }, i));
                            }) }))] }) }), document.body), detail && createPortal(_jsx("div", { className: css.overlay, onClick: () => { setDetail(null); }, role: "dialog", children: _jsxs("div", { className: css.detailCard, onClick: (e) => { e.stopPropagation(); }, children: [_jsxs("div", { className: css.lightboxHead, children: [_jsxs("span", { children: [detail.m.author || '未知', " \u00B7 ", detail.m.time] }), _jsx("button", { type: "button", className: css.btn, onClick: () => { setDetail(null); }, "aria-label": "\u5173\u95ED", children: "\u00D7" })] }), _jsxs("div", { className: css.detailBody, children: [detail.m.text && _jsx("div", { className: css.content, children: detail.m.text }), detail.m.images.length > 0 && (_jsx("div", { className: [css.images, detail.m.images.length === 1 ? css.imagesSingle : ''].filter(Boolean).join(' '), children: detail.m.images.map((im, ii) => {
                                        const key = imgKey(im);
                                        const dataSrc = key ? snsImgs[key] : undefined;
                                        const haveSrc = !!(dataSrc || im.thumb || im.url);
                                        return (_jsx("div", { className: css.imgWrap, role: "button", title: "\u70B9\u51FB\u67E5\u770B\u5927\u56FE", onClick: () => { setViewer({ images: detail.m.images, index: ii, author: detail.m.author }); }, children: haveSrc
                                                ? _jsx("img", { src: dataSrc || im.thumb || im.url || '', alt: "", loading: "lazy", referrerPolicy: "no-referrer", className: css.img, onError: (e) => {
                                                        // 如果当前src是CDN URL（非data URL），隐藏图片
                                                        const currentSrc = dataSrc || im.thumb || im.url || '';
                                                        if (!currentSrc.startsWith('data:')) {
                                                            e.currentTarget.style.display = 'none';
                                                        }
                                                    } })
                                                : _jsx("div", { className: css.imgFallback, children: "\u52A0\u8F7D\u4E2D" }) }, ii));
                                    }) })), detail.m.videos.length > 0 && (_jsx("div", { className: css.videos, children: detail.m.videos.map((v, vi) => {
                                        const vk = v.md5 ? 'v:' + v.md5 : (v.timelineId && v.id ? 'v:' + v.timelineId + ':' + v.id : '');
                                        const vCover = (vk ? snsImgs[vk] : undefined) || v.thumb || '';
                                        const src = vk ? videoSrcs[vk] : undefined;
                                        const playing = !!src;
                                        return (_jsx("div", { className: [css.videoTile, playing ? css.videoTilePlaying : '', playing ? css.videoTileDetail : ''].filter(Boolean).join(' '), title: v.url || v.md5 || '', role: playing ? undefined : 'button', onClick: playing ? undefined : () => { loadVideo(vk, v); }, children: playing
                                                ? _jsxs(_Fragment, { children: [_jsx("video", { className: css.videoPlayer, src: src, controls: true, autoPlay: true, poster: vCover || '' }), _jsx("button", { className: css.fullscreenBtn, title: "\u5168\u5C4F", onClick: (e) => { e.stopPropagation(); fullscreenVideo(e.currentTarget.closest('.videoTile')); }, children: "\u26F6" })] })
                                                : vCover
                                                    ? _jsxs(_Fragment, { children: [_jsx("img", { className: css.videoCover, src: vCover, alt: "", loading: "lazy", referrerPolicy: "no-referrer", onError: (e) => {
                                                                    // 如果当前src是CDN URL（非data URL），隐藏图片
                                                                    if (!vCover.startsWith('data:')) {
                                                                        e.currentTarget.style.display = 'none';
                                                                    }
                                                                } }), _jsx("span", { className: css.videoPlayBadge, children: "\u25B6" }), v.duration > 0 && (_jsxs("span", { className: css.videoDur, children: [Math.round(v.duration), "s"] }))] })
                                                    : _jsxs(_Fragment, { children: [_jsx("span", { className: css.videoBadge, children: videoFailed.has(vk) ? '×' : '▶' }), v.duration > 0 && (_jsxs("span", { className: css.videoDur, children: [Math.round(v.duration), "s"] }))] }) }, vi));
                                    }) })), detail.m.link_title && (_jsx("div", { className: css.linkCard, children: _jsxs("div", { className: css.linkBody, children: [detail.m.link_url
                                                ? _jsx("a", { className: css.linkTitle, href: detail.m.link_url, target: "_blank", rel: "noopener noreferrer", children: detail.m.link_title })
                                                : _jsx("span", { className: css.linkTitle, children: detail.m.link_title }), _jsx("div", { className: css.linkSub, children: detail.m.sourceNickName ? '公众号 · ' + detail.m.sourceNickName : (detail.m.contentType === 28 ? '视频号' : '链接') })] }) })), detail.m.location && _jsx("div", { className: css.tags, children: _jsxs("span", { className: css.tag, children: ["\uD83D\uDCCD ", detail.m.location] }) }), detail.m.likes.length > 0 && (_jsxs("div", { className: css.likesRow, children: [_jsxs("span", { className: css.likesCount, children: ["\u2764 ", detail.m.likes.length] }), _jsx("span", { className: css.likeNames, children: detail.m.likes.map((l, idx) => (_jsxs(Fragment, { children: [_jsx(MomentsMiniAvatar, { username: l.username, name: l.nickname || l.username }), _jsx("span", { className: css.clickableName, title: '只看 ' + (l.nickname || l.username), onClick: (e) => { e.stopPropagation(); setAuthorFilter(l.nickname || l.username || null); }, children: l.nickname || l.username || '未知' }), idx < detail.m.likes.length - 1 ? '、' : null] }, idx))) })] })), detail.m.comments.length > 0 && (_jsx("div", { className: css.comments, children: detail.m.comments.map((c, ci) => {
                                        const target = replyTarget(detail.m, c);
                                        const img = c.image;
                                        const cdata = (img?.md5 && snsImgs[img.md5]) || '';
                                        return (_jsxs("div", { className: css.comment, children: [_jsx(MomentsMiniAvatar, { username: c.username, name: c.nickname || c.username }), _jsx("span", { className: css.commentName, title: '只看 ' + (c.nickname || c.username), onClick: (e) => { e.stopPropagation(); setAuthorFilter(c.nickname || c.username || null); }, children: c.nickname || c.username || '未知' }), c.to_username && c.to_username !== detail.m.username && _jsxs("span", { className: css.commentReply, children: ["\u56DE\u590D ", c.to_nickname || c.to_username, target ? '：' : ''] }), target && _jsxs("span", { className: css.commentQuote, children: ["\u201C", target.content.slice(0, 40), "\u201D"] }), _jsx("span", { className: css.commentText, children: c.content || '' }), img && (cdata || img.thumb || img.url) && (_jsx("img", { src: cdata || img.thumb || img.url || '', alt: "", loading: "lazy", referrerPolicy: "no-referrer", className: css.commentImg, onClick: () => { setViewer({ images: [{ thumb: img.thumb, url: img.url, md5: img.md5 }], index: 0, author: (c.nickname || c.username || '') }); } }, 'img' + String(ci))), c.ts > 0 && _jsx("span", { className: css.commentTime, children: fmtCommentTime(c.ts) })] }, ci));
                                    }) }))] })] }) }), document.body), exportOpen && (_jsx("div", { className: css.overlay, onClick: () => { setExportOpen(false); }, role: "dialog", children: _jsxs("div", { className: css.lightbox, onClick: (e) => { e.stopPropagation(); }, children: [_jsxs("div", { className: css.lightboxHead, children: [_jsx("span", { children: "\u5BFC\u51FA\u670B\u53CB\u5708" }), _jsx("button", { type: "button", className: css.btn, onClick: () => { setExportOpen(false); }, "aria-label": "\u5173\u95ED", children: "\u00D7" })] }), _jsxs("div", { className: css.exportForm, children: [_jsxs("div", { className: css.exportField, children: [_jsx("span", { className: css.exportLabel, children: "\u683C\u5F0F" }), _jsx("div", { className: css.exportChips, children: ['html', 'json', 'txt', 'csv'].map(f => (_jsx("button", { type: "button", className: css.btn, "data-on": expFormat === f || undefined, onClick: () => { setExpFormat(f); }, children: f.toUpperCase() }, f))) })] }), _jsxs("div", { className: css.exportField, children: [_jsx("span", { className: css.exportLabel, children: "\u8303\u56F4" }), _jsx("span", { className: css.exportHint, children: (() => {
                                                const parts = [];
                                                if (authorFilter)
                                                    parts.push('作者：' + authorFilter);
                                                if (author)
                                                    parts.push('指定用户：' + author);
                                                if (search.trim())
                                                    parts.push('关键词：' + search.trim());
                                                if (mediaFilter !== 'all')
                                                    parts.push('类型：' + MEDIA_LABELS[mediaFilter]);
                                                if (monthFilter)
                                                    parts.push('月份：' + monthFilter);
                                                if (mineFilter !== 'all')
                                                    parts.push('范围：' + (mineFilter === 'mine' ? '我' : '他人'));
                                                return (parts.length > 0 ? parts.join(' · ') : '全部联系人') + ' · 服务端全量';
                                            })() })] }), _jsxs("div", { className: css.exportField, children: [_jsx("span", { className: css.exportLabel, children: "\u65F6\u95F4" }), _jsxs("div", { className: css.exportChips, children: [_jsx("input", { type: "date", value: expFrom, onChange: (e) => { setExpFrom(e.target.value); }, className: css.search }), _jsx("span", { children: "\u81F3" }), _jsx("input", { type: "date", value: expTo, onChange: (e) => { setExpTo(e.target.value); }, className: css.search })] })] }), _jsxs("div", { className: css.exportField, children: [_jsx("span", { className: css.exportLabel, children: "\u76EE\u5F55" }), _jsxs("div", { className: css.exportChips, children: [_jsxs("button", { type: "button", className: css.btn, onClick: () => { void pickDir(); }, disabled: pickingDir, children: ["\u9009\u62E9\u76EE\u5F55", expDir ? ' ✓' : ''] }), expDir && _jsx("span", { className: css.exportHint, title: expDir, children: expDir })] })] }), _jsxs("div", { className: css.exportField, children: [_jsx("span", { className: css.exportLabel, children: "\u5A92\u4F53" }), _jsxs("div", { className: css.exportChips, children: [_jsxs("label", { className: css.exportCheck, title: "HTML \u5BFC\u51FA\u65F6\u5185\u5D4C\u79BB\u7EBF\u89E3\u7801\u56FE\u7247\uFF08base64\uFF09\uFF0C\u4F53\u79EF\u8F83\u5927", children: [_jsx("input", { type: "checkbox", checked: expImages, onChange: (e) => { setExpImages(e.target.checked); }, disabled: expFormat !== 'html' }), _jsx("span", { children: "HTML \u5185\u5D4C\u79BB\u7EBF\u56FE\u7247" })] }), _jsxs("label", { className: css.exportCheck, title: "\u628A\u52A8\u6001 JSON + \u79BB\u7EBF\u56FE\u7247/\u89C6\u9891\u6253\u5305\u6210\u4E00\u4E2A ZIP\uFF08\u5A92\u4F53\u8F83\u591A\u65F6\u4F53\u79EF\u5927\uFF09", children: [_jsx("input", { type: "checkbox", checked: expZip, onChange: (e) => { setExpZip(e.target.checked); } }), _jsx("span", { children: "ZIP \u542B\u5A92\u4F53" })] })] })] }), _jsx("button", { type: "button", className: css.btn, style: { alignSelf: 'flex-end' }, onClick: () => { void doExport(); }, disabled: exporting, children: exporting ? '导出中…' : '导出' })] })] }) }))] }));
}
//# sourceMappingURL=Moments.js.map