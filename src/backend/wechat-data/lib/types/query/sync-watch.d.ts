/** 事件防抖：一个写入簇合并成一次触发。 */
export declare const WATCH_DEBOUNCE_MS = 400;
/** 触发限频：两次监听触发的最小间隔（轮询兜底不受影响）。 */
export declare const WATCH_MIN_GAP_MS = 1500;
/** 监听器的最小接口（真机是 `node:fs` 的 FSWatcher，单测注入假件）。 */
export interface SyncWatcherLike {
    close(): void;
    on(event: 'error', cb: (err: Error) => void): unknown;
}
/** 可注入依赖：单测给假 watch / 假时钟；缺省走真 `node:fs` 与 `Date.now`。 */
export interface SyncWatchDeps {
    watchDir?: (dir: string, onChange: (eventType: string, filename: string | null) => void) => SyncWatcherLike | null;
    now?: () => number;
}
export interface SyncWatchHandle {
    /** 每拍都带当前 raw 根调用：目录变了就重挂监听（报错后也靠它自愈）。 */
    refresh(dir: string): void;
    stop(): void;
}
/**
 * 启动原始库目录的 WAL 监听：目录内任何写入（追加/新建/rename）经防抖与限频后
 * 调一次 `onTrigger`。挂载失败或运行期报错只上报一次（`onWatchError`），
 * 且监听被摘掉后由调用方下一拍 `refresh` 重挂。
 * @param opts - `onTrigger` 是合并后的一次触发；`onAttached` 在每次新挂载成功时回调
 *   （供诊断日志/探针确认监听真的挂在哪个目录上）；`onWatchError` 可选。
 * @param deps - 测试注入点（缺省走真 fs.watch / Date.now）。
 * @returns `refresh` / `stop` 句柄。
 */
export declare function startSyncWatch(opts: {
    onTrigger: () => void;
    onAttached?: (dir: string) => void;
    onWatchError?: (message: string) => void;
}, deps?: SyncWatchDeps): SyncWatchHandle;
