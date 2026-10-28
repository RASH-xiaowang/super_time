/**
 * 厂商：**实在智能 RPA**（Intelligent RPA / 实在 RPA 控制器 Commander）——**实验性**。
 *
 * 触发：`POST {基址}/openAPI/v2/job/operation`（since 1.8.0）——「预建任务 + 每次触发」：
 * body `{jobUuid, operation:1, inputParam:{…}}`；响应 `data.works[].workUuid` 是运行记录 id。
 *
 * **接入 blocker（官方原文缺失）**：鉴权只写 `appKey` + `appSecret`「随 header 传递」，
 * 但**官方未公开 header 字段名**（实测未登录响应也不提示）。因此适配器把两个 header 名
 * 做成用户配置（`keyHeader`/`secretHeader`，默认空，联调时填），不猜任何一个名字。
 *
 * 另：官方无回调、无幂等键 → 不能自动重试（`retry.maxAttempts=1`），完成状态只能轮询
 * `work-execute/list` / `work-list`（v1 不做轮询，只把 workUuid 落库）。
 *
 * 来源：实在学院平台接口文档（2026-10-21）：API 授权（发刊 2023/08/22）、任务管理、流程管理、
 * 机器人管理、控制器简介、消息中心。
 */
import type { RpaVendorDescriptor, RpaField } from '../../../types-rpa.ts'
import { RPA_PARAM_SOURCES } from '../param-sources.ts'
import { resolveMapped } from '../template.ts'
import type {
  RpaHttpRequest,
  RpaHttpResponse,
  RpaInvocationContext,
  RpaSendResult,
  RpaVendorAdapter,
} from '../types.ts'

/** 操作码：1 = 立即/再次执行（官方 v2/job/operation）。 */
const OPERATION_START = 1

const appKeyField: RpaField = {
  key: 'appKey',
  label: 'AppKey',
  type: 'password',
  required: true,
  secret: true,
  help: '控制中枢「基础配置」页面获取；只存本机。',
}
const appSecretField: RpaField = {
  key: 'appSecret',
  label: 'AppSecret',
  type: 'password',
  required: true,
  secret: true,
  help: '与 AppKey 成对；只存本机，投递时放进你填的 Secret header。',
}

