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
import { DatabaseSync as NativeDatabaseSync } from 'node:sqlite'

type DatabaseSyncOptions = NonNullable<ConstructorParameters<typeof NativeDatabaseSync>[1]>

export type DatabaseSync = NativeDatabaseSync

/** 默认保持与原宿主全局 patch 相同的行为；写连接可单独调大而不放大短读连接的 RSS。 */
const DEFAULT_CACHE_KB = 256

let readCacheKb = DEFAULT_CACHE_KB
let writableCacheKb = DEFAULT_CACHE_KB

/**
 * 0 / 负数保留旧宿主的「不干预」语义（让 SQLite 用自己默认的 -2000）；
 * 非数字配置按默认值兜底，避免把拼错的环境变量当成有意关闭。
 */
function resolveCacheKb(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return n > 0 ? Math.floor(n) : 0
}

/**
 * 覆盖读/写连接的页缓存。宿主在 bundle 加载后、网关建好前调用；
 * 未调用时使用默认值，因此直接加载 query 模块的测试也能得到一致行为。
 */
export function configureSqliteCachePolicy(input: { readOnlyKb?: unknown; writableKb?: unknown } = {}): void {
  const shared = resolveCacheKb(process.env.DSH_WECHAT_SQLITE_CACHE_KB, DEFAULT_CACHE_KB)
  readCacheKb = resolveCacheKb(input.readOnlyKb ?? shared, DEFAULT_CACHE_KB)
  writableCacheKb = resolveCacheKb(
    input.writableKb ?? resolveCacheKb(process.env.DSH_WECHAT_SQLITE_WRITE_CACHE_KB, shared),
    DEFAULT_CACHE_KB,
  )
}

/**
 * 包装构造器而不改动 node:sqlite 的实例类型：`instanceof DatabaseSync`
 * 与所有实例 API 保持不变，只在新连接上应用本模块统一的页缓存策略。
 */
export const DatabaseSync = new Proxy(NativeDatabaseSync, {
  construct(target, args) {
    const db = Reflect.construct(target, args)
    const options = args[1] as DatabaseSyncOptions | undefined
    const kb = options?.readOnly === true ? readCacheKb : writableCacheKb
    if (kb > 0) {
      try {
        db.exec(`PRAGMA cache_size = -${kb}`)
      } catch {
        /* 个别连接不接受该 PRAGMA，保持旧实现的降级行为。 */
      }
    }
    return db
  },
}) as typeof NativeDatabaseSync

// 模块加载时先按环境变量确定默认值；宿主随后仍可显式覆盖。
configureSqliteCachePolicy()
