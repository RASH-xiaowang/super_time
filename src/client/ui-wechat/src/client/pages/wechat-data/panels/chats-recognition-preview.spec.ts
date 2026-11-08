// @vitest-environment jsdom
/**
 * 识别弹窗原图预览：缩放控件、滚轮与复位都不改变弹窗布局。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RecognitionImagePreview } from './chats-recognition-preview.tsx'

let host: HTMLDivElement
let root: Root

function mount(source = 'data:image/png;base64,AAAA'): void {
  act(() => {
    root.render(createElement(RecognitionImagePreview, { source }))
  })
}

const preview = (): HTMLElement | null =>
  document.querySelector<HTMLElement>('[data-recognition-preview="1"]')

function pointerEvent(type: string, clientX: number, clientY: number): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: 0,
  })
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
  })
  return event
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 400,
      bottom: 300,
      width: 400,
      height: 300,
      toJSON: () => ({}),
    }),
  })
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
})

describe('识别原图预览缩放', () => {
  it('按钮可放大、缩小并重置，图片只改变 transform', () => {
    mount()
    const stage = preview()
    expect(stage?.dataset.zoom).toBe('1')
    const image = stage?.querySelector('img')
    expect(image?.style.transform).toContain('scale(1)')

    act(() => {
      stage?.querySelector<HTMLButtonElement>('button[aria-label="放大识别图片"]')?.click()
    })
    expect(preview()?.dataset.zoom).toBe('1.25')
    expect(preview()?.querySelector('img')?.style.transform).toContain('scale(1.25)')

    act(() => {
      preview()?.querySelector<HTMLButtonElement>('button[aria-label="缩小识别图片"]')?.click()
    })
    expect(preview()?.dataset.zoom).toBe('1')

    act(() => {
      preview()?.querySelector<HTMLButtonElement>('button[aria-label="放大识别图片"]')?.click()
      preview()?.querySelector<HTMLButtonElement>('button[aria-label="重置图片缩放"]')?.click()
    })
    expect(preview()?.dataset.zoom).toBe('1')
  })

  it('滚轮缩放围绕鼠标位置，并可用双击复位', () => {
    mount()
    const stage = preview()
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -100,
      clientX: 320,
      clientY: 220,
    })
    act(() => { stage?.dispatchEvent(wheel) })
    expect(wheel.defaultPrevented).toBe(true)
    expect(Number(preview()?.dataset.zoom)).toBeGreaterThan(1)
    expect(preview()?.querySelector('img')?.style.transform).toMatch(/translate3d\([^0][^,]*px,/)

    act(() => {
      preview()?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
    })
    expect(preview()?.dataset.zoom).toBe('1')
    expect(preview()?.querySelector('img')?.style.transform).toContain('translate3d(0px, 0px, 0)')
  })

  it('未放大时向上拖拽即可放大', () => {
    mount()
    const stage = preview()
    act(() => {
      stage?.dispatchEvent(pointerEvent('pointerdown', 200, 220))
    })
    act(() => {
      preview()?.dispatchEvent(pointerEvent('pointermove', 210, 120))
    })
    act(() => {
      preview()?.dispatchEvent(pointerEvent('pointerup', 210, 120))
    })
    expect(Number(preview()?.dataset.zoom)).toBeGreaterThan(1)
    expect(preview()?.dataset.zoomed).toBe('true')
  })

  it('放大后可拖拽查看，松开后保留位置', () => {
    mount()
    act(() => {
      preview()?.dispatchEvent(pointerEvent('pointerdown', 200, 220))
      preview()?.dispatchEvent(pointerEvent('pointermove', 210, 120))
      preview()?.dispatchEvent(pointerEvent('pointerup', 210, 120))
    })
    const stage = preview()
    expect(Number(stage?.dataset.zoom)).toBeGreaterThan(1)
    act(() => {
      stage?.dispatchEvent(pointerEvent('pointerdown', 200, 150))
    })
    expect(preview()?.dataset.dragging).toBe('true')
    act(() => {
      preview()?.dispatchEvent(pointerEvent('pointermove', 240, 180))
    })
    act(() => {
      preview()?.dispatchEvent(pointerEvent('pointerup', 240, 180))
    })
    expect(preview()?.dataset.dragging).toBeUndefined()
    expect(preview()?.querySelector('img')?.style.transform).toContain('translate3d(')
    expect(preview()?.querySelector('img')?.style.transform).not.toContain('translate3d(0px, 0px, 0)')
  })

  it('按钮放大后拖拽位置受容器边界约束', () => {
    mount()
    act(() => {
      preview()?.querySelector<HTMLButtonElement>('button[aria-label="放大识别图片"]')?.click()
      preview()?.querySelector<HTMLButtonElement>('button[aria-label="放大识别图片"]')?.click()
    })
    const stage = preview()
    expect(stage?.dataset.zoomed).toBe('true')
    act(() => {
      stage?.dispatchEvent(pointerEvent('pointerdown', 200, 150))
    })
    expect(preview()?.dataset.dragging).toBe('true')
    act(() => {
      preview()?.dispatchEvent(pointerEvent('pointermove', 240, 180))
    })
    act(() => {
      preview()?.dispatchEvent(pointerEvent('pointerup', 240, 180))
    })
    expect(preview()?.dataset.dragging).toBeUndefined()
    expect(preview()?.querySelector('img')?.style.transform).toContain('translate3d(')
  })

  it('换到另一张图片时自动恢复 100%', () => {
    mount('data:image/png;base64,AAAA')
    act(() => {
      preview()?.querySelector<HTMLButtonElement>('button[aria-label="放大识别图片"]')?.click()
    })
    expect(preview()?.dataset.zoom).toBe('1.25')
    act(() => { mount('data:image/png;base64,BBBB') })
    expect(preview()?.dataset.zoom).toBe('1')
  })
})
