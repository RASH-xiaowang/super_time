/**
 * 厂商：**来也 RPA（机器人指挥官 Automation Commander）**——**实验性**。
 *
 * 公开可落地的通道只有 v6.7 的 **MCP 服务**：`POST {基址}/automation/mcp`（Bearer 个人令牌
 * `rk-…`），用 JSON-RPC 调工具 `create_task`（另有 `query_task_result` 供后续轮询）。
 * 官方 OpenAPI 创建任务接口文档不公开（发行说明要求联系销售），本适配器**不**按 MCP 参数臆造 OpenAPI。
 *
 * 需要 `buildRequest` 钩子的原因：MCP 的 JSON-RPC 封装与 `arguments` 结构（flowName/assignType/
 * workerName/workerGroupName/departmentName/parameters[]）无法用普通 REST 模板表达；响应还需要
 * 二次/三次 JSON 解析（`result` 是字符串，解析后 `return.data` 可能仍是字符串）。
 *
 * 来源：来也官方文档站（2026-10-21）：[MCP 服务](https://documents.laiye.com/automation-commander/docs/MCP)
 * （页面版本 V6.7）、触发器/任务/队列页、用户中心系统设置、V6.2 发行说明、V6.0.0.2211 历史应用管理。
 */
import type { RpaMappingTarget, RpaSemantic, RpaVendorDescriptor, RpaField } from '../../../types-rpa.ts'
import type {
  RpaHttpRequest,
  RpaHttpResponse,
  RpaInvocationContext,
  RpaRecordContext,
  RpaSendResult,
  RpaVendorAdapter,
} from '../types.ts'

/** MCP 工具名（v6.7 官方文档）。 */
const CREATE_TASK_TOOL = 'create_task'
const MAPPING_TARGETS: RpaMappingTarget[] = [
  { semantic: 'room', defaultKey: 'room_name' },
  { semantic: 'content', defaultKey: 'content' },
  { semantic: 'at', defaultKey: 'at_name' },
]
const MAP_FIELD = 'parameterMap'

const tokenField: RpaField = {
  key: 'token',
  label: '个人访问令牌',
  type: 'password',
  required: true,
  secret: true,
  example: 'rk-{CompanyOpenId}-{randomString}',
  help: '机器人指挥官「个人令牌」生成；Bearer 认证，重置令牌会让旧令牌立即失效。',
}

