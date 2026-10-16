/**
 * 转账/红包的权威状态（P1-7：`query/payments.ts` 此前零 spec 引用 —— 资金相关却无测）。
 *
 * ## 这一屏为什么值得单独钉
 *
 * 面板上「已收款 / 已退还 / 待确认」这类字样**不是**从消息 XML 里读的，而是从这里查
 * `general.db` 的 `transferTable` / `redEnvelopeTable`。也就是说：读错一行 = 把钱的状态
 * 说错。三类最容易出事的地方：
 *   ① `message_server_id` 在库里是整数，而消息侧传来的 id 是**字符串**（可能超过 2^53），
 *      比较必须两边都落到文本上 —— 少一个 CAST，就是「查无此单」；
 *   ② 大整数经 `Number()` 会静默丢精度，所以取回的 id/文本字段一律走字符串口径；
 *   ③ 「这份快照根本没有支付表」与「这次读失败了」是两件事：前者答 `found:false` 是对的
 *      （没这张表就是没有这笔单），后者**必须**继续抛出，不能被咽成「查无此单」
 *      —— 这正是 P1-1 立的那条契约。
 * @vitest-environment node
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryPaymentStatus } from '../src/query/payments.ts'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  scratch.length = 0
})

/**
 * 造一个带 general.db 的解密根。
 * @param rows - 转账行：`[message_server_id, transfer_id, delay_confirm_flag]`。
 * @param reds - 红包行：`[message_server_id, send_id]`。
 * @param opts - `onlyRed`/`noTables` 控制建哪张表。
 * @returns 解密根目录。
 */
function makeRoot(rows: Array<[number, string, number]> = [], reds: Array<[number, string]> = [], opts: { onlyRed?: boolean; noTables?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'payments-'))
  scratch.push(root)
  mkdirSync(join(root, 'general'), { recursive: true })
  const db = new DatabaseSync(join(root, 'general', 'general.db'))
  if (!opts.noTables) {
    if (!opts.onlyRed) {
      db.exec(`CREATE TABLE transferTable (
        message_server_id INTEGER, transfer_id TEXT, pay_sub_type INTEGER, pay_receiver TEXT, pay_payer TEXT,
        begin_transfer_time INTEGER, last_modified_time INTEGER, invalid_time INTEGER, delay_confirm_flag INTEGER)`)
      const ins = db.prepare('INSERT INTO transferTable VALUES (?,?,2,?, ?, 1700000000, 1700000060, 1700000900, ?)')
      for (const [sid, tid, dcf] of rows) ins.run(sid, tid, 'wxid_payee', 'wxid_payer', dcf)
    }
    db.exec('CREATE TABLE redEnvelopeTable (message_server_id INTEGER, sender_user_name TEXT, hb_status INTEGER, hb_type INTEGER, receive_status INTEGER, send_id TEXT)')
    const insRed = db.prepare('INSERT INTO redEnvelopeTable VALUES (?,?,3,1,2,?)')
    for (const [sid, sendId] of reds) insRed.run(sid, 'wxid_sender', sendId)
  }
  db.close()
  return root
}

