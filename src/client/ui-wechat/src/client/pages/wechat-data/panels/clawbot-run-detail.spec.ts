// @vitest-environment jsdom
/**
 * ClawBot 单条运行详情的展示回归。
 *
 * 两个最容易静默退化的点：
 *   ① 后端会把同一条 run 同时附在入站目标与出站分段上，前端若不去重，
 *      同一份工具/引用详情会在对话流里出现两次；
 *   ② `done` 只表示生成流程结束，不等于消息已发送。发送门禁拒绝时必须
 *      显示「未发送」和原因，不能让用户误以为联系人已经收到。
 */
import { createElement } from 'react'
import { act } from 'react-dom/test-utils'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClawbotMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { ClawbotThread, type useClawbotMediaAccess } from './clawbot-thread.tsx'
import { ClawbotRunDetail, autoReplyRunOf, type ClawbotRunDetailLike } from './clawbot-run-detail.tsx'

function row(over: Omit<Partial<ClawbotMessage>, 'run'> & { run?: ClawbotRunDetailLike } = {}): ClawbotMessage {
  return {
    id: 1,
    slot: 1,
    ts: Date.now(),
    direction: 'in',
    msgType: 'text',
    content: '你好',
    createdAt: Date.now(),
    media: null,
    ...over,
  } as ClawbotMessage
}

const media = {
  by: {},
  busy: new Set<number>(),
  load: vi.fn(() => Promise.resolve(null)),
  reload: vi.fn(() => Promise.resolve()),
  open: vi.fn(() => Promise.resolve()),
  zoom: null,
  setZoom: vi.fn(),
} as unknown as ReturnType<typeof useClawbotMediaAccess>

let host: HTMLDivElement
let root: Root

function show(node: React.JSX.Element): void {
  act(() => { root.render(node) })
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

describe('autoReplyRunOf', () => {
  it('旧消息与非法 runId 不伪造运行详情', () => {
    expect(autoReplyRunOf(row())).toBeNull()
    expect(autoReplyRunOf(row({ run: { runId: 0, status: 'done' } }))).toBeNull()
    expect(autoReplyRunOf(row({ run: { runId: 7, status: 'done' } }))).toMatchObject({ runId: 7 })
  })
})

describe('ClawbotRunDetail', () => {
  it('done 但发送门禁拒绝时显示未发送与可读原因', () => {
    show(createElement(ClawbotRunDetail, {
      detail: {
        runId: 9,
        status: 'done',
        sendDecision: { send: false, error: '没有可追溯的知识库引用' },
      },
    }))
    expect(host.textContent).toContain('未发送')
    expect(host.textContent).toContain('没有可追溯的知识库引用')
    expect(host.querySelector('details')?.getAttribute('data-send')).toBe('blocked')
  })

  it('没有任何可展示字段时不渲染空壳', () => {
    show(createElement(ClawbotRunDetail, { detail: { runId: 9 } }))
    expect(host.innerHTML).toBe('')
  })
})

describe('ClawbotThread 运行详情落点', () => {
  it('同一 run 同时附在入站与出站上时只渲染一次，并优先挂在入站消息下', () => {
    const runDetail: ClawbotRunDetailLike = {
      runId: 12,
      status: 'done',
      sendDecision: { send: true, detail: '已发送' },
      toolCalls: [{
        index: 0,
        round: 1,
        callId: 'call-1',
        name: 'search_kb',
        argumentsSummary: 'query=报价',
        ok: true,
        deduplicated: false,
        attempts: 1,
        retries: 0,
        elapsedMs: 20,
        hits: 2,
        facts: 0,
      }],
    }
    // rows 是后端 DESC：先给最新的出站，再给较早的入站。
    show(createElement(ClawbotThread, {
      rows: [
        row({ id: 2, direction: 'out', content: '报价是 100 元', run: runDetail }),
        row({ id: 1, direction: 'in', content: '报价多少？', run: runDetail }),
      ],
      show: text => text,
      media,
    }))
    expect(host.querySelectorAll('details')).toHaveLength(1)
    const blocks = [...host.children[0]?.children ?? []]
    const inbound = blocks.findIndex(el => el.textContent?.includes('报价多少？'))
    const outbound = blocks.findIndex(el => el.textContent?.includes('报价是 100 元'))
    const detail = blocks.findIndex(el => el.tagName.toLowerCase() === 'div' && el.querySelector('details') !== null)
    expect(detail).toBeGreaterThan(inbound)
    expect(detail).toBeLessThan(outbound)
  })

  it('没有 run 的历史消息保持原样，不附带空详情', () => {
    show(createElement(ClawbotThread, {
      rows: [row({ id: 3, direction: 'out', content: '历史消息' })],
      show: text => text,
      media,
    }))
    expect(host.querySelector('details')).toBeNull()
    expect(host.textContent).toContain('历史消息')
  })
})
