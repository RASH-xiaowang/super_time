/**
 * `llm-http.js` 的手写类型声明（宿主 CommonJS 不自动生成声明）。
 *
 * 只声明对外契约，不承诺内部实现；与其它宿主层 `.d.ts` 一样由
 * `host-decl-alignment.spec.ts` 做导出双向差集校验。
 */

export const DEFAULT_MAX_ATTEMPTS: 1;
export const DEFAULT_TIMEOUT_MS: 20_000;

export interface ParsedLlmBaseUrl {
  raw: string;
  base: string;
  host: string;
  origin: string;
}

export interface LlmRequestOptions {
  method?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
  timeoutScope?: 'full' | 'headers';
  onRetry?: (info: { attempt: number, delayMs: number, reason: string }) => void;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>;
}

export function parseLlmBaseUrl(input: unknown): ParsedLlmBaseUrl;
/**
 * 把「基础 URL」与「端点路径」拼成完整 URL，并容忍用户把完整端点填进基础 URL。
 *
 * 用户把 `embeddingApiUrl` 填成 `.../v1/embeddings`（完整端点）而 `embedPath` 仍是
 * 默认 `/embeddings` 时，朴素拼接会得到 `.../v1/embeddings/embeddings` ⇒ 404，
 * 而后果是**稠密检索整条通道静默失效**（不是报错弹窗）。
 * @param baseUrl - 用户填的基础 URL（可能已含端点路径）。
 * @param path - 端点路径（如 `/embeddings`）。
 * @returns 完整 URL。
 */
export function joinLlmEndpoint(baseUrl: string, path: string): string;
export function headersFor(apiKey?: string, extra?: Record<string, string>): Record<string, string>;
export function llmRequest(url: string, options?: LlmRequestOptions): Promise<Response>;
