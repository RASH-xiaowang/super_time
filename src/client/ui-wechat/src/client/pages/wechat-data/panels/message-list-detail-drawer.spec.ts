// @vitest-environment jsdom
/**
 * 消息记录详情抽屉（B3）的行为判据。
 *
 * 守四件事：
 *   ① 只读入口在状态 Badge 与回复 ID 上，打开后能看到完整正文、sourceRef 与
 *      分层失败文案（标题 / 详情 / 建议），且抽屉里没有重发/探测/删除等写操作；
 *   ② 抽屉持有的是 id 而不是记录快照：事件刷新替换同 id 记录后，内容跟着变；
 *   ③ 关闭后打开状态清空，同一份 records 重渲染不会让抽屉自己回来；
 *   ④ 顶部复制按钮写进剪贴板的正是正文 / sourceRef。
 *
 * Radix Drawer 的 Portal 与焦点副作用跨宏任务，flush 方式与
 * `BugReportDialog.spec.ts` / `favorites-chatlog-preview.spec.ts` 一致。
 */
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageListRecord } from '@deepseek-ai/dsh-wechat-data/types'
import { MessageListRecords } from './message-list-records.tsx'

let host: HTMLDivElement
let root: Root
const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined)

function baseRecord(patch: Partial<MessageListRecord> = {}): MessageListRecord {
  return {
    id: 11,
    replyId: 'ml-11',
    chatName: 'ai-微信助理',
    targetName: 'ai-微信助理',
    text: '第一段正文\n第二段正文',
    images: [],
    triggeredAt: 1_793_262_006_439,
    source: 'ai_reply',
    status: 'failed',
    note: 'AI 回复 · 自动生成',
    chatUsername: 'wxid_peer',
    targetUsername: 'wxid_peer',
    webhookUrl: 'http://192.0.2.10:17890/webhook/***',
    error: '会话已有更新的消息，本次 AI 回复已过期取消；不会自动补发旧问题',
    failureKind: 'superseded',
    attempts: 2,
    createdAt: 1_793_262_006_439,
    updatedAt: 1_793_262_011_630,
    lastAttemptAt: 1_793_262_011_630,
    sourceRef: 'ai-reply:acct:talker:1',
    segmentIndex: 2,
    segmentCount: 3,
    jobId: 'jobs/abc',
    jobState: 'running',
    ...patch,
  }
}

function propsFor(records: MessageListRecord[]): Parameters<typeof MessageListRecords>[0] {
  return {
    records,
    total: records.length,
    stats: {
      success: 0,
      failed: records.filter((record) => record.status === 'failed').length,
      pending: records.filter((record) => record.status === 'pending').length,
      queued: 0,
      running: 0,
    },
    loading: false,
    readError: '',
    search: '',
    status: '',
    source: '',
    thumbs: {},
    canWrite: false,
    resendingId: null,
    batchBusy: false,
    probeBusyId: null,
    jobBusyId: null,
    onSearchChange: () => {},
    onStatusChange: () => {},
    onSourceChange: () => {},
    onRefresh: () => {},
    onResend: () => {},
    onBatchResend: async () => true,
    onBatchProbe: async () => true,
    onBatchDelete: async () => true,
    onProbe: () => {},
    onQueryJob: () => {},
    onConfigureRule: () => {},
    onConfigureRecordRule: () => {},
    regeneratingId: null,
    deletingAiReplyId: null,
    onRegenerateAiReply: () => {},
    onDeleteAiReplyRecord: () => {},
    onCleanupAiReplyRecords: async () => true,
  }
}

/** Radix 的 Portal / 焦点与 effect 都跨宏任务；逐轮 setTimeout(0) 并包在 act 里。 */
async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
    })
  }
}

async function render(records: MessageListRecord[]): Promise<void> {
  act(() => {
    root.render(createElement(MessageListRecords, propsFor(records)))
  })
  await flush()
}

async function click(element: Element | null): Promise<void> {
  expect(element, '要点击的目标不存在').not.toBeNull()
  act(() => {
    element?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await flush()
}

function openTrigger(id = 11): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    '[aria-label="查看记录 #' + String(id) + ' 详情"]',
  )
}

