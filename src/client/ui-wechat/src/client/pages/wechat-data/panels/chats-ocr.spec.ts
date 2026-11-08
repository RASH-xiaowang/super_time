// @vitest-environment jsdom
/**
 * 图片消息 OCR 入口的行为判据。
 *
 * 这里刻意不碰真实微信 OCR：组件契约只负责「何时出现、何时请求、缓存和
 * 四种结果状态」。主进程的微信原生调用由后端专项测试覆盖。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageOcrResult } from '../../../contracts.ts'

const mocks = vi.hoisted(() => ({
  desktop: true,
  ocr: vi.fn(),
}))

vi.mock('../api.ts', () => ({
  apiImageAiJson: vi.fn(),
  apiOcrImage: mocks.ocr,
  runtimeCapabilities: () => ({ isDesktop: mocks.desktop }),
}))

const { ImageOcrAction, ImageTextActions } = await import('./chats-ocr.tsx')

const result = (text: string): ImageOcrResult => ({
  engine: 'wechat-native',
  text,
  lines: text.trim() ? [{ text, left: 1, top: 2, right: 3, bottom: 4, rate: 0.98 }] : [],
  width: 800,
  height: 600,
  elapsedMs: 12,
})

function deferred<T>(): { promise: Promise<T>, resolve: (v: T) => void, reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let host: HTMLDivElement
let root: Root

function mount(localId = 1): void {
  act(() => {
    root.render(createElement(ImageOcrAction, {
      source: 'data:image/png;base64,AAAA',
      username: 'wxid_test',
      localId,
      layout: 'side',
    }))
  })
}

function mountTextActions(): void {
  act(() => {
    root.render(createElement(ImageTextActions, {
      source: 'data:image/png;base64,AAAA',
      username: 'wxid_test',
      localId: 2,
      layout: 'side',
    }))
  })
}

const action = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('button[aria-label="识别图片文字"]')
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-st-dialog="chats-ocr"]')

beforeEach(() => {
  mocks.desktop = true
  mocks.ocr.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
})

describe('图片 OCR 入口', () => {
  it('微信 OCR 在上，AI 入口紧随其下，并位于同一纵向动作栈', () => {
    mountTextActions()
    const stack = host.querySelector<HTMLElement>('[class*="msgImageActionStack"]')
    const buttons = [...(stack?.querySelectorAll('button') ?? [])]
    expect(buttons.map((button) => button.textContent)).toEqual(['?', 'AI'])
    expect(buttons[1]?.getAttribute('aria-label')).toBe('用 AI 识别图片文字并输出 JSON')
  })

  it('非桌面端不渲染按钮（手机浏览器和交接态都不留死控件）', () => {
    mocks.desktop = false
    mount()
    expect(action()).toBeNull()
  })

  it('桌面端点按后只请求一次，先显示加载，再把微信原生 OCR 文本放进弹窗', async () => {
    const pending = deferred<ImageOcrResult>()
    mocks.ocr.mockReturnValue(pending.promise)
    mount(11)

    await act(async () => {
      action()?.click()
      await Promise.resolve()
    })
    expect(mocks.ocr).toHaveBeenCalledWith('data:image/png;base64,AAAA')
    expect(dialog()?.textContent).toContain('正在用微信原生 OCR 识别图片')
    const preview = dialog()?.querySelector<HTMLElement>('[data-recognition-preview="1"]')
    expect(preview?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(preview?.nextElementSibling?.getAttribute('data-recognition-result')).toBe('1')

    await act(async () => {
      pending.resolve(result('第一行\n第二行'))
      await pending.promise
    })
    expect(dialog()?.querySelector('pre')?.textContent).toBe('第一行\n第二行')
    expect(dialog()?.textContent).toContain('微信原生 OCR')
  })

  it('空结果与失败都可读，失败后能原地重试', async () => {
    mocks.ocr.mockResolvedValueOnce(result('   '))
    mount(12)
    await act(async () => {
      action()?.click()
      await Promise.resolve()
    })
    expect(dialog()?.textContent).toContain('没有识别到文字')
    expect(dialog()?.textContent).toContain('重新识别')

    mocks.ocr.mockRejectedValueOnce(new Error('微信 OCR 插件未就绪'))
    mocks.ocr.mockResolvedValueOnce(result('重试成功'))
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')?.click()
    })
    await act(async () => {
      action()?.click()
      await Promise.resolve()
    })
    expect(dialog()?.textContent).toContain('识别失败')
    expect(dialog()?.textContent).toContain('微信 OCR 插件未就绪')

    await act(async () => {
      ;[...(dialog()?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent === '重试')
        ?.click()
      await Promise.resolve()
    })
    expect(dialog()?.querySelector('pre')?.textContent).toBe('重试成功')
  })

  it('成功结果按 username + localId 缓存；关闭后再点不重复调 OCR', async () => {
    mocks.ocr.mockResolvedValue(result('缓存文字'))
    mount(13)
    await act(async () => {
      action()?.click()
      await Promise.resolve()
    })
    expect(mocks.ocr).toHaveBeenCalledTimes(1)

    act(() => { document.querySelector<HTMLButtonElement>('button[aria-label="关闭"]')?.click() })
    expect(dialog()).toBeNull()

    await act(async () => {
      action()?.click()
      await Promise.resolve()
    })
    expect(mocks.ocr).toHaveBeenCalledTimes(1)
    expect(dialog()?.querySelector('pre')?.textContent).toBe('缓存文字')
  })

  it('复制只复制 OCR 正文，Escape 关闭弹窗', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    mocks.ocr.mockResolvedValue(result('可复制文字'))
    mount(14)
    await act(async () => {
      action()?.click()
      await Promise.resolve()
    })

    await act(async () => {
      ;[...(dialog()?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent === '复制文字')
        ?.click()
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith('可复制文字')
    expect(dialog()?.textContent).toContain('已复制')

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(dialog()).toBeNull()
  })
})
