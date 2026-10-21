// @vitest-environment jsdom
/**
 * 收藏聊天记录预览的行为守卫：
 * ① 标题与逐条消息来自收藏自身，不是通用详情列表；
 * ② 头像只交给 RemoteImg（原始 `sourceheadurl` 不得直接进 `<img>`）；
 * ③ 外层是 kit 右侧抽屉，逐条内容仍完整渲染。
 */
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FavorItem } from '@deepseek-ai/dsh-wechat-data/types'
import type { FavoritesChatlogPreviewProps } from './favorites-chatlog-preview.tsx'
import { FavoritesChatlogPreview } from './favorites-chatlog-preview.tsx'

const stubs = vi.hoisted(() => ({
  remote: vi.fn((src: string): void => { void src }),
  shared: vi.fn((_sources: readonly string[]): Record<string, string> => ({})),
  avatar: vi.fn((_options: { md5: string }): Promise<{ url?: string }> => Promise.resolve({})),
  voice: vi.fn((): Promise<{ url?: string; error?: string }> => Promise.resolve({})),
}))

vi.mock('../api.ts', () => ({
  apiGetMessageFile: vi.fn(),
  apiGetSnsImageDataUrl: stubs.avatar,
  apiGetSnsVideoCoverDataUrl: vi.fn(),
  apiGetSnsVideoDataUrl: vi.fn(),
  apiGetVoiceDataUrl: stubs.voice,
}))

vi.mock('./remote-img.tsx', async () => {
  const { createElement } = await import('react')
  return {
    useSharedRemoteImages: stubs.shared,
    RemoteImg: ({ src, pending }: { src: string; pending?: React.ReactNode }): React.JSX.Element => {
      stubs.remote(src)
      return createElement('span', { 'data-proxied': src }, pending ?? null)
    },
  }
})

const item: FavorItem = {
  localId: 71,
  type: 14,
  typeLabel: '聊天记录',
  title: '群聊的聊天记录',
  desc: '',
  url: '',
  updateTime: 0,
  time: '2026-07-29 10:00',
  content: '<fav><title>群聊的聊天记录</title><datalist>'
    + '<dataitem datatype="1"><datadesc>第一条</datadesc><datasrcname>甲</datasrcname><datasrctime>2026-07-27 22:48:59</datasrctime><sourceheadurl>https://wx.qlogo.cn/a/96</sourceheadurl></dataitem>'
    + '<dataitem datatype="3"><datafmt>silk</datafmt><duration>2686</duration><fromnewmsgid>2538601227098830648</fromnewmsgid><datasrcname>乙</datasrcname><datasrctime>2026-07-27 22:49:00</datasrctime></dataitem>'
    + '</datalist></fav>',
  fromUsr: '',
  chatName: '',
  source: '某群',
}

let host: HTMLDivElement
let root: Root
const onClose = vi.fn()

function show(over: Partial<FavoritesChatlogPreviewProps> = {}): void {
  act(() => {
    root.render(createElement(FavoritesChatlogPreview, { item, thumbs: {}, onClose, ...over }))
  })
}

async function showAndFlush(over: Partial<FavoritesChatlogPreviewProps> = {}): Promise<void> {
  await act(async () => {
    root.render(createElement(FavoritesChatlogPreview, { item, thumbs: {}, onClose, ...over }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  stubs.remote.mockReset()
  stubs.shared.mockReset()
  stubs.shared.mockReturnValue({})
  stubs.avatar.mockReset()
  stubs.avatar.mockResolvedValue({})
  stubs.voice.mockReset()
  stubs.voice.mockResolvedValue({})
  onClose.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('FavoritesChatlogPreview', () => {
  it('标题与逐条消息都在，时间保留完整年份', async () => {
    await showAndFlush()
    const drawer = document.querySelector('[role="dialog"]')
    expect(drawer, '聊天记录没有走 Radix 抽屉（role=dialog 缺失）').not.toBeNull()
    expect(drawer?.textContent).toContain('群聊的聊天记录')
    expect(drawer?.querySelectorAll('[class*="chatlogRow"]')).toHaveLength(2)
    expect(drawer?.textContent).toContain('甲')
    expect(drawer?.textContent).toContain('2026-07-27 22:48:59')
    expect(drawer?.textContent).toContain('第一条')
    expect(drawer?.textContent).toContain('语音 · 3 秒')
  })

  it('聊天记录中的图片/语音/视频等资源复用详情渲染器，不再退化成文字占位', async () => {
    stubs.voice.mockResolvedValue({ url: 'data:audio/wav;base64,voice' })
    await showAndFlush()
    expect(stubs.voice).toHaveBeenCalledWith({ svrId: '2538601227098830648' })
    expect(document.querySelector('audio')?.getAttribute('src')).toBe('data:audio/wav;base64,voice')
    expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('[语音]')
  })

  it('头像地址交给 RemoteImg，页面不直接挂外链', async () => {
    await showAndFlush()
    expect(stubs.remote.mock.calls.map((c) => c[0])).toEqual(['https://wx.qlogo.cn/a/96', ''])
    expect(host.querySelector('img[src^="http"]')).toBeNull()
  })

  it('同一发送者的头像只解析一次，所有记录同步使用同一结果', async () => {
    stubs.shared.mockReturnValue({ 'https://wx.qlogo.cn/a/96': 'data:image/jpeg;base64,avatar' })
    await showAndFlush({
      item: {
        ...item,
        content: '<fav><title>群聊的聊天记录</title><datalist>'
          + '<dataitem datatype="1"><datadesc>第一条</datadesc><datasrcname>甲</datasrcname><sourceheadurl>https://wx.qlogo.cn/a/96</sourceheadurl></dataitem>'
          + '<dataitem datatype="1"><datadesc>第二条</datadesc><datasrcname>甲</datasrcname><sourceheadurl>https://wx.qlogo.cn/a/96</sourceheadurl></dataitem>'
          + '</datalist></fav>',
      },
    })
    expect(stubs.shared).toHaveBeenCalledWith(['https://wx.qlogo.cn/a/96', 'https://wx.qlogo.cn/a/96'])
    expect(stubs.remote.mock.calls.map((c) => c[0])).toEqual([
      'data:image/jpeg;base64,avatar',
      'data:image/jpeg;base64,avatar',
    ])
  })

  it('聊天记录头像只有 32 位 MD5 时也先本机解码，再交给 RemoteImg', async () => {
    const md5 = 'f18572f2133c91307dc98c1cc095d995'
    stubs.avatar.mockResolvedValue({ url: 'data:image/jpeg;base64,decoded-avatar' })
    await showAndFlush({
      item: {
        ...item,
        content: '<fav><title>群聊的聊天记录</title><datalist>'
          + `<dataitem datatype="1"><datadesc>第一条</datadesc><datasrcname>甲</datasrcname><sourceheadurl>${md5}</sourceheadurl></dataitem>`
          + '</datalist></fav>',
      },
    })
    expect(stubs.avatar).toHaveBeenCalledWith({ md5 })
    expect(stubs.remote.mock.calls.map((c) => c[0])).toContain('data:image/jpeg;base64,decoded-avatar')
    expect(document.querySelector(`[role="dialog"] img[src="${md5}"]`)).toBeNull()
  })

  it('关闭按钮调用 onClose', async () => {
    await showAndFlush()
    const close = document.querySelector('[role="dialog"] button[aria-label="关闭"]')
    expect(close, '抽屉关闭按钮缺失').not.toBeNull()
    act(() => { close?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('没有条目时整块不渲染', () => {
    show({ item: null })
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
