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
 * · **资金**：与 `ledger.ts#paymentFromContent` 共用 `payment-money.ts`。金额按整数
 *   “分”解析，千分位、元/分单位可识别，外币与畸形值明确拒绝；读不到就是未知，
 *   绝不折算成 0。转账按 `<transferid>` 去重，双方均非当前账号的第三方转账不进入
 *   个人年度资金。红包卡本身不证明当前账号领取，只有本机系统消息中的
 *   `你领取了…红包`（收）或 `…领取了你的红包`（发）才计入。
 * · **撤回**：与 `revoke-retain.ts` 的提示判据同源（`local_type = 10000` + 文案），并补上
 *   `parse-system.ts#parseSystemMessage` 已经识别的 `<sysmsg type="revokemsg">` 标记形态
 *   （实测有 `customtip` 里不带「撤回了一条消息」字样的），以及 `parse.ts` 里独立成案的
 *   `local_type = 10002`。
 * · **时段**：`new Date(ts * 1000).getHours()` ⇒ **本地时区**，与 `annual-review.ts` 的
 *   `hourAll`／深夜／作息完全相同（那边也是本地时区，不是 UTC）。
 * · `AnnualRowInput.mine` / `senderUsername` 用于区分收发与真实往来人；`sender`
 *   仅作展示名兜底，不拿来冒充 username。
 *
 * ## 识别不了的形态（已知缺口；**解析不出就不计入 count/total，绝不用 0 混进合计**）
 *
 *  ① `feedesc` 缺失或为空的红包/转账（部分客户端不下发金额）⇒ 计入 `amountUnknownCount`，
 *     不进入金额合计、最大一笔或 TOP 排行。
 *  ② 外币（`HK$`／`US$`／`$`）⇒ 明确拒绝并计入未知，不冒充人民币。
 *  ③ 红包卡有 `feedesc` 但本机没有领取/退回系统消息 ⇒ 不进入个人资金合计。
 *  ④ 没有 `<appmsg>` 包裹的裸片段（形如 `<type>2000</type><feedesc>￥1</feedesc>`）⇒ 不计入：
 *     `parseAppmsgType` 在没有 `<appmsg>` 时会退化成「在整段文本里找 `<type>`」，而本模块
 *     为了不把整年每一行都送进 appmsg 解析器，先用 `text.includes('<appmsg')` 挡了一道
 *     （onRow 里先检查 `<appmsg>`）。真实数据里转账/红包一定带 `<appmsg>` 包裹。
 *  ⑤ 图片里的转账截图、聊天记录卡片（`<recorditem>` 内嵌的转账）、语音里说的金额 ⇒ 不计入。
 *  ⑥ 群收款／AA 收款与普通转账同为 appmsg 2000；在拿到权威字段语义前，只按
 *     `transferid` 计一次，不根据 `paysubtype` 猜测场景。
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
import { displayNameForUsername } from './message-identity.ts'
import { centsToYuan, parseCnyAmount } from './payment-money.ts'

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
  /** Message-table sender identity when Name2Id resolves it. */
  senderUsername?: string
  /** 消息 server_id；仅用于没有业务 id 的卡片去重。 */
  serverId?: string
}

/** 这条消息所属的会话。 */
export interface AnnualChatInput {
  username: string
  name: string
  /** 企业名称（仅企业微信单聊；群聊/普通联系人缺省）。 */
  enterpriseName?: string
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
  /** 最大一笔对应的会话 username（拿不到就空串）。 */
  topPeerUsername: string
  /** 最大一笔对应会话的企业名称（仅企业微信单聊）。 */
  topPeerEnterpriseName?: string
  /** 往来金额 TOP5（按金额倒序，同额按 username 升序，保证确定性）。 */
  byPeer: Array<{ username: string; name: string; enterpriseName?: string; amount: number; count: number }>
  /** Confirmed money events whose amount is absent/foreign/malformed. */
  amountUnknownCount?: number
  /** Incoming red packets with no local system-message claim evidence. */
  unconfirmedRedpacketCount?: number
  /** Transfers where both payer and receiver are other accounts. */
  thirdPartyTransferCount?: number
}

