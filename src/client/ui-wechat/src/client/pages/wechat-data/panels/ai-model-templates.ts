import type { WechatLlmConfig, WechatLlmProfile } from '../api.ts'

/** 厂商模板：连接仍走 OpenAI 兼容协议，模板只预填供应商 / 模型 / 地址。 */
export const LLM_TEMPLATES = [
  { key: 'deepseek', label: 'DeepSeek', provider: 'deepseek', model: 'deepseek-flash', apiUrl: 'https://api.deepseek.com/v1' },
  {
    key: 'mimo',
    label: 'MiMo（小米 Token Plan）',
    provider: 'mimo',
    model: 'mimo-v2.5',
    apiUrl: 'https://token-plan-cn.xiaomimimo.com/v1',
  },
  { key: 'dashscope', label: '通义千问（阿里百炼）', provider: 'dashscope', model: 'qwen-plus', apiUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { key: 'moonshot', label: 'Moonshot Kimi', provider: 'moonshot', model: 'moonshot-v1-8k', apiUrl: 'https://api.moonshot.cn/v1' },
  { key: 'siliconflow', label: '硅基流动 SiliconFlow', provider: 'siliconflow', model: 'Qwen/Qwen2.5-7B-Instruct', apiUrl: 'https://api.siliconflow.cn/v1' },
  { key: 'hunyuan', label: '腾讯混元', provider: 'hunyuan', model: 'hunyuan-lite', apiUrl: 'https://api.hunyuan.cloud.tencent.com/v1' },
  { key: 'qianfan', label: '百度千帆（文心）', provider: 'qianfan', model: 'ernie-4.0-turbo-8k', apiUrl: 'https://qianfan.baidubce.com/v2' },
  { key: 'openai', label: 'OpenAI 官方', provider: 'openai-compat', model: 'gpt-4o-mini', apiUrl: 'https://api.openai.com/v1' },
  { key: 'opencode-go', label: 'OpenCode Go', provider: 'opencode', model: 'glm-5.3-flash', apiUrl: 'https://opencode.ai/inference/go/openai/v1' },
  { key: 'openrouter', label: 'OpenRouter', provider: 'openrouter', model: '~openai/gpt-sol-latest', apiUrl: 'https://openrouter.ai/api/v1' },
  { key: 'cerebras', label: 'Cerebras', provider: 'cerebras', model: 'qwen-3.8-27b', apiUrl: 'https://api.cerebras.ai/v1' },
] as const

export type LlmTemplate = (typeof LLM_TEMPLATES)[number]

/** 当前配置不属于任何内置模板时的下拉占位值。 */
export const CUSTOM_TEMPLATE_KEY = '__current__'

/** 两个地址是否属于同一家厂商。换 host 时必须清空上一家的 Key。 */
export function sameHost(a: string, b: string): boolean {
  try {
    const ha = new URL(a).host
    const hb = new URL(b).host
    return Boolean(ha) && ha === hb
  } catch {
    return false
  }
}

/** 取 URL 主机名；解析失败时返回空串。 */
export function hostOfUrl(url: string | undefined): string {
  try {
    return new URL(url ?? '').host
  } catch {
    return ''
  }
}

/**
 * 从一条已保存配置里取出可编辑字段。
 *
 * 字段必须逐个列全：编辑配置时表单提交的就是这个对象，漏一个键就会把它静默清成默认值。
 */
export function configOf(profile: WechatLlmProfile): WechatLlmConfig {
  const picked: WechatLlmConfig = {
    provider: profile.provider,
    model: profile.model,
    apiKey: profile.apiKey,
    apiUrl: profile.apiUrl,
    apiPath: profile.apiPath,
    timeoutMs: profile.timeoutMs,
  }
  for (const key of [
    'embeddingModel', 'embedPath', 'embeddingApiUrl', 'embeddingApiKey',
    'rerankModel', 'rerankPath', 'rerankApiUrl', 'rerankApiKey',
  ] as const) {
    if (profile[key] !== undefined) picked[key] = profile[key]
  }
  if (profile.rerankTimeoutMs !== undefined) picked.rerankTimeoutMs = profile.rerankTimeoutMs
  return picked
}

/** 按当前草稿匹配模板；自定义配置返回专用占位值。 */
export function templateKeyOf(config: WechatLlmConfig | null): string {
  if (!config) return ''
  const hit = LLM_TEMPLATES.find((template) => (
    template.provider === config.provider
    && template.model === config.model
    && template.apiUrl === config.apiUrl
  ))
  return hit?.key ?? ((config.provider || config.apiUrl) ? CUSTOM_TEMPLATE_KEY : '')
}

/**
 * 草稿比较指纹。
 *
 * 只包含可编辑字段，并保持稳定字段顺序；无论对象来自后端快照、模板还是手工编辑，
 * 同一份配置都必须得到同一串指纹。
 */
export function configSignature(config: WechatLlmConfig | null): string {
  if (!config) return ''
  return JSON.stringify([
    config.provider,
    config.model,
    config.apiKey,
    config.apiUrl,
    config.apiPath,
    config.timeoutMs,
    config.embeddingModel ?? '',
    config.embedPath ?? '',
    config.embeddingApiUrl ?? '',
    config.embeddingApiKey ?? '',
    config.rerankModel ?? '',
    config.rerankPath ?? '',
    config.rerankApiUrl ?? '',
    config.rerankApiKey ?? '',
    config.rerankTimeoutMs ?? 0,
  ])
}
