import { describe, expect, it } from 'vitest'
import {
  mergeReasoningSegment,
  normalizeAskReasoningSegment,
  traceGroupsOf,
  type AskReasoningSegment,
} from './answer-run-trace.ts'

const segment = (
  key: string,
  round: number | undefined,
  text: string,
): AskReasoningSegment => ({
  key,
  text,
  ...(round === undefined ? {} : { round }),
  phase: round === undefined ? 'synthesis' : 'tool_selection',
})

describe('answer-run-trace', () => {
  it('normalizes segmented reasoning metadata', () => {
    expect(normalizeAskReasoningSegment({
      segmentId: 'reasoning:tool:2',
      round: 2,
      phase: 'tool_selection',
      text: '第二轮思考',
    })).toEqual({
      key: 'reasoning:tool:2',
      round: 2,
      phase: 'tool_selection',
      text: '第二轮思考',
    })
  })

  it('uses segmentText when legacy aggregate text also includes prior rounds', () => {
    expect(normalizeAskReasoningSegment({
      text: '第一轮思考\n\n第二轮思考',
      segmentText: '第二轮思考',
      segmentId: 'reasoning:tool:2',
      round: 2,
      phase: 'tool_selection',
      seq: 2,
    })).toEqual({
      key: 'reasoning:tool:2',
      round: 2,
      phase: 'tool_selection',
      text: '第二轮思考',
      seq: 2,
    })
  })

  it('upserts snapshots instead of appending duplicate thought text', () => {
    const first = segment('r1', 1, '先分析')
    const updated = mergeReasoningSegment([first], segment('r1', 1, '先分析，再检索'))
    expect(updated).toHaveLength(1)
    expect(updated[0]?.text).toBe('先分析，再检索')
  })

  it('rejects stale unversioned or lower-version snapshots for the same segment', () => {
    const current = {
      ...segment('r1', 1, '完整思考'),
      version: 3,
    }
    const lower = {
      ...segment('r1', 1, '旧思考'),
      version: 2,
    }
    const unversioned = segment('r1', 1, '更旧的思考')

    expect(mergeReasoningSegment([current], lower)[0]?.text).toBe('完整思考')
    expect(mergeReasoningSegment([current], unversioned)[0]?.text).toBe('完整思考')
  })

  it('groups each round tool before its reasoning and keeps legacy fallback after tools', () => {
    const groups = traceGroupsOf({
      stages: [
        {
          key: 'tool:a',
          label: 'search_messages',
          status: 'done',
          round: 1,
          callId: 'a',
          toolName: 'search_messages',
        },
        {
          key: 'tool:b',
          label: 'get_message_context',
          status: 'done',
          round: 2,
          callId: 'b',
          toolName: 'get_message_context',
        },
      ],
      tools: [
        {
          key: 'call:a',
          name: '消息检索',
          stage: {
            key: 'tool:a',
            label: 'search_messages',
            status: 'done',
            round: 1,
            callId: 'a',
            toolName: 'search_messages',
          },
          stageEvents: [],
        },
        {
          key: 'call:b',
          name: '读取会话消息',
          stage: {
            key: 'tool:b',
            label: 'get_message_context',
            status: 'done',
            round: 2,
            callId: 'b',
            toolName: 'get_message_context',
          },
          stageEvents: [],
        },
      ],
      reasoning: [
        segment('r1', 1, '第一轮思考'),
        segment('r2', 2, '第二轮思考'),
      ],
    })
    expect(groups.map(group => group.round)).toEqual([1, 2])
    expect(groups[0]?.tools.map(tool => tool.name)).toEqual(['消息检索'])
    expect(groups[0]?.reasoning[0]?.text).toBe('第一轮思考')
    expect(groups[1]?.tools.map(tool => tool.name)).toEqual(['读取会话消息'])
    expect(groups[1]?.reasoning[0]?.text).toBe('第二轮思考')
  })

  it('renders legacy reasoning below unscoped tools, never above them', () => {
    const groups = traceGroupsOf({
      stages: [],
      tools: [{
        key: 'legacy',
        name: '消息检索',
        stage: {
          key: 'tool:legacy',
          label: 'search_messages',
          status: 'done',
          callId: 'legacy',
          toolName: 'search_messages',
        },
        stageEvents: [],
      }],
      reasoning: [{ key: 'reasoning:legacy', text: '旧版思考' }],
    })
    expect(groups).toHaveLength(1)
    expect(groups[0]?.tools).toHaveLength(1)
    expect(groups[0]?.reasoning[0]?.text).toBe('旧版思考')
  })

  it('renders legacy reasoning after numbered rounds when both formats coexist', () => {
    const groups = traceGroupsOf({
      stages: [{
        key: 'tool:search',
        label: 'search_messages',
        status: 'done',
        round: 1,
        callId: 'search',
        toolName: 'search_messages',
      }],
      tools: [{
        key: 'call:search',
        name: '消息检索',
        stage: {
          key: 'tool:search',
          label: 'search_messages',
          status: 'done',
          round: 1,
          callId: 'search',
          toolName: 'search_messages',
        },
        stageEvents: [],
      }],
      reasoning: [{ key: 'reasoning:legacy', text: '旧版整轮思考' }],
    })

    expect(groups.map(group => group.key)).toEqual(['round:1', 'trace:legacy'])
    expect(groups[1]?.reasoning[0]?.text).toBe('旧版整轮思考')
  })

  it('collapses multiple segment ids from the same round into one thought', () => {
    const groups = traceGroupsOf({
      stages: [],
      tools: [],
      reasoning: [
        { ...segment('r1b', 1, '再核对检索结果'), seq: 2 },
        { ...segment('r1a', 1, '先确认范围'), seq: 1 },
      ],
    })

    expect(groups).toHaveLength(1)
    expect(groups[0]?.reasoning).toHaveLength(1)
    expect(groups[0]?.reasoning[0]?.key).toBe('reasoning:group:round:1')
    expect(groups[0]?.reasoning[0]?.text).toBe('先确认范围\n\n再核对检索结果')
    expect(groups[0]?.reasoningKeys).toEqual(['r1a', 'r1b'])
  })

  it('uses segment id as a stable tie-breaker when sequence metadata is absent', () => {
    const reasoning = [
      { ...segment('r1z', 1, '后段思考') },
      { ...segment('r1a', 1, '前段思考') },
    ]
    const forward = traceGroupsOf({ stages: [], tools: [], reasoning })
    const reverse = traceGroupsOf({ stages: [], tools: [], reasoning: [...reasoning].reverse() })

    expect(forward[0]?.reasoning[0]?.text).toBe('前段思考\n\n后段思考')
    expect(reverse[0]?.reasoning[0]?.text).toBe(forward[0]?.reasoning[0]?.text)
  })

  it('keeps one round reasoning below all tools from the same round', () => {
    const groups = traceGroupsOf({
      stages: [],
      tools: [{
        key: 'call:search',
        name: '消息检索',
        stage: {
          key: 'tool:search',
          label: 'search_messages',
          status: 'done',
          round: 1,
          callId: 'search',
          toolName: 'search_messages',
        },
        stageEvents: [],
      }, {
        key: 'call:context',
        name: '读取会话消息',
        stage: {
          key: 'tool:context',
          label: 'get_message_context',
          status: 'done',
          round: 1,
          callId: 'context',
          toolName: 'get_message_context',
        },
        stageEvents: [],
      }],
      reasoning: [segment('r1', 1, '并行结果需要合并判断')],
    })

    expect(groups).toHaveLength(1)
    expect(groups[0]?.tools.map(tool => tool.name)).toEqual(['消息检索', '读取会话消息'])
    expect(groups[0]?.reasoning).toHaveLength(1)
    expect(groups[0]?.reasoning[0]?.text).toBe('并行结果需要合并判断')
  })

  it('orders preflight steps, numbered rounds, synthesis and verification', () => {
    const groups = traceGroupsOf({
      stages: [{
        key: 'answer:intent',
        label: '理解问题',
        status: 'done',
      }, {
        key: 'answer:tools',
        label: '工具调用',
        status: 'done',
      }, {
        key: 'answer:synthesize',
        label: '综合生成',
        status: 'done',
      }, {
        key: 'answer:verify',
        label: '核对结果',
        status: 'done',
      }],
      tools: [{
        key: 'call:2',
        name: '消息检索',
        stage: {
          key: 'tool:2',
          label: 'search_messages',
          status: 'done',
          round: 2,
          callId: 'call:2',
          toolName: 'search_messages',
        },
        stageEvents: [],
      }, {
        key: 'call:1',
        name: '读取会话',
        stage: {
          key: 'tool:1',
          label: 'get_message_context',
          status: 'done',
          round: 1,
          callId: 'call:1',
          toolName: 'get_message_context',
        },
        stageEvents: [],
      }],
      reasoning: [
        segment('r2', 2, '第二轮思考'),
        {
          key: 'reasoning:synthesis',
          phase: 'synthesis',
          text: '综合思考',
        },
        segment('r1', 1, '第一轮思考'),
      ],
    })

    expect(groups.map(group => group.key)).toEqual([
      'trace:unscoped',
      'round:1',
      'round:2',
      'answer:synthesis',
      'answer:verify',
    ])
    expect(groups[1]?.tools[0]?.name).toBe('读取会话')
    expect(groups[2]?.tools[0]?.name).toBe('消息检索')
    expect(groups[0]?.stages.map(stage => stage.key)).toEqual(['answer:intent'])
    expect(groups[3]?.stages.map(stage => stage.key)).toEqual(['answer:synthesize'])
    expect(groups[4]?.stages.map(stage => stage.key)).toEqual(['answer:verify'])
  })

  it('does not repeat the round wrapper as an inner pipeline step', () => {
    const groups = traceGroupsOf({
      stages: [{
        key: 'answer:round:1',
        label: '工具选择（第 1 轮）',
        status: 'done',
        round: 1,
      }],
      tools: [{
        key: 'call:search',
        name: '消息检索',
        stage: {
          key: 'tool:search',
          label: 'search_messages',
          status: 'done',
          round: 1,
          callId: 'search',
          toolName: 'search_messages',
        },
        stageEvents: [],
      }],
      reasoning: [],
    })

    expect(groups).toHaveLength(1)
    expect(groups[0]?.stages).toEqual([])
  })

  it('places post-retrieval blocked or clarify steps after the tool rounds', () => {
    const groups = traceGroupsOf({
      stages: [{
        key: 'answer:intent',
        label: '意图识别',
        status: 'done',
      }, {
        key: 'answer:round:1',
        label: '工具选择（第 1 轮）',
        status: 'done',
        round: 1,
      }, {
        key: 'tool:search',
        label: 'search_messages',
        status: 'done',
        phase: 'completed',
        round: 1,
        callId: 'search',
        toolName: 'search_messages',
      }, {
        key: 'answer:blocked',
        label: '检索已阻止',
        status: 'skipped',
      }],
      tools: [],
      reasoning: [],
    })

    expect(groups.map(group => group.key)).toEqual([
      'trace:unscoped',
      'round:1',
      'trace:post',
    ])
    expect(groups[2]?.stages[0]?.key).toBe('answer:blocked')
  })
})
