// @vitest-environment node
/**
 * 问答可信度回归（微信问答与会话内 AI 问答共用同一条链路）：
 *
 *   ① 生成侧**接地审计**：回答里的金额/日期/长数字必须来自「回答自己引用的原文」，
 *      合计（原文金额 ≤3 项相加）放行、计数放行 —— 都是确定性纯函数，可离线回归。
 *   ② **会话范围**必须真的收得住实体通道：会话级问答（会话内 AI 面板 / 用户选定会话）
 *      绝不能把别的会话里的消息当证据（`who:` 是跨会话的全库过滤，曾漏带 username）。
 */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { auditGrounding, groundingRepairHint } from '../src/query/grounding.ts'
import { buildSearchIndex } from '../src/query/search.ts'
import { runRetrievalPipeline } from '../src/query/retrieval/pipeline.ts'
import { defaultRetrievalConfig } from '../src/query/retrieval/config.ts'
import type { Context } from '@deepseek-ai/cordis'
import { WechatDataGateway } from '../src/gateway.ts'
import { at } from '../../tests/helpers/strict-index.ts'

const scratch: string[] = []
afterEach(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true })
  scratch.length = 0
})

describe('接地审计：金额 / 日期 / 长数字必须来自引用原文', () => {
  /** 三条「引用原文」（窗口全文，带各自日期）。 */
  const EVIDENCE = [
    '房东老陈 2026-09-05 20:12\n微信转账 收到转账3500.00元 请及时查收',
    '李四 2026-09-02 14:07\n好的，差额是2000，我明天转给你',
    '李四 2026-07-20 11:00\n我换号了，新号码是13812345678',
  ]

  it('金额写在原文里 → 通过，并计入核对项数', () => {
    const a = auditGrounding('老陈转来 3500.00 元 [1]。', EVIDENCE, 3)
    expect(a.unsupported).toEqual([])
    expect(a.ok).toBe(true)
    expect(a.checked).toBe(1)
  })

  it('原文里没有的金额 → 报出（文档记录过的真实编造：原文 13.00/500.00，回答写 5000.00）', () => {
    const evidence = ['小何 2026-09-01 10:00\n收到转账 13.00 元', '小何 2026-09-02 10:00\n收到转账 500.00 元']
    const a = auditGrounding('最近一次转账来自王五，金额 5000.00 元 [1]。', evidence, 2)
    expect(a.ok).toBe(false)
    expect(a.unsupported.map(v => v.value)).toEqual(['5000.00元'])
  })

  it('正当的合计放行：等于原文金额 ≤3 项之和', () => {
    const evidence = ['收到转账3500.00元', '收到转账3500.00元']
    expect(auditGrounding('两笔加起来 7000 元 [1][2]。', evidence, 2).ok).toBe(true)
  })

  it('日期必须来自原文（含年份/横杠/中文写法）', () => {
    expect(auditGrounding('你们 2026-09-02 聊过合同 [2]。', EVIDENCE, 3).ok).toBe(true)
    expect(auditGrounding('收到房租是 2026年9月5日 [1]。', EVIDENCE, 3).ok).toBe(true)
    const bad = auditGrounding('你们 2026-09-03 聊过合同 [2]。', EVIDENCE, 3)
    expect(bad.ok).toBe(false)
    expect(bad.unsupported[0]).toMatchObject({ kind: 'date', value: '2026-09-03' })
  })

  it('日期里的数字不会被当成金额出处（2026 元 不能靠 2026-09-05 蒙混）', () => {
    const a = auditGrounding('他转了 2026 元 [1]。', EVIDENCE, 3)
    expect(a.ok).toBe(false)
  })

  it('长数字串（手机号/卡号）必须来自原文', () => {
    expect(auditGrounding('他的号码是 13812345678 [3]。', EVIDENCE, 3).ok).toBe(true)
    const bad = auditGrounding('他的号码是 13800000000 [3]。', EVIDENCE, 3)
    expect(bad.ok).toBe(false)
    expect(at(bad.unsupported, 0, 'unsupported').kind).toBe('digits')
  })

  it('计数（共几笔/几条）不算编造 —— 模型可以正当数出来', () => {
    const a = auditGrounding('一共 3 笔转账 [1][2][3]。', EVIDENCE, 3)
    expect(a.checked).toBe(0)
    expect(a.ok).toBe(true)
  })

  it('带高风险值却没标 [n] 的句子计入 uncited（软问题：值有出处就不算失败）', () => {
    const a = auditGrounding('老陈转来 3500.00 元。另外还聊到合同 [1]。', EVIDENCE, 3)
    expect(a.uncited).toBe(1)
    expect(a.ok).toBe(true)
  })

  it('越界的 [n] 不算引用', () => {
    expect(auditGrounding('内容 [9]', EVIDENCE, 3).cited).toEqual([])
    expect(auditGrounding('内容 [2][1]', EVIDENCE, 3).cited).toEqual([1, 2])
  })

  it('回炉提示会点名具体的值，并给出「合计要写加数」的出路', () => {
    const a = auditGrounding('金额 5000.00 元 [1]', ['收到转账 13.00 元'], 1)
    const hint = groundingRepairHint(a)
    expect(hint).toContain('5000.00元')
    expect(hint).toContain('合计')
    expect(hint).toContain('3500+3500=7000')
  })

  it('没有违规值时回炉提示为空串', () => {
    expect(groundingRepairHint(auditGrounding('收到 13.00 元 [1]', ['收到转账 13.00 元'], 1))).toBe('')
  })
})

