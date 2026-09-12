import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 渐进式列表渲染 hook:大数据量列表先渲染前 `step` 项,滚动到底部哨兵
 * 出现时再增量增加,避免一次性渲染上千 DOM 节点导致卡顿。
 * 数据长度变化时自动钳制回合法范围。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
export function useProgressiveList(len, step = 120) {
    const [count, setCount] = useState(() => Math.min(step, len));
    const io = useRef(null);
    const sentinelRef = useCallback((el) => {
        if (io.current) {
            io.current.disconnect();
            io.current = null;
        }
        if (!el || typeof IntersectionObserver === 'undefined') {
            // 无 IO 支持时直接全量,保证数据可见
            setCount(c => (c < len ? Math.max(len, c) : c));
            return;
        }
        const obs = new IntersectionObserver((entries) => {
            if (entries[0]?.isIntersecting)
                setCount(c => Math.min(c + step, len));
        }, { root: null, rootMargin: '600px 0px' });
        obs.observe(el);
        io.current = obs;
    }, [step, len]);
    const grow = useCallback(() => {
        setCount(c => Math.min(c + step, len));
    }, [step, len]);
    /** 至少渲染到第 n 项（定位跳转等场景需要目标项立刻在 DOM 里）。
     *  不做上限钳制：调用时闭包里的 len 可能已过期，返回的 count 会按最新
     *  len 钳制，超出部分自然被忽略。 */
    const reveal = useCallback((n) => {
        setCount(c => Math.max(c, n));
    }, []);
    return { count: Math.min(count, len), grow, reveal, sentinelRef };
}
/** 哨兵容器:占位两个像素,IntersectionObserver 观察它即可触发渐进加载。 */
export function ListSentinel({ refFn }) {
    return _jsx("div", { ref: refFn, style: { height: 2, flexShrink: 0 }, "aria-hidden": "true" });
}
/**
 * 分页哨兵：滚动到可视区附近时回调一次（用于「加载更多」而非仅渐进 DOM 渲染）。
 * 传入的 onVisible 保存在 ref 中，避免每次渲染重建观察器。
 */
export function useLazySentinel(onVisible, rootMargin = '600px 0px', root) {
    const cbRef = useRef(onVisible);
    cbRef.current = onVisible;
    const rootRef = useRef(root);
    rootRef.current = root;
    const ioRef = useRef(null);
    return useCallback((el) => {
        if (ioRef.current) {
            ioRef.current.disconnect();
            ioRef.current = null;
        }
        if (!el || typeof IntersectionObserver === 'undefined')
            return;
        const rootEl = rootRef.current?.() ?? null;
        const ob = new IntersectionObserver((entries) => {
            if (entries[0]?.isIntersecting)
                cbRef.current();
        }, { root: rootEl, rootMargin });
        ob.observe(el);
        ioRef.current = ob;
    }, [rootMargin]);
}
/**
 * 骨架屏:数据未到时先渲染框架占位(微光动画),不让整页被"加载中…"卡住。
 * 行模式用于列表,网格模式用于卡片格子。
 */
export function ListSkeleton({ rows = 8, grid = false }) {
    return (_jsx("div", { style: { display: 'grid', gridTemplateColumns: grid ? 'repeat(auto-fill, minmax(120px, 1fr))' : '1fr', gap: 10, padding: 10, width: '100%', boxSizing: 'border-box' }, "aria-hidden": "true", children: Array.from({ length: rows }).map((_, i) => (_jsx("div", { className: "nm-skel", style: grid
                ? { height: 120 }
                : { height: 46, display: 'flex', alignItems: 'center', gap: 10, padding: '0 10px' }, children: !grid && (_jsxs(_Fragment, { children: [_jsx("span", { className: "nm-skel", style: { width: 34, height: 34, borderRadius: 9, flexShrink: 0 } }), _jsx("span", { className: "nm-skel", style: { width: '55%', height: 12, flexShrink: 1 } }), _jsx("span", { className: "nm-skel", style: { width: 60, height: 10, flexShrink: 0, marginLeft: 'auto' } })] })) }, i))) }));
}
/**
 * 订阅宿主「微信数据已更新」事件（真实同步把新数据解密进快照后由宿主派发）。
 * 用 ref 保存最新 handler，避免每次渲染重复订阅；事件触发时调用 ref.current()，
 * 始终拿到最新闭包。相比固定轮询，能按需、即时刷新。
 * @param handler - 数据落地后的刷新回调。
 */
