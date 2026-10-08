/**
 * 年度报告的「年度资金 / 年度撤回 / 群聊年度」三块统计：**纯函数累加器**。
 *
 * ## 为什么做成累加器
 *
 * `annual-review.ts` 已经为整年跑了一遍「分片 → 表 → 行」的单次遍历，逐行做 CPU 重活。
 * 这三块统计要的口径与那一遍**完全同源**（同一年、同一批行、同一套类型归一化），
 * 再扫一遍库既慢又必然与年报口径漂移。所以这里不碰 DB、不碰 Buffer、不读文件、不联网 ——
 * 调用方在既有循环里**逐行** `onRow(row, chat)`，扫完 `done()` 取结果。
 * 解压（zstd）与编码（UTF-8/GBK）转换由调用方负责，本模块只吃**已解码**的 `text`。
 *
 * ## 口径来源（照抄既有实现，不另发明）
 *
 * · **资金**：与 `ledger.ts#paymentFromContent` 同一路 —— `parseMessageContent(49, text, false)`
 *   取 rich；`transfer`（appmsg 2000）取 `rich.title`（= `wcpayinfo.feedesc`，形如 `￥1.23`）；
 *   `redpacket`（appmsg 2001/2003）取 `rich.amount`（`parse-rich.ts` 已剥掉前导 `￥`）。
 *   金额取数与 ledger 的 `parseAmount` 是**同一条正则** `[\d.]+`（只取第一段数字）。
 *   其余 appmsg 子类型（链接/文件/接龙/聊天记录…）一律不算资金。
 * · **撤回**：与 `revoke-retain.ts` 的提示判据同源（`local_type = 10000` + 文案），并补上
 *   `parse-system.ts#parseSystemMessage` 已经识别的 `<sysmsg type="revokemsg">` 标记形态
 *   （实测有 `customtip` 里不带「撤回了一条消息」字样的），以及 `parse.ts` 里独立成案的
 *   `local_type = 10002`。
 * · **时段**：`new Date(ts * 1000).getHours()` ⇒ **本地时区**，与 `annual-review.ts` 的
 *   `hourAll`／深夜／作息完全相同（那边也是本地时区，不是 UTC）。
 * · `AnnualRowInput.sender` / `mine` 目前不参与这三块的口径（契约保留字段；将来要拆
 *   「收/支」「谁撤的」时会用到，现在**不猜**）。
 *
 * ## 识别不了的形态（已知缺口；**解析不出就不计入 count/total，绝不用 0 混进合计**）
 *
 *  ① `feedesc` 缺失或为空的红包/转账（部分客户端不下发金额）⇒ 不计入。注意 ledger 的
 *     `parseAmount` 对这种情况返回 **0**，会被记成「0 元一笔」；本模块选择「不知道就不记」。
 *  ② 千分位金额 `￥1,234.56` ⇒ 只读到 `1`（同一条正则被逗号截断）。这是**读错**而不是读不到，
 *     保持 ledger 口径是为了让账本与年报的数字对得上（要修就两处一起修）。
 *  ③ 外币（`HK$`／`US$`／`$`）⇒ 只取数字、按人民币元计入。`feedesc` 里没有可靠的币种字段。
 *  ④ 没有 `<appmsg>` 包裹的裸片段（形如 `<type>2000</type><feedesc>￥1</feedesc>`）⇒ 不计入：
 *     `parseAppmsgType` 在没有 `<appmsg>` 时会退化成「在整段文本里找 `<type>`」，而本模块
 *     为了不把整年每一行都送进 appmsg 解析器，先用 `text.includes('<appmsg')` 挡了一道
 *     （见 `moneyAmountOf`）。真实数据里转账/红包一定带 `<appmsg>` 包裹，所以这条代价接近 0。
 *  ⑤ 图片里的转账截图、聊天记录卡片（`<recorditem>` 内嵌的转账）、语音里说的金额 ⇒ 不计入。
 *  ⑥ 群收款／AA 收款与普通转账同为 appmsg 2000，`paysubtype` 不参与判据 ⇒ 会被**当成转账**计入
 *     （与 ledger 相同；要不要拆开得先有真实样本）。
 *  ⑦ 微信支付「收款到账」通知（一般由公众号发出，不是 2000/2001/2003）⇒ 不计入。
 *  ⑧ 纯文本消息里提到「撤回了一条消息」（引用/复述别人发的提示）⇒ 不计入：撤回要求
 *     `local_type` 是 10000/10002，或正文里带 `revokemsg` 标记。
 *  ⑨ `ts` 为 0／非有限值的行**整行跳过**（与 `annual-review.ts` 的 `if (!ts) continue` 同口径）：
 *     「年度」本身就依赖时间，把坏时间戳的行算进分子分母会让年报自相矛盾。
 *  ⑩ 会话归属：`username` 为空时，所有「拿不到会话名」的行会合并进同一个空键桶（不会凭空
 *     拆成多个人）；这类桶上的 `topPeerName` 退回空串。
 * @module query/annual-extras
 */
