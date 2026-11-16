/**
 * 通话记录检索工具（2026-10-16 新增）。
 *
 * ## 为什么需要它
 *
 * 通话记录是 `local_type = 50` 的 `voipmsg`，**不在检索索引里** ——
 * `search_messages` / `aggregate_messages` 都看不到它们。于是「最近跟谁通过话」
 * 「上个月和李四打了几次电话」这类问题只能靠模型猜，或者被答成「没有相关聊天记录」。
 *
 * ## 与 `query/calls.ts` 的关系
 *
 * 那个模块已经能正确解析 zstd + voip XML（时长藏在 `<msg>` 里，`<duration>` 恒为 0），
 * 也已经有分片级缓存与让出。这里**不复制解析逻辑**：只把工具参数翻译成
 * `queryCalls` 的范围/对方/预算，再把结构化结果整形成 `ToolHit` / `facts`。
 *
 * ## 口径（写进 `note`，避免模型把估算当精确值）
 *
 *   · 接通 = 有时长，或状态为「已在其它设备接听」；
 *   · 未接/拒接 = 其余全部（取消/拒绝/未应答/忙线），与面板 `missed` 同口径；
 *   · 时长只统计**本机有记录**的接通通话（其它设备接听没有本地时长）；
 *   · `room_type` 0=语音 / 1=视频（判据见 `parse.ts#parseVoipKind`），未知时只说「通话」。
 *
 * @module query/tools/calls-tools
 */
import { ANSWERED_ELSEWHERE, queryCalls, type CallHistoryRecord, type CallsQueryResult } from '../calls.ts'
import { contactMeta } from '../meta.ts'
import {
  isInternalWechatId,
  mergeDisplayNames,
  messageIdentityIndex,
  resolveTalkerUsername,
} from '../message-identity.ts'
import { resolveSelfUsername } from '../../config/resolve.ts'
import { fmtDateTimeSec } from '../../format.ts'
import { dayEndSec, dayStartSec } from './message-tools.ts'
import { argInt, argString, type RetrievalTool, type ToolHit, type ToolResult } from './types.ts'

/**
 * 单次工具调用的扫描预算。
 *
 * 为什么要预算：SQL 的 `local_type = 50` 仍要逐表扫；大账号（几十万条消息、上万条通话）
 * 上全量解码 XML 可能远超问答的一次工具预算。20k 条 type-50 已覆盖绝大多数账号的
 * 全部通话，4 秒则给「异常多」的账号一个硬上界。命中任一预算都会停扫，
 * 并在 `note` 里明确写「统计不完整」——不能把截断后的数字伪装成精确值。
 */
const CALL_SCAN_MAX_ROWS = 20_000
const CALL_SCAN_MAX_MS = 4_000

/** 显示名回退：这些是产品里的「占位名」，不是真实姓名，不能当成联系人名返回。 */
const GENERATED_LABELS = new Set(['未命名会话', '未知联系人', '某个群聊', '某位成员', '某位联系人'])
const GENERATED_ROOM_LABEL_RE = /^群聊(?:\s+\d+)?$/

/**
 * 把 `YYYY-MM-DD` 转成本地时区当天的起/止 epoch 秒。
 *
 * 为什么不用 `Date.parse`：它对 `2026-02-30` 这类非法日期会静默进位。
 * 工具参数是不可信输入，非法日期必须报出来，而不是悄悄换成另一天。
 * @param value - 原始日期串。
 * @param endOfDay - true 取 23:59:59（含端点），false 取 00:00:00。
 * @returns epoch 秒；非法日期返回 null。
 */
function dayBoundSec(value: string, endOfDay: boolean): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const probe = new Date(year, month - 1, day)
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) return null
  return endOfDay ? dayEndSec(value) : dayStartSec(value)
}

/** 显示名：联系人备注/昵称 > 会话标题 > username（缺失时如实回退，不编造）。 */
function peerLabel(
  username: string,
  names: ReadonlyMap<string, string>,
  meta: ReturnType<typeof contactMeta>,
): string {
  const raw = username.trim()
  for (const candidate of [meta.names.get(raw), names.get(raw)]) {
    const clean = candidate?.trim() ?? ''
    if (
      clean
      && clean !== raw
      && !GENERATED_LABELS.has(clean)
      && !GENERATED_ROOM_LABEL_RE.test(clean)
      && !isInternalWechatId(clean)
    ) return clean
  }
  return raw || '未知对方'
}

