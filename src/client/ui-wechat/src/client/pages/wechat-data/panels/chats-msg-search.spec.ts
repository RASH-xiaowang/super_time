// @vitest-environment jsdom
/**
 * 消息内搜索的防抖计时器必须活到组件卸载为止。
 *
 * 卸载后迟到的 350ms 回调不只是“晚一个结果”：它会真的发 apiSearchMessages，
 * 并在面板已经不存在后继续持有这次搜索的 React 闭包。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatsMsgSearch } from './chats-msg-search.tsx'

const mocks = vi.hoisted(() => ({
  apiBuildSearchIndex: vi.fn(),
  apiCancelSearch: vi.fn(),
  apiCancelSearchIndexBuild: vi.fn(),
  apiGetSearchIndexStatus: vi.fn(),
  apiSearchMessages: vi.fn(),
}))

vi.mock('../api.ts', () => mocks)

type SearchApi = ReturnType<typeof useChatsMsgSearch>

let host: HTMLDivElement
let root: Root
let latest: SearchApi | null = null

const notify = vi.fn()
const setStack = vi.fn()
const setEdited = vi.fn()
const setExport = vi.fn()

function Probe(): React.JSX.Element {
  latest = useChatsMsgSearch({
    notify,
    chatlogStack: [],
    editedOpen: false,
    exportOpen: false,
    setChatlogStack: setStack,
    setEditedOpen: setEdited,
    setExportOpen: setExport,
  } as unknown as Parameters<typeof useChatsMsgSearch>[0])
  return createElement('div', { 'data-probe': '' })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  for (const fn of Object.values(mocks)) fn.mockReset()
  mocks.apiSearchMessages.mockResolvedValue({ hits: [], indexed: true })
  mocks.apiCancelSearch.mockResolvedValue({ ok: true })
  latest = null
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('useChatsMsgSearch 卸载清理', () => {
  it('350ms 防抖窗口内卸载：计时器归零，回调不得再发搜索', async () => {
    act(() => { root.render(createElement(Probe)) })
    act(() => { latest?.onSearchInput('待查关键词') })
    expect(vi.getTimerCount()).toBe(1)

    act(() => { root.unmount() })
    expect(vi.getTimerCount(), '卸载后仍留着搜索防抖计时器').toBe(0)

    act(() => { vi.advanceTimersByTime(400) })
    await flush()
    expect(mocks.apiSearchMessages, '卸载后的防抖回调仍调用了消息搜索').not.toHaveBeenCalled()

    // 让 afterEach 仍有一个可安全卸载的 root。
    root = createRoot(host)
  })
})
