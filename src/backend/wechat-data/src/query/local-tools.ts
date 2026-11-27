/**
 * 「本地工具」清单的组装（2026-11-24）。
 *
 * ## 为什么从真源读，而不是写一张静态表
 *
 * 项目里能「被调用」的工具分布在四处，各自都已经有注册表：
 *   ① 问答检索工具 —— `query/tools/registry.ts#buildTools`
 *   ② AI 回复工具 —— `query/reply-tools/registry.ts#REPLY_TOOL_SCHEMAS`
 *   ③ 出网触发通道 —— `query/rpa/registry.ts#RPA_VENDORS`
 *   ④ 本机能力（语音转写 / OCR / 读图 / 索引 / 解密 / 导出 / 备份）—— 没有统一注册表，
 *      在本文件的 `LOCAL_CAPABILITIES` 里显式登记（每条都写了对应的 Remote 方法，
 *      便于核对是不是真的存在）。
 *
 * 前三处直接读注册表：新增一个工具，页面自动多一张卡；删掉一个就少一张。
 * 这也是「文档/界面/runtime 三处不会各说一套」的唯一做法。
 *
 * ## 状态只标「可判定的」
 *
 * 回复工具的温度/搜索确实有配置项，所以能如实标 `needs-config` 并写清缺什么；
 * 本机能力的就绪与否取决于运行环境（微信是否安装、模型是否下载），这里不猜 ——
 * 一律 `ready`，把前置条件写在 `statusNote` 里由用户自己核对。
 *
 * @module query/local-tools
 */
import { buildTools } from './tools/registry.ts'
import { REPLY_TOOL_SCHEMAS } from './reply-tools/registry.ts'
import { listVendorDescriptors } from './rpa/registry.ts'
import { readReplyToolsConfig } from '../config/wechat-config.ts'
import { readToolConfig, type ToolOverrideRecord } from './tool-config-store.ts'
import { customItem } from './custom-tools.ts'
import type { ReplyToolsConfig } from './reply-tools/types.ts'
import type {
  LocalToolGroup,
  LocalToolItem,
  LocalToolParam,
  LocalToolsSnapshot,
} from '../types-local-tools.ts'

/** 分组元信息（顺序 = 页面顺序）。 */
const GROUPS: readonly LocalToolGroup[] = [
  { id: 'retrieval', label: '微信数据检索', note: '问答链路按问题自动挑选；直接读本机解密库，不出网。' },
  { id: 'reply', label: 'AI 回复', note: '回复生成时可被模型调用；只读、只处理目标消息里的公共信息。' },
  { id: 'rpa', label: '出网触发', note: '任务命中关键词后把记录发到这些通道；地址与凭据在任务里配置。' },
  { id: 'local', label: '本机能力', note: '本机数据处理能力，不走工具调用协议，由界面按钮或内部流程触发。' },
]

/** 检索工具的中文名（unknown 回退到模型调用名）。 */
const RETRIEVAL_LABELS: Readonly<Record<string, string>> = {
  search_messages: '消息关键词检索',
  search_semantic: '语义检索（向量）',
  search_hybrid: '混合检索',
  aggregate_messages: '消息聚合统计',
  list_sessions: '会话列表',
  get_session_messages: '会话消息列表',
  get_message_context: '消息上下文展开',
  search_contacts: '联系人搜索',
  get_contact_detail: '联系人详情',
  get_social_summary: '社交圈摘要',
  search_moments: '朋友圈检索',
  search_favorites: '收藏检索',
  search_files: '文件检索',
  search_records: '转账红包记录检索',
  search_kb: '知识库检索',
  get_funds_summary: '资金往来汇总',
  get_call_history: '通话记录',
  get_group_detail: '群聊详情',
  search_revoked: '撤回消息检索',
  aggregate_media: '媒体聚合统计',
  get_moments_stats: '朋友圈统计',
}

