/**
 * 厂商：**阿里云 RPA**（原码栈；`console-rpa.aliyun.com` 上的私有 RPC 风格接口）——**实验性**。
 *
 * 触发：服务型机器人 `POST /rpa/openapi/raas/task/CreateTask`（参数首字母大写）；本地型机器人
 * `POST /rpa/openapi/task/createServiceTask`（参数小写）。两套 API 大小写敏感，由 `apiFamily` 切换。
 *
 * 鉴权是**老版 RPC 签名**（不是阿里云标准 OpenAPI、不是 ACS3）：
 *  · `SignatureMethod=HMAC-SHA1`、`SignatureVersion=1.0`、`Version=20200430`、`Format=json`；
 *  · 公共参数 + 接口自定义参数一起参与签名；`Signature = Base64(HMAC-SHA1(AccessKeySecret + "&", StringToSign))`；
 *  · `StringToSign = HTTPMethod + "&" + percentEncode("/") + "&" + percentEncode(CanonicalizedQueryString)`。
 *
 * 本文件按官方「HTTP 调用说明」实现 `buildRequest`（业务参数 → form body）与 `signRequest`
 * （补公共参数、签名、重排 body）；签名函数 `aliyunRpcSign` 单独导出以便单测。
 *
 * ⚠️ 官方示例自相矛盾（CreateTask 说 body 传参但示例是 query 串；Python 示例签名参数放 body、
 * Java 示例放 query），因此本适配器标 `experimental`：**签名位置需 POC 核对**。
 *
 * 来源：阿里云帮助中心（2026-10-21）：CreateTask、createServiceTask、HTTP 调用说明、
 * ListTasks/ListTaskDetails、集成服务型机器人、幂等调用、调用限制。多数页面「更新时间」为空。
 */
import { createHmac, randomUUID } from 'node:crypto'
import type { RpaMappingTarget, RpaSemantic, RpaVendorDescriptor, RpaField } from '../../../types-rpa.ts'
import type {
  RpaHttpRequest,
  RpaHttpResponse,
  RpaInvocationContext,
  RpaRecordContext,
  RpaSendResult,
  RpaVendorAdapter,
} from '../types.ts'

/** 公共参数固定值（官方 HTTP 调用说明）。 */
const SIGNATURE_METHOD = 'HMAC-SHA1'
const SIGNATURE_VERSION = '1.0'
const API_VERSION = '20200430'
/** 官方默认任务优先级（1–100，100 最高）。 */
const DEFAULT_TASK_PRIORITY = 50
/** `AppParams` 官方上限 40KB。 */
const APP_PARAMS_MAX = 40_000

const MAPPING_TARGETS: RpaMappingTarget[] = [
  { semantic: 'room', defaultKey: 'room_name' },
  { semantic: 'content', defaultKey: 'content' },
  { semantic: 'at', defaultKey: 'at_name' },
]
const MAP_FIELD = 'appParamsMap'

const accessKeyIdField: RpaField = {
  key: 'accessKeyId',
  label: 'AccessKeyId',
  type: 'password',
  required: true,
  secret: true,
  help: '从 RPA 控制台「系统设置」获取的 AK（不是阿里云 RAM AccessKey）；只存本机。',
}
const accessKeySecretField: RpaField = {
  key: 'accessKeySecret',
  label: 'AccessKeySecret',
  type: 'password',
  required: true,
  secret: true,
  help: '与 AccessKeyId 成对；只用于本地签名，不发送。',
}