import { parseMessageContent } from './parse.ts'

/* ────────────── 对外契约 ────────────── */

/** 一行已解码的年度消息（调用方负责解压/编码转换，本模块不碰 DB、不碰 Buffer）。 */
export interface AnnualRowInput {
  /** 微信 type 列。 */
  type: number
  /** 秒级时间戳。 */
  ts: number
  /** 已解码正文（XML 与纯文本都在这里）。 */
  text: string
  /** 发送者显示名。 */
  sender: string
  /** 是否我发的。 */
  mine: boolean
}

/** 这条消息所属的会话。 */
export interface AnnualChatInput {
  username: string
  name: string
  /** 是否群聊（chatroom）。 */
  isGroup: boolean
}

/** 年度资金（转账/红包）汇总。 */
export interface AnnualMoney {
  /** 全年资金类消息**笔数**。 */
  count: number
  /** 金额合计（元，两位小数）。 */
  total: number
  /** 最大一笔的金额。 */
  topAmount: number
  /** 最大一笔对应的会话显示名（拿不到就空串）。 */
  topPeerName: string
  /** 往来金额 TOP5（按金额倒序，同额按 username 升序，保证确定性）。 */
  byPeer: Array<{ username: string; name: string; amount: number; count: number }>
}

/** 年度撤回汇总。 */
export interface AnnualRevoke {
  /** 全年撤回条数。 */
  count: number
  /** 撤回最多的会话显示名（拿不到就空串）。 */
  topPeerName: string
  /** 24 个时段桶（0..23 点）的撤回条数。 */
  byHour: number[]
}

/** 群聊年度汇总。 */
export interface AnnualGroups {
  /** 全年群聊消息条数（含所有人）。 */
  messages: number
  /** 群聊占全年全部消息的比例（0..1，全部消息为 0 时给 0）。 */
  share: number
  /** 最活跃的群 TOP5（按条数倒序，同数按 username 升序）。 */
  top: Array<{ username: string; name: string; count: number }>
}

/* ────────────── 口径常量 ────────────── */

/**
 * 金额取数正则：**与 `ledger.ts#parseAmount` 逐字相同**（取第一段 `[\d.]+`）。
 * 故意不加千分位支持：两处口径必须一致，否则账本与年报会对不上（见文件头缺口 ②）。
 */
const RE_AMOUNT = /[\d.]+/
/** 「分」单位后缀：只有紧跟在数字后面时才算单位（`100分` ⇒ 1 元）。 */
const RE_FEN_SUFFIX = /^\s*分/
/** 撤回标记（`<sysmsg type="revokemsg">` / `<revokemsg>`），大小写不敏感。 */
const RE_REVOKE_MARK = /revokemsg/i
/** 系统消息类型（`revoke-retain.ts` 只看这一个）。 */
const TYPE_SYSTEM = 10000
/** 系统消息里独立成「撤回」的另一档（`parse.ts` 的 case 10002）。 */
const TYPE_SYSTEM_REVOKE = 10002
/** 群聊会话名后缀。 */
const GROUP_SUFFIX = '@chatroom'
/** 榜单长度。 */
const TOP_N = 5
/** 时段桶数。 */
const HOURS = 24
/** `local_type` 归一化的上界（高 32 位带进来时取模）。 */
const TYPE_MOD = 4294967296

