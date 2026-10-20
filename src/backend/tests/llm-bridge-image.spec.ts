/**
 * LLM 桥接层的图片投影（2026-10-18，ClawBot 自动回复「识别图中内容」）。
 *
 * 守两件事：
 *  ① 纯文本消息的 content 仍是**字符串**（不改变旧请求形状）；
 *  ② 带图片块时投影成 OpenAI 兼容的 parts：`text` + `image_url`，data URL 由
 *     `data` + `mediaType` 拼出、`image_url.url` 原样透传（远端 / 调用方已拼好的 URL）。
 *
 * 这里只测纯函数，不联网。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { toOpenAiContent, toOpenAiMessage, toTokenUsage } from '../llm-bridge.js'

describe('toOpenAiMessage 的图片投影', () => {
  it('纯文本仍是字符串（旧请求形状不变）', () => {
    expect(toOpenAiMessage({ role: 'user', content: [{ type: 'text', text: '你好' }, { type: 'text', text: '在吗' }] }))
      .toEqual({ role: 'user', content: '你好在吗' })
  })

  it('base64 + mediaType ⇒ data URL 的 image_url part', () => {
    const msg = toOpenAiMessage({
      role: 'user',
      content: [
        { type: 'text', text: '分析一下这张图' },
        { type: 'image', data: 'aGVsbG8=', mediaType: 'image/png' },
      ],
    })
    expect(msg.role).toBe('user')
    expect(msg.content).toEqual([
      { type: 'text', text: '分析一下这张图' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } },
    ])
  })

  it('缺 mediaType 时按 image/jpeg 兜底；空 data 的图片块被跳过（不生成坏 URL）', () => {
    const content = toOpenAiContent({
      content: [
        { type: 'image', data: 'aGVsbG8=' },
        { type: 'image', data: '' },
        { type: 'text', text: '看图' },
      ],
    })
    expect(content).toEqual([
      { type: 'text', text: '看图' },
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aGVsbG8=' } },
    ])
  })

  it('image_url.url 原样透传（远端 / 已拼好的 data URL）', () => {
    expect(toOpenAiContent({
      content: [{ type: 'image', image_url: { url: 'https://example.test/a.png' } }],
    })).toEqual([{ type: 'image_url', image_url: { url: 'https://example.test/a.png' } }])
  })
})

describe('toTokenUsage：OpenAI 兼容 usage 归一', () => {
  it('prompt 里的缓存命中要减出 input，缓存单列（dsh-llm 口径）', () => {
    expect(toTokenUsage({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      prompt_tokens_details: { cached_tokens: 40 },
    })).toEqual({ inputTokens: 60, outputTokens: 20, totalTokens: 120, cacheReadTokens: 40 })
  })

  it('没有 total_tokens 时按 input+output 兜底；完全没有计数时返回 null（不伪造 0）', () => {
    expect(toTokenUsage({ prompt_tokens: 10, completion_tokens: 5 })).toEqual({
      inputTokens: 10, outputTokens: 5, totalTokens: 15,
    })
    expect(toTokenUsage({})).toBeNull()
    expect(toTokenUsage(undefined)).toBeNull()
  })
})
