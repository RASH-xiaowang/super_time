// @vitest-environment jsdom
/**
 * 聊天记录查看器的行为守卫（#19 第六刀：`chats-chatlog-dialog.tsx`）。
 *
 * 这一屏是栈式的，三条只有渲染才看得见的规矩：「返回上一级」只在栈深 >1 时出现、
 * 「关闭 / 点遮罩」清的是**整个栈**（只弹一层的话，下次打开会莫名落在三层深里）、
 * 头像只能交给 `RemoteImg`（后端代理）—— `<sourceheadurl>` 是未校验的原始地址，
 * 渲染层自己去要它就把主机白名单 / 出网开关 / 操作记录整套绕过了（M23）。
 * 一条记录怎么读成一行字在 `chats-chatlog.spec.ts`，这里只管它长成什么样。
 */
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatsChatlogViewProps } from './chats-chatlog-dialog.tsx'
import { ChatsChatlogView } from './chats-chatlog-dialog.tsx'
import type { ChatlogRecord } from '@deepseek-ai/dsh-wechat-data/types'

// RemoteImg 会在挂载里去要代理地址、openLink 会调 window.open —— 两者都要换成可断言的桩，
// 而且必须"看到调用方把原始地址交进来"这件事（这正是出网纪律的断点）。
// `vi.hoisted` 是必须的：`vi.mock` 的工厂会被提升到 import 之前，只有 hoisted 的声明在它里面可用。
const stubs = vi.hoisted(() => ({
  remote: vi.fn((src: string): void => { void src }),
  openLink: vi.fn((url: string): void => { void url }),
}))

vi.mock('./remote-img.tsx', async () => {
  const { createElement } = await import('react')
  return {
    RemoteImg: ({ src, pending }: { src: string; alt?: string; pending?: React.ReactNode }): React.JSX.Element => {
      stubs.remote(src)
      return createElement('span', { 'data-proxied': src }, pending ?? null)
    },
  }
})

vi.mock('./chats-support.tsx', () => ({ openLink: (u: string): void => { stubs.openLink(u) } }))

const rec = (over: Partial<ChatlogRecord> = {}): ChatlogRecord =>
  ({ name: '甲', time: '10:00', text: '正文', ...over }) as ChatlogRecord

let host: HTMLDivElement
let root: Root
const sink = {
  onBack: vi.fn(),
  onCloseAll: vi.fn(),
  // 参数签名要写出来：`vi.fn(async () => {})` 的 calls 类型是 `[]`，取 `calls[0][0]` 直接红类型。
  openNestedChatlog: vi.fn((_rec: ChatlogRecord): Promise<void> => Promise.resolve()),
}

function props(over: Partial<ChatsChatlogViewProps> = {}): ChatsChatlogViewProps {
  return {
    depth: 1,
    frame: { title: '聊天记录', records: [rec()] },
    onCloseAll: sink.onCloseAll,
    onBack: sink.onBack,
    openNestedChatlog: sink.openNestedChatlog,
    resolving: false,
    ...over,
  }
}

function show(over: Partial<ChatsChatlogViewProps> = {}): void {
  act(() => { root.render(createElement(ChatsChatlogView, props(over))) })
}