/** 检索工具的源文件（与 `query/tools/registry.ts` 的装配顺序同源）。 */
const RETRIEVAL_SOURCES: Readonly<Record<string, string>> = {
  get_funds_summary: 'src/backend/wechat-data/src/query/tools/funds-tools.ts',
  get_call_history: 'src/backend/wechat-data/src/query/tools/calls-tools.ts',
  get_group_detail: 'src/backend/wechat-data/src/query/tools/group-tools.ts',
  search_moments: 'src/backend/wechat-data/src/query/tools/moments-tools.ts',
  get_moments_stats: 'src/backend/wechat-data/src/query/tools/moments-tools.ts',
  search_revoked: 'src/backend/wechat-data/src/query/tools/revoke-tools.ts',
  aggregate_media: 'src/backend/wechat-data/src/query/tools/media-tools.ts',
  search_messages: 'src/backend/wechat-data/src/query/tools/message-tools.ts',
  list_sessions: 'src/backend/wechat-data/src/query/tools/message-tools.ts',
  get_session_messages: 'src/backend/wechat-data/src/query/tools/message-tools.ts',
  get_message_context: 'src/backend/wechat-data/src/query/tools/message-tools.ts',
  aggregate_messages: 'src/backend/wechat-data/src/query/tools/aggregate-tools.ts',
  search_contacts: 'src/backend/wechat-data/src/query/tools/contact-tools.ts',
  get_contact_detail: 'src/backend/wechat-data/src/query/tools/contact-tools.ts',
  get_social_summary: 'src/backend/wechat-data/src/query/tools/social-tools.ts',
  search_favorites: 'src/backend/wechat-data/src/query/tools/content-tools.ts',
  search_files: 'src/backend/wechat-data/src/query/tools/content-tools.ts',
  search_records: 'src/backend/wechat-data/src/query/tools/content-tools.ts',
  search_kb: 'src/backend/wechat-data/src/query/tools/kb-tools.ts',
  search_semantic: 'src/backend/wechat-data/src/query/tools/kb-tools.ts',
  search_hybrid: 'src/backend/wechat-data/src/query/tools/search-hybrid-tool.ts',
}

/** 检索工具分类的中文名。 */
const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  message: '消息',
  aggregate: '聚合',
  contact: '联系人',
  content: '内容',
  kb: '知识库',
}

/** 回复工具的中文名与出网属性。 */
const REPLY_META: Readonly<Record<string, { label: string; summary: string; online: boolean }>> = {
  weather: { label: '天气查询', summary: '查目标消息里那座城市的当前天气或未来 7 天预报。', online: true },
  search_web: { label: '网页搜索', summary: '只用目标消息里的公共关键词搜索公开网页。', online: true },
  current_datetime: { label: '日期时间', summary: '当前日期、星期、时区，或相对今天偏移若干天。', online: false },
  resolve_date: { label: '相对日期', summary: '把消息里的今天、明天、下周几换成具体日期和星期。', online: false },
  calculate: { label: '计算器', summary: '四则运算、括号与百分比（不执行代码）。', online: false },
  convert_units: { label: '单位换算', summary: '长度、质量、温度、速度、时长白名单换算。', online: false },
  read_public_url: { label: '读取公开网页', summary: '读取目标消息里显式给出的公开 HTTPS 链接正文。', online: true },
}

/** 本机能力登记（每条都对应真实存在的 Remote / 内部流程）。 */
interface LocalCapability {
  id: string
  name: string
  summary: string
  callName?: string
  source: string
  statusNote?: string
  online?: boolean
}

