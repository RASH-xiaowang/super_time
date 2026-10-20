/**
 * keep-alive 试点的纯缓存语义。
 *
 * 这里不挂 React：缓存只关心“哪些面板已挂过、当前 tab 是否试点”，
 * 组件级“state 真的没丢”交给接线判据 + 真机切 tab 冒烟。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { ReactNode } from 'react'
import { isKeepAliveTab, keepAliveView } from './keep-alive.tsx'

describe('keep-alive 缓存', () => {
  it('只试点 chats/taskinfo，其它 tab 不缓存', () => {
    expect(isKeepAliveTab('chats')).toBe(true)
    expect(isKeepAliveTab('taskinfo')).toBe(true)
    expect(isKeepAliveTab('overview')).toBe(false)
    expect(isKeepAliveTab('moments')).toBe(false)
  })

  it('切到试点面板会入缓存；切到普通面板时独立渲染且缓存仍在', () => {
    const cache = new Map<string, ReactNode>()
    const chats = 'chats'
    const first = keepAliveView(cache, 'chats', chats)
    expect(first.panes).toEqual([['chats', chats]])
    expect(first.standalone).toBeNull()

    const overview = 'overview'
    const second = keepAliveView(cache, 'overview', overview)
    expect(second.panes).toEqual([['chats', chats]])
    expect(second.standalone).toBe(overview)

    const taskinfo = 'taskinfo'
    const third = keepAliveView(cache, 'taskinfo', taskinfo)
    expect(third.panes.map(([tab]) => tab)).toEqual(['chats', 'taskinfo'])
    expect(third.standalone).toBeNull()
  })

  it('再次切回同一试点时复用原 key，不新增重复项', () => {
    const cache = new Map<string, ReactNode>()
    keepAliveView(cache, 'chats', 'chats-v1')
    const again = keepAliveView(cache, 'chats', 'chats-v2')
    expect(again.panes).toEqual([['chats', 'chats-v2']])
  })
})