const descriptor: RpaVendorDescriptor = {
  id: 'laiye',
  name: '来也 RPA',
  vendor: '来也科技（Laiye）· 机器人指挥官 Automation Commander',
  version: '1.0.0',
  summary: '通过机器人指挥官 MCP 服务（tools/call create_task）创建任务；实验性：官方未给 JSON-RPC 报文示例。',
  status: 'experimental',
  docs: {
    home: 'https://documents.laiye.com/automation-commander/docs/MCP',
    triggerApi: 'https://documents.laiye.com/automation-commander/docs/MCP',
    lastVerifiedAt: '2026-10-21',
    pageVersion: 'V6.7（文档站页头）',
  },
  capabilities: {
    direction: 'outbound',
    synchronous: false,
    completion: 'poll',
    idempotency: 'none',
    deployment: ['onprem'],
  },
  fields: [
    {
      key: 'baseUrl',
      label: 'Commander 基址',
      type: 'text',
      required: true,
      example: 'https://rpa.example.com:8182',
      pattern: '^https?://',
      help: '机器人指挥官/用户中心地址（私有化部署）；官方示例域名带 8182 端口。',
    },
    {
      key: 'flowName',
      label: '流程名',
      type: 'text',
      required: true,
      example: 'finance_report_flow',
      summary: true,
      help: '要执行的 RPA 流程名称（create_task.flowName）。',
    },
    {
      key: 'assignType',
      label: '分配方式',
      type: 'select',
      required: true,
      defaultValue: 'automatic',
      options: [
        { value: 'automatic', label: 'automatic（自动分配）' },
        { value: 'designate', label: 'designate（指定机器人）' },
      ],
      help: '官方：automatic / designate；designate 时填机器人名，automatic 可填机器人组名。',
    },
    {
      key: 'workerName',
      label: '机器人名',
      type: 'text',
      required: false,
      help: '指定分配时的机器人名称（automatic 时留空或填 "0"）。',
    },
    {
      key: 'workerGroupName',
      label: '机器人组名',
      type: 'text',
      required: false,
      example: '财务机器人组',
      help: '自动分配时的机器人组名称（designate 时留空或填 "0"）。',
    },
    {
      key: 'departmentName',
      label: '部门名',
      type: 'text',
      required: false,
      advanced: true,
      example: 'Laiye Tech',
      help: '用户属于多个部门时必填。',
    },
    {
      key: 'priority',
      label: '优先级',
      type: 'select',
      required: false,
      defaultValue: 'middle',
      options: [
        { value: 'high', label: 'high' },
        { value: 'middle', label: 'middle' },
        { value: 'low', label: 'low' },
      ],
      advanced: true,
      help: '官方：high/middle/low，默认 middle。',
    },
    {
      key: 'parameterMap',
      label: '参数映射',
      type: 'map',
      required: true,
      defaultValue: { room: 'room_name', content: 'content', at: 'at_name' },
      help: '映射成 create_task.parameters[]（parameterName/parameterType/parameterValue，类型仅 string/number/boolean）。',
    },
  ],
  auth: {
    modes: [
      {
        strategy: 'bearer',
        fields: [tokenField],
      },
    ],
  },
  mapping: {
    style: 'object',
    mapField: MAP_FIELD,
    targets: MAPPING_TARGETS,
  },
  request: {
    method: 'POST',
    url: '${config.baseUrl}/automation/mcp',
    headers: { 'Content-Type': 'application/json' },
    body: {
      jsonrpc: '2.0',
      id: '${invocation.idempotencyKey}',
      method: 'tools/call',
      params: {
        name: CREATE_TASK_TOOL,
        arguments: { flowName: '${config.flowName}', assignType: '${config.assignType}' },
      },
    },
  },
  response: {
    okHttpStatus: [200],
  },
  retry: { maxAttempts: 1, retryOn: [] },
  governance: {
    contentOutbound: true,
    hosts: [{ kind: 'suffix', value: 'laiye.com' }],
    allowCustomBaseUrl: true,
    privacySection: 'G3',
  },
  risks: [
    'OpenAPI 创建任务接口文档不公开（官方要求联系销售）：本适配器只走公开的 MCP 通道',
    '回调契约缺失（事件推送地址的 payload/签名/重试均未公开）：完成状态只能靠 query_task_result 轮询',
    '官方未给 create_task 的 HTTP/JSON-RPC 报文样例：封装格式待联调核对',
    'MCP 响应需二次/三次 JSON 解析（result 是字符串，return.data 可能仍是字符串）',
    '无幂等键：自动重试可能重复创建任务（maxAttempts=1）；版本差异大（6.0→6.7）',
  ],
  notes: [
    '官方未给 HTTP 报文示例（只给工具名/参数表/响应示例）→ JSON-RPC 封装待联调核对。',
    'Bearer 个人令牌有效期官方未公开；只能绑个人身份，人员离职/重置令牌会让集成中断。',
    '响应解析按「result 字符串 → return.code/data.taskIds」实现，并兼容 MCP content[].text 形态。',
    'v1 只落库 taskIds[0]（externalTaskId），不实现 query_task_result 轮询。',
  ],
}

