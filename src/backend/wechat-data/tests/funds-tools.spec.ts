/**
 * `get_funds_summary` 的行为判据。
 *
 * 这个工具的价值在「确定性数字」：金额来自消息卡片、方向来自当前账号、状态只来自
 * 本地证据。测试用最小 `general.db` + 消息分片复现这三条链路，重点钉住：
 *   · facts 的金额/笔数必须与逐笔命中一致；
 *   · direction / month / from-to 过滤不能把范围外数据混进来；
 *   · `general.db` 缺失必须报 not_configured，而不是伪装成「0 条」；
 *   · 红包时间无法证明时回退全部时间并**如实标注**，不能直接报空。
 *
 * @vitest-environment node
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getFundsSummaryTool } from '../src/query/tools/funds-tools.ts'
import type { ToolContext, ToolResult } from '../src/query/tools/types.ts'

const SELF = 'wxid_me'
const scratch: string[] = []
const previousSelf = process.env['DSH_WECHAT_SELF_WXID']

beforeEach(() => {
  process.env['DSH_WECHAT_SELF_WXID'] = SELF
})

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
  if (previousSelf === undefined) delete process.env['DSH_WECHAT_SELF_WXID']
  else process.env['DSH_WECHAT_SELF_WXID'] = previousSelf
})

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wx-funds-'))
  scratch.push(dir)
  return dir
}

function makeDb(path: string, create: (db: DatabaseSync) => void): void {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { create(db) } finally { db.close() }
}

/** 本地时区某天中午的 epoch 秒。 */
function at(year: number, month: number, day: number): number {
  return Math.floor(new Date(year, month - 1, day, 12, 0, 0).getTime() / 1000)
}

const SEPT = (day: number): number => at(2026, 9, day)
const AUG = (day: number): number => at(2026, 8, day)

function transferXml(amount: string): string {
  return `<msg><appmsg><type>2000</type><wcpayinfo><paysubtype>3</paysubtype><feedesc>￥${amount}</feedesc></wcpayinfo></appmsg></msg>`
}

function redpacketXml(amount: string): string {
  return `<msg><appmsg><type>2001</type><wcpayinfo><feedesc>￥${amount}</feedesc></wcpayinfo></appmsg></msg>`
}

function claimXml(sendId: string): string {
  return `<img src="SystemMessages_HongbaoIcon.png"/> 你领取了张三的<wc_custom_link href="weixin://weixinhongbao/opendetail?sendid=${sendId}&sign=test">红包</wc_custom_link>`
}

function returnedXml(sendId: string): string {
  return `<img src="SystemMessages_HongbaoIcon.png"/> 超过24小时未领取，红包已退回 <wc_custom_link href="weixin://weixinhongbao/opendetail?sendid=${sendId}&sign=test">红包</wc_custom_link>`
}

interface FixtureOptions {
  /** 额外加一位联系人 wxid_b + 一笔转给当前账号的转账（用于 username 过滤）。 */
  extraContact?: boolean
  /** 是否写入红包消息卡片；false 时红包行没有可证明的时间/金额（降级用例）。 */
  redpacketCards?: boolean
}

/**
 * 造一份最小资金数据：
 *   · 9 月：收入转账 10、支出转账 20、失效支出转账 5；红包发 8.88、收 6.66、退回 4.00；
 *   · 8 月：支出转账 7（用于验证 month/from-to 不越界）。
 */
