/**
 * 厂商：**八爪鱼 RPA（MCP 工具）**——实验性（2026-10-21）。
 *
 * 与同目录 `bazhuayu.ts` 的区别：那条走八爪鱼**开放 API**（企业版机器人调度
 * `/api/v1/bots/scheduling/start`）；这条走八爪鱼**官方 MCP Server**
 * `https://mcp-rpa.bazhuayu.com/mcp`，用 JSON-RPC 调用工具 `automation_call`
 * 触发单个应用。个人版账号在客户端「开放能力（AI）→ MCP 工具」里添加应用后即可用
 * 这条通道（开放 API 调度属企业版能力，个人版会返回 FeatureIsDisabled）。
 *
 * 真实核对（2026-10-21，用本机任务保存的 API Key 实测）：
 *  · `POST https://mcp-rpa.bazhuayu.com/mcp`，头 `X-API-Key: <八爪鱼 API Key>`；
 *    返回 `text/event-stream`（SSE，`data: {...}` 一行一个 JSON-RPC 消息）；
 *  · `tools/list` 返回：automation_search / automation_details / automation_call /
 *    automation_run_status / automation_run_stop / bot_online_list；
 *  · `automation_call` 入参 `{ id, parameters, botId? }`，成功返回 runId（本适配器落
 *    `external_task_id`），失败返回 `result.isError=true` + `Error Code/Error Message`。
 *
 * 需要 `buildRequest`/`parseResponse` 钩子：MCP 的 JSON-RPC 封装与 SSE 响应无法用普通
 * REST 模板表达；响应还要先拆 SSE、再拆 MCP content（可能带 Markdown）。
 *
 * 来源：八爪鱼 RPA MCP 工具帮助中心
 * （https://rpa.bazhuayu.com/helpcenter/features/app-management/mcp-tools ）、
 * MCP 接入指南（https://rpa.bazhuayu.com/mcp-guide ）。
 */
import type { RpaVendorDescriptor, RpaField } from '../../../types-rpa.ts'
import { resolveMapped } from '../template.ts'
import type {
  RpaHttpRequest,
  RpaHttpResponse,
  RpaInvocationContext,
  RpaSendResult,
  RpaVendorAdapter,
} from '../types.ts'

/** MCP 工具名（2026-10-21 `tools/list` 实测）。 */
const CALL_TOOL = 'automation_call'

const API_KEY_FIELD: RpaField = {
  key: 'apiKey',
  label: 'API Key',
  ariaLabel: '八爪鱼 API Key',
  type: 'password',
  required: true,
  secret: true,
  help: '八爪鱼客户端「开放能力（AI）→ API Key」生成；只存本机，投递时进 X-API-Key 请求头。',
}

const EXTRA_PARAM_SOURCES = [
  'room', 'content', 'at', 'taskName', 'keyword', 'triggeredAt', 'chatType',
  'taskId', 'recordId', 'fixed', 'template',
] as const

