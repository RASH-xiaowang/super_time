/**
 * 资金账本工具（`get_funds_summary`，2026-11 新增）。
 *
 * ## 为什么不能只靠 `search_records`
 *
 * `search_records` 返回的是**记录条目壳**（会话、单号、时间），没有金额、方向与状态。
 * 而「我一共收到多少转账」「跟谁资金往来最多」「最近几笔红包有没有退回」这类问题
 * 需要的是**确定性统计 + 逐笔证据**：
 *   · 金额来自消息卡片的 `feedesc`（资金表本身不存金额）；
 *   · 方向取决于当前账号是付款人还是收款人；
 *   · 状态只有本地系统消息（领取/退回）能证明，不能靠 `hb_status` 猜。
 *
 * 这些计算已经在 `query/ledger.ts` 里做了一遍（面板和问答必须同一口径），
 * 本文件只做**工具包装**：参数校验、范围换算、事实文案与命中整形。
 *
 * ## 诚实性约定
 *
 *   · `general.db` 不存在 = 还没解密到资金库，返回 `not_configured`，绝不伪装成 0 条；
 *   · 红包时间无法从消息卡片证明时，回退「全部时间统计」并在事实里标注；
 *   · 金额解析不出来时写「金额未知」，不用 0 顶替；
 *   · 状态只展示本地证据能支撑的结论，其余写「状态未确认」。
 *
 * @module query/tools/funds-tools
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveSelfUsername } from '../../config/resolve.ts'
import { fmtDateTimeSec } from '../../format.ts'
import { isLedgerCanceled, queryLedgerRange, type LedgerContactTotal, type LedgerFundRecord } from '../ledger.ts'
import { ymdLocal } from '../retrieval/aggregate.ts'
import { argInt, argString, type RetrievalTool, type ToolHit, type ToolResult } from './types.ts'

/** 资金库缺失时的人话说明（与 records 面板同一句，避免两处各说一套）。 */
const NOT_CONFIGURED_MESSAGE = '还没有资金往来数据（general.db 不存在）：请先完成解密或在微信打开过转账/红包页面'

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/

/** 严格解析 `YYYY-MM-DD`，拒绝 `2026-02-30` 这类会被 Date 滚动的日期。 */
function dayBounds(value: string): { start: number; end: number } | undefined {
  const match = DAY_RE.exec(value)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1970 || year > 9999) return undefined
  const probe = new Date(year, month - 1, day, 0, 0, 0)
  if (probe.getFullYear() !== year || probe.getMonth() !== month - 1 || probe.getDate() !== day) {
    return undefined
  }
  const start = Math.floor(probe.getTime() / 1000)
  // 用 23:59:59 的 Date 而不是 start + 86399：夏令时切换日不是 24 小时。
  const end = Math.floor(new Date(year, month - 1, day, 23, 59, 59).getTime() / 1000)
  return { start, end }
}

/** 严格解析 `YYYY-MM`，返回本地时区的月初 00:00 与月末 23:59:59。 */
function monthBounds(value: string): { start: number; end: number } | undefined {
  const match = MONTH_RE.exec(value)
  if (!match) return undefined
  const year = Number(match[1])
  const month = Number(match[2])
  if (year < 1970 || year > 9999) return undefined
  const start = Math.floor(new Date(year, month - 1, 1, 0, 0, 0).getTime() / 1000)
  const end = Math.floor(new Date(year, month, 1, 0, 0, 0).getTime() / 1000) - 1
  return { start, end }
}

/** 统计区间的人类可读标签。 */
function rangeLabel(from: number, to: number): string {
  if (from > 0 && to > 0) return `${ymdLocal(from)} ~ ${ymdLocal(to)}`
  if (from > 0) return `${ymdLocal(from)} 起`
  if (to > 0) return `截至 ${ymdLocal(to)}`
  return '全部时间'
}

