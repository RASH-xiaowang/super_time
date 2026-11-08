/**
 * 未填 Key 或列表接口暂时不可达时的内置模型清单。
 * @vitest-environment node
 */
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { findByBaseUrl } = require('../llm-model-catalog.js') as {
  findByBaseUrl: (baseUrl: string) => { vendor: string, models: string[] } | null
}

describe('新增厂商的内置模型清单', () => {
  it('OpenCode Go 默认给出当前可用的代表模型', () => {
    const hit = findByBaseUrl('https://opencode.ai/inference/go/openai/v1')
    expect(hit?.vendor).toBe('OpenCode Go')
    expect(hit?.models).toEqual(expect.arrayContaining(['glm-5.3-flash', 'kimi-k3', 'qwen3.8-max']))
  })

  it('OpenRouter 与 Cerebras 的主机名可命中清单', () => {
    expect(findByBaseUrl('https://openrouter.ai/api/v1')?.models).toContain('~openai/gpt-sol-latest')
    expect(findByBaseUrl('https://api.cerebras.ai/v1')?.models).toContain('qwen-3.8-27b')
  })
})
