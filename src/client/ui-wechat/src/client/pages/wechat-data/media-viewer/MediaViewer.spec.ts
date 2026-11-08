// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cacheMock = vi.hoisted(() => ({ reportError: vi.fn() }))

vi.mock('../ui/kit.tsx', () => ({
  useDialogFocus: (): void => {},
  useEscapeToClose: (): void => {},
}))

vi.mock('./use-viewer-cache.ts', () => ({
  useViewerCache: (sources: readonly { key: string }[], index: number) => ({
    getEntry: (key: string) => (key === sources[index]?.key
      ? { src: key === 'download:source' ? 'blob:download-source' : 'blob:live-video' }
      : undefined),
    retry: (): void => {},
    reportError: cacheMock.reportError,
  }),
}))

const { MediaViewer } = await import('./MediaViewer.tsx')

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  cacheMock.reportError.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('MediaViewer 实况定位', () => {
  it('视频元数据就绪后从 stillImageTimeMs 对应的静态帧开始播放', () => {
    act(() => {
      root.render(createElement(MediaViewer, {
        sources: [{
          key: 'live:video',
          title: '实况照片',
          kind: 'video',
          startAtMs: 1250,
          load: async () => 'blob:live-video',
        }],
        index: 0,
        onIndexChange: (): void => {},
        onClose: (): void => {},
        dialogName: 'media-viewer-live',
      }))
    })

    const video = document.querySelector('video')
    expect(video).toBeTruthy()
    if (!video) return
    Object.defineProperty(video, 'duration', { configurable: true, value: 4 })
    video.currentTime = 0

    act(() => {
      video.dispatchEvent(new Event('loadedmetadata', { bubbles: true }))
    })

    expect(video.currentTime).toBeCloseTo(1.25)
  })

  it('媒体元素报错时把可读原因交给查看器缓存，界面能显示错误卡片', () => {
    act(() => {
      root.render(createElement(MediaViewer, {
        sources: [{
          key: 'broken:video',
          title: '坏视频',
          kind: 'video',
          load: async () => 'blob:broken-video',
        }],
        index: 0,
        onIndexChange: (): void => {},
        onClose: (): void => {},
        dialogName: 'media-viewer-broken',
      }))
    })

    const video = document.querySelector('video')
    expect(video).toBeTruthy()
    if (!video) return
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 3 } })
    act(() => { video.dispatchEvent(new Event('error', { bubbles: true })) })
    expect(cacheMock.reportError).toHaveBeenCalledWith('broken:video', '视频解码失败，文件可能损坏或编码不受支持')
  })
})

describe('MediaViewer 下载', () => {
  function renderWithDownload(onDownload?: (src: string) => void | Promise<void>): void {
    act(() => {
      root.render(createElement(MediaViewer, {
        sources: [{
          key: 'download:source',
          title: '待保存资源',
          kind: 'video',
          load: async () => 'blob:download-source',
          ...(onDownload ? { onDownload } : {}),
        }],
        index: 0,
        onIndexChange: (): void => {},
        onClose: (): void => {},
        dialogName: 'media-viewer-download',
      }))
    })
  }

  it('等待异步自定义下载完成，期间禁用按钮', async () => {
    let finish: (() => void) | undefined
    const onDownload = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    renderWithDownload(onDownload)

    act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="下载"]')?.click() })
    expect(onDownload).toHaveBeenCalledWith('blob:download-source')
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLButtonElement>('button[aria-label="正在保存"]')?.disabled).toBe(true)
    })

    await act(async () => { finish?.(); await Promise.resolve() })
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLButtonElement>('button[aria-label="下载"]')).toBeTruthy()
    })
  })

  it('自定义下载失败时显示原因，且不偷偷回退到 <a download>', async () => {
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    renderWithDownload(async () => { throw new Error('磁盘已满') })

    await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="下载"]')?.click() })
    await vi.waitFor(() => {
      expect(document.querySelector('[role="alert"]')?.textContent).toContain('保存失败：磁盘已满')
    })
    expect(anchorClick).not.toHaveBeenCalled()
  })

  it('未提供原文件保存链路时禁用下载，绝不保存当前预览源', () => {
    renderWithDownload()
    const button = document.querySelector<HTMLButtonElement>('button[aria-label*="未提供原文件"]')
    expect(button?.disabled).toBe(true)
  })

  it('在查看器内显示调用方传入的保存进度卡', () => {
    act(() => {
      root.render(createElement(MediaViewer, {
        sources: [{ key: 'status:source', title: '保存状态', load: async () => 'blob:status' }],
        index: 0,
        onIndexChange: (): void => {},
        onClose: (): void => {},
        dialogName: 'media-viewer-status',
        statusOverlay: createElement('div', { 'data-media-save-status': 'running' }, '正在写入文件'),
      }))
    })
    expect(document.querySelector('[data-media-save-status="running"]')?.textContent).toContain('正在写入文件')
  })
})
