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
import { fmtBytes } from '../../format.ts'
import { searchUnified } from '../unified-search.ts'
import type { UnifiedSearchDomainError, UnifiedSearchSnapshot } from '../../types.ts'
import {
  argInt, argString,
  type RetrievalTool, type ToolContext, type ToolHit, type ToolResult,
} from './types.ts'

type ResourceDomain = 'moments' | 'favorites' | 'files' | 'records'

/** 读取模型参数与服务端锁定范围；服务端范围优先。 */
function contentScope(args: Record<string, unknown>, ctx: ToolContext): {
  from?: string
  to?: string
  username?: string
} {
  const from = ctx.scope?.from?.trim() || argString(args['from']).trim()
  const to = ctx.scope?.to?.trim() || argString(args['to']).trim()
  const username = ctx.scope?.username?.trim() || argString(args['username']).trim()
  return {
    ...(from !== '' ? { from } : {}),
    ...(to !== '' ? { to } : {}),
    ...(username !== '' ? { username } : {}),
  }
}

/**
 * 某个资源域的失败。
 *
 * 日期/会话范围无法执行时返回 `unsupported_scope`；库/表读不动时返回
 * `upstream_failure`。两者都不能被当作「没有结果」。
 */
function domainFailure(
  result: ToolResult['tool'],
  domain: ResourceDomain,
  snap: UnifiedSearchSnapshot,
): ToolResult | undefined {
  const failure: UnifiedSearchDomainError | undefined = snap.domainErrors?.[domain]
  if (!failure) return undefined
  return {
    tool: result,
    ok: false,
    error: failure.message,
    errorCode: failure.code === 'unsupported_scope' ? 'unsupported_scope' : 'upstream_failure',
    errorDetails: { domain, code: failure.code },
    hits: [],
  }
}

/** 部分命中时把域异常附在 note 上，便于证据层与用户知道结果不完整。 */
function degradedNote(snap: UnifiedSearchSnapshot, domain: ResourceDomain): string {
  const failure = snap.domainErrors?.[domain]
  return failure ? `；${failure.message}（结果可能不完整）` : ''
}

