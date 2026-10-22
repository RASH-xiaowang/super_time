/**
 * 工具阶段合并的纯逻辑判据。
 *
 * 这些用例直接模拟乱序事件，不依赖 React：`called/retry` 迟到时不能把已经
 * failed/done 的卡改回运行中，尝试次数只能单调递增。
 *
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  appendAskStage,
  askToolLabel,
  askToolStatusLabel,
  normalizeAskStage,
  type AskStage,
} from './ask-stage-merge.ts'

function event(over: Partial<AskStage> = {}): AskStage {
  return {
    key: 'tool:0:search_messages',
    label: 'search_messages',
    status: 'running',
    phase: 'called',
    callId: 'call_1',
    toolName: 'search_messages',
    argumentsSummary: '{"keywords":["合同"]}',
    attempt: 1,
    maxAttempts: 2,
    ...over,
  }
}

describe('mergeAskStage：按 callId 单调合并', () => {
  it('同一 callId 的新事件原地更新，不新增第二张卡', () => {
    const one = appendAskStage([], event())
    const two = appendAskStage(one, event({
      phase: 'retry',
      status: 'running',
      attempt: 2,
      detail: '第 2 次尝试',
    }))
    expect(two).toHaveLength(1)
    expect(two[0]).toMatchObject({ phase: 'retry', attempt: 2, status: 'running' })
  })

  it('迟到的 called 不能覆盖 completed 终态', () => {
    const done = appendAskStage([], event({ phase: 'completed', status: 'done', hits: 3, elapsedMs: 120 }))
    const late = appendAskStage(done, event({
      phase: 'called',
      status: 'running',
      attempt: 1,
      elapsedMs: 5,
    }))
    expect(late[0]).toMatchObject({
      phase: 'completed',
      status: 'done',
      hits: 3,
      elapsedMs: 120,
      attempt: 1,
    })
  })

  it('迟到的 retry 不能覆盖 failed 终态；终态之间也不互相改写', () => {
    const failed = appendAskStage([], event({
      phase: 'failed',
      status: 'failed',
      errorClass: 'transient',
      deadlineExceeded: true,
      attempt: 3,
      maxAttempts: 3,
    }))
    const retry = appendAskStage(failed, event({ phase: 'retry', status: 'running', attempt: 2 }))
    expect(retry[0]).toMatchObject({
      phase: 'failed',
      status: 'failed',
      errorClass: 'transient',
      deadlineExceeded: true,
      attempt: 3,
    })
    const done = appendAskStage(retry, event({ phase: 'completed', status: 'done', hits: 9 }))
    expect(done[0]).toMatchObject({ phase: 'failed', status: 'failed' })
  })

  it('尝试次数取最大值，乱序的较小 attempt 不会把进度改回去', () => {
    const retry = appendAskStage([], event({ phase: 'retry', status: 'running', attempt: 3, maxAttempts: 4 }))
    const late = appendAskStage(retry, event({ phase: 'called', status: 'running', attempt: 1 }))
    expect(late[0]).toMatchObject({ attempt: 3, maxAttempts: 4 })
  })

  it('旧后端只有 key/status 时仍兼容，并按 key 合并', () => {
    const first = appendAskStage([], {
      key: 'retrieve',
      label: '检索本机记录',
      status: 'running',
    })
    const second = appendAskStage(first, {
      key: 'retrieve',
      label: '检索本机记录',
      status: 'done',
      detail: '召回 12 条',
    })
    expect(second).toEqual([{
      key: 'retrieve',
      label: '检索本机记录',
      status: 'done',
      detail: '召回 12 条',
    }])
  })
})

describe('工具阶段展示文案', () => {
  it('中文工具名、运行/重试/失败/超时状态齐全', () => {
    expect(askToolLabel(event())).toBe('消息检索')
    expect(askToolStatusLabel(event())).toBe('调用中')
    expect(askToolStatusLabel(event({ phase: 'retry', attempt: 2 }))).toBe('重试中')
    expect(askToolStatusLabel(event({ status: 'failed', phase: 'failed' }))).toBe('失败')
    expect(askToolStatusLabel(event({ status: 'failed', phase: 'failed', deadlineExceeded: true }))).toBe('超时')
    expect(askToolStatusLabel(event({ status: 'done', phase: 'completed' }))).toBe('完成')
    expect(askToolStatusLabel(event({ status: 'skipped', phase: 'failed' }))).toBe('未执行')
  })

  it('未知后端字段和缺失字段不会崩，缺 key/label 的事件被丢弃', () => {
    expect(normalizeAskStage({ key: 'x', label: 'X', status: 'future_status' })).toMatchObject({
      key: 'x',
      label: 'X',
      status: 'running',
    })
    expect(normalizeAskStage({ key: 'x' })).toBeNull()
    expect(appendAskStage([], null)).toEqual([])
  })
})
