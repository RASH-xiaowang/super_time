/**
 * 「总览·战术分析」分片聚合磁盘缓存（2026-10-21 性能专项）。
 *
 * 为什么需要：`getOverviewInsights` 冷启动 391ms 里 191ms 是「每分片 239 张 Msg_ 表
 * 各跑一次 GROUP BY」，同一份解密数据第二次启动还要重算。磁盘缓存让第二次启动命中。
 *
 * 判据：① 往返一致；② 缺失/损坏文件退化为空缓存（**绝不能**返回错数）；
 * ③ 原子写（不留 .tmp）；④ 写失败只返回 false，不抛；⑤ 接线守卫（compute 里真的
 * hydrate/persist 了，且命中判断仍是逐字比对 sig）。
 * @vitest-environment node
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  insightsShardCachePath,
  loadInsightsShardCache,
  saveInsightsShardCache,
} from '../src/query/insights-shard-store.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

/** 临时目录（返回目录本身，缓存路径由被测函数拼）。 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'insights-store-'))
  scratch.push(dir)
  return dir
}

describe('insights-shard-store', () => {
  it('save → load 往返一致（含条数/键/指纹/聚合）', () => {
    const dir = tempDir()
    const path = insightsShardCachePath(join(dir, 'decrypted'))
    const entries = [
      { key: 'a#self#1', sig: 'sig-a', agg: { n: 10, dayCounts: [[1, 2]] } },
      { key: 'b#self#1', sig: 'sig-b', agg: { n: 20, dayCounts: [] } },
    ]
    expect(saveInsightsShardCache(path, entries)).toBe(true)
    const loaded = loadInsightsShardCache<{ n: number; dayCounts: number[][] }>(path)
    expect(loaded.size).toBe(2)
    expect(loaded.get('a#self#1')).toEqual(entries[0])
    expect(loaded.get('b#self#1')?.agg.n).toBe(20)
  })

  it('原子写：成功后不留 .tmp', () => {
    const dir = tempDir()
    const path = insightsShardCachePath(join(dir, 'decrypted'))
    expect(saveInsightsShardCache(path, [{ key: 'k', sig: 's', agg: {} }])).toBe(true)
    expect(existsSync(path)).toBe(true)
    expect(existsSync(path + '.tmp')).toBe(false)
  })

  it('文件缺失 ⇒ 空缓存（首次启动的正常路径）', () => {
    const path = insightsShardCachePath(join(tempDir(), 'decrypted'))
    expect(loadInsightsShardCache(path).size).toBe(0)
  })

  it('损坏/半写文件 ⇒ 空缓存，不抛（绝不能把坏数据当成有效聚合）', () => {
    const dir = tempDir()
    const path = insightsShardCachePath(join(dir, 'decrypted'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{"version":1,"entries":[{"key":', 'utf8')
    expect(() => loadInsightsShardCache(path)).not.toThrow()
    expect(loadInsightsShardCache(path).size).toBe(0)
    writeFileSync(path, 'not json at all', 'utf8')
    expect(loadInsightsShardCache(path).size).toBe(0)
  })

  it('条目缺字段 ⇒ 跳过该条（不污染缓存）', () => {
    const dir = tempDir()
    const path = insightsShardCachePath(join(dir, 'decrypted'))
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({
      version: 1,
      entries: [{ key: 'ok', sig: 's', agg: { n: 1 } }, { key: 'no-sig', agg: {} }, { sig: 'no-key', agg: {} }, null],
    }), 'utf8')
    const loaded = loadInsightsShardCache(path)
    expect([...loaded.keys()]).toEqual(['ok'])
  })

  it('写失败只返回 false，不抛（缓存写不进去不能影响查询）', () => {
    const dir = tempDir()
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x', 'utf8')
    // 让父目录是一个文件 ⇒ mkdirSync 失败
    const path = join(blocker, 'cache', 'insights-shards.v1.json')
    expect(() => saveInsightsShardCache(path, [])).not.toThrow()
    expect(saveInsightsShardCache(path, [])).toBe(false)
  })
})

describe('insights 计算接线守卫', () => {
  const HERE = dirname(fileURLToPath(import.meta.url))
  const SRC = readFileSync(join(HERE, '..', 'src', 'query', 'overview-insights.ts'), 'utf8')

  it('compute 里真的 hydrate 与 persist（否则磁盘缓存在生产永远不会被用到）', () => {
    expect(SRC, '缺 hydrate ⇒ 重启后永远读不到磁盘缓存').toContain('ensureShardCacheHydrated(dec)')
    expect(SRC, '缺 persist ⇒ 算完从不落盘').toContain('persistShardCacheIfDirty(dec)')
  })

  it('命中仍逐字比对 sig（缓存正确性不能只靠版本号）', () => {
    expect(SRC).toContain('hit.sig !== sig')
  })
})