/** 取非空字符串配置值（数字/布尔转字符串，对象/数组视为空）。 */
function configText(ctx: RpaInvocationContext, key: string): string {
  const value = ctx.config[key]
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** 三个语义参数位的取值（单聊没有触发对象名时回落会话名，与旧实现同口径）。 */
function semanticValue(record: RpaRecordContext, semantic: RpaSemantic): string {
  if (semantic === 'room') return record.chatName
  if (semantic === 'content') return record.text
  return record.targetName !== '' ? record.targetName : record.chatName
}

/** `parameters[]`：每项 `parameterName/parameterType: 'string'/parameterValue`。 */
function taskParameters(ctx: RpaInvocationContext): Array<{
  parameterName: string
  parameterType: string
  parameterValue: string
}> {
  const raw = ctx.config[MAP_FIELD]
  const overrides = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  return MAPPING_TARGETS.map((target) => {
    const custom = overrides[target.semantic]
    const name = typeof custom === 'string' && custom.trim() !== '' ? custom.trim() : target.defaultKey
    return {
      parameterName: name,
      // 微信侧三个值都是字符串；官方 create_task 的 parameterType 支持 string/number/boolean。
      parameterType: 'string',
      parameterValue: semanticValue(ctx.record, target.semantic),
    }
  })
}

/** 尝试解析可能套了多层字符串的 JSON；解析失败返回 undefined。 */
function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

/** 从 MCP 工具响应里取出「业务正文」：兼容 `{result}` / `{result:{content:[{text}]}}`。 */
function mcpBusinessBody(outer: unknown): unknown {
  const parsed = parseMaybeJson(outer)
  if (typeof parsed !== 'object' || parsed === null) return parsed
  const root = parsed as Record<string, unknown>
  if (root['error'] !== undefined) return root
  let payload = root['result']
  // MCP 标准形态：result.content[0].text 里再放业务 JSON；官方示例则是 result 直接是 JSON 字符串。
  if (typeof payload === 'object' && payload !== null) {
    const content = (payload as Record<string, unknown>)['content']
    if (Array.isArray(content)) {
      const first = content[0]
      const text = typeof first === 'object' && first !== null ? (first as Record<string, unknown>)['text'] : undefined
      if (typeof text === 'string') payload = text
    }
  }
  const inner = parseMaybeJson(payload)
  if (typeof inner !== 'object' || inner === null) return inner
  const record = inner as Record<string, unknown>
  // 官方示例外层是 {return:{code,message,data}}；也容忍直接给 {code,data}。
  const business = record['return'] ?? record
  return parseMaybeJson(business) ?? business
}

export const adapter: RpaVendorAdapter = {
  descriptor,
  /**
   * 组装 MCP JSON-RPC 请求（`tools/call` → `create_task`）。
   * @param ctx - 投递上下文。
   * @returns POST `/automation/mcp` 请求。
   * @throws 服务地址 / 流程名缺失时抛可读错误。
   */
  buildRequest(ctx: RpaInvocationContext): RpaHttpRequest {
    const baseUrl = configText(ctx, 'baseUrl').replace(/\/+$/, '')
    if (baseUrl === '') throw new Error('来也 RPA 投递失败：任务未配置 Commander 基址')
    const flowName = configText(ctx, 'flowName')
    if (flowName === '') throw new Error('来也 RPA 投递失败：任务未配置流程名')
    const args: Record<string, unknown> = {
      flowName,
      assignType: configText(ctx, 'assignType') !== '' ? configText(ctx, 'assignType') : 'automatic',
      parameters: taskParameters(ctx),
    }
    const workerName = configText(ctx, 'workerName')
    if (workerName !== '') args['workerName'] = workerName
    const workerGroupName = configText(ctx, 'workerGroupName')
    if (workerGroupName !== '') args['workerGroupName'] = workerGroupName
    const departmentName = configText(ctx, 'departmentName')
    if (departmentName !== '') args['departmentName'] = departmentName
    const priority = configText(ctx, 'priority')
    if (priority !== '') args['priority'] = priority
    const body = {
      jsonrpc: '2.0',
      id: ctx.idempotencyKey,
      method: 'tools/call',
      params: { name: CREATE_TASK_TOOL, arguments: args },
    }
    return {
      method: 'POST',
      url: baseUrl + '/automation/mcp',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      contentType: 'application/json',
    }
  },
  /** 解析 MCP 响应：二次 JSON 解析后看 `return.code`（'0'=成功）与 `return.data.taskIds[]`。 */
  parseResponse(res: RpaHttpResponse): RpaSendResult {
    const status = Number(res.status)
    if (status !== 200) {
      return {
        ok: false,
        retryable: status >= 500 || status === 429,
        message: '来也 RPA 触发失败：HTTP ' + String(status),
      }
    }
    let outer: unknown
    try {
      outer = JSON.parse(res.bodyText) as unknown
    } catch {
      return { ok: false, retryable: false, message: '来也 MCP 响应不是合法 JSON' }
    }
    const body = mcpBusinessBody(outer)
    if (typeof body !== 'object' || body === null) {
      return { ok: false, retryable: false, message: '来也 MCP 响应格式不正确（无法解析业务正文）' }
    }
    const business = body as Record<string, unknown>
    const rpcError = business['error']
    if (typeof rpcError === 'object' && rpcError !== null) {
      const message = (rpcError as Record<string, unknown>)['message']
      return {
        ok: false,
        retryable: false,
        message: '来也 MCP 调用失败：' + (typeof message === 'string' ? message : '未知错误'),
      }
    }
    const code = business['code']
    if (code !== undefined && code !== 0 && code !== '0') {
      const message = business['message']
      return {
        ok: false,
        retryable: false,
        message: '来也创建任务失败：' + (typeof message === 'string' ? message : 'code=' + String(code)),
      }
    }
    const data = business['data']
    const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
    const taskIds = record['taskIds']
    const first = Array.isArray(taskIds) ? taskIds[0] : undefined
    return {
      ok: true,
      retryable: false,
      externalTaskId: typeof first === 'number' || typeof first === 'string' ? String(first) : undefined,
      message: typeof business['message'] === 'string' ? business['message'] : undefined,
    }
  },
}