const descriptor: RpaVendorDescriptor = {
  id: 'aliyun-rpa',
  name: '阿里云 RPA',
  vendor: '阿里云 机器人流程自动化（RPA，原码栈）',
  version: '1.0.0',
  summary: '调用阿里云 RPA OpenAPI 创建任务（服务型/本地型两套接口，HMAC-SHA1 签名）。实验性：签名位置待 POC。',
  status: 'experimental',
  docs: {
    home: 'https://help.aliyun.com/zh/rpa/developer-reference/',
    triggerApi: 'https://help.aliyun.com/zh/rpa/developer-reference/createtask',
    lastVerifiedAt: '2026-10-21',
    pageVersion: '多数页面「更新时间」为空；产品线 v4（v3 已于 2024-12-31 停止服务）',
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
      key: 'apiFamily',
      label: '接口族',
      type: 'select',
      required: true,
      defaultValue: 'service',
      options: [
        { value: 'service', label: '服务型机器人（CreateTask，参数大写）' },
        { value: 'local', label: '本地型机器人（createServiceTask，参数小写）' },
      ],
      help: '两套 API 大小写敏感、不可混用；服务型仅公有云（需无影云电脑）。',
    },
    {
      key: 'baseUrl',
      label: '服务地址',
      type: 'text',
      required: true,
      defaultValue: 'https://console-rpa.aliyun.com',
      pattern: '^https?://',
      help: '公有云固定 https://console-rpa.aliyun.com；线下部署填 RPA 控制台地址。',
    },
    {
      key: 'appId',
      label: '应用 ID',
      type: 'text',
      required: true,
      example: '2e8e34bf-0000-0000-0000-e1d0add3d95e',
      summary: true,
      help: '控制台「企业应用-企业应用列表」查看。',
    },
    {
      key: 'appVersion',
      label: '应用版本',
      type: 'text',
      required: true,
      example: '1.0.0',
      help: '填具体版本号或 dynamic；留空行为随部署形态/服务端版本漂移（官方多处口径冲突），本版强制填。',
    },
    {
      key: 'allocateMode',
      label: '分配方式',
      type: 'select',
      required: false,
      defaultValue: 'auto',
      options: [
        { value: 'auto', label: 'auto（按分组自动分配）' },
        { value: 'manu', label: 'manu（手动指定机器人）' },
      ],
      advanced: true,
      help: '官方：空=auto；手动指定时需 AllocateMode=manu + RobotId。',
    },
    {
      key: 'robotId',
      label: '机器人 ID',
      type: 'text',
      required: false,
      advanced: true,
      help: '服务型：RobotId（配合 manu）；本地型：机器人 ID（createServiceTask 的 clientId）。',
    },
    {
      key: 'packId',
      label: '机器人分组 ID',
      type: 'text',
      required: false,
      advanced: true,
      example: 'bv2XPrDl',
      help: '服务型：配合 auto 指定机器人分组，空=默认分组；本地型不使用。',
    },
    {
      key: 'taskPriority',
      label: '任务优先级',
      type: 'number',
      required: false,
      defaultValue: DEFAULT_TASK_PRIORITY,
      advanced: true,
      help: '1–100，100 最高；官方默认 50。',
    },
    {
      key: 'callbackUrl',
      label: '回调地址',
      type: 'text',
      required: false,
      advanced: true,
      example: 'https://example.com/rpa/callback?token=…',
      help: '可选。官方回调无签名，建议 https + 随机 token 放 query；v1 只把 TaskId 落库。',
    },
    {
      key: 'appParamsMap',
      label: '参数映射',
      type: 'map',
      required: true,
      defaultValue: { room: 'room_name', content: 'content', at: 'at_name' },
      help: '映射成 AppParams 的 name/value 数组（键名须与 RPA 应用入参名一致）。',
    },
  ],
  auth: {
    modes: [
      {
        strategy: 'custom',
        custom: 'aliyun-rpc-hmac-sha1',
        fields: [accessKeyIdField, accessKeySecretField],
      },
    ],
  },
  mapping: {
    style: 'nameValueArray',
    mapField: MAP_FIELD,
    targets: MAPPING_TARGETS,
  },
  request: {
    method: 'POST',
    url: '${config.baseUrl}/rpa/openapi/raas/task/CreateTask',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: {
      AppId: '${config.appId}',
      AppVersion: '${config.appVersion}',
      AppParams: '${mapped}',
    },
  },
  response: {
    okHttpStatus: [200],
    okPath: 'code',
    okValue: 0,
    externalTaskIdPath: 'data.TaskId',
    messagePath: 'msg',
  },
  retry: { maxAttempts: 2, retryOn: ['network', 'http-5xx', 'http-429'] },
  governance: {
    contentOutbound: true,
    hosts: [{ kind: 'exact', value: 'console-rpa.aliyun.com' }],
    allowCustomBaseUrl: true,
    privacySection: 'G3',
  },
  risks: [
    '官方示例矛盾：CreateTask 说 body 传参但示例是 query 串；Python 示例签名参数放 body、Java 示例放 query → 签名位置必须 POC 核对',
    '回调无签名：body 只有 taskId/taskStatus/taskResult，可被伪造/重放（需随机路径 + token + 二次查询）',
    '服务型/本地型是两套大小写敏感接口，参数不可混用；AppVersion 默认语义多处冲突',
    '成本与开通门槛高（机器人授权 5,000 元/年起 + 编辑器授权；服务型需无影云电脑 + 主账号授权）',
    'AK 来源是 RPA 控制台「系统设置」，不是阿里云 RAM AccessKey（与 RAM/STS 关系官方未说明）',
  ],
  notes: [
    '官方未公开：全局限流 QPS、本地型回调协议细节（超时/重试/payload）。本适配器不承诺这两项。',
    '签名实现按官方 HTTP 调用说明（HMAC-SHA1 / SignatureVersion=1.0 / Version=20200430）把公共参数与业务参数都放 form body；官方示例 body/query 签名位置矛盾，待联调（POC）核对。',
    '服务型 CreateTask 支持 X-Idempotent-Request-ID（≤50 字符、180 秒窗口、非强制）：本适配器用触发记录级 id 注入。',
    '回调无签名 → v1 只落库 externalTaskId（TaskId），不接收回调；状态查询留待后续（ListTasks/ListTaskDetails）。',
  ],
}

