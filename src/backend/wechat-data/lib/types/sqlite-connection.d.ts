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
 * 包装构造器而不改动 node:sqlite 的实例类型：`instanceof DatabaseSync`
 * 与所有实例 API 保持不变，只在新连接上应用本模块统一的页缓存策略。
 */
export declare const DatabaseSync: typeof NativeDatabaseSync;