const descriptor: RpaVendorDescriptor = {
  id: 'bazhuayu-mcp',
  name: '八爪鱼 RPA（MCP）',
  vendor: '八爪鱼 RPA（Bazhuayu）· MCP 工具',
  version: '1.0.0',
  summary: '通过八爪鱼官方 MCP Server 调用 automation_call 启动应用；个人版可用，参数由「附加参数」逐条配置。',
  status: 'experimental',
  docs: {
    home: 'https://rpa.bazhuayu.com/helpcenter/features/app-management/mcp-tools',
    triggerApi: 'https://rpa.bazhuayu.com/helpcenter/features/app-management/mcp-tools',
    lastVerifiedAt: '2026-10-21',
    pageVersion: 'MCP 工具（2026-10-21 在线核对：/mcp + X-API-Key + automation_call）',
  },
  capabilities: {
    direction: 'outbound',
    synchronous: true,
    completion: 'none',
    idempotency: 'none',
    deployment: ['cloud'],
  },
  fields: [
    {
      key: 'automationId',
      label: '应用 ID（automation id）',
      type: 'text',
      required: true,
      example: 'flow_registration_6ad859ccee2df270d53fc6e5',
      summary: true,
      help: 'MCP 侧的应用 id，形如 `flow_registration_<FlowId>`；可在客户端「开放能力（AI）→ MCP 工具」里查看，'
        + '或先用 MCP 工具 automation_search 搜到后复制。不要填裸 FlowId。',
    },
    API_KEY_FIELD,
    {
      key: 'botId',
      label: '机器人 ID',
      type: 'text',
      required: false,
      advanced: true,
      help: '可选；留空 = 由八爪鱼自动选择可用机器人。可先用 bot_online_list 查到机器人 id 再填。',
    },
    {
      key: 'extraParams',
      label: '附加参数',
      type: 'paramList',
      required: false,
      maxItems: 20,
      paramSources: [...EXTRA_PARAM_SOURCES],
      help: '传给 automation_call.parameters 的键值对（默认 {}）。参数名必须与八爪鱼应用入参一致；'
        + '需要会话名/触发文本/触发对象时，各加一条并把值来源选成对应项。',
    },
  ],
  auth: {
    // 凭据直接写进请求头（X-API-Key: ${secret.apiKey}），没有额外鉴权流程。
    modes: [],
  },
  mapping: {
    style: 'object',
    // 无内置语义参数：parameters 完全由附加参数组装（默认 {}）。
    targets: [],
    extrasField: 'extraParams',
  },
  request: {
    method: 'POST',
    url: 'https://mcp-rpa.bazhuayu.com/mcp',
    headers: {
      'Content-Type': 'application/json',
      // MCP Streamable HTTP：服务端返回 SSE，必须显式接受两种类型。
      Accept: 'application/json, text/event-stream',
      'X-API-Key': '${secret.apiKey}',
    },
    body: {
      jsonrpc: '2.0',
      id: '${invocation.idempotencyKey}',
      method: 'tools/call',
      params: {
        name: CALL_TOOL,
        arguments: { id: '${config.automationId}' },
      },
    },
  },
  response: {
    // MCP 统一 HTTP 200；业务成败看 JSON-RPC result（解析见下方 parseResponse）。
    okHttpStatus: [200],
  },
  // 没有幂等键：MCP 超时后自动重发可能重复启动应用，只发一次，失败由人工重投。
  retry: { maxAttempts: 1, retryOn: [] },
  governance: {
    contentOutbound: true,
    hosts: [{ kind: 'exact', value: 'mcp-rpa.bazhuayu.com' }],
    allowCustomBaseUrl: false,
    privacySection: 'G3',
  },
  risks: [
    '账号/机器人没有「执行」权益时，MCP 返回 BotFeatureIsDisabled（个人版需在客户端开通机器人执行能力）',
    '接口没有幂等键：网络超时后不会自动重发（避免同一个应用被启动两次），失败请在触发记录里人工重投',
    'MCP 返回 runId 只代表「已受理运行」：执行进度/结果需到八爪鱼客户端或 automation_run_status 查看',
    '应用 ID 必须是 MCP 侧的 automation id（通常形如 flow_registration_<FlowId>），填裸 FlowId 会提示找不到应用',
    'MCP 方式不发图片（任务里的 photoLimit 对它不生效）',
    'MCP Server 的响应是 SSE、工具名/参数可能随官方升级变化：本适配器按 2026-10-21 的 tools/list 契约实现',
    '实验性：虽已按真实 API Key 实测 tools/list 与 automation_call，但官方升级工具参数/响应格式时仍需联调核对',
  ],
  notes: [
    '2026-10-21（v1.0.0）：用真实 API Key 核对 MCP Server —— POST /mcp + X-API-Key 可 initialize/tools/list；',
    '  automation_call 入参 { id, parameters, botId? }；成功返回 runId，失败在 result.isError 的 Markdown 里给 Error Code/Message。',
    '与「八爪鱼 RPA」的区别：那条是企业版开放 API（/api/v1/bots/scheduling/start），本条目是 MCP 工具通道；',
    '  个人版账号在开放 API 调度上会 FeatureIsDisabled，改用 MCP 工具（并确保机器人有执行权益）可绕开该限制。',
    '附加参数的值来源：会话名/触发文本/触发对象/任务名/关键词/触发时间/会话类型/任务 id/记录 id/固定值/自定义模板。',
  ],
}

/** 一次 MCP JSON-RPC 响应的 SSE 解包：每行 `data: {json}`。 */
function parseRpcMessages(bodyText: string): unknown[] {
  const trimmed = bodyText.trim()
  if (trimmed === '') return []
  if (trimmed.startsWith('{')) {
    try {
      return [JSON.parse(trimmed) as unknown]
    } catch {
      return []
    }
  }
  const messages: unknown[] = []
  for (const line of bodyText.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice('data:'.length).trim()
    if (payload === '') continue
    try {
      messages.push(JSON.parse(payload) as unknown)
    } catch {
      // 单个坏事件不拖垮整条响应；后续仍可能拿到 result。
    }
  }
  return messages
}

/** 取一条 JSON-RPC 消息的 `result` / `error`（优先最后一个带 result 的）。 */
function pickRpcMessage(messages: unknown[]): Record<string, unknown> | undefined {
  let fallback: Record<string, unknown> | undefined
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const record = message as Record<string, unknown>
    if (record['result'] !== undefined || record['error'] !== undefined) fallback = record
  }
  return fallback
}

/** MCP result.content[] 的文本拼接（工具正文在 text 里）。 */
function contentText(result: Record<string, unknown>): string {
  const content = result['content']
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const item of content) {
    if (typeof item !== 'object' || item === null) continue
    const text = (item as Record<string, unknown>)['text']
    if (typeof text === 'string') parts.push(text)
  }
  return parts.join('\n')
}

