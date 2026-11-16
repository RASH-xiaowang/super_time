/**
 * 撤回消息检索工具（2026-11-13 新增）。
 *
 * ## 为什么必须单独做成工具
 *
 * 「谁撤回了什么」「最近撤回了哪些消息」的答案**不在普通消息检索里**：
 *   · 微信库里只剩一条系统提示（`"某某" 撤回了一条消息`），原文那行已经不在了；
 *   · 原文能留下，靠的是本仓的 `revoke-retain.ts` 归档闭环（先把消息全量落进
 *     `message-archive.db`，再按「同会话里紧挨在提示之前」配对）。
 *
 * 所以这里不能复用 `search_messages` —— 它检索的是**当前**消息库，撤回的原文
 * 早已被微信删掉。本工具直接复用归档的读取实现，保证与「撤回消息」面板同口径。
 *
 * ## 「没有归档」不能报成「没有撤回」
 *
 * 归档库不存在意味着**我们还没开始保留原文**（后台同步会补），而不是「你没有
 * 撤回消息」。两者对用户的含义完全不同 —— 前者需要提示去检查数据配置/等待同步，
 * 后者才是结论。因此空结果时先探测归档是否可读，再决定 note 措辞。
 *
 * @module query/tools/revoke-tools
 */
import { existsSync } from 'node:fs'
import { fmtDateTimeSec } from '../../format.ts'
import { contactMeta } from '../meta.ts'
import { displayNameForUsername } from '../message-identity.ts'
import { queryRevoked } from '../records.ts'
import { messageArchivePath, queryRevokedRetained } from '../revoke-retain.ts'
import {
  argInt, argString,
  type RetrievalTool, type ToolHit, type ToolResult,
} from './types.ts'

/** 默认返回条数（与其它检索工具一致）。 */
const DEFAULT_LIMIT = 20
/** 上限：一次问答里展示太多撤回原文会挤占上下文。 */
const MAX_LIMIT = 100
/** 单页取回量；`queryRevoked` 自身把单页上限钳在 500。 */
const SCAN_PAGE = 500
/**
 * 单次工具调用的**扫描上界**。
 *
 * 为什么有上界：归档读取要扫全部撤回提示并配对原文（`queryRevokedRetained`
 * 没有 SQL 时间过滤）。给一个两倍于常见撤回量的上界，既能覆盖「按区间找旧撤回」，
 * 又不会让一次问答被几十万行归档拖住；超出时在 note 里如实说明「结果可能不完整」。
 */
const SCAN_MAX_ROWS = 1000
/** 插件缓存降级分页的时间预算（毫秒）。 */
const SCAN_BUDGET_MS = 1500

/**
 * `queryRevoked` / `queryRevokedRetained` 在归档路径返回的完整行形状。
 *
 * 公开签名里 `queryRevoked` 只声明了四个兼容字段，但归档路径实际会带
 * `sender_username/session_username/local_id`（见 `types-insights.ts#RevokedItem`）。
 * 这里显式声明，避免调用方用 `any` 或字符串解析 key。
 */
interface RevokeRow {
  sender: string
  type_label: string
  content: string
  create_time: number
  sender_username?: string
  session_username?: string
  session_name?: string
  enterpriseName?: string
  senderEnterpriseName?: string
  local_id?: number
}

/** 把 `YYYY-MM-DD` 转成当天 00:00 的 epoch 秒（本地时区）；非法日期返回 0。 */
function dayStartSec(value: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (!m) return 0
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const probe = new Date(y, mo - 1, d, 0, 0, 0)
  // 拒绝 2026-02-30 这类会被 Date 滚到下个月的输入，而不是悄悄改成另一个日期。
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return 0
  return Math.floor(probe.getTime() / 1000)
}

/** 把 `YYYY-MM-DD` 转成当天 23:59:59 的 epoch 秒（本地时区）；非法日期返回 0。 */
function dayEndSec(value: string): number {
  const start = dayStartSec(value)
  return start === 0 ? 0 : start + 86399
}

/** 发送者筛选：显示名 / 微信号 / 会话名任一命中（大小写不敏感，允许部分匹配）。 */
function matchesSender(row: RevokeRow, needle: string): boolean {
  const wanted = needle.trim().toLowerCase()
  if (wanted === '') return true
  const haystack = [
    row.sender,
    row.sender_username ?? '',
    row.session_name ?? '',
    row.session_username ?? '',
  ].map(v => v.trim().toLowerCase()).filter(v => v !== '')
  // 先精确再包含：`王五` 命中「王五」，`王` 也能命中「王五」（与检索工具的宽松口径一致）。
  return haystack.some(v => v === wanted) || haystack.some(v => v.includes(wanted))
}