/** 把 `searchUnified` 的某个域投影成工具命中。 */
function toHits(rows: ReadonlyArray<Record<string, unknown>>, kind: 'moment' | 'favorite' | 'file' | 'record'): ToolHit[] {
  return rows.map((r, i) => {
    const s = (k: string): string => (typeof r[k] === 'string' ? String(r[k]) : '')
    const n = (k: string): number => (typeof r[k] === 'number' ? Number(r[k]) : 0)
    if (kind === 'moment') {
      const username = s('username')
      const timelineId = s('tid')
      const fallbackId = s('time') || s('snippet').slice(0, 40) || String(i)
      const key = `moment:${username}:${timelineId || fallbackId}`
      return {
        key,
        name: s('name') || '朋友圈',
        time: s('time'),
        snippet: s('snippet') || s('text'),
        source: 'resource' as const,
        trace: {
          kind: 'resource' as const,
          resource: {
            resourceKind: 'moment' as const,
            stableKey: key,
            ...(s('time') ? { time: s('time') } : {}),
            ...(username ? { username } : {}),
            ...(timelineId ? { timelineId } : {}),
            ...(s('mediaId') ? { mediaId: s('mediaId') } : {}),
            ...(s('mediaKind') ? { mediaKind: s('mediaKind') } : {}),
            ...(s('md5') ? { md5: s('md5') } : {}),
            ...(s('url') ? { url: s('url') } : {}),
            ...(s('token') ? { token: s('token') } : {}),
            ...(s('seed') ? { seed: s('seed') } : {}),
          },
        },
      }
    }
    if (kind === 'favorite') {
      const favoriteId = n('id')
      const identity = favoriteId > 0
        ? String(favoriteId)
        : s('serverId') || s('sourceId') || s('title') || String(i)
      const key = `fav:${identity}`
      const typeLabel = s('typeLabel')
      const mediaKind = s('resourceKind')
      return {
        key,
        name: s('title') || `收藏 #${String(favoriteId)}`,
        time: s('time'),
        snippet: s('snippet') || s('title'),
        source: 'resource' as const,
        trace: {
          kind: 'resource' as const,
          resource: {
            resourceKind: 'favorite' as const,
            stableKey: key,
            ...(s('time') ? { time: s('time') } : {}),
            ...(favoriteId > 0 ? { favoriteId } : {}),
            ...(s('serverId') ? { serverId: s('serverId') } : {}),
            ...(s('sourceId') ? { sourceId: s('sourceId') } : {}),
            ...(typeLabel ? { category: typeLabel } : {}),
            ...(s('fileName') ? { fileName: s('fileName') } : {}),
            ...(n('size') > 0 ? { size: n('size') } : {}),
            ...(s('md5') ? { md5: s('md5') } : {}),
            ...(s('thumbMd5') ? { thumbMd5: s('thumbMd5') } : {}),
            ...(s('fullMd5') ? { fullMd5: s('fullMd5') } : {}),
            ...(mediaKind ? { mediaKind } : {}),
            ...(s('url') ? { url: s('url') } : {}),
          },
        },
      }
    }
    if (kind === 'file') {
      const md5 = s('md5')
      const fileName = s('fileName')
      const key = md5 ? `file:${md5}` : `file:name:${fileName || s('time') || String(i)}`
      const category = s('category')
      return {
        key,
        name: fileName,
        time: s('time'),
        snippet: [
          category === 'image' ? '图片' : category === 'video' ? '视频' : '文件',
          n('size') > 0 ? fmtBytes(n('size')) : '',
        ]
          .filter(Boolean).join(' · ') || '文件',
        source: 'resource' as const,
        trace: {
          kind: 'resource' as const,
          resource: {
            resourceKind: 'file' as const,
            stableKey: key,
            ...(s('time') ? { time: s('time') } : {}),
            fileName,
            ...(n('size') > 0 ? { size: n('size') } : {}),
            ...(category ? { category } : {}),
            ...(md5 ? { md5 } : {}),
          },
        },
      }
    }
    const recordType = s('kind') === 'redpackets' ? 'redpackets' as const : 'transfers' as const
    const sourceId = s('sourceId') || `${recordType}:${s('session')}:${s('time')}`
    const key = `record:${recordType}:${sourceId}`
    const transferId = s('transferId')
    const messageServerId = s('messageServerId')
    return {
      key,
      name: s('name'),
      time: s('time'),
      snippet: recordType === 'transfers' ? '转账记录' : '红包记录',
      source: 'resource' as const,
      trace: {
        kind: 'resource' as const,
        resource: {
          resourceKind: 'record' as const,
          stableKey: key,
          ...(s('time') ? { time: s('time') } : {}),
          ...(s('session') ? { session: s('session') } : {}),
          sourceId,
          recordType,
          ...(transferId ? { transferId } : {}),
          ...(messageServerId ? { messageServerId } : {}),
        },
      },
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
      username: { type: 'string', description: '限定朋友圈作者（不填 = 全部；会话内问答由服务端强制）' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（不填 = 不限）' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD（不填 = 不限）' },
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
      const snap = searchUnified(ctx.decryptedDir, q, limit, contentScope(args, ctx))
      const hits = toHits(snap.moments as unknown as Array<Record<string, unknown>>, 'moment')
      if (hits.length === 0) {
        const failed = domainFailure('search_moments', 'moments', snap)
        if (failed) return failed
      }
      return {
        tool: 'search_moments', ok: true, hits,
        note: `「${q}」→ ${hits.length} 条朋友圈${degradedNote(snap, 'moments')}`,
        elapsedMs: Date.now() - started,
      }
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
      username: { type: 'string', description: '限定来源用户/会话（不填 = 全部；会话内问答由服务端强制）' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（不填 = 不限）' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD（不填 = 不限）' },
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
      const snap = searchUnified(ctx.decryptedDir, q, limit, contentScope(args, ctx))
      const hits = toHits(snap.favorites as unknown as Array<Record<string, unknown>>, 'favorite')
      if (hits.length === 0) {
        const failed = domainFailure('search_favorites', 'favorites', snap)
        if (failed) return failed
      }
      return {
        tool: 'search_favorites', ok: true, hits,
        note: `「${q}」→ ${hits.length} 条收藏${degradedNote(snap, 'favorites')}`,
        elapsedMs: Date.now() - started,
      }
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
      username: { type: 'string', description: '限定会话（文件索引不支持时会明确报错，不会静默查全库）' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（不填 = 不限）' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD（不填 = 不限）' },
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
      const snap = searchUnified(ctx.decryptedDir, q, limit, contentScope(args, ctx))
      const hits = toHits(snap.files as unknown as Array<Record<string, unknown>>, 'file')
      if (hits.length === 0) {
        const failed = domainFailure('search_files', 'files', snap)
        if (failed) return failed
      }
      return {
        tool: 'search_files', ok: true, hits,
        note: `「${q}」→ ${hits.length} 个文件${degradedNote(snap, 'files')}`,
        elapsedMs: Date.now() - started,
      }
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
      username: { type: 'string', description: '限定会话（不填 = 全部；会话内问答由服务端强制）' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（不填 = 不限）' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD（不填 = 不限）' },
      limit: { type: 'number', description: '最多返回几条（默认 12，上限 12）' },
    },
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const q = argString(args['query']).trim()
    const limit = argInt(args['limit'], 12, 1, 12)
    try {
      const snap = searchUnified(ctx.decryptedDir, q, limit, contentScope(args, ctx))
      const hits = toHits(snap.records as unknown as Array<Record<string, unknown>>, 'record')
      if (hits.length === 0) {
        const failed = domainFailure('search_records', 'records', snap)
        if (failed) return failed
      }
      return {
        tool: 'search_records', ok: true, hits,
        note: `${hits.length} 条转账/红包记录${degradedNote(snap, 'records')}`,
        elapsedMs: Date.now() - started,
      }
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
