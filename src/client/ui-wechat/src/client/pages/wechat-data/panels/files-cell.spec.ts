// @vitest-environment jsdom
/**
 * 文件面板「一格」的行为判据（#22 虚拟化：格子会随视口反复挂载/卸载）。
 *
 * 这几条钉的是搬成组件之后**最容易丢**的东西：图片类目才请求解码（视频/文件没有预览，
 * 请求了就是白敲后端）、没有缩略图时留的是扩展名图标而不是破图、`title` 里始终是全文
 * （格位只有 124px 可用，靠 CSS 省略号截断，用户要能复制到全名）。
 */
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileItem } from '@deepseek-ai/dsh-wechat-data/types'
import { FileCell } from './files-cell.tsx'

const MD5 = 'a'.repeat(32)
const file = (over: Partial<FileItem> = {}): FileItem =>
  ({ md5: MD5, fileName: MD5 + '.dat', category: 'image', fileSize: 2048, modifyTime: 1_700_000_000, ...over } as FileItem)

const onOpen = vi.fn((_f: FileItem): void => {})
const onMounted = vi.fn((_key: string): void => {})

let host: HTMLDivElement
let root: Root

function show(over: Partial<React.ComponentProps<typeof FileCell>> = {}): void {
  act(() => {
    root.render(createElement(FileCell, { f: file(), imgSrc: '', onOpen, onMounted, ...over }))
  })
}

const q = (sel: string): Element | null => host.querySelector(sel)
const need = (el: Element | null | undefined, what: string): Element => {
  expect(el ?? null, `${what} 没找到`).not.toBeNull()
  return el as Element
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  onOpen.mockReset()
  onMounted.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('FileCell', () => {
  it('图片格挂载 ⇒ 按解析键请求解码（键是剥掉 .dat 的那一份，与原图/缩略共用一个缓存槽）', () => {
    show()
    expect(onMounted.mock.calls.map((c) => c[0])).toEqual([MD5])
  })

  it('视频与文件格不请求缩略图（它们没有预览，敲后端就是白跑一趟）', () => {
    show({ f: file({ category: 'video' }) })
    show({ f: file({ category: 'file', fileName: '合同.pdf' }) })
    expect(onMounted).not.toHaveBeenCalled()
  })

  it('点击把整条交回面板（开灯箱还是开抽屉是面板的决定，格子不自己判）', () => {
    show()
    const cell = need(q('[data-file-key]'), '格子')
    act(() => { cell.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(onOpen.mock.calls).toHaveLength(1)
    expect((onOpen.mock.calls[0]?.[0] as FileItem).category).toBe('image')
  })

  it('解码到了才出 <img>；没解码到时是扩展名图标占位，不留破图', () => {
    show()
    expect(q('img')).toBeNull()
    expect(need(q('[data-file-key]'), '格子').textContent).not.toContain('<img')
    show({ imgSrc: 'data:image/png;base64,zz' })
    const img = need(q('img'), '缩略图')
    expect(img.getAttribute('src')).toBe('data:image/png;base64,zz')
    expect(img.getAttribute('referrerPolicy')).toBe('no-referrer')
  })

  it('可见文本给可读名（哈希名要换掉），而 title 里始终是完整信息', () => {
    show({ f: file({ sessionName: '项目群', sourceMonth: '2026-09' }) })
    const cell = need(q('[data-file-key]'), '格子')
    const text = cell.textContent ?? ''
    expect(text).not.toContain(MD5)
    expect(text).toContain('图片')
    const title = String(cell.getAttribute('title') ?? '')
    expect(title).toContain(MD5)
    expect(title).toContain('来源：项目群 · 2026-09')
  })

  it('可读名直接显示，且 title 不重复给同一个名字', () => {
    show({ f: file({ fileName: '合同-终版.docx', sessionName: '', sourceMonth: '' }) })
    expect(q('.fileName, [data-file-key]')?.textContent).toContain('合同-终版.docx')
    const title = String(need(q('[data-file-key]'), '格子').getAttribute('title') ?? '')
    expect(title.split('\n').filter((l) => l === '合同-终版.docx')).toHaveLength(1)
  })
})
