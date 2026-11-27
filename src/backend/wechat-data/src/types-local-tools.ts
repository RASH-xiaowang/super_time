/**
 * 「本地工具」页的契约（2026-11-24）。
 *
 * 这个页面**不自己维护一份工具名单**：清单来自各工具的真源（问答检索注册表、
 * AI 回复工具 schema、RPA 厂商注册表、本机能力登记），所以新增一个工具后界面自动出现，
 * 不会出现「文档里有、界面没有」的漂移。这里只定义投影后的展示形状。
 */

/** 工具分组（页面上的四段）。 */
export type LocalToolGroupId = 'retrieval' | 'reply' | 'rpa' | 'local'

/**
 * 工具当前是否可用。
 *
 * 只有**可判定**的才标 `needs-config`（例如回复工具缺天气/搜索配置）；
 * 本机能力一律 `ready`，前置条件写在 `statusNote` 里 —— 不猜、也不假装就绪。
 */
export type LocalToolStatus = 'ready' | 'needs-config'

/** 一个工具参数的展示摘要。 */
export interface LocalToolParam {
  name: string
  required: boolean
  /** JSON Schema 的 type（`string` / `number` / `integer` / `boolean` / `object`…）。 */
  type: string
  /** 取值约束的短说明（枚举值、长度/数值范围、单位白名单等）。 */
  note?: string
}

/**
 * 工具的来源与参与面（2026-11-24 起工具可在前端增删）。
 *
 * 设计要点：
 *  · **默认工具来自代码**（注册表里各工具的 `run`），所以不可删、也不可改执行逻辑；
 *    可改的只有「启停」，以及说明文字（覆盖表）。
 *  · **自定义工具是数据**：只有两种**不需要写代码**的执行方式 ——
 *    `alias`（把某个内置工具包一层，固定若干参数）与 `answer`（返回一段固定文本）。
 *    它们之所以能真被调用，是因为执行体由这两个模板生成，而不是凭空多出一段 SQL。
 *  · `participation` 说明这个工具会出现在哪条链路里 —— 界面照实标，不夸大。
 */
export type LocalToolKind = 'builtin' | 'alias' | 'answer'

/** 工具参与哪条链路（用于卡片标注与筛选）。 */
export type LocalToolSurface = 'ask' | 'reply' | 'rpa' | 'local'

/**
 * `alias` 固定住的参数值。
 *
 * 允许四种（不是「统一成字符串」）：目标工具的 schema 里 `boolean` 是严格比较
 * `=== true`、`array` 是 `Array.isArray` 才认 —— 把 `"true"` 当字符串传过去会被
 * **静默当成 false / 空数组**，界面上看不出任何异常，预设却根本没生效。
 */
export type LocalToolFixedValue = string | number | boolean | readonly string[]

/** 一个工具卡片。 */
export interface LocalToolItem {
  /** 稳定键（`<group>:<name>`）。 */
  id: string
  group: LocalToolGroupId
  /** 面向用户的名字（中文）。 */
  name: string
  /** 模型/接口里的调用名（`search_messages`、`weather`、`webhook`…）。 */
  callName?: string
  /** 一句话说明。 */
  summary: string
  /** 完整说明（模型的 description 原文；可能是长句）。 */
  description: string
  params: LocalToolParam[]
  status: LocalToolStatus
  /** 状态说明（缺什么配置 / 前置条件）。 */
  statusNote?: string
  /** 定义它的源文件（相对仓库根），便于排查。 */
  source: string
  /** 这次调用会不会访问网络。 */
  online: boolean
  /** 是否来自代码注册表（true = 不可删除，只能启停）。 */
  builtin: boolean
  /** 执行方式。 */
  kind?: LocalToolKind
  /** 参与哪几条链路。 */
  participation?: LocalToolSurface[]
  /** 当前是否启用（禁用后不计入任何链路的工具集）。 */
  enabled: boolean
  /** `alias` 封装的目标工具调用名（自定义工具才有）。 */
  target?: string
  /** `answer` 的固定文本（自定义工具才有）。 */
  answer?: string
  /** `alias` 固定住的参数（自定义工具才有）。 */
  fixed?: Record<string, LocalToolFixedValue>
}

