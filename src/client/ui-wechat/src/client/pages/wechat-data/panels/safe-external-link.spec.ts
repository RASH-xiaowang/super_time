/**
 * 不可信外链的**行为**判据（jsdom）。
 *
 * 微信消息 / 收藏 / 朋友圈里的 URL 来自数据文件，属于不可信内容。`javascript:` 之类
 * 一旦直接进 `<a href>`，点击就是一次任意脚本执行；`file:` / `data:` 同样不该成为链接。
 * 这里守三件事：
 *   ① `safeExternalHref` 只放行 http/https（大小写与首尾空白归一）；
 *   ② `SafeExternalLink` 对安全地址保持原生 `<a target="_blank">` 行为，对不安全地址
 *      **不生成 `<a>`**（退化成纯文本或按 fallback 隐藏）；
 *   ③ `openLink` 对不安全地址不调用 `window.open`（旧入口也不能绕道执行）。
 *
 * @vitest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SafeExternalLink, openLink, safeExternalHref } from './chats-support.tsx'

const UNSAFE = [
  'javascript:alert(1)',
  '  JavaScript:alert(1)',
  'file:///C:/Windows/win.ini',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  '//evil.example/path',
  '/relative/path',
  '',
]

let root: Root | null = null
let host: HTMLElement

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
})

afterEach(() => {
  if (root) {
    act(() => { root?.unmount() })
    root = null
  }
  host.remove()
  vi.restoreAllMocks()
})

function render(node: React.ReactElement): void {
  root = createRoot(host)
  act(() => { root?.render(node) })
}

describe('safeExternalHref（白名单）', () => {
  it('http / https 放行，并去掉首尾空白（大小写不敏感）', () => {
    expect(safeExternalHref('https://example.com/a?b=1')).toBe('https://example.com/a?b=1')
    expect(safeExternalHref('  HTTP://example.com/x  ')).toBe('HTTP://example.com/x')
  })

  it('javascript / file / data / vbscript / 相对地址一律拒绝', () => {
    for (const url of UNSAFE) {
      expect(safeExternalHref(url), `${JSON.stringify(url)} 不该被放行`).toBeNull()
    }
  })
})

describe('SafeExternalLink', () => {
  it('安全地址保持原生新标签页链接（href / target / rel 不变）', () => {
    render(createElement(SafeExternalLink, {
      href: 'https://example.com/post/1',
      className: 'link',
      title: '外部链接',
      children: '查看原文',
    }))
    const a = host.querySelector('a')
    expect(a, '安全地址没有渲染成链接').not.toBeNull()
    expect(a?.getAttribute('href')).toBe('https://example.com/post/1')
    expect(a?.getAttribute('target')).toBe('_blank')
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer')
    expect(a?.getAttribute('title')).toBe('外部链接')
    expect(a?.textContent).toBe('查看原文')
    expect(a?.className).toBe('link')
  })

  it('不安全地址不生成 <a>，默认退化成同样式纯文本', () => {
    render(createElement(SafeExternalLink, {
      href: 'javascript:alert(1)',
      className: 'link',
      children: '打开链接',
    }))
    expect(host.querySelector('a'), 'javascript: 地址仍然生成了可点击链接').toBeNull()
    const span = host.querySelector('span')
    expect(span?.textContent).toBe('打开链接')
    expect(span?.className).toBe('link')
    expect(host.innerHTML).not.toContain('javascript:')
  })

  it('显式 fallback 覆盖文案；fallback={null} 表示整段隐藏', () => {
    render(createElement(SafeExternalLink, {
      href: 'file:///C:/secret',
      fallback: '链接不可用',
      children: '打开链接',
    }))
    expect(host.textContent).toBe('链接不可用')
    expect(host.querySelector('a')).toBeNull()

    act(() => {
      root?.render(createElement(SafeExternalLink, {
        href: 'data:text/html,x',
        fallback: null,
        children: '打开链接',
      }))
    })
    expect(host.querySelector('a')).toBeNull()
    expect(host.textContent, 'fallback={null} 应完全隐藏，而不是悄悄显示 children').toBe('')
  })

  it('每个不安全协议都落成纯文本，不留可点击入口', () => {
    root = createRoot(host)
    for (const url of UNSAFE) {
      act(() => {
        root?.render(createElement(SafeExternalLink, { href: url, children: '内容' }))
      })
      expect(host.querySelector('a'), `${url} 仍然生成了链接`).toBeNull()
      expect(host.textContent).toBe('内容')
    }
  })
})

describe('openLink', () => {
  it('安全地址照旧 window.open，不安全地址不调用', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null)
    openLink('https://example.com/x')
    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('https://example.com/x', '_blank', 'noopener,noreferrer')

    open.mockClear()
    for (const url of UNSAFE) openLink(url)
    expect(open, '不安全地址绕过了白名单去调用 window.open').not.toHaveBeenCalled()
  })
})
