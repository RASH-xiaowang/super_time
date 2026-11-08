// @vitest-environment jsdom
/**
 * 图片 AI 入口：只在桌面端出现，点击不冒泡到图片查看器，并展示严格 JSON。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageAiJsonResult } from '../../../contracts.ts'

const mocks = vi.hoisted(() => ({
  desktop: true,
  ai: vi.fn(),
}))

vi.mock('../api.ts', () => ({
  apiImageAiJson: mocks.ai,
  runtimeCapabilities: () => ({ isDesktop: mocks.desktop }),
}))

const { ImageAiAction } = await import('./chats-image-ai.tsx')

const result = (overrides: Record<string, unknown> = {}): ImageAiJsonResult => ({
  engine: 'configured-llm',
  model: 'vision-test',
  json: {
    姓名: '张三',
    性别: '男',
    民族: '汉',
    出生日期: '1990年1月2日',
    住址: '示例省示例市示例区示例路1号',
    公民身份号码: '110101199001021234',
    ...overrides,
  },
  elapsedMs: 25,
})

function deferred<T>(): { promise: Promise<T>, resolve: (v: T) => void, reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

let host: HTMLDivElement
let root: Root

function mount(localId = 201): void {
  act(() => {
    root.render(createElement(ImageAiAction, {
      source: 'data:image/png;base64,AAAA',
      username: 'wxid_test',
      localId,
      layout: 'side',
    }))
  })
}

function mountWithParentClick(onParentClick: () => void, localId = 202): void {
  act(() => {
    root.render(createElement(
      'div',
      { onClick: onParentClick },
      createElement(ImageAiAction, {
        source: 'data:image/png;base64,AAAA',
        username: 'wxid_test',
        localId,
        layout: 'side',
      }),
    ))
  })
}

const action = (): HTMLButtonElement | null =>
  document.querySelector<HTMLButtonElement>('button[aria-label="用 AI 识别图片文字并输出 JSON"]')
const dialog = (): HTMLElement | null => document.querySelector<HTMLElement>('[data-st-dialog="chats-image-ai"]')

beforeEach(() => {
  mocks.desktop = true
  mocks.ai.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
})

describe('图片 AI 入口', () => {
  it('非桌面端不渲染入口', () => {
    mocks.desktop = false
    mount()
    expect(action()).toBeNull()
  })

  it('点击只调用当前配置的大模型，不冒泡到图片查看器', async () => {
    const pending = deferred<ImageAiJsonResult>()
    mocks.ai.mockReturnValue(pending.promise)
    const parentClick = vi.fn()
    mountWithParentClick(parentClick)

    await act(async () => {
      action()?.click()
      action()?.click()
      await Promise.resolve()
    })
    expect(mocks.ai).toHaveBeenCalledWith('data:image/png;base64,AAAA')
    expect(mocks.ai).toHaveBeenCalledTimes(1)
    expect(parentClick).not.toHaveBeenCalled()
    expect(dialog()?.textContent).toContain('图片会发送给当前配置的多模态模型处理')
    const preview = dialog()?.querySelector<HTMLElement>('[data-recognition-preview="1"]')
    expect(preview?.querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAAA')
    expect(preview?.nextElementSibling?.getAttribute('data-recognition-result')).toBe('1')

    await act(async () => {
      pending.resolve(result())
      await pending.promise
    })
    expect(dialog()?.textContent).toContain('vision-test')
    const pre = dialog()?.querySelector('pre')
    expect(JSON.parse(pre?.textContent ?? '')).toEqual(result().json)
  })

  it('失败后可原地重试，成功后复制 JSON', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    mocks.ai.mockRejectedValueOnce(new Error('请切换支持图片输入的多模态模型'))
    mocks.ai.mockResolvedValueOnce(result({ 姓名: '李四' }))
    mount(203)

    await act(async () => {
      action()?.click()
      await Promise.resolve()
    })
    expect(dialog()?.textContent).toContain('AI 识别失败')
    expect(dialog()?.textContent).toContain('支持图片输入')

    await act(async () => {
      ;[...(dialog()?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent === '重试')
        ?.click()
      await Promise.resolve()
    })
    expect(mocks.ai).toHaveBeenCalledTimes(2)
    const expectedJson = JSON.stringify(result({ 姓名: '李四' }).json, null, 2)
    expect(dialog()?.querySelector('pre')?.textContent).toBe(expectedJson)

    await act(async () => {
      ;[...(dialog()?.querySelectorAll('button') ?? [])]
        .find((button) => button.textContent === '复制 JSON')
        ?.click()
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith(expectedJson)
    expect(dialog()?.textContent).toContain('已复制 JSON')
  })

  it('短时间内重复打开复用成功结果，不再次请求模型', async () => {
    mocks.ai.mockResolvedValue(result())
    mount(204)

    await act(async () => {
      action()?.click()
      await Promise.resolve()
    })
    expect(mocks.ai).toHaveBeenCalledTimes(1)

    act(() => {
      dialog()?.querySelector<HTMLButtonElement>('button[aria-label="关闭 AI 图片文字"]')?.click()
    })
    expect(dialog()).toBeNull()

    await act(async () => {
      action()?.click()
      await Promise.resolve()
    })
    expect(mocks.ai).toHaveBeenCalledTimes(1)
    expect(dialog()?.querySelector('pre')?.textContent).toContain('"姓名"')
  })
})
