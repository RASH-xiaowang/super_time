// @vitest-environment jsdom
/**
 * 合并图片（连拍）的折叠/展开行为。
 *
 * 这里把图片缓存和 OCR 入口都装成轻量替身，只验证卡片栈的层数、动作区位置、
 * 展开后的图片数量、顶部收起入口，以及自己发送时是否保留镜像标记。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'

const api = vi.hoisted(() => ({
  image: vi.fn(),
}))

vi.mock('../api.ts', () => ({
  apiGetEmoticonDataUrl: vi.fn(),
  apiGetImageDataUrl: api.image,
  apiGetImageOriginal: vi.fn(),
  apiGetVideoInfo: vi.fn(),
  apiGetVoiceDataUrl: vi.fn(),
  apiGetVoiceTranscript: vi.fn(),
  apiOpenPath: vi.fn(),
  apiTranscribeVoiceMessage: vi.fn(),
  runtimeCapabilities: () => ({ isDesktop: false }),
}))

vi.mock('./chats-ocr.tsx', () => ({
  ImageOcrAction: ({ layout }: { layout: string }): React.JSX.Element =>
    createElement('button', { 'data-ocr': layout }, '?'),
  ImageTextActions: ({ layout }: { layout: string }): React.JSX.Element =>
    createElement(
      'span',
      { 'data-actions': layout },
      createElement('button', { 'data-ocr': layout }, '?'),
      createElement('button', { 'data-ai': layout }, 'AI'),
    ),
}))

vi.mock('../image-cache.ts', () => ({
  recallImage: (): { url: string } => ({ url: 'data:image/png;base64,iVBORw0KGgo=' }),
  rememberImage: vi.fn(),
}))

const { MessageImageGroup } = await import('./chats-media.tsx')

const message = (localId: number, isSender = 0): WechatMessage => ({
  localId,
  createTime: 1700000000,
  type: 3,
  isSender,
} as WechatMessage)

let host: HTMLDivElement
let root: Root

function mount(items: WechatMessage[]): void {
  act(() => {
    root.render(createElement(MessageImageGroup, {
      items,
      username: 'wxid_talker',
      onOpenAt: vi.fn(),
    }))
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  api.image.mockClear()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('合并图片卡片栈', () => {
  it('默认只展开第一张并露出三张边缘，按钮显示总数', async () => {
    mount([1, 2, 3, 4].map((id) => message(id)))
    await act(async () => { await Promise.resolve() })
    const panel = host.querySelector<HTMLElement>('[class*="msgImageGroupPanel"]')
    expect(panel?.className).toContain('msgImageGroupPanel')
    expect(host.querySelectorAll('[data-slot]')).toHaveLength(3)
    expect(host.textContent).toContain('展开 4')
    const stack = host.querySelector<HTMLElement>('[class*="msgImageStack"]')
    const actions = host.querySelector<HTMLElement>('[class*="msgImageGroupActions"]')
    expect(actions?.querySelector('[data-ocr="side"]')).not.toBeNull()
    expect(actions?.querySelector('[data-ai="side"]')).not.toBeNull()
    expect(stack?.querySelector('[data-ocr]')).toBeNull()
    expect(panel?.lastElementChild).toBe(actions)
    expect(host.textContent).not.toContain('收起')
  })

  it('点展开后就地列出全部图片，并可收起', () => {
    mount([11, 12, 13, 14].map((id) => message(id)))
    const toggle = (): HTMLButtonElement | null =>
      host.querySelector<HTMLButtonElement>('button[title^="展开这组"]')

    act(() => { toggle()?.click() })
    expect(host.querySelectorAll('[class*="msgImageExpandedFrame"]')).toHaveLength(4)
    expect(host.textContent).toContain('收起')
    const expanded = host.querySelector<HTMLElement>('[class*="msgImageGroupExpanded"]')
    const actions = expanded?.lastElementChild as HTMLElement | null
    expect(actions?.className).toContain('msgImageGroupExpandedActions')
    expect(actions?.textContent).toContain('收起')
    expect(expanded?.querySelector('[class*="msgImageExpandedFrame"] [class*="msgImageGroupExpandedActions"]')).toBeNull()
    expect(host.querySelectorAll('[data-ocr="side"]')).toHaveLength(4)
    expect(host.querySelectorAll('[data-ai="side"]')).toHaveLength(4)

    const collapse = [...host.querySelectorAll('button')].find((button) => button.textContent === '收起')
    act(() => { collapse?.click() })
    expect(host.querySelectorAll('[data-slot]')).toHaveLength(3)
    expect(host.textContent).toContain('展开 4')
  })

  it('自己发送的合并图片带镜像标记', () => {
    mount([21, 22].map((id) => message(id, 1)))
    expect(host.querySelector<HTMLElement>('[class*="msgImageGroupPanel"]')?.getAttribute('data-self')).toBe('1')
  })

  it('展开后收起按钮位于图片列表之后的右下角操作行', () => {
    mount([31, 32].map((id) => message(id)))
    const toggle = host.querySelector<HTMLButtonElement>('button[title^="展开这组"]')
    act(() => { toggle?.click() })
    const expanded = host.querySelector<HTMLElement>('[class*="msgImageGroupExpanded"]')
    const lastFrame = expanded?.querySelector<HTMLElement>('[class*="msgImageExpandedFrame"]:last-of-type')
    const actions = expanded?.querySelector<HTMLElement>('[class*="msgImageGroupExpandedActions"]')
    expect(actions?.previousElementSibling).toBe(lastFrame)
    expect(lastFrame?.contains(actions ?? null)).toBe(false)
  })
})
