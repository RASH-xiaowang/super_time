/**
 * 一次「文本 + 可选图片」的模型对话调用（2026-10-19 自 `askdeep.ts` 抽出）。
 *
 * 为什么单独成文件：`askdeep.ts` 已逼近 M21 的 1000 行上限，而这一块只依赖
 * `llm.stream` 与 dsh-llm 的组装器，和检索/落库无关；搬出来既守住上限，也让
 * 「usage 回调」这条记账接缝可以单独阅读。
 *
 * @module remotes/ask-run-chat
 */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  ImageBlock,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import type {
  AnswerModelTurn,
  AnswerRunTurnFn,
} from '../query/answer-runtime/types.ts'

/**
 * 一次对话调用的形状（`runChat` 与带图降级版共用）。
 *
 * 第 7 参是本轮模型调用的硬截止/取消信号；旧调用方可继续只传前 6 参。
 */
export type RunChatFn = (
  system: string,
  userText: string,
  maxTokens: number,
  onDelta?: (text: string) => void,
  onReasoning?: (text: string) => void,
  images?: readonly ImageBlock[],
  signal?: AbortSignal,
) => Promise<string>

/** 一次「可带工具」的模型轮次输出（运行时层定义的公共契约）。 */
export type AskModelTurn = AnswerModelTurn

/** 一次带历史消息与工具清单的模型调用。 */
export type RunChatTurnFn = AnswerRunTurnFn

/**
 * 构造一次「文本 + 可选图片」的对话调用。
 * @param deps - LLM 服务、模型、取消检查与 usage 回调。
 * @returns runChat（系统提示 + 用户文本 + 可选图片块 ⇒ 回答文本）。
 */
export function createAskRunChat(deps: {
  llm: Context['llm']
  provider: string
  model: string
  throwIfCanceled: () => void
  /** 每收到一块模型 usage 就回调（规划 / 生成 / 回炉的调用都会计数）。 */
  onUsage?: (usage: TokenUsage) => void
  /** 可选的固定取消信号（兼容旧的 6 参调用；普通调用也可逐次从第 7 参传入）。 */
  signal?: AbortSignal
}): RunChatFn {
  return async (system, userText, maxTokens, onDelta, onReasoning, images, signal) => {
    const assembler = new BlockAssembler()
    const content: ContentBlock[] = [{ type: 'text', text: userText }]
    if (images !== undefined && images.length > 0) content.push(...images)
    const opts: GenerateOptions = {
      provider: deps.provider,
      model: deps.model,
      messages: [createUserMessage({
        content,
        source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
      })],
      system,
      maxTokens,
      ...((signal ?? deps.signal) !== undefined
        ? { signal: (signal ?? deps.signal)! }
        : {}),
    }
    let acc = ''
    let emitted = false
    let reasoningAcc = ''
    for await (const chunk of deps.llm.stream(opts)) {
      const activeSignal = signal ?? deps.signal
      // 用户主动停止优先于内部 deadline abort，避免把 ASK_CANCELED 误报成 ABORT_ERR。
      deps.throwIfCanceled()
      if (activeSignal?.aborted === true) {
        throw abortError(activeSignal)
      }
      assembler.push(chunk)
      const c = chunk as { type?: string; text?: string; usage?: TokenUsage }
      if (c.type === 'usage' && c.usage !== undefined) deps.onUsage?.(c.usage)
      if (onReasoning && c.type === 'reasoning-delta' && typeof c.text === 'string') {
        reasoningAcc += c.text
        onReasoning(reasoningAcc)
      }
      if (onDelta && c.type === 'text-delta' && typeof c.text === 'string') {
        acc += c.text
        emitted = true
        onDelta(acc)
      }
    }
    const activeSignal = signal ?? deps.signal
    deps.throwIfCanceled()
    if (activeSignal?.aborted === true) {
      throw abortError(activeSignal)
    }
    const finish = assembler.finish
    if (finish.kind === 'error') {
      throw new Error(`模型调用失败：${finish.failure.message}`)
    }
    if (finish.kind === 'aborted') {
      throw new Error(`模型调用已中止：${finish.failure.message}`)
    }
    // 厂商不支持 SSE 时 stream() 只 yield 一次完整 text-delta，上面已覆盖；
    // 若一个 delta 都没拿到（极端情况），最后补发一次完整文本，保证界面不会空着。
    if (onDelta && !emitted) {
      const finalText = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
      if (finalText) onDelta(finalText)
    }
    return assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
  }
}