export function useWechatDataUpdated(handler, eventName = 'dsh-wechat-data-updated') {
    const ref = useRef(handler);
    ref.current = handler;
    useEffect(() => {
        const on = () => {
            ref.current();
        };
        window.addEventListener(eventName, on);
        return () => { window.removeEventListener(eventName, on); };
    }, [eventName]);
}
/**
 * 懒挂载容器：子元素进入可视区附近时才渲染。用于地图、重型图表或统计区块，
 * 避免打开页签时把不可见的重资源一次性加载/渲染。
 */
export function LazyMount({ children, rootMargin = '600px 0px', placeholder = null, onShow }) {
    const ref = useRef(null);
    const [show, setShow] = useState(false);
    const shownRef = useRef(false);
    const onShowRef = useRef(onShow);
    onShowRef.current = onShow;
    const reveal = () => {
        setShow(true);
        if (!shownRef.current) {
            shownRef.current = true;
            onShowRef.current?.();
        }
    };
    useEffect(() => {
        if (!ref.current || typeof IntersectionObserver === 'undefined') {
            reveal();
            return;
        }
        const ob = new IntersectionObserver((entries) => {
            if (entries[0]?.isIntersecting) {
                reveal();
                ob.disconnect();
            }
        }, { root: null, rootMargin });
        ob.observe(ref.current);
        return () => { ob.disconnect(); };
    }, [rootMargin]);
    return _jsx("div", { ref: ref, children: show ? children : placeholder });
}
/**
 * 通用分页加载器：首次装载拉第一页，`loadMore` 追加下一页（offset 分页），
 * `reset` 在筛选/关键词变化时重新从第一页加载。`fetchPage` 使用 ref 持有，
 * 调用方每次渲染传新函数也不会触发重复加载。
 */
export function usePagedList(options) {
    const { pageSize } = options;
    const fetchPageRef = useRef(options.fetchPage);
    fetchPageRef.current = options.fetchPage;
    const [items, setItems] = useState([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState(null);
    const [lastCount, setLastCount] = useState(0);
    const offsetRef = useRef(0);
    const seqRef = useRef(0);
    const busyRef = useRef(false);
    const load = useCallback(async (append, force = false) => {
        if (busyRef.current && !force)
            return;
        busyRef.current = true;
        const seq = ++seqRef.current;
        const offset = append ? offsetRef.current : 0;
        if (append)
            setLoadingMore(true);
        else {
            setItems([]);
            setTotal(0);
            setLastCount(0);
            setLoading(true);
            setError(null);
        }
        try {
            const r = await fetchPageRef.current(offset, pageSize);
            if (seq !== seqRef.current)
                return;
            const list = r.items;
            setItems(prev => append ? [...prev, ...list] : list);
            setTotal(r.total);
            setLastCount(list.length);
            offsetRef.current = offset + list.length;
        }
        catch (e) {
            if (seq === seqRef.current)
                setError(e.message);
        }
        finally {
            if (seq === seqRef.current) {
                setLoading(false);
                setLoadingMore(false);
                busyRef.current = false;
            }
        }
    }, [pageSize]);
    const loadMore = useCallback(() => { void load(true); }, [load]);
    const reset = useCallback(() => {
        seqRef.current += 1;
        offsetRef.current = 0;
        busyRef.current = false;
        void load(false, true);
    }, [load]);
    return {
        items,
        total,
        loading,
        loadingMore,
        error,
        hasMore: items.length < total && lastCount === pageSize,
        loadMore,
        reset,
    };
}
//# sourceMappingURL=hooks.js.map