/* ────────────── 小工具（纯函数） ────────────── */

/**
 * 归一化 `local_type`：高 32 位被带进来时取低 32 位。
 * @param lt - 原始 `type` / `local_type`。
 * @returns 归一化后的类型。
 */
function normType(lt: number): number {
  return lt > TYPE_MOD ? lt % TYPE_MOD : lt
}

/**
 * 金额取整到**分**。`feedesc` 本身就是两位小数，这一步只收口 `1.005` 这类脏小数点与浮点残渣，
 * 并保证「同一分钱」的两个来源（逐笔累加 vs 直接写死）产生**完全相同的 double** —— 排序判据要用。
 * @param n - 元为单位的金额。
 * @returns 两位小数（四舍五入到分）的金额。
 */
function toYuan(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * 会话显示名。
 * @param chat - 会话。
 * @returns `name` 非空用它，否则退回 `username`（`annual-review.ts#nameOf` 同口径）。
 */
function displayNameOf(chat: AnnualChatInput): string {
  const name = chat.name.trim()
  return name !== '' ? name : chat.username
}

/**
 * username 的确定性比较（**码元序**）。
 * 不能用 `localeCompare`：它随 locale／ICU 变，同一份数据在不同机器上会排出不同榜单。
 * @param a - 左。
 * @param b - 右。
 * @returns 负数/0/正数，同 `Array#sort` 的约定。
 */
function byUsernameAsc(a: string, b: string): number {
  if (a === b) return 0
  return a < b ? -1 : 1
}

/**
 * 会话是不是群聊。
 *
 * `isGroup` 由调用方给出（`annual-review.ts` 用的是 `username.endsWith('@chatroom')`），
 * 这里两者取**或**：`@chatroom` 是微信的群会话后缀，不可能出现在单聊上，
 * 所以「或」只在调用方把 `isGroup` 设错时生效，方向上只会更接近年报的群口径。
 * @param chat - 会话。
 * @returns 是群聊则为 true。
 */
function isGroupChat(chat: AnnualChatInput): boolean {
  return chat.isGroup || chat.username.endsWith(GROUP_SUFFIX)
}

/* ────────────── 资金 ────────────── */

/**
 * 从一段含金额的文本里取出**元**为单位的金额。
 *
 * 与 `ledger.ts#parseAmount` 的唯一有意差异：区分「读不出」与「真的是 0」——
 * 这里读不出给 `null`（调用方不计入），而 ledger 给 `0`（会被记成 0 元一笔）。
 * 另外数字后面紧跟 `分` 时按 1/100 元折算（ledger 会把 `100分` 读成 100 元，虚高 100 倍）。
 * @param raw - `feedesc` / `title` 之类的原始串（可能带 `￥`）。
 * @returns 金额（元，两位小数）；没有任何数字时返回 `null`。
 */
function parseAmountYuan(raw: string): number | null {
  const m = RE_AMOUNT.exec(raw)
  const digits = m === null ? undefined : m[0]
  // exec 成功时第 0 组必定存在；这里只是 `noUncheckedIndexedAccess` 下的类型收口。
  if (m === null || digits === undefined) return null
  const n = Number(digits)
  if (!Number.isFinite(n)) return null
  const rest = raw.slice(m.index + digits.length)
  return toYuan(RE_FEN_SUFFIX.test(rest) ? n / 100 : n)
}

/**
 * 一条消息里的**资金金额**（转账/红包），照 `ledger.ts#paymentFromContent` 的口径取。
 *
 * 先 `text.includes('<appmsg')` 挡一道再做解析：本模块对**整年每一行**都要跑，而转账/红包
 * 一定带 `<appmsg>` 包裹（见文件头缺口 ④）。
 * @param text - 已解码正文。
 * @returns 金额（元）；不是转账/红包、或金额读不出时返回 `null`。
 */
function moneyAmountOf(text: string): number | null {
  if (!text.includes('<appmsg')) return null
  const rich = parseMessageContent(49, text, false).rich
  if (rich === undefined) return null
  // appmsg 2000 ⇒ transfer（金额在 title = feedesc）；2001/2003 ⇒ redpacket（金额在 amount）。
  if (rich.type === 'transfer') return parseAmountYuan(rich.title ?? '')
  if (rich.type === 'redpacket') return parseAmountYuan(rich.amount ?? '')
  return null
}

/* ────────────── 撤回 ────────────── */

/**
 * 一行是不是**撤回**消息。
 *
 * 与 `revoke-retain.ts` 同源（`local_type = 10000` + 「撤回了一条消息」文案），并补上两条
 * 既有实现已经识别的形态：`<sysmsg type="revokemsg">` 标记（`parseSystemMessage` 认它，
 * 即使 `customtip` 里没有那句文案）与 `local_type = 10002`（`parse.ts` 直接判成撤回）。
 * 非系统消息只有正文带 `revokemsg` 标记才算 —— 免得把「引用/复述撤回提示」的普通文本算进来。
 * @param row - 年度消息行。
 * @returns 是撤回则为 true。
 */
function isRevokeRow(row: AnnualRowInput): boolean {
  const text = row.text
  if (text === '') return false
  const lt = normType(row.type)
  if (lt === TYPE_SYSTEM_REVOKE) return true
  if (lt !== TYPE_SYSTEM) return RE_REVOKE_MARK.test(text)
  return parseMessageContent(TYPE_SYSTEM, text).sysKind === 'revoke'
}

/* ────────────── 累加桶 ────────────── */

/** 按会话累计金额 + 笔数（资金 TOP5 用）。 */
interface PeerAgg {
  username: string
  name: string
  amount: number
  count: number
}

/** 按会话累计条数（群 TOP5 / 撤回最多用）。 */
interface CountAgg {
  username: string
  name: string
  count: number
}

/**
 * 条数累加（会话首次出现时建桶）。`name` 先到先得，空串会被后到的非空名字补上。
 * @param map - 桶表。
 * @param username - 会话标识（唯一键）。
 * @param name - 会话显示名。
 */
function bumpCount(map: Map<string, CountAgg>, username: string, name: string): void {
  const cur = map.get(username)
  if (cur === undefined) {
    map.set(username, { username, name, count: 1 })
    return
  }
  cur.count += 1
  if (cur.name === '') cur.name = name
}

/**
 * 金额累加（会话首次出现时建桶）。
 * @param map - 桶表。
 * @param username - 会话标识（唯一键）。
 * @param name - 会话显示名。
 * @param amount - 这一笔的金额（元）。
 */
function bumpMoney(map: Map<string, PeerAgg>, username: string, name: string, amount: number): void {
  const cur = map.get(username)
  if (cur === undefined) {
    map.set(username, { username, name, amount, count: 1 })
    return
  }
  cur.amount += amount
  cur.count += 1
  if (cur.name === '') cur.name = name
}

/* ────────────── 结果装配（只读，不碰内部状态） ────────────── */

/**
 * 资金 TOP5。排序键是**取整到分之后**的金额：与卡片上显示的数字是同一个数，
 * 于是「显示同额」一定走 username 升序这条判据（浮点残渣不会插进来）。
 * @param map - 资金桶表。
 * @returns 至多 5 条（新建对象，改它不影响内部状态）。
 */
function topMoneyPeers(map: Map<string, PeerAgg>): AnnualMoney['byPeer'] {
  return [...map.values()]
    .map((p) => ({ username: p.username, name: p.name, amount: toYuan(p.amount), count: p.count }))
    .sort((a, b) => b.amount - a.amount || byUsernameAsc(a.username, b.username))
    .slice(0, TOP_N)
}

/**
 * 群聊 TOP5（条数倒序，同数按 username 升序）。
 * @param map - 群聊桶表。
 * @returns 至多 5 条（新建对象）。
 */
function topGroups(map: Map<string, CountAgg>): AnnualGroups['top'] {
  return [...map.values()]
    .map((p) => ({ username: p.username, name: p.name, count: p.count }))
    .sort((a, b) => b.count - a.count || byUsernameAsc(a.username, b.username))
    .slice(0, TOP_N)
}

/**
 * 撤回最多的会话显示名（同数按 username 升序取第一个）。
 * @param map - 撤回桶表。
 * @returns 会话显示名；一条撤回都没有时返回空串。
 */
function topRevokePeerName(map: Map<string, CountAgg>): string {
  const best = [...map.values()].sort((a, b) => b.count - a.count || byUsernameAsc(a.username, b.username))[0]
  return best === undefined ? '' : best.name
}

/**
 * 建一个累加器：`onRow` 每行调一次，`done()` 取结果（可重复调用，不得改内部状态）。
 *
 * 用法（接在 `annual-review.ts` 的行循环里）：
 * ```ts
 * const extras = createAnnualExtras()
 * for (const r of cur) {
 *   extras.onRow({ type, ts, text, sender, mine }, { username, name, isGroup })
 * }
 * const { money, revoke, groups } = extras.done()
 * ```
 * @returns `{ onRow, done }` 两个纯函数。
 */
export function createAnnualExtras(): {
  onRow(row: AnnualRowInput, chat: AnnualChatInput): void
  done(): { money: AnnualMoney; revoke: AnnualRevoke; groups: AnnualGroups }
} {
  /** 全年全部消息条数（群聊占比的分母）。 */
  let rows = 0
  /** 群聊消息条数（含所有人）。 */
  let groupMessages = 0
  const groupAgg = new Map<string, CountAgg>()
  /** 资金：笔数 / 合计 / 最大一笔（及其会话）。 */
  let moneyCount = 0
  let moneyTotal = 0
  let hasTop = false
  let topAmount = 0
  let topPeerUsername = ''
  let topPeerName = ''
  const moneyPeer = new Map<string, PeerAgg>()
  /** 撤回：条数 / 时段桶 / 按会话。 */
  let revokeCount = 0
  const revokeByHour = new Array<number>(HOURS).fill(0)
  const revokePeer = new Map<string, CountAgg>()

  const onRow = (row: AnnualRowInput, chat: AnnualChatInput): void => {
    const ts = row.ts
    if (!Number.isFinite(ts) || ts <= 0) return
    rows += 1
    const name = displayNameOf(chat)

    if (isGroupChat(chat)) {
      groupMessages += 1
      bumpCount(groupAgg, chat.username, name)
    }

    const amount = moneyAmountOf(row.text)
    if (amount !== null) {
      moneyCount += 1
      moneyTotal += amount
      bumpMoney(moneyPeer, chat.username, name, amount)
      // 「最大一笔」同额时按 username 升序定主，避免结果依赖行序（分片并行/顺序变化都会改行序）。
      if (!hasTop || amount > topAmount
        || (amount === topAmount && byUsernameAsc(chat.username, topPeerUsername) < 0)) {
        hasTop = true
        topAmount = amount
        topPeerUsername = chat.username
        topPeerName = name
      }
    }

    if (isRevokeRow(row)) {
      revokeCount += 1
      const hour = new Date(ts * 1000).getHours()
      revokeByHour[hour] = (revokeByHour[hour] ?? 0) + 1
      bumpCount(revokePeer, chat.username, name)
    }
  }

  const done = (): { money: AnnualMoney; revoke: AnnualRevoke; groups: AnnualGroups } => ({
    money: {
      count: moneyCount,
      total: toYuan(moneyTotal),
      topAmount: hasTop ? toYuan(topAmount) : 0,
      topPeerName: hasTop ? topPeerName : '',
      byPeer: topMoneyPeers(moneyPeer),
    },
    revoke: {
      count: revokeCount,
      topPeerName: topRevokePeerName(revokePeer),
      byHour: [...revokeByHour],
    },
    groups: {
      messages: groupMessages,
      share: rows > 0 ? groupMessages / rows : 0,
      top: topGroups(groupAgg),
    },
  })

  return { onRow, done }
}
