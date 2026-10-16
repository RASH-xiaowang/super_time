/**
 * 文本气泡里的「可点」必须是真的可点，「不可点」不许假装可点。
 *
 * ## 为什么现在才有用例
 *
 * `message-text.tsx` 的注释一直写着这条约定「与 `check-ui-consistency` /
 * `audit-a11y-clickable` 一致」—— 而**这两个脚本都不在仓库里**（2026-09-26 审查的
 * 同一类发现：写着有守卫，守卫没提交，等于没有守卫）。这里补上真正的守卫。
 *
 * ## 钉的是哪三件事
 *
 *  1. 链接走**真 `<a href>`**：读屏会播报「链接」、右键能复制地址；同时 `preventDefault`
 *     交给 `onOpenLink`（外链只能走主进程那道白名单闸门，不许渲染进程自己导航）。
 *  2. 提及是**展示性**高亮：不许带 `role` / `tabIndex`。一旦加上，每条群消息的 @ 都在
 *     Tab 序列里塞一个按了没反应的死焦点 —— 键盘用户要逐个跳过，比不高亮更糟。
 *  3. 只有 `https?://` 会被切成链接（判据是正则，不是「看起来像 URL」）：
 *     `javascript:` 之类的伪协议如果也生成了 `<a href>`，就是一个现成的 XSS 入口。
 * @vitest-environment jsdom
 */
import React, { createElement as h } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoot } from 'react-dom/client'
import type { MessageAtUser } from '@deepseek-ai/dsh-wechat-data/types'
import { MessageText } from './message-text.tsx'

const AT: readonly MessageAtUser[] = [{ username: 'wxid_zhang', displayName: '张三' } as MessageAtUser]

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn()
})

/** 让 React 19 的并发渲染落地（jsdom 里没有 act，就等宏任务队列转一圈）。 */
async function flush(n = 4): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise<void>((r) => { setTimeout(r, 0) })
}

/** 把气泡渲染进一个临时容器，返回容器（用例结束后卸载）。 */
async function render(text: string, atUsers?: readonly MessageAtUser[], onOpenLink = (_url: string): void => {}): Promise<HTMLElement> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(h(MessageText, { text, atUsers, onOpenLink }))
  cleanups.push(() => { root.unmount(); host.remove() })
  await flush()
  return host
}

describe('文本气泡的可点性约定', () => {
  it('明文 URL → 真 <a href>，且点击交给 onOpenLink 并阻止默认导航', async () => {
    const onOpenLink = vi.fn()
    const host = await render('看 https://example.com/a 这个链接', undefined, onOpenLink)
    const links = host.querySelectorAll('a')
    expect(links.length, '链接片段没被渲染成 <a> ⇒ 下面全部断言都会空转').toBe(1)
    const a = links[0] as HTMLAnchorElement
    expect(a.getAttribute('href')).toBe('https://example.com/a')
    expect(a.getAttribute('rel'), '缺 rel 的话 target 一旦被加上就是 window.opener 泄漏').toContain('noopener')
    expect(a.textContent).toBe('https://example.com/a')

    // jsdom 里 dispatchEvent 会走 React 19 的 root 委托
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(ev)
    expect(onOpenLink, '点击没有转交外链处理器 ⇒ 绕过主进程协议闸门的导航就回来了').toHaveBeenCalledWith('https://example.com/a')
    expect(ev.defaultPrevented, '没有 preventDefault ⇒ 渲染进程会自己去导航外链').toBe(true)
  })

  it('@提及只做视觉高亮：不许带 role / tabIndex（那是死焦点）', async () => {
    const host = await render('辛苦 @张三 复核一下', AT)
    const mention = [...host.querySelectorAll('span')].find((s) => s.textContent === '@张三')
    expect(mention, '提及没被渲染成独立节点 ⇒ 判据空转').toBeTruthy()
    expect(mention?.getAttribute('role'), '提及加了 role 就成了假按钮').toBeNull()
    expect(mention?.hasAttribute('tabindex'), '提及进了 Tab 序列 ⇒ 每条群消息多一个死焦点').toBe(false)
    expect(mention?.tagName).toBe('SPAN')
    // 提及不是链接：不许顺手给它 href
    expect(host.querySelectorAll('a').length, '提及被渲染成了 <a>').toBe(0)
  })

  it('只有 http(s) 会被切成链接：伪协议不许生成 <a href>', async () => {
    const host = await render('点 javascript:alert(1)//@张三 看看')
    expect(host.querySelectorAll('a').length, 'javascript: 生成了 <a> ⇒ XSS 入口').toBe(0)
    expect(host.textContent).toContain('javascript:alert(1)')
  })
})
