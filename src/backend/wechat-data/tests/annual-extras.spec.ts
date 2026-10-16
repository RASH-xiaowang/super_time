/**
 * `createAnnualExtras`（年度资金 / 年度撤回 / 群聊年度）的判据（2026-09-30 首次立判据）。
 *
 * ## 为什么这份用例值得写这么细
 *
 * 三块统计全是**加法**：错一格不会抛异常，只会让年报上多一个解释不通的数字
 * （「全年转账 47 笔」到底是 45 还是 47，没有任何别的地方能对出来）。所以这里逐条钉住口径：
 *  · 只有 **XML 卡片**才算资金（转账 appmsg 2000 / 红包 2001·2003），纯文本里说「给你转了 50」不算；
 *  · **解析不出就不计入**（`count`/`total` 都不加）—— 但**真的是 0 元**的那笔要计入：
 *    「不知道」与「就是 0」是两件事，混了就等于往合计里塞了一个编出来的数；
 *  · 撤回只认 `local_type=10000/10002` 或正文里的 `revokemsg` 标记（复述别人的提示不算）；
 *  · 时段桶用**本地时区**（`new Date(ts*1000).getHours()`，与 `annual-review.ts` 的作息口径同源），
 *    所以夹具用本地分量构造时间戳 —— 断言在任何时区的机器上都一样；
 *  · 榜单同数一律按 **username 升序**：换一个入库顺序（分片并行、补数据重扫）结果必须逐字相同；
 *  · `done()` 可重复调用，且返回的是**拷贝**：调用方改返回值动不了内部状态。
 *
 * ## 已知缺口（与 `annual-extras.ts` 文件头一一对应，**用下面的用例写成事实，不假装覆盖**）
 *
 *  · 千分位 `￥1,234.56` 只读到 `1`（与 `ledger.ts` 的 `parseAmount` 是同一条正则，逗号截断）；
 *  · 外币（`HK$`/`US$`）只取数字、按人民币元计入（`feedesc` 里没有币种字段）；
 *  · 没有 `<appmsg>` 包裹的裸 `<type>2000</type>` 片段不计入（热路径先挡一道，见 `moneyAmountOf`）；
 *  · 聊天记录卡片（`<recorditem>`）里内嵌的转账不计入；
 *  · 群收款 / AA 收款与普通转账同为 appmsg 2000 ⇒ 被**当成转账**计入（`paysubtype` 不参与判据）；
 *  · 图片截图里的转账、语音里说的金额、微信支付「收款到账」通知 ⇒ 都不计入。
 * 每一条都有对应用例，且用例注释里写明「这是刻意保留的现状」；要收紧时先改口径再改这里。
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  createAnnualExtras,
  type AnnualChatInput,
  type AnnualGroups,
  type AnnualMoney,
  type AnnualRevoke,
  type AnnualRowInput,
} from '../src/query/annual-extras.ts'

/* ────────────── 夹具 ────────────── */

const ALICE: AnnualChatInput = { username: 'wxid_alice', name: '小爱', isGroup: false }
const BOB: AnnualChatInput = { username: 'wxid_bob', name: '老王', isGroup: false }
const ROOM: AnnualChatInput = { username: 'room_family@chatroom', name: '家人群', isGroup: true }

/**
 * 2026-05-06 本地 `hour` 点的时间戳。
 *
 * 必须用**本地分量**构造（`new Date(y, m, d, h, …)`）：撤回时段桶是按本地时区算的，
 * 用 `Date.UTC` 写夹具的话，CI 在别的时区上会红/绿互换。
 * @param hour - 本地小时（0..23）。
 * @param minute - 本地分钟。
 * @returns 秒级时间戳。
 */
function atHour(hour: number, minute = 0): number {
  return Math.floor(new Date(2026, 4, 6, hour, minute, 0, 0).getTime() / 1000)
}

/**
 * 转账卡（appmsg 2000）：金额在 `wcpayinfo.feedesc` —— 正是 `ledger.ts` 取的那一处。
 * @param amount - `feedesc` 的原文（如 `￥1.23`、`100分`；空串表示客户端没下发金额）。
 * @returns 已解码正文。
 */
function transferXml(amount: string): string {
  return '<msg><appmsg appid="wx123" sdkver="0"><title>微信转账</title><type>2000</type>'
    + '<wcpayinfo><paysubtype>1</paysubtype><feedesc>' + amount + '</feedesc>'
    + '<pay_memo>还款</pay_memo></wcpayinfo></appmsg></msg>'
}

