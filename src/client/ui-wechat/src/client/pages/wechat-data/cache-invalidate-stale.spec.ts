/**
 * P2-4 / 第一批 #4：一次实时同步事件 ≠「所有面板同时回源」。
 *
 * 旧写法是收到 `dsh-wechat-data-updated` 就 `_snapshotCache.clear()`。判断没错（数据确实都旧了），
 * 错在表达方式：清表 ⇒ 下一次读**全部回源**，而实时同步活跃期这个事件约每 10 秒来一次，
 * 于是「每 10 秒全体面板重新取数」，其中 `ledger` / `storage-stats` 是几百毫秒的重查询，
 * 全部排进后端那一条单队列（PERF-BASELINE 记的「世界板块 13ms 等到 17,008ms」是同一本账）。
 *
 * 现在的口径：**标记陈旧而不是删掉**。旧值立刻可画，真正的取数挪到后台，成功后写回 + 通知；
 * 旧到超过上限的值宁可当没有（不许画五小时前的数据）。这里量的就是这三件事。
 * @vitest-environment jsdom
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  cachedGet,
  invalidateSnapshotCache,
  snapshotDelete,
  snapshotHit,
  snapshotSet,
  subscribeSnapshot,
} from './cache.ts'

const CEILING_MS = 5 * 60_000
const HERE = dirname(fileURLToPath(import.meta.url))

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-26T12:00:00Z'))
  localStorage.clear()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** 等后台复验的微任务跑完（fake timers 不影响微任务队列）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

describe('cachedGet：陈旧可读 + 后台复验', () => {
  it('新鲜命中一次都不回源（这是缓存的基本职责，先钉住）', async () => {
    let calls = 0
    const first = await cachedGet('contacts:fresh', async () => { calls += 1; return { items: [1] } })
    expect(first).toEqual({ items: [1] })
    await cachedGet('contacts:fresh', async () => { calls += 1; return { items: [2] } })
    expect(calls, '30 秒内第二次读不该回源').toBe(1)
  })

  it('数据变更后再读：**立刻拿到旧值**，同时后台复验并写回', async () => {
    await cachedGet('ledger:all', async () => ({ sum: 1 }))
    invalidateSnapshotCache()
    let calls = 0
    const got = await cachedGet('ledger:all', async () => { calls += 1; return { sum: 99 } })
    expect(got, '被标记陈旧的键仍然要能立刻画出旧值（这是「切回面板不转圈」的一半）').toEqual({ sum: 1 })
    expect(calls, '陈旧命中必须在后台补一次真取数（否则界面永远停在旧值）').toBe(1)
    await flush()
    const again = await cachedGet('ledger:all', async () => ({ sum: 0 }))
    expect(again, '后台复验成功后没写回缓存').toEqual({ sum: 99 })
  })

  it('同一次事件里多个面板读同一个陈旧键 ⇒ 只回源一次', async () => {
    await cachedGet('moments:bg', async () => ({ items: ['a'], total: 1 }))
    invalidateSnapshotCache()
    let calls = 0
    const slow = async (): Promise<{ items: string[]; total: number }> => {
      calls += 1
      return await new Promise((resolve) => { setTimeout(() => resolve({ items: ['b'], total: 2 }), 5) })
    }
    const three = await Promise.all([
      cachedGet('moments:bg', slow), cachedGet('moments:bg', slow), cachedGet('moments:bg', slow),
    ])
    expect(calls).toBe(1)
    for (const v of three) expect(v).toEqual({ items: ['a'], total: 1 })
    await vi.waitFor(() => expect(snapshotHit('moments:bg')).toEqual({ items: ['b'], total: 2 }))
  })

  it('复验失败：留着旧值，界面不受影响，下一次读会再试', async () => {
    await cachedGet('privacy:keep', async () => ({ hits: 3 }))
    invalidateSnapshotCache()
    await cachedGet('privacy:keep', async () => { throw new Error('后端重启中') })
    await flush()
    expect(snapshotHit('privacy:keep'), '复验失败不该把旧值清掉').toEqual({ hits: 3 })
  })

  it('旧到超过上限的值直接丢掉：宁可冷启动也不画五小时前的数据', async () => {
    snapshotSet('records:old', { items: ['很久以前'] })
    vi.advanceTimersByTime(CEILING_MS + 1000)
    let calls = 0
    const v = await cachedGet('records:old', async () => { calls += 1; return { items: ['现在'] } })
    expect(calls, '过上限的条目还被当命中用了').toBe(1)
    expect(v).toEqual({ items: ['现在'] })
    expect(snapshotHit('records:old')).toEqual({ items: ['现在'] })
  })

  it('后台复验成功会通知订阅者（面板靠这个重渲染，不是靠清表）', async () => {
    snapshotDelete('group:notify')
    await cachedGet('group:notify', async () => ({ members: 1 }))
    let notified = 0
    const stop = subscribeSnapshot('group:notify', () => { notified += 1 })
    invalidateSnapshotCache()
    await cachedGet('group:notify', async () => ({ members: 2 }))
    await flush()
    stop()
    expect(notified, '复验完成后没有通知订阅者').toBeGreaterThanOrEqual(1)
  })
})

describe('invalidateSnapshotCache 的接线（判据不能只测缓存模块自己）', () => {
  it('宿主的实时同步事件仍然通向它（断链就退回「切页不刷新」）', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(join(HERE, 'cache.ts'), 'utf8')
    expect(src).toContain("window.addEventListener('dsh-wechat-data-updated'")
    // 陈旧机制在，就不许再退回「一把清表」
    expect(src, '又回到 _snapshotCache.clear() ⇒ 每 10 秒全体回源的 storm 会回来')
      .not.toMatch(/export function invalidateSnapshotCache\(\)[\s\S]{0,220}_snapshotCache\.clear\(\)/)
  })

  it('apiGetLedger 走了缓存（P2-4 里那条「无缓存重查询」的具体落点）', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(join(HERE, 'api-read.ts'), 'utf8').replace(/\r\n/g, '\n')
    const body = src.slice(src.indexOf('export async function apiGetLedger'))
    expect(body.slice(0, 600)).toContain("cachedGet('ledger:'")
  })
})
