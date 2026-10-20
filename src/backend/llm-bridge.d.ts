/**
 * `llm-bridge.js` 的手写类型声明（N32 同族：宿主 CommonJS 不自动生成声明）。
 *
 * 只声明公开出口与返回值形状，不承诺实现细节；与 `wechat-paths.d.ts` / `update.d.ts`
 * 一样接受 `host-decl-alignment.spec.ts` 的导出双向差集校验。写这份声明是为了让
 * 直接调用桥接层的测试与消费方得到真实类型，而不是整块 `any`。
 */
import type { GenerateOptions, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ResolvedLlmConfig } from './llm-config-store'

/** `llmConfigFromEnv()` 的返回形状（键名与 `wechat-paths.d.ts` 的 LlmConfig 对应）。 */
export type LlmBridgeConfig = ResolvedLlmConfig

/**
 * `llmConfigFromEnv` / `createLlmBridge` 的覆盖参数：除了标准键外，旧调用点与测试还会传
 * `apiUrl`（历史上与 `baseUrl` 同义）。实现读的是 `file.apiUrl`，覆盖参数里没有 `apiUrl`
 * 的读取位，因此把它单独放在覆盖类型里，不伪装成返回值的一部分。
 */
export type LlmBridgeConfigOverrides = Partial<LlmBridgeConfig> & { apiUrl?: string }

export type LlmBridgeContentPart = {
  text?: string
  type?: string
  /** 图片块：canonical base64（ClawBot 自动回复从本机媒体缓存读出）。 */
  data?: string
  /** 图片块：MIME（`image/jpeg` 等）。 */
  mediaType?: string
  /** 图片块：调用方已拼好的远端 URL / data URL。 */
  image_url?: { url?: string }
}

/** OpenAI 兼容消息的 content：纯文本是 string，带图时是 parts 数组。 */
export type LlmBridgeOpenAiContent = string | Array<{ type: 'text', text: string } | { type: 'image_url', image_url: { url: string } }>

export interface LlmBridgeMessage {
  role?: string
  content?: string | ReadonlyArray<LlmBridgeContentPart>
}

export interface LlmBridgeGenerateOptions extends Partial<GenerateOptions> {
  system?: string
  messages?: ReadonlyArray<LlmBridgeMessage>
  model?: string
  maxTokens?: number
}

export interface LlmBridge {
  readonly configured: boolean
  readonly config: LlmBridgeConfig
  stream(options: LlmBridgeGenerateOptions): AsyncIterable<StreamChunk>
  embed(texts: string | ReadonlyArray<string>, options?: { model?: string }): Promise<number[][]>
  embeddingModelName(override?: string): string
  rerank(query: string, documents: ReadonlyArray<string>, options?: { model?: string, topN?: number }): Promise<number[]>
  rerankModelName(override?: string): string
  generate(options: LlmBridgeGenerateOptions): Promise<{ content: string }>
  listConfigurableProviders(): Array<{ provider: string, model: string }>
  listModels(provider?: string): Promise<Array<{ id: string }>>
}

export function createLlmBridge(configOverrides?: LlmBridgeConfigOverrides): LlmBridge
export function llmConfigFromEnv(overrides?: LlmBridgeConfigOverrides): LlmBridgeConfig
export function resolveEmbedModel(cfg: LlmBridgeConfig, override?: string): string
export function toOpenAiContent(message: LlmBridgeMessage): LlmBridgeOpenAiContent
export function toOpenAiMessage(message: LlmBridgeMessage): { role: string, content: LlmBridgeOpenAiContent }
/** 把 OpenAI 兼容的 usage 归一成 dsh-llm 口径（无可用计数时返回 null）。 */
export function toTokenUsage(raw: unknown): TokenUsage | null