/**
 * 构造「多消息 + 工具」的模型轮次调用。
 *
 * 与 {@link createAskRunChat} 的分工：后者是旧问答的单轮纯文本调用；这里是工具循环
 * 的底层，必须把 assistant 的 `tool-call` 与 user-role 的 `tool-result` 原样交给
 * 适配器（OpenAI 兼容桥会投影成 `tool_calls` / `role:"tool"`），否则第二轮会失忆。
 * @param deps - LLM 服务、模型、取消检查与 usage 回调。
 * @returns 一次可带工具清单的模型调用。
 */
export function createAskRunChatTurn(deps: {
  llm: Context['llm']
  provider: string
  model: string
  throwIfCanceled: () => void
  onUsage?: (usage: TokenUsage) => void
  signal?: AbortSignal
}): RunChatTurnFn {
  return async (input) => {
    const assembler = new BlockAssembler()
    const opts: GenerateOptions = {
      provider: deps.provider,
      model: deps.model,
      messages: input.messages,
      system: input.system,
      maxTokens: input.maxTokens,
      ...((input.signal ?? deps.signal) !== undefined
        ? { signal: (input.signal ?? deps.signal)! }
        : {}),
      ...(input.tools !== undefined && input.tools.length > 0 ? { tools: input.tools } : {}),
    }
    let emitted = false
    for await (const chunk of deps.llm.stream(opts)) {
      const activeSignal = input.signal ?? deps.signal
      // 先走调用方的取消检查：模型 deadline 的 abort 只负责内部中断。
      deps.throwIfCanceled()
      if (activeSignal?.aborted === true) throw abortError(activeSignal)
      assembler.push(chunk)
      const c = chunk as { type?: string; text?: string; usage?: TokenUsage }
      if (c.type === 'usage' && c.usage !== undefined) deps.onUsage?.(c.usage)
      if (input.onReasoning && c.type === 'reasoning-delta' && typeof c.text === 'string') {
        input.onReasoning(c.text)
      }
      if (input.onDelta && c.type === 'text-delta' && typeof c.text === 'string') {
        emitted = true
        input.onDelta(c.text)
      }
    }
    const activeSignal = input.signal ?? deps.signal
    deps.throwIfCanceled()
    if (activeSignal?.aborted === true) throw abortError(activeSignal)
    const finish = assembler.finish
    if (finish.kind === 'error') throw new Error(`模型调用失败：${finish.failure.message}`)
    if (finish.kind === 'aborted') throw new Error(`模型调用已中止：${finish.failure.message}`)
    const blocks = assembler.blocks()
    const text = blocks.map(b => (b.type === 'text' ? b.text : '')).join('').trim()
    const reasoning = blocks.map(b => (b.type === 'reasoning' ? b.text : '')).join('').trim()
    // 有的端点不发 text-delta、只发 block-end：最终补发全文，保证界面不空着。
    if (input.onDelta && !emitted && text !== '') input.onDelta(text)
    return {
      blocks,
      finish,
      text,
      reasoning,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
    }
  }
}

/** 把已触发的取消信号变成可分类的错误，避免供应商晚到块继续被回放。 */
function abortError(signal: AbortSignal): Error {
  const reason = signal.reason
  const message = typeof reason === 'string' && reason.trim() !== ''
    ? reason
    : reason instanceof Error && reason.message !== ''
      ? reason.message
      : '模型调用已中止'
  const record = typeof reason === 'object' && reason !== null
    ? reason as { code?: unknown; category?: unknown }
    : undefined
  return Object.assign(new Error(message), {
    code: typeof record?.code === 'string' ? record.code : 'ABORT_ERR',
    ...(typeof record?.category === 'string' ? { category: record.category } : {}),
  })
}