const descriptor: RpaVendorDescriptor = {
  id: 'shizai',
  name: '实在智能 RPA',
  vendor: '实在智能（Intelligent RPA）',
  version: '1.1.0',
  summary: '对预建任务触发执行（openAPI/v2/job/operation）；业务参数全部由「附加参数」显式配置。实验性：鉴权 header 名官方未公开，需联调。',
  status: 'experimental',
  docs: {
    home: 'https://rpa-college.ai-indeed.com/doc/group_1687.html',
    triggerApi: 'https://rpa-college.ai-indeed.com/doc/2477.html',
    lastVerifiedAt: '2026-10-21',
    pageVersion: '核心接口页「发刊日期 2023/08/22」；站点无更新记录',
  },
  capabilities: {
    direction: 'outbound',
    synchronous: false,
    completion: 'none',
    idempotency: 'none',
    deployment: ['cloud', 'onprem'],
  },
  fields: [
    {
      key: 'baseUrl',
      label: '服务地址',
      type: 'text',
      required: true,
      defaultValue: 'https://z-commander-api.ai-indeed.com',
      pattern: '^https?://',
      help: 'SaaS 固定 https://z-commander-api.ai-indeed.com；私有化填私有地址。',
    },
    {
      key: 'keyHeader',
      label: 'AppKey header 名',
      type: 'text',
      required: false,
      defaultValue: '',
      advanced: true,
      help: '官方未公开鉴权 header 字段名（只写「随 header 传递」）：联调确认后把 AppKey 的 header 名填这里。',
    },
    {
      key: 'secretHeader',
      label: 'AppSecret header 名',
      type: 'text',
      required: false,
      defaultValue: '',
      advanced: true,
      help: '同上：联调确认后把 AppSecret 的 header 名填这里。',
    },
    {
      key: 'jobUuid',
      label: '任务 UUID',
      type: 'text',
      required: true,
      example: 'UADACDSKKAKSDLLAL',
      summary: true,
      help: '控制器里预建任务的 UUID（任务入参须与流程「引用参数/模板」一致）。',
    },
    {
      key: 'priority',
      label: '优先级',
      type: 'number',
      required: false,
      defaultValue: 2,
      advanced: true,
      help: '预建任务优先级（1 高 / 2 中 / 3 低）。官方 v2/job/operation 请求体未含该字段，本版不发送，请在控制器设置。',
    },
    {
      key: 'extraParams',
      label: '附加参数',
      type: 'paramList',
      required: false,
      maxItems: 20,
      paramSources: [...RPA_PARAM_SOURCES],
      help: 'inputParam 全部在这里配置（默认 {}，不发任何业务参数）。参数名必须与流程引用参数一致；'
        + '需要会话名/触发文本/触发对象时，各加一条并把值来源选成对应项。',
    },
  ],
  auth: {
    modes: [
      {
        strategy: 'custom',
        custom: 'shizai-appkey-headers',
        fields: [appKeyField, appSecretField],
      },
    ],
  },
  mapping: {
    style: 'object',
    targets: [],
    extrasField: 'extraParams',
    legacyMapField: 'inputParamMap',
  },
  request: {
    method: 'POST',
    url: '${config.baseUrl}/openAPI/v2/job/operation',
    headers: { 'Content-Type': 'application/json' },
    body: {
      jobUuid: '${config.jobUuid}',
      operation: OPERATION_START,
      inputParam: '${mapped}',
    },
  },
  response: {
    okHttpStatus: [200],
    okPath: 'code',
    okValue: 0,
    externalTaskIdPath: 'data.works[0].workUuid',
    messagePath: 'msg',
  },
  retry: { maxAttempts: 1, retryOn: [] },
  governance: {
    contentOutbound: true,
    hosts: [{ kind: 'exact', value: 'z-commander-api.ai-indeed.com' }],
    allowCustomBaseUrl: true,
    privacySection: 'G3',
  },
  risks: [
    '鉴权 header 字段名官方未公开（blocker）：keyHeader/secretHeader 必须联调确认后填写，否则请求无法通过鉴权',
    '无回调、无幂等键：超时重试会重复执行 RPA → 本适配器禁止自动重试（maxAttempts=1）',
    'inputParam 受流程「引用参数/模板」约束（错误码：任务参数不匹配 / 引用类型需传引用参数）',
    'v2/job/operation 需控制器 ≥1.8.0；文档较旧（2023/08/22 发刊）',
    '业务参数默认不发；只有「附加参数」显式配置后才进入 inputParam，请确认键名与流程引用参数一致',
  ],
  notes: [
    '官方未公开：鉴权 header 名、限流 QPS、回调（只有站内消息）。状态查询需 work-execute/list / work-list 轮询（v1 不做）。',
    'priority 字段是预建任务属性；官方 v2/job/operation 请求体只有 jobUuid/operation/inputParam → 本适配器不发送 priority，待联调确认。',
    'operation=1（立即/再次执行）为官方取值；停止/删除分别用 2/3/4，本适配器只用 1。',
    '2026-10-23（v1.1.0）：移除内置参数映射，统一改为「附加参数」；旧 inputParamMap 自动迁移。',
  ],
}

