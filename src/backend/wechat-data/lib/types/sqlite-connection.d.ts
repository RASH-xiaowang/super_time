/**
 * SQLite 连接的底层策略边界。
 *
 * `dirs.ts` 这类 base 叶子也需要打开只读库，但它不能反向依赖 `query/db-open.ts`。
 * 因此把「构造器包装 + 页缓存配置」单独放在这一层，query 侧的连接生命周期助手
 * （`withDb` / `withWritableDb` / `withDbAsync`）从这里复用同一个构造器。
 *
 * 生产代码不再直接 import `node:sqlite`；实例仍是原生 `DatabaseSync`，只在新连接上
 * 应用统一页缓存策略，不需要宿主替换 node:sqlite 的全局导出。
 */
import { DatabaseSync as NativeDatabaseSync } from 'node:sqlite';
export type DatabaseSync = NativeDatabaseSync;
/**
 * 覆盖读/写连接的页缓存。宿主在 bundle 加载后、网关建好前调用；
 * 未调用时使用默认值，因此直接加载 query 模块的测试也能得到一致行为。
 */
export declare function configureSqliteCachePolicy(input?: {
    readOnlyKb?: unknown;
    writableKb?: unknown;
}): void;
/**
 * sqlite 连接统计快照。
 *
 * 为什么需要：第五轮 heap 归因发现 worker 空闲时 `external` 有 53MB 而 `arrayBuffers=0`，
 * 更像是 node:sqlite 的堆外内存 —— 一个可疑来源是**同时开着的连接数**（每连接 256KB 页缓存
 * × N）。没有运行时读数就只能猜；这里给 `[mem]` 行提供 open/peak 事实。
 * @returns {{ open: number, peak: number }} 当前打开数与历史峰值。
 */
export declare function sqliteConnectionStats(): {
    open: number;
    peak: number;
};
/**
 * 包装构造器而不改动 node:sqlite 的实例类型：`instanceof DatabaseSync`
 * 与所有实例 API 保持不变，只在新连接上应用本模块统一的页缓存策略。
 */
export declare const DatabaseSync: typeof NativeDatabaseSync;
/**
 * 给一条（已打开的）只读连接临时调大页缓存。
 *
 * 0 / 负数表示不干预（沿用连接创建时的策略）；非数字按默认 8MB 兜底。
 * @param db - 已打开的连接（通常是 `readOnly` 的分析连接）。
 * @param kbOverride - 显式覆盖（KB）；缺省读 `DSH_WECHAT_ANALYTICS_CACHE_KB`。
 */
export declare function raiseAnalyticsCache(db: DatabaseSync, kbOverride?: unknown): void;
