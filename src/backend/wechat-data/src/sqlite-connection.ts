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

/** 我们自己创建的连接标记（关闭计数只认自己，不误统计调用方自建的实例）。 */
const OWNED = Symbol('rea-sqlite-owned')

/** 当前打开连接数与历史峰值（内存归因：每条连接至少持有一份页缓存）。 */
let openConnections = 0
let peakConnections = 0

/**
 * sqlite 连接统计快照。
 *
 * 为什么需要：第五轮 heap 归因发现 worker 空闲时 `external` 有 53MB 而 `arrayBuffers=0`，
 * 更像是 node:sqlite 的堆外内存 —— 一个可疑来源是**同时开着的连接数**（每连接 256KB 页缓存
 * × N）。没有运行时读数就只能猜；这里给 `[mem]` 行提供 open/peak 事实。
 * @returns {{ open: number, peak: number }} 当前打开数与历史峰值。
 */
export function sqliteConnectionStats(): { open: number, peak: number } {
  return { open: openConnections, peak: peakConnections }
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
    try {
      ;(db as unknown as Record<symbol, unknown>)[OWNED] = true
      openConnections += 1
      if (openConnections > peakConnections) peakConnections = openConnections
    } catch { /* 统计失败不影响连接本身 */ }
    return db
  },
}) as typeof NativeDatabaseSync

// 关闭计数：`close` 在原生原型上，这里在模块加载时包一层原型。
// 用 OWNED 标记只统计本模块创建的连接；若测试再包一层原型（image-batch 的 openCounter 就是这么做的），
// 它的 wrapper 会调用到这一层，计数仍然成立。
const nativeClose = NativeDatabaseSync.prototype.close
try {
  NativeDatabaseSync.prototype.close = function patchedClose(
    this: InstanceType<typeof NativeDatabaseSync>,
    ...args: Parameters<typeof nativeClose>
  ) {
    const result = nativeClose.apply(this, args)
    try {
      const self = this as unknown as Record<symbol, unknown>
      if (self[OWNED] === true) {
        self[OWNED] = false
        openConnections = Math.max(0, openConnections - 1)
      }
    } catch { /* 统计失败不影响关闭 */ }
    return result
  } as typeof nativeClose
} catch { /* 原型被冻结的环境：统计退化为只计打开数（peak 仍可用） */ }

// 模块加载时先按环境变量确定默认值；宿主随后仍可显式覆盖。
configureSqliteCachePolicy()

/**
 * 分析型只读查询的临时页缓存（KB）。
 *
 * 全局读缓存 256KB 是**为短读连接**定的（不让每个连接都吃几 MB RSS）。但像
 * `getStorageStats` 这种「一次扫描 29MB 的 message_resource.db、还要按 message_id
 * 随机 JOIN 回 MessageResourceInfo」的查询会被 256KB 打穿：实测同一条 chats+senders
 * 查询 **233ms → 64ms（3.6×）**，4MB 就回落到 74ms，8MB 之后进入平台期。
 *
 * 因此这里只给**这一条连接**抬高页缓存：查询结束连接即关闭，不会让常驻 RSS 涨上去。
 */
const DEFAULT_ANALYTICS_CACHE_KB = 8 * 1024

/**
 * 给一条（已打开的）只读连接临时调大页缓存。
 *
 * 0 / 负数表示不干预（沿用连接创建时的策略）；非数字按默认 8MB 兜底。
 * @param db - 已打开的连接（通常是 `readOnly` 的分析连接）。
 * @param kbOverride - 显式覆盖（KB）；缺省读 `DSH_WECHAT_ANALYTICS_CACHE_KB`。
 */
export function raiseAnalyticsCache(db: DatabaseSync, kbOverride?: unknown): void {
  const kb = resolveCacheKb(kbOverride ?? process.env.DSH_WECHAT_ANALYTICS_CACHE_KB, DEFAULT_ANALYTICS_CACHE_KB)
  if (kb <= 0) return
  try {
    db.exec(`PRAGMA cache_size = -${kb}`)
  } catch {
    /* 个别连接不接受该 PRAGMA：保持连接创建时的策略，不影响查询本身。 */
  }
}
