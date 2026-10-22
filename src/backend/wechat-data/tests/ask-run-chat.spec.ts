// @vitest-environment node
/**
 * 模型轮次适配器的取消信号接线。
 *
 * 工具循环负责给每轮模型调用发 AbortSignal；这一层必须把它原样写入
 * GenerateOptions.signal，并在流循环里优先识别调用方的“停止生成”。
 *
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import {
  createAskRunChat,
  createAskRunChatTurn,
} from '../src/remotes/ask-run-chat.ts'

const PROVIDER = 'mock'
const MODEL = 'mock-model'

function ctxWithStream(
  stream: (options: GenerateOptions) => AsyncIterable<unknown>,
): Context {
  return { llm: { stream } } as unknown as Context
}

describe('createAskRunChatTurn：取消信号透传', () => {
  it('把 input.signal 写入 GenerateOptions.signal', async () => {
    const seen: GenerateOptions[] = []
    const controller = new AbortController()
    const runTurn = createAskRunChatTurn({
      llm: ctxWithStream(async function* (options) {
        seen.push(options)
        yield { type: 'text-delta', index: 0, text: '好' }
      }).llm,
      provider: PROVIDER,
      model: MODEL,
      throwIfCanceled: () => undefined,
    })

    const out = await runTurn({
      system: '系统',
      messages: [],
      maxTokens: 32,
      signal: controller.signal,
    })

    expect(seen[0]?.signal).toBe(controller.signal)
    expect(out.text).toBe('好')
  })

  it('调用方取消优先于本轮内部 abort，错误码保持 ASK_CANCELED', async () => {
    const controller = new AbortController()
    controller.abort(Object.assign(new Error('模型轮次超时'), {
      code: 'model_timeout',
      category: 'timeout',
    }))
    const runTurn = createAskRunChatTurn({
      llm: ctxWithStream(async function* () {
        yield { type: 'text-delta', index: 0, text: '晚到内容' }
      }).llm,
      provider: PROVIDER,
      model: MODEL,
      throwIfCanceled: () => {
        throw Object.assign(new Error('已停止生成'), { code: 'ASK_CANCELED' })
      },
    })

    await expect(runTurn({
      system: '系统',
      messages: [],
      maxTokens: 32,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'ASK_CANCELED' })
  })
})

describe('createAskRunChat：第 7 个参数是可选信号', () => {
  it('兼容旧的 6 参调用，并透传第 7 参信号', async () => {
    const seen: GenerateOptions[] = []
    const controller = new AbortController()
    const runChat = createAskRunChat({
      llm: ctxWithStream(async function* (options) {
        seen.push(options)
        yield { type: 'text-delta', index: 0, text: '完成' }
      }).llm,
      provider: PROVIDER,
      model: MODEL,
      throwIfCanceled: () => undefined,
    })

    await expect(runChat('系统', '问题', 32)).resolves.toBe('完成')
    expect(seen[0]?.signal).toBeUndefined()

    const delta = vi.fn()
    await expect(runChat('系统', '问题', 32, delta, undefined, undefined, controller.signal))
      .resolves.toBe('完成')
    expect(seen[1]?.signal).toBe(controller.signal)
    expect(delta).toHaveBeenLastCalledWith('完成')
  })
})