const LOCAL_CAPABILITIES: readonly LocalCapability[] = [
  {
    id: 'voice-transcribe', name: '语音转写',
    summary: '把语音消息转成文字；本机 Whisper 模型，转写结果可回填到聊天界面。',
    callName: 'transcribeVoiceMessage', statusNote: '首次使用需下载语音模型。',
    source: 'src/backend/wechat-data/src/query/voice-transcribe.ts',
  },
  {
    id: 'ocr-image', name: '图片文字识别',
    summary: '用微信自带的 OCR 识别聊天图片里的文字，适合截图、票据与名片。',
    callName: 'ocrImage', statusNote: '依赖本机已安装并可用的微信。',
    source: 'src/backend/wechat-ocr.js',
  },
  {
    id: 'image-ai', name: '图片理解',
    summary: '把聊天图片交给所配置的多模态模型，回答「这张图是什么」。',
    callName: 'imageAiJson', statusNote: '需先配置可用的多模态模型。', online: true,
    source: 'src/backend/wechat-image-ai.js',
  },
  {
    id: 'search-index', name: '全文检索索引',
    summary: '为全部消息分片建立本地检索索引，问答与搜索命中都基于它。',
    callName: 'buildSearchIndex', statusNote: '索引缺失或过期时由后台自动重建。',
    source: 'src/backend/wechat-data/src/query/search-build.ts',
  },
  {
    id: 'decrypt-images', name: '图片批量解密',
    summary: '把加密的图片缓存批量解密到 decoded_images，供界面与导出直接读取。',
    callName: 'decryptAllImages',
    source: 'src/backend/wechat-data/src/query/media-image.ts',
  },
  {
    id: 'decrypt-databases', name: '数据库解密',
    summary: '用本机密钥解密微信数据库，是所有只读面板的数据来源。',
    callName: 'decryptAllDatabases', statusNote: '需要可用的数据库密钥。',
    source: 'src/backend/wechat-data/src/query/decrypt.ts',
  },
  {
    id: 'export-session', name: '聊天记录导出',
    summary: '把会话导出成 HTML / JSON / CSV，可选时间范围与消息类型。',
    callName: 'exportSessionMessages',
    source: 'src/backend/wechat-data/src/query/export-flows.ts',
  },
  {
    id: 'export-assets', name: '资产清单导出',
    summary: '导出收藏、朋友圈与年度报告的清单文件（不含媒体本体）。',
    callName: 'exportCsv',
    source: 'src/backend/wechat-data/src/query/export-*.ts',
  },
  {
    id: 'backup', name: '备份与恢复',
    summary: '把解密库与媒体打包成可迁移备份，支持加密备份与校验预览。',
    callName: 'createBackup',
    source: 'src/backend/wechat-data/src/query/backup.ts',
  },
  {
    id: 'rpa-media', name: '局域网图片直链',
    summary: '给出网通道签一个短时图片链接，让机器人自己来本机取图。',
    callName: '/api/rpa-media', statusNote: '需打开局域网访问。', online: true,
    source: 'src/backend/rpa-media.js',
  },
]

/**
 * 从 JSON Schema 提取参数摘要。
 * @param parameters - 工具的 `parameters`（JSON Schema 对象）。
 * @returns 参数列表（保持 schema 里的声明顺序）；没有 properties 时为空数组。
 */
export function paramSummaries(parameters: Record<string, unknown> | undefined): LocalToolParam[] {
  const props = parameters?.['properties']
  if (typeof props !== 'object' || props === null || Array.isArray(props)) return []
  const rawRequired = parameters?.['required']
  const required = new Set(
    Array.isArray(rawRequired) ? rawRequired.filter((item): item is string => typeof item === 'string') : [],
  )
  const out: LocalToolParam[] = []
  for (const [name, rule] of Object.entries(props as Record<string, unknown>)) {
    const spec = (typeof rule === 'object' && rule !== null ? rule : {}) as Record<string, unknown>
    const type = typeof spec['type'] === 'string' ? spec['type'] : 'any'
    const note = paramNote(spec)
    out.push(note === '' ? { name, required: required.has(name), type } : { name, required: required.has(name), type, note })
  }
  return out
}

