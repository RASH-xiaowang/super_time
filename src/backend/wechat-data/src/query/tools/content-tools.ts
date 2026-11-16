/**
 * 内容类检索工具（2026-10-16 新增）：朋友圈 / 收藏 / 文件 / 转账红包记录。
 *
 * ## 为什么拆成四个工具而不是一个「搜所有内容」
 *
 * 四个域的数据形状与用户意图都不同：
 *   · 朋友圈 —— 有作者、有发布时间、有配文；
 *   · 收藏 —— 有类型（文本/图片/链接/文件）、有收藏时间；
 *   · 文件 —— 有文件名、大小、md5；
 *   · 转账红包 —— 有金额、方向（收/付）、状态。
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
 * 2026-11：`query` 全部改为可空（空 = 该域最近条目）；新增排序、类型/大类、
 * 金额/体积区间与记录类型/收支方向过滤，`limit` 上限统一到 60。
 *
 * @module query/tools/content-tools
 */
import { fmtBytes } from '../../format.ts'
import { searchUnified } from '../unified-search.ts'
import type {
  ToolResourceTrace,
  ToolHit,
  ToolResult,
  RetrievalTool,
  ToolContext,
} from './types.ts'
import { argInt, argString } from './types.ts'

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

/** 枚举参数：不认识的值回落到默认，不把无效字符串拼进 SQL/查询。 */
function argEnum<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof v !== 'string') return fallback
  return (allowed as readonly string[]).includes(v) ? v as T : fallback
}

/** 可选非负整数（缺省 = 不设区间）。 */
function argOptionalInt(v: unknown, min = 0): number | undefined {
  if (v === null || v === undefined || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return undefined
  return Math.max(Math.trunc(n), min)
}

/** 元 → 分（参数是「元」，内部按分比较，避免浮点累计误差）。 */
function argYuanCents(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || n < 0) return undefined
  return Math.round(n * 100)
}

