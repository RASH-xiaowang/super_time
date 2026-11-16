// @vitest-environment jsdom
/** 详情浮层内的图片必须能真正打开查看器，而不是被更高层级的详情遮住。 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { MomentItem } from '@deepseek-ai/dsh-wechat-data/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MomentsDetail } from './moments-portals.tsx'

const moment = {
  username: 'wxid_a',
  author: '张三',
  time: '刚刚',
  text: '',
  images: [{ md5: 'image-md5' }],
  videos: [],
  comments: [],
  likes: [],
} as unknown as MomentItem

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  document.body.innerHTML = ''
})

describe('朋友圈详情浮层', () => {
  it('点击图片时先收起详情，再打开共享查看器', () => {
    const setDetail = vi.fn()
    const setViewer = vi.fn()
    act(() => {
      root.render(createElement(MomentsDetail, {
        detail: { m: moment },
        setDetail,
        setViewer,
        setAuthorFilter: vi.fn(),
        snsImgs: {},
        articleCovers: {},
        mediaKeySpec: { current: new Map() },
        videoSrcs: {},
        videoLoading: new Set<string>(),
        videoMeta: {},
        setVideoMeta: vi.fn(),
        videoFailed: new Set<string>(),
        videoErr: new Map<string, string>(),
        loadVideo: vi.fn(),
        reportVideoError: vi.fn(),
        saveVideo: vi.fn(),
        fullscreenVideo: vi.fn(),
        closeVideo: vi.fn(),
      }))
    })

    const image = document.querySelector('[data-st-dialog="moments-detail"] [title="点击查看大图"]')
    expect(image).toBeTruthy()
    act(() => { image?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

    expect(setDetail).toHaveBeenCalledWith(null)
    expect(setViewer).toHaveBeenCalledWith(expect.objectContaining({
      index: 0,
      author: '张三',
      images: moment.images,
    }))
  })
})
