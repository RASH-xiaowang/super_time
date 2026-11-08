// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MessageListRecord } from '@deepseek-ai/dsh-wechat-data/types'
import { useMessageListBatch } from './use-message-list-batch.ts'

function record(id: number): MessageListRecord {
  return {
    id,
    replyId: 'reply-' + String(id),
    chatName: '会话',
    targetName: '对象',
    text: '正文',
    images: [],
    triggeredAt: id,
    source: 'manual',
    status: 'pending',
    note: '',
    chatUsername: '',
    targetUsername: '',
    webhookUrl: 'https://downstream.example/webhook/token',
    error: '',
    attempts: 0,
    createdAt: id,
    updatedAt: id,
  }
}

let host: HTMLDivElement
let root: Root
let latest: ReturnType<typeof useMessageListBatch> | null = null

function Harness({ records }: { records: MessageListRecord[] }): React.JSX.Element {
  latest = useMessageListBatch({
    records,
    busy: false,
    onResend: async () => true,
    onProbe: async () => true,
    onDelete: async () => true,
  })
  return createElement('div')
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
  latest = null
})

describe('消息列表分页批量选择', () => {
  it('加载更多保留已选 id，筛选替换窗口后自动移除不可见选择', () => {
    act(() => { root.render(createElement(Harness, { records: [record(1), record(2)] })) })
    act(() => {
      latest?.toggleMode()
      latest?.toggle(1)
    })
    expect([...latest!.selectedIds]).toEqual([1])

    act(() => { root.render(createElement(Harness, { records: [record(1), record(2), record(3)] })) })
    expect([...latest!.selectedIds]).toEqual([1])
    expect(latest!.selectableCount).toBe(3)

    act(() => { root.render(createElement(Harness, { records: [record(3)] })) })
    expect([...latest!.selectedIds]).toEqual([])
    expect(latest!.selectableCount).toBe(1)
  })
})
