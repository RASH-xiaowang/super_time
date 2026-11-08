// @vitest-environment node
/**
 * Reasoning stream metadata must survive the gateway boundary. The renderer
 * uses these fields to group a thought under its tool round and to reject
 * delayed snapshots that were produced before the current version.
 */
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeAskReasoningEmitter } from '../src/gateway-core-ask-events.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('makeAskReasoningEmitter', () => {
  it('forwards segment round and monotonic content version', () => {
    const emitted: Array<{ event: string; payload: unknown }> = []
    const ctx = {
      emit: (event: string, payload: unknown) => {
        emitted.push({ event, payload })
      },
    } as unknown as Context

    const emit = makeAskReasoningEmitter(ctx, 'stream-1')
    emit?.('第二轮思考', {
      phase: 'tool_selection',
      mode: 'snapshot',
      round: 2,
      version: 7,
    })

    expect(emitted).toEqual([{
      event: 'wechat-ask/reasoning',
      payload: {
        id: 'stream-1',
        text: '第二轮思考',
        segmentText: '第二轮思考',
        segmentId: 'reasoning:tool:2',
        phase: 'tool_selection',
        round: 2,
        version: 7,
      },
    }])
  })

  it('keeps legacy aggregate text and trailing-flushes the latest snapshot', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = []
    const ctx = {
      emit: (event: string, payload: Record<string, unknown>) => {
        emitted.push({ event, payload })
      },
    } as unknown as Context
    const emit = makeAskReasoningEmitter(ctx, 'stream-2')

    emit?.('第一轮', {
      phase: 'tool_selection',
      mode: 'snapshot',
      round: 1,
      version: 1,
      seq: 1,
    })
    vi.advanceTimersByTime(20)
    emit?.('第二轮', {
      phase: 'tool_selection',
      mode: 'snapshot',
      round: 2,
      version: 1,
      seq: 2,
    })
    vi.advanceTimersByTime(10)
    emit?.('第一轮完整', {
      phase: 'tool_selection',
      mode: 'snapshot',
      round: 1,
      version: 2,
      seq: 1,
    })

    expect(emitted).toHaveLength(2)
    vi.advanceTimersByTime(50)
    expect(emitted).toHaveLength(3)
    expect(emitted[2]?.payload).toMatchObject({
      text: '第一轮完整\n\n第二轮',
      segmentText: '第一轮完整',
      segmentId: 'reasoning:tool:1',
      version: 2,
      seq: 1,
    })
  })

  it('flushes pending segments before dispose and ignores later snapshots', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000)
    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = []
    const ctx = {
      emit: (event: string, payload: Record<string, unknown>) => {
        emitted.push({ event, payload })
      },
    } as unknown as Context
    const emit = makeAskReasoningEmitter(ctx, 'stream-3')

    emit?.('第一轮旧快照', {
      phase: 'tool_selection',
      mode: 'snapshot',
      round: 1,
      version: 1,
      seq: 1,
    })
    vi.advanceTimersByTime(10)
    emit?.('第二轮', {
      phase: 'tool_selection',
      mode: 'snapshot',
      round: 2,
      version: 1,
      seq: 2,
    })
    vi.advanceTimersByTime(10)
    emit?.('第一轮最终快照', {
      phase: 'tool_selection',
      mode: 'snapshot',
      round: 1,
      version: 2,
      seq: 1,
    })

    expect(emitted).toHaveLength(2)
    emit?.dispose()
    expect(emitted).toHaveLength(3)
    expect(emitted[2]?.payload).toMatchObject({
      text: '第一轮最终快照\n\n第二轮',
      segmentText: '第一轮最终快照',
      segmentId: 'reasoning:tool:1',
      version: 2,
    })

    emit?.('丢弃', {
      phase: 'tool_selection',
      mode: 'snapshot',
      round: 1,
      version: 3,
      seq: 1,
    })
    vi.advanceTimersByTime(1_000)
    expect(emitted).toHaveLength(3)
  })

  it('flush sends the latest pending snapshots synchronously and is idempotent', () => {
    vi.useFakeTimers()
    vi.setSystemTime(3_000)
    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = []
    const ctx = {
      emit: (event: string, payload: Record<string, unknown>) => {
        emitted.push({ event, payload })
      },
    } as unknown as Context
    const emit = makeAskReasoningEmitter(ctx, 'stream-5')

    emit?.('第一轮', {
      phase: 'tool_selection',
      mode: 'snapshot',
      round: 1,
      version: 1,
      seq: 1,
    })
    vi.advanceTimersByTime(10)
    emit?.('第二轮初稿', {
      phase: 'tool_selection',
      mode: 'snapshot',
      round: 2,
      version: 1,
      seq: 2,
    })
    vi.advanceTimersByTime(10)
    emit?.('第二轮最终稿', {
      phase: 'tool_selection',
      mode: 'snapshot',
      round: 2,
      version: 2,
      seq: 2,
    })

    // 每个新分段的第一个快照立即展示，只有该分段的后续更新进入尾随节流。
    expect(emitted).toHaveLength(2)
    emit?.flush()
    expect(emitted).toHaveLength(3)
    expect(emitted[2]?.payload).toMatchObject({
      text: '第一轮\n\n第二轮最终稿',
      segmentText: '第二轮最终稿',
      version: 2,
    })

    emit?.flush()
    expect(emitted).toHaveLength(3)
  })

  it('rejects late snapshots with an older version', () => {
    const emitted: Array<{ event: string; payload: Record<string, unknown> }> = []
    const ctx = {
      emit: (event: string, payload: Record<string, unknown>) => {
        emitted.push({ event, payload })
      },
    } as unknown as Context
    const emit = makeAskReasoningEmitter(ctx, 'stream-4')

    emit?.('新快照', {
      phase: 'tool_selection',
      mode: 'snapshot',
      round: 1,
      version: 2,
      seq: 1,
    })
    emit?.('迟到的旧快照', {
      phase: 'tool_selection',
      mode: 'snapshot',
      round: 1,
      version: 1,
      seq: 1,
    })

    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.payload).toMatchObject({ text: '新快照', version: 2 })
  })
})