/** 年度撤回汇总。 */
export interface AnnualRevoke {
  /** 全年撤回条数。 */
  count: number
  /** 撤回最多的会话显示名（拿不到就空串）。 */
  topPeerName: string
  /** 撤回最多会话的 username（拿不到就空串）。 */
  topPeerUsername: string
  /** 撤回最多会话的企业名称（仅企业微信单聊）。 */
  topPeerEnterpriseName?: string
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

/** 撤回标记（`<sysmsg type="revokemsg">` / `<revokemsg>`），大小写不敏感。 */
const RE_REVOKE_MARK = /revokemsg/i
/** 红包系统消息里的 sendid（链接参数或纯文本参数）。 */
const RE_SEND_ID = /(?:[?&]sendid=|sendid=)([^&"'<>\\\s]+)/i
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

/** Read a simple XML tag, including CDATA-wrapped values. */
function xmlField(text: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?\\s*</${tag}>`, 'i')
  return re.exec(text)?.[1]?.trim() ?? ''
}

function transferIdOf(text: string): string {
  return xmlField(text, 'transferid')
}

function redpacketIdOf(text: string): string {
  return xmlField(text, 'paymsgid') || RE_SEND_ID.exec(text)?.[1] || ''
}

type RedpacketEvidenceKind = 'selfClaimed' | 'otherClaimed' | 'returned'

function redpacketEvidenceOf(text: string): { sendId: string; kind: RedpacketEvidenceKind } | null {
  const sendId = RE_SEND_ID.exec(text)?.[1] ?? ''
  if (sendId === '' || !text.includes('红包')) return null
  if (/红包.*(?:退回|退还)|未领取.*退回|超过24小时未领取/.test(text)) {
    return { sendId, kind: 'returned' }
  }
  if (text.includes('你领取了')) return { sendId, kind: 'selfClaimed' }
  if (text.includes('领取了你的') || text.includes('已被领完')) {
    return { sendId, kind: 'otherClaimed' }
  }
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
  enterpriseName?: string
  amountCents: number
  count: number
}

/** 按会话累计条数（群 TOP5 / 撤回最多用）。 */
interface CountAgg {
  username: string
  name: string
  enterpriseName?: string
  count: number
}

/**
 * 条数累加（会话首次出现时建桶）。`name` 先到先得，空串会被后到的非空名字补上。
 * @param map - 桶表。
 * @param username - 会话标识（唯一键）。
 * @param name - 会话显示名。
 */
function bumpCount(map: Map<string, CountAgg>, username: string, name: string, enterpriseName?: string): void {
  const cur = map.get(username)
  if (cur === undefined) {
    map.set(username, {
      username,
      name,
      ...(enterpriseName !== undefined ? { enterpriseName } : {}),
      count: 1,
    })
    return
  }
  cur.count += 1
  if (cur.name === '') cur.name = name
  if (cur.enterpriseName === undefined && enterpriseName !== undefined) cur.enterpriseName = enterpriseName
}

/**
 * 金额累加（会话首次出现时建桶）。
 * @param map - 桶表。
 * @param username - 会话标识（唯一键）。
 * @param name - 会话显示名。
 * @param amountCents - 这一笔的金额（整数分）。
 */
function bumpMoney(
  map: Map<string, PeerAgg>,
  username: string,
  name: string,
  enterpriseName: string | undefined,
  amountCents: number,
): void {
  const cur = map.get(username)
  if (cur === undefined) {
    map.set(username, {
      username,
      name,
      ...(enterpriseName !== undefined ? { enterpriseName } : {}),
      amountCents,
      count: 1,
    })
    return
  }
  cur.amountCents += amountCents
  cur.count += 1
  if (cur.name === '') cur.name = name
  if (cur.enterpriseName === undefined && enterpriseName !== undefined) cur.enterpriseName = enterpriseName
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
    .map((p) => ({
      username: p.username,
      name: p.name,
      ...(p.enterpriseName !== undefined ? { enterpriseName: p.enterpriseName } : {}),
      amount: centsToYuan(p.amountCents),
      count: p.count,
    }))
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
 * 撤回最多的会话（同数按 username 升序取第一个）。
 * @param map - 撤回桶表。
 * @returns 会话 username、显示名与企业名；一条撤回都没有时三者都为空。
 */
function topRevokePeer(map: Map<string, CountAgg>): { username: string; name: string; enterpriseName?: string } {
  const best = [...map.values()].sort((a, b) => b.count - a.count || byUsernameAsc(a.username, b.username))[0]
  return {
    username: best?.username ?? '',
    name: best?.name ?? '',
    ...(best?.enterpriseName !== undefined ? { enterpriseName: best.enterpriseName } : {}),
  }
}

interface MoneyEvent {
  username: string
  name: string
  enterpriseName?: string
  amountCents: number | null
}

interface PendingRedpacket extends MoneyEvent {
  sendId: string
  mine: boolean
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
export function createAnnualExtras(options: {
  selfUsername?: string
  names?: ReadonlyMap<string, string>
  enterpriseNames?: ReadonlyMap<string, string>
} = {}): {
  onRow(row: AnnualRowInput, chat: AnnualChatInput): void
  done(): { money: AnnualMoney; revoke: AnnualRevoke; groups: AnnualGroups }
} {
  /** 全年全部消息条数（群聊占比的分母）。 */
  let rows = 0
  /** 群聊消息条数（含所有人）。 */
  let groupMessages = 0
  const groupAgg = new Map<string, CountAgg>()
  const self = options.selfUsername?.trim() ?? ''
  const moneyEvents: MoneyEvent[] = []
  const seenMoneyCards = new Set<string>()
  const pendingRedpackets = new Map<string, PendingRedpacket>()
  const redpacketEvidence = {
    selfClaimed: new Set<string>(),
    otherClaimed: new Set<string>(),
    returned: new Set<string>(),
  } satisfies Record<RedpacketEvidenceKind, Set<string>>
  let thirdPartyTransferCount = 0
  /** 撤回：条数 / 时段桶 / 按会话。 */
  let revokeCount = 0
  const revokeByHour = new Array<number>(HOURS).fill(0)
  const revokePeer = new Map<string, CountAgg>()

  const onRow = (row: AnnualRowInput, chat: AnnualChatInput): void => {
    const ts = row.ts
    if (!Number.isFinite(ts) || ts <= 0) return
    rows += 1
    const name = displayNameOf(chat)
    const enterpriseName = chat.enterpriseName?.trim() || undefined

    if (isGroupChat(chat)) {
      groupMessages += 1
      bumpCount(groupAgg, chat.username, name, enterpriseName)
    }

    const lt = normType(row.type)
    if (lt === TYPE_SYSTEM || lt === TYPE_SYSTEM_REVOKE || row.text.includes('SystemMessages_HongbaoIcon.png')) {
      const proof = redpacketEvidenceOf(row.text)
      if (proof !== null) redpacketEvidence[proof.kind].add(proof.sendId)
    }

    const rich = row.text.includes('<appmsg')
      ? parseMessageContent(49, row.text, false).rich
      : undefined
    if (rich?.type === 'transfer') {
      const transferId = transferIdOf(row.text)
      const cardKey = transferId
        ? `transfer:${transferId}`
        : row.serverId
          ? `server:${row.serverId}`
          : `transfer:${row.ts}:${chat.username}:${row.text}`
      if (!seenMoneyCards.has(cardKey)) {
        seenMoneyCards.add(cardKey)
        const payer = xmlField(row.text, 'payer_username')
        const receiver = xmlField(row.text, 'receiver_username')
        const thirdParty = self !== ''
          && payer !== ''
          && receiver !== ''
          && payer !== self
          && receiver !== self
        if (thirdParty) {
          thirdPartyTransferCount += 1
        } else {
          const peerUsername = !row.mine && row.senderUsername
            ? row.senderUsername
            : row.mine && receiver !== '' && receiver !== self
              ? receiver
              : chat.username
          const peerName = peerUsername === chat.username
            ? name
            : displayNameForUsername(peerUsername, options.names)
          const peerEnterpriseName = peerUsername === chat.username
            ? enterpriseName
            : options.enterpriseNames?.get(peerUsername)?.trim() || undefined
          moneyEvents.push({
            username: peerUsername,
            name: peerName,
            ...(peerEnterpriseName === undefined ? {} : { enterpriseName: peerEnterpriseName }),
            amountCents: parseCnyAmount(rich.title ?? '').cents,
          })
        }
      }
    } else if (rich?.type === 'redpacket') {
      const sendId = redpacketIdOf(row.text)
      const cardKey = sendId
        ? `redpacket:${sendId}`
        : row.serverId
          ? `server:${row.serverId}`
          : `redpacket:${row.ts}:${chat.username}:${row.text}`
      if (!seenMoneyCards.has(cardKey)) {
        seenMoneyCards.add(cardKey)
        const rpPeerUsername = !row.mine && row.senderUsername ? row.senderUsername : chat.username
        const rpPeerName = rpPeerUsername === chat.username
          ? name
          : displayNameForUsername(rpPeerUsername, options.names)
        const rpEnterpriseName = rpPeerUsername === chat.username
          ? enterpriseName
          : options.enterpriseNames?.get(rpPeerUsername)?.trim() || undefined
        pendingRedpackets.set(cardKey, {
          sendId,
          mine: row.mine,
          username: rpPeerUsername,
          name: rpPeerName,
          ...(rpEnterpriseName === undefined ? {} : { enterpriseName: rpEnterpriseName }),
          amountCents: parseCnyAmount(rich.amount ?? '').cents,
        })
      }
    }

    if (isRevokeRow(row)) {
      revokeCount += 1
      const hour = new Date(ts * 1000).getHours()
      revokeByHour[hour] = (revokeByHour[hour] ?? 0) + 1
      bumpCount(revokePeer, chat.username, name, enterpriseName)
    }
  }

  const done = (): { money: AnnualMoney; revoke: AnnualRevoke; groups: AnnualGroups } => {
    const revokeTop = topRevokePeer(revokePeer)
    const events = [...moneyEvents]
    let unconfirmedRedpacketCount = 0
    for (const rp of pendingRedpackets.values()) {
      const isReturned = rp.sendId !== '' && redpacketEvidence.returned.has(rp.sendId)
      const confirmed = rp.mine
        ? isReturned || (rp.sendId !== '' && redpacketEvidence.otherClaimed.has(rp.sendId))
        : rp.sendId !== '' && redpacketEvidence.selfClaimed.has(rp.sendId)
      if (!confirmed) {
        if (!rp.mine) unconfirmedRedpacketCount += 1
        continue
      }
      if (isReturned && rp.mine) continue
      events.push(rp)
    }

    const moneyPeer = new Map<string, PeerAgg>()
    let moneyCount = 0
    let moneyTotalCents = 0n
    let amountUnknownCount = 0
    let hasTop = false
    let topAmountCents = 0
    let topPeerUsername = ''
    let topPeerName = ''
    let topPeerEnterpriseName: string | undefined
    for (const event of events) {
      moneyCount += 1
      if (event.amountCents === null) {
        amountUnknownCount += 1
        continue
      }
      moneyTotalCents += BigInt(event.amountCents)
      bumpMoney(moneyPeer, event.username, event.name, event.enterpriseName, event.amountCents)
      if (!hasTop || event.amountCents > topAmountCents
        || (event.amountCents === topAmountCents && byUsernameAsc(event.username, topPeerUsername) < 0)) {
        hasTop = true
        topAmountCents = event.amountCents
        topPeerUsername = event.username
        topPeerName = event.name
        topPeerEnterpriseName = event.enterpriseName
      }
    }
    return {
      money: {
        count: moneyCount,
        total: centsToYuan(Number(moneyTotalCents)),
        topAmount: hasTop ? centsToYuan(topAmountCents) : 0,
        topPeerName: hasTop ? topPeerName : '',
        topPeerUsername: hasTop ? topPeerUsername : '',
        ...(hasTop && topPeerEnterpriseName !== undefined ? { topPeerEnterpriseName } : {}),
        byPeer: topMoneyPeers(moneyPeer),
        ...(amountUnknownCount > 0 ? { amountUnknownCount } : {}),
        ...(unconfirmedRedpacketCount > 0 ? { unconfirmedRedpacketCount } : {}),
        ...(thirdPartyTransferCount > 0 ? { thirdPartyTransferCount } : {}),
      },
      revoke: {
        count: revokeCount,
        topPeerName: revokeTop.name,
        topPeerUsername: revokeTop.username,
        ...(revokeTop.enterpriseName !== undefined ? { topPeerEnterpriseName: revokeTop.enterpriseName } : {}),
        byHour: [...revokeByHour],
      },
      groups: {
        messages: groupMessages,
        share: rows > 0 ? groupMessages / rows : 0,
        top: topGroups(groupAgg),
      },
    }
  }

  return { onRow, done }
}
