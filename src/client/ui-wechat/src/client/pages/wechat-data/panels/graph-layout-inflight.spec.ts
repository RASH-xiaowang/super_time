// @vitest-environment node
/**
 * 同一张图连续点两次「重新布局」时，两个调用必须共享同一次 Worker 计算。
 *
 * Worker 等待表按布局指纹建键。若 fresh 请求绕过在飞去重，第二份任务会覆盖第一份的
 * resolve/reject，第一份 Promise 永不结束，连带保留调用方组件与整张图。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_GRAPH_SETTINGS, type BuiltGraph, type GEdge, type GNode } from './graph-model.ts'

interface PostedTask {
  key: string
  nodes: Array<{ id: string, x: number, y: number }>
}

let restoreWorker: (() => void) | null = null
let restoreLocation: (() => void) | null = null
let disposeLayoutWorker: (() => void) | null = null

function node(id: string): GNode {
  return {
    id,
    label: id,
    kind: 'person',
    weight: 1,
    radius: 8,
    community: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    fx: null,
    fy: null,
  }
}

function chain(count: number): BuiltGraph {
  const nodes = Array.from({ length: count }, (_, i) => node('n' + String(i)))
  const edges: GEdge[] = Array.from({ length: count - 1 }, (_, i) => ({
    source: 'n' + String(i),
    target: 'n' + String(i + 1),
    weight: 1,
    dist: 100,
    kind: 'common',
  }))
  return { nodes, edges, communityCount: 1, kindCounts: {} }
}

afterEach(() => {
  disposeLayoutWorker?.()
  disposeLayoutWorker = null
  restoreWorker?.()
  restoreWorker = null
  restoreLocation?.()
  restoreLocation = null
  vi.restoreAllMocks()
})

describe('graph layout in-flight sharing', () => {
  it('重复 fresh 布局只投递一份 Worker 任务，且两个调用都能结束', async () => {
    const posted: PostedTask[] = []
    let worker: FakeWorker | null = null

    class FakeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null
      onerror: (() => void) | null = null
      onmessageerror: (() => void) | null = null
      task: PostedTask | null = null

      constructor() {
        worker = this
      }

      postMessage(task: PostedTask): void {
        this.task = task
        posted.push(task)
      }

      terminate(): void {
        // no-op
      }
    }

    const workerDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'Worker')
    const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'location')
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker })
    Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { protocol: 'http:' } })
    restoreWorker = () => {
      if (workerDescriptor) Object.defineProperty(globalThis, 'Worker', workerDescriptor)
      else Reflect.deleteProperty(globalThis, 'Worker')
    }
    restoreLocation = () => {
      if (locationDescriptor) Object.defineProperty(globalThis, 'location', locationDescriptor)
      else Reflect.deleteProperty(globalThis, 'location')
    }

    vi.resetModules()
    const layout = await import('./graph-layout.ts')
    disposeLayoutWorker = layout.disposeLayoutWorker
    const graph = chain(201)

    const first = layout.runLayout({ graph, settings: DEFAULT_GRAPH_SETTINGS, fresh: true })
    const second = layout.runLayout({ graph, settings: DEFAULT_GRAPH_SETTINGS, fresh: true })

    expect(posted, '同一指纹的两次 fresh 布局各自投递了 Worker 任务').toHaveLength(1)
    const task = posted[0]
    expect(task).toBeDefined()
    expect(worker).not.toBeNull()

    const points = task?.nodes.map((n) => ({ id: n.id, x: n.x, y: n.y })) ?? []
    ;(worker as FakeWorker | null)?.onmessage?.({
      data: { key: task?.key ?? '', points },
    } as MessageEvent)

    let timeout: ReturnType<typeof setTimeout> | undefined
    const stalled = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => { reject(new Error('共享的在飞布局没有让两个调用都结束')) }, 1000)
    })
    try {
      const [a, b] = await Promise.race([Promise.all([first, second]), stalled])
      expect(a.positions.size).toBe(graph.nodes.length)
      expect(b.positions.size).toBe(graph.nodes.length)
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  })
})
