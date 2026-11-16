/**
 * AI 回复的模型生成边界。
 *
 * 默认走 DSH 当前对话模型；调用方可注入一个 provider-neutral generate 函数，
 * 以后接“大肥鱼”自己的推理接口时不必改 runner、消息列表或前端。
 * 生成器不碰微信库、不写消息列表、不直接发 Webhook。
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { normalizeChatAiReplyText } from './context.ts'
import type { ChatAiReplyContextImage } from './context.ts'
import type { ChatAiReplyGenerationResult } from './types.ts'

export type ChatAiReplyGenerateFn = (input: {
  system: string
  prompt: string
  /** 已解码的图片；默认生成器会把它作为 OpenAI 兼容的 image_url 发送。 */
  images?: ChatAiReplyContextImage[]
  accountKey: string
  chatUsername: string
  /** 生成期取消信号；沿用 DSH 的 GenerateOptions.signal。 */
  signal?: AbortSignal
}) => Promise<ChatAiReplyGenerationResult>

export interface ChatAiReplyGeneratorDeps {
  ctx: () => Context
}

/** 默认生成器：使用 DSH 设置中的对话模型，并限制单次输出长度。 */
export function createDefaultChatAiReplyGenerator(
  deps: ChatAiReplyGeneratorDeps,
): ChatAiReplyGenerateFn {
  return async (input) => {
    const ctx = deps.ctx()
    const selection = (ctx as unknown as {
      agentDefaultModel?: { currentSelection(): { provider: string; model: string } }
    }).agentDefaultModel?.currentSelection()
    if (selection === undefined || selection.provider === '' || selection.model === '') {
      return { ok: false, text: '', error: '未配置对话模型' }
    }
    const optionsBase = {
      provider: selection.provider,
      model: selection.model,
      system: input.system,
      maxTokens: 600,
      // 同一账号的同一会话始终复用同一标识；OpenCode 传输层再散列后写入
      // x-opencode-session，避免把账号或联系人原值直接发给厂商。
      sessionId: `supertime:ai-reply:${input.accountKey}:${input.chatUsername}` as GenerateOptions['sessionId'],
    }

    const run = async (
      prompt: string,
      images: ChatAiReplyContextImage[],
    ): Promise<ChatAiReplyGenerationResult> => {
      const content: ContentBlock[] = [{ type: 'text', text: prompt }]
      for (const image of images) {
        content.push({
          // mini 宿主的 OpenAI 兼容桥接器识别 data + mediaType；
          // 不会把本机文件路径暴露给厂商。
          type: 'image',
          data: image.dataUrl.slice(image.dataUrl.indexOf(',') + 1),
          mediaType: image.mediaType,
        } as unknown as ContentBlock)
      }
      const user = createUserMessage({
        content,
        source: { kind: 'plugin', plugin: 'dsh-wechat-data' },
      })
      const options: GenerateOptions = {
        ...optionsBase,
        messages: [user],
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }
      const assembler = new BlockAssembler()
      try {
        for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk)
      } catch (e) {
        if (input.signal?.aborted === true) {
          // 取消不是失败：把已经流出的部分正文交回运行器写进生成快照，
          // 绝不走图片降级再付一次费。
          const partial = normalizeChatAiReplyText(
            assembler.blocks().map((block) => block.type === 'text' ? block.text : '').join(''),
          )
          return { ok: false, text: partial, canceled: true, error: '已取消' }
        }
        return { ok: false, text: '', error: e instanceof Error ? e.message : String(e) }
      }
      const text = normalizeChatAiReplyText(
        assembler.blocks().map((block) => block.type === 'text' ? block.text : '').join(''),
      )
      return text === ''
        ? { ok: false, text: '', error: '模型没有返回可用文本' }
        : { ok: true, text }
    }

    const images = input.images ?? []
    const first = await run(input.prompt, images)
    // 取消优先于图片降级：第二次调用只会继续烧 token。
    if (first.canceled === true) return first
    if (first.ok || images.length === 0 || !isImageRequestFailure(first.error)) return first

    // 纯文本模型/不兼容端点不应让整次回复失败：去掉图片块后按原上下文降级一次。
    // 图片内容此时无法识别，模型只看到 [图片] 占位符。
    return run(stripImageNotice(input.prompt), [])
  }
}

function isImageRequestFailure(error: string | undefined): boolean {
  const text = String(error ?? '')
  return /\b(?:400|415|422)\b/.test(text)
    || /image|vision|multimodal|modality|image_url|图片|视觉/i.test(text)
}

function stripImageNotice(prompt: string): string {
  return prompt.replace(
    /\n\n本次随请求附带 \d+ 张最近的图片，请结合图片内容理解上下文。\n/,
    '\n\n（当前模型未能读取所附图片，本次只按文字上下文回复。）\n',
  )
}