function makeFundsDir(options: FixtureOptions = {}): string {
  const root = tempRoot()
  const { extraContact = false, redpacketCards = true } = options
  const session = 'wxid_a'
  const msgTable = 'Msg_' + createHash('md5').update(session, 'utf8').digest('hex')

  makeDb(join(root, 'contact', 'contact.db'), (db) => {
    db.exec('CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, remark TEXT, nick_name TEXT)')
    const insert = db.prepare('INSERT INTO contact (id, username, remark, nick_name) VALUES (?, ?, ?, ?)')
    insert.run(1, session, '张三', 'zhangsan')
    insert.run(2, SELF, '我', 'me')
    if (extraContact) insert.run(3, 'wxid_b', '李四', 'lisi')
  })

  makeDb(join(root, 'general', 'general.db'), (db) => {
    db.exec(`CREATE TABLE transferTable (
      session_name TEXT, message_server_id INTEGER, second_message_server_id INTEGER,
      transfer_id TEXT, pay_receiver TEXT, pay_payer TEXT,
      begin_transfer_time INTEGER, last_modified_time INTEGER, invalid_time INTEGER,
      pay_sub_type INTEGER, delay_confirm_flag INTEGER
    )`)
    db.exec(`CREATE TABLE redEnvelopeTable (
      session_name TEXT, message_server_id INTEGER, sender_user_name TEXT,
      send_id TEXT, hb_status INTEGER, receive_status INTEGER
    )`)
    const transfer = db.prepare('INSERT INTO transferTable VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    // 收入：张三 -> 我
    transfer.run(session, 1001, 0, 'tr-in', SELF, session, SEPT(1), SEPT(1), 0, 3, 0)
    // 支出：我 -> 张三
    transfer.run(session, 1002, 0, 'tr-out', session, SELF, SEPT(2), SEPT(2), 0, 3, 0)
    // 支出但已失效
    transfer.run(session, 1003, 0, 'tr-invalid', session, SELF, SEPT(3), SEPT(4), SEPT(4), 3, 0)
    // 上月支出（范围外）
    transfer.run(session, 1004, 0, 'tr-aug', session, SELF, AUG(15), AUG(15), 0, 3, 0)
    if (extraContact) {
      // 李四 -> 我（username 过滤用例）；会话也属于李四，避免「同会话里出现第三人」干扰口径。
      transfer.run('wxid_b', 1005, 0, 'tr-b', SELF, 'wxid_b', SEPT(7), SEPT(7), 0, 3, 0)
    }
    const redpacket = db.prepare('INSERT INTO redEnvelopeTable VALUES (?, ?, ?, ?, ?, ?)')
    redpacket.run(session, 2001, SELF, 'rp-out', 1, 1)
    redpacket.run(session, 2002, 'wxid_a', 'rp-in', 1, 1)
    redpacket.run(session, 2003, SELF, 'rp-returned', 1, 1)
  })

  makeDb(join(root, 'message', 'message_1.db'), (db) => {
    db.exec(`CREATE TABLE "${msgTable}" (
      local_id INTEGER, create_time INTEGER, local_type INTEGER,
      message_content TEXT, server_id INTEGER
    )`)
    const insert = db.prepare(`INSERT INTO "${msgTable}" VALUES (?, ?, ?, ?, ?)`)
    const transfers: Array<[number, number, string]> = [
      [1, 1001, '10.00'],
      [2, 1002, '20.00'],
      [3, 1003, '5.00'],
      [4, 1004, '7.00'],
    ]
    if (extraContact) transfers.push([5, 1005, '30.00'])
    for (const [localId, serverId, amount] of transfers) {
      const day = serverId === 1004 ? AUG(15) : serverId === 1005 ? SEPT(7) : SEPT(serverId - 1000)
      insert.run(localId, day, 49, transferXml(amount), serverId)
    }
    if (redpacketCards) {
      insert.run(101, SEPT(4), 49, redpacketXml('8.88'), 2001)
      insert.run(102, SEPT(5), 49, redpacketXml('6.66'), 2002)
      insert.run(103, SEPT(6), 49, redpacketXml('4.00'), 2003)
    }
    // 领取 / 退回证据：只有这两个系统消息能证明红包状态。
    insert.run(201, SEPT(5), 10000, claimXml('rp-in'), 0)
    insert.run(202, SEPT(6), 10000, returnedXml('rp-returned'), 0)
  })

  return root
}

async function run(args: Record<string, unknown>, ctx?: Partial<ToolContext>): Promise<ToolResult> {
  return getFundsSummaryTool.run(args, {
    decryptedDir: scratch[scratch.length - 1] ?? '',
    ...ctx,
  })
}

function bodies(result: ToolResult): string {
  return (result.facts ?? []).map(fact => `${fact.title}\n${fact.body}`).join('\n')
}

describe('get_funds_summary：正常统计', () => {
  it('汇总转账与红包金额/笔数，并返回含金额、方向、状态的最近明细', async () => {
    const root = makeFundsDir()
    const result = await run({ month: '2026-09' }, { decryptedDir: root })

    expect(result.ok, result.error ?? '').toBe(true)
    expect(result.errorCode).toBeUndefined()
    expect(result.hits).toHaveLength(6)

    const factText = bodies(result)
    expect(factText).toContain('资金总览（区间')
    expect(factText).toContain('转账 3 笔')
    expect(factText).toContain('收入 ¥16.66')
    expect(factText).toContain('支出 ¥33.88')
    expect(factText).toContain('净额 -¥17.22')
    expect(factText).toContain('红包收 1 个 ¥6.66 / 发 2 个 ¥8.88')
    expect(factText).toContain('异常 1 笔')
    expect(factText).toContain('张三 收 ¥16.66 / 支 ¥33.88（5 笔）')

    const inTransfer = result.hits.find(hit => hit.trace?.resource?.transferId === 'tr-in')
    expect(inTransfer?.snippet).toBe('转账 · 收入 ¥10.00 · 已收款')
    const claim = result.hits.find(hit => hit.trace?.resource?.sourceId === 'rp-in')
    expect(claim?.snippet).toBe('红包 · 收入 ¥6.66 · 已领取')
    const returned = result.hits.find(hit => hit.trace?.resource?.sourceId === 'rp-returned')
    expect(returned?.snippet).toBe('红包 · 支出 ¥4.00 · 已退回')
    const invalid = result.hits.find(hit => hit.trace?.resource?.transferId === 'tr-invalid')
    expect(invalid?.snippet).toBe('转账 · 支出 ¥5.00 · 已失效')

    for (const hit of result.hits) {
      expect(hit.source).toBe('resource')
      expect(hit.trace?.kind).toBe('resource')
      expect(hit.trace?.resource?.resourceKind).toBe('record')
      expect(hit.trace?.resource?.stableKey).toBe(hit.key)
      expect(hit.time).not.toBe('')
      expect(hit.snippet).toContain('¥')
    }
    expect(result.note ?? '').toContain('统计区间：2026-09-01 ~ 2026-09-30')
    expect(result.note ?? '').toContain('本地时区')
    expect(result.note ?? '').toContain('含端点')
  })

  it('direction=in / out 只统计对应方向', async () => {
    const root = makeFundsDir()

    const income = await run({ month: '2026-09', direction: 'in' }, { decryptedDir: root })
    expect(income.ok, income.error ?? '').toBe(true)
    expect(income.hits).toHaveLength(2)
    expect(income.hits.every(hit => hit.snippet.includes('收入'))).toBe(true)
    const incomeText = bodies(income)
    expect(incomeText).toContain('转账 1 笔')
    expect(incomeText).toContain('收入 ¥16.66')
    expect(incomeText).toContain('支出 ¥0.00')
    expect(incomeText).toContain('红包收 1 个 ¥6.66 / 发 0 个 ¥0.00')

    const expense = await run({ month: '2026-09', direction: 'out' }, { decryptedDir: root })
    expect(expense.ok, expense.error ?? '').toBe(true)
    expect(expense.hits).toHaveLength(4)
    expect(expense.hits.every(hit => hit.snippet.includes('支出'))).toBe(true)
    const expenseText = bodies(expense)
    expect(expenseText).toContain('转账 2 笔')
    expect(expenseText).toContain('支出 ¥33.88')
    expect(expenseText).toContain('红包收 0 个 ¥0.00 / 发 2 个 ¥8.88')
  })

  it('kind=transfer / redpacket 只统计对应类型', async () => {
    const root = makeFundsDir()
    const transfer = await run({ month: '2026-09', kind: 'transfer' }, { decryptedDir: root })
    expect(transfer.ok, transfer.error ?? '').toBe(true)
    expect(transfer.hits).toHaveLength(3)
    expect(transfer.hits.every(hit => hit.snippet.startsWith('转账'))).toBe(true)
    expect(bodies(transfer)).toContain('红包收 0 个 ¥0.00 / 发 0 个 ¥0.00')

    const redpacket = await run({ month: '2026-09', kind: 'redpacket' }, { decryptedDir: root })
    expect(redpacket.ok, redpacket.error ?? '').toBe(true)
    expect(redpacket.hits).toHaveLength(3)
    expect(redpacket.hits.every(hit => hit.snippet.startsWith('红包'))).toBe(true)
    expect(bodies(redpacket)).toContain('转账 0 笔')
  })
})

describe('get_funds_summary：区间', () => {
  it('month 与等价的 from/to 得到同一结果', async () => {
    const root = makeFundsDir()
    const byMonth = await run({ month: '2026-09' }, { decryptedDir: root })
    const byRange = await run({ from: '2026-09-01', to: '2026-09-30' }, { decryptedDir: root })

    expect(byMonth.ok, byMonth.error ?? '').toBe(true)
    expect(byRange.ok, byRange.error ?? '').toBe(true)
    expect(byRange.hits.map(hit => hit.key).sort()).toEqual(byMonth.hits.map(hit => hit.key).sort())
    expect(bodies(byRange)).toBe(bodies(byMonth))
    expect(byRange.note).toBe(byMonth.note)
  })

  it('from/to 与 month 同时给出时以 from/to 为准', async () => {
    const root = makeFundsDir()
    const result = await run({
      month: '2026-08',
      from: '2026-09-01',
      to: '2026-09-30',
    }, { decryptedDir: root })
    expect(result.ok, result.error ?? '').toBe(true)
    expect(bodies(result)).toContain('转账 3 笔')
    expect(result.hits).toHaveLength(6)
    expect(result.note ?? '').toContain('2026-09-01 ~ 2026-09-30')
  })

  it('只给 to 时按截止日期过滤（保留截止日之前、排除之后）', async () => {
    const root = makeFundsDir()
    const result = await run({ to: '2026-09-01' }, { decryptedDir: root })
    expect(result.ok, result.error ?? '').toBe(true)
    // 「截至 9/1」应包含 8 月与 9/1，但不包含 9/2、9/3。
    expect(bodies(result)).toContain('转账 2 笔')
    expect(bodies(result)).toContain('收入 ¥10.00')
    expect(bodies(result)).toContain('支出 ¥7.00')
    expect(result.hits).toHaveLength(2)
    expect(result.hits.map(hit => hit.snippet)).toEqual([
      '转账 · 收入 ¥10.00 · 已收款',
      '转账 · 支出 ¥7.00 · 已转账',
    ])
  })

  it('month=2026-08 不混入 9 月数据', async () => {
    const root = makeFundsDir()
    const result = await run({ month: '2026-08' }, { decryptedDir: root })
    expect(result.ok, result.error ?? '').toBe(true)
    expect(bodies(result)).toContain('转账 1 笔')
    expect(bodies(result)).toContain('支出 ¥7.00')
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.snippet).toBe('转账 · 支出 ¥7.00 · 已转账')
  })

  it('无效日期/月份返回 invalid_arguments', async () => {
    const root = makeFundsDir()
    for (const args of [
      { from: '2026-02-30' },
      { month: '2026-13' },
      { from: '2026-09-30', to: '2026-09-01' },
    ]) {
      const result = await run(args, { decryptedDir: root })
      expect(result.ok, JSON.stringify(args)).toBe(false)
      expect(result.errorCode).toBe('invalid_arguments')
      expect(result.hits).toEqual([])
    }
  })
})

