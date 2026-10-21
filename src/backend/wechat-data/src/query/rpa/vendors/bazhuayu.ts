/**
 * 内置厂商：**八爪鱼 RPA**。
 *
 * 官方接口（2026-10-21 在线核对）：`POST https://api-rpa.bazhuayu.com/api/v1/bots/scheduling/start`
 * （机器人调度-启动单个应用），鉴权 `X-API-Key`（也接受 `Authorization: Bearer`），请求体
 * **camelCase**：`flowId` / `flowContentRetrievalMode` / `params`；成功 HTTP 200 返回
 * `{ flowId, flowProcessNo }`，失败返回 `code/description/requestId`。**不发图片**。
 *
 * 版本历史：
 *  · v1.3.0（2026-10-21）：修正真实投递 401 的根因——旧实现 URL 少了 `/v1`
 *    （`/api/bots/...` 不是公开路径，对端按未认证返回 401），body 也用了 PascalCase；
 *    现在按官方文档修正，并把 `flowProcessNo` 落 `external_task_id`、失败原因带厂商
 *    `description`；因无幂等键改为**不自动重试**。
 *  · v1.2.0（2026-10-21，用户要求）：不再有「三个内置参数」——`params` 里放什么完全由
 *    任务的「附加参数」逐条配置（参数名 + 值来源），默认 `params: {}`。需要会话名/触发
 *    文本/触发对象时，在附加参数里各加一条（值来源分别选「会话名 / 触发文本 / 触发对象」）。
 */
import type { RpaVendorDescriptor, RpaField } from '../../../types-rpa.ts'
import type { RpaVendorAdapter } from '../types.ts'

/** 附加参数允许的值来源：触发记录/任务的内置字段 + 固定值 + 自定义模板（不含图片）。 */
const EXTRA_PARAM_SOURCES = [
  'room', 'content', 'at', 'taskName', 'keyword', 'triggeredAt', 'chatType',
  'taskId', 'recordId', 'fixed', 'template',
] as const

/** 八爪鱼 API Key（凭据：只存 trigger_secret，投递时进 X-API-Key）。 */
const apiKeyField: RpaField = {
  key: 'apiKey',
  label: 'API Key',
  ariaLabel: '八爪鱼 API Key',
  type: 'password',
  required: true,
  secret: true,
  help: '只存本机；投递时由后端读出来放进 X-API-Key 请求头，不进任务列表/Remote 返回值。',
}

const descriptor: RpaVendorDescriptor = {
  id: 'bazhuayu',
  name: '八爪鱼 RPA',
  vendor: '八爪鱼 RPA（Bazhuayu）',
  version: '1.3.0',
  summary: '把任务「附加参数」逐条映射成八爪鱼流程入参（默认不发业务参数），POST 到八爪鱼固定主机启动流程（不发图片）。',
  status: 'stable',
  docs: {
    home: 'https://rpa.bazhuayu.com/',
    triggerApi: 'https://rpa.bazhuayu.com/helpcenter/features/enterprise/api/robot-scheduling-start-single',
    lastVerifiedAt: '2026-10-21',
    pageVersion: '官方文档 2026-10-21 在线核对：机器人调度-启动单个应用（/api/v1/bots/scheduling/start）',
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
      key: 'flowId',
      label: 'FlowId',
      ariaLabel: '八爪鱼 FlowId',
      type: 'text',
      required: true,
      example: '6ad859ccee2df270d53fc6e5',
      summary: true,
      help: '八爪鱼流程 id（控制台流程详情里复制）；不是凭据，随任务配置返回。',
    },
    apiKeyField,
    {
      key: 'extraParams',
      label: '附加参数',
      type: 'paramList',
      required: false,
      maxItems: 20,
      paramSources: [...EXTRA_PARAM_SOURCES],
      help: '八爪鱼流程的入参全部在这里配置（默认不发任何业务参数）。参数名必须与流程入参一致；'
        + '需要会话名/触发文本/触发对象时，各加一条并把值来源选成对应项。',
    },
  ],
  auth: {
    // 凭据直接写进请求模板 header（X-API-Key: ${secret.apiKey}），没有额外鉴权流程。
    modes: [],
  },
  mapping: {
    style: 'object',
    // 无内置语义参数：Params 完全由附加参数组装（默认 {}）。
    targets: [],
    extrasField: 'extraParams',
  },
  request: {
    method: 'POST',
    // 官方文档（2026-10-21 核对）：机器人调度-启动单个应用 → /api/v1/bots/scheduling/start。
    // 旧实现漏了 `/v1`（/api/bots/... 不是公开接口路径），对端会按未认证返回 401。
    url: 'https://api-rpa.bazhuayu.com/api/v1/bots/scheduling/start',
    headers: {
      'Content-Type': 'application/json',
      // 官方 API Key 文档：X-API-Key（推荐）或 Authorization: Bearer <key>。
      'X-API-Key': '${secret.apiKey}',
    },
    body: {
      flowId: '${config.flowId}',
      flowContentRetrievalMode: 'ByNewestContent',
      // params 可选字段；specifiedBot / specifiedPublicationVersion 留空时不发（官方示例只带需要的字段）。
      params: '${mapped}',
    },
  },
  response: {
    // 官方文档：成功 HTTP 200，返回 { flowId, flowProcessNo }；失败 400 + code/description/requestId。
    okHttpStatus: [200],
    externalTaskIdPath: 'flowProcessNo',
  },
  // 启动机器人没有幂等键：网络超时后自动重发可能重复启动同一个流程，只发一次，失败由人工重投。
  retry: { maxAttempts: 1, retryOn: [] },
  governance: {
    contentOutbound: true,
    hosts: [{ kind: 'exact', value: 'api-rpa.bazhuayu.com' }],
    allowCustomBaseUrl: false,
    privacySection: 'G3',
  },
  risks: [
    '接口没有幂等键：网络超时后不会自动重发（避免同一个流程被启动两次），失败请在触发记录里人工重投',
    'HTTP 200 只代表「已受理启动」：执行结果需到八爪鱼控制台查看',
    '接口没有图片参数：RPA 方式不发图片（任务里的 photoLimit 对它不生效）',
    'FlowId 必须属于该 API Key 的授权范围，否则对端返回 401/400',
    '附加参数完全由你配置：值来自触发记录/固定值/自定义模板，发出去之前请确认对端流程能接受这些键',
  ],
  notes: [
    '2026-10-21（v1.3.0）：按官方文档修正请求——URL 补 `/v1`、鉴权改 `X-API-Key`、请求体改官方 camelCase 字段；',
    '  不再自动重试（无幂等键）；成功时把 `flowProcessNo` 落到 `external_task_id`，失败时展示厂商 `description`。',
    '2026-10-21（v1.2.0，按用户要求）：移除「三个内置参数」——params 完全由「附加参数」逐条配置，默认 {}；',
    '需要会话名/触发文本/触发对象时，在附加参数里各加一条（值来源分别选「会话名 / 触发文本 / 触发对象」）。',
    '附加参数的值来源：会话名/触发文本/触发对象/任务名/关键词/触发时间/会话类型/任务 id/记录 id/固定值/自定义模板。',
    '自定义模板只允许 `${record.<字段>}` / `${task.<字段>}`（字段白名单见 docs/TASK-CENTER.md §6.3）。',
  ],
}

export const adapter: RpaVendorAdapter = {
  descriptor,
}