/**
 * 把 `peer` 参数（显示名或 username）解析成一组 username。
 *
 * 为什么允许一组：不同联系人可能同名（企业联系人尤其常见），按名字精确匹配到谁
 * 就查谁；不同名的「模糊匹配」不做 —— 那会把「李四」误扩大到「李四四」。
 * @param peer - 用户/模型给的对方标识。
 * @param names - 合并后的显示名。
 * @param usernames - 身份索引里的已知 username。
 * @param meta - contact.db 元数据（备注优先）。
 * @returns 匹配到的 username 集合（至少包含输入本身，便于 username 直查）。
 */
function resolvePeerUsernames(
  decryptedDir: string,
  peer: string,
  names: ReadonlyMap<string, string>,
  usernames: ReadonlySet<string>,
  meta: ReturnType<typeof contactMeta>,
): Set<string> {
  const out = new Set<string>()
  const needle = peer.trim()
  if (!needle) return out
  const canonical = resolveTalkerUsername(decryptedDir, needle, ['message'])
  if (canonical) out.add(canonical)
  if (usernames.has(needle)) out.add(needle)
  const lower = needle.toLocaleLowerCase()
  const matches = (name: string): boolean => {
    const clean = name.trim()
    // 占位名（未命名会话/未知联系人/群聊 123）不是真实姓名：拿它们当条件会把
    // 「所有没有备注的人」都匹配进来，等于悄悄扩大查询范围。
    if (!clean || GENERATED_LABELS.has(clean) || GENERATED_ROOM_LABEL_RE.test(clean) || isInternalWechatId(clean)) return false
    return clean === needle || clean.toLocaleLowerCase() === lower
  }
  for (const [username, name] of meta.names) if (matches(name)) out.add(username)
  for (const [username, name] of names) if (matches(name)) out.add(username)
  return out
}

/** 时长展示（通话记录行）：`21分08秒` / `1小时02分` / `45秒`。 */
function formatDurationClock(sec: number): string {
  const total = Math.max(0, Math.trunc(sec))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}小时${String(m).padStart(2, '0')}分`
  if (m > 0) return `${m}分${String(s).padStart(2, '0')}秒`
  return `${s}秒`
}

/** 汇总时长展示（facts）：`2 小时 5 分` / `38 分` / `45 秒`。 */
function formatDurationSpan(sec: number): string {
  const total = Math.max(0, Math.trunc(sec))
  if (total === 0) return '0 秒'
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`
  if (m > 0) return s > 0 ? `${m} 分 ${s} 秒` : `${m} 分`
  return `${s} 秒`
}

/** 语音/视频：`room_type` 未知时不下结论，只说「通话」。 */
function callKind(record: CallHistoryRecord): string {
  if (record.roomType === 0) return '语音通话'
  if (record.roomType === 1) return '视频通话'
  return '通话'
}

/** 结果口径：与 `calls.ts#buildSnapshot` 的 connected/missed 保持同一判据。 */
function callOutcome(record: CallHistoryRecord): string {
  if (record.connected) {
    return ANSWERED_ELSEWHERE.test(record.status) ? '已在其它设备接听' : '已接听'
  }
  const status = record.status
  if (/拒绝|拒接/.test(status)) return '已拒接'
  if (/取消/.test(status)) return '已取消'
  if (/忙/.test(status)) return '忙线'
  if (/未应答|未接听|无应答/.test(status)) return '未接听'
  return '未接通'
}

/** 一条通话的摘要，例如「视频通话 · 21分08秒 · 呼出 · 已接听」。 */
function callSnippet(record: CallHistoryRecord): string {
  const parts = [callKind(record)]
  if (record.durationSec !== undefined) parts.push(formatDurationClock(record.durationSec))
  parts.push(record.outgoing ? '呼出' : '呼入')
  parts.push(callOutcome(record))
  return parts.join(' · ')
}

/** `order` 参数：recent = 最新优先（默认）；duration = 时长从长到短；count = 通话多的对方优先。 */
type CallOrder = 'recent' | 'duration' | 'count'

/**
 * 按工具参数排序。
 *
 * `count` 的口径是「对方通话次数」而不是「本条时长」：问「跟谁通话最多」时，
 * 用户要的是把高频对方排前面；同一对方内部再按时间倒序，保证结果可解释。
 */
