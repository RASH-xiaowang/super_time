/**
 * 内置厂商：**八爪鱼 RPA**。
 *
 * 固定主机 `api-rpa.bazhuayu.com`（写死在请求模板里，不来自用户输入），鉴权是
 * `X-Api-Key` 请求头（凭据只存本机、只进 header）；请求体形状：
 * `FlowId` + 固定字段 + `Params{...}`，**不发图片**。
 *
 * 2026-10-21 参数增强（v1.2.0，用户要求）：**不再有「三个内置参数」**——`Params` 里放什么
 * 完全由任务的「附加参数」逐条配置（参数名 + 值来源），默认 `Params: {}`。这样八爪鱼流程
 * 的入参名/数量都不受本产品预设限制；需要会话名/触发文本/触发对象时，在附加参数里各加一条
 * （值来源分别选「会话名 / 触发文本 / 触发对象」）即可。
 */
import type { RpaVendorDescriptor, RpaField } from '../../../types-rpa.ts'
import type { RpaVendorAdapter } from '../types.ts'

/** 附加参数允许的值来源：触发记录/任务的内置字段 + 固定值 + 自定义模板（不含图片）。 */
const EXTRA_PARAM_SOURCES = [
  'room', 'content', 'at', 'taskName', 'keyword', 'triggeredAt', 'chatType',
  'taskId', 'recordId', 'fixed', 'template',
] as const

/** 八爪鱼 API Key（凭据：只存 trigger_secret，投递时进 X-Api-Key）。 */
const apiKeyField: RpaField = {
  key: 'apiKey',
  label: 'API Key',
  ariaLabel: '八爪鱼 API Key',
  type: 'password',
  required: true,
  secret: true,
  help: '只存本机；投递时由后端读出来放进 X-Api-Key 请求头，不进任务列表/Remote 返回值。',
}

const descriptor: RpaVendorDescriptor = {
  id: 'bazhuayu',
  name: '八爪鱼 RPA',
  vendor: '八爪鱼 RPA（Bazhuayu）',
  version: '1.2.0',
  summary: '把任务「附加参数」逐条映射成八爪鱼流程入参（默认不发业务参数），POST 到八爪鱼固定主机启动流程（不发图片）。',
  status: 'stable',
  docs: {
    home: 'https://www.bazhuayu.com/',
    triggerApi: 'https://www.bazhuayu.com/',
    lastVerifiedAt: '2026-10-21',
    pageVersion: '内置通道（2026-10-21 回归核对；无公开接口页）',
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
    // 凭据直接写进请求模板 header（X-Api-Key: ${secret.apiKey}），没有额外鉴权流程。
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
    url: 'https://api-rpa.bazhuayu.com/api/bots/scheduling/start',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': '${secret.apiKey}',
    },
    body: {
      FlowId: '${config.flowId}',
      FlowContentRetrievalMode: 'ByNewestContent',
      SpecifiedPublicationVersion: '',
      SpecifiedBot: '',
      Params: '${mapped}',
      UserStartSource: 'OpenApi',
    },
  },
  response: {
    // 旧实现按「HTTP 2xx = 成功」判定（接口没有业务码约定）。
    okHttpStatus: [200, 201, 202, 204],
  },
  retry: { maxAttempts: 2, retryOn: ['network', 'http-5xx', 'http-429'] },
  governance: {
    contentOutbound: true,
    hosts: [{ kind: 'exact', value: 'api-rpa.bazhuayu.com' }],
    allowCustomBaseUrl: false,
    privacySection: 'G3',
  },
  risks: [
    '2xx 即视为成功：接口没有业务码可核对，执行失败只能到八爪鱼控制台查看',
    '接口没有图片参数：RPA 方式不发图片（任务里的 photoLimit 对它不生效）',
    'FlowId 必须属于该 API Key 的授权范围，否则对端可能返回错误',
    '附加参数完全由你配置：值来自触发记录/固定值/自定义模板，发出去之前请确认对端流程能接受这些键',
  ],
  notes: [
    '2026-10-21（v1.2.0，按用户要求）：移除「三个内置参数」——Params 完全由「附加参数」逐条配置，默认 {}；',
    '需要会话名/触发文本/触发对象时，在附加参数里各加一条（值来源分别选「会话名 / 触发文本 / 触发对象」）。',
    '附加参数的值来源：会话名/触发文本/触发对象/任务名/关键词/触发时间/会话类型/任务 id/记录 id/固定值/自定义模板。',
    '自定义模板只允许 `${record.<字段>}` / `${task.<字段>}`（字段白名单见 docs/TASK-CENTER.md §6.3）。',
  ],
}

export const adapter: RpaVendorAdapter = {
  descriptor,
}