/** RFC3986 编码（阿里云签名规定）：`A-Za-z0-9-_.~` 不编码，空格 → `%20`。 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => {
    return '%' + char.charCodeAt(0).toString(16).toUpperCase()
  })
}

/**
 * 规范化查询串：参数按 key 字典序排序，逐项 `percentEncode(k)=percentEncode(v)` 用 `&` 连接。
 * @param params - 参与签名的参数（**不含** Signature）。
 * @returns CanonicalizedQueryString。
 */
export function canonicalizedQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((key) => percentEncode(key) + '=' + percentEncode(params[key] ?? ''))
    .join('&')
}

/**
 * 计算阿里云 RPC 签名（HMAC-SHA1 + Base64）。
 *
 * 步骤（官方「HTTP 调用说明」）：CanonicalizedQueryString → `StringToSign =
 * HTTPMethod&percentEncode("/")&percentEncode(canonical)` → `Base64(HMAC-SHA1(AccessKeySecret + "&", StringToSign))`。
 * @param params - 参与签名的全部参数（公共参数 + 业务参数，**不含** Signature）。
 * @param accessKeySecret - RPA 控制台系统设置的 AccessKeySecret。
 * @param method - HTTP 方法（官方签名串里是大写，默认 POST）。
 * @returns Base64 签名串。
 */
export function aliyunRpcSign(params: Record<string, string>, accessKeySecret: string, method = 'POST'): string {
  const canonical = canonicalizedQuery(params)
  const stringToSign = method.toUpperCase() + '&' + percentEncode('/') + '&' + percentEncode(canonical)
  return createHmac('sha1', accessKeySecret + '&').update(stringToSign, 'utf8').digest('base64')
}

/** form body 编码：与签名同一套 RFC3986 编码（避免签名用 %20、body 用 + 的不一致）。 */
function encodeForm(params: Record<string, string>): string {
  return Object.keys(params)
    .map((key) => percentEncode(key) + '=' + percentEncode(params[key] ?? ''))
    .join('&')
}