/**
 * 探测归档是否**可用**。
 *
 * 只看文件存在不够：文件可能在、但 `archived_msg` 表缺失（解密不完整）。
 * `queryRevokedRetained` 的 `readError` 正好区分这两类，直接复用它的判定。
 */
function archiveReadError(decryptedDir: string): boolean {
  try {
    return queryRevokedRetained(decryptedDir, 1, 0).readError !== undefined
  } catch {
    return !existsSync(messageArchivePath(decryptedDir))
  }
}

/** 归档不存在时的统一说明：**不能**等价成「没有撤回」。 */
const MISSING_ARCHIVE_NOTE =
  '本机未开启/没有撤回归档（归档建立前撤回的原文不会被保留）；'
  + '这不等于「没有撤回」，后台同步开启后才会持续记录。'

/** 检索撤回消息（原文来自本机保留归档）。 */
export const searchRevokedTool: RetrievalTool = {
  name: 'search_revoked',
  category: 'content',
  description:
    '检索**撤回消息**（含被撤回的原文，前提是本机已建立撤回归档）。'
    + '适用于「谁撤回了什么」「最近撤回了哪些消息」「有没有撤回关于 X 的消息」这类问题。'
    + '注意：普通 search_messages 查不到撤回原文；问撤回必须用本工具。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '匹配撤回原文的关键词（不填 = 全部撤回消息）' },
      sender: { type: 'string', description: '撤回消息的发送者（显示名或微信号，不填 = 全部）' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（不填 = 不限）' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD（不填 = 不限）' },
      limit: { type: 'number', description: '最多返回几条（默认 20，上限 100）' },
    },
  },
  run: (args, ctx): ToolResult => {
    const started = Date.now()
    const queryText = argString(args['query']).trim()
    const senderFilter = argString(args['sender']).trim()
    // 服务端锁定的 scope 是硬过滤：模型参数不能覆盖用户选定的范围。
    const from = ctx.scope?.from?.trim() || argString(args['from']).trim()
    const to = ctx.scope?.to?.trim() || argString(args['to']).trim()
    const limit = argInt(args['limit'], DEFAULT_LIMIT, 1, MAX_LIMIT)
    const lo = from ? dayStartSec(from) : 0
    const hi = to ? dayEndSec(to) : 0
    const archiveExisted = existsSync(messageArchivePath(ctx.decryptedDir))

    let rows: RevokeRow[] = []
    let total = 0
    let truncated = false
    let readError = ''
    try {
      // 第一步：`queryRevoked` 会先触发归档（幂等、按源库签名跳过未变分片），
      // 再按归档路径出列表；归档不可用时它会自动降级到第三方插件缓存。
      const base = queryRevoked(ctx.decryptedDir, SCAN_PAGE, 0, queryText)
      rows = base.items as RevokeRow[]
      total = base.total
      if (total > rows.length) {
        // 第二步：归档已就绪后，直接用 `queryRevokedRetained` 一次取到扫描上界，
        // 避免按 500 一页反复重扫全部提示（那会成倍放大配对成本）。
        const deep = queryRevokedRetained(ctx.decryptedDir, SCAN_MAX_ROWS, 0, queryText)
        readError = deep.readError ?? ''
        if (readError === '') {
          rows = deep.items as RevokeRow[]
          total = deep.total
        } else {
          // 没有归档时退回插件缓存分页（总量通常很小）。
          let offset = rows.length
          while (offset < Math.min(total, SCAN_MAX_ROWS)) {
            if (ctx.signal?.aborted || Date.now() - started > SCAN_BUDGET_MS) {
              truncated = true
              break
            }
            const page = queryRevoked(
              ctx.decryptedDir,
              Math.min(SCAN_PAGE, SCAN_MAX_ROWS - offset),
              offset,
              queryText,
            )
            if (page.items.length === 0) break
            rows.push(...(page.items as RevokeRow[]))
            offset += page.items.length
          }
        }
        if (rows.length < total) truncated = true
      }
    } catch (e) {
      return {
        tool: 'search_revoked',
        ok: false,
        errorCode: 'upstream_failure',
        error: '撤回记录读取失败：' + ((e as Error)?.message ?? String(e)),
        hits: [],
        elapsedMs: Date.now() - started,
      }
    }

    const lockedSession = (ctx.scope?.username ?? '').trim()
    const filtered = rows.filter((r) => {
      if (lockedSession !== '') {
        // 会话内问答：归档行必须能**明确归属**到当前会话才保留。
        // `session_username` 缺失时无法证明归属，按 fail closed 排除 ——
        // 宁可少答，也不能把其他会话的撤回原文漏进当前会话。
        if ((r.session_username ?? '').trim() !== lockedSession) return false
      }
      if (lo > 0 && r.create_time < lo) return false
      if (hi > 0 && r.create_time > hi) return false
      return matchesSender(r, senderFilter)
    })

    const rangeLabel = from || to
      ? `${from || '不限'} ~ ${to || '不限'}`
      : '全部时间'
    // 会话内问答必须让模型和用户知道统计口径只覆盖当前会话，而不是全部归档。
    const scopeLabel = lockedSession !== '' ? '仅当前会话' : ''

    if (filtered.length === 0) {
      // 关键区分：归档不存在 ≠ 没有撤回。文件/表任一缺失都用专门措辞。
      const missing = readError !== '' ? true : (!archiveExisted && archiveReadError(ctx.decryptedDir))
      return {
        tool: 'search_revoked',
        ok: true,
        hits: [],
        facts: [],
        note: missing
          ? MISSING_ARCHIVE_NOTE
          : `归档中没有匹配的撤回记录（${scopeLabel ? `${scopeLabel} · ` : ''}${rangeLabel}${queryText ? `，关键词「${queryText}」` : ''}${senderFilter ? `，发送者「${senderFilter}」` : ''}）`,
        elapsedMs: Date.now() - started,
      }
    }

    // facts：标题给出区间口径，正文给总数 / 最高频发送者 / 关键词命中数。
    const bySender = new Map<string, number>()
    for (const row of filtered) {
      const sender = (row.sender || '未知').trim() || '未知'
      bySender.set(sender, (bySender.get(sender) ?? 0) + 1)
    }
    const topSender = [...bySender.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]
    const bodyParts = [`共 ${filtered.length} 条`]
    if (topSender !== undefined) bodyParts.push(`${topSender[0]} ${topSender[1]} 条`)
    if (queryText !== '') {
      const kw = queryText.toLowerCase()
      const matched = filtered.filter(r => (r.content ?? '').toLowerCase().includes(kw)).length
      bodyParts.push(`含「${queryText}」${matched} 条`)
    }

    const names = contactMeta(ctx.decryptedDir).names
    const hits: ToolHit[] = filtered.slice(0, limit).map((row, index) => {
      const username = (row.session_username ?? '').trim()
      const localId = Number(row.local_id ?? 0)
      const hasStableKey = username !== '' && Number.isSafeInteger(localId) && localId > 0
      // 证据层按 `username:local_id` 解析定位（evidence-normalize 的 messageLocator）；
      // 只有插件降级行没有这两个字段，用一个不冲突的兜底键而不是伪造微信号。
      const key = hasStableKey ? `${username}:${localId}` : `revoked:${row.create_time || 0}:${index}`
      const name = row.session_name?.trim()
        || (username !== '' ? displayNameForUsername(username, names) : '')
        || '撤回消息'
      const content = (row.content ?? '').replace(/\s+/g, ' ').trim() || '（无内容副本）'
      const enterpriseName = row.enterpriseName?.trim() ?? ''
      const senderEnterpriseName = row.senderEnterpriseName?.trim() ?? ''
      return {
        key,
        name,
        ...(enterpriseName !== '' ? { enterpriseName } : {}),
        time: fmtDateTimeSec(row.create_time),
        snippet: `撤回：${content}`.slice(0, 240),
        ...(row.sender.trim() !== '' ? { sender: row.sender } : {}),
        ...(senderEnterpriseName !== '' ? { senderEnterpriseName } : {}),
        source: 'msg' as const,
        trace: {
          kind: 'msg' as const,
          ...(username !== '' ? { username } : {}),
          ...(localId > 0 ? { localId } : {}),
        },
      }
    })

    const noteParts = [
      `撤回 ${filtered.length} 条`,
      scopeLabel,
      rangeLabel,
      senderFilter ? `发送者「${senderFilter}」` : '',
      queryText ? `关键词「${queryText}」` : '',
    ].filter(part => part !== '')
    if (truncated) {
      noteParts.push(`归档共 ${total} 条，本次最多扫描 ${rows.length} 条，结果可能不完整`)
    }

    return {
      tool: 'search_revoked',
      ok: true,
      hits,
      facts: [{
        // 有日期条件时明确写「区间」，否则写「全量」，避免把一段样本说成全部。
        title: from || to ? '撤回（区间）' : '撤回（全量）',
        body: bodyParts.join('；'),
      }],
      note: noteParts.join(' · '),
      elapsedMs: Date.now() - started,
    }
  },
}

/** 撤回类工具集。 */
export const REVOKE_TOOLS: readonly RetrievalTool[] = [searchRevokedTool]
