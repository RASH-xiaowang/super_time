/**
 * `message-webhook.js` 的手写类型声明。
 */

export const MESSAGE_WEBHOOK_PATH_PREFIX: '/api/message-webhook/'

export interface MessageWebhookResponse {
  writeHead: (status: number, headers?: Record<string, string | number>) => unknown
  end: (body?: unknown) => unknown
}

export interface MessageWebhookHandlerDeps {
  getApiToken: () => string
  ingest: (payload: Record<string, unknown>) => Promise<unknown>
}

export interface MessageWebhookHandler {
  handleGet: (res: MessageWebhookResponse, token: string) => Promise<void>
  handlePost: (res: MessageWebhookResponse, token: string, payload: unknown) => Promise<void>
}

export function createMessageWebhookHandler(
  deps: MessageWebhookHandlerDeps,
  options?: { loadTokenModule?: () => Promise<unknown> },
): MessageWebhookHandler
