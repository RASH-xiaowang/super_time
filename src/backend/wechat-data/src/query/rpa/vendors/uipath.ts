/**
 * 厂商：**UiPath Orchestrator**（Automation Cloud + Standalone 私有化）。
 *
 * 触发：`POST …/orchestrator_/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs`，
 * 请求体是 `{startInfo:{ReleaseKey, Strategy, JobsCount, InputArguments}}`；`InputArguments`
 * 必须是 **JSON 文本字符串**（≤10,000 字符）。响应是作业数组（`value[0].Key` 作为作业键）。
 *
 * 鉴权两种（按 `config.authMode` 选）：
 *  · `pat`   —— `Authorization: Bearer <PAT>`（仅本地用户；目录/SAML 用户需 OAuth）；
 *  · `oauth` —— 外部应用 client_credentials：POST `{baseUrl}/{organizationName}/identity_/connect/token`
 *              换 `access_token`（expires_in 3600，无 refresh），由核心 auth.ts 缓存并注入。
 *
 * 文件夹头用 `X-UIPATH-FolderKey`：官方给的是四选一，`X-UIPATH-OrganizationUnitId` 要的是
 * Int64 FolderId，而本产品配置的是文件夹 key（官方原文：FolderKey 不随许可计划变化，优先用它）。
 *
 * 来源：UiPath 官方文档 Automation Cloud · latest（2026-10-21）：
 * 作业请求 jobs-requests、构建 API 请求 building-api-requests、鉴权 authentication-methods、
 * PAT personal-access-tokens、外部应用 OAuth、Webhooks、限流 rate-limits。
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

/** 三个语义参数位 → `InputArguments` 里 JSON 字段名的默认映射。 */
const MAPPING_TARGETS: RpaMappingTarget[] = [
  { semantic: 'room', defaultKey: 'room_name' },
  { semantic: 'content', defaultKey: 'content' },
  { semantic: 'at', defaultKey: 'at_name' },
]
const MAP_FIELD = 'inputArgumentsMap'
/** 官方输入参数 JSON 文本上限（含名称/转义/空格/方括号/值）。 */
const INPUT_ARGUMENTS_MAX = 10_000

const patField: RpaField = {
  key: 'pat',
  label: 'PAT',
  type: 'password',
  required: true,
  secret: true,
  help: '个人访问令牌，需要 Jobs.Create 权限；仅本地用户，目录/SAML 用户请用 OAuth。',
}
const clientIdField: RpaField = {
  key: 'clientId',
  label: 'OAuth client_id',
  type: 'password',
  required: true,
  secret: true,
  help: '外部应用（机密应用）的 client_id；只存本机。',
}
const clientSecretField: RpaField = {
  key: 'clientSecret',
  label: 'OAuth client_secret',
  type: 'password',
  required: true,
  secret: true,
  help: '外部应用（机密应用）的 client_secret；只存本机。',
}

