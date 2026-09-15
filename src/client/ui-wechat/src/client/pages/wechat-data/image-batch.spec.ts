// @vitest-environment node
/**
 * N16 合并窗口的**纯逻辑**用例（`image-batch.ts`）。
 *
 * 为什么与 `api-image-batch.spec.ts` 分开：那边证明「api 层真的接上了批量 RPC」，这边把
 * 合并语义本身钉死（何时冲刷、怎么分块、回填顺序、失败传播）——`schedule` 注入成手动触发，
 * 于是「同一个窗口内合并、跨窗口不合并」这两条不依赖微任务时序就能断言。
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { createImageLoadQueue } from './image-batch.ts'

/** 造一个手动控制冲刷时机的队列。 */
function manualQueue(chunkSize: number, flushImpl: (batch: readonly number[]) => Promise<readonly string[]>): {
  enqueue: (key: number) => Promise<string>
  flush: () => Promise<void>
  batches: number[][]
} {
  const runs: Array<() => void> = []
  const batches: number[][] = []
  const queue = createImageLoadQueue<number, string>({
    chunkSize,
    schedule: (run) => { runs.push(run) },
    onMissing: (key) => 'missing:' + String(key),
    flush: (batch) => {
      batches.push([...batch])
      return flushImpl(batch)
    },
  })
  return {
    enqueue: (key) => queue.enqueue(key),
    batches,
    flush: async () => {
      // 一次冲刷窗口 = 把当前排下的那次 run 执行掉（期间入队的请求属于下一个窗口）。
      const next = runs.shift()
      expect(next, '没有待执行的冲刷（说明窗口语义变了）').toBeTruthy()
      ;(next as () => void)()
      // 让 flush 的 promise 链跑完
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe('N16：取图合并队列', () => {
  it('同一窗口内的多次入队合并成一次 flush，结果按入队顺序回填', async () => {
    const q = manualQueue(200, async (batch) => batch.map(k => 'url:' + String(k)))
    const p = [q.enqueue(1), q.enqueue(2), q.enqueue(3)]
    expect(q.batches.length).toBe(0) // 冲刷前一次都没发
    await q.flush()
    expect(q.batches).toEqual([[1, 2, 3]])
    expect(await Promise.all(p)).toEqual(['url:1', 'url:2', 'url:3'])
  })

  it('下一个窗口是新一轮 flush（窗口不是一次性的）', async () => {
    const q = manualQueue(200, async (batch) => batch.map(k => 'url:' + String(k)))
    const p1 = q.enqueue(1)
    await q.flush()
    const p2 = q.enqueue(2)
    await q.flush()
    expect(q.batches).toEqual([[1], [2]])
    expect(await p1).toBe('url:1')
    expect(await p2).toBe('url:2')
  })

  it('超过分块上限时分多次 flush，条数与请求数一一对应', async () => {
    const q = manualQueue(2, async (batch) => batch.map(k => 'url:' + String(k)))
    const p = [q.enqueue(1), q.enqueue(2), q.enqueue(3), q.enqueue(4), q.enqueue(5)]
    await q.flush()
    expect(q.batches).toEqual([[1, 2], [3, 4], [5]])
    expect(await Promise.all(p)).toEqual(['url:1', 'url:2', 'url:3', 'url:4', 'url:5'])
  })

  it('flush 少返回了一条 → 缺失那条走 onMissing（不留悬空的 Promise、也不错位）', async () => {
    const q = manualQueue(200, async () => ['url:1']) // 故意少返回第 2 条
    const p = [q.enqueue(1), q.enqueue(2)]
    await q.flush()
    expect(await Promise.all(p)).toEqual(['url:1', 'missing:2'])
  })

  it('flush 失败 → 该块的每一条各自 reject（错误不会静默变成空图）', async () => {
    const q = manualQueue(200, async () => { throw new Error('批量取图失败') })
    const p = [q.enqueue(1), q.enqueue(2)]
    await q.flush()
    const settled = await Promise.allSettled(p)
    expect(settled.map(s => s.status)).toEqual(['rejected', 'rejected'])
    // 防空转：确认真的带上了原因，而不是空 Error
    expect(String((settled[0] as PromiseRejectedResult).reason)).toContain('批量取图失败')
  })

  it('默认调度器是微任务（不注入 schedule 也能合并）', async () => {
    const batches: number[][] = []
    const queue = createImageLoadQueue<number, string>({
      onMissing: (k) => 'missing:' + String(k),
      flush: async (batch) => { batches.push([...batch]); return batch.map(k => 'url:' + String(k)) },
    })
    const p = [queue.enqueue(1), queue.enqueue(2)]
    expect(batches.length).toBe(0)
    await vi.waitFor(() => { expect(batches.length).toBe(1) })
    expect(await Promise.all(p)).toEqual(['url:1', 'url:2'])
  })
})