/**
 * 红包卡（appmsg 2001）：金额同样在 `feedesc`，`parse-rich` 剥掉前导 `￥` 后放进 `rich.amount`。
 * @param amount - `feedesc` 的原文。
 * @returns 已解码正文。
 */
function redpacketXml(amount: string): string {
  return '<msg><appmsg><title>恭喜发财</title><type>2001</type>'
    + '<wcpayinfo><feedesc>' + amount + '</feedesc></wcpayinfo></appmsg></msg>'
}

/** 撤回提示的 sysmsg 形态（实测第 2 种，`replacemsg` 里带文案）。 */
const REVOKE_XML = '<sysmsg type="revokemsg"><revokemsg>'
  + '<replacemsg><![CDATA["小爱" 撤回了一条消息]]></replacemsg>'
  + '<session>room_family@chatroom</session><newmsgid>123456789</newmsgid></revokemsg></sysmsg>'

/** 撤回提示的纯文本形态（`local_type=10000`，实测第 1 种）。 */
const REVOKE_TEXT = '"小爱" 撤回了一条消息'

interface RowOpts {
  type?: number
  ts?: number
  mine?: boolean
  sender?: string
}

/**
 * 造一行年度消息（默认：type 1、本地 12 点、非我发）。
 * @param text - 已解码正文。
 * @param opts - 可覆盖的字段。
 * @returns 行输入。
 */
function rowOf(text: string, opts: RowOpts = {}): AnnualRowInput {
  return {
    type: opts.type ?? 1,
    ts: opts.ts ?? atHour(12),
    text,
    sender: opts.sender ?? '对方',
    mine: opts.mine ?? false,
  }
}

/** 一次「喂进去 → 取结果」。 */
function run(pairs: Array<[AnnualRowInput, AnnualChatInput]>): ReturnType<ReturnType<typeof createAnnualExtras>['done']> {
  const acc = createAnnualExtras()
  for (const [row, chat] of pairs) acc.onRow(row, chat)
  return acc.done()
}

/** 造 `n` 个群各一条消息（`room_1..room_n`）。 */
function groupFan(n: number): Array<[AnnualRowInput, AnnualChatInput]> {
  const out: Array<[AnnualRowInput, AnnualChatInput]> = []
  for (let i = 1; i <= n; i += 1) {
    out.push([rowOf('群消息'), { username: 'room_' + String(i) + '@chatroom', name: '群' + String(i), isGroup: true }])
  }
  return out
}

/** 造 `n` 个人各一笔同额转账（`wxid_p1..wxid_pn`）。 */
function moneyFan(n: number, amount: string): Array<[AnnualRowInput, AnnualChatInput]> {
  const out: Array<[AnnualRowInput, AnnualChatInput]> = []
  for (let i = 1; i <= n; i += 1) {
    out.push([
      rowOf(transferXml(amount), { type: 49 }),
      { username: 'wxid_p' + String(i), name: '好友' + String(i), isGroup: false },
    ])
  }
  return out
}

/* ────────────── 表驱动：一行一行喂进去 → 期望 ────────────── */

interface Case {
  /** 用例名（直接做 `it` 的标题）。 */
  name: string
  /** 输入：`[行, 会话]` 序列。 */
  pairs: Array<[AnnualRowInput, AnnualChatInput]>
  /** 资金期望（给了就整块比对）。 */
  money?: Partial<AnnualMoney>
  /** 撤回期望。 */
  revoke?: Partial<AnnualRevoke>
  /** 群聊期望。 */
  groups?: Partial<AnnualGroups>
}

