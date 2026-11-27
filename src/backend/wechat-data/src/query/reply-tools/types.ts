/** Reply-only, read-only public tools. Never register these with Ask. */
export interface ReplyToolsConfig {
  weatherProvider: string
  weatherAccess: string
  weatherApiKey: string
  searchProvider: string
  searchApiKey: string
}
export interface ReplyToolSource {
  title: string
  url: string
  fetchedAt: string
  date?: string
  timezone?: string
}
export interface ReplyToolResult {
  ok: boolean
  code?: string
  data?: unknown
  sources?: ReplyToolSource[]
}
export interface ReplyToolObservation {
  name: string
  ok: boolean
  code?: string
  elapsedMs: number
}
export interface ReplyToolContext {
  /** Only the selected message body; not conversation, contact or KB. */
  publicText: string
  config: ReplyToolsConfig
  signal: AbortSignal
  now?: () => Date
  /** Injectable transport for synthetic tests only, never exposed through RPC. */
  read?: (url: string, options: { signal: AbortSignal; headers?: Record<string, string> }) => Promise<{ text: string; contentType: string }>
}
export const DISABLED_REPLY_TOOLS_CONFIG: ReplyToolsConfig = {
  weatherProvider: '', weatherAccess: '', weatherApiKey: '', searchProvider: '', searchApiKey: '',
}
export function replyToolError(code: string): ReplyToolResult { return { ok: false, code } }
