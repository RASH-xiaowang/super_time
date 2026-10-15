// @vitest-environment node
/**
 * 问答「停止生成」的行为回归（W3-6.1）。
 *
 * 这条链路此前的缺口：`apiAskWechat` 悬挂时面板一直拒绝新提问（M13 记过），用户**只能等它跑完**。
 * 现在渲染层能点「停止生成」，本文件钉住后端这一侧的四件事：
 *   ① 取消必须命中**在飞**的那一轮（返回 ok）；
 *   ② 命中后这一轮以带 `code:'ASK_CANCELED'` 的错误结束 —— 面板据此把它显示成「已停止」而不是红色错误；
 *   ③ 取消之后轮次槽位被还回去：同一个 jobId 能再开一轮（否则每问一轮就漏一个槽位条目）；
 *   ④ 对**已经结束**的轮次取消返回 ok=false + 可读原因（用户点晚了要被告知，而不是假装成功）。
 *
 * 桩 LLM 的合成流刻意做成「可停在两个 chunk 之间」：取消必须由 `throwIfCanceled()`
 * 在流式循环里接住，而不是靠某个一次性检查蒙过去 —— 那样测不出「生成中途能不能停」。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildSearchIndex } from '../src/query/search.ts'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'

const scratch: string[] = []
const disposers: Array<() => void> = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
  for (const d of disposers) d()
  disposers.length = 0
  vi.unstubAllEnvs()
})

const LISI = 'wxid_lisi'

/** 造一个真实可检索的数据根（一条单聊 + 三条消息），索引由 `buildSearchIndex` 建。 */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-ask-cancel-'))
  scratch.push(root)
  const dec = join(root, 'decrypted')
  mkdirSync(join(dec, 'session'), { recursive: true })
  mkdirSync(join(dec, 'message'), { recursive: true })
  mkdirSync(join(dec, 'contact'), { recursive: true })

  const cdb = new DatabaseSync(join(dec, 'contact', 'contact.db'))
  cdb.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, flag INTEGER)')
  cdb.prepare('INSERT INTO contact VALUES (?,?,?,0)').run(LISI, '李四', '李四')
  cdb.close()

  const sdb = new DatabaseSync(join(dec, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  sdb.prepare('INSERT INTO SessionTable VALUES (?,?,1700000000,1700000000,0,1,\'\')').run(LISI, LISI)
  sdb.close()

  const mdb = new DatabaseSync(join(dec, 'message', 'message_0.db'))
  const t = 'Msg_' + createHash('md5').update(LISI, 'utf8').digest('hex')
  mdb.exec(`CREATE TABLE "${t}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
  const ins = mdb.prepare(`INSERT INTO "${t}" VALUES (?,?,1,0,?,1,?,?,'')`)
  ins.run(1, 1, 1700000001, '微信转账 收到转账13.00元 请及时查收', 'srv0')
  ins.run(2, 2, 1700000002, '合同的事我看过了，差额那部分我们再对一下', 'srv1')
  ins.run(3, 3, 1700000003, '好的，我明天把合同改好发你', 'srv2')
  mdb.close()
  return dec
}

/** 一个可停在两个 chunk 之间的合成流：`release` 由测试控制。 */
function makeCtx(release: Promise<void>): { ctx: Context; synthStarted: () => number } {
  let started = 0
  const llm = {
    async *stream(opts: { system?: string; messages?: Array<{ content?: Array<{ text?: string }> }> }) {
      const sys = String(opts.system ?? '')
      if (sys.includes('检索规划器')) {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ intent: '查询', subQueries: ['合同'], from: '', to: '', person: '' }) }
        return
      }
      // 合成：第一个 chunk 之后停住，等测试那边取消完再继续。
      yield { type: 'text-delta', index: 0, text: '收到 13.00 元' }
      started += 1
      await release
      yield { type: 'text-delta', index: 0, text: '，合同差额再对一下' }
    },
  }
  const ctx = {
    reflect: { provide: () => {} },
    effect: (fn: () => undefined | (() => void)) => {
      const d = fn()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
    emit: () => {},
    llm,
    agentDefaultModel: { currentSelection: () => ({ provider: 'mock', model: 'mock' }) },
  }
  return { ctx: ctx as unknown as Context, synthStarted: () => started }
}

describe('问答「停止生成」（W3-6.1）', () => {
  it('取消命中在飞的那一轮：带 code 结束、槽位归还、对已结束轮次如实说没命中', async () => {
    const dec = makeFixture()
    await buildSearchIndex(dec, true)
    vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', dec)
    vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(dec, 'decoded_images'))

    // 取消闸：holder 形式而不是裸 `let` —— TS 的控制流分析会把「只在 Promise 构造器里赋值」
    // 的裸变量 narrowing 成 null，后面的调用点就变成「不可调用」（本 spec 第一版踩过）。
    const ctl: { release: (() => void) | null } = { release: null }
    const release = new Promise<void>((resolve) => { ctl.release = resolve })
    const m = makeCtx(release)
    const gw = new WechatDataGateway(m.ctx)
    const jobId = 'ask-cancel-1'

    // ① 提问（不 await）：跑到合成流第一个 chunk 后停在 release 上。
    const asking = gw.askWechat({ question: '合同的事', jobId, streamId: jobId })
    // 等合成真的开始（轮询 started 比固定 setTimeout 稳）。
    for (let i = 0; i < 200 && m.synthStarted() === 0; i += 1) {
      await new Promise((r) => { setTimeout(r, 10) })
    }
    expect(m.synthStarted(), '合成流应当已经开始（否则测不到「生成中途」这个状态）').toBe(1)

    // ② 取消：命中在飞轮次。
    const hit = gw.cancelAsk({ jobId })
    expect(hit.ok, '在飞的轮次必须被取消命中').toBe(true)

    // ③ 放开流：下一个 chunk 的循环开头接住 aborted，抛带 code 的错误。
    ctl.release?.()
    await expect(asking).rejects.toMatchObject({ code: 'ASK_CANCELED' })

    // ④ 槽位归还：同一个 jobId 能再开一轮，而且这一轮能正常跑完。
    const r2 = await gw.askWechat({ question: '合同的事', jobId, streamId: jobId })
    expect(r2.answer.length, '归还槽位后同一 jobId 应能正常完成一轮').toBeGreaterThan(0)

    // ⑤ 对已经结束的轮次取消：如实返回没命中 + 原因。
    const late = gw.cancelAsk({ jobId })
    expect(late.ok).toBe(false)
    expect(late.message ?? '', '必须说清为什么没取消掉').toContain('已经结束')
  }, 60_000)
})