const CASES: Case[] = [
  {
    name: '空输入：三块全是零（byHour 仍是 24 个 0，share 是 0 不是 NaN）',
    pairs: [],
    money: { count: 0, total: 0, topAmount: 0, topPeerName: '', byPeer: [] },
    revoke: { count: 0, topPeerName: '', byHour: new Array<number>(24).fill(0) },
    groups: { messages: 0, share: 0, top: [] },
  },
  {
    name: '单聊：我发的转账与对方发的红包都计入（合计 10.11、最大一笔 8.88、TOP1 是小爱）',
    pairs: [
      [rowOf(transferXml('￥1.23'), { type: 49, ts: atHour(9), mine: true, sender: '我' }), ALICE],
      [rowOf(redpacketXml('￥8.88'), { type: 49, ts: atHour(10) }), ALICE],
      [rowOf('早', { ts: atHour(11) }), ALICE],
    ],
    money: {
      count: 2,
      total: 10.11,
      topAmount: 8.88,
      topPeerName: '小爱',
      byPeer: [{ username: 'wxid_alice', name: '小爱', amount: 10.11, count: 2 }],
    },
    revoke: { count: 0, topPeerName: '' },
    groups: { messages: 0, share: 0, top: [] },
  },
  {
    name: '群聊占比：3 条群里 + 1 条单聊 ⇒ 0.75，群消息算所有人的',
    pairs: [
      [rowOf('甲', { mine: true, sender: '我' }), ROOM],
      [rowOf('乙'), ROOM],
      [rowOf('丙'), ROOM],
      [rowOf('私聊'), ALICE],
    ],
    groups: { messages: 3, share: 0.75, top: [{ username: 'room_family@chatroom', name: '家人群', count: 3 }] },
    money: { count: 0 },
    revoke: { count: 0 },
  },
  {
    name: '「真的是 0 元」与「解析不出」是两件事：￥0.00 计 1 笔 0 元，feedesc 空的那笔不计入',
    pairs: [
      [rowOf(transferXml('￥0.00'), { type: 49 }), ALICE],
      [rowOf(transferXml(''), { type: 49 }), ALICE],
    ],
    money: {
      count: 1,
      total: 0,
      topAmount: 0,
      topPeerName: '小爱',
      byPeer: [{ username: 'wxid_alice', name: '小爱', amount: 0, count: 1 }],
    },
  },
  {
    name: '畸形 XML / 非资金卡片都不算钱（链接卡里的 9.9 不是金额）',
    pairs: [
      [rowOf('<msg><appmsg><type>2000</type><wcpayinfo><feedesc>￥1.2', { type: 49 }), ALICE],
      [rowOf('<msg><appmsg><type>2000</type></appmsg></msg>', { type: 49 }), ALICE],
      [rowOf('这不是 XML', { type: 1 }), ALICE],
      [rowOf('<msg><appmsg><title>只要 9.9</title><type>5</type><url>https://example.com</url></appmsg></msg>', { type: 49 }), ALICE],
    ],
    money: { count: 0, total: 0, topAmount: 0, topPeerName: '', byPeer: [] },
    revoke: { count: 0 },
  },
  {
    name: '「100分」按分折算成 1 元（金额正则与 ledger 同源，只多一步单位判断）',
    pairs: [[rowOf(transferXml('100分'), { type: 49 }), ALICE]],
    money: {
      count: 1,
      total: 1,
      topAmount: 1,
      topPeerName: '小爱',
      byPeer: [{ username: 'wxid_alice', name: '小爱', amount: 1, count: 1 }],
    },
  },
  {
    name: '【已知缺口】千分位 ￥1,234.56 只读到 1（与 ledger 同一条正则，逗号把数字截断了）',
    pairs: [[rowOf(transferXml('￥1,234.56'), { type: 49 }), ALICE]],
    money: { count: 1, total: 1, topAmount: 1, topPeerName: '小爱' },
  },
  {
    name: '【已知缺口】红包没有 feedesc ⇒ 不计入（ledger 会记成 0 元一笔，本模块选择不记）',
    pairs: [[rowOf(redpacketXml(''), { type: 49 }), ALICE]],
    money: { count: 0, total: 0, topAmount: 0, topPeerName: '', byPeer: [] },
  },
  {
    name: '撤回三种形态各算一条：type 10000 文案 / sysmsg revokemsg / type 10002',
    pairs: [
      [rowOf(REVOKE_TEXT, { type: 10000, ts: atHour(3) }), ALICE],
      [rowOf(REVOKE_XML, { type: 10000, ts: atHour(4) }), ROOM],
      [rowOf('<sysmsg type="revokemsg"><revokemsg><revoketime>0</revoketime></revokemsg></sysmsg>', { type: 10002, ts: atHour(5) }), ALICE],
    ],
    revoke: { count: 3, topPeerName: '小爱' },
    money: { count: 0 },
    groups: { messages: 1, share: 0.3333333333333333 },
  },
  {
    name: '【口径】type=1 的普通文本里复述「撤回了一条消息」不算撤回',
    pairs: [
      [rowOf(REVOKE_TEXT, { type: 1 }), ALICE],
      [rowOf('他昨天撤回了一条消息你知道吗', { type: 1 }), ROOM],
    ],
    revoke: { count: 0, topPeerName: '' },
  },
  {
    name: '撤回最多的会话：同数按 username 升序取（不是先到先得）',
    pairs: [
      [rowOf(REVOKE_TEXT, { type: 10000, ts: atHour(1) }), BOB],
      [rowOf(REVOKE_TEXT, { type: 10000, ts: atHour(2) }), ALICE],
    ],
    revoke: { count: 2, topPeerName: '小爱' },
  },
  {
    name: '群 TOP5 同数按 username 升序：6 个群各 1 条、倒序喂入 ⇒ room_1..room_5',
    pairs: [...groupFan(6)].reverse(),
    groups: {
      messages: 6,
      share: 1,
      top: [
        { username: 'room_1@chatroom', name: '群1', count: 1 },
        { username: 'room_2@chatroom', name: '群2', count: 1 },
        { username: 'room_3@chatroom', name: '群3', count: 1 },
        { username: 'room_4@chatroom', name: '群4', count: 1 },
        { username: 'room_5@chatroom', name: '群5', count: 1 },
      ],
    },
  },
  {
    name: '资金 TOP5 同额按 username 升序：6 人各 ￥6.00 ⇒ p1..p5，最大一笔定在好友1',
    pairs: moneyFan(6, '￥6.00'),
    money: {
      count: 6,
      total: 36,
      topAmount: 6,
      topPeerName: '好友1',
      byPeer: [
        { username: 'wxid_p1', name: '好友1', amount: 6, count: 1 },
        { username: 'wxid_p2', name: '好友2', amount: 6, count: 1 },
        { username: 'wxid_p3', name: '好友3', amount: 6, count: 1 },
        { username: 'wxid_p4', name: '好友4', amount: 6, count: 1 },
        { username: 'wxid_p5', name: '好友5', amount: 6, count: 1 },
      ],
    },
  },
]

