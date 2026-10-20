/**
 * 内容类检索工具（2026-10-16 新增）：朋友圈 / 收藏 / 文件 / 转账红包记录。
 *
 * ## 为什么拆成四个工具而不是一个「搜所有内容」
 *
 * 四个域的数据形状与用户意图都不同：
 *   · 朋友圈 —— 有作者、有发布时间、有配文；
 *   · 收藏 —— 有类型（文本/图片/链接/文件）、有收藏时间；
 *   · 文件 —— 有文件名、大小、md5；
 *   · 转账红包 —— 有金额、方向（收/付）。
 *
 * 合成一个工具会让模型拿到一堆形状混杂的结果，而它需要的是「这次该看哪一类」。
 * 拆开之后每个工具的返回形状是**同质的**，模型转述时不容易串。
 *
 * ## 实现复用
 *
 * 四个域的实现都在 `unified-search.ts`（全局搜索面板用的同一套），
 * 这里只做**工具包装**（参数校验 + 结果整形）。刻意不重写：
 * 重写一份必然与全局搜索的行为分叉，而「同一个词在两处搜出不同结果」是最难解释的 bug。
 *
 * @module query/tools/content-tools
 */
import { searchUnified } from '../unified-search.ts'
import { argInt, argString, type RetrievalTool, type ToolHit, type ToolResult } from './types.ts'

/** 把 `searchUnified` 的某个域投影成工具命中。 */
function toHits(rows: ReadonlyArray<Record<string, unknown>>, kind: 'moment' | 'favorite' | 'file' | 'record'): ToolHit[] {
  return rows.map((r, i) => {
    const s = (k: string): string => (typeof r[k] === 'string' ? String(r[k]) : '')
    const n = (k: string): number => (typeof r[k] === 'number' ? Number(r[k]) : 0)
    if (kind === 'moment') {
      return {
        key: `moment:${s('username')}:${String(n('local_id'))}`,
        name: s('name') || s('username'),
        time: s('time'),
        snippet: s('snippet') || s('text'),
        source: 'msg' as const,
      }
    }
    if (kind === 'favorite') {
      return {
        key: `fav:${String(n('id'))}`,
        name: `收藏 #${String(n('id'))}`,
        time: s('time'),
        snippet: s('snippet') || s('title'),
        source: 'msg' as const,
      }
    }
    if (kind === 'file') {
      return {
        key: `file:${s('fileName')}:${String(i)}`,
        name: s('fileName'),
        time: s('time'),
        snippet: n('size') > 0 ? `${(n('size') / 1024).toFixed(1)} KB` : s('md5'),
        source: 'msg' as const,
      }
    }
    return {
      key: `rec:${s('kind')}:${s('session')}:${String(i)}`,
      name: s('name'),
      time: s('time'),
      snippet: s('kind') === 'transfers' ? '转账' : '红包',
      source: 'msg' as const,
    }
  })
}

/** 朋友圈检索。 */
export const searchMomentsTool: RetrievalTool = {
  name: 'search_moments',
  category: 'content',
  description:
    '检索**朋友圈**（按配文内容）。适用于「谁发过关于 X 的朋友圈」「X 那条朋友圈是什么时候发的」。'
    + '注意：它查的是朋友圈，不是聊天记录。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索词' },
      limit: { type: 'number', description: '最多返回几条（默认 12，上限 12）' },
    },
    required: ['query'],
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const q = argString(args['query']).trim()
    if (!q) return { tool: 'search_moments', ok: false, error: '缺少 query', hits: [] }
    const limit = argInt(args['limit'], 12, 1, 12)
    try {
      const snap = searchUnified(ctx.decryptedDir, q, limit)
      const hits = toHits(snap.moments as unknown as Array<Record<string, unknown>>, 'moment')
      return { tool: 'search_moments', ok: true, hits, note: `「${q}」→ ${hits.length} 条朋友圈`, elapsedMs: Date.now() - started }
    } catch (e) {
      return { tool: 'search_moments', ok: false, error: (e as Error).message, hits: [] }
    }
  },
}

/** 收藏检索。 */
export const searchFavoritesTool: RetrievalTool = {
  name: 'search_favorites',
  category: 'content',
  description:
    '检索**微信收藏**（文本/图片/链接/文件）。适用于「我收藏过关于 X 的东西」「收藏里有没有 X」。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索词' },
      limit: { type: 'number', description: '最多返回几条（默认 12，上限 12）' },
    },
    required: ['query'],
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const q = argString(args['query']).trim()
    if (!q) return { tool: 'search_favorites', ok: false, error: '缺少 query', hits: [] }
    const limit = argInt(args['limit'], 12, 1, 12)
    try {
      const snap = searchUnified(ctx.decryptedDir, q, limit)
      const hits = toHits(snap.favorites as unknown as Array<Record<string, unknown>>, 'favorite')
      return { tool: 'search_favorites', ok: true, hits, note: `「${q}」→ ${hits.length} 条收藏`, elapsedMs: Date.now() - started }
    } catch (e) {
      return { tool: 'search_favorites', ok: false, error: (e as Error).message, hits: [] }
    }
  },
}

/** 文件检索。 */
export const searchFilesTool: RetrievalTool = {
  name: 'search_files',
  category: 'content',
  description:
    '检索聊天里收发过的**文件**（按文件名）。适用于「有没有发过 X 文件」「X 文件是什么时候发的」。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '文件名关键词' },
      limit: { type: 'number', description: '最多返回几条（默认 12，上限 12）' },
    },
    required: ['query'],
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const q = argString(args['query']).trim()
    if (!q) return { tool: 'search_files', ok: false, error: '缺少 query', hits: [] }
    const limit = argInt(args['limit'], 12, 1, 12)
    try {
      const snap = searchUnified(ctx.decryptedDir, q, limit)
      const hits = toHits(snap.files as unknown as Array<Record<string, unknown>>, 'file')
      return { tool: 'search_files', ok: true, hits, note: `「${q}」→ ${hits.length} 个文件`, elapsedMs: Date.now() - started }
    } catch (e) {
      return { tool: 'search_files', ok: false, error: (e as Error).message, hits: [] }
    }
  },
}

/** 转账红包记录检索。 */
export const searchRecordsTool: RetrievalTool = {
  name: 'search_records',
  category: 'content',
  description:
    '检索**转账与红包记录**（按对方名字或备注）。适用于「我给 X 转过多少钱」「X 给我发过红包吗」。'
    + '注意：它返回的是**记录条目**；问「一共多少笔」请用 aggregate_messages。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '对方名字 / 备注（留空 = 全部记录）' },
      limit: { type: 'number', description: '最多返回几条（默认 12，上限 12）' },
    },
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const q = argString(args['query']).trim()
    const limit = argInt(args['limit'], 12, 1, 12)
    try {
      const snap = searchUnified(ctx.decryptedDir, q, limit)
      const hits = toHits(snap.records as unknown as Array<Record<string, unknown>>, 'record')
      return { tool: 'search_records', ok: true, hits, note: `${hits.length} 条转账/红包记录`, elapsedMs: Date.now() - started }
    } catch (e) {
      return { tool: 'search_records', ok: false, error: (e as Error).message, hits: [] }
    }
  },
}

/** 内容类工具集。 */
export const CONTENT_TOOLS: readonly RetrievalTool[] = [
  searchMomentsTool,
  searchFavoritesTool,
  searchFilesTool,
  searchRecordsTool,
]