/** 取非空字符串配置值（数字/布尔转字符串，对象/数组视为空）。 */
function configText(ctx: RpaInvocationContext, key: string): string {
  const value = ctx.config[key]
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** 从 v2/job/operation 响应里取运行记录 id（works[].workUuid），兼容 data.jobUuid。 */
function pickWorkUuid(data: Record<string, unknown>): string | undefined {
  const works = data['works']
  if (Array.isArray(works)) {
    const first = works[0]
    if (typeof first === 'object' && first !== null) {
      const workUuid = (first as Record<string, unknown>)['workUuid']
      if (typeof workUuid === 'string' && workUuid !== '') return workUuid
    }
  }
  const jobUuid = data['jobUuid']
  return typeof jobUuid === 'string' && jobUuid !== '' ? jobUuid : undefined
}

export const adapter: RpaVendorAdapter = {
  descriptor,
  /**
   * 组装「预建任务触发」请求：`{jobUuid, operation:1, inputParam}`。
   * @param ctx - 投递上下文。
   * @returns POST `/openAPI/v2/job/operation` 请求。
   * @throws 服务地址 / 任务 UUID 缺失时抛可读错误。
   */
  buildRequest(ctx: RpaInvocationContext): RpaHttpRequest {
    const baseUrl = configText(ctx, 'baseUrl').replace(/\/+$/, '')
    if (baseUrl === '') throw new Error('实在智能 RPA 投递失败：任务未配置服务地址')
    const jobUuid = configText(ctx, 'jobUuid')
    if (jobUuid === '') throw new Error('实在智能 RPA 投递失败：任务未配置任务 UUID')
    const body = {
      jobUuid,
      operation: OPERATION_START,
      inputParam: resolveMapped(descriptor, ctx),
    }
    return {
      method: 'POST',
      url: baseUrl + '/openAPI/v2/job/operation',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      contentType: 'application/json',
    }
  },
  /**
   * 实在的「明文 Key/Secret」鉴权：官方只写「随 header 传递」、未给 header 名。
   * 这里按用户配置的 header 名注入；两个名字都必须由联调确认后填写（不猜、不伪造）。
   * @param req - 已组装的请求（原地改写 headers）。
   * @param ctx - 投递上下文（secrets 里取 appKey/appSecret）。
   * @throws 任一 header 名或凭据缺失时抛可读错误（避免发出无鉴权请求）。
   */
  signRequest(req: RpaHttpRequest, ctx: RpaInvocationContext): void {
    const keyHeader = configText(ctx, 'keyHeader')
    const secretHeader = configText(ctx, 'secretHeader')
    const appKey = ctx.secrets['appKey'] ?? ''
    const appSecret = ctx.secrets['appSecret'] ?? ''
    if (keyHeader === '' || secretHeader === '') {
      throw new Error('实在智能 RPA 投递失败：未配置鉴权 header 名（官方未公开，需联调确认后填写）')
    }
    if (appKey === '' || appSecret === '') {
      throw new Error('实在智能 RPA 投递失败：缺少 AppKey / AppSecret')
    }
    req.headers[keyHeader] = appKey
    req.headers[secretHeader] = appSecret
  },
  /** 解析响应：`code=0` 成功；运行记录 id 取 `data.works[0].workUuid`。 */
  parseResponse(res: RpaHttpResponse): RpaSendResult {
    const status = Number(res.status)
    if (status !== 200) {
      return {
        ok: false,
        retryable: status >= 500 || status === 429,
        message: '实在智能 RPA 触发失败：HTTP ' + String(status),
      }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(res.bodyText) as unknown
    } catch {
      return { ok: false, retryable: false, message: '实在智能 RPA 响应不是合法 JSON' }
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, retryable: false, message: '实在智能 RPA 响应格式不正确' }
    }
    const root = parsed as Record<string, unknown>
    const code = root['code']
    if (code !== 0 && code !== '0') {
      const msg = root['msg']
      return {
        ok: false,
        retryable: false,
        message: '实在智能 RPA 触发失败：' + (typeof msg === 'string' ? msg : 'code=' + String(code)),
      }
    }
    const data = root['data']
    const record = typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {}
    return {
      ok: true,
      retryable: false,
      externalTaskId: pickWorkUuid(record),
      message: typeof root['msg'] === 'string' ? root['msg'] : undefined,
    }
  },
}