const descriptor: RpaVendorDescriptor = {
  id: 'uipath',
  name: 'UiPath Orchestrator',
  vendor: 'UiPath（Orchestrator）',
  version: '1.0.0',
  summary: '用 StartJobs 启动作业；PAT 或 OAuth 外部应用鉴权，返回 Job.Key 供轮询核对。',
  status: 'stable',
  docs: {
    home: 'https://docs.uipath.com/orchestrator/automation-cloud/latest/api-guide/jobs-requests',
    triggerApi: 'https://docs.uipath.com/orchestrator/automation-cloud/latest/api-guide/jobs-requests',
    lastVerifiedAt: '2026-10-21',
    pageVersion: 'Automation Cloud · latest（页面无最后更新时间）',
  },
  capabilities: {
    direction: 'outbound',
    synchronous: false,
    completion: 'callback',
    idempotency: 'none',
    deployment: ['cloud', 'onprem'],
  },
  fields: [
    {
      key: 'deployment',
      label: '部署形态',
      type: 'select',
      required: true,
      defaultValue: 'cloud',
      options: [
        { value: 'cloud', label: 'Automation Cloud' },
        { value: 'onprem', label: 'Standalone（私有化）' },
      ],
      help: 'Standalone 的 URL 前缀官方未给原文：请把服务地址填到 Orchestrator 根，联调核对。',
    },
    {
      key: 'baseUrl',
      label: '服务地址',
      type: 'text',
      required: true,
      defaultValue: 'https://cloud.uipath.com',
      pattern: '^https?://',
      help: 'Cloud 填 https://cloud.uipath.com（或 govcloud/dedicated 区域地址）；私有化填实例地址。',
    },
    {
      key: 'organizationName',
      label: '组织名',
      type: 'text',
      required: true,
      example: 'myorg',
      help: 'Cloud：组织（organization）名；私有化若 URL 无组织段可留空串（联调核对）。',
    },
    {
      key: 'tenantName',
      label: '租户名',
      type: 'text',
      required: true,
      example: 'mytenant',
      help: 'Cloud：租户（tenant）名。',
    },
    {
      key: 'folderKey',
      label: '文件夹 Key',
      type: 'text',
      required: true,
      example: '6ea73196-ca89-446c-81e1-5279bdd36dc2',
      help: '文件夹 key（官方：不随许可计划变化）；作为 X-UIPATH-FolderKey 发送。',
    },
    {
      key: 'releaseKey',
      label: '流程 ReleaseKey',
      type: 'text',
      required: true,
      example: '795cbab2-8008-4a54-b1cb-f9ff1ece139e',
      summary: true,
      help: '要执行的流程版本 ReleaseKey（Orchestrator 流程详情里复制）。',
    },
    {
      key: 'authMode',
      label: '鉴权方式',
      type: 'select',
      required: true,
      defaultValue: 'pat',
      options: [
        { value: 'pat', label: 'PAT（个人访问令牌）' },
        { value: 'oauth', label: 'OAuth 外部应用' },
      ],
      help: 'PAT 仅适用于本地用户；目录/SAML 用户请用 OAuth 外部应用。',
    },
    {
      key: 'scope',
      label: 'OAuth scope',
      type: 'text',
      required: false,
      defaultValue: 'OR.Default',
      advanced: true,
      help: 'OAuth 令牌 scope，默认 OR.Default（细粒度权限在租户/文件夹给应用分配角色）。',
    },
    {
      key: 'strategy',
      label: '分配策略',
      type: 'select',
      required: false,
      defaultValue: 'ModernJobsCount',
      options: [
        { value: 'ModernJobsCount', label: 'ModernJobsCount' },
        { value: 'All', label: 'All（仅经典文件夹）' },
      ],
      advanced: true,
      help: '官方示例只出现这三个值；「All」不适用于新式文件夹，本版默认 ModernJobsCount。',
    },
    {
      key: 'jobsCount',
      label: '作业数',
      type: 'number',
      required: false,
      defaultValue: 1,
      advanced: true,
      help: '与 ModernJobsCount 同用（官方示例 1）。',
    },
    {
      key: 'inputArgumentsMap',
      label: '参数映射',
      type: 'map',
      required: true,
      defaultValue: { room: 'room_name', content: 'content', at: 'at_name' },
      help: '映射成 InputArguments 的 JSON 字段名（键名须与 UiPath 流程入参一致）。',
    },
  ],
  auth: {
    modes: [
      {
        strategy: 'bearer',
        when: { field: 'authMode', equals: ['pat'] },
        fields: [patField],
      },
      {
        strategy: 'token-exchange',
        when: { field: 'authMode', equals: ['oauth'] },
        fields: [clientIdField, clientSecretField],
        exchange: {
          method: 'POST',
          url: '${config.baseUrl}/${config.organizationName}/identity_/connect/token',
          contentType: 'application/x-www-form-urlencoded',
          body: {
            grant_type: 'client_credentials',
            client_id: '${secret.clientId}',
            client_secret: '${secret.clientSecret}',
            scope: '${config.scope}',
          },
          tokenPath: 'access_token',
          expiresInPath: 'expires_in',
          headerPrefix: 'Bearer ',
        },
      },
    ],
  },
  mapping: {
    style: 'jsonStringObject',
    mapField: MAP_FIELD,
    targets: MAPPING_TARGETS,
  },
  request: {
    method: 'POST',
    url: '${config.baseUrl}/${config.organizationName}/${config.tenantName}/orchestrator_/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs',
    headers: {
      'Content-Type': 'application/json',
      'X-UIPATH-FolderKey': '${config.folderKey}',
    },
    body: {
      startInfo: {
        ReleaseKey: '${config.releaseKey}',
        Strategy: '${config.strategy}',
        JobsCount: '${config.jobsCount}',
        InputArguments: '${mapped}',
      },
    },
  },
  response: {
    okHttpStatus: [200],
    externalTaskIdPath: 'value[0].Key',
    messagePath: 'value[0].State',
  },
  retry: { maxAttempts: 1, retryOn: [] },
  governance: {
    contentOutbound: true,
    hosts: [
      { kind: 'suffix', value: 'uipath.com' },
      { kind: 'suffix', value: 'uipath.us' },
    ],
    allowCustomBaseUrl: true,
    privacySection: 'G3',
  },
  risks: [
    'Orchestrator Webhook 不重试/不存储/失败即丢、失败熔断 1 小时：完成状态需用 Job.Key 轮询核对（v1 只落库）',
    'StartJobs 官方页没有字段级必填/类型/默认值表；本适配器只用官方示例可证字段，上线前需按实例 Swagger 复核',
    'Cloud 与 Standalone 私有化的 URL/租户头差异官方未给原文：需客户实例联调',
    'PAT 不适用目录/SAML 用户；企业客户建议 OAuth 外部应用',
    'InputArguments JSON 文本 ≤10,000 字符；Jobs 列表端点有限流（单作业端点不限）',
  ],
  notes: [
    '文件夹头用 X-UIPATH-FolderKey（而非 X-UIPATH-OrganizationUnitId）：后者要求 Int64 FolderId，本产品配置的是 FolderKey。',
    'Standalone：baseUrl 填到 Orchestrator 根（不含 /odata），URL 按 /odata/Jobs/… 拼接；该假设官方未给原文，需联调核对。',
    'strategy=All 不适用于新式文件夹；strategy=Specific 需要 RobotIds（本版未提供字段），默认 ModernJobsCount。',
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

/** `InputArguments` 的对象形态：映射键可被配置里的 map 字段逐项覆盖。 */
function inputArguments(ctx: RpaInvocationContext): Record<string, string> {
  const raw = ctx.config[MAP_FIELD]
  const overrides = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  const out: Record<string, string> = {}
  for (const target of MAPPING_TARGETS) {
    const custom = overrides[target.semantic]
    const key = typeof custom === 'string' && custom.trim() !== '' ? custom.trim() : target.defaultKey
    out[key] = semanticValue(ctx.record, target.semantic).trim()
  }
  return out
}

/**
 * StartJobs 的 URL：
 *  · Cloud：`{baseUrl}/{org}/{tenant}/orchestrator_/odata/Jobs/…`（官方原文路径）；
 *  · Standalone：`{baseUrl}/odata/Jobs/…`（官方未给原文，按「baseUrl = Orchestrator 根」约定，见 notes）。
 */
function startJobsUrl(config: { baseUrl: string; org: string; tenant: string; onprem: boolean }): string {
  const base = config.baseUrl.replace(/\/+$/, '')
  const suffix = '/odata/Jobs/UiPath.Server.Configuration.OData.StartJobs'
  if (config.onprem) return base + suffix
  return base + '/' + config.org + '/' + config.tenant + '/orchestrator_' + suffix
}

/** 从 StartJobs 响应里取作业键：官方返回 `{value:[{Key,…}]}`，也容忍单个对象。 */
function pickJobKey(parsed: unknown): { key?: string; state?: string } {
  if (typeof parsed !== 'object' || parsed === null) return {}
  const value = (parsed as Record<string, unknown>)['value']
  const first = Array.isArray(value) ? value[0] : value
  if (typeof first !== 'object' || first === null) return {}
  const job = first as Record<string, unknown>
  const key = job['Key']
  const state = job['State']
  return {
    key: typeof key === 'string' ? key : undefined,
    state: typeof state === 'string' ? state : undefined,
  }
}

export const adapter: RpaVendorAdapter = {
  descriptor,
  /**
   * 组装 StartJobs 请求：URL 按部署形态分支，InputArguments 为 JSON 文本字符串。
   * @param ctx - 投递上下文。
   * @returns POST StartJobs 请求。
   * @throws 服务地址/组织/租户/流程 ReleaseKey 缺失时抛可读错误。
   */
  buildRequest(ctx: RpaInvocationContext): RpaHttpRequest {
    const baseUrl = configText(ctx, 'baseUrl')
    if (baseUrl === '') throw new Error('UiPath 投递失败：任务未配置服务地址')
    const onprem = configText(ctx, 'deployment') === 'onprem'
    const org = configText(ctx, 'organizationName')
    const tenant = configText(ctx, 'tenantName')
    const releaseKey = configText(ctx, 'releaseKey')
    if (releaseKey === '') throw new Error('UiPath 投递失败：任务未配置流程 ReleaseKey')
    if (!onprem && (org === '' || tenant === '')) {
      throw new Error('UiPath 投递失败：Cloud 部署必须配置组织名与租户名')
    }
    const argumentsText = JSON.stringify(inputArguments(ctx))
    if (argumentsText.length > INPUT_ARGUMENTS_MAX) {
      throw new Error('UiPath 投递失败：InputArguments 超过 10000 字符上限')
    }
    const strategy = configText(ctx, 'strategy') !== '' ? configText(ctx, 'strategy') : 'ModernJobsCount'
    const rawCount = ctx.config['jobsCount']
    const parsedCount = typeof rawCount === 'number' ? rawCount : Number(configText(ctx, 'jobsCount'))
    const jobsCount = Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : 1
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    const folderKey = configText(ctx, 'folderKey')
    if (folderKey !== '') headers['X-UIPATH-FolderKey'] = folderKey
    const body = {
      startInfo: {
        ReleaseKey: releaseKey,
        Strategy: strategy,
        JobsCount: jobsCount,
        InputArguments: argumentsText,
      },
    }
    return {
      method: 'POST',
      url: startJobsUrl({ baseUrl, org, tenant, onprem }),
      headers,
      body: JSON.stringify(body),
      contentType: 'application/json',
    }
  },
  /**
   * 解析 StartJobs 响应：HTTP 200 + `value[]` 数组里的 `Key`（作业键）。
   * 数组/单对象都兼容；没有作业对象时按失败处理（避免把空响应当成功）。
   */
  parseResponse(res: RpaHttpResponse): RpaSendResult {
    const status = Number(res.status)
    if (status !== 200) {
      return {
        ok: false,
        retryable: status >= 500 || status === 429,
        message: 'UiPath 触发失败：HTTP ' + String(status),
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(res.bodyText) as unknown
    } catch {
      return { ok: false, retryable: false, message: 'UiPath 响应不是合法 JSON' }
    }
    const job = pickJobKey(parsed)
    if (job.key === undefined) {
      return { ok: false, retryable: false, message: 'UiPath 未返回作业对象（缺少 value[0].Key）' }
    }
    return {
      ok: true,
      retryable: false,
      externalTaskId: job.key,
      message: job.state !== undefined ? 'UiPath 作业已创建（' + job.state + '）' : undefined,
    }
  },
}
