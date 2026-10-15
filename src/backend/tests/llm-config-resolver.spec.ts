/**
 * LLM 配置唯一解析点的纯函数判据。
 *
 * `llm-bridge.js` 的出站与 `llm-balance.js` 的探针默认值都从这里合并
 * `overrides > file > env > shared defaults`。这里把各层的优先级、`apiUrl` 到
 * `baseUrl` 的映射，以及旧实现「空串/0 都算没给值」的口径钉住，避免下一次
 * 重构又回到两条互不相通的解析链。
 * @vitest-environment node
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { resolveLlmConfig } = require('../llm-config-store.js')

interface LlmDefaults {
  provider: string
  model: string
  apiKey: string
  apiUrl: string
  apiPath: string
  embeddingModel: string
  embedPath: string
  embeddingApiUrl: string
  embeddingApiKey: string
  rerankModel: string
  rerankPath: string
  rerankApiUrl: string
  rerankApiKey: string
  rerankTimeoutMs: number
  timeoutMs: number
}

const DEFAULTS = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'src', 'shared', 'llm-defaults.json'), 'utf8'),
) as LlmDefaults

describe('LLM 配置唯一解析点', () => {
  it('没有覆盖、文件与环境变量时返回共享默认值，并把 apiUrl 映射成 baseUrl', () => {
    expect(resolveLlmConfig({})).toEqual({
      provider: DEFAULTS.provider,
      model: '',
      apiKey: '',
      baseUrl: DEFAULTS.apiUrl,
      apiPath: DEFAULTS.apiPath,
      embeddingModel: '',
      embedPath: DEFAULTS.embedPath,
      embeddingApiUrl: '',
      embeddingApiKey: '',
      rerankModel: '',
      rerankPath: DEFAULTS.rerankPath,
      rerankApiUrl: '',
      rerankApiKey: '',
      rerankTimeoutMs: DEFAULTS.rerankTimeoutMs,
      timeoutMs: DEFAULTS.timeoutMs,
    })
  })

  it('优先级为 overrides > file > env > defaults，且数字字段按值转换', () => {
    const cfg = resolveLlmConfig({
      overrides: { model: 'override-model', timeoutMs: 3000 },
      file: {
        provider: 'file-provider',
        model: 'file-model',
        apiUrl: 'https://file.example/v1',
        timeoutMs: 2000,
      },
      env: {
        SUPERTIME_LLM_PROVIDER: 'env-provider',
        SUPERTIME_LLM_MODEL: 'env-model',
        SUPERTIME_LLM_API_URL: 'https://env.example/v1',
        SUPERTIME_LLM_TIMEOUT_MS: '4000',
      },
    })
    expect(cfg.provider).toBe('file-provider')
    expect(cfg.model).toBe('override-model')
    expect(cfg.baseUrl).toBe('https://file.example/v1')
    expect(cfg.timeoutMs).toBe(3000)

    const envOnly = resolveLlmConfig({
      file: { apiUrl: '', model: 'file-model' },
      env: { SUPERTIME_LLM_API_URL: 'https://env.example/v1', SUPERTIME_LLM_MODEL: 'env-model' },
    })
    expect(envOnly.baseUrl).toBe('https://env.example/v1')
    expect(envOnly.model).toBe('file-model')
  })

  it('历史兼容参数 apiUrl 不参与覆盖；空串与 0 按旧口径继续回落', () => {
    const cfg = resolveLlmConfig({
      overrides: { apiUrl: 'https://ignored.example/v1', timeoutMs: 0 },
      file: { apiUrl: 'https://file.example/v1', timeoutMs: '' },
      env: { SUPERTIME_LLM_TIMEOUT_MS: '2500' },
    })
    expect(cfg.baseUrl).toBe('https://file.example/v1')
    expect(cfg.timeoutMs).toBe(2500)
  })
})
