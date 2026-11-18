// @vitest-environment node
/**
 * AI 回复的会话标识必须按「账号 + 联系人」稳定复用。
 *
 * 传输层会把该种子散列成 x-opencode-session；如果每次请求随机生成，
 * OpenCode 侧就看不到同一会话的连续性。
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { createDefaultChatAiReplyGenerator } from '../src/query/ai-reply/generator.ts'
import { buildChatAiReplyPrompt } from '../src/query/ai-reply/context.ts'

describe('AI 回复生成器的 OpenCode 会话标识', () => {
  it('同一账号与联系人会得到可复用的稳定种子', async () => {
    const seen: GenerateOptions[] = []
    const ctx = {
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'opencode', model: 'glm-5.3-flash' }),
      },
      llm: {
        stream: (options: GenerateOptions) => {
          seen.push(options)
          return (async function* () {})()
        },
      },
    } as unknown as Context
    const generate = createDefaultChatAiReplyGenerator({ ctx: () => ctx })

    const first = await generate({
      system: 'system',
      prompt: '第一次',
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
    })
    const second = await generate({
      system: 'system',
      prompt: '第二次',
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
    })

    expect(first.ok).toBe(false)
    expect(second.ok).toBe(false)
    expect(String(seen[0]?.sessionId)).toBe('supertime:ai-reply:wxid_self:wxid_peer')
    expect(String(seen[1]?.sessionId)).toBe(String(seen[0]?.sessionId))
    expect(seen[0]?.provider).toBe('opencode')
  })

  it('图片会作为 image 内容块发送，纯文本端点失败时自动降级一次', async () => {
    const seen: GenerateOptions[] = []
    const ctx = {
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'opencode', model: 'vision-model' }),
      },
      llm: {
        stream: (options: GenerateOptions) => {
          seen.push(options)
          const hasImage = options.messages.some((message) =>
            message.content.some((block) => block.type === 'image'))
          if (hasImage) {
            return (async function* () {
              throw new Error('LLM HTTP 400: image input is not supported')
            })()
          }
          return (async function* () {
            yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
            yield { type: 'text-delta' as const, index: 0, text: '收到' }
            yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: '收到' } }
            yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
          })()
        },
      },
    } as unknown as Context
    const generate = createDefaultChatAiReplyGenerator({ ctx: () => ctx })

    const result = await generate({
      system: 'system',
      // 用生产提示词原文，确保降级时真的替换掉「图片或表情」附注；
      // 手写旧文案会掩盖正则与实际提示词不一致的问题。
      prompt: buildChatAiReplyPrompt(['对方：[图片]'], 1),
      images: [{
        localId: 1,
        dataUrl: 'data:image/png;base64,aGVsbG8=',
        mediaType: 'image/png',
        bytes: 5,
      }],
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
    })

    expect(result).toEqual({ ok: true, text: '收到', model: 'opencode/vision-model' })
    expect(seen).toHaveLength(2)
    const firstContent = seen[0]?.messages[0]?.content as unknown as Array<Record<string, unknown>>
    expect(firstContent[0]).toMatchObject({ type: 'text' })
    expect(firstContent[1]).toMatchObject({
      type: 'image',
      data: 'aGVsbG8=',
      mediaType: 'image/png',
    })
    expect(seen[1]?.messages[0]?.content.some((block) => block.type === 'image')).toBe(false)
    const retryText = String((seen[1]?.messages[0]?.content[0] as { text?: string } | undefined)?.text)
    expect(retryText).toContain('当前模型未能读取所附图片')
    expect(retryText).not.toContain('本次随请求附带')
  })

  it('模型完整正文按 UTF-16 安全截断到 4000，不会拆坏 emoji', async () => {
    const longText = 'a' + '😀'.repeat(2100)
    const ctx = {
      agentDefaultModel: {
        currentSelection: () => ({ provider: 'opencode', model: 'glm-5.3-flash' }),
      },
      llm: {
        stream: () => (async function* () {
          yield { type: 'block-start' as const, index: 0, blockType: 'text' as const }
          yield { type: 'text-delta' as const, index: 0, text: longText }
          yield { type: 'block-end' as const, index: 0, block: { type: 'text' as const, text: longText } }
          yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
        })(),
      },
    } as unknown as Context
    const generate = createDefaultChatAiReplyGenerator({ ctx: () => ctx })

    const result = await generate({
      system: 'system',
      prompt: '生成一条较长回复',
      accountKey: 'wxid_self',
      chatUsername: 'wxid_peer',
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.text.length).toBeLessThanOrEqual(4000)
    expect(result.text.endsWith('…')).toBe(true)
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(result.text))
      .toBe(false)
  })
})
