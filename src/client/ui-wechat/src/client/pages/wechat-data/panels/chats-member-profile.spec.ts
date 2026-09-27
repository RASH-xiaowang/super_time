// @vitest-environment jsdom
/**
 * 群成员资料浮层的行为判据（#19 第八刀：从 `chats-view.tsx` 拆出 `chats-member-profile.tsx`）。
 *
 * 钉的是「缺的字段整行消失」这一条：微信那边 region/signature 常常返回空串而不是 null，
 * 用 `!= null` 判空会把「地区：」这种半空行画出来。另钉 `pos` 缺失时不画 ——
 * 位置是点头像时算的，没有位置就浮在 (0,0) 盖住导航栏。
 * `Avatar` 装假：它自己会发 IPC，而本文件要断的是浮层的行集合。
 */
import { act } from 'react-dom/test-utils'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import csscards from './chats-cards.module.css'
import { ChatsMemberProfile, type ChatsMemberProfileProps, type MemberProfile } from './chats-member-profile.tsx'

vi.mock('./chats-support.tsx', () => ({
  Avatar: (p: Record<string, unknown>): React.JSX.Element => createElement('i', { 'data-avatar': String(p.username) }),
}))

const rows = (): string[] => [...host.querySelectorAll('.' + csscards.memberProfileItem)]
  .map((el) => (el.firstElementChild?.textContent ?? '').trim())
const rowValue = (label: string): string | undefined => {
  const el = [...host.querySelectorAll('.' + csscards.memberProfileItem)]
    .find((r) => (r.firstElementChild?.textContent ?? '').trim() === label)
  return el?.lastElementChild?.textContent ?? undefined
}
const need = (el: Element | null | undefined, what: string): Element => {
  expect(el ?? null, `${what} 没找到`).not.toBeNull()
  return el as Element
}

let host: HTMLDivElement
let root: Root

function show(member: MemberProfile | null, pos: { left: number; top: number } | null): void {
  const props: ChatsMemberProfileProps = { member, pos }
  act(() => { root.render(createElement(ChatsMemberProfile, props)) })
}

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

describe('ChatsMemberProfile', () => {
  it('人或位置缺一个都不画（没有位置就浮在左上角盖住导航）', () => {
    show({ name: '张三', username: 'wx_zhang' }, null)
    expect(host.childElementCount).toBe(0)
    show(null, { left: 10, top: 20 })
    expect(host.childElementCount).toBe(0)
  })

  it('按点击处画，并把微信 id 带在 data 上（真机验收靠它认人）', () => {
    show({ name: '张三', username: 'wx_zhang' }, { left: 333, top: 444 })
    const pop = need(host.querySelector('[data-st-member-profile]'), '浮层')
    expect(pop.getAttribute('data-st-member-profile')).toBe('wx_zhang')
    expect((pop as HTMLElement).style.left).toBe('333px')
    expect((pop as HTMLElement).style.top).toBe('444px')
  })

  it('只有微信号一行是常驻的：缺区域/签名就整行消失（不是画一行空标签）', () => {
    show({ name: '张三', username: 'wx_zhang' }, { left: 1, top: 2 })
    expect(rows()).toEqual(['微信号'])
    expect(rowValue('微信号')).toBe('wx_zhang')
  })

  it('空串也算没有（微信那边没填的字段返回 ""，不是 undefined）', () => {
    show({ name: '张三', username: 'wx_zhang', region: '', signature: '' }, { left: 1, top: 2 })
    expect(rows()).toEqual(['微信号'])
  })

  it('有值才按「微信号 → 地区 → 签名」的顺序各占一行', () => {
    show({ name: '张三', username: 'wx_zhang', region: '广东 广州', signature: '  在路 上 ' }, { left: 1, top: 2 })
    expect(rows()).toEqual(['微信号', '地区', '签名'])
    expect(rowValue('地区')).toBe('广东 广州')
    expect(rowValue('签名')).toBe('  在路 上 ')
  })
})
