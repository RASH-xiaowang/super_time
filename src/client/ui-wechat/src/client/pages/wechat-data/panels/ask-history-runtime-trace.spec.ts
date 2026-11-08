/**
 * 历史轨迹恢复的纯逻辑测试：不依赖 DOM，验证持久化的两轮工具、分段思考、
 * 回答整理与核对阶段会按实时问答相同的顺序进入视图。
 */
import { describe, expect, it } from 'vitest'
import { askHistoryTraceViewOf } from './ask-history-runtime-trace.ts'
import type { AskHistoryRuntimeTrace } from '@deepseek-ai/dsh-wechat-data/types'

const trace: AskHistoryRuntimeTrace = {
  version: 1,
  truncated: false,
  toolCallTotal: 2,
  reasoningSegments: [
    { key: 'r1', round: 1, phase: 'tool_selection', text: '第一轮思考', seq: 1 },
    { key: 'r2', round: 2, phase: 'tool_selection', text: '第二轮思考', seq: 2 },
    { key: 'synthesis', phase: 'synthesis', text: '回答整理思考', seq: 3 },
  ],
  stages: [
    { key: 'answer:intent', label: '理解问题', status: 'done' },
    {
      key: 'tool:search:1', label: 'search_messages', status: 'done', round: 1,
      phase: 'completed', callId: 'call-1', toolName: 'search_messages', hits: 2,
    },
    {
      key: 'tool:context:2', label: 'get_message_context', status: 'done', round: 2,
      phase: 'completed', callId: 'call-2', toolName: 'get_message_context', hits: 1,
    },
    { key: 'answer:synthesize', label: '综合生成', status: 'done' },
    { key: 'answer:verify', label: '核对结果', status: 'done' },
  ],
  toolCalls: [
    {
      index: 0, round: 1, callId: 'call-1', name: 'search_messages', ok: true,
      deduplicated: false, attempts: 1, retries: 0, elapsedMs: 12, hits: 2, facts: 0,
    },
    {
      index: 1, round: 2, callId: 'call-2', name: 'get_message_context', ok: true,
      deduplicated: false, attempts: 1, retries: 0, elapsedMs: 18, hits: 1, facts: 1,
    },
  ],
}

describe('ask-history-runtime-trace', () => {
  it('恢复“预检 → 工具轮次 → 本轮思考 → 回答整理 → 核对结果”的完整顺序', () => {
    const view = askHistoryTraceViewOf(trace)!
    expect(view.groups.map(group => group.key)).toEqual([
      'trace:unscoped',
      'round:1',
      'round:2',
      'answer:synthesis',
      'answer:verify',
    ])
    expect(view.groups[1]?.tools.map(tool => tool.name)).toEqual(['消息检索'])
    expect(view.groups[1]?.reasoning[0]?.text).toBe('第一轮思考')
    expect(view.groups[2]?.tools.map(tool => tool.name)).toEqual(['展开消息上下文'])
    expect(view.groups[2]?.reasoning[0]?.text).toBe('第二轮思考')
    expect(view.groups[3]?.reasoning[0]?.text).toBe('回答整理思考')
    expect(view.groups[4]?.stages.map(stage => stage.key)).toEqual(['answer:verify'])
  })

  it('旧记录没有 runtimeTrace 时返回 null，历史主记录仍走原渲染路径', () => {
    expect(askHistoryTraceViewOf(undefined)).toBeNull()
  })

  it('工具摘要总数包含被预算裁掉的调用，界面能如实提示轨迹已截断', () => {
    const view = askHistoryTraceViewOf({
      ...trace,
      toolCallTotal: 30,
      truncated: true,
    })!
    expect(view.truncated).toBe(true)
    expect(view.toolCallTotal).toBe(30)
  })
})