/** 取非空字符串配置值（数字/布尔转字符串，对象/数组视为空）。 */
function configText(ctx: RpaInvocationContext, key: string): string {
  const value = ctx.config[key]
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** 取数字配置值（缺省/非法时用 fallback）。 */
function configNumber(ctx: RpaInvocationContext, key: string, fallback: number): number {
  const value = ctx.config[key]
  const parsed = typeof value === 'number' ? value : Number(configText(ctx, key))
  return Number.isFinite(parsed) ? parsed : fallback
}

/** 三个语义参数位的取值（单聊没有触发对象名时回落会话名，与旧实现同口径）。 */
function semanticValue(record: RpaRecordContext, semantic: RpaSemantic): string {
  if (semantic === 'room') return record.chatName
  if (semantic === 'content') return record.text
  return record.targetName !== '' ? record.targetName : record.chatName
}

/** `AppParams` 的 `[{name,value}]` 数组：映射键可被配置里的 map 字段逐项覆盖。 */
function appParams(ctx: RpaInvocationContext): Array<{ name: string; value: string }> {
  const raw = ctx.config[MAP_FIELD]
  const overrides = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}
  return MAPPING_TARGETS.map((target) => {
    const custom = overrides[target.semantic]
    const name = typeof custom === 'string' && custom.trim() !== '' ? custom.trim() : target.defaultKey
    return { name, value: semanticValue(ctx.record, target.semantic) }
  })
}

/** 组装业务参数（未签名）：服务型大写参数 / 本地型小写参数。 */
function businessParams(ctx: RpaInvocationContext, family: 'service' | 'local'): Record<string, string> {
  const appId = configText(ctx, 'appId')
  if (appId === '') throw new Error('阿里云 RPA 投递失败：任务未配置应用 ID')
  const appVersion = configText(ctx, 'appVersion')
  const paramsText = JSON.stringify(appParams(ctx))
  if (paramsText.length > APP_PARAMS_MAX) {
    throw new Error('阿里云 RPA 投递失败：AppParams 超过 40KB 上限')
  }
  const callbackUrl = configText(ctx, 'callbackUrl')
  const robotId = configText(ctx, 'robotId')
  const packId = configText(ctx, 'packId')
  if (family === 'service') {
    const out: Record<string, string> = { AppId: appId, AppParams: paramsText }
    const allocateMode = configText(ctx, 'allocateMode') !== '' ? configText(ctx, 'allocateMode') : 'auto'
    out['AllocateMode'] = allocateMode
    if (allocateMode === 'manu' && robotId !== '') out['RobotId'] = robotId
    if (allocateMode !== 'manu' && packId !== '') out['PackId'] = packId
    out['TaskPriority'] = String(configNumber(ctx, 'taskPriority', DEFAULT_TASK_PRIORITY))
    if (appVersion !== '') out['AppVersion'] = appVersion
    if (callbackUrl !== '') out['CallbackUrl'] = callbackUrl
    return out
  }
  const local: Record<string, string> = { appId, appParams: paramsText }
  if (robotId !== '') local['clientId'] = robotId
  if (appVersion !== '') local['appVersion'] = appVersion
  if (callbackUrl !== '') local['callbackUrl'] = callbackUrl
  return local
}

/** 接口路径（服务型/本地型大小写敏感，不可混用）。 */
function triggerPath(family: 'service' | 'local'): string {
  return family === 'service'
    ? '/rpa/openapi/raas/task/CreateTask'
    : '/rpa/openapi/task/createServiceTask'
}

/** 当前配置对应的接口族（缺省 service）。 */
function apiFamilyOf(ctx: RpaInvocationContext): 'service' | 'local' {
  return configText(ctx, 'apiFamily') === 'local' ? 'local' : 'service'
}

