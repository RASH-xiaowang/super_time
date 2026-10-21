/**
 * 「总览·战术分析」分片级聚合的**跨启动**缓存（2026-10-21 性能专项）。
 *
 * ## 为什么
 *
 * `getOverviewInsights` 冷启动实测 **391ms**，其中 191ms 是「对每个消息分片的
 * 全部 Msg_ 表各跑一次 GROUP BY」——这是首屏最贵的单笔 CPU。但它的输入是**已解密
 * 不再变化的库文件**：同一份数据第二次启动还会再算一遍，纯属重复劳动。
 * 已有的内存缓存（`insightsShardCache`）只覆盖同一进程内的重复调用（TTL 到期后仍要重算），
 * 跨进程完全不生效。本模块把这份「按分片的可加聚合」落到数据根旁的 cache 目录。
 *
 * ## 正确性边界
 *
 *  - 每条记录都带**指纹**：`key` 里已含 contact/session 的 sig，`sig` 是分片文件自身的
 *    `fileSigOf`（含 SQLite 变更计数器）。读取端（`applyCachedShard`）命中前逐字比对 `sig`，
 *    不匹配就当未命中 —— 数据一变（同步/解密）自动失效，不依赖 TTL。
 *  - 文件是**纯缓存**：不存在/损坏/没权限都按「空缓存」处理，绝不影响查询结果。
 *  - 原子写：先写 `.tmp` 再 rename，避免进程被杀时留下半个 JSON 被下次当成有效缓存。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 磁盘缓存里的一条分片聚合（`agg` 的具体形状由调用方定义）。 */
export interface InsightsShardCacheEntry<T> {
  key: string
  sig: string
  agg: T
}

/** 磁盘缓存的格式版本：形状变了就换 v2，旧文件自然不会被读。 */
const CACHE_VERSION = 1
const CACHE_FILE = 'insights-shards.v' + CACHE_VERSION + '.json'
/** 单个缓存文件的大小上限：超过视为异常文件，不读（防止坏数据把启动拖住）。 */
const MAX_BYTES = 16 * 1024 * 1024

/**
 * 分片聚合磁盘缓存的位置：`<数据根>/cache/insights-shards.v1.json`
 * （`dec` 是 `<数据根>/decrypted`）。
 * @param dec - 已解密数据根。
 * @returns 缓存文件绝对路径。
 */
export function insightsShardCachePath(dec: string): string {
  return join(dirname(dec), 'cache', CACHE_FILE)
}

/**
 * 读取磁盘缓存。任何异常都退化为空 Map。
 * @param path - `insightsShardCachePath()` 的返回值。
 * @returns key → 记录。
 */
export function loadInsightsShardCache<T>(path: string): Map<string, InsightsShardCacheEntry<T>> {
  const out = new Map<string, InsightsShardCacheEntry<T>>()
  try {
    if (!existsSync(path)) return out
    const text = readFileSync(path, 'utf8')
    if (text.length > MAX_BYTES) return out
    const parsed: unknown = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return out
    const entries = (parsed as { entries?: unknown }).entries
    if (!Array.isArray(entries)) return out
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object') continue
      const e = raw as { key?: unknown; sig?: unknown; agg?: unknown }
      if (typeof e.key !== 'string' || typeof e.sig !== 'string' || e.agg === undefined) continue
      out.set(e.key, { key: e.key, sig: e.sig, agg: e.agg as T })
    }
  } catch { /* 损坏/权限/半写文件：当作没有缓存 */ }
  return out
}

/**
 * 原子写入磁盘缓存。
 * @param path - `insightsShardCachePath()` 的返回值。
 * @param entries - 要持久化的记录（调用方已按 LRU 上限裁剪）。
 * @returns true = 写入成功（失败只返回 false，不抛）。
 */
export function saveInsightsShardCache<T>(path: string, entries: Array<InsightsShardCacheEntry<T>>): boolean {
  const tmp = path + '.tmp'
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, entries }), 'utf8')
    renameSync(tmp, path)
    return true
  } catch {
    try { writeFileSync(tmp, '', 'utf8') } catch { /* 清理失败也不影响 */ }
    return false
  }
}