/** 新增/编辑自定义工具的入参（Remote 边界，字段必须按不可信输入处理）。 */
export interface LocalToolInput {
  /** 更新时必填（自定义工具的唯一键）；新增时也要填（模型按它调用）。 */
  name?: string
  title: string
  description: string
  kind: 'alias' | 'answer'
  enabled?: boolean
  /**
   * `true` = 这是一次**新建**。
   *
   * 界面上「新建」与「编辑」共用同一个抽屉，两者都不带 id；没有这个标记时，
   * 用一个已存在的名字新建会**静默覆盖**旧工具（用户以为建了第二个，其实改掉了第一个）。
   * 带上之后，`isNew` + 名字已存在 ⇒ 明确拒绝并提示改名。
   */
  isNew?: boolean
  /** `alias`：被封装的内置工具调用名（必须存在且已启用）。 */
  target?: string
  /** `alias`：固定参数（键必须在目标工具的参数 schema 里；值按 schema 类型转换）。 */
  fixed?: Record<string, LocalToolFixedValue>
  /** `answer`：固定返回的文本（≤2000 字）。 */
  answer?: string
  /** `alias`：额外暴露给模型的参数名（缺省 = 目标工具里除固定参数外的全部）。 */
  expose?: string[]
}

/** 工具写入结果。 */
export interface LocalToolSaveResult {
  ok: boolean
  /** 保存后的卡片（保存成功时回带，界面直接替换即可）。 */
  item?: LocalToolItem
  error?: string
}

/** 工具删除/启停结果。 */
export interface LocalToolMutationResult {
  ok: boolean
  error?: string
}

/** 一项可选项（表单下拉用；由后端给出，前端不硬编码）。 */
export interface LocalToolConfigOption {
  value: string
  label: string
  /** 补充说明（例如「需要 API Key」「非商用免费」）。 */
  hint?: string
}

/**
 * 「AI 回复工具」的配置快照（2026-11-24）。
 *
 * 只回**是否已保存**密钥，永不回读原文 —— 与任务中心凭据同一口径：
 * 一旦能把密钥读回界面，它就会出现在截图、日志与剪贴板里。
 */
export interface LocalToolConfig {
  weather: {
    provider: string
    access: string
    apiKeySaved: boolean
  }
  search: {
    provider: string
    apiKeySaved: boolean
  }
  /** 天气数据源可选项（当前只有 open-meteo）。 */
  weatherProviders: LocalToolConfigOption[]
  /** 天气使用方式（非商用 / 商用）。 */
  weatherAccessModes: LocalToolConfigOption[]
  /** 网页搜索服务可选项（当前只有 Brave）。 */
  searchProviders: LocalToolConfigOption[]
}

/**
 * 保存配置的入参（Remote 边界，字段都按不可信输入处理）。
 *
 * `*ApiKey` **缺省 = 保持不变**（界面不回显原文，所以「没改」必须能与「清空」区分开；
 * 目前不支持清空，只支持替换 —— 与其它密钥字段一致）。
 */
export interface LocalToolConfigInput {
  weatherProvider?: string
  weatherAccess?: string
  weatherApiKey?: string
  searchProvider?: string
  searchApiKey?: string
}

/** 保存配置的结果（成功时回带新快照，界面直接替换）。 */
export interface LocalToolConfigSaveResult {
  ok: boolean
  config?: LocalToolConfig
  error?: string
}

/** 分组元信息（顺序即页面顺序）。 */
export interface LocalToolGroup {
  id: LocalToolGroupId
  label: string
  note: string
}

/** 本地工具快照。 */
export interface LocalToolsSnapshot {
  items: LocalToolItem[]
  groups: LocalToolGroup[]
  updatedAt: number
}
