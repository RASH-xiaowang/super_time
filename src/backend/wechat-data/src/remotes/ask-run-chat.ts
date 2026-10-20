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
import type { ContentBlock, GenerateOptions, ImageBlock, TokenUsage } from '@deepseek-ai/dsh-llm'

/** 一次对话调用的形状（`runChat` 与带图降级版共用）。 */
export type RunChatFn = (
  system: string,
  userText: string,
  maxTokens: number,
  onDelta?: (text: string) => void,
  onReasoning?: (text: string) => void,
  images?: readonly ImageBlock[],
) => Promise<string>

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
}): RunChatFn {
  return async (system, userText, maxTokens, onDelta, onReasoning, images) => {
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
    }
    let acc = ''
    let emitted = false
    let reasoningAcc = ''
    for await (const chunk of deps.llm.stream(opts)) {
      deps.throwIfCanceled()
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
    // 厂商不支持 SSE 时 stream() 只 yield 一次完整 text-delta，上面已覆盖；
    // 若一个 delta 都没拿到（极端情况），最后补发一次完整文本，保证界面不会空着。
    if (onDelta && !emitted) {
      const finalText = assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
      if (finalText) onDelta(finalText)
    }
    return assembler.blocks().map(b => (b.type === 'text' ? b.text : '')).join('').trim()
  }
}