export const adapter: RpaVendorAdapter = {
  descriptor,
  /**
   * 组装 CreateTask / createServiceTask 请求：业务参数先放 form body（未签名），
   * 公共参数与 Signature 由 {@link signRequest} 在出网前补齐。
   * @param ctx - 投递上下文。
   * @returns POST 请求（body 为 form-urlencoded）。
   * @throws 应用 ID / 服务地址缺失或 AppParams 超限时抛可读错误。
   */
  buildRequest(ctx: RpaInvocationContext): RpaHttpRequest {
    const baseUrl = configText(ctx, 'baseUrl') !== '' ? configText(ctx, 'baseUrl') : 'https://console-rpa.aliyun.com'
    const family = apiFamilyOf(ctx)
    const params = businessParams(ctx, family)
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
    if (family === 'service') {
      // 官方：X-Idempotent-Request-ID ≤50 字符、180 秒窗口、非强制；用触发记录级 id 防重复创建。
      headers['X-Idempotent-Request-ID'] = ctx.idempotencyKey.slice(0, 50)
    }
    return {
      method: 'POST',
      url: baseUrl.replace(/\/+$/, '') + triggerPath(family),
      headers,
      body: encodeForm(params),
      contentType: 'application/x-www-form-urlencoded',
    }
  },
  /**
   * RPC 签名（custom 鉴权）：解析 body 里的业务参数 → 补公共参数 → 计算 Signature →
   * 把所有参数（含 Signature）重新编码进 form body。官方 Java 示例是 query、Python 示例是 body；
   * 本实现按「body 传参」的官方文字说明，需 POC 核对（见 notes/risks）。
   * @param req - 已组装的请求（原地改写 body）。
   * @param ctx - 投递上下文（secrets 里取 AK/SK）。
   * @throws 凭据缺失时抛可读错误（避免把无签名请求发出去）。
   */
  signRequest(req: RpaHttpRequest, ctx: RpaInvocationContext): void {
    const accessKeyId = ctx.secrets['accessKeyId'] ?? ''
    const accessKeySecret = ctx.secrets['accessKeySecret'] ?? ''
    if (accessKeyId === '' || accessKeySecret === '') {
      throw new Error('阿里云 RPA 投递失败：缺少 AccessKeyId / AccessKeySecret')
    }
    const params: Record<string, string> = {}
    for (const [key, value] of new URLSearchParams(req.body)) params[key] = value
    params['AccessKeyId'] = accessKeyId
    params['SignatureMethod'] = SIGNATURE_METHOD
    params['SignatureVersion'] = SIGNATURE_VERSION
    params['SignatureNonce'] = randomUUID().replace(/-/g, '')
    params['Timestamp'] = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
    params['Version'] = API_VERSION
    params['Format'] = 'json'
    params['Signature'] = aliyunRpcSign(params, accessKeySecret, req.method)
    req.body = encodeForm(params)
  },
  /** 解析响应：`code=0` 成功，任务 id 取 `data.TaskId`（服务型）/`data.taskId`（本地型）。 */
  parseResponse(res: RpaHttpResponse): RpaSendResult {
    const status = Number(res.status)
    if (status !== 200) {
      return {
        ok: false,
        retryable: status >= 500 || status === 429,
        message: '阿里云 RPA 触发失败：HTTP ' + String(status),
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(res.bodyText) as unknown
    } catch {
      return { ok: false, retryable: false, message: '阿里云 RPA 响应不是合法 JSON' }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, retryable: false, message: '阿里云 RPA 响应格式不正确' }
    }
    const root = parsed as Record<string, unknown>
    const code = root['code']
    const okCode = code === 0 || code === '0' || code === undefined
    if (!okCode) {
      const msg = root['msg']
      return {
        ok: false,
        retryable: false,
        message: '阿里云 RPA 触发失败：' + (typeof msg === 'string' ? msg : 'code=' + String(code)),
      }
    }
    const data = root['data']
    const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
    const taskId = record['TaskId'] ?? record['taskId']
    return {
      ok: true,
      retryable: false,
      externalTaskId: typeof taskId === 'string' ? taskId : typeof taskId === 'number' ? String(taskId) : undefined,
      message: typeof root['msg'] === 'string' ? root['msg'] : undefined,
    }
  },
}
