/**
 * 快照发布锁：同一目标的发布必须串行；等待有上限；抛错也要释放门闩。
 *
 * 场景是真实存在的：实时同步 tick 与「修复/立即解密」RPC 同进程并发，两边的
 * `atomicReplace` 都指向同一份快照。没有这把锁时语义是「最后写入者赢」——
 * 旧一代可能压在新一代之上。锁只覆盖发布几毫秒，不影响解密与推送节奏。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { withPublishLock } from '../src/query/snapshot-publish-lock.ts'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

describe('withPublishLock', () => {
  it('同一目标的两次发布串行：后一个必须等前一个结束', async () => {
    const events: string[] = []
    const first = withPublishLock('t.db', async () => {
      events.push('first:start')
      await sleep(30)
      events.push('first:end')
    })
    await sleep(1)
    const second = withPublishLock('t.db', async () => {
      events.push('second:start')
      events.push('second:end')
    })
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('不同目标互不阻塞', async () => {
    const events: string[] = []
    await Promise.all([
      withPublishLock('a.db', async () => { events.push('a:start'); await sleep(30); events.push('a:end') }),
      withPublishLock('b.db', async () => { events.push('b:start'); events.push('b:end') }),
    ])
    expect(events.indexOf('b:end')).toBeLessThan(events.indexOf('a:end'))
  })

  it('等待超过上限 ⇒ 明确失败（交给调用方退避），不无限期拖住同步 tick', async () => {
    let releaseFirst: () => void = () => { /* 见下 */ }
    const held = withPublishLock('slow.db', () => new Promise<void>((resolve) => { releaseFirst = resolve }))
    await sleep(1)
    await expect(withPublishLock('slow.db', async () => { /* 不该执行 */ }, 20))
      .rejects.toThrow(/等待超时/)
    releaseFirst()
    await held
  })

  it('发布动作抛错也必须释放门闩：下一次发布照常进行', async () => {
    await expect(withPublishLock('err.db', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(withPublishLock('err.db', async () => { /* 能进来就说明门闩已释放 */ })).resolves.toBeUndefined()
  })
})
