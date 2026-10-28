// @vitest-environment jsdom
/**
 * 全局搜索结果面板的行为守卫。
 *
 * 重点不是“有没有 JSX”，而是四件用户能直接感知的事：
 *   ① 群消息头像必须用 `sender_username`，不能用同名显示名猜；
 *   ② 会话/消息/联系人要展示真实时间、类型、微信号、群人数等可辨识信息；
 *   ③ 文件/收藏没有人的身份时显示类型图标，不伪造头像；
 *   ④ 长文本截断与窄面板布局必须由 CSS 保证，而不是靠后端截字符串。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSearchResultsState } from './global-search-results.tsx'

const calls = vi.hoisted(() => ({
  avatars: [] as Array<{ username: string; nickname?: string }>,
}))

vi.mock('../api.ts', () => ({
  apiGetAvatarBatched: vi.fn((options: { username: string; nickname?: string }) => {
    calls.avatars.push(options)
    return Promise.resolve({ kind: 'none' })
  }),
}))

const { GlobalSearchResults } = await import('./global-search-results.tsx')

const session = {
  username: '123@chatroom',
  displayName: '项目冲刺群',
  type: 'group',
  lastTimestamp: 1_760_000_000,
  summary: '李四：这版设计可以进入验收',
  unreadCount: 128,
  draft: '',
  pinned: true,
  hidden: false,
} as const

const message = {
  text: '这版设计可以进入验收，头像和时间都要补齐',
  username: '123@chatroom',
  create_time: 1_760_000_000,
  local_id: 42,
  name: '项目冲刺群',
  time: '2025-10-09 12:00',
  snippet: '这版设计可以进入验收，头像和时间都要补齐',
  sender: '李四',
  sender_username: 'wxid_lisi',
} as const

const contact = {
  username: 'wxid_lisi',
  name: '李四',
  category: 'contact',
  remark: '李四',
  nickname: '木子',
  alias: 'lisi_wechat',
} as const

const groupContact = {
  username: '456@chatroom',
  name: '供应链协作群',
  category: 'group',
  remark: '供应链协作群',
  nickname: '供应链协作群',
  memberCount: 38,
} as const

const file = {
  fileName: '验收清单.xlsx',
  md5: '1234567890abcdef1234567890abcdef',
  size: 2048,
  category: 'file',
  time: '2025-10-09 12:00',
  modifyTime: 1_760_000_000,
} as const

const record = {
  kind: 'transfers',
  name: '李四',
  session: 'wxid_lisi',
  time: '2025-10-09 12:00',
  sourceId: 'transfer-1',
  transferId: 'transfer-1',
} as const

const baseResults: GlobalSearchResultsState = {
  sessions: [session as never],
  hits: [message as never],
  contacts: [contact, groupContact] as never,
  moments: [],
  favorites: [],
  files: [file as never],
  records: [record],
}

let host: HTMLDivElement
let root: Root
const close = vi.fn()
const openSession = vi.fn()
const openMoments = vi.fn()
const seed = vi.fn()

function render(results: GlobalSearchResultsState = baseResults): void {
  act(() => {
    root.render(createElement(GlobalSearchResults, {
      query: '验收',
      loading: false,
      results,
      onClose: close,
      onOpenSession: openSession,
      onOpenMoments: openMoments,
      onSeed: seed,
    }))
  })
}

function buttonByLabel(prefix: string): HTMLButtonElement {
  const node = host.querySelector(`button[aria-label^="${prefix}"]`)
  expect(node, `找不到按钮：${prefix}`).not.toBeNull()
  return node as HTMLButtonElement
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  calls.avatars.length = 0
  close.mockReset()
  openSession.mockReset()
  openMoments.mockReset()
  seed.mockReset()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
})

describe('全局搜索结果面板', () => {
  it('群消息用发送者 wxid 取头像，并展示来源与时间', () => {
    render()
    const messageButton = buttonByLabel('打开消息')
    const avatar = messageButton.querySelector('[data-search-avatar]')
    expect(avatar?.getAttribute('data-username')).toBe('wxid_lisi')
    expect(avatar?.getAttribute('data-avatar-kind')).toBe('private')
    expect(messageButton.textContent).toContain('来源 项目冲刺群')
    expect(messageButton.textContent).toContain('群消息')
    expect(messageButton.textContent).toContain('这版设计可以进入验收')
    expect(calls.avatars.some(call => call.username === 'wxid_lisi')).toBe(true)
  })

  it('联系人补充微信号、昵称、群人数，会话补充未读与类型', () => {
    render()
    expect(buttonByLabel('联系人 李四').textContent).toContain('微信号 lisi_wechat')
    expect(buttonByLabel('联系人 李四').textContent).toContain('昵称 木子')
    expect(buttonByLabel('群聊 供应链协作群').textContent).toContain('38 人')
    const sessionButton = buttonByLabel('打开群聊 项目冲刺群')
    expect(sessionButton.textContent).toContain('群聊')
    expect(sessionButton.textContent).toContain('99+')
    expect(sessionButton.textContent).toContain('李四：这版设计可以进入验收')
  })

  it('文件使用类型图标，不伪造人物头像', () => {
    render()
    const fileButton = buttonByLabel('打开文件 验收清单.xlsx')
    expect(fileButton.querySelector('[data-search-avatar]')).toBeNull()
    expect(fileButton.querySelector('[data-kind="file"]')).not.toBeNull()
    expect(fileButton.textContent).toContain('2.0 KB')
  })

  it('记录标题展示解析后的名称，原始会话只留在可访问信息中', () => {
    render()
    const recordButton = buttonByLabel('打开转账记录 李四')
    expect(recordButton.textContent).toContain('李四')
    expect(recordButton.textContent).toContain('transfer-1')
    expect(recordButton.textContent).not.toContain('wxid_lisi')
    expect(recordButton.getAttribute('aria-label')).toContain('wxid_lisi')
  })

  it('无法解析记录名称时显示明确的未知标签，不把 wxid 当标题', () => {
    render({
      ...baseResults,
      records: [{
        ...record,
        name: '未知联系人',
        session: 'wxid_missing',
        sourceId: 'transfer-missing',
        transferId: 'transfer-missing',
      }],
    })
    const recordButton = buttonByLabel('打开转账记录 未知联系人')
    expect(recordButton.textContent).toContain('未知联系人')
    expect(recordButton.textContent).not.toContain('wxid_missing')
    expect(recordButton.getAttribute('aria-label')).toContain('wxid_missing')
  })

  it('点击结果先关闭面板再跳转', () => {
    render()
    act(() => { buttonByLabel('打开群聊 项目冲刺群').click() })
    expect(close).toHaveBeenCalledTimes(1)
    expect(openSession).toHaveBeenCalledWith('123@chatroom')
  })

  it('长文本与窄面板由 CSS 收敛，不截断后端原文', () => {
    const css = readFileSync(join(__dirname, 'global-search.module.css'), 'utf8')
    expect(css).toContain('-webkit-line-clamp: 2')
    expect(css).toContain('line-clamp: 2')
    expect(css).toContain('@container (max-width: 420px)')
    expect(css).toContain('grid-template-columns: 36px minmax(0, 1fr)')
  })
})