describe('get_funds_summary：范围与降级', () => {
  it('general.db 缺失时返回 not_configured，而不是 0 条', async () => {
    const root = tempRoot()
    mkdirSync(join(root, 'contact'), { recursive: true })
    const result = await run({ month: '2026-09' }, { decryptedDir: root })
    expect(result.ok).toBe(false)
    expect(result.errorCode).toBe('not_configured')
    expect(result.error).toBe('还没有资金往来数据（general.db 不存在）：请先完成解密或在微信打开过转账/红包页面')
    expect(result.hits).toEqual([])
    expect(result.facts).toBeUndefined()
  })

  it('区间内没有记录时返回 ok:true + 空 hits/facts', async () => {
    const root = makeFundsDir()
    const result = await run({ from: '2020-01-01', to: '2020-12-31' }, { decryptedDir: root })
    expect(result.ok, result.error ?? '').toBe(true)
    expect(result.hits).toEqual([])
    expect(result.facts).toEqual([])
    expect(result.note ?? '').toContain('该区间内没有资金往来记录')
  })

  it('红包时间无法证明时回退全部时间统计并如实标注，而不是报空', async () => {
    const root = makeFundsDir({ redpacketCards: false })
    const result = await run({ from: '2020-01-01', to: '2020-12-31' }, { decryptedDir: root })

    expect(result.ok, result.error ?? '').toBe(true)
    expect(result.hits).toHaveLength(3)
    expect(bodies(result)).toContain('红包按全部时间统计')
    expect(result.note ?? '').toContain('红包按全部时间统计')
    // 金额在本地无法证明：明确写「金额未知」，不能写成 ¥0.00。
    expect(result.hits.some(hit => hit.snippet.includes('金额未知'))).toBe(true)
    expect(bodies(result)).toContain('红包收 1 个 ¥0.00 / 发 2 个 ¥0.00')
  })

  it('includeAnomalies=false 时不报告异常', async () => {
    const root = makeFundsDir()
    const result = await run({ month: '2026-09', includeAnomalies: false }, { decryptedDir: root })
    expect(result.ok, result.error ?? '').toBe(true)
    expect(bodies(result)).not.toContain('异常')
    expect(result.facts).toHaveLength(2)
  })

  it('取消信号在计算前已触发时返回「已取消」而不是崩溃', async () => {
    const root = makeFundsDir()
    const controller = new AbortController()
    controller.abort()
    const result = await run({ month: '2026-09' }, { decryptedDir: root, signal: controller.signal })
    expect(result.ok).toBe(false)
    expect(result.error ?? '').toContain('取消')
    expect(result.hits).toEqual([])
  })
})