function dialog(): Element | null {
  return document.querySelector('[role="dialog"]')
}

function dialogButton(label: string): HTMLButtonElement | null {
  return dialog()?.querySelector<HTMLButtonElement>('button[aria-label="' + label + '"]') ?? null
}

beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  writeText.mockClear()
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
  })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => { root.unmount() })
  host.remove()
  // Radix Portal 挂在 body 下；逐个摘掉，避免下一条用例查到上一次的 DOM。
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('消息记录详情抽屉', () => {
  it('从状态徽标/回复 ID 打开，展示完整正文、sourceRef 与失败分层文案，且没有写操作', async () => {
    await render([baseRecord()])
    expect(
      document.querySelectorAll('[aria-label="查看记录 #11 详情"]'),
      '状态徽标与回复 ID 都应该是详情入口',
    ).toHaveLength(2)

    await click(openTrigger())
    const panel = dialog()
    expect(panel, '详情没有走 Radix Drawer（role=dialog 缺失）').not.toBeNull()
    const text = panel?.textContent ?? ''
    expect(text).toContain('记录 #11')
    expect(text).toContain('AI回复')
    expect(text).toContain('第一段正文\n第二段正文')
    expect(text).toContain('ai-reply:acct:talker:1')
    expect(text).toContain('这条回复已过期')
    expect(text).toContain('对方传来更新的消息')
    expect(text).toContain('建议：如需回复，请等待新消息')
    expect(text).toContain('第 2/3 段')
    expect(text).toContain('jobs/abc')
    // 只读：写入口仍只存在于表格行里，没有被搬进抽屉。
    expect(text).not.toContain('重发')
    expect(text).not.toContain('探测')
    expect(text).not.toContain('删除')
  })

  it('事件刷新后抽屉内容跟随同 id 的新记录，不停在旧快照', async () => {
    await render([baseRecord({
      status: 'pending',
      failureKind: undefined,
      error: '',
      text: '旧正文',
      sourceRef: 'ref-old',
    })])
    await click(openTrigger())
    expect(dialog()?.textContent).toContain('旧正文')
    expect(dialog()?.textContent).toContain('ref-old')

    await render([baseRecord({
      status: 'success',
      failureKind: undefined,
      error: '',
      text: '新正文，事件已刷新',
      sourceRef: 'ref-new',
      jobId: undefined,
      jobState: undefined,
    })])
    const text = dialog()?.textContent ?? ''
    expect(text, '抽屉被刷新事件关掉了').not.toBe('')
    expect(text).toContain('新正文，事件已刷新')
    expect(text).toContain('ref-new')
    expect(text).not.toContain('旧正文')
    expect(text).not.toContain('ref-old')
  })

  it('关闭后抽屉卸载并清空打开状态', async () => {
    await render([baseRecord()])
    await click(openTrigger())
    expect(dialog()).not.toBeNull()

    await click(dialogButton('关闭'))
    expect(dialog(), '关闭后抽屉还挂在 DOM 上').toBeNull()

    // 同一份 records 再渲染一次：如果 detailRecordId 没清空，记录仍在，抽屉会自己回来。
    await render([baseRecord()])
    expect(dialog(), '打开状态没有清空，重渲染后抽屉又回来了').toBeNull()
  })

  it('顶部复制按钮写入的正是正文与 sourceRef', async () => {
    const record = baseRecord()
    await render([record])
    await click(openTrigger())

    const buttons = [...(dialog()?.querySelectorAll('button') ?? [])]
    const copyBody = buttons.find((button) => button.textContent?.trim() === '复制正文')
    const copyRef = buttons.find((button) => button.textContent?.trim() === '复制 sourceRef')
    expect(copyBody, '缺少「复制正文」').toBeDefined()
    expect(copyRef, '缺少「复制 sourceRef」').toBeDefined()

    act(() => { copyBody?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    act(() => { copyRef?.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await act(async () => { await Promise.resolve() })
    expect(writeText).toHaveBeenNthCalledWith(1, record.text)
    expect(writeText).toHaveBeenNthCalledWith(2, record.sourceRef)
  })
})