const LISI = 'wxid_lisi'
const WANG = 'wxid_wangwu'
const GROUP = '12345678@chatroom'
const NAMES: Array<[string, string]> = [[LISI, '李四'], [WANG, '王五'], [GROUP, '项目组']]

/** 造一个真实可检索的数据根：两个单聊 + 一个群（群里有李四发言）。 */
function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wx-ask-scope-'))
  scratch.push(root)
  const dec = join(root, 'decrypted')
  mkdirSync(join(dec, 'session'), { recursive: true })
  mkdirSync(join(dec, 'message'), { recursive: true })
  mkdirSync(join(dec, 'contact'), { recursive: true })

  const cdb = new DatabaseSync(join(dec, 'contact', 'contact.db'))
  cdb.exec('CREATE TABLE contact (username TEXT, remark TEXT, nick_name TEXT, flag INTEGER)')
  const insC = cdb.prepare('INSERT INTO contact VALUES (?,?,?,0)')
  for (const [u, n] of NAMES) insC.run(u, n, n)
  cdb.close()

  const sdb = new DatabaseSync(join(dec, 'session', 'session.db'))
  sdb.exec('CREATE TABLE SessionTable (username TEXT, display_name TEXT, last_timestamp INTEGER, sort_timestamp INTEGER, unread_count INTEGER, last_msg_type INTEGER, last_msg_sender TEXT)')
  const insS = sdb.prepare('INSERT INTO SessionTable VALUES (?,?,1700000000,1700000000,0,1,\'\')')
  for (const [u] of NAMES) insS.run(u, u)
  sdb.close()

  const mdb = new DatabaseSync(join(dec, 'message', 'message_0.db'))
  const t = (u: string): string => 'Msg_' + createHash('md5').update(u, 'utf8').digest('hex')
  const bodies = new Map<string, Array<[number, string]>>([
    [LISI, [
      [1, '微信转账 收到转账13.00元 请及时查收'],
      [2, '合同的事我看过了，差额那部分我们再对一下'],
      [3, '好的，我明天把合同改好发你'],
    ]],
    [WANG, [[1, '周末一起去打球吗'], [2, '可以，周六下午三点']]],
    // 群聊里李四的发言：who 列会同时含「项目组」与「李四」
    [GROUP, [[1, LISI + ':\n合同的模板我改好了，差额字段单独列出来了'], [2, WANG + ':\n收到，我今晚看']]],
  ])
  for (const [u, rows] of bodies) {
    mdb.exec(`CREATE TABLE "${t(u)}" (local_id INTEGER, sort_seq INTEGER, local_type INTEGER, is_sender INTEGER, create_time INTEGER, real_sender_id INTEGER, message_content TEXT, server_id INTEGER, compress_content TEXT)`)
    const ins = mdb.prepare(`INSERT INTO "${t(u)}" VALUES (?,?,1,0,?,1,?,?, '')`)
    rows.forEach(([id, text], i) => ins.run(id, id, 1700000000 + id, text, 'srv' + i))
  }
  mdb.close()
  return dec
}

