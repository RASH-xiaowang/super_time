/**
 * WeChat data types, mirrored from the st_control wechat module. The gateway
 * reads st_control's decrypted SQLite and projects these shapes to the
 * browser Remote client.
 */



export type { ContactsPageOptions } from './query/contacts.ts'
export * from './types-chat.ts'
export * from './types-moments.ts'
export * from './types-insights.ts'
export * from './types-panels.ts'
export * from './types-ask-export.ts'
export * from './types-backup.ts'
export * from './types-kb.ts'
export * from './types-ops.ts'
export * from './types-analytics.ts'
export * from './types-calls.ts'
export * from './types-config.ts'
export * from './types-laya.ts'
export * from './types-retrieval.ts'
export * from './types-kb-wire.ts'
export * from './types-taskcenter.ts'

/**
 * 这些类型原先只住在实现模块里，前端不得不再镜像一份（`types.ts` 里的「待 H11/H12
 * 落地」旧账）。现在把它们收进共享契约，前端可以只 `export type` 转发，不再逐字段
 * 复制。`build:types` 会同步生成到 `lib/types`。
 */
export type { KbModelRole, ModelRef, KbModelSettings, ResolvedModel } from './query/kb/model-config.ts'
export type { KbEntitySummary } from './query/kb/extract.ts'
export type { KbVectorIndexStatus, KbVectorBuildResult } from './query/kb-vectors.ts'
export type { AnnualReview } from './query/annual-review.ts'
export type { RetrievalConfig } from './query/retrieval/config.ts'
export type { ChannelName, FeedbackRecord, IntentKind, RerankWeights } from './query/retrieval/types.ts'
