// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mediaViewer = vi.hoisted(() => ({
  latest: null as null | Record<string, unknown>,
}))

vi.mock('../media-viewer/MediaViewer.tsx', async () => {
  const React = await import('react')
  return {
    MediaViewer: (props: Record<string, unknown>): React.JSX.Element => {
      mediaViewer.latest = props
      const sources = props.sources as Array<Record<string, unknown>>
      const index = props.index as number
      const source = sources[index] ?? {}
      return React.createElement(
        'div',
        {
          'data-viewer': 'moments',
          'data-kind': String(source.kind ?? 'image'),
          'data-key': String(source.key ?? ''),
          'data-start-at': String(source.startAtMs ?? ''),
        },
        React.createElement('button', {
          type: 'button',
          'data-nav': 'next',
          onClick: () => (props.onIndexChange as (i: number) => void)(1),
        }),
        React.createElement('button', {
          type: 'button',
          'data-close': '1',
          onClick: props.onClose as () => void,
        }),
        props.extraToolbar as React.ReactNode,
      )
    },
  }
})

const { MomentLiveBadge, momentLiveKey, momentLivePhoto } = await import('./moments-live.tsx')
const { MomentsImageViewer } = await import('./moments-portals.tsx')

const live = {
  url: 'https://video.example/live.mp4',
  md5: 'live-md5',
  key: 'live-seed',
  duration: 2.5,
  stillImageTimeMs: 1200,
}
const viewer = {
  images: [
    { md5: 'still-1', livePhoto: live },
    { md5: 'still-2' },
  ],
  index: 0,
  author: '张三',
}

let host: HTMLDivElement
let root: Root
let loadVideo: ReturnType<typeof vi.fn>
let closeVideo: ReturnType<typeof vi.fn>
let setViewerIndex: ReturnType<typeof vi.fn>
const HERE = dirname(fileURLToPath(import.meta.url))

