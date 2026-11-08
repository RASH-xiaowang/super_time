// @vitest-environment jsdom
/**
 * 查看器缓存的资源边界：成功和失败都必须受同一条 LRU 约束；切换 sources 后，
 * 旧请求不得覆盖同一 key 的新结果。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useViewerCache } from './use-viewer-cache.ts'
import type { ViewerSource } from './viewer-types.ts'

type ViewerCache = ReturnType<typeof useViewerCache>

let host: HTMLDivElement
let root: Root
let latest: ViewerCache | null = null

function Probe({ sources, index }: { sources: readonly ViewerSource[]; index: number }): React.JSX.Element {
  latest = useViewerCache(sources, index)
  return createElement('div', { 'data-probe': '' })
}

function render(sources: readonly ViewerSource[], index = 0): void {
  act(() => { root.render(createElement(Probe, { sources, index })) })
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    await Promise.resolve()
  })
}

const source = (key: string, load: () => Promise<string>): ViewerSource => ({ key, load })

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  latest = null
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('useViewerCache 的资源回收', () => {
  it('失败项也进入 LRU，不会被无界保留', async () => {
    const loads = Array.from({ length: 5 }, () => vi.fn().mockRejectedValue(new Error('坏图')))
    const sources = loads.map((load, i) => source(String(i), load))

    render(sources, 0)
    await flush()
    render(sources, 2)
    await flush()
    render(sources, 4)
    const retained = [0, 1, 2, 3, 4].filter((i) => latest?.getEntry(String(i)) !== undefined)
    expect(retained, '失败项没有进入 LRU，缓存条数无界').toHaveLength(4)
    expect(loads[4], '最后定位到第 5 张时没有发起加载').toHaveBeenCalled()
    expect(latest?.getEntry('4')?.error).toBe('资源暂不可用，请稍后重试')
    expect(latest?.getEntry('4')?.error).not.toContain('坏图')
  })

  it('sources 切换后立即加载同名新键，旧请求迟到也不能覆盖新结果', async () => {
    let finishOld!: (value: string) => void
    let finishNew!: (value: string) => void
    const oldLoad = vi.fn(() => new Promise<string>((resolve) => { finishOld = resolve }))
    const newLoad = vi.fn(() => new Promise<string>((resolve) => { finishNew = resolve }))

    render([source('same', oldLoad)])
    await flush()
    render([source('same', newLoad)])
    await flush()
    expect(newLoad, '旧 sources 的同名在途请求挡住了新 sources').toHaveBeenCalledTimes(1)

    act(() => { finishNew('new') })
    await flush()
    expect(latest?.getEntry('same')?.src).toBe('new')

    act(() => { finishOld('old') })
    await flush()
    expect(latest?.getEntry('same')?.src, '旧请求覆盖了新一轮结果').toBe('new')
  })

  it('key 列表相同的父组件重渲染不清缓存，也不重复发起加载', async () => {
    const load = vi.fn().mockResolvedValue('blob:same')
    render([source('same', load)])
    await flush()
    expect(load).toHaveBeenCalledTimes(1)

    render([source('same', load)])
    await flush()
    expect(load, '仅数组引用变化不应作废原图缓存').toHaveBeenCalledTimes(1)
    expect(latest?.getEntry('same')?.src).toBe('blob:same')
  })

  it('媒体元素报错后写错误项，普通重渲染不会自动重拉，显式重试才重新加载', async () => {
    const load = vi.fn()
      .mockResolvedValueOnce('blob:broken')
      .mockResolvedValueOnce('blob:fixed')
    render([source('same', load)])
    await flush()

    act(() => { latest?.reportError('same', '视频解码失败') })
    await flush()
    expect(latest?.getEntry('same')?.error).toBe('视频解码失败')

    render([source('same', load)])
    await flush()
    expect(load, '错误项应等待用户显式重试').toHaveBeenCalledTimes(1)

    act(() => { latest?.retry('same') })
    render([source('same', load)])
    await flush()
    expect(load).toHaveBeenCalledTimes(2)
    expect(latest?.getEntry('same')?.src).toBe('blob:fixed')
  })
})