describe('queryPaymentStatus：转账', () => {
  it('按 message_server_id 命中，字段逐个落位（金额状态是给人看的，取错列就是撒谎）', () => {
    const root = makeRoot([[7_000_000_000_001, 'TF20231114', 1]])
    const res = queryPaymentStatus(root, '7000000000001')
    expect(res.found).toBe(true)
    expect(res.kind).toBe('transfer')
    expect(res.serverId).toBe('7000000000001')
    expect(res.transfer).toMatchObject({
      transferId: 'TF20231114',
      paySubType: 2,
      receiver: 'wxid_payee',
      payer: 'wxid_payer',
      beginTime: 1_700_000_000,
      lastModifiedTime: 1_700_000_060,
      invalidTime: 1_700_000_900,
      delayConfirm: true,
    })
    // 转账优先：同一 id 两边都有时，先转账再红包（口径只能有一个）
  })

  it('id 是**超过 2^53 的整数列**也必须命中（少一个 CAST 就查不到，而这不是「没有这笔单」）', () => {
    const root = mkdtempSync(join(tmpdir(), 'payments-big-'))
    scratch.push(root)
    mkdirSync(join(root, 'general'), { recursive: true })
    const db = new DatabaseSync(join(root, 'general', 'general.db'))
    db.exec('CREATE TABLE transferTable (message_server_id INTEGER, transfer_id TEXT, pay_sub_type INTEGER, pay_receiver TEXT, pay_payer TEXT, begin_transfer_time INTEGER, last_modified_time INTEGER, invalid_time INTEGER, delay_confirm_flag INTEGER)')
    // 直接以文本存 id（真实库里两种形态都见过）
    db.prepare('INSERT INTO transferTable VALUES (?, ?, 2, ?, ?, 1700000000, 1700000000, 1700000000, 0)').run('9007199254740993', 'TF_big', 'a', 'b')
    db.close()
    expect(queryPaymentStatus(root, '9007199254740993').found, '大整数 id 查不到 ⇒ 这张单子永远显示「无状态」').toBe(true)
  })

  it('查不到 ⇒ found:false 且不带半截对象；空 id 也不炸', () => {
    const root = makeRoot([[1, 'TF1', 0]])
    expect(queryPaymentStatus(root, '999999')).toEqual({ found: false })
    expect(queryPaymentStatus(root, '')).toEqual({ found: false })
    expect(queryPaymentStatus(root, '1').transfer?.delayConfirm, 'flag=0 该读成 false').toBe(false)
  })
})

describe('queryPaymentStatus：红包与缺表', () => {
  it('转账表没有、红包表有 ⇒ 走红包分支（两表都在同一个库里，分支顺序不能反）', () => {
    const root = makeRoot([], [[42, 'SEND42']], { onlyRed: true })
    const res = queryPaymentStatus(root, '42')
    expect(res.kind).toBe('redpacket')
    expect(res.redpacket).toMatchObject({ sender: 'wxid_sender', hbStatus: 3, hbType: 1, receiveStatus: 2, sendId: 'SEND42' })
  })

  it('general.db 不存在 ⇒ found:false，不打日志也不抛（这台机器还没解密）', () => {
    const root = mkdtempSync(join(tmpdir(), 'payments-none-'))
    scratch.push(root)
    expect(queryPaymentStatus(root, '1')).toEqual({ found: false })
  })

  it('库在但两张支付表都没有 ⇒ found:false 并且**留一条 warn**（静默会让「支付状态永远空白」查不出原因）', () => {
    const root = makeRoot([], [], { noTables: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(queryPaymentStatus(root, '1')).toEqual({ found: false })
      expect(warn.mock.calls.map((c) => String(c[1] ?? '')).join(' '), '支付表缺失被完全咽掉了').toContain('transferTable')
    } finally { warn.mockRestore() }
  })

  it('真的读失败（库里是一张坏表/列缺失）不许被咽成「查无此单」—— P1-1 的契约', () => {
    const root = mkdtempSync(join(tmpdir(), 'payments-broken-'))
    scratch.push(root)
    mkdirSync(join(root, 'general'), { recursive: true })
    const file = join(root, 'general', 'general.db')
    // 一个存在但打不开成 sqlite 的文件：这不是「没有支付记录」，是读失败
    writeFileSync(file, 'not a database at all', 'utf8')
    expect(() => queryPaymentStatus(root, '1')).toThrow()
  })

  it('同一个数据根的同一张缺表只提醒一次（支付状态是按单查的，不封顶就是刷屏）', () => {
    const root = makeRoot([], [], { noTables: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      queryPaymentStatus(root, '1')
      queryPaymentStatus(root, '2')
      queryPaymentStatus(root, '3')
      const tables = warn.mock.calls.map((c) => String(c[1] ?? ''))
      expect(tables.filter((t) => t === 'transferTable').length, '每查一单提醒一次 ⇒ 支付面板一开就淹没日志').toBe(1)
    } finally { warn.mockRestore() }
  })
})
