/**
 * 隐藏的保活聊天面板必须释放图片 data URL（jsdom 行为判据）。
 *
 * 保活面板切走后仍挂在 DOM 里（`display:none`），若组件 state 继续持有
 * `data:image/...;base64,…`，这些大字符串会随面板一直常驻，直到用户关掉应用。
 * 修复口径：**隐藏时清掉组件手里的 URL，只保留 `image-cache` 的键**；切回来时
 * 先从缓存命中原图（命中就不发请求），没有才重新取。
 *
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { forgetAllImages, recallImage, rememberImage } from '../image-cache.ts'
import { KeepAliveActiveProvider } from './keep-alive.tsx'
import { MessageEmoticon, MessageImage } from './chats-media.tsx'

const mocks = vi.hoisted(() => ({
  apiGetEmoticonDataUrl: vi.fn(),
  apiGetImageDataUrl: vi.fn(),
}))

vi.mock('../api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api.ts')>()
  return { ...actual, ...mocks }
})

const IMAGE_URL = 'data:image/png;base64,AAAA'
const EMOJI_MD5 = '0123456789abcdef0123456789abcdef'

let host: HTMLElement
let root: Root | null = null

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset()
  mocks.apiGetImageDataUrl.mockResolvedValue({ url: IMAGE_URL, thumb: true })
  mocks.apiGetEmoticonDataUrl.mockResolvedValue({ url: 'data:image/gif;base64,BBBB' })
  forgetAllImages()
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  if (root) {
    act(() => { root?.unmount() })
    root = null
  }
  host.remove()
  forgetAllImages()
})

function mount(node: React.ReactElement): void {
  root = createRoot(host)
  act(() => { root?.render(node) })
}

/** 让 effect 里的 Promise 回调在 act 内跑完。 */
async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

const message = { localId: 42, isSender: 0, type: 3 } as WechatMessage

function imageView(active: boolean): React.ReactElement {
  return createElement(KeepAliveActiveProvider, {
    active,
    children: createElement(MessageImage, { m: message, selfName: 'wxid_self' }),
  })
}

describe('隐藏保活面板的图片 data URL 释放', () => {
  it('消息图片：显示时从缓存出图，隐藏后清掉组件 URL，再显示时仍从缓存恢复', async () => {
    rememberImage('wxid_self', 42, { url: IMAGE_URL, thumb: true })
    mount(imageView(true))
    await flush()
    expect(host.querySelector('img')?.getAttribute('src'), '显示态没有渲染图片').toContain(IMAGE_URL)

    act(() => { root?.render(imageView(false)) })
    expect(host.querySelector('img'), '隐藏后组件仍持有图片 data URL').toBeNull()
    // 键仍在内存 LRU 中：释放的是组件引用，不是缓存本身。
    expect(recallImage('wxid_self', 42)?.url).toBe(IMAGE_URL)

    act(() => { root?.render(imageView(true)) })
    await flush()
    expect(host.querySelector('img')?.getAttribute('src'), '切回来没有从缓存恢复').toContain(IMAGE_URL)
    expect(mocks.apiGetImageDataUrl, '缓存命中还去打了图片接口').not.toHaveBeenCalled()
  })

  it('表情：隐藏时清掉 img，切回来重新取（表情不在消息图片缓存里）', async () => {
    const emojiView = (active: boolean): React.ReactElement => createElement(KeepAliveActiveProvider, {
      active,
      children: createElement(MessageEmoticon, { md5: EMOJI_MD5, label: '笑' }),
    })
    mount(emojiView(true))
    await flush()
    expect(host.querySelector('img'), '显示态没有渲染表情').not.toBeNull()
    expect(mocks.apiGetEmoticonDataUrl).toHaveBeenCalledTimes(1)

    act(() => { root?.render(emojiView(false)) })
    expect(host.querySelector('img'), '隐藏后表情组件仍持有 data URL').toBeNull()
    expect(mocks.apiGetEmoticonDataUrl, '隐藏时不应继续取表情').toHaveBeenCalledTimes(1)

    act(() => { root?.render(emojiView(true)) })
    await flush()
    expect(host.querySelector('img'), '切回来没有恢复表情').not.toBeNull()
    expect(mocks.apiGetEmoticonDataUrl).toHaveBeenCalledTimes(2)
  })
})