const q = (sel: string): Element | null => host.querySelector(sel)
const qa = (sel: string): Element[] => [...host.querySelectorAll(sel)]
const need = (el: Element | null | undefined, what: string): Element => {
  expect(el ?? null, `${what} 没找到`).not.toBeNull()
  return el as Element
}
const click = (el: Element | null | undefined): void => {
  need(el, '要点的元素')
  act(() => { el?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}
const textOf = (sel: string): string => q(sel)?.textContent ?? ''
const headerBtn = (label: string): Element | undefined =>
  qa('button[class*="calClose"]').find((b) => b.getAttribute('aria-label') === label)

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  for (const k of Object.keys(sink)) (sink as unknown as Record<string, { mockReset: () => void }>)[k]?.mockReset()
  stubs.remote.mockReset()
  stubs.openLink.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('开合与栈', () => {
  it('没有栈顶 ⇒ 整块不渲染', () => {
    show({ frame: null })
    expect(q('[data-st-dialog="chats-chatlog"]')).toBeNull()
  })

  it('标题就是栈顶那层的标题（不是根层的）', () => {
    show({ frame: { title: '内层：某群', records: [rec()] }, depth: 2 })
    expect(q('[data-st-dialog="chats-chatlog"]')?.getAttribute('role')).toBe('dialog')
    expect(textOf('[class*="calTitle"]')).toBe('内层：某群')
  })

  it('栈深 1 时不给「返回上一级」；栈深 2 时给了，且它只弹一层（不是整个关掉）', () => {
    show({ depth: 1 })
    expect(headerBtn('返回上一级'), '一级里长出返回钮 ⇒ 点一下抽屉就没了').toBeUndefined()
    show({ depth: 3 })
    click(headerBtn('返回上一级'))
    expect(sink.onBack).toHaveBeenCalledTimes(1)
    expect(sink.onCloseAll, '返回上一级被写成关闭 ⇒ 三层栈一次清空').not.toHaveBeenCalled()
  })

  it('「关闭」清整个栈（只弹一层的话，下次打开会莫名落在三层深里）', () => {
    show({ depth: 3 })
    click(headerBtn('关闭'))
    expect(sink.onCloseAll).toHaveBeenCalledTimes(1)
    expect(sink.onBack).not.toHaveBeenCalled()
  })

  it('点遮罩本身 ⇒ 清栈；点在对话框里面 ⇒ 不动（填半天一碰全丢的那条老路）', () => {
    show({ depth: 2 })
    click(q('[class*="chatlogDialog"]'))
    expect(sink.onCloseAll).not.toHaveBeenCalled()
    click(q('[data-st-dialog="chats-chatlog"]'))
    expect(sink.onCloseAll).toHaveBeenCalledTimes(1)
  })
})

describe('三种数据形态', () => {
  it('解析中 ⇒ 报「解析聊天记录…」，即使此刻还没有记录也不说"暂无"', () => {
    show({ frame: { title: '聊天记录', records: [] }, resolving: true })
    expect(textOf('[class*="emptyInline"]')).toBe('解析聊天记录…')
    expect(host.textContent).not.toContain('暂无内层消息')
  })

  it('没在解析且真的没有 ⇒ 「暂无内层消息」', () => {
    show({ frame: { title: '聊天记录', records: [] } })
    expect(textOf('[class*="emptyInline"]')).toBe('暂无内层消息')
  })

  it('一行有名字与时间，正文按种类渲染（顺序与条数都对得上）', () => {
    show({
      frame: {
        title: '聊天记录',
        records: [rec({ name: '甲', time: '09:01', text: '第一句' }), rec({ name: '乙', time: '09:02', renderType: 'emoji', text: '' })],
      },
    })
    const rows = qa('[class*="chatlogRow"]')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.textContent).toContain('甲')
    expect(rows[0]?.textContent).toContain('09:01')
    expect(rows[1]?.textContent).toContain('😀 [表情]')
  })
})

describe('头像只能走代理', () => {
  it('head 地址交给 RemoteImg（组件自己不去 fetch 原始地址）', () => {
    show({ frame: { title: '聊天记录', records: [rec({ head: 'http://wx.qlogo.cn/a/193' })] } })
    expect(stubs.remote.mock.calls.map((c) => c[0])).toEqual(['http://wx.qlogo.cn/a/193'])
    expect(q('img[src^="http"]'), '渲染层直接挂了外链 <img> ⇒ 绕过主机白名单与出网开关').toBeNull()
  })

  it('没有 head ⇒ 交空串，由代理侧决定回退', () => {
    show({ frame: { title: '聊天记录', records: [rec()] } })
    expect(stubs.remote.mock.calls.map((c) => c[0])).toEqual([''])
  })
})

describe('嵌套与链接', () => {
  it('chatHistory 那一行是按钮，点它把这条记录交进栈', () => {
    const nested = rec({ renderType: 'chatHistory', text: '群聊记录', nested: [rec(), rec()] })
    show({ frame: { title: '聊天记录', records: [nested] } })
    const btn = need(q('button[class*="chatlogNested"]'), '嵌套记录按钮')
    expect(btn.textContent).toBe('📋 群聊记录（2 条）')
    click(btn)
    expect(sink.openNestedChatlog).toHaveBeenCalledTimes(1)
    expect(sink.openNestedChatlog.mock.calls[0]?.[0]).toBe(nested)
  })

  it('非 chatHistory 的行不给嵌套按钮', () => {
    show({ frame: { title: '聊天记录', records: [rec({ renderType: 'text' })] } })
    expect(q('button[class*="chatlogNested"]')).toBeNull()
  })

  it('链接行：`rel=noopener noreferrer` 齐、默认行为被拦住、地址交给 openLink', () => {
    show({ frame: { title: '聊天记录', records: [rec({ renderType: 'link', text: '点我', link: 'https://example.com/x' })] } })
    const a = need(q('a[class*="msgTextLink"]'), '链接')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    expect(a.textContent).toBe('点我')
    // 拦截 `preventDefault` 与否只能看事件对象自己：渲染进程里真开一个浏览器标签是越权行为，
    // 走的是 `openLink`（主壳那边再按开关决定）。
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    act(() => { a.dispatchEvent(ev) })
    expect(stubs.openLink).toHaveBeenCalledWith('https://example.com/x')
    expect(ev.defaultPrevented, '没拦住默认行为 ⇒ WebView 会自己跳去外部页面').toBe(true)
  })

  it('renderType 是 link 但没有可用地址 ⇒ 退成普通文本行（不给一个 href 为空的锚）', () => {
    show({ frame: { title: '聊天记录', records: [rec({ renderType: 'link', text: '只有字' })] } })
    expect(q('a[class*="msgTextLink"]')).toBeNull()
    expect(textOf('[class*="chatlogText"]')).toBe('只有字')
  })
})