/** 参数的取值约束短说明（枚举 > 范围 > 长度）。 */
function paramNote(spec: Record<string, unknown>): string {
  const enumValues = Array.isArray(spec['enum']) ? spec['enum'].map((item) => String(item)) : []
  if (enumValues.length > 0) return enumValues.slice(0, 8).join(' / ')
  const min = typeof spec['minimum'] === 'number' ? spec['minimum'] : undefined
  const max = typeof spec['maximum'] === 'number' ? spec['maximum'] : undefined
  if (min !== undefined || max !== undefined) return `${min ?? '−∞'} ~ ${max ?? '∞'}`
  const maxLength = typeof spec['maxLength'] === 'number' ? spec['maxLength'] : undefined
  if (maxLength !== undefined) return `≤ ${maxLength} 字`
  return ''
}

/** 内置工具的覆盖（标题/说明/启停）—— 缺省视为「未覆盖且启用」。 */
function overrideOf(overrides: ReadonlyMap<string, ToolOverrideRecord>, name: string): ToolOverrideRecord {
  return overrides.get(name) ?? { title: '', description: '', enabled: true }
}

/** 问答检索工具（读注册表 + 覆盖表）。 */
function retrievalItems(overrides: ReadonlyMap<string, ToolOverrideRecord>): LocalToolItem[] {
  return buildTools().map((tool) => {
    const patch = overrideOf(overrides, tool.name)
    const label = patch.title.trim() !== '' ? patch.title.trim() : (RETRIEVAL_LABELS[tool.name] ?? tool.name)
    return {
      id: `retrieval:${tool.name}`,
      group: 'retrieval',
      name: label,
      callName: tool.name,
      summary: `${CATEGORY_LABELS[tool.category] ?? tool.category}类工具`,
      description: patch.description.trim() !== '' ? patch.description.trim() : tool.description,
      params: paramSummaries(tool.parameters),
      // 语义检索没有注入向量模型时**工具仍在**，执行时如实返回未配置 —— 界面照实标注。
      ...(tool.name === 'search_semantic'
        ? { status: 'needs-config' as const, statusNote: '需要配置向量模型；未配置时会如实返回「未配置」。' }
        : { status: 'ready' as const }),
      ...(patch.enabled ? {} : { statusNote: '已停用：不会出现在任何链路的工具集里。' }),
      source: RETRIEVAL_SOURCES[tool.name] ?? 'src/backend/wechat-data/src/query/tools/registry.ts',
      online: false,
      builtin: true,
      kind: 'builtin' as const,
      participation: ['ask' as const],
      enabled: patch.enabled,
    }
  })
}

/** 回复工具的就绪状态（按已保存的配置判定）。 */
function replyStatus(name: string, cfg: ReplyToolsConfig): { status: 'ready' | 'needs-config'; note?: string } {
  if (name === 'weather') {
    if (cfg.weatherProvider !== 'open-meteo') {
      return { status: 'needs-config', note: '未选择天气数据源：点本卡「配置」选 Open-Meteo。' }
    }
    if (cfg.weatherAccess !== 'noncommercial' && cfg.weatherAccess !== 'commercial') {
      return { status: 'needs-config', note: '未选择天气使用方式（非商用 / 商用）：点本卡「配置」选择。' }
    }
    if (cfg.weatherAccess === 'commercial' && cfg.weatherApiKey === '') {
      return { status: 'needs-config', note: '商用模式需要 Open-Meteo API Key：点本卡「配置」填写。' }
    }
    return { status: 'ready' }
  }
  if (name === 'search_web') {
    if (cfg.searchProvider !== 'brave') {
      return { status: 'needs-config', note: '未选择搜索服务：点本卡「配置」选 Brave Search。' }
    }
    if (cfg.searchApiKey === '') {
      return { status: 'needs-config', note: '缺少 Brave API Key：点本卡「配置」填写。' }
    }
    return { status: 'ready' }
  }
  return { status: 'ready' }
}