describe('表驱动：输入行 → 三块统计期望', () => {
  for (const c of CASES) {
    it(c.name, () => {
      const r = run(c.pairs)
      // 一律用 toMatchObject：表里给的是**该用例关心的那几个字段**，不是整块结果的完整快照
      //（完整形状由下面「空格形状」那条 toEqual 单独钉住）。
      if (c.money !== undefined) expect(r.money).toMatchObject(c.money)
      if (c.revoke !== undefined) expect(r.revoke).toMatchObject(c.revoke)
      if (c.groups !== undefined) expect(r.groups).toMatchObject(c.groups)
    })
  }

  it('空输入的**完整形状**（键名/键数/空数组，逐字钉住）', () => {
    expect(run([])).toEqual({
      money: { count: 0, total: 0, topAmount: 0, topPeerName: '', byPeer: [] },
      revoke: { count: 0, topPeerName: '', byHour: new Array<number>(24).fill(0) },
      groups: { messages: 0, share: 0, top: [] },
    })
  })
})

/* ────────────── 时段桶（本地时区） ────────────── */

describe('撤回时段桶', () => {
  it('0 点与 23 点各进自己的桶，桶长恒为 24 且求和等于 count', () => {
    const r = run([
      [rowOf(REVOKE_TEXT, { type: 10000, ts: atHour(0, 30) }), ALICE],
      [rowOf(REVOKE_TEXT, { type: 10000, ts: atHour(23, 59) }), ALICE],
      [rowOf(REVOKE_TEXT, { type: 10000, ts: atHour(23, 0) }), ROOM],
      [rowOf(REVOKE_TEXT, { type: 10000, ts: atHour(12) }), ALICE],
    ])
    expect(r.revoke.count).toBe(4)
    expect(r.revoke.byHour).toHaveLength(24)
    expect(r.revoke.byHour[0]).toBe(1)
    expect(r.revoke.byHour[12]).toBe(1)
    expect(r.revoke.byHour[23]).toBe(2)
    expect(r.revoke.byHour.reduce((a, n) => a + n, 0)).toBe(r.revoke.count)
  })

  it('时区自证：夹具用的是本地分量（否则 ci 换时区就会红绿互换）', () => {
    // 同一天本地 0 点：`getHours()` 必须还是 0（用 Date.UTC 写夹具时这条会随 TZ 变）
    expect(new Date(atHour(0) * 1000).getHours()).toBe(0)
    expect(new Date(atHour(23) * 1000).getHours()).toBe(23)
  })
})

