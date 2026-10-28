import { describe, expect, it } from 'vitest'
import type { AskStage } from './ask-stage-merge.ts'
import {
  askNodeStatusOf,
  askRunOutcomeLabel,
  askToolStats,
  buildAskRunMetrics,
  completedAskRunPhase,
  deriveLiveAskPhase,
  formatAskRunDuration,
  isAskTimeoutSignal,
  resolveAskRunOutcome,
} from './ask-run-model.ts'

const tool = (over: Partial<AskStage> = {}): AskStage => ({
  key: 'tool:search_messages',
  label: '消息检索',
  status: 'running',
  phase: 'called',
  callId: 'c1',
  toolName: 'search_messages',
  ...over,
})

describe('ask-run-model', () => {
  it('流式阶段按生成、工具、思考、核对的优先级收敛', () => {
    expect(deriveLiveAskPhase({})).toBe('queued')
    expect(deriveLiveAskPhase({ reasoning: '先确认时间范围' })).toBe('thinking')
    expect(deriveLiveAskPhase({
      reasoning: '先确认时间范围',
      stages: [tool()],
    })).toBe('tool_calling')
    expect(deriveLiveAskPhase({
      text: '正在回答',
      stages: [tool()],
    })).toBe('generating')
    expect(deriveLiveAskPhase({
      text: '正在回答',
      stages: [{
        key: 'verify',
        label: '核对结果',
        status: 'running',
      }],
    })).toBe('verifying')
  })

  it('保留降级语义，停止优先于后端旧状态', () => {
    expect(resolveAskRunOutcome({ status: 'degraded' })).toBe('degraded')
    expect(resolveAskRunOutcome({ status: 'degraded', stopped: true })).toBe('stopped')
    expect(resolveAskRunOutcome({ withheld: true })).toBe('insufficient')
    expect(resolveAskRunOutcome({ status: 'future_status' })).toBe('unknown')
    expect(resolveAskRunOutcome({})).toBe('unknown')
    expect(resolveAskRunOutcome({ hasAnswer: true })).toBe('ok')
    expect(askRunOutcomeLabel('degraded')).toBe('已完成 · 已降级')
    expect(askRunOutcomeLabel('unknown')).toBe('状态未知')
    expect(completedAskRunPhase('failed')).toBe('failed')
    expect(completedAskRunPhase('degraded')).toBe('completed')
  })

  it('节点状态区分超时、失败、跳过与成功', () => {
    expect(askNodeStatusOf(tool({ status: 'failed', deadlineExceeded: true }))).toBe('timeout')
    expect(askNodeStatusOf(tool({ status: 'failed', errorClass: 'timeout' }))).toBe('timeout')
    expect(isAskTimeoutSignal({ errorClass: 'http', errorCode: 'ETIMEDOUT' })).toBe(true)
    expect(askNodeStatusOf(tool({ status: 'failed' }))).toBe('error')
    expect(askNodeStatusOf(tool({ status: 'skipped' }))).toBe('skipped')
    expect(askNodeStatusOf(tool({ status: 'done' }))).toBe('success')
  })

  it('成功终态与进行中的重试不会沿用上一尝试的超时标记', () => {
    expect(askNodeStatusOf(tool({
      status: 'done',
      phase: 'completed',
      errorClass: 'timeout',
      deadlineExceeded: true,
    }))).toBe('success')
    expect(askNodeStatusOf(tool({
      status: 'running',
      phase: 'retry',
      attempt: 2,
      maxAttempts: 3,
      errorClass: 'timeout',
      deadlineExceeded: true,
    }))).toBe('running')
  })

  it('工具统计只算工具阶段，累计耗时缺失时不伪造 0', () => {
    expect(askToolStats([
      tool({ status: 'done', elapsedMs: 120 }),
      tool({ key: 'tool:two', callId: 'c2', status: 'failed', elapsedMs: 30 }),
      { key: 'plan', label: '理解问题', status: 'done' },
    ])).toEqual({ total: 2, failed: 1, elapsedMs: 150 })
    expect(askToolStats([
      tool({ status: 'done' }),
    ])).toEqual({ total: 1, failed: 0 })
  })

  it('原始重试事件先按 callId 收敛，工具数与耗时不会重复累计', () => {
    expect(askToolStats([
      tool({ status: 'running', phase: 'called', attempt: 1, maxAttempts: 2, elapsedMs: 5 }),
      tool({
        status: 'running',
        phase: 'retry',
        attempt: 1,
        maxAttempts: 2,
        elapsedMs: 20,
        errorClass: 'timeout',
        deadlineExceeded: true,
      }),
      tool({ status: 'running', phase: 'retry', attempt: 2, maxAttempts: 2, elapsedMs: 25 }),
      tool({
        status: 'done',
        phase: 'completed',
        attempt: 2,
        maxAttempts: 2,
        elapsedMs: 900,
        hits: 1,
      }),
    ])).toEqual({ total: 1, failed: 0, elapsedMs: 900 })
  })

  it('耗时格式化避免伪精度', () => {
    expect(formatAskRunDuration(undefined)).toBeUndefined()
    expect(formatAskRunDuration(420)).toBe('420ms')
    expect(formatAskRunDuration(1250)).toBe('1.3s')
    expect(formatAskRunDuration(12_400)).toBe('12s')
  })

  it('后端耗时优先，首字/思考/工具耗时按真实事件计算', () => {
    expect(buildAskRunMetrics({
      startedAt: 1_000,
      firstReasoningAt: 1_100,
      reasoningEndedAt: 1_400,
      firstTokenAt: 1_500,
    }, 3_000, [
      tool({ status: 'done', elapsedMs: 200 }),
    ], 2_500)).toEqual({
      startedAt: 1_000,
      completedAt: 3_000,
      totalMs: 2_500,
      firstTokenMs: 500,
      reasoningMs: 300,
      toolMs: 200,
    })
    expect(buildAskRunMetrics({ startedAt: 1_000 }, 3_000, [])).toEqual({
      startedAt: 1_000,
      completedAt: 3_000,
      totalMs: 2_000,
    })
  })

  it('工具已全部结束但正文未到时显示准备回答，不倒退回“调用工具”', () => {
    expect(deriveLiveAskPhase({
      stages: [tool({ status: 'done', phase: 'completed', hits: 1 })],
    })).toBe('preparing')
    expect(deriveLiveAskPhase({
      reasoning: '工具已返回，继续整理结论。',
      stages: [tool({ status: 'done', phase: 'completed', hits: 1 })],
    })).toBe('thinking')
  })
})