describe('会话范围必须收住实体通道（会话级问答不得召回别的会话）', () => {
  it('scope.username 限定后，实体（who:）召回不会带出同一个人在群里的发言', async () => {
    const dec = makeFixture()
    const built = await buildSearchIndex(dec, true)
    expect(built.status).toBe('ok')
    // 索引侧确实有跨会话命中：不限定会话时，「李四」会同时命中单聊与群聊。
    // （这是范围修复前的漏召路径，先证明它真实存在，否则下面的断言是空转。）
    const all = await runRetrievalPipeline({
      decryptedDir: dec,
      question: '李四的合同',
      subQueries: ['合同'],
      entity: '李四',
      limit: 10,
      config: defaultRetrievalConfig(),
    })
    expect(new Set(all.citations.map(c => c.username)).size).toBeGreaterThan(1)

    const scoped = await runRetrievalPipeline({
      decryptedDir: dec,
      question: '李四的合同',
      subQueries: ['合同'],
      entity: '李四',
      scope: { username: LISI },
      limit: 10,
      config: defaultRetrievalConfig(),
    })
    expect(scoped.citations.length).toBeGreaterThan(0)
    expect([...new Set(scoped.citations.map(c => c.username))]).toEqual([LISI])
    for (const ch of scoped.chunks) expect(ch.username).toBe(LISI)
  }, 60_000)
})
describe('端到端：核对不通过会带着「具体哪个值不对」回炉重写', () => {
  const GHOST = '最近一次转账来自王五，金额 5000.00 元 [1]。'
  const FIXED = '最近一次转账是收到 13.00 元 [1]。'
  const disposers: Array<() => void> = []

  afterEach(() => {
    for (const d of disposers) d()
    disposers.length = 0
    vi.unstubAllEnvs()
  })

  /**
   * 只提供 askWechat 真正用到的表面：`llm.stream`（规划器 + 综合）与默认模型。
   * 规划器那一跳用 system 里是否含「检索规划器」区分；综合回答按 `replies` 依次返回，
   * 并把每次发给模型的**综合提示词**留下来，用来断言「回炉时点名了具体的值」。
   */
  function makeCtx(replies: string[]): { ctx: Context; synthCalls: () => number; prompts: string[] } {
    const prompts: string[] = []
    let synth = 0
    const llm = {
      async *stream(opts: { system?: string; messages?: Array<{ content?: Array<{ text?: string }> }> }) {
        const sys = String(opts.system ?? '')
        if (sys.includes('检索规划器')) {
          yield { type: 'text-delta', index: 0, text: JSON.stringify({ intent: '最近查询', subQueries: ['转账'], from: '', to: '', person: '' }) }
          return
        }
        prompts.push(opts.messages?.[0]?.content?.[0]?.text ?? '')
        const text = replies[Math.min(synth, replies.length - 1)] ?? ''
        synth += 1
        yield { type: 'text-delta', index: 0, text }
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
    return { ctx: ctx as unknown as Context, synthCalls: () => synth, prompts }
  }

  /** 装好临时数据根 + 已建索引的网关。 */
  async function gatewayWith(replies: string[]): Promise<{ gw: WechatDataGateway; synthCalls: () => number; prompts: string[] }> {
    const dec = makeFixture()
    await buildSearchIndex(dec, true)
    vi.stubEnv('DSH_WECHAT_DECRYPTED_DIR', dec)
    vi.stubEnv('DSH_WECHAT_DECODED_DIR', join(dec, 'decoded_images'))
    const m = makeCtx(replies)
    return { gw: new WechatDataGateway(m.ctx), synthCalls: m.synthCalls, prompts: m.prompts }
  }

  it('修正稿更好的话采纳修正稿，并如实记下 repaired', async () => {
    const { gw, synthCalls, prompts } = await gatewayWith([GHOST, FIXED])
    const r = await gw.askWechat({ question: '最近一次转账是多少' })
    expect(synthCalls()).toBe(2)
    // 回炉提示点名了那个编造的值，并给出「合计要写加数」的出路（不是笼统的「请重写」）
    expect(prompts[1]).toContain('5000.00元')
    expect(prompts[1]).toContain('合计')
    expect(r.answer).toBe(FIXED)
    expect(r.grounding?.repaired).toBe(true)
    expect(r.grounding?.unsupported).toEqual([])
    expect(r.withheld).toBeUndefined()
  })

  it('修正稿没变好时保留原回答并如实标注（金额不硬拦截 —— 合计可能是正当算出来的）', async () => {
    const { gw, synthCalls } = await gatewayWith([GHOST])
    const r = await gw.askWechat({ question: '最近一次转账是多少' })
    expect(synthCalls()).toBe(2)
    expect(r.answer).toBe(GHOST)
    expect(r.grounding?.unsupported).toEqual(['5000.00元'])
    expect(r.grounding?.repaired).toBe(false)
    expect(r.withheld).toBeUndefined()
  })

  it('一条 [n] 都没有仍然不予采用（原有硬约束不退化）', async () => {
    const { gw } = await gatewayWith(['上个月一共转了 3 笔。'])
    const r = await gw.askWechat({ question: '最近一次转账是多少' })
    expect(r.withheld).toBe(true)
    expect(r.answer).toContain('没有找到可据以回答的证据')
    expect(r.answer).not.toContain('3 笔')
  })
})