/** AI 回复工具（读注册表 + 已保存配置 + 覆盖表）。 */
function replyItems(decryptedDir: string, overrides: ReadonlyMap<string, ToolOverrideRecord>): LocalToolItem[] {
  const cfg = readReplyToolsConfig(decryptedDir)
  return REPLY_TOOL_SCHEMAS.map((schema) => {
    const meta = REPLY_META[schema.name] ?? { label: schema.name, summary: '', online: false }
    const status = replyStatus(schema.name, cfg)
    const patch = overrideOf(overrides, schema.name)
    return {
      id: `reply:${schema.name}`,
      group: 'reply' as const,
      name: patch.title.trim() !== '' ? patch.title.trim() : meta.label,
      callName: schema.name,
      summary: meta.summary,
      description: patch.description.trim() !== '' ? patch.description.trim() : schema.description,
      params: paramSummaries(schema.parameters),
      status: status.status,
      ...(status.note === undefined ? {} : { statusNote: status.note }),
      ...(patch.enabled ? {} : { statusNote: '已停用：回复时不会把这个工具交给模型。' }),
      source: 'src/backend/wechat-data/src/query/reply-tools/registry.ts',
      online: meta.online,
      builtin: true,
      kind: 'builtin' as const,
      participation: ['reply' as const],
      enabled: patch.enabled,
    }
  })
}

/** 出网触发通道（读厂商注册表）。 */
function rpaItems(): LocalToolItem[] {
  return listVendorDescriptors().map((descriptor) => ({
    id: `rpa:${descriptor.id}`,
    group: 'rpa' as const,
    name: descriptor.name,
    callName: descriptor.id,
    summary: `${descriptor.vendor} · 协议 v${descriptor.version}`,
    description: descriptor.summary,
    params: descriptor.fields.map((field) => ({
      name: field.label,
      required: field.required,
      type: field.type,
      ...(field.secret === true ? { note: '凭据（只存本机）' } : (field.help === undefined ? {} : { note: field.help })),
    })),
    status: 'ready' as const,
    statusNote: '需在任务信息里填写地址与凭据后才会投递。',
    source: 'src/backend/wechat-data/src/query/rpa/registry.ts',
    online: true,
    builtin: true,
    kind: 'builtin' as const,
    participation: ['rpa' as const],
    enabled: true,
  }))
}

/** 本机能力（静态登记）。 */
function localItems(): LocalToolItem[] {
  return LOCAL_CAPABILITIES.map((cap) => ({
    id: `local:${cap.id}`,
    group: 'local' as const,
    name: cap.name,
    ...(cap.callName === undefined ? {} : { callName: cap.callName }),
    summary: cap.summary,
    description: cap.summary,
    params: [],
    status: 'ready' as const,
    ...(cap.statusNote === undefined ? {} : { statusNote: cap.statusNote }),
    source: cap.source,
    online: cap.online === true,
    builtin: true,
    kind: 'builtin' as const,
    participation: ['local' as const],
    enabled: true,
  }))
}

/**
 * 组装「本地工具」快照。
 *
 * 每次调用都**现读**注册表与覆盖表：工具页的增删改、以及问答链路读到的工具集，
 * 用的是同一份数据 —— 所以「前端改完立即生效」不需要任何额外的缓存失效协议。
 * 自定义工具排在检索组之后（它们天然属于「问答工具」这一族）。
 * @param decryptedDir - 解密数据根（回复工具的就绪状态与工具配置都读它）。
 * @returns 四组工具 + 自定义工具 + 分组元信息。
 */
export function queryLocalTools(decryptedDir: string): LocalToolsSnapshot {
  const config = readToolConfig(decryptedDir)
  const custom = config.custom.map(customItem)
  return {
    items: [
      ...retrievalItems(config.overrides),
      ...custom,
      ...replyItems(decryptedDir, config.overrides),
      ...rpaItems(),
      ...localItems(),
    ],
    groups: [...GROUPS],
    updatedAt: Math.floor(Date.now() / 1000),
  }
}
