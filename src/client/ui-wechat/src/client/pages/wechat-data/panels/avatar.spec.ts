// @vitest-environment jsdom
/**
 * Avatar 的身份边界：
 *  · 有真实 username 时走批量队列并显示真实头像；
 *  · username 缺失时只显示首字母，不按昵称猜图、不写缓存；
 *  · 同昵称不同 username 不能共享缓存。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  apiGetAvatarBatched: vi.fn(),
}))

vi.mock('../api.ts', () => ({
  apiGetAvatar: vi.fn(),
  apiGetMessageFile: vi.fn(),
  apiGetAvatarBatched: mocks.apiGetAvatarBatched,
}))

import { Avatar, avatarCache } from './chats-support.tsx'

let host: HTMLDivElement
let root: Root

const flush = async (times = 4): Promise<void> => {
  for (let i = 0; i < times; i += 1) await act(async () => { await Promise.resolve() })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  avatarCache.clear()
  mocks.apiGetAvatarBatched.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('Avatar 头像身份', () => {
  it('真实 username 命中时显示 img，并把展示名作为 nickname 传入', async () => {
    mocks.apiGetAvatarBatched.mockResolvedValue({
      kind: 'data',
      data: 'data:image/png;base64,avatar-a',
    })

    act(() => {
      root.render(createElement(Avatar, { name: '张三', username: 'wxid_a', size: 28 }))
    })
    await flush()

    expect(mocks.apiGetAvatarBatched).toHaveBeenCalledWith({ username: 'wxid_a', nickname: '张三' })
    const img = host.querySelector('img')
    expect(img, '命中头像却没有显示 img').not.toBeNull()
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,avatar-a')
    expect(avatarCache.get('wxid_a')).toBe('data:image/png;base64,avatar-a')
  })

  it('username 为空时只显示首字母，不调用批量接口、不按昵称写缓存', async () => {
    act(() => {
      root.render(createElement(Avatar, { name: '李四', username: '', size: 28 }))
    })
    await flush()

    expect(mocks.apiGetAvatarBatched).not.toHaveBeenCalled()
    expect(host.querySelector('img')).toBeNull()
    expect(host.textContent).toBe('李')
    expect(avatarCache.has('李四')).toBe(false)
    expect(avatarCache.size).toBe(0)
  })

  it('同昵称不同 username 不共享缓存', async () => {
    mocks.apiGetAvatarBatched.mockImplementation(async ({ username }: { username: string }) => ({
      kind: 'data',
      data: `data:image/png;base64,avatar-${username}`,
    }))

    act(() => {
      root.render(createElement(
        'div',
        null,
        createElement(Avatar, { name: '同名', username: 'wxid_a' }),
        createElement(Avatar, { name: '同名', username: 'wxid_b' }),
      ))
    })
    await flush()

    expect(mocks.apiGetAvatarBatched).toHaveBeenCalledWith({ username: 'wxid_a', nickname: '同名' })
    expect(mocks.apiGetAvatarBatched).toHaveBeenCalledWith({ username: 'wxid_b', nickname: '同名' })
    expect(avatarCache.get('wxid_a')).toBe('data:image/png;base64,avatar-wxid_a')
    expect(avatarCache.get('wxid_b')).toBe('data:image/png;base64,avatar-wxid_b')
    expect(avatarCache.has('同名')).toBe(false)
    const srcs = [...host.querySelectorAll('img')].map((img) => img.getAttribute('src'))
    expect(srcs).toEqual(['data:image/png;base64,avatar-wxid_a', 'data:image/png;base64,avatar-wxid_b'])
  })
})