/** 从成功正文里提取 runId（兼容结构化字段与 Markdown 文案）。 */
function extractRunId(result: Record<string, unknown>, text: string): string | undefined {
  const structured = result['structuredContent']
  if (typeof structured === 'object' && structured !== null) {
    const value = (structured as Record<string, unknown>)['runId']
    if (typeof value === 'string' && value !== '') return value
    if (typeof value === 'number') return String(value)
  }
  const patterns = [
    /"runId"\s*:\s*"([^"]+)"/,
    /(?:runId|run_id|Run ID|RunId)\s*[：:|]\s*`?([A-Za-z0-9_-]{4,})`?/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match?.[1] !== undefined && match[1] !== '') return match[1]
  }
  return undefined
}

/** 从 isError 正文里提取 Error Code / Error Message。 */
function extractToolError(text: string): string {
  // 工具正文是 Markdown（`**Error Code:** `CODE``），正则容忍星号/反引号/冒号组合。
  const code = /Error Code[^A-Za-z0-9`]*`?([A-Za-z0-9_-]+)`?/.exec(text)?.[1] ?? ''
  const message = /Error Message[^\n]*\n+([\s\S]*?)(?:\n\n|$)/.exec(text)?.[1]?.trim() ?? ''
  if (code !== '' && message !== '') return code + '：' + message
  if (code !== '') return code
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find((line) => line !== '')
  return firstLine !== undefined ? firstLine.slice(0, 300) : 'MCP 工具返回失败'
}

/**
 * 解析 MCP 响应：拆 SSE → 找 JSON-RPC 消息 → 区分 RPC 错误 / 工具 isError / 成功 runId。
 * @param res - HTTP 响应（bodyText 可能是 SSE）。
 * @returns 投递结果；失败文案带八爪鱼错误码，不含凭据。
 */
function parseMcpResponse(res: RpaHttpResponse): RpaSendResult {
  const status = Number(res.status)
  const text = res.bodyText
  const messages = parseRpcMessages(text)
  const rpc = messages.length > 0 ? pickRpcMessage(messages) : undefined
  const failure = (message: string): RpaSendResult => ({
    ok: false,
    retryable: status >= 500 || status === 429,
    message,
  })
  if (status !== 200) {
    const detail = rpc === undefined ? '' : extractToolError(text)
    return failure('HTTP ' + String(status) + (detail !== '' ? '：' + detail : ''))
  }
  if (rpc === undefined) return failure('八爪鱼 MCP 响应无法解析（没有 JSON-RPC 消息）')
  const rpcError = rpc['error']
  if (typeof rpcError === 'object' && rpcError !== null) {
    const message = (rpcError as Record<string, unknown>)['message']
    return failure('八爪鱼 MCP 调用失败：' + (typeof message === 'string' ? message : '未知错误'))
  }
  const result = rpc['result']
  if (typeof result !== 'object' || result === null) return failure('八爪鱼 MCP 响应缺少 result')
  const record = result as Record<string, unknown>
  if (record['isError'] === true) return failure('八爪鱼 MCP 返回失败：' + extractToolError(contentText(record)))
  const resultText = contentText(record)
  return {
    ok: true,
    retryable: false,
    externalTaskId: extractRunId(record, resultText),
    message: resultText !== '' ? resultText.split(/\r?\n/)[0]?.slice(0, 120) : undefined,
  }
}

/** 取字符串配置值（trim；非字符串视为空）。 */
function configText(ctx: RpaInvocationContext, key: string): string {
  const value = ctx.config[key]
  return typeof value === 'string' ? value.trim() : ''
}

export const adapter: RpaVendorAdapter = {
  descriptor,
  /**
   * 组装 MCP `tools/call → automation_call` 请求：JSON-RPC 2.0 + 参数容器。
   * @param ctx - 投递上下文。
   * @returns POST `/mcp` 请求。
   * @throws 未配置 API Key / 应用 ID 时抛可读错误（不发请求）。
   */
  buildRequest(ctx: RpaInvocationContext): RpaHttpRequest {
    const apiKey = (ctx.secrets['apiKey'] ?? '').trim()
    if (apiKey === '') throw new Error('八爪鱼 MCP 投递失败：任务未配置 API Key')
    const automationId = configText(ctx, 'automationId')
    if (automationId === '') throw new Error('八爪鱼 MCP 投递失败：任务未配置应用 ID（automation id）')
    const parameters = resolveMapped(descriptor, ctx)
    const args: Record<string, unknown> = { id: automationId, parameters }
    const botId = configText(ctx, 'botId')
    if (botId !== '') args['botId'] = botId
    const body = {
      jsonrpc: '2.0',
      id: ctx.idempotencyKey,
      method: 'tools/call',
      params: { name: CALL_TOOL, arguments: args },
    }
    return {
      method: 'POST',
      url: descriptor.request.url,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify(body),
      contentType: 'application/json',
    }
  },
  parseResponse: parseMcpResponse,
}
