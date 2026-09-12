export declare function useProgressiveList(len: number, step?: number): {
    count: number;
    grow: () => void;
    reveal: (n: number) => void;
    sentinelRef: (el: HTMLDivElement | null) => void;
};
/** 哨兵容器:占位两个像素,IntersectionObserver 观察它即可触发渐进加载。 */
export declare function ListSentinel({ refFn }: {
    refFn: (el: HTMLDivElement | null) => void;
}): React.JSX.Element;
/**
 * 分页哨兵：滚动到可视区附近时回调一次（用于「加载更多」而非仅渐进 DOM 渲染）。
 * 传入的 onVisible 保存在 ref 中，避免每次渲染重建观察器。
 */
export declare function useLazySentinel(onVisible: () => void, rootMargin?: string, root?: () => Element | null): (el: HTMLDivElement | null) => void;
/**
 * 骨架屏:数据未到时先渲染框架占位(微光动画),不让整页被"加载中…"卡住。
 * 行模式用于列表,网格模式用于卡片格子。
 */
export declare function ListSkeleton({ rows, grid }: {
    rows?: number;
    grid?: boolean;
}): React.JSX.Element;
/**
 * 订阅宿主「微信数据已更新」事件（真实同步把新数据解密进快照后由宿主派发）。
 * 用 ref 保存最新 handler，避免每次渲染重复订阅；事件触发时调用 ref.current()，
 * 始终拿到最新闭包。相比固定轮询，能按需、即时刷新。
 * @param handler - 数据落地后的刷新回调。
 */
export declare function useWechatDataUpdated(handler: () => void, eventName?: string): void;
/**
 * 懒挂载容器：子元素进入可视区附近时才渲染。用于地图、重型图表或统计区块，
 * 避免打开页签时把不可见的重资源一次性加载/渲染。
 */
export declare function LazyMount({ children, rootMargin, placeholder, onShow }: {
    children: React.ReactNode;
    rootMargin?: string;
    placeholder?: React.ReactNode;
    onShow?: () => void;
}): React.JSX.Element;
/**
 * 通用分页加载器：首次装载拉第一页，`loadMore` 追加下一页（offset 分页），
 * `reset` 在筛选/关键词变化时重新从第一页加载。`fetchPage` 使用 ref 持有，
 * 调用方每次渲染传新函数也不会触发重复加载。
 */
export declare function usePagedList<T>(options: {
    pageSize: number;
    fetchPage: (offset: number, limit: number) => Promise<{
        items: readonly T[];
        total: number;
    }>;
}): {
    items: readonly T[];
    total: number;
    loading: boolean;
    loadingMore: boolean;
    error: string | null;
    hasMore: boolean;
    loadMore: () => void;
    reset: () => void;
};
//# sourceMappingURL=hooks.d.ts.map