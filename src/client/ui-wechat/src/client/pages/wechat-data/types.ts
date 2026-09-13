/**
 * WeChat data types — re-exported from the host WechatDataGateway package so
 * the browser panels and the Remote client share one vocabulary.
 */
export type {
  WechatSession, WechatMessage, WechatContact, ContactBook,
  SessionsSnapshot, MessagesSnapshot, ContactsSnapshot,
} from '@deepseek-ai/dsh-wechat-data/types'

/** Monitor status (kept local; not yet in the host vocabulary). */
export interface MonitorStatus {
  running: boolean
  status: string
  [key: string]: unknown
}

// ── 知识笔记 / 知识图谱 ───────────────────────────────────────────────
// 契约的权威定义在 src/backend/wechat-data/src/types.ts。这里**刻意再声明一份**而不是
// 从 @deepseek-ai/dsh-wechat-data/types 引入：前端解析到的是 node_modules 里那份
// 手工维护的旧副本（非符号链接），它落后于后端源码，已经不匹配（api.ts 里记录过 48 条
// 类型错误）。把新类型挂到那份副本上只会把 H12/M17 的问题摊得更大。
// 待 H11/H12 落地（类型可从源码生成、同步自动化）后，这几条应迁回共享契约。

/** One knowledge note: manual entry, or distilled from an AI answer. */
export interface KnowledgeNote {
  id: number
  title: string
  /** Body text; `[[target]]` / `[[target|display]]` are wiki links. */
  body: string
  tags: string[]
  sourceKind: 'manual' | 'ask'
  sourceUsername?: string
  sourceQuestion?: string
  /** Distinct `[[target]]` values found in the body. */
  links: string[]
  createdAt: number
  updatedAt: number
}

/** Note list snapshot. */
export interface NotesSnapshot {
  items: KnowledgeNote[]
  total: number
}

/** Note mutation result (save/delete). */
export interface NoteMutationResult {
  ok: boolean
  id?: number
  error?: string
}

/**
 * Knowledge graph snapshot.
 *
 * Node ids are namespaced: `note:<id>` for notes, `kb:<normalized target>` for
 * stubs — so they never collide with social-graph ids (usernames / `self`).
 */
export interface KnowledgeSnapshot {
  notes: Array<{
    id: number
    title: string
    excerpt: string
    tags: string[]
    sourceKind: 'manual' | 'ask'
    sourceUsername?: string
    sourceQuestion?: string
    createdAt: number
    updatedAt: number
    /** Distinct outgoing wiki links (stubs included). */
    outLinks: number
    /** Incoming wiki links. */
    backLinks: number
  }>
  /** `[[target]]` values matching no note — rendered as dashed stub nodes. */
  stubs: Array<{ key: string; label: string; refCount: number; referencedBy: number[] }>
  edges: Array<{ source: string; target: string; weight: number; kind: 'wiki' | 'stub' }>
  /** Source-chat usernames → display names (fused-view labels). */
  sessionNames: Record<string, string>
  summary: {
    noteCount: number
    linkCount: number
    stubCount: number
    orphanCount: number
    askCount: number
    manualCount: number
  }
}
