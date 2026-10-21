/**
 * 厂商：**影刀 RPA**（YingDao，SaaS `api.yingdao.com` + 专有云）。
 *
 * 触发链路：先用 AK/SK 换 `accessToken`（GET token/create，AK/SK 走 query），再
 * `POST /oapi/dispatch/v2/job/start` 启动单个应用；`Authorization: Bearer <token>` 由
 * 核心鉴权层（`auth.ts` 的 token-exchange）统一换 token + 缓存 + 注入，本文件只管业务请求。
 *
 * 需要 `buildRequest` 钩子的原因：`accountName` 与 `robotClientGroupUuid` 是**二选一**
 * （两者都填以分组为准），且 `params[]` 要按 `name/value/type:'str'` 组装——用声明式模板
 * 表达「条件字段」不划算，也不能把空串字段发给厂商。
 *
 * 来源：影刀帮助中心（2026-10-21 渲染读取，页面未标版本）：
 * 鉴权 …/710499792859115520、启动应用运行 …/710488569666060288、回调 …/710484124829691904、
 * 限流 …/912893828744491008。官方未给完整 token JSON 示例、专有云地址未给出、priority 枚举页未取证。
 */
import type { RpaMappingTarget, RpaSemantic, RpaVendorDescriptor, RpaField } from '../../../types-rpa.ts'
import type { RpaHttpRequest, RpaInvocationContext, RpaRecordContext, RpaVendorAdapter } from '../types.ts'

/** 三个语义参数位 → 影刀应用入参名的默认映射（须与 RPA 应用入参名一致，可改）。 */
const MAPPING_TARGETS: RpaMappingTarget[] = [
  { semantic: 'room', defaultKey: 'room_name' },
  { semantic: 'content', defaultKey: 'content' },
  { semantic: 'at', defaultKey: 'at_name' },
]
const MAP_FIELD = 'paramMap'
/** 幂等 uuid 官方上限 36 位。 */
const IDEMPOTENT_MAX = 36

/** 凭据：AccessKeyId / AccessKeySecret（只存本机；换 token 时走 query）。 */
const authFields: RpaField[] = [
  {
    key: 'accessKeyId',
    label: 'AccessKeyId',
    type: 'password',
    required: true,
    secret: true,
    example: 'ak-…',
    help: '影刀控制台「api 配置」里由企业管理员创建；只存本机。',
  },
  {
    key: 'accessKeySecret',
    label: 'AccessKeySecret',
    type: 'password',
    required: true,
    secret: true,
    help: '与 AccessKeyId 成对；只存本机，换 token 时由后端使用。',
  },
]

const descriptor: RpaVendorDescriptor = {
  id: 'yingdao',
  name: '影刀 RPA',
  vendor: '影刀 RPA（YingDao，官网 yingdao.com）',
  version: '1.0.0',
  summary: '用 AK/SK 换 token 后启动影刀应用；异步 + 回调，参数映射到应用入参。',
  status: 'stable',
  docs: {
    home: 'https://www.yingdao.com/yddoc/rpa/zh-CN/710488569666060288',
    triggerApi: 'https://www.yingdao.com/yddoc/rpa/zh-CN/710488569666060288',
    lastVerifiedAt: '2026-10-21',
    pageVersion: '未标注（SPA 渲染读取）',
  },
  capabilities: {
    direction: 'outbound',
    synchronous: false,
    completion: 'callback',
    idempotency: 'vendor-key',
    deployment: ['cloud', 'onprem'],
  },
  fields: [
    {
      key: 'baseUrl',
      label: '服务地址',
      type: 'text',
      required: true,
      defaultValue: 'https://api.yingdao.com',
      pattern: '^https?://',
      help: 'SaaS 固定 https://api.yingdao.com；专有云请填厂商提供的专有地址（官方未公开格式）。',
    },
    {
      key: 'robotUuid',
      label: '应用 UUID',
      type: 'text',
      required: true,
      example: '73d9a119-7ec7-4226-b679-506afefae667',
      summary: true,
      help: '控制台-应用管理-应用详情里复制。',
    },
    {
      key: 'accountName',
      label: '机器人账号',
      type: 'text',
      required: false,
      example: 'admin@fckj',
      help: '与「机器人分组 UUID」二选一；两者都填时以分组为准。',
    },
    {
      key: 'robotClientGroupUuid',
      label: '机器人分组 UUID',
      type: 'text',
      required: false,
      advanced: true,
      help: '与「机器人账号」二选一；填了分组时优先用分组。',
    },
    {
      key: 'priority',
      label: '排队优先级',
      type: 'select',
      required: false,
      defaultValue: 'middle',
      options: [
        { value: 'high', label: 'high' },
        { value: 'middle', label: 'middle' },
        { value: 'low', label: 'low' },
      ],
      advanced: true,
      help: '官方示例与默认值为 middle；完整枚举值页未取证，联调时核对。',
    },
    {
      key: 'paramMap',
      label: '参数映射',
      type: 'map',
      required: false,
      defaultValue: { room: 'room_name', content: 'content', at: 'at_name' },
      help: '默认 room_name/content/at_name；须改成你影刀应用里真实入参名。',
    },
  ],
  auth: {
    modes: [
      {
        strategy: 'token-exchange',
        fields: authFields,
        exchange: {
          method: 'GET',
          url: '${config.baseUrl}/oapi/token/v2/token/create',
          query: {
            accessKeyId: '${secret.accessKeyId}',
            accessKeySecret: '${secret.accessKeySecret}',
          },
          // 官方页只明确「响应含 expiresIn」，未给完整 JSON 示例；tokenPath 为约定推断（见 notes）。
          tokenPath: 'data.accessToken',
          expiresInPath: 'expiresIn',
          headerPrefix: 'Bearer ',
        },
      },
    ],
  },
  mapping: {
    style: 'nameValueTypeArray',
    mapField: MAP_FIELD,
    targets: MAPPING_TARGETS,
  },
  request: {
    method: 'POST',
    url: '${config.baseUrl}/oapi/dispatch/v2/job/start',
    headers: { 'Content-Type': 'application/json' },
    body: {
      robotUuid: '${config.robotUuid}',
      idempotentUuid: '${invocation.idempotencyKey}',
      params: '${mapped}',
    },
  },
  response: {
    okHttpStatus: [200],
    okPath: 'code',
    okValue: 200,
    externalTaskIdPath: 'data.jobUuid',
    messagePath: 'msg',
  },
  retry: { maxAttempts: 2, retryOn: ['network', 'http-5xx', 'http-429'] },
  governance: {
    contentOutbound: true,
    hosts: [{ kind: 'exact', value: 'api.yingdao.com' }],
    allowCustomBaseUrl: true,
    privacySection: 'G3',
  },
  risks: [
    '回调无签名：只能当「有变化」的信号，不能用回调内容直接写业务状态（需查询接口二次确认）',
    '专有云地址官方未给出：baseUrl 必须可配置',
    '参数合计建议 ≤8000（专有云 6.0.0 前 3000）；waitTimeout 官方标注即将作废，本适配器不使用',
    '限流：job/start 10 次/秒；API 是否有企业版门槛官方未答复',
  ],
  notes: [
    'token 响应解析路径按 data.accessToken 约定（官方页面只明确响应含 expiresIn，未给完整 JSON 示例）→ 联调核对',
    'priority 可选值只核对到 middle（默认）；枚举值说明页未取证 → 联调核对',
    '回调是控制台全局单点配置（不能按任务区分目的地）；v1 只把 jobUuid 落库，不接收回调',
  ],
}

