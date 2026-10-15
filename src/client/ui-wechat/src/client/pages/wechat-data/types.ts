/**
 * WeChat data panel 的本地类型面。
 *
 * 后端类型已经由 `build:types` 生成到 `@deepseek-ai/dsh-wechat-data/types`
 * （H11/H12 落地后的共享契约）。因此这里**只保留前端专属形状**；后端形状一律转发，
 * 不再逐字段复制一份「镜像类型」。
 */
export type {
  WechatSession, WechatMessage, WechatContact, ContactBook,
  SessionsSnapshot, MessagesSnapshot, ContactsSnapshot,
} from '@deepseek-ai/dsh-wechat-data/types'

export type {
  KnowledgeNote, NotesSnapshot, NoteMutationResult, KnowledgeSnapshot,
  KbMeta, KbListSnapshot, KbDeleteAction, KbMutationResult,
  KbFileParseState, KbFileMeta, KbFileListSnapshot, KbSummaryResult,
  KbFileChunk, KbFileChunkPage, KbFileRegisterResult, KbFileMutationResult,
  KbFileAddResult, KbChannelName, KbHit, KbSearchStats, KbSearchResult,
} from '@deepseek-ai/dsh-wechat-data/types'

export type {
  KbModelRole, ModelRef, KbModelSettings, ResolvedModel,
  KbEntitySummary, KbVectorIndexStatus, KbVectorBuildResult as KbVectorBuildPayload,
  KbExtractResult, KbLinkSuggestion, KbLinkSuggestResult, KbModelConfigResult,
  KbModelConfigView, KbVectorBuildWireResult as KbVectorBuildResult, KbVectorIndexView,
} from '@deepseek-ai/dsh-wechat-data/types'

// `export type { … }` 只重新导出、不把名字带进本模块作用域；后面的本地形状还要引用它们。
import type {
  ModelRef, ResolvedModel,
} from '@deepseek-ai/dsh-wechat-data/types'

/** Monitor status (kept local; not yet in the host vocabulary). */
export interface MonitorStatus {
  running: boolean
  status: string
  [key: string]: unknown
}

/**
 * 可添加的文件类型（**镜像**后端 `query/kb/types.ts` 的 `ACCEPTED_EXTS`）。
 *
 * 只用于 `dialog:open-file` 的 `filters`（让用户在选择时看不到不支持的类型），
 * **不是**接纳判据 —— 真正的判据在后端 `isAcceptedExt()`，选进来的东西一律
 * 逐项回执（`not-accepted` 会明说原因）。
 *
 * ⚠️ 改动这里必须同步后端；`kb-files.wiring.spec.ts` 会逐个集合比对，漂了就红。
 */
export const KB_ACCEPTED_EXTS: readonly string[] = [
  // A 档：文本族
  'txt', 'md', 'markdown', 'markdn', 'text', 'log', 'csv', 'tsv',
  'json', 'jsonl', 'ndjson', 'yaml', 'yml', 'xml', 'srt', 'vtt', 'ini', 'conf',
  // A' 档：HTML
  'html', 'htm', 'xhtml',
  // B 档：等解析器接入
  'pdf', 'docx', 'xlsx', 'xls',
  // C 档：只登记元数据
  'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff',
]

/** 前端沿用的模型引用串别名；后端契约名为 `ModelRef`。 */
export type KbModelRef = ModelRef

/** 前端沿用的模型解析结果别名；后端契约名为 `ResolvedModel`。 */
export type KbResolvedModel = ResolvedModel

// KB Remote wire 类型全部由共享包转发（见文件顶部 import/export）。