describe('get_funds_summary：联系人与条数', () => {
  it('username 限定联系人或会话', async () => {
    const root = makeFundsDir({ extraContact: true })
    const result = await run({ month: '2026-09', username: 'wxid_b' }, { decryptedDir: root })
    expect(result.ok, result.error ?? '').toBe(true)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]?.snippet).toBe('转账 · 收入 ¥30.00 · 已收款')
    expect(bodies(result)).toContain('转账 1 笔')
    expect(bodies(result)).toContain('李四 收 ¥30.00 / 支 ¥0.00（1 笔）')
  })

  it('ctx.scope.username 优先于模型参数，不能被覆盖', async () => {
    const root = makeFundsDir({ extraContact: true })
    const result = await run(
      { month: '2026-09', username: 'wxid_b' },
      { decryptedDir: root, scope: { username: 'wxid_a' } },
    )
    expect(result.ok, result.error ?? '').toBe(true)
    expect(bodies(result)).toContain('转账 3 笔')
    expect(result.hits).toHaveLength(6)
    expect(result.hits.some(hit => hit.name === '李四')).toBe(false)
  })

  it('top 同时限制最近明细与按人排行', async () => {
    const root = makeFundsDir()
    const result = await run({ month: '2026-09', top: 2 }, { decryptedDir: root })
    expect(result.ok, result.error ?? '').toBe(true)
    expect(result.hits).toHaveLength(2)
    // 最近两笔：9/6 退回红包、9/5 领取红包。
    expect(result.hits.map(hit => hit.snippet)).toEqual([
      '红包 · 支出 ¥4.00 · 已退回',
      '红包 · 收入 ¥6.66 · 已领取',
    ])
  })
})
