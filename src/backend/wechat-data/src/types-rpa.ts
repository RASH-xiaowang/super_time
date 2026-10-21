/**
 * 多 RPA 厂商触发方式的**共享契约**（2026-10-21，方案见 `docs/RPA-VENDOR-TRIGGERS.md`）。
 *
 * 任务命中关键词后按 `triggerMethod` 投递：`webhook`（整条记录）或注册表里的某个 RPA 厂商。
 * 每个厂商由一份**可序列化描述符** `RpaVendorDescriptor` 描述：配置字段（UI 自动渲染）、
 * 鉴权方式、参数映射、请求模板、响应解析、完成通知能力、来源与风险。后端派发管道按描述符
 * 通用执行，**不认识任何具体厂商**；新增厂商只加一个描述符并注册，不改核心逻辑。
 *
 * 本文件进 `build:types` 的公开类型（渲染层只从这里取类型，不 import 后端实现）。
 */

/** 配置字段的控件类型（渲染层按此选择控件；后端按此做最小校验）。 */
export type RpaFieldType = 'text' | 'password' | 'number' | 'boolean' | 'select' | 'map'

/** `select` 字段的可选项。 */
export interface RpaFieldOption {
  value: string
  label: string
}

/**
 * 一个厂商配置字段（非敏感字段进 `triggerConfig`；`secret` 字段进 `triggerSecret`）。
 *
 * `required` 只约束**「标记已完善」**；保存待完善任务时允许留空（与现有 Webhook 口径一致）。
 */
export interface RpaField {
  /** 稳定键名，写入 `triggerConfig` / `triggerSecret`；同一描述符内唯一。 */
  key: string
  /** 表单显示名（中文）。 */
  label: string
  type: RpaFieldType
  required: boolean
  /** 凭据字段：只回「是否已配置」，永不回读原文。 */
  secret?: boolean
  /** 可访问名（E2E/SSR 依赖）；缺省 = `label`。 */
  ariaLabel?: string
  /** 示例值（渲染为 placeholder；必填字段必须有示例或默认值）。 */
  example?: string
  /** 新任务预填值；`map` 字段为 `{ room, content, at }`。 */
  defaultValue?: string | number | boolean | Record<string, string>
  options?: RpaFieldOption[]
  /** 字段下方的说明/限制（一句话）。 */
  help?: string
  /** 收进「高级」折叠区。 */
  advanced?: boolean
  /** 校验正则（字符串形式，前后端同源；只用于非空值）。 */
  pattern?: string
  /** 该字段参与任务行摘要（如 FlowId / 应用 UUID）。 */
  summary?: boolean
}

/** 触发参数容器的形态（各厂商对参数的包装方式不同）。 */
export type RpaParamStyle =
  | 'object'
  | 'nameValueArray'
  | 'nameValueTypeArray'
  | 'jsonStringObject'
  | 'formParams'

/** 厂商状态：`stable` = 官方契约可核对；`experimental` = 契约有缺失/待联调，UI 显示警告。 */
export type RpaVendorStatus = 'stable' | 'experimental'

/** 完成通知能力：callback（厂商回调）/ poll（只能轮询）/ none（受理即止）。 */
export type RpaCompletionMode = 'callback' | 'poll' | 'none'

/** 鉴权策略。`custom` 由厂商适配器内的 `signRequest` 钩子实现（如阿里云 RPC 签名）。 */
export type RpaAuthStrategy = 'header' | 'bearer' | 'token-exchange' | 'custom'

/** 先换 token 再调业务接口的声明式描述（影刀、UiPath OAuth 等）。 */
export interface RpaTokenExchange {
  method: 'GET' | 'POST'
  /** 模板：`${config.baseUrl}/...`。 */
  url: string
  query?: Record<string, string>
  /** 表单/JSON body 模板（按 `contentType` 发送）。 */
  body?: unknown
  contentType?: string
  /** 响应里取 token 的路径（点分，如 `data.accessToken`）。 */
  tokenPath: string
  /** 响应里取有效期（秒）的路径；缺省 = 固定 1 小时。 */
  expiresInPath?: string
  /** 请求头的值前缀（默认 `Bearer `）。 */
  headerPrefix?: string
}

/** 一种鉴权模式；`when` 用于按配置字段选择（如 UiPath PAT / OAuth 二选一）。 */
export interface RpaAuthMode {
  strategy: RpaAuthStrategy
  when?: { field: string; equals: string[] }
  /** 该模式需要的凭据字段（secret，进 `triggerSecret`）。 */
  fields: RpaField[]
  exchange?: RpaTokenExchange
  /** 文档用标识（自定义签名策略名，如 `aliyun-rpc-hmac-sha1`）。 */
  custom?: string
}