/** 分 → 「¥12.34」；金额未知时由调用方给文案，不在这里伪造 0。 */
function moneyLabel(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`
}

/**
 * 某个资源域的失败。
 *
 * 日期/会话范围无法执行时返回 `unsupported_scope`；库/表还没解密/生成时返回
 * `not_configured`；其余读取失败返回 `upstream_failure`。三者都不能被当作「没有结果」。
 */
function domainFailure(
  result: ToolResult['tool'],
  domain: ResourceDomain,
  snap: ReturnType<typeof searchUnified>,
): ToolResult | undefined {
  const failure = snap.domainErrors?.[domain]
  if (!failure) return undefined
  const code = String(failure.code)
  const errorCode = code === 'unsupported_scope'
    ? 'unsupported_scope' as const
    : code === 'not_configured'
      ? 'not_configured' as const
      : 'upstream_failure' as const
  return {
    tool: result,
    ok: false,
    error: failure.message,
    errorCode,
    errorDetails: { domain, code },
    hits: [],
  }
}

/** 部分命中时把域异常附在 note 上，便于证据层与用户知道结果不完整。 */
function degradedNote(snap: ReturnType<typeof searchUnified>, domain: ResourceDomain): string {
  const failure = snap.domainErrors?.[domain]
  return failure ? `；${failure.message}（结果可能不完整）` : ''
}

type RecordTrace = Omit<ToolResourceTrace, 'recordType'> & {
  /** 运行时可取 `revokes`；公开类型暂只声明转账/红包，故在此局部放宽。 */
  recordType?: 'transfers' | 'redpackets' | 'revokes'
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
        // 正文保留前 200 字：工具给模型转述用，截到 12 条那种上限不是这里的职责。
        snippet: (s('snippet') || s('text')).slice(0, 200),
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
    const recordType: RecordTrace['recordType'] = s('kind') === 'revokes'
      ? 'revokes'
      : s('kind') === 'redpackets' ? 'redpackets' : 'transfers'
    const sourceId = s('sourceId') || `${recordType}:${s('session')}:${s('time')}`
    const key = `record:${recordType}:${sourceId}`
    const transferId = s('transferId')
    const messageServerId = s('messageServerId')
    const direction = s('direction')
    const directionLabel = direction === 'in' ? '收入' : direction === 'out' ? '支出' : '方向未知'
    const amountCents = n('amountCents')
    const hasAmount = typeof r['amountCents'] === 'number' && Number.isFinite(amountCents) && amountCents >= 0
    const statusLabel = s('statusLabel') || '状态未知'
    const kindLabel = recordType === 'revokes' ? '撤回' : recordType === 'redpackets' ? '红包' : '转账'
    const snippet = recordType === 'revokes'
      ? '撤回记录 · 状态：已撤回'
      : `${kindLabel} · ${directionLabel} ${hasAmount ? moneyLabel(amountCents) : '金额未知'} · 状态：${statusLabel}`
    const resource: RecordTrace = {
      resourceKind: 'record',
      stableKey: key,
      ...(s('time') ? { time: s('time') } : {}),
      ...(s('session') ? { session: s('session') } : {}),
      sourceId,
      recordType,
      ...(transferId ? { transferId } : {}),
      ...(messageServerId ? { messageServerId } : {}),
    }
    return {
      key,
      name: s('name') || kindLabel,
      time: s('time'),
      snippet,
      source: 'resource' as const,
      trace: {
        kind: 'resource' as const,
        resource: resource as ToolResourceTrace,
      },
    }
  })
}

/** 记录结果的事实小计（只统计本次返回的这一页，标题必须说明「本次结果」）。 */
function recordFacts(rows: ReadonlyArray<Record<string, unknown>>): Array<{ title: string; body: string }> {
  if (rows.length === 0) return []
  let transfers = 0
  let redpackets = 0
  let revokes = 0
  let inCents = 0
  let outCents = 0
  let unknownAmount = 0
  let unknownDirection = 0
  for (const row of rows) {
    const kind = typeof row['kind'] === 'string' ? row['kind'] : ''
    if (kind === 'revokes') { revokes += 1; continue }
    if (kind === 'redpackets') redpackets += 1
    else transfers += 1
    const cents = typeof row['amountCents'] === 'number' ? row['amountCents'] : undefined
    if (cents === undefined || !Number.isFinite(cents)) {
      unknownAmount += 1
      continue
    }
    if (row['direction'] === 'in') inCents += cents
    else if (row['direction'] === 'out') outCents += cents
    else unknownDirection += 1
  }
  const parts = [
    `转账 ${String(transfers)} 笔`,
    `红包 ${String(redpackets)} 笔`,
    ...(revokes > 0 ? [`撤回 ${String(revokes)} 条`] : []),
    `收入 ${moneyLabel(inCents)}`,
    `支出 ${moneyLabel(outCents)}`,
    `金额未知 ${String(unknownAmount)} 笔`,
    ...(unknownDirection > 0 ? [`方向未知 ${String(unknownDirection)} 笔`] : []),
  ]
  return [{
    title: `本次结果：${String(rows.length)} 条记录`,
    body: `${parts.join(' · ')}（金额来自本机支付卡片，缺失时不猜测；不是全量统计）`,
  }]
}

/** 朋友圈检索。 */
export const searchMomentsTool: RetrievalTool = {
  name: 'search_moments',
  category: 'content',
  description:
    '检索**朋友圈**（按配文/作者）。适用于「谁发过关于 X 的朋友圈」「X 那条朋友圈是什么时候发的」。'
    + 'query 留空 = 最近动态（按时间排序）。注意：它查的是朋友圈，不是聊天记录。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索词（留空 = 最近动态）' },
      username: { type: 'string', description: '限定朋友圈作者（不填 = 全部；会话内问答由服务端强制）' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（不填 = 不限）' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD（不填 = 不限）' },
      order: { type: 'string', enum: ['recent', 'oldest'], description: '排序：recent 最新在前（默认），oldest 最早在前' },
      limit: { type: 'number', description: '最多返回几条（默认 12，上限 60）' },
    },
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const q = argString(args['query']).trim()
    const limit = argInt(args['limit'], 12, 1, 60)
    const order = argEnum(args['order'], ['recent', 'oldest'] as const, 'recent')
    try {
      const snap = searchUnified(ctx.decryptedDir, q, limit, {
        ...contentScope(args, ctx),
        domains: ['moments'],
        order,
        reportMissing: true,
      })
      const hits = toHits(snap.moments as unknown as Array<Record<string, unknown>>, 'moment')
      if (hits.length === 0) {
        const failed = domainFailure('search_moments', 'moments', snap)
        if (failed) return failed
      }
      const orderLabel = order === 'oldest' ? '（最早在前）' : ''
      return {
        tool: 'search_moments', ok: true, hits,
        note: (q
          ? `「${q}」→ ${String(hits.length)} 条朋友圈${orderLabel}`
          : `最近 ${String(hits.length)} 条朋友圈${orderLabel}`)
          + degradedNote(snap, 'moments'),
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
    '检索**微信收藏**（文本/图片/视频/链接/文件）。适用于「我收藏过关于 X 的东西」「收藏里有没有 X」。'
    + 'query 留空 = 最近收藏（按时间排序）。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '检索词（留空 = 最近收藏）' },
      type: {
        type: 'string',
        enum: ['all', 'text', 'image', 'video', 'file', 'link', 'other'],
        description: '收藏类型（默认 all；未知类型归 other）',
      },
      username: { type: 'string', description: '限定来源用户/会话（不填 = 全部；会话内问答由服务端强制）' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（不填 = 不限）' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD（不填 = 不限）' },
      order: { type: 'string', enum: ['recent', 'oldest'], description: '排序：recent 最新在前（默认），oldest 最早在前' },
      limit: { type: 'number', description: '最多返回几条（默认 12，上限 60）' },
    },
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const q = argString(args['query']).trim()
    const limit = argInt(args['limit'], 12, 1, 60)
    const order = argEnum(args['order'], ['recent', 'oldest'] as const, 'recent')
    const type = argEnum(args['type'], ['all', 'text', 'image', 'video', 'file', 'link', 'other'] as const, 'all')
    try {
      const snap = searchUnified(ctx.decryptedDir, q, limit, {
        ...contentScope(args, ctx),
        domains: ['favorites'],
        order,
        favoriteType: type,
        reportMissing: true,
      })
      const hits = toHits(snap.favorites as unknown as Array<Record<string, unknown>>, 'favorite')
      if (hits.length === 0) {
        const failed = domainFailure('search_favorites', 'favorites', snap)
        if (failed) return failed
      }
      const orderLabel = order === 'oldest' ? '（最早在前）' : ''
      const typeLabel = type === 'all' ? '' : `（类型 ${type}）`
      return {
        tool: 'search_favorites', ok: true, hits,
        note: (q
          ? `「${q}」→ ${String(hits.length)} 条收藏${typeLabel}${orderLabel}`
          : `最近 ${String(hits.length)} 条收藏${typeLabel}${orderLabel}`)
          + degradedNote(snap, 'favorites'),
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
    '检索聊天里收发过的**文件**（按文件名/MD5）。适用于「有没有发过 X 文件」「X 文件是什么时候发的」。'
    + 'query 留空 = 最近文件；可按文件大类与体积过滤。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '文件名/MD5 关键词（留空 = 最近文件）' },
      category: {
        type: 'string',
        enum: ['all', 'file', 'image', 'video'],
        description: '文件大类（默认 all，按扩展名/来源表判断）',
      },
      username: { type: 'string', description: '限定会话（文件索引不支持时会明确报错，不会静默查全库）' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（不填 = 不限）' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD（不填 = 不限）' },
      order: { type: 'string', enum: ['recent', 'size'], description: '排序：recent 修改时间倒序（默认），size 体积倒序' },
      minSize: { type: 'number', description: '最小体积（字节，含边界）' },
      maxSize: { type: 'number', description: '最大体积（字节，含边界）' },
      limit: { type: 'number', description: '最多返回几条（默认 12，上限 60）' },
    },
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const q = argString(args['query']).trim()
    const limit = argInt(args['limit'], 12, 1, 60)
    const category = argEnum(args['category'], ['all', 'file', 'image', 'video'] as const, 'all')
    const order = argEnum(args['order'], ['recent', 'size'] as const, 'recent')
    const minSize = argOptionalInt(args['minSize'], 0)
    const maxSize = argOptionalInt(args['maxSize'], 0)
    /*
     * hardlink.db 的文件索引没有来源会话列。任何会话过滤（模型参数或锁定
     * scope）都必须在这里明确拒绝；否则不带 username 的调用会静默查全库
     * （2026-11-13 审计）。执行层守卫也会拦锁定会话，这里兜住直接调用。
     */
    const sessionFilter = ctx.scope?.username?.trim() || argString(args['username']).trim()
    if (sessionFilter !== '') {
      return {
        tool: 'search_files',
        ok: false,
        errorCode: 'unsupported_scope',
        error: '文件检索不支持按会话过滤，请去掉 username 后按文件名检索',
        errorDetails: { parameter: 'username', username: sessionFilter },
        hits: [],
      }
    }
    try {
      const snap = searchUnified(ctx.decryptedDir, q, limit, {
        ...contentScope(args, ctx),
        domains: ['files'],
        fileCategory: category,
        fileOrder: order,
        ...(minSize !== undefined ? { minSize } : {}),
        ...(maxSize !== undefined ? { maxSize } : {}),
        reportMissing: true,
      })
      const hits = toHits(snap.files as unknown as Array<Record<string, unknown>>, 'file')
      if (hits.length === 0) {
        const failed = domainFailure('search_files', 'files', snap)
        if (failed) return failed
      }
      const orderLabel = order === 'size' ? '（体积倒序）' : ''
      const categoryLabel = category === 'all' ? '' : `（${category === 'image' ? '图片' : category === 'video' ? '视频' : '文件'}）`
      return {
        tool: 'search_files', ok: true, hits,
        note: (q
          ? `「${q}」→ ${String(hits.length)} 个文件${categoryLabel}${orderLabel}`
          : `最近 ${String(hits.length)} 个文件${categoryLabel}${orderLabel}`)
          + degradedNote(snap, 'files'),
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
    + 'query 留空 = 最近记录；返回金额、收支方向与原始状态。'
    + '问「一共多少笔」用 aggregate_messages；本工具只统计「本次结果」。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '对方名字 / 备注（留空 = 全部记录）' },
      kind: {
        type: 'string',
        enum: ['all', 'transfer', 'redpacket', 'revoke'],
        description: '记录类型（默认 all；revoke = 撤回记录）',
      },
      direction: { type: 'string', enum: ['all', 'in', 'out'], description: '收支方向（默认 all；撤回记录不适用）' },
      order: { type: 'string', enum: ['recent', 'oldest'], description: '排序：recent 最新在前（默认），oldest 最早在前' },
      minAmount: { type: 'number', description: '最小金额（元，含边界；仅转账/红包）' },
      maxAmount: { type: 'number', description: '最大金额（元，含边界；仅转账/红包）' },
      username: { type: 'string', description: '限定会话（不填 = 全部；会话内问答由服务端强制）' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（不填 = 不限）' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD（不填 = 不限）' },
      limit: { type: 'number', description: '最多返回几条（默认 12，上限 60）' },
    },
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const q = argString(args['query']).trim()
    const limit = argInt(args['limit'], 12, 1, 60)
    const kind = argEnum(args['kind'], ['all', 'transfer', 'redpacket', 'revoke'] as const, 'all')
    const direction = argEnum(args['direction'], ['all', 'in', 'out'] as const, 'all')
    const order = argEnum(args['order'], ['recent', 'oldest'] as const, 'recent')
    const minAmountCents = argYuanCents(args['minAmount'])
    const maxAmountCents = argYuanCents(args['maxAmount'])
    const recordKind = kind === 'transfer'
      ? 'transfers' as const
      : kind === 'redpacket' ? 'redpackets' as const : kind === 'revoke' ? 'revokes' as const : 'all' as const
    try {
      const snap = searchUnified(ctx.decryptedDir, q, limit, {
        ...contentScope(args, ctx),
        domains: ['records'],
        recordKind,
        direction,
        order,
        ...(minAmountCents !== undefined ? { minAmountCents } : {}),
        ...(maxAmountCents !== undefined ? { maxAmountCents } : {}),
        resolveRecordMoney: true,
        reportMissing: true,
      })
      const rows = snap.records as unknown as Array<Record<string, unknown>>
      const hits = toHits(rows, 'record')
      if (hits.length === 0) {
        const failed = domainFailure('search_records', 'records', snap)
        if (failed) return failed
      }
      const kindLabel = kind === 'all' ? '' : `（${kind === 'transfer' ? '转账' : kind === 'redpacket' ? '红包' : '撤回'}）`
      const orderLabel = order === 'oldest' ? '（最早在前）' : ''
      const facts = recordFacts(rows)
      return {
        tool: 'search_records', ok: true, hits,
        ...(facts.length > 0 ? { facts } : {}),
        note: (q
          ? `「${q}」→ ${String(hits.length)} 条记录${kindLabel}${orderLabel}`
          : `最近 ${String(hits.length)} 条记录${kindLabel}${orderLabel}`)
          + degradedNote(snap, 'records'),
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
