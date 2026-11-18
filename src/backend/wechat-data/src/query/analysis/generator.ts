/**
 * 消息分析的默认模型生成器。
 *
 * 与 AI 回复的生成器同构（同一套 `ctx.llm.stream`），差别只在：
 *  · 没有图片内容块（分析只读文本）；
 *  · 输出预算更大（要装一个完整 JSON），并使用低温度以稳定结构；
 *  · 不做图片降级重试（本来就没有图片）。
 *
 * @module query/analysis/generator
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { AnalysisGenerateFn } from './analyze.ts'

export interface AnalysisGeneratorDeps {
  /** 取宿主 `Context`；可能取不到（插件未挂载），调用方按「没有模型」处理。 */
  ctx: () => Context | undefined
}

/** 输出上限：一份 JSON 分析约 300–600 token，留一倍余量。 */
const ANALYSIS_MAX_TOKENS = 1200

/**
 * 默认生成器：用设置里的当前对话模型。
 * @param deps - 取 `Context` 的函数（延迟求值，避免启动期读不到模型配置）。
 * @returns 可直接注入 `AnalysisDeps.generate` 的函数。
 */
export function createDefaultAnalysisGenerator(
  deps: AnalysisGeneratorDeps,
): AnalysisGenerateFn {
  return async (input) => {
    // `ctx()` 可能拿不到（宿主装配遗漏、插件被卸载）：那等同于「没有模型」，
    // 应当返回一句可展示的原因，而不是抛 TypeError 让整个面板显示堆栈。
    const ctx = deps.ctx?.()
    if (ctx === undefined || ctx === null) {
      return { ok: false, text: '', error: '模型环境未就绪：无法读取对话模型配置' }
    }
    const selection = (ctx as unknown as {
      agentDefaultModel?: { currentSelection(): { provider: string; model: string } }
    }).agentDefaultModel?.currentSelection()
    if (selection === undefined || selection.provider === '' || selection.model === '') {
      return { ok: false, text: '', error: '未配置对话模型' }
    }
    const modelLabel = selection.provider + '/' + selection.model
    const user = createUserMessage({
      content: [{ type: 'text', text: input.prompt }] as ContentBlock[],
      source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
    })
    const options: GenerateOptions = {
      provider: selection.provider,
      model: selection.model,
      system: input.system,
      maxTokens: ANALYSIS_MAX_TOKENS,
      // 结构化输出：低温让字段名与枚举值更稳；同一会话复用 session 标识。
      temperature: 0,
      sessionId: `supertime:analysis:${input.accountKey}:${input.chatUsername}` as GenerateOptions['sessionId'],
      messages: [user],
    }
    const assembler = new BlockAssembler()
    try {
      for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
    } catch (e) {
      return {
        ok: false,
        text: '',
        error: e instanceof Error ? e.message : String(e),
        model: modelLabel,
      }
    }
    const text = assembler.blocks()
      .map((block) => block.type === 'text' ? block.text : '')
      .join('')
      .trim()
    return text === ''
      ? { ok: false, text: '', error: '模型没有返回可用内容', model: modelLabel }
      : { ok: true, text, model: modelLabel }
  }
}