/** 三个语义参数位：会话名 / 触发文本 / 触发对象。 */
export type RpaSemantic = 'room' | 'content' | 'at'

/** 语义参数位 → 厂商参数名的映射目标（默认值来自这里，用户可在 `map` 字段覆盖）。 */
export interface RpaMappingTarget {
  semantic: RpaSemantic
  /** 默认的厂商参数名（如 `room_name`）。 */
  defaultKey: string
  /** 表单里这一项的中文名（缺省：会话名/触发文本/触发对象）。 */
  label?: string
}

/** 参数映射：`mapField` 指向一个 `type: 'map'` 的配置字段，值为 `{ room, content, at }`。 */
export interface RpaMapping {
  style: RpaParamStyle
  mapField: string
  targets: RpaMappingTarget[]
}

/** 出网主机声明：固定域名（exact）或后缀（suffix，如厂商子域）。 */
export interface RpaGovernanceHost {
  kind: 'exact' | 'suffix'
  value: string
}

/** 隐私/出网治理声明（守卫测试用它强制登记隐私声明与出网台账）。 */
export interface RpaGovernance {
  /** 是否把用户内容（触发文本）发出去；false 的厂商不会拿到 text。 */
  contentOutbound: boolean
  hosts: RpaGovernanceHost[]
  /** 允许用户填写私有化地址（来也/UiPath 私有化）；默认只允许声明的主机。 */
  allowCustomBaseUrl?: boolean
  /** `docs/PRIVACY.md` 里对应的章节（如 `G3`）。 */
  privacySection: string
}

/** 请求模板：占位符见 `docs/RPA-VENDOR-TRIGGERS.md` §4.4（config/secret/record/invocation/mapped）。 */
export interface RpaRequestTemplate {
  method: 'POST' | 'PUT'
  url: string
  headers?: Record<string, string>
  body?: unknown
  contentType?: string
}

/** 响应解析规则（HTTP 状态 + 业务码 + 外部任务 id）。 */
export interface RpaResponseSpec {
  okHttpStatus: number[]
  okPath?: string
  okValue?: string | number | boolean
  externalTaskIdPath?: string
  messagePath?: string
}

/** 重试策略。无幂等键的厂商必须在描述符里把 `maxAttempts` 设为 1。 */
export interface RpaRetrySpec {
  maxAttempts: number
  retryOn: Array<'network' | 'http-5xx' | 'http-429'>
}

/** 厂商触发能力与来源/风险（列表展示、文档与守卫共用）。 */
export interface RpaVendorDescriptor {
  /** 稳定 id，写入 `task_info.trigger_method`；永不复用。 */
  id: string
  name: string
  vendor: string
  /** 描述符版本：参数/协议变更必须 bump，用于提示旧任务复核。 */
  version: string
  /** 一句话说明（选择器下方）。 */
  summary: string
  status: RpaVendorStatus
  docs: {
    home: string
    triggerApi: string
    /** 参数核对时间（ISO date，如 `2026-10-21`）。 */
    lastVerifiedAt: string
    /** 官方页版本/更新时间（拿不到写「未标注」）。 */
    pageVersion?: string
  }
  capabilities: {
    direction: 'outbound' | 'inbound' | 'both'
    synchronous: boolean
    completion: RpaCompletionMode
    idempotency: 'vendor-key' | 'none'
    deployment: Array<'cloud' | 'onprem'>
  }
  /** 配置字段（UI 自动渲染）。 */
  fields: RpaField[]
  auth: { modes: RpaAuthMode[] }
  mapping: RpaMapping
  request: RpaRequestTemplate
  response: RpaResponseSpec
  retry: RpaRetrySpec
  governance: RpaGovernance
  /** 已知不稳定/缺失点（UI「厂商说明」与文档共用）。 */
  risks: string[]
  /** 补充说明（如「官方未公开 header 名，需联调确认」）。 */
  notes?: string[]
}

/** `listRpaVendors` 返回的厂商标目录（前端据此渲染触发方式选择器与动态表单）。 */
export interface RpaVendorCatalog {
  items: RpaVendorDescriptor[]
  registryVersion: string
}

/** 非敏感配置值（`map` 字段是字符串字典）。 */
export type RpaConfigValue = string | number | boolean | Record<string, string>

/** 任务的非敏感触发配置（键 = 描述符字段 key）。 */
export type RpaTriggerConfig = Record<string, RpaConfigValue>

/** 凭据配置：键 = secret 字段 key；空串语义 = 清空，缺省 = 保留旧值。 */
export type RpaTriggerSecretInput = Record<string, string>

/** 已保存凭据的「是否配置」快照（永不返回凭据原文）。 */
export type RpaTriggerSecretSet = Record<string, boolean>