/** 取非空字符串配置值（数字/布尔转字符串，对象/数组视为空）。 */
function configText(ctx: RpaInvocationContext, key: string): string {
  const value = ctx.config[key]
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** 三个语义参数位的取值（与旧八爪鱼口径一致：单聊没有触发对象名时回落会话名）。 */
function semanticValue(record: RpaRecordContext, semantic: RpaSemantic): string {
  if (semantic === 'room') return record.chatName
  if (semantic === 'content') return record.text
  return record.targetName !== '' ? record.targetName : record.chatName
}

/** 生成 `[{name, value, type:'str'}]`：key 可被配置里的 map 字段逐项覆盖。 */
function mappedParams(ctx: RpaInvocationContext): Array<{ name: string; value: string; type: 'str' }> {
  const raw = ctx.config[MAP_FIELD]
  const overrides = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  return MAPPING_TARGETS.map((target) => {
    const custom = overrides[target.semantic]
    const name = typeof custom === 'string' && custom.trim() !== '' ? custom.trim() : target.defaultKey
    return { name, value: semanticValue(ctx.record, target.semantic), type: 'str' as const }
  })
}

export const adapter: RpaVendorAdapter = {
  descriptor,
  /**
   * 组装「启动应用运行」请求：必要字段 + accountName/分组二选一 + params[]。
   * @param ctx - 投递上下文（config 含 baseUrl/robotUuid 等，secrets 含 AK/SK）。
   * @returns POST job/start 请求。
   * @throws 服务地址或应用 UUID 缺失时抛可读错误。
   */
  buildRequest(ctx: RpaInvocationContext): RpaHttpRequest {
    const baseUrl = configText(ctx, 'baseUrl').replace(/\/+$/, '')
    if (baseUrl === '') throw new Error('影刀 RPA 投递失败：任务未配置服务地址')
    const robotUuid = configText(ctx, 'robotUuid')
    if (robotUuid === '') throw new Error('影刀 RPA 投递失败：任务未配置应用 UUID')
    const body: Record<string, unknown> = {
      robotUuid,
      // 幂等 uuid ≤36 位；用触发记录级 id 做一次创建防重（官方：重复请求只成功创建一次）。
      idempotentUuid: ctx.idempotencyKey.slice(0, IDEMPOTENT_MAX),
      params: mappedParams(ctx),
    }
    const group = configText(ctx, 'robotClientGroupUuid')
    const account = configText(ctx, 'accountName')
    // 官方明确「两者都填以分组为准」，所以分组优先；都没有就交给控制台默认分配。
    if (group !== '') body['robotClientGroupUuid'] = group
    else if (account !== '') body['accountName'] = account
    const priority = configText(ctx, 'priority')
    if (priority !== '') body['priority'] = priority
    return {
      method: 'POST',
      url: baseUrl + '/oapi/dispatch/v2/job/start',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      contentType: 'application/json',
    }
  },
}