/** 整数分 → `¥1,234.56`（负数保留符号；绝不用浮点直接拼金额）。 */
function fmtCents(cents: number): string {
  const value = Number.isFinite(cents) ? Math.trunc(cents) : 0
  const negative = value < 0
  const abs = Math.abs(value)
  const whole = Math.floor(abs / 100)
  const fraction = abs % 100
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}¥${grouped}.${String(fraction).padStart(2, '0')}`
}

/** 元（快照里的两位小数数值）→ 带千分位的 `¥` 文案。 */
function fmtYuan(value: number): string {
  return fmtCents(Math.round((Number.isFinite(value) ? value : 0) * 100))
}

/** 本地布尔解析：模型可能给 `"false"` / `0` / `null`。 */
function argBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (value === 'true' || value === '1' || value === 1) return true
  if (value === 'false' || value === '0' || value === 0) return false
  return fallback
}

/** 失败结果（参数问题与数据问题分开）。 */
function failure(errorCode: 'invalid_arguments' | 'not_configured' | 'upstream_failure', error: string): ToolResult {
  return { tool: 'get_funds_summary', ok: false, errorCode, error, hits: [] }
}

/** 取消结果：不是数据读失败，必须让调用方看见「已取消」。 */
function canceled(): ToolResult {
  return failure('upstream_failure', '资金统计已取消')
}

/**
 * 状态文案。
 *
 * 转账的 `pay_sub_type` 在本仓库没有权威映射（面板也只显示原始值），所以只有
 * `invalid_time > 0` 才能说「已失效」；其余按资金表已确认的方向显示「已收款/已转账」
 * （与账本汇总的「收入/支出」同一口径）。红包则必须有本地领取/退回系统消息，
 * 其余一律「状态未确认」，不拿 `hb_status` 猜。
 */
function statusLabel(record: LedgerFundRecord): string {
  if (record.recordType === 'transfers') {
    if (record.status === 'invalid') return '已失效'
    if (record.direction === 'in') return '已收款'
    if (record.direction === 'out') return '已转账'
    return '状态未确认'
  }
  switch (record.status) {
    case 'received': return '已领取'
    case 'returned': return '已退回'
    case 'claimed-other': return '已被领完'
    case 'sent': return '已发出'
    default: return record.rawStatus !== undefined && record.rawStatus !== ''
      ? `状态未确认（原始状态 ${record.rawStatus}）`
      : '状态未确认'
  }
}

/** 命中摘要：必须同时含金额、方向与状态。 */
function snippetFor(record: LedgerFundRecord): string {
  const kind = record.recordType === 'transfers' ? '转账' : '红包'
  const direction = record.direction === 'in' ? '收入' : record.direction === 'out' ? '支出' : '方向未知'
  const amount = record.amountCents === null ? '金额未知' : fmtCents(record.amountCents)
  return `${kind} · ${direction} ${amount} · ${statusLabel(record)}`
}

/**
 * 把逐笔资金记录投影成可点击的资源命中（稳定键优先用单号 / 红包 send_id）。
 *
 * 会话内问答必须能证明「这条资源属于当前会话」：资金表里的 `session` 可能是
 * 历史 `Msg_<md5>` 表名或显示名，直接与锁定 username 比较会误判为越界。
 * 这里只在**服务端硬锁**存在时把锁定 username 写进定位（查询本身已按别名过滤），
 * 模型自己填的 username 不享受这个待遇。
 */
function toHit(record: LedgerFundRecord, scopedSession = ''): ToolHit {
  const identity = record.transferId || record.sendId || record.serverId
    || `${record.session}:${String(record.time)}`
  const key = `record:${record.recordType}:${identity}`
  const time = fmtDateTimeSec(record.time)
  const sourceId = record.transferId || record.sendId || record.serverId
    || `${record.recordType}:${record.session}:${String(record.time)}`
  return {
    key,
    name: record.name || (record.recordType === 'transfers' ? '转账记录' : '红包记录'),
    ...(record.enterpriseName !== undefined && record.enterpriseName !== ''
      ? { enterpriseName: record.enterpriseName }
      : {}),
    time,
    snippet: snippetFor(record),
    source: 'resource',
    trace: {
      kind: 'resource',
      resource: {
        resourceKind: 'record',
        stableKey: key,
        ...(time !== '' ? { time } : {}),
        ...(scopedSession !== ''
          ? { session: scopedSession, username: scopedSession }
          : record.session !== '' ? { session: record.session } : {}),
        ...(record.transferId !== undefined && record.transferId !== ''
          ? { transferId: record.transferId }
          : {}),
        ...(record.serverId !== undefined && record.serverId !== ''
          ? { serverId: record.serverId, messageServerId: record.serverId }
          : {}),
        sourceId,
        recordType: record.recordType,
      },
    },
  }
}

/** 第一条事实：区间总览。 */
function overviewFact(
  result: Awaited<ReturnType<typeof queryLedgerRange>>,
  range: string,
  includeAnomalies: boolean,
): { title: string; body: string } {
  const s = result.snapshot.summary
  const net = Math.round((s.totalAmountIn - s.totalAmountOut) * 100) / 100
  const anomaly = includeAnomalies ? `；异常 ${result.snapshot.warnings.length} 笔` : ''
  const unknown = (s.amountUnknownCount ?? 0) > 0
    ? `；另有 ${String(s.amountUnknownCount)} 笔金额未知（未计入合计）`
    : ''
  // 红包时间不可证明时不能把它说成「这个区间内的红包」；标注在总览里最显眼。
  const degraded = result.redpacketsAllTime ? '；红包按全部时间统计（本地无法证明部分红包时间）' : ''
  return {
    title: `资金总览（区间 ${range}）`,
    body: `转账 ${String(s.transfers)} 笔，收入 ${fmtYuan(s.totalAmountIn)}，支出 ${fmtYuan(s.totalAmountOut)}，净额 ${fmtYuan(net)}；`
      + `红包收 ${String(s.redpacketsReceived)} 个 ${fmtYuan(s.redpacketAmountReceived)} / 发 ${String(s.redpacketsSent)} 个 ${fmtYuan(s.redpacketAmountSent)}`
      + anomaly + unknown + degraded,
  }
}

/** 第二条事实：按人 TOP（金额已按联系人合并，未截断的汇总由账本提供）。 */
function contactFact(totals: readonly LedgerContactTotal[], top: number): { title: string; body: string } {
  const lines = totals.slice(0, top).map((row, index) =>
    `${String(index + 1)}. ${row.name || row.username} 收 ${fmtCents(row.amountInCents)} / 支 ${fmtCents(row.amountOutCents)}（${String(row.count)} 笔）`,
  )
  return {
    title: '按人 TOP',
    body: lines.length > 0
      ? lines.join('\n')
      : '暂无可归属到联系人的金额（金额未知或与当前账号无关的记录不计入排行）',
  }
}

/** 可选事实：本地证据明确的资金异常（红包退回等）。 */
function anomalyFact(
  warnings: Awaited<ReturnType<typeof queryLedgerRange>>['snapshot']['warnings'],
  top: number,
): { title: string; body: string } {
  const lines = warnings.slice(0, top).map((warning) => {
    const amount = warning.amount === undefined ? '金额未知' : fmtYuan(warning.amount)
    const who = warning.name ?? warning.username ?? '未知'
    const at = warning.time === undefined || warning.time <= 0 ? '' : ` · ${fmtDateTimeSec(warning.time)}`
    return `${warning.label} · ${who} · ${amount}${at}`
  })
  return { title: '异常提醒', body: lines.join('\n') }
}

/** 是否真的有「匹配到的资金记录」；全空时按契约返回 facts: []。 */
function hasAnyRecord(result: Awaited<ReturnType<typeof queryLedgerRange>>): boolean {
  const s = result.snapshot.summary
  return s.transfers > 0
    || s.redpacketsSent > 0
    || s.redpacketsReceived > 0
    || (s.amountUnknownCount ?? 0) > 0
    || (s.redpacketUnconfirmedCount ?? 0) > 0
    || (s.transferThirdPartyCount ?? 0) > 0
    || result.snapshot.warnings.length > 0
    || result.records.length > 0
}

/** 资金账本汇总工具。 */
export const getFundsSummaryTool: RetrievalTool = {
  name: 'get_funds_summary',
  category: 'aggregate',
  description:
    '汇总**转账与红包**的资金往来：笔数、收入/支出金额、净额、按联系人排行、红包收发与异常，并附最近几笔明细（金额/方向/状态）。'
    + '适用于「我一共收到多少转账」「这个月红包收了多少」「跟谁资金往来最多」「最近有没有红包退回」。'
    + '**不要用 search_records 去数笔数或加总金额** —— 它只返回记录条目，没有金额与方向。',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: '起始日期 YYYY-MM-DD（本地时区，含当天；不填 = 不限）' },
      to: { type: 'string', description: '截止日期 YYYY-MM-DD（本地时区，含当天；不填 = 不限）' },
      month: { type: 'string', description: '月份 YYYY-MM（与 from/to 二选一；同时给时以 from/to 为准）' },
      username: { type: 'string', description: '限定联系人或会话（不填 = 全部；会话内问答由服务端强制，不能覆盖）' },
      direction: {
        type: 'string',
        enum: ['all', 'in', 'out'],
        description: '方向：all=全部（默认），in=只看收入，out=只看支出',
      },
      kind: {
        type: 'string',
        enum: ['all', 'transfer', 'redpacket'],
        description: '类型：all=全部（默认），transfer=只看转账，redpacket=只看红包',
      },
      top: { type: 'number', description: '按人排行与最近明细的条数（默认 10，上限 30）' },
      includeAnomalies: { type: 'boolean', description: '是否包含异常提醒（默认 true）' },
    },
  },
  run: async (args, ctx): Promise<ToolResult> => {
    const started = Date.now()
    const top = argInt(args['top'], 10, 1, 30)
    const directionRaw = argString(args['direction']).trim().toLowerCase()
    const direction = directionRaw === 'in' || directionRaw === 'out' ? directionRaw : undefined
    const kindRaw = argString(args['kind']).trim().toLowerCase()
    const kind = kindRaw === 'transfer' || kindRaw === 'redpacket' ? kindRaw : undefined
    const includeAnomalies = argBoolean(args['includeAnomalies'], true)
    // 执行上下文里的范围是服务端锁定值，不能被模型参数覆盖。
    const username = (ctx.scope?.username ?? '').trim() || argString(args['username']).trim()
    const fromText = (ctx.scope?.from ?? '').trim() || argString(args['from']).trim()
    const toText = (ctx.scope?.to ?? '').trim() || argString(args['to']).trim()
    const month = argString(args['month']).trim()

    // 区间优先级：服务端/模型显式 from/to > month > 全部时间。
    let fromSec = 0
    let toSec = 0
    if (fromText !== '' || toText !== '') {
      if (fromText !== '') {
        const bounds = dayBounds(fromText)
        if (bounds === undefined) {
          return failure('invalid_arguments', `from 必须是合法的 YYYY-MM-DD（收到「${fromText}」）`)
        }
        fromSec = bounds.start
      }
      if (toText !== '') {
        const bounds = dayBounds(toText)
        if (bounds === undefined) {
          return failure('invalid_arguments', `to 必须是合法的 YYYY-MM-DD（收到「${toText}」）`)
        }
        toSec = bounds.end
      }
      if (fromSec > 0 && toSec > 0 && fromSec > toSec) {
        return failure('invalid_arguments', 'from 不能晚于 to')
      }
    } else if (month !== '') {
      const bounds = monthBounds(month)
      if (bounds === undefined) {
        return failure('invalid_arguments', `month 必须是合法的 YYYY-MM（收到「${month}」）`)
      }
      fromSec = bounds.start
      toSec = bounds.end
    }

    if (ctx.signal?.aborted === true) return canceled()

    // 库不存在不是「0 条」：这是配置/解密状态问题，必须让用户知道去哪儿处理。
    if (!existsSync(join(ctx.decryptedDir, 'general', 'general.db'))) {
      return failure('not_configured', NOT_CONFIGURED_MESSAGE)
    }

    try {
      // 方向需要知道「我是谁」。装配层若已经把当前账号放进上下文（运行期扩展字段）
      // 就直接用，避免每次问答都重新扫配置；否则按标准入口解析。
      const injectedSelf = (ctx as { selfUsername?: unknown }).selfUsername
      const selfUsername = typeof injectedSelf === 'string' && injectedSelf.trim() !== ''
        ? injectedSelf.trim()
        : resolveSelfUsername(ctx.decryptedDir)
      const result = await queryLedgerRange(ctx.decryptedDir, {
        from: fromSec,
        to: toSec,
        ...(username !== '' ? { username } : {}),
        ...(direction !== undefined ? { direction } : {}),
        ...(kind !== undefined ? { kind } : {}),
        includeWarnings: includeAnomalies,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      }, { selfUsername })
      if (!result.generalExists) return failure('not_configured', NOT_CONFIGURED_MESSAGE)

      const hasAny = hasAnyRecord(result)
      // 读失败与「确实没有记录」必须分开：空结果 + readError 不能悄悄答 0 笔。
      if (!hasAny && result.snapshot.readError !== undefined && result.snapshot.readError !== '') {
        return failure('upstream_failure', `资金记录读取失败（与「没有记录」不同）：${result.snapshot.readError}`)
      }

      const range = rangeLabel(fromSec, toSec)
      const records = [...result.records].sort((a, b) => {
        const at = a.time > 0 ? a.time : -1
        const bt = b.time > 0 ? b.time : -1
        return bt - at || a.recordType.localeCompare(b.recordType)
      })
      const scopedSession = (ctx.scope?.username ?? '').trim()
      const hits = records.slice(0, top).map(record => toHit(record, scopedSession))

      const facts: Array<{ title: string; body: string }> = []
      if (hasAny) {
        facts.push(overviewFact(result, range, includeAnomalies))
        facts.push(contactFact(result.contactTotals, top))
        if (includeAnomalies && result.snapshot.warnings.length > 0) {
          facts.push(anomalyFact(result.snapshot.warnings, top))
        }
      }

      const filters: string[] = []
      if (direction !== undefined) filters.push(direction === 'in' ? '仅收入' : '仅支出')
      if (kind !== undefined) filters.push(kind === 'transfer' ? '仅转账' : '仅红包')
      if (username !== '') filters.push('已限定联系人或会话')
      const degraded = result.redpacketsAllTime ? '；红包按全部时间统计（本地无法证明部分红包时间）' : ''
      const selfNote = selfUsername === '' ? '；未能确定当前账号，收/支方向可能不完整' : ''
      const readNote = result.snapshot.readError !== undefined && result.snapshot.readError !== ''
        ? `；${result.snapshot.readError}（结果可能不完整）`
        : ''
      const emptyNote = hasAny ? '' : '；该区间内没有资金往来记录'
      const note = `统计区间：${range} · 本地时区 · 含端点`
        + (filters.length > 0 ? ` · ${filters.join(' · ')}` : '')
        + degraded + selfNote + readNote + emptyNote

      return {
        tool: 'get_funds_summary',
        ok: true,
        hits,
        facts,
        note,
        elapsedMs: Date.now() - started,
      }
    } catch (e) {
      if (isLedgerCanceled(e)) return canceled()
      return failure('upstream_failure', `资金统计失败：${(e as Error)?.message ?? String(e)}`)
    }
  },
}

/** 资金类工具集。 */
export const FUNDS_TOOLS: readonly RetrievalTool[] = [getFundsSummaryTool]
