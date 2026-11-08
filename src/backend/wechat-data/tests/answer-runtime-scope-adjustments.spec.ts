/**
 * 可收敛的日期参数偏差：收敛并记录，不触发整轮越界阻断。
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import type { AskModelTurn, RunChatTurnFn } from '../src/remotes/ask-run-chat.ts'
import {
  ANSWER_PROFILES,
  type RetrievalTool,
  type ToolResult,
} from '../src/query/tools/index.ts'
import { runToolLoop } from '../src/query/answer-runtime/tool-loop.ts'

const NOW = new Date('2026-10-22T10:00:00')

function userMessage(text: string): Message {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'answer-runtime-scope-test' },
  })
}

function tool(run: (args: Record<string, unknown>) => ToolResult): RetrievalTool {
  return {
    name: 'search_messages',
    category: 'message',
    description: 'search_messages 测试替身（说明长度足够）',
    parameters: { type: 'object', properties: {} },
    run,
  }
}

function turn(input: {
  text?: string
  calls?: Array<{ id: string; name: string; args: unknown }>
}): AskModelTurn {
  return {
    blocks: [
      ...(input.text ? [{ type: 'text' as const, text: input.text }] : []),
      ...(input.calls ?? []).map(call => ({
        type: 'tool-call' as const,
        id: ToolCallId(call.id),
        name: call.name,
        arguments: JSON.stringify(call.args),
      })),
    ],
    finish: (input.calls?.length ?? 0) > 0 ? { kind: 'tool-calls' } : { kind: 'stop' },
    text: input.text ?? '',
    reasoning: '',
  }
}

describe('工具范围守卫：日期参数可收敛', () => {
  it('模型日期偏离固定范围时收敛到锁定值，并在 trace 记录修复', async () => {
    const run = vi.fn((args: Record<string, unknown>) => {
      expect(args).toMatchObject({
        from: '2026-10-01',
        to: '2026-10-07',
      })
      return {
        tool: 'search_messages' as const,
        ok: true,
        hits: [{
          key: 'wxid_a:1',
          name: '项目群',
          time: '2026-10-03 10:00',
          snippet: '合同已确认。',
          source: 'msg' as const,
        }],
      }
    })
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '已按固定范围查询。' })
      }
      return turn({
        calls: [{
          id: 'call_scope_date',
          name: 'search_messages',
          args: { keywords: ['合同'], from: '2026-09-01', to: '2026-09-30' },
        }],
      })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop({
      system: '系统提示',
      messages: [userMessage('查合同')],
      question: '查合同',
      profile: ANSWER_PROFILES['wechat-ask'],
      profileTools: [tool(run)],
      toolContext: {
        decryptedDir: '/fake',
        now: NOW,
        scope: { from: '2026-10-01', to: '2026-10-07' },
      },
      runTurn,
      now: NOW,
    })

    expect(run).toHaveBeenCalledTimes(1)
    expect(out.toolCalls[0]).toMatchObject({ name: 'search_messages', ok: true })
    expect(out.toolCalls[0]?.note).toContain('已按本轮固定范围收敛为 2026-10-01')
    expect(out.toolCalls[0]?.note).toContain('已按本轮固定范围收敛为 2026-10-07')
    expect(out.toolCalls[0]?.errorCode).toBeUndefined()
  })

  it('不同原始日期收敛到同一固定范围时只执行一次', async () => {
    const run = vi.fn(() => ({
      tool: 'search_messages' as const,
      ok: true,
      hits: [{
        key: 'wxid_a:2',
        name: '项目群',
        time: '2026-10-03 10:00',
        snippet: '合同已确认。',
        source: 'msg' as const,
      }],
    }))
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '同一范围内只查一次。' })
      }
      return turn({
        calls: [
          {
            id: 'call_date_a',
            name: 'search_messages',
            args: { keywords: ['合同'], from: '2026-09-01', to: '2026-09-30' },
          },
          {
            id: 'call_date_b',
            name: 'search_messages',
            args: { keywords: ['合同'], from: '2026-08-01', to: '2026-08-31' },
          },
        ],
      })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop({
      system: '系统提示',
      messages: [userMessage('查合同')],
      question: '查合同',
      profile: ANSWER_PROFILES['wechat-ask'],
      profileTools: [tool(run)],
      toolContext: {
        decryptedDir: '/fake',
        now: NOW,
        scope: { from: '2026-10-01', to: '2026-10-07' },
      },
      runTurn,
      now: NOW,
    })

    expect(run).toHaveBeenCalledTimes(1)
    expect(out.toolCalls).toHaveLength(2)
    expect(out.toolCalls[0]?.deduplicated).toBe(false)
    expect(out.toolCalls[1]?.deduplicated).toBe(true)
    expect(out.toolResults).toHaveLength(1)
  })

  it('「最近」语义自动让会话消息按最新优先取，并复用锁定会话', async () => {
    const run = vi.fn((args: Record<string, unknown>) => {
      expect(args).toMatchObject({
        username: 'wxid_locked',
        order: 'desc',
        limit: 20,
      })
      return {
        tool: 'get_session_messages' as const,
        ok: true,
        hits: [{
          key: 'wxid_locked:9',
          name: '项目群',
          time: '2026-10-21 18:00',
          snippet: '最新消息',
          source: 'msg' as const,
        }],
      }
    })
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      if (input.messages.some(message => message.content.some(block => block.type === 'tool-result'))) {
        return turn({ text: '看最新消息。' })
      }
      return turn({
        calls: [{
          id: 'call_latest',
          name: 'get_session_messages',
          args: { limit: 20 },
        }],
      })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop({
      system: '系统提示',
      messages: [userMessage('最近群里聊了什么')],
      question: '最近群里聊了什么',
      profile: ANSWER_PROFILES['wechat-ask'],
      profileTools: [{
        name: 'get_session_messages',
        category: 'message',
        description: 'get_session_messages 测试替身（说明长度足够）',
        parameters: { type: 'object', properties: {} },
        run,
      }],
      toolContext: {
        decryptedDir: '/fake',
        now: NOW,
        scope: { username: 'wxid_locked' },
      },
      runTurn,
      recency: true,
      now: NOW,
    })

    expect(run).toHaveBeenCalledTimes(1)
    expect(out.toolCalls[0]).toMatchObject({
      name: 'get_session_messages',
      ok: true,
      deduplicated: false,
    })
  })

  it('真实越权仍然硬失败：会话改写与跨会话消息 key', async () => {
    const run = vi.fn(() => ({ tool: 'search_messages' as const, ok: true, hits: [] }))
    const runTurn = vi.fn(async (input: Parameters<RunChatTurnFn>[0]) => {
      const hasResult = input.messages.some(message =>
        message.content.some(block => block.type === 'tool-result'))
      if (hasResult) return turn({ text: '不能越界。' })
      return turn({
        calls: [
          {
            id: 'call_user',
            name: 'search_messages',
            args: { keywords: ['合同'], username: 'wxid_other' },
          },
          {
            id: 'call_key',
            name: 'get_message_context',
            args: { key: 'wxid_other:1' },
          },
        ],
      })
    }) as unknown as RunChatTurnFn

    const out = await runToolLoop({
      system: '系统提示',
      messages: [userMessage('查合同')],
      question: '查合同',
      profile: ANSWER_PROFILES['session-ask'],
      profileTools: [
        tool(run),
        {
          name: 'get_message_context',
          category: 'message',
          description: 'get_message_context 测试替身（说明长度足够）',
          parameters: { type: 'object', properties: {} },
          run: () => ({ tool: 'get_message_context', ok: true, hits: [] }),
        },
      ],
      toolContext: {
        decryptedDir: '/fake',
        now: NOW,
        scope: { username: 'wxid_locked' },
      },
      runTurn,
      now: NOW,
    })

    expect(run).not.toHaveBeenCalled()
    expect(out.toolCalls.map(call => call.errorCode)).toEqual([
      'scope_violation',
      'scope_violation',
    ])
  })
})
