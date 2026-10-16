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
export function headersFor(apiKey?: string, extra?: Record<string, string>): Record<string, string>;
export function llmRequest(url: string, options?: LlmRequestOptions): Promise<Response>;