function render(
  videoSrcs: Record<string, string> = {},
  videoFailed = new Set<string>(),
  videoErr = new Map<string, string>(),
): void {
  act(() => {
    root.render(createElement(MomentsImageViewer, {
      viewer,
      setViewer: vi.fn(),
      setViewerIndex,
      curImg: viewer.images[0],
      snsImgs: {},
      snsOriginals: new Set<string>(),
      resolveSnsOriginal: async () => 'data:live',
      copyCurrentLink: vi.fn(),
      viewRotate: 0,
      setViewRotate: vi.fn(),
      videoSrcs,
      videoFailed,
      videoErr,
      loadVideo,
      closeVideo,
    }))
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  mediaViewer.latest = null
  loadVideo = vi.fn()
  closeVideo = vi.fn()
  setViewerIndex = vi.fn()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('实况元数据', () => {
  it('兼容 livePhoto/live 与两种静态帧字段名，并识别可播放条件', () => {
    expect(momentLivePhoto({ livePhoto: live })).toMatchObject({
      url: live.url,
      md5: live.md5,
      key: live.key,
      duration: 2.5,
      stillTimeMs: 1200,
    })
    expect(momentLivePhoto({ live: { ...live, stillImageTimeMs: undefined, stillTime: 900 } })).toMatchObject({
      md5: 'live-md5',
      stillTimeMs: 900,
    })
    expect(momentLivePhoto({ livePhoto: { key: 'only-key' } })).toBeNull()
    expect(momentLivePhoto({ md5: '普通图片' })).toBeNull()
  })

  it('实况状态键与普通视频分开，并随 timeline/id 保持稳定', () => {
    expect(momentLiveKey({ md5: 'still-1', timelineId: 't1', livePhoto: live }, 0)).toBe('live:t1:live-md5')
    expect(momentLiveKey({ md5: 'still-1', timelineId: 't1', livePhoto: live }, 0))
      .toBe(momentLiveKey({ md5: 'still-1', timelineId: 't1', livePhoto: live }, 9))
  })

  it('角标有可访问名称，且不依赖图片加载成功', () => {
    render()
    act(() => {
      root.render(createElement(MomentLiveBadge))
    })
    expect(host.querySelector('[aria-label="实况照片"]')?.textContent).toContain('实况')
  })

  it('卡片与详情图片都接入角标与实况提示', () => {
    const card = readFileSync(join(HERE, 'moments-card.tsx'), 'utf8')
    const portals = readFileSync(join(HERE, 'moments-portals.tsx'), 'utf8')
    const panel = readFileSync(join(HERE, 'moments-panel.tsx'), 'utf8')
    expect(card).toContain('const live = momentLivePhoto(im)')
    expect(card).toContain('<MomentLiveBadge />')
    expect(portals).toContain("title={live ? '点击查看大图（实况）' : '点击查看大图'}")
    expect(panel).toContain('videoFailed={videoFailed}')
    expect(panel).toContain('loadVideo={loadVideo}')
  })

  it('单张朋友圈图片保存走后端原图导出，不再用 <a download> 存缩略图', () => {
    const helper = readFileSync(join(HERE, 'moments-original-export.ts'), 'utf8')
    const portals = readFileSync(join(HERE, 'moments-portals.tsx'), 'utf8')
    expect(helper).toContain('apiExportSnsImage')
    expect(helper).toContain("title: '保存朋友圈原图'")
    expect(helper).toContain('dest: picked.path')
    expect(helper).toContain('jobId')
    expect(portals).toContain('saveMomentImageOriginal')
    const saveStart = helper.indexOf('export async function saveMomentImageOriginal')
    const save = helper.slice(saveStart)
    expect(save).not.toContain('document.createElement(\'a\')')
  })
})

describe('图片查看器播放实况', () => {
  it('点击后走既有视频 RPC 状态；视频到位时当前源切为 video 并从静态帧开始', () => {
    render()
    const button = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('播放实况'))
    expect(button, '查看器里没有可发现的实况入口').toBeTruthy()
    act(() => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(loadVideo).toHaveBeenCalledWith('live:live-md5', expect.objectContaining({
      url: live.url,
      md5: live.md5,
      key: live.key,
    }))
    expect(host.textContent).toContain('实况加载中')

    const key = momentLiveKey(viewer.images[0], 0)
    render({ [key]: 'blob:live-video' })
    expect(host.querySelector('[data-viewer="moments"]')?.getAttribute('data-kind')).toBe('video')
    expect(host.querySelector('[data-viewer="moments"]')?.getAttribute('data-start-at')).toBe('1200')
    expect(host.textContent).toContain('退出实况')
  })

  it('导航切图和关闭灯箱都会退出播放并清掉视频状态', () => {
    render()
    const play = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('播放实况'))
    act(() => { play?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const key = momentLiveKey(viewer.images[0], 0)
    render({ [key]: 'blob:live-video' })
    closeVideo.mockClear()
    act(() => { host.querySelector('[data-nav="next"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(closeVideo).toHaveBeenCalledWith(key)
    expect(setViewerIndex).toHaveBeenCalledWith(1)

    const playAgain = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('播放实况'))
    act(() => { playAgain?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    closeVideo.mockClear()
    act(() => { host.querySelector('[data-close="1"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(closeVideo).toHaveBeenCalledWith(key)
  })

  it('视频取不到时显示原因入口并允许再次重试', () => {
    render()
    const play = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('播放实况'))
    act(() => { play?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    const key = momentLiveKey(viewer.images[0], 0)
    render({}, new Set([key]), new Map([[key, '本机未缓存']]))
    expect(host.textContent).toContain('重试实况')
    expect(host.textContent).toContain('视频不可用')
    expect(host.querySelector('[title="本机未缓存"]'), '失败原因被吞掉了').toBeTruthy()
    loadVideo.mockClear()
    const retry = [...host.querySelectorAll('button')].find((b) => b.textContent?.includes('重试实况'))
    act(() => { retry?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(loadVideo).toHaveBeenCalledTimes(1)
  })
})
