/**
 * 内置厂商：**八爪鱼 RPA**（迁移基线，行为与 2026-10-21 之前逐字段一致）。
 *
 * 固定主机 `api-rpa.bazhuayu.com`（写死在请求模板里，不来自用户输入），鉴权是
 * `X-Api-Key` 请求头（凭据只存本机、只进 header）；请求体形状沿用旧实现：
 * `FlowId` + 固定字段 + `Params{room_name, content, at_name}`，**不发图片**。
 *
 * 该厂商完全用声明式模板表达，没有代码钩子；参数映射走 `mapping.style='object'`
 * （`Params` 整值替换为 `{room_name,content,at_name}` 对象）。
 */
import type { RpaVendorDescriptor, RpaField, RpaMappingTarget } from '../../../types-rpa.ts'
import type { RpaVendorAdapter } from '../types.ts'

/** 三个语义参数位的默认映射键（=`Params` 的三个固定字段，沿用旧实现）。 */
const MAPPING_TARGETS: RpaMappingTarget[] = [
  { semantic: 'room', defaultKey: 'room_name' },
  { semantic: 'content', defaultKey: 'content' },
  { semantic: 'at', defaultKey: 'at_name' },
]

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
  version: '1.0.0',
  summary: '把触发记录映射成 room_name/content/at_name，POST 到八爪鱼固定主机启动流程（不发图片）。',
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
  ],
  auth: {
    // 凭据直接写进请求模板 header（X-Api-Key: ${secret.apiKey}），没有额外鉴权流程。
    modes: [],
  },
  mapping: {
    style: 'object',
    mapField: 'paramMap',
    targets: MAPPING_TARGETS,
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
  ],
  notes: [
    '内置厂商：请求 URL / 请求头 / 请求体与 2026-10-21 之前完全一致（作为多厂商改造的回归基线）。',
  ],
}

export const adapter: RpaVendorAdapter = {
  descriptor,
}