/* ────────────── done() 的契约 ────────────── */

describe('done() 可重复调用、返回拷贝', () => {
  it('重复调用结果逐字相同，且两次返回的不是同一批对象', () => {
    const acc = createAnnualExtras()
    acc.onRow(rowOf(transferXml('￥1.00'), { type: 49 }), ALICE)
    acc.onRow(rowOf(REVOKE_TEXT, { type: 10000, ts: atHour(0) }), ALICE)
    acc.onRow(rowOf('群消息'), ROOM)
    const first = acc.done()
    const second = acc.done()
    expect(second).toEqual(first)
    expect(second.money.byPeer).not.toBe(first.money.byPeer)
    expect(second.revoke.byHour).not.toBe(first.revoke.byHour)
    expect(second.groups.top).not.toBe(first.groups.top)
  })

  it('把返回值改烂（塞行、改金额、时段桶清零）也动不了内部状态', () => {
    const acc = createAnnualExtras()
    acc.onRow(rowOf(transferXml('￥1.00'), { type: 49 }), ALICE)
    acc.onRow(rowOf(REVOKE_TEXT, { type: 10000, ts: atHour(0) }), ALICE)
    acc.onRow(rowOf('群消息'), ROOM)
    const baseline = acc.done()
    const dirty = acc.done()
    for (const p of dirty.money.byPeer) { p.amount = 999; p.count = 9 }
    dirty.money.byPeer.push({ username: 'zzz', name: '脏', amount: 1e9, count: 1 })
    dirty.money.total = 1e9
    dirty.money.topPeerName = '脏'
    dirty.revoke.byHour[0] = 42
    dirty.revoke.byHour.push(7)
    dirty.groups.top.push({ username: 'zzz', name: '脏', count: 999 })
    dirty.groups.share = 1
    expect(acc.done()).toEqual(baseline)
  })

  it('onRow 不改输入：行与会话对象原样（纯函数）', () => {
    const row = rowOf(transferXml('￥2.00'), { type: 49, ts: atHour(8) })
    const chat: AnnualChatInput = { username: 'wxid_alice', name: '小爱', isGroup: false }
    const rowCopy = { ...row }
    const chatCopy = { ...chat }
    createAnnualExtras().onRow(row, chat)
    expect(row).toEqual(rowCopy)
    expect(chat).toEqual(chatCopy)
  })
})

/* ────────────── 边界与「拿不到」 ────────────── */