function orderRecords(records: readonly CallHistoryRecord[], order: CallOrder): CallHistoryRecord[] {
  const out = [...records]
  if (order === 'duration') {
    out.sort((a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0) || b.createTime - a.createTime)
    return out
  }
  if (order === 'count') {
    const counts = new Map<string, number>()
    for (const r of out) counts.set(r.username, (counts.get(r.username) ?? 0) + 1)
    out.sort((a, b) =>
      (counts.get(b.username) ?? 0) - (counts.get(a.username) ?? 0)
      || b.createTime - a.createTime)
    return out
  }
  out.sort((a, b) => b.createTime - a.createTime || b.localId - a.localId)
  return out
}

/** 区间文案：`全部时间` / `A ~ B` / `A 起` / `截至 B`。 */
function rangeLabelOf(from: string, to: string): string {
  if (from && to) return `${from} ~ ${to}`
  if (from) return `${from} 起`
  if (to) return `截至 ${to}`
  return '全部时间'
}

/** 查询本机通话记录（次数/接通/未接/时长/呼入呼出）。 */
export const getCallHistoryTool: RetrievalTool = {
  name: 'get_call_history',
  category: 'message',
  description:
    '查本机通话记录（语音/视频），可按对方与日期过滤，并给出次数、接通/未接、时长与呼入呼出统计。'
    + '适用于「最近跟谁通过话」「和李四打了几次电话」「上个月通话时长」「谁给我打电话最多」这类问题。'
    + '注意：通话记录**不在聊天检索索引里**，问通话必须用本工具，不要用 search_messages。'
    + '不用于聊天文字、转账或通话内容（本机没有录音）。',
  parameters: {
    type: 'object',
    properties: {
      peer: { type: 'string', description: '对方显示名或 username（不填 = 全部）' },
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（本地时区，含当天）' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD（本地时区，含当天）' },
      order: {
        type: 'string',
        enum: ['recent', 'duration', 'count'],
        description: 'recent = 最近优先（默认）；duration = 通话时长从长到短；count = 通话次数多的对方优先',
      },
      limit: { type: 'number', description: '最多返回几条通话（默认 20，上限 100）' },
    },
  },
  run: async (args, ctx): Promise<ToolResult> => {
    const started = Date.now()
    if (ctx.signal?.aborted === true) {
      return { tool: 'get_call_history', ok: false, hits: [], error: '已取消', elapsedMs: 0 }
    }
    // `ctx.scope` 是服务端锁定的硬范围，优先级高于模型参数（与其余工具同策略）。
    const from = (ctx.scope?.from || argString(args['from'])).trim()
    const to = (ctx.scope?.to || argString(args['to'])).trim()
    const peer = (ctx.scope?.username || argString(args['peer'])).trim()
    const orderArg = argString(args['order'], 'recent').trim().toLowerCase()
    const order: CallOrder = orderArg === 'duration' ? 'duration' : orderArg === 'count' ? 'count' : 'recent'
    const limit = argInt(args['limit'], 20, 1, 100)

    const lo = from ? dayBoundSec(from, false) : null
    if (from && lo === null) {
      return {
        tool: 'get_call_history', ok: false, errorCode: 'invalid_arguments',
        error: `from 不是合法日期：${from}（需要 YYYY-MM-DD）`,
        errorDetails: { param: 'from' }, hits: [],
      }
    }
    const hi = to ? dayBoundSec(to, true) : null
    if (to && hi === null) {
      return {
        tool: 'get_call_history', ok: false, errorCode: 'invalid_arguments',
        error: `to 不是合法日期：${to}（需要 YYYY-MM-DD）`,
        errorDetails: { param: 'to' }, hits: [],
      }
    }
    if (from && to && lo !== null && hi !== null && lo > hi) {
      return {
        tool: 'get_call_history', ok: false, errorCode: 'invalid_arguments',
        error: 'from 不能晚于 to', errorDetails: { param: 'from' }, hits: [],
      }
    }

    const meta = contactMeta(ctx.decryptedDir)
    const identity = messageIdentityIndex(ctx.decryptedDir, ['message'])
    const names = mergeDisplayNames(ctx.decryptedDir, identity.usernames)
    const peers = peer
      ? resolvePeerUsernames(ctx.decryptedDir, peer, names, identity.usernames, meta)
      : undefined
    // 只有**显式给了日期**才传范围。`0` 不是「不限」而在 SQL 里是真实的
    // `create_time <= 0`（1970 前），会把全部记录过滤掉 —— 一个不报错的空结果。
    const fromSec = from && lo !== null ? lo : undefined
    const toSec = to && hi !== null ? hi : undefined
    // 登录账号用来区分呼入/呼出。工具层自己解析一次（ctx 里没有 self）：
    // `resolveSelfUsername` 先看环境变量再看配置，带文件签名缓存，重复调用不贵。
    const self = resolveSelfUsername(ctx.decryptedDir).trim()
    const rangeLabel = rangeLabelOf(from, to)

    let result: CallsQueryResult
    try {
      result = await queryCalls(ctx.decryptedDir, self, 20, limit, {
        ...(fromSec !== undefined ? { fromSec } : {}),
        ...(toSec !== undefined ? { toSec } : {}),
        ...(peers ? { peers } : {}),
        maxRows: CALL_SCAN_MAX_ROWS,
        maxMs: CALL_SCAN_MAX_MS,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
    } catch (e) {
      const msg = e instanceof Error && e.message !== '' ? e.message : String(e)
      return { tool: 'get_call_history', ok: false, hits: [], error: `读取通话记录失败：${msg}` }
    }

    // 进入扫描前的取消已在上面提前返回；这里只需要看扫描过程中是否被取消
    // （`ctx.signal` 在 await 期间可能变化，TypeScript 不能建模，但 scan 会记录）。
    if (result.scan.cancelled) {
      // 取消不是「没有数据」：返回失败，避免半份统计被模型当成完整答案引用。
      return {
        tool: 'get_call_history', ok: false, hits: [],
        error: '已取消（通话记录扫描未完成）',
        elapsedMs: Date.now() - started,
      }
    }

    if (result.total === 0) {
      return {
        tool: 'get_call_history', ok: true, hits: [], facts: [],
        note: `没有找到通话记录（${rangeLabel}${peer ? ` · 对方 ${peer}` : ''}）`,
        elapsedMs: Date.now() - started,
      }
    }

    const ordered = orderRecords(result.records, order)
    const hits: ToolHit[] = ordered.slice(0, limit).map((record) => {
      const enterpriseName = meta.enterpriseNames.get(record.username)?.trim()
      return {
        key: `${record.username}:${record.localId}`,
        name: peerLabel(record.username, names, meta),
        ...(enterpriseName ? { enterpriseName } : {}),
        time: fmtDateTimeSec(record.createTime),
        snippet: callSnippet(record),
        source: 'msg',
        trace: { kind: 'msg', username: record.username, localId: record.localId },
      }
    })

    const top = result.peers[0]
    const topText = top
      ? `；TOP 对方 ${peerLabel(top.username, names, meta)} ${top.calls} 次 / ${formatDurationSpan(top.durationSec)}`
      : ''
    const facts = [{
      title: `通话总览（${rangeLabel}）`,
      body: `${result.total} 次，接通 ${result.connected}，未接/拒接 ${result.missed}，`
        + `总时长 ${formatDurationSpan(result.durationSec)}；`
        + `呼出 ${result.outgoing} / 呼入 ${result.incoming}${topText}`,
    }]

    // 截断必须显式写出来：它直接决定模型该不该把「N 次」当成精确总数。
    const scanText = result.scan.truncated
      ? `达到${result.scan.truncationReason === 'time' ? '时间' : '行数'}预算，`
        + `只检查了前 ${result.scan.scannedRows} 条 type-50 行`
        + '（按分片/表顺序，不保证覆盖最近的通话），统计可能不完整'
      : `完整检查 ${result.scan.scannedRows} 条 type-50 行`
    const orderText = order === 'duration' ? '按时长倒序' : order === 'count' ? '按对方通话次数' : '按时间倒序'
    const selfText = self === '' ? ' · 未解析到登录账号，呼入/呼出可能不准' : ''
    return {
      tool: 'get_call_history', ok: true, hits, facts,
      note: `区间 ${rangeLabel}${peer ? ` · 对方 ${peer}` : ''} · `
        + '口径：接通含「已在其它设备接听」，时长只计本机有记录的接通通话 · '
        + `${scanText} · ${orderText}返回 ${hits.length} 条${selfText}`,
      elapsedMs: Date.now() - started,
    }
  },
}

/** 通话类工具集。 */
export const CALLS_TOOLS: readonly RetrievalTool[] = [getCallHistoryTool]
