/**
 * askWechat 端到端耗时回归：历史与返回给 UI 的结果必须共用请求入口的墙钟。
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  createAskDeepRemotes,
  type createAskDeepRemotesInputs,
} from '../src/remotes/askdeep.ts'
import type { AnswerRuntimeStage } from '../src/query/answer-runtime/types.ts'

const mocks = vi.hoisted(() => ({
  askWithRuntime: vi.fn(),
}))

vi.mock('../src/remotes/ask-runtime.ts', () => ({
  askWithRuntime: mocks.askWithRuntime,
}))

describe('askWechat：端到端耗时', () => {
  beforeEach(() => {
    mocks.askWithRuntime.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('用请求入口到 runtime 返回的总耗时覆盖内部耗时，并原样落历史', async () => {
    let now = 1_000
    let requestStartedAt = 0
    let firstTokenAt = 0
    vi.spyOn(Date, 'now').mockImplementation(() => now)

    const runtime = {
      answer: '尾款下周一付。',
      citations: [],
      status: 'ok' as const,
      durationMs: 25,
      resources: [],
      toolCalls: [],
      plan: { intent: 'lookup' as const, subQueries: ['尾款'], terms: ['尾款'] },
      retrieval: { candidates: 1, kept: 1, scope: '本机记录', recency: false },
    }
    mocks.askWithRuntime.mockImplementation(async (runtimeDeps: {
      emitStage?: (stage: { key: string; label: string; status: string }) => void
    }) => {
      requestStartedAt = Date.now()
      now = 1_120
      runtimeDeps.emitStage?.({
        key: 'answer:synthesize',
        label: '生成回复',
        status: 'running',
      })
      now = 1_400
      return runtime
    })

    const saveAskHistory = vi.fn()
    const rc = {
      dirs: () => ({ decrypted: 'D:/fake', decoded: 'D:/fake/decoded_images' }),
      op: vi.fn(),
      ctx: () => ({
        agentDefaultModel: {
          currentSelection: () => ({ provider: 'mock', model: 'mock' }),
        },
        llm: {},
      }) as unknown as Context,
      askTrace: new Map(),
      privacyGate: (_feature: string, _stats: unknown, texts: string[]) => texts,
      embedModelName: () => 'mock-embed',
      makeEmbedFn: () => undefined,
      makeRerankFn: () => undefined,
      makeDeltaEmitter: () => undefined,
      makeReasoningEmitter: () => undefined,
      makeStageEmitter: () => (stage: AnswerRuntimeStage) => {
        if (stage.key === 'answer:synthesize' && stage.status === 'running') {
          firstTokenAt = Date.now()
        }
      },
      kbModel: () => ({ provider: 'mock', model: 'mock' }),
      askKnownEntities: () => [],
      askKnownSessions: () => [],
      saveAskHistory,
      askSignal: () => undefined,
      cancelAskJob: () => false,
    } as unknown as createAskDeepRemotesInputs

    const result = await createAskDeepRemotes(rc).askWechat({
      question: '尾款什么时候付？',
      dataScope: 'kb-only',
    })

    expect(result.durationMs).toBe(400)
    expect(firstTokenAt - requestStartedAt).toBe(120)
    expect(firstTokenAt - requestStartedAt).toBeLessThanOrEqual(result.durationMs ?? 0)
    expect(saveAskHistory).toHaveBeenCalledTimes(1)

    const [, savedResult, elapsedMs, model] = saveAskHistory.mock.calls[0] ?? []
    expect(savedResult).toBe(result)
    expect(savedResult.durationMs).toBe(400)
    expect(elapsedMs).toBe(400)
    expect(model).toBe('mock · mock')
  })
})
