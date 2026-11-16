// @vitest-environment jsdom
/**
 * 表情行「先占位、后测量」的行为守卫。
 *
 * 为什么必须钉住：虚拟消息行是绝对定位的，行高由内容撑出来。表情 `<img>` 在解码前
 * 高度是 0、之后最多 130px —— 没有占位时，挂载首帧量到的行高比真实值矮近 100px，
 * 紧跟着的一行就被画到它身上（真机现象：消息/日期分隔叠在一起，用户报「消息分布
 * 不对」）。这里断言占位在加载前存在、加载后交还给图片自身尺寸；以及**换图**时
 * 占位必须重新出现（虚拟列表会复用行组件，旧的 loaded 状态会让新图跳过占位）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StickerImage, StickerPlaceholder, STICKER_PLACEHOLDER_PX } from './chats-sticker.tsx'

const DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let host: HTMLDivElement
let root: Root

const sticker = (): HTMLElement => host.firstElementChild as HTMLElement
const image = (): HTMLImageElement | null => sticker().querySelector('img')
const skeleton = (): Element | null => sticker().querySelector('[aria-hidden="true"]')

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('表情占位', () => {
  it('真图默认不加载完就不交还布局：先占 STICKER_PLACEHOLDER_PX 方块', () => {
    act(() => { root.render(createElement(StickerImage, { src: DATA_URL, label: '猫猫' })) })
    expect(sticker().style.width, '加载前没有占宽 ⇒ 行高会先塌后涨').toBe(`${STICKER_PLACEHOLDER_PX}px`)
    expect(sticker().style.height).toBe(`${STICKER_PLACEHOLDER_PX}px`)
    expect(skeleton(), '加载前没有骨架').not.toBeNull()
    expect(image()?.getAttribute('alt')).toBe('猫猫')
    expect(image()?.style.opacity, '加载中的图片不能参与布局').toBe('0')
  })

  it('图片 load 之后交还固有尺寸（骨架消失、不再固定宽高）', () => {
    act(() => { root.render(createElement(StickerImage, { src: DATA_URL, label: '猫猫' })) })
    const img = image()
    expect(img).not.toBeNull()
    act(() => { img?.dispatchEvent(new Event('load')) })
    expect(skeleton(), '加载完成后骨架还在 ⇒ 行高永远多占一格').toBeNull()
    expect(sticker().style.width).toBe('')
    expect(sticker().style.height).toBe('')
    expect(image()?.getAttribute('data-loaded')).toBe('1')
  })

  it('取图（后端解码）期间也先占位：MessageEmoticon 必须接上 StickerPlaceholder', () => {
    act(() => { root.render(createElement(StickerPlaceholder)) })
    expect(sticker().style.width).toBe(`${STICKER_PLACEHOLDER_PX}px`)
    expect(sticker().style.height).toBe(`${STICKER_PLACEHOLDER_PX}px`)
    const media = readFileSync(join(import.meta.dirname, 'chats-media.tsx'), 'utf8')
    expect(media, '取图期间退回芯片 ⇒ 行高先矮后涨，表情挂载时压住下一行').toContain('if (!err) return <StickerPlaceholder />')
  })

  it('换一张表情（行组件被复用）必须重新占位，不能沿用上一张的已加载状态', () => {
    act(() => { root.render(createElement(StickerImage, { src: DATA_URL, label: '第一张' })) })
    act(() => { image()?.dispatchEvent(new Event('load')) })
    expect(skeleton()).toBeNull()
    const second = DATA_URL.replace('AAAA', 'AAAB')
    act(() => { root.render(createElement(StickerImage, { src: second, label: '第二张' })) })
    expect(skeleton(), '换了 src 却没有重新占位 ⇒ 新图加载时行高会先塌后涨').not.toBeNull()
    expect(sticker().style.height).toBe(`${STICKER_PLACEHOLDER_PX}px`)
  })
})