describe('边界', () => {
  it('ts 为 0 / NaN / 负数 / Infinity 的行整行跳过（资金、群聊、撤回都不计）', () => {
    const r = run([
      [rowOf(transferXml('￥5.00'), { type: 49, ts: 0 }), ALICE],
      [rowOf(transferXml('￥5.00'), { type: 49, ts: Number.NaN }), ALICE],
      [rowOf('群消息', { ts: -1 }), ROOM],
      [rowOf(REVOKE_TEXT, { type: 10000, ts: Number.POSITIVE_INFINITY }), ALICE],
    ])
    expect(r.money.count).toBe(0)
    expect(r.groups.messages).toBe(0)
    expect(r.groups.share).toBe(0)
    expect(r.revoke.count).toBe(0)
  })

  it('会话显示名拿不到时 topPeerName 退回 username；两者都空才给空串', () => {
    const noName = run([[rowOf(transferXml('￥3.00'), { type: 49 }), { username: 'wxid_noname', name: '', isGroup: false }]])
    expect(noName.money.topPeerName).toBe('wxid_noname')
    expect(noName.money.byPeer).toEqual([{ username: 'wxid_noname', name: 'wxid_noname', amount: 3, count: 1 }])
    const nothing = run([[rowOf(transferXml('￥3.00'), { type: 49 }), { username: '', name: '', isGroup: false }]])
    expect(nothing.money.topPeerName).toBe('')
    expect(nothing.money.byPeer).toEqual([{ username: '', name: '', amount: 3, count: 1 }])
  })

  it('群聊判定：会话名以 @chatroom 结尾时，即使 isGroup=false 也按群算（见模块注释）', () => {
    const r = run([[rowOf('群消息'), { username: 'room_x@chatroom', name: '某群', isGroup: false }]])
    expect(r.groups.messages).toBe(1)
    expect(r.groups.share).toBe(1)
  })

  it('榜单与输入顺序无关：同一批群正序/倒序各喂一遍，结果逐字相同', () => {
    const forward = run(groupFan(6))
    const backward = run([...groupFan(6)].reverse())
    expect(backward.groups).toEqual(forward.groups)
    expect(forward.groups.top.map((g) => g.username))
      .toEqual(['room_1@chatroom', 'room_2@chatroom', 'room_3@chatroom', 'room_4@chatroom', 'room_5@chatroom'])
  })

  it('最大一笔换人时 topPeerName 跟着换（同额按 username 升序，与先喂谁无关）', () => {
    const r = run([
      [rowOf(transferXml('￥5.00'), { type: 49, ts: atHour(1) }), BOB],
      [rowOf(transferXml('￥5.00'), { type: 49, ts: atHour(2) }), ALICE],
      [rowOf(transferXml('￥99.00'), { type: 49, ts: atHour(3) }), ROOM],
    ])
    expect(r.money.topAmount).toBe(99)
    expect(r.money.topPeerName).toBe('家人群')
    expect(r.money.byPeer.map((p) => p.username)).toEqual(['room_family@chatroom', 'wxid_alice', 'wxid_bob'])
  })

  it('防空转：金额真的读进来了（否则上面那些 0 值断言都可能恒真）', () => {
    const r = run([[rowOf(transferXml('￥12.34'), { type: 49 }), ALICE]])
    expect(r.money).toEqual({
      count: 1,
      total: 12.34,
      topAmount: 12.34,
      topPeerName: '小爱',
      byPeer: [{ username: 'wxid_alice', name: '小爱', amount: 12.34, count: 1 }],
    })
  })
})

/* ────────────── 已知缺口：写成事实，不假装覆盖 ────────────── */

describe('已知缺口（当前实现的真实输出，刻意保留）', () => {
  it('聊天记录卡片（recorditem 内嵌转账）不算资金', () => {
    // appmsg 子类型是 19（chatlog），内嵌的 2000 在 <recorditem> 里 —— parseAppmsgType 不会看到它。
    const chatlog = '<msg><appmsg><title>群的聊天记录</title><type>19</type><recorditem><![CDATA['
      + transferXml('￥88.88') + ']]></recorditem></appmsg></msg>'
    const r = run([[rowOf(chatlog, { type: 49 }), ALICE]])
    expect(r.money.count).toBe(0)
    expect(r.money.total).toBe(0)
  })

  it('外币只取数字、按人民币元计入（feedesc 里没有币种字段）', () => {
    const r = run([[rowOf(transferXml('HK$100'), { type: 49 }), ALICE]])
    expect(r.money.count).toBe(1)
    expect(r.money.total).toBe(100)
  })

  it('没有 <appmsg> 包裹的裸 <type>2000</type> 片段不计入（热路径先挡一道）', () => {
    const bare = '<type>2000</type><wcpayinfo><feedesc>￥1</feedesc></wcpayinfo>'
    const r = run([[rowOf(bare, { type: 49 }), ALICE]])
    expect(r.money.count).toBe(0)
  })

  it('群收款 / AA 收款与普通转账同为 appmsg 2000 ⇒ 被当成转账计入', () => {
    const collect = '<msg><appmsg><title>群收款</title><type>2000</type>'
      + '<wcpayinfo><paysubtype>19</paysubtype><feedesc>￥30.00</feedesc></wcpayinfo></appmsg></msg>'
    const r = run([[rowOf(collect, { type: 49 }), ROOM]])
    expect(r.money.count).toBe(1)
    expect(r.money.total).toBe(30)
    expect(r.money.byPeer).toEqual([{ username: 'room_family@chatroom', name: '家人群', amount: 30, count: 1 }])
  })

  it('图片消息（含转账截图）与语音都不进资金统计', () => {
    const r = run([
      [rowOf('<msg><img aeskey="x" md5="y" /></msg>', { type: 3 }), ALICE],
      [rowOf('<msg><voicemsg voicelength="3000" /></msg>', { type: 34 }), ALICE],
    ])
    expect(r.money.count).toBe(0)
    expect(r.groups.messages).toBe(0)
  })
})
