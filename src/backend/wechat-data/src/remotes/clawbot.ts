/**
 * 微信 ClawBot 集成 的 @Remote 处理器（A 方案，2026-10-12；iLink 通道同日接入）。
 *
 * 机制：类里保留 `@Remote` 装饰器与签名（协议层按名字枚举），方法体一行转发；
 * 处理器体在这里，依赖由 `rc` 显式给出（与 `remotes/opslog.ts` 同范式）。
 *
 * 十二个对外方法。**实例管理四个**（多实例，2026-10-13）：`listClawbotInstances` /
 * `createClawbotInstance` / `deleteClawbotInstance` / `setClawbotInstanceConfig`；
 * **绑定与会话八个**（均带可选 `slot`，缺省 = 第一个实例）：`getClawbotBinding` /
 * `createClawbotBindQr` / `getClawbotBindState` / `unbindClawbot` / `listClawbotMessages` /
 * `checkClawbotEnv` / `sendClawbotMessage` / `getClawbotMedia`。
 *
 * ## 多实例（2026-10-13）
 *
 * **一实例一条长轮询**：通道注册表是 `Map<slot, ClawbotChannel>`（见工厂里的 `channelFor`）。
 * 一条串行循环会让几个号互相饿死，而且「这一批消息属于哪个号」根本无从分辨 ——
 * 游标（`sync_buf`）、落库（`clawbot_message.slot`）、事件与附件队列全部按实例分开。
 * 扫码会话同理按 slot 分开（用户可能同时给两个号取码）。
 * 实例与配置的**存储语义**在 `query/clawbot/clawbot-instance.ts`（配置的唯一入口）；本文件只管通道、事件与转发。
 * 工厂里的两个**内部方法**（不加 `@Remote`、不进 `docs/API.md`）：`bindClawbotWechat`
 * （扫码确认后回写身份 + 凭证并拉起通道）与 `ensureClawbotChannel`（启动钩子）；
 * 重量级主体都提成了**模块级函数**：`sendClawbotText`（发送）、`mediaFor`（取媒体）、
 * `insertClawbotMessages`（落库 + 刷新令牌）、`snapshotOf`（快照）——
 * 一是让工厂不越过 `function-size-ratchet` 的 250 行线，二是这些函数都能被单测直驱。
 *
 * ## 绑定流程（一次调用 = 一次上游请求，循环由界面驱动）
 *
 * `createClawbotBindQr`（取码 + 落库 `binding` 态）→ 弹窗打开期间反复调
 * `getClawbotBindState`（每次中继一次 40s 长轮询；标签页在途请求不叠加 ——
 * 同一个在途 promise 直接复用）→ `confirmed` 时落身份/凭证、发事件、拉起通道。
 * 关掉弹窗 = 停止调用：后端不留无人消费的轮询循环。
 *
 * ## 发送（可发可收）
 *
 * `sendClawbotMessage` 是**唯一由内容驱动的出网路径**：正文 = 你在输入框里写的原文，
 * 逐条主动触发；只有服务端 `ret=0` 才落库（`direction='out'`）并发事件 ——
 * 失败不写「已发出」的假记录。会话令牌（`context_token`）取自最近一条入站消息，
 * 由通道在每批消息落库时刷新到绑定行。
 *
 * ## 事件两条（命名沿用 `<域>/<动作>` 惯例）
 *
 * - `clawbot/message`：写入消息后，`{ lastId, delta, slot }` —— **不承载正文**，
 *   前端按 `lastId` 拉增量、按 `slot` 判断是不是当前实例；
 * - `clawbot/binding-changed`：绑定状态迁移后，`{ from, to, wxid }`。
 * emit 一律 try/catch（事件推不出去不该让业务失败，与 `wechat-ask/delta` 同策略）。
 *
 * ## 出网纪律
 *
 * 本文件**不直接出网**：全部网络调用经 `query/clawbot/clawbot-ilink.ts`（唯一接缝，
 * `clawbot-outbound.spec.ts` 逐文件扫描）。请求体只含控制面信息（凭证/游标）与
 * **用户主动发送的正文**（`sendClawbotMessage`，逐条触发）。
 *
 * @module remotes/clawbot
 */
import type {
  ClawbotBindQr,
  ClawbotBindStateSnapshot,
  ClawbotBinding,
  ClawbotBindingSnapshot,
  ClawbotBindingStatus,
  ClawbotChannelInfo,
  ClawbotEnvSnapshot,
  ClawbotInstanceConfig,
  ClawbotInstanceCreated,
  ClawbotInstanceDeleted,
  ClawbotInstancesSnapshot,
  ClawbotMediaResult,
  ClawbotMessageQuery,
  ClawbotMessageSnapshot,
  ClawbotSendResult,
  OperationCategory,
  OperationStatus,
} from '../types.ts'
import type { BindingCredentials } from '../query/clawbot/clawbot-binding.ts'
import { completeBinding, markBindingQr, readBinding, readBindingInternal, readBindings, renameBinding, saveSendContextToken, saveSyncBuf, unbindBinding } from '../query/clawbot/clawbot-binding.ts'
import type { ClawbotMessageInput } from '../query/clawbot/clawbot-message.ts'
import { clearClawbotMessages, clawbotMessageCounts, insertClawbotMessage, listClawbotMediaPending, listClawbotMessages as queryClawbotMessages } from '../query/clawbot/clawbot-message.ts'
import { createClawbotChannel, type ClawbotChannel } from '../query/clawbot/clawbot-channel.ts'
import { DEFAULT_CLAWBOT_SLOT } from '../query/clawbot/clawbot-db.ts'
import { createAutoReplyRunner, type ClawbotAskFn, type ReplyableMessage } from '../query/clawbot/clawbot-auto-reply.ts'
import {
  createClawbotInstance as createInstanceRow,
  deleteClawbotInstance as deleteInstanceRow,
  listClawbotInstances as listInstanceRows,
  readInstanceConfig,
  resolveClawbotSlot,
  saveInstanceConfig,
} from '../query/clawbot/clawbot-instance.ts'
import { ensureClawbotMedia, imageMimeOf, readClawbotMediaBytes } from '../query/clawbot/clawbot-media.ts'
import { createClawbotMediaQueue } from '../query/clawbot/clawbot-media-queue.ts'
import type { IlinkSendResult, WeixinMessage } from '../query/clawbot/clawbot-ilink.ts'
import {
  CLAWBOT_QR_TTL_MS,
  getUpdates as ilinkGetUpdates,
  mapWeixinMessage,
  pollBindStatus as ilinkPollBindStatus,
  requestBindQr as ilinkRequestBindQr,
  sendTextMessage as ilinkSendTextMessage,
} from '../query/clawbot/clawbot-ilink.ts'

/** `clawbot/binding-changed` 的参数（不含任何会话内容）。 */
export interface ClawbotBindingChangedArgs {
  from: ClawbotBindingStatus
  to: ClawbotBindingStatus
  wxid: string | null
}

/**
 * `clawbot/message` 的参数（幂等提示：只带位置、数量与**实例编号**，不带正文）。
 *
 * `slot` 是多实例之后加的：事件是广播给整个渲染层的，前端必须能判断
 * 「这条提示是不是我当前看的那个号」—— 否则 A 号来消息会去刷 B 号的列表。
 */
export interface ClawbotMessageEventArgs {
  lastId: number
  delta: number
  /** 这批消息属于哪个实例（多实例，2026-10-13）。 */
  slot: number
}

/**
 * 事件出口的形状：**名字与载荷成对**（判别联合）。
 *
 * 为什么不做成 `(name, args)` 两个参数：`ctx.emit` 的第一参数是 `keyof Events`、
 * 载荷类型按名字决定，把两个联合类型分开传会立刻丢掉相关性（要么强转、要么判空）。
 * 成对传递后，装配侧一个 `switch` 就能逐条对号入座，类型全程闭合。
 */
export type ClawbotEmitEvent =
  | { name: 'clawbot/binding-changed', args: ClawbotBindingChangedArgs }
  | { name: 'clawbot/message', args: ClawbotMessageEventArgs }

export type ClawbotEmit = (event: ClawbotEmitEvent) => void

/** iLink 依赖的**注入点**（测试全部注入假实现 ⇒ 零出网；生产缺省走真实客户端）。 */
export interface ClawbotIlinkDeps {
  requestBindQr: typeof ilinkRequestBindQr
  pollBindStatus: typeof ilinkPollBindStatus
  getUpdates: typeof ilinkGetUpdates
  sendTextMessage: typeof ilinkSendTextMessage
  sleep: (ms: number) => Promise<void>
}

export interface createClawbotRemotesInputs {
  dirs: () => { decrypted: string }
  op: (category: OperationCategory, action: string, status: OperationStatus, target?: string, detail?: string) => void
  emit: ClawbotEmit
  /** 可选覆盖（测试注入假 fetch/假客户端；不传 = 真实 iLink 客户端 + 真 setTimeout）。 */
  ilink?: Partial<ClawbotIlinkDeps>
  /** 可选覆盖媒体取数与补扫清点（测试注入假实现；不传 = 真实下载解密 + 真实库清点）。 */
  media?: { ensure?: typeof ensureClawbotMedia, listPending?: (limit: number) => number[] }
  /**
   * ask 能力注入点（装配层把 `askDeep.askWechat` 包一层传进来）。
   *
   * 为什么注入而不是在本文件 import 问答管道：管道理面同时住着**模型解析**
   * （设置里的「对话模型」）与**隐私闸**，抄一份到这里就等于开了一条不受闸门管的旁路。
   * 注入一份调用 ⇒ 自动回复与手动问答走**同一条路**（在自动回复批次把
   * `askDeep.askWechat` 包一层接进来）。
   * 缺省（不传）= 自动回复不可用：收到消息只落库。
   */
  ask?: ClawbotAskFn
}

/**
 * 自动回复的 ask 能力（**家**在 `query/clawbot/clawbot-auto-reply.ts` —— query 层不许反过来依赖 remotes）；
 * 这里 re-export 保持既有导入路径不变。
 */
export type { ClawbotAskFn } from '../query/clawbot/clawbot-auto-reply.ts'

/** 事件尽力而为：推不出去（没窗口 / IPC 断了）不该让绑定或落库失败。 */
function safeEmit(rc: createClawbotRemotesInputs, event: ClawbotEmitEvent): void {
  try {
    rc.emit(event)
  } catch { /* event best-effort */ }
}

/** 当天 0 点（本地时区）——「今日消息」的口径与操作日志的 from/to 语义一致。 */
function startOfToday(): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 进行中的扫码会话（内存态；进程重启即失效 —— 那是「重新生成」按钮要覆盖的场景）。 */
interface ClawbotBindSession {
  /** 这一场会话属于哪个实例（多实例下各自取码、各自收尾）。 */
  slot: number
  token: string
  /** 二维码内容（就是这一轮 UI 正在画的那张）。 */
  payload: string
  expiresAt: number
  /** 服务端最近一次明确状态（unknown/error 不改它）。 */
  state: 'wait' | 'scaned' | 'confirmed' | 'expired'
  /** 在途轮询（多个调用复用同一个上游请求，不叠加）。 */
  inFlight: Promise<ClawbotBindStateSnapshot> | null
}

/**
 * 发送主体：前置校验 → 上游发送 → 只有 `ret=0` 才落库（`direction='out'`）。
 *
 * 提成模块级函数（而不是留在工厂里）是为了让 `createClawbotRemotes` 不越过
 * `function-size-ratchet` 的 250 行线；依赖三项全部显式传入，无闭包状态。
 * @param decryptedDir - 解密数据根。
 * @param ilink - iLink 依赖（生产 = 真客户端；测试注入假实现）。
 * @param options.text - 正文原文。
 * @param slot - 实例编号（哪条绑定行的凭证与令牌）。
 * @returns 发送结果（见 {@link ClawbotSendResult}）；**事件由调用方发**。
 */
async function sendClawbotText(
  decryptedDir: string,
  ilink: ClawbotIlinkDeps,
  options: { text: string },
  slot: number,
): Promise<ClawbotSendResult> {
  const text = typeof options?.text === 'string' ? options.text : ''
  if (text.trim() === '') return { ok: false, id: null, error: '消息内容为空' }
  const { binding, credentials, sendContextToken } = readBindingInternal(decryptedDir, slot)
  if (binding.status !== 'bound' || credentials === null) {
    return { ok: false, id: null, error: '尚未绑定微信（先到「集成设置」完成绑定）' }
  }
  const toUserId = credentials.ilinkUserId !== '' ? credentials.ilinkUserId : (binding.wxid ?? '')
  if (toUserId === '') return { ok: false, id: null, error: '缺少微信侧用户标识（重新绑定一次试试）' }
  if (sendContextToken === '') {
    return { ok: false, id: null, error: '还没有可用会话：请先在微信里给它发一条消息，再从这里回复' }
  }
  let resp: IlinkSendResult
  try {
    resp = await ilink.sendTextMessage(credentials, { toUserId, text, contextToken: sendContextToken })
  } catch (e) {
    return { ok: false, id: null, error: '发送失败：' + (e instanceof Error ? e.message : String(e)) }
  }
  if (resp.ret !== 0) {
    return { ok: false, id: null, error: `发送被服务端拒绝（ret=${String(resp.ret)}${resp.errMsg !== '' ? '：' + resp.errMsg : ''}）` }
  }
  const id = insertClawbotMessage(decryptedDir, { slot, ts: Date.now(), direction: 'out', msgType: 'text', content: text })
  return { ok: true, id }
}

/**
 * 绑定卡片快照（绑定行 + 会话计数 + 通道状态；读失败随行带出）。
 *
 * 提成模块级函数是为了让 `createClawbotRemotes` 不越过 `function-size-ratchet`
 * 的 250 行线；依赖两项显式传入。
 * @param decryptedDir - 解密数据根。
 * @param slot - 实例编号（会话计数按实例分）。
 * @param channel - 该实例通道的运行态（**只读快照**，不持通道句柄 —— 读卡片不该建通道）。
 * @returns 绑定卡片快照。
 */
function snapshotOf(decryptedDir: string, slot: number, channel: ClawbotChannelInfo): ClawbotBindingSnapshot {
  const { binding, readError } = readBinding(decryptedDir, slot)
  const counts = clawbotMessageCounts(decryptedDir, { since: startOfToday(), slot })
  return {
    binding,
    todayMessages: counts.today,
    totalMessages: counts.total,
    channel: { running: channel.running, error: channel.error },
    ...(readError === undefined ? {} : { readError }),
  }
}

/** 媒体取数的注入点（测试注入假实现 ⇒ 零出网）。 */
export interface ClawbotMediaDeps {
  ensure: typeof ensureClawbotMedia
}

/** 图片内联上限：超过只给本机路径（防把大 base64 搬过 IPC）。 */
export const CLAWBOT_INLINE_MAX_BYTES = 12 * 1024 * 1024

/**
 * 取媒体主体（模块级：让工厂不越棘轮线，且可被单测直驱）。
 *
 * 图片且未超内联上限时给 `dataUrl`；其余（含过大的图片）只给本机路径 ——
 * 界面对图片画小图、对别的类型走 `openPath`。缓存读不出来（罕见）时退化为「只给路径」。
 * @param decryptedDir - 解密数据根。
 * @param media - 媒体依赖（生产 = `query/clawbot/clawbot-media.ts`）。
 * @param id - 会话行 id。
 * @returns 取数结果（见 {@link ClawbotMediaResult}）。
 */
async function mediaFor(decryptedDir: string, media: ClawbotMediaDeps, id: number): Promise<ClawbotMediaResult> {
  const rowId = Number.isFinite(id) ? Math.floor(id) : 0
  if (rowId <= 0) return { ok: false, error: '无效的消息 id' }
  const r = await media.ensure(decryptedDir, rowId)
  if (!r.ok) return { ok: false, error: r.error }
  const base: ClawbotMediaResult = { ok: true, kind: r.kind, name: r.name, path: r.path }
  if (r.kind !== 'image' || r.bytes > CLAWBOT_INLINE_MAX_BYTES) return base
  try {
    const bytes = readClawbotMediaBytes(r.path)
    return { ...base, dataUrl: `data:${imageMimeOf(bytes)};base64,${bytes.toString('base64')}` }
  } catch {
    return base
  }
}

/**
 * 一批消息落库（`mapWeixinMessage` → 逐条插入；`msg_id` 去重由插入兜底），
 * 把**最新的会话令牌**刷新到绑定行（发送路径下一个动作要用），并收集**新插入的附件行 id**
 * （交给自动取回队列）。
 *
 * 模块级函数（接收通道的 `insertMessages` 依赖指向它）；依赖两项显式传入。
 * @param decryptedDir - 解密数据根。
 * @param slot - 这一批属于哪个实例（**必填**：多实例下忘了传就会写进别的号的会话里）。
 * @param msgs - 协议帧数组。
 * @returns `{ lastId, delta, mediaIds, inbound }`；一条都没写入（全跳过/全重复）时为 null。
 *   `inbound` 是**本批新落库的消息**（含方向与类型）—— 自动回复据此挑选候选，
 *   省掉「落完库再查一次刚刚插了哪些」那一趟。
 */
export function insertClawbotMessages(decryptedDir: string, slot: number, msgs: readonly WeixinMessage[]): { lastId: number, delta: number, mediaIds: number[], inbound: ReplyableMessage[] } | null {
  let lastId = 0
  let delta = 0
  let latestToken = ''
  const mediaIds: number[] = []
  /** 本批新落库的消息（自动回复用；**只有新插入的**才算，去重跳过的旧帧不进来）。 */
  const inbound: ReplyableMessage[] = []
  for (const msg of msgs) {
    // 会话令牌只认**用户发来**的帧（bot 回显不刷新它），取最新一枚。
    const token = typeof msg.context_token === 'string' ? msg.context_token : ''
    if (token !== '' && (msg.message_type ?? 1) !== 2) latestToken = token
    const input: ClawbotMessageInput | null = mapWeixinMessage(msg)
    if (input === null) continue
    const id = insertClawbotMessage(decryptedDir, { ...input, slot })
    if (id !== null) {
      lastId = id
      delta += 1
      inbound.push({ direction: input.direction, msgType: input.msgType ?? null, content: input.content, id })
      if (input.media !== null && input.media !== undefined) mediaIds.push(id)
    }
  }
  if (latestToken !== '') saveSendContextToken(decryptedDir, latestToken, slot)
  return delta > 0 ? { lastId, delta, mediaIds, inbound } : null
}

/**
 * 自动回复的**上下文**（2026-10-18 用户报「不能关联上下文和识别图中内容」）：
 * 取目标消息之前的最近 20 条（含 bot 自己的回复），按库里方向映射成 user/assistant。
 * 只读同一个 ClawBot 会话的库，不碰本机微信数据 —— 与 `dataScope: 'kb-only'` 的纪律一致。
 * @param decryptedDir - 解密数据根。
 * @param slot - 实例编号。
 * @param beforeId - 目标消息行 id（取它之前的消息）。
 * @returns user/assistant 对话（读失败 = 空数组，不阻断自动回复）。
 */
function readAutoReplyHistory(decryptedDir: string, slot: number, beforeId: number): Array<{ role: 'user' | 'assistant', content: string }> {
  try {
    const snap = queryClawbotMessages(decryptedDir, { slot, limit: 20 })
    return snap.items
      .filter((m) => m.id < beforeId)
      .sort((a, b) => a.id - b.id)
      .map((m) => ({
        role: m.direction === 'in' ? ('user' as const) : ('assistant' as const),
        content: (m.content.trim() !== '' ? m.content : m.msgType === 'image' ? '[图片]' : m.msgType === 'voice' ? '[语音]' : '').trim(),
      }))
      .filter((m) => m.content !== '')
  } catch { return [] }
}

/**
 * 目标消息之前最近的 2 张入站图片（媒体缓存命中才送；未下载/超 8MB 跳过）。
 * 图片字节交给 ask 管道按模型能力决定是否真的送模型，本层不做模型判断。
 * @param decryptedDir - 解密数据根。
 * @param slot - 实例编号。
 * @param beforeId - 目标消息行 id。
 * @returns canonical base64 图片（读失败 = 空数组）。
 */
async function readAutoReplyImages(decryptedDir: string, slot: number, beforeId: number): Promise<Array<{ data: string, mediaType: string, name?: string }>> {
  const out: Array<{ data: string, mediaType: string, name?: string }> = []
  try {
    const snap = queryClawbotMessages(decryptedDir, { slot, limit: 40 })
    const rows = snap.items
      .filter((m) => m.id < beforeId && m.direction === 'in' && m.msgType === 'image')
      .sort((a, b) => b.id - a.id)
      .slice(0, 2)
      .reverse()
    for (const m of rows) {
      const got = await ensureClawbotMedia(decryptedDir, m.id)
      if (!got.ok) continue
      const bytes = readClawbotMediaBytes(got.path)
      if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) continue
      out.push({ data: bytes.toString('base64'), mediaType: imageMimeOf(bytes), name: `wx-image-${String(m.id)}` })
    }
  } catch { return [] }
  return out
}

/**
 * 扫码绑定与通道生命周期（模块级：让工厂不越 `function-size-ratchet` 的 250 行线）。
 *
 * 这三件事都只依赖两个注入点 ——「按实例取通道句柄」与「按实例取绑定卡片快照」——
 * 所以能整体搬出工厂；工厂里剩下的只有组装。
 */
function createBindFlow(deps: {
  dir: () => string
  rc: createClawbotRemotesInputs
  ilink: ClawbotIlinkDeps
  channelFor: (slot: number) => ClawbotChannel
  reconcileChannels: () => void
  bindingSnapshot: (slot: number) => ClawbotBindingSnapshot
  sweepMedia: () => void
}) {
  const { dir, rc, ilink, channelFor, reconcileChannels, bindingSnapshot, sweepMedia } = deps

  /**
   * 扫码确认 / 测试驱动的绑定收尾：回写身份与凭证、写审计、发事件、拉起该实例的通道。
   * @param identity - wxid / 昵称 / 头像（昵称头像 iLink 不下发，可为空）。
   * @param credentials - 会话凭证；null/缺省 = 只改绑定行不起通道（测试态）。
   * @param slot - 实例编号（缺省 1）。
   * @returns 绑定卡片快照。
   */
  function bindClawbotWechat(
    identity: { wxid: string, userName?: string | null, avatar?: string | null },
    credentials?: BindingCredentials | null,
    slot: number = DEFAULT_CLAWBOT_SLOT,
  ): ClawbotBindingSnapshot {
    const d = dir()
    const before = readBinding(d, slot).binding
    const after: ClawbotBinding = completeBinding(d, identity, credentials ?? null, slot)
    rc.op('clawbot', 'clawbot_bind', 'ok', identity.wxid, `已绑定 ${identity.userName ?? identity.wxid}（实例 ${slot}）`)
    safeEmit(rc, { name: 'clawbot/binding-changed', args: { from: before.status, to: after.status, wxid: after.wxid } })
    if (credentials != null) channelFor(slot).start()
    // 同一个 wxid 出现在别的实例上时，那一条已被收敛且凭证清空 —— 顺手停掉它的循环。
    reconcileChannels()
    return bindingSnapshot(slot)
  }

  /**
   * 单次状态轮询的中继与收尾（confirmed 时完成绑定）。
   * @param session - 进行中的扫码会话（含它属于哪个实例）。
   * @returns 状态与绑定卡片快照。
   */
  async function pollOnce(session: ClawbotBindSession): Promise<ClawbotBindStateSnapshot> {
    const r = await ilink.pollBindStatus(session.token)
    if (r.status === 'confirmed') {
      const creds = r.credentials
      const wxid = creds.ilinkUserId !== '' ? creds.ilinkUserId : creds.ilinkBotId
      session.state = 'confirmed'
      // 绑定至此完成：身份 + 凭证落库，通道拉起 —— 弹窗只需要读结果。
      return { state: session.state, binding: bindClawbotWechat({ wxid, userName: null, avatar: null }, creds, session.slot) }
    }
    if (r.status === 'wait' || r.status === 'scaned' || r.status === 'expired') session.state = r.status
    // unknown / error（含 40s 超时）：保留原状态 —— 长轮询「没等到变化」是常态，不是失败。
    return { state: session.state, binding: bindingSnapshot(session.slot) }
  }

  /**
   * 网关启动时把**每个已绑定实例**的通道拉起来（幂等；顺带做一次附件启动补扫）。
   *
   * 条件：该实例 `bound` 且凭证齐备 —— 其他状态一律不启动（**也就不会出网**）。
   */
  function ensureClawbotChannel(): void {
    const { bindings } = readBindings(dir())
    let started = 0
    for (const b of bindings) {
      if (b.status !== 'bound') continue
      const { credentials } = readBindingInternal(dir(), b.slot)
      if (credentials === null) continue
      channelFor(b.slot).start()
      started += 1
    }
    if (started > 0) sweepMedia()
  }

  return { bindClawbotWechat, pollOnce, ensureClawbotChannel }
}

/**
 * 绑定与会话八个对外方法的实体（模块级：同上）。
 *
 * 与工厂的区别只有一处：这里的依赖全是显式传入的（`dir` / `ilink` / 会话表 / 通道句柄），
 * 因此可以被单测直驱，也把工厂压回棘轮线以下。
 */
function createBindingOps(deps: {
  dir: () => string
  rc: createClawbotRemotesInputs
  ilink: ClawbotIlinkDeps
  sessions: Map<number, ClawbotBindSession>
  stopChannel: (slot: number) => void
  bindingSnapshot: (slot: number) => ClawbotBindingSnapshot
  bindFlow: ReturnType<typeof createBindFlow>
}) {
  const { dir, rc, ilink, sessions, stopChannel, bindingSnapshot, bindFlow } = deps
  const slotOf = (options?: { slot?: number }): number => resolveClawbotSlot(dir(), options?.slot)

  return {
    /**
     * 当前绑定行（设置卡片首屏）。
     * @param options.slot - 实例编号（缺省 = 第一个已绑定实例，其次第一个实例）。
     * @returns 绑定卡片快照（含会话计数与通道状态）。
     */
    getClawbotBinding(options?: { slot?: number }): ClawbotBindingSnapshot {
      return bindingSnapshot(slotOf(options))
    },

    /**
     * 申请绑定二维码（真实调用腾讯 iLink 服务；需要联网，失败时原样抛错让界面提示）。
     * @param options.slot - 为哪个实例取码（缺省 = 第一个实例）。
     * @returns 一次性凭证 / 二维码内容 / 过期时间 / 初始四态。
     */
    async createClawbotBindQr(options?: { slot?: number }): Promise<ClawbotBindQr> {
      const d = dir()
      const slot = slotOf(options)
      const qr = await ilink.requestBindQr()
      const expiresAt = Date.now() + CLAWBOT_QR_TTL_MS
      const before = readBinding(d, slot).binding
      const after = markBindingQr(d, { token: qr.token, expiresAt }, slot)
      sessions.set(slot, { slot, token: qr.token, payload: qr.payload, expiresAt, state: 'wait', inFlight: null })
      rc.op('clawbot', 'clawbot_bind_qr', 'ok', `slot=${slot}`, `二维码有效期至 ${new Date(expiresAt).toLocaleString('zh-CN', { hour12: false })}`)
      safeEmit(rc, { name: 'clawbot/binding-changed', args: { from: before.status, to: after.status, wxid: after.wxid } })
      return { token: qr.token, payload: qr.payload, expiresAt, state: 'wait' }
    },

    /**
     * 中继一次绑定状态轮询（弹窗打开期间反复调用；在途请求不叠加）。
     *
     * 没有进行中的会话（从未申请 / 重启丢会话 / 已完成）⇒ `idle`；
     * `confirmed` / `expired` 是终态，重复调用直接返回、不再打上游。
     * @param options.slot - 哪个实例的这场会话（缺省 = 第一个实例）。
     * @returns 状态与绑定卡片快照。
     */
    async getClawbotBindState(options?: { slot?: number }): Promise<ClawbotBindStateSnapshot> {
      const slot = slotOf(options)
      const session = sessions.get(slot)
      if (session === undefined) return { state: 'idle', binding: bindingSnapshot(slot) }
      if (session.state === 'confirmed' || session.state === 'expired') {
        return { state: session.state, binding: bindingSnapshot(slot) }
      }
      let pending = session.inFlight
      if (pending === null) {
        pending = bindFlow.pollOnce(session)
        session.inFlight = pending
        // 只有还是同一场会话时才清在途标记（期间用户点了「重新生成」⇒ 别动新会话）。
        const clear = (): void => { if (sessions.get(slot) === session) session.inFlight = null }
        void pending.then(clear, clear)
      }
      return pending
    },

    /**
     * 解绑：停该实例的通道、清凭证（`unbindBinding`）、**保留接入会话**（D-4）。
     * @param options.slot - 实例编号（缺省 = 第一个实例）。
     * @returns 解绑后的绑定卡片快照。
     */
    unbindClawbot(options?: { slot?: number }): ClawbotBindingSnapshot {
      const d = dir()
      const slot = slotOf(options)
      // 只停**已建**的通道：解绑一个从没跑过的实例不该凭空建出通道对象。
      stopChannel(slot)
      sessions.delete(slot)
      const before = readBinding(d, slot).binding
      const after = unbindBinding(d, slot)
      const detail = before.status === 'bound'
        ? `已解绑 ${before.userName ?? before.wxid ?? ''}（接入会话保留）`
        : '解绑（此前未处于已绑定）'
      rc.op('clawbot', 'clawbot_unbind', 'ok', before.wxid ?? '', `${detail}（实例 ${slot}）`)
      safeEmit(rc, { name: 'clawbot/binding-changed', args: { from: before.status, to: after.status, wxid: after.wxid } })
      return bindingSnapshot(slot)
    },

    /**
     * 给实例起别名（「工作号」「客服号」；2026-10-16）。
     *
     * 与绑定状态机**无关**：只动 `label` 一列，所以别名活过重新绑定与解绑。
     * 空串 = 清除别名（界面回落到昵称，再回落到「实例 N」）。
     * @param options.slot - 实例编号。
     * @param options.label - 新别名（空串 = 清除）。
     * @returns 落库后的绑定卡片快照（界面据此立刻更新轨上的名字）。
     */
    renameClawbotInstance(options: { slot: number, label: string }): ClawbotBindingSnapshot {
      const d = dir()
      const slot = Math.max(Math.floor(options?.slot ?? DEFAULT_CLAWBOT_SLOT), 1)
      const before = readBinding(d, slot).binding
      const after = renameBinding(d, slot, options?.label ?? '')
      const shown = after.label ?? after.userName ?? after.wxid ?? ''
      rc.op('clawbot', 'clawbot_instance_rename', 'ok', `slot=${slot}`,
        after.label === null ? `已清除别名（原「${before.label ?? ''}」）` : `别名改为「${after.label}」`)
      return bindingSnapshot(slot)
    },
  }
}

/**
 * 会话检索 / 环境自检 / 发送 / 媒体取数（模块级：同上）。
 *
 * 与绑定那几个分开的理由是**职责不同**：这一组只读会话与按需取数，不碰通道生命周期与扫码会话表，
 * 所以依赖更少（不需要 channelFor 与 sessions），也能独立被单测直驱。
 */
function createSessionOps(deps: {
  dir: () => string
  rc: createClawbotRemotesInputs
  ilink: ClawbotIlinkDeps
  media: ClawbotMediaDeps
  channelInfo: (slot: number) => ClawbotChannelInfo
  bindingSnapshot: (slot: number) => ClawbotBindingSnapshot
}) {
  const { dir, rc, ilink, media, channelInfo, bindingSnapshot } = deps
  const slotOf = (options?: { slot?: number }): number => resolveClawbotSlot(dir(), options?.slot)

  return {
    /**
     * 接入会话检索（时间 / 关键词 / 方向 / 分页 / 续传）；`slot` 缺省 = 第一个实例。
     * @param options - 检索条件（关键词在服务端过滤；带 `slot` 就是按实例分）。
     * @returns 会话页快照。
     */
    listClawbotMessages(options?: ClawbotMessageQuery): ClawbotMessageSnapshot {
      return queryClawbotMessages(dir(), { ...options, slot: slotOf(options) })
    },

    /**
     * 清空某实例的**接入会话**（2026-10-17 用户要求「增加对话历史清除按钮，可以删除对话历史
     * 以防止污染回复」）。
     *
     * 只删消息，**不动绑定与配置**（那是另一回事）；返回删掉的条数与最新快照
     * （界面据此立刻刷新，不用再发一次 list）。
     * @param options.slot - 实例编号（缺省 = 第一个实例）。
     * @returns 删掉的条数 + 最新会话页快照。
     */
    clearClawbotMessages(options?: { slot?: number }): { removed: number, messages: ClawbotMessageSnapshot } {
      const slot = slotOf(options)
      const { removed } = clearClawbotMessages(dir(), slot)
      rc.op('clawbot', 'clawbot_messages_clear', 'ok', `slot=${slot}`, `已清空接入会话 ${String(removed)} 条`)
      return { removed, messages: queryClawbotMessages(dir(), { slot }) }
    },

    /**
     * 环境自检（M-C 精简版，只查 3 项）—— 第 ② 项读**该实例**通道的真实运行态。
     * @param options.slot - 实例编号（缺省 = 第一个实例）。
     * @returns 自检快照。
     */
    checkClawbotEnv(options?: { slot?: number }): ClawbotEnvSnapshot {
      const slot = slotOf(options)
      const { binding } = readBinding(dir(), slot)
      const st = channelInfo(slot)
      const bound = binding.status === 'bound'
      let channelState: 'ok' | 'warn' | 'error' = 'ok'
      let channelDetail = '未绑定（不接收任何消息）'
      if (bound && st.running) {
        channelState = 'ok'
        channelDetail = '接收中（长轮询）'
      } else if (bound && st.error !== null) {
        channelState = 'error'
        channelDetail = st.error
      } else if (bound) {
        channelState = 'warn'
        channelDetail = '已绑定，但接收通道未运行'
      }
      const bindingState: 'ok' | 'warn' = bound ? 'ok' : 'warn'
      const bindingDetail =
        bound ? '已绑定'
          : binding.status === 'binding' ? '绑定中（等待扫码确认）'
            : binding.status === 'unbound-by-user' ? '已解绑，可重新绑定'
              : '尚未绑定'
      return {
        items: [
          { key: 'app', label: 'Super Time 正在运行', state: 'ok', detail: '正常' },
          { key: 'channel', label: '绑定通道（iLink）', state: channelState, detail: channelDetail },
          { key: 'binding', label: '集成状态仍为「已绑定」', state: bindingState, detail: bindingDetail },
        ],
      }
    },

    /**
     * 发送一条消息到微信（**唯一由内容驱动的出网路径**，用户逐条主动触发）。
     *
     * 主体在 {@link sendClawbotText}（前置校验 / 上游发送 / 成功才落库）；
     * 这里只负责「成功发一条实时事件」——失败不写「已发出」的假记录。
     * @param options.text - 正文原文（不打码、不改写；打码开关只作用于展示层）。
     * @param options.slot - 从哪个实例发（缺省 = 第一个实例）。
     * @returns 发送结果（见 {@link ClawbotSendResult}）。
     */
    async sendClawbotMessage(options: { text: string, slot?: number }): Promise<ClawbotSendResult> {
      const slot = slotOf(options)
      const result = await sendClawbotText(dir(), ilink, options, slot)
      if (result.ok && result.id !== null) safeEmit(rc, { name: 'clawbot/message', args: { lastId: result.id, delta: 1, slot } })
      return result
    },

    /**
     * 取某条消息的附件（**只在用户点开时发生**）：按需下载 + 解密 + 落盘缓存。
     *
     * 按消息 id 取（id 全局唯一），所以**不需要 slot**。缓存命中不再联网；
     * 主机白名单与体积上限都在 `query/clawbot/clawbot-media.ts` 里判。
     * @param options.id - 会话行 id。
     * @returns 取数结果（见 {@link ClawbotMediaResult}）。
     */
    async getClawbotMedia(options: { id: number }): Promise<ClawbotMediaResult> {
      return mediaFor(dir(), media, options?.id ?? 0)
    },
  }
}

export function createClawbotRemotes(rc: createClawbotRemotesInputs) {
  const decrypted = (): string => rc.dirs().decrypted

  const ilink: ClawbotIlinkDeps = {
    requestBindQr: ilinkRequestBindQr,
    pollBindStatus: ilinkPollBindStatus,
    getUpdates: ilinkGetUpdates,
    sendTextMessage: ilinkSendTextMessage,
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms) }),
    ...(rc.ilink ?? {}),
  }

  const media: ClawbotMediaDeps = { ensure: rc.media?.ensure ?? ensureClawbotMedia }

  /**
   * 附件自动取回队列（收到带附件的消息即入队；启动补扫兜住上次没取完的）。
   * 取数走 `media.ensure`（默认即真实下载解密；缓存命中只是一次 stat）。
   * **跨实例共用一个队列**：待取的是消息行 id（全局唯一），一个 worker 顺序取即可。
   */
  const mediaQueue = createClawbotMediaQueue({
    listPending: rc.media?.listPending ?? ((limit: number) => listClawbotMediaPending(decrypted(), limit)),
    ensure: (id) => media.ensure(decrypted(), id),
  })

  /** 进行中的扫码会话（**每实例一场**：用户可能同时给两个号取码）。 */
  const sessions = new Map<number, ClawbotBindSession>()

  /**
   * AI 自动回复执行器（多实例，2026-10-13）。
   *
   * `ask` 由装配层注入（生产 = `askDeep.askWechat` 包一层）⇒ 自动回复与手动问答走
   * **同一条管道**：模型统一由设置里的「对话模型」决定、同过隐私闸与 AI 审计；
   * 未注入（测试态）时自动回复不可用 —— 只记一行审计，一个字节都不发。
   * 发送复用 `sendClawbotText`（**成功才落库**，失败不写「已回复」的假记录）。
   */
  const autoReply = createAutoReplyRunner({
    readConfig: (slot: number) => readInstanceConfig(decrypted(), slot).config,
    ...(rc.ask === undefined ? {} : { ask: rc.ask }),
    send: (slot: number, text: string) => sendClawbotText(decrypted(), ilink, { text }, slot),
    op: rc.op,
    onReplied: ({ slot, id }) => { safeEmit(rc, { name: 'clawbot/message', args: { lastId: id, delta: 1, slot } }) },
    history: (slot, target) => (target.id === undefined ? [] : readAutoReplyHistory(decrypted(), slot, target.id)),
    images: (slot, target) => (target.id === undefined ? Promise.resolve([]) : readAutoReplyImages(decrypted(), slot, target.id)),
  })

  /**
   * 通道注册表：**一实例一条长轮询**（多实例，2026-10-13）。
   *
   * 惰性创建（第一次需要时才建）；依赖全部直调真实库与事件，且**凭证每轮现读** ——
   * 解绑、或被别的实例接管（`completeBinding` 清凭证）之后，即使停止位漏了，
   * 下一轮也拿不到凭证、发不出请求。
   */
  const channels = new Map<number, ClawbotChannel>()

  /** 取（或建）某实例的通道句柄。 */
  function channelFor(slot: number): ClawbotChannel {
    const existing = channels.get(slot)
    if (existing !== undefined) return existing
    const handle: ClawbotChannel = createClawbotChannel({
      getUpdates: (buf, signal) => {
        const { credentials } = readBindingInternal(decrypted(), slot)
        if (credentials === null) {
          // 凭证没了（解绑 / 被接管 / 会话过期）：**把循环也停掉** ——
          // 「没有凭证还每轮瞬败」会在退避窗口外空转（假 sleep 下会把事件循环饿死）。
          handle.stop()
          return Promise.reject(new Error('未绑定或凭证缺失（通道已停止）'))
        }
        return ilink.getUpdates(credentials, buf, undefined, signal)
      },
      readBuf: () => readBindingInternal(decrypted(), slot).syncBuf,
      saveBuf: (buf) => { saveSyncBuf(decrypted(), buf, slot) },
      insertMessages: (msgs) => {
        const inserted = insertClawbotMessages(decrypted(), slot, msgs)
        // 收到带附件的消息 ⇒ 立刻排队自动取回（不等人点；失败在补扫里重试）。
        if (inserted !== null && inserted.mediaIds.length > 0) mediaQueue.enqueue(inserted.mediaIds)
        // 自动回复（**默认关**，开关在实例卡上）：只看本批新落库的入站文本。
        if (inserted !== null && inserted.inbound.length > 0) autoReply.consider(slot, inserted.inbound)
        return inserted
      },
      onMessages: (info) => { safeEmit(rc, { name: 'clawbot/message', args: { lastId: info.lastId, delta: info.delta, slot } }) },
      onError: (error) => {
        // 终态错误留一行审计（只发生一次；会话过期/异常退出都走这里）。target 记实例，日志才分得清是哪个号。
        if (error !== null) rc.op('clawbot', 'clawbot_channel_error', 'fail', `slot=${slot}`, error)
      },
      sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          clearTimeout(timer)
          reject(signal?.reason instanceof Error ? signal.reason : new Error('ClawBot 通道已停止'))
        }
        // stop() 可能在本函数进入前就已经 abort：不再起一个注定要等待的计时器。
        if (signal?.aborted === true) {
          onAbort()
          return
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve()
        }, ms)
        signal?.addEventListener('abort', onAbort, { once: true })
      }),
    })
    channels.set(slot, handle)
    return handle
  }

  /** 某实例通道的对外状态（**从没建过 = 未运行**；不用为了读卡片而建通道）。 */
  function channelInfoOf(slot: number): ClawbotChannelInfo {
    const st = channels.get(slot)?.state()
    return st === undefined ? { running: false, error: null } : { running: st.running, error: st.lastError }
  }

  /**
   * 让每条**已建**通道的运行态与库里的绑定态对齐。
   *
   * 绑定 / 解绑 / 被别的实例接管之后调用：被接管那条的凭证已被 `completeBinding` 清空，
   * 这里主动停掉它的循环，不用等下一轮轮询自己撞上「凭证没了」。
   */
  function reconcileChannels(): void {
    for (const [slot, handle] of channels) {
      const { binding, credentials } = readBindingInternal(decrypted(), slot)
      if (binding.status !== 'bound' || credentials === null) handle.stop()
    }
  }

  /** 绑定卡片快照：绑定行 + 会话计数 + 通道状态（读失败随行带出）。 */
  function bindingSnapshot(slot: number): ClawbotBindingSnapshot {
    return snapshotOf(decrypted(), slot, channelInfoOf(slot))
  }

  /** 实例列表快照（通道状态由本层注入 —— 存储层不该知道通道注册表）。 */
  function instancesSnapshot(): ClawbotInstancesSnapshot {
    return listInstanceRows(decrypted(), { since: startOfToday(), channelState: channelInfoOf })
  }

  const bindFlow = createBindFlow({
    dir: decrypted,
    rc,
    ilink,
    channelFor,
    reconcileChannels,
    bindingSnapshot,
    sweepMedia: () => { mediaQueue.sweep() },
  })

  const bindingOps = createBindingOps({
    dir: decrypted,
    rc,
    ilink,
    sessions,
    stopChannel: (slot: number) => { channels.get(slot)?.stop() },
    bindingSnapshot,
    bindFlow,
  })

  const sessionOps = createSessionOps({
    dir: decrypted,
    rc,
    ilink,
    media,
    channelInfo: channelInfoOf,
    bindingSnapshot,
  })

  return {
    ...bindingOps,
    ...sessionOps,

    /**
     * 实例列表（设置视图的实例卡）：每个微信号一条，带各自的行为配置与会话计数。
     * @returns 实例列表快照（读失败时带 readError，界面必须与「一个实例都没有」分开显示）。
     */
    listClawbotInstances(): ClawbotInstancesSnapshot {
      return instancesSnapshot()
    },

    /**
     * 新建一个实例（初始 `unbound`，等扫码绑定）。
     *
     * slot 由存储层按「绑定行自增 id」分配（**只增不复用**，见 `query/clawbot/clawbot-instance.ts`）。
     * @returns 新实例编号 + 最新列表（界面据此立刻对它取码，不用去猜哪条是新的）。
     */
    createClawbotInstance(): ClawbotInstanceCreated {
      const created = createInstanceRow(decrypted())
      rc.op('clawbot', 'clawbot_instance_create', 'ok', `slot=${created.slot}`, '新建实例（等待绑定）')
      return { slot: created.slot, ...instancesSnapshot() }
    },

    /**
     * 删除一个实例：绑定行 + 配置 + **该实例的接入会话**一起删。
     *
     * 连带删会话是有意的（列表按实例遍历，实例没了那些行再也显示不出来），
     * 所以返回删掉的条数 —— 界面必须在确认框里如实告知「将删除 N 条接入会话」。
     * @param options.slot - 实例编号。
     * @returns 连带删掉的会话条数 + 最新列表。
     */
    deleteClawbotInstance(options: { slot: number }): ClawbotInstanceDeleted {
      const slot = Math.max(Math.floor(options?.slot ?? DEFAULT_CLAWBOT_SLOT), 1)
      const handle = channels.get(slot)
      if (handle !== undefined) { handle.stop(); channels.delete(slot) }
      sessions.delete(slot)
      const { removedMessages } = deleteInstanceRow(decrypted(), slot)
      rc.op('clawbot', 'clawbot_instance_delete', 'ok', `slot=${slot}`, `已删除实例（连带 ${removedMessages} 条接入会话）`)
      return { removedMessages, ...instancesSnapshot() }
    },

    /**
     * 改某实例的行为配置（**部分更新**：只覆盖传进来的字段，缺省保持原值）。
     * @param options.slot - 实例编号。
     * @param options.autoReply / kbEnabled / kbId / systemPrompt / splitReply - 要改的字段。
     * @returns 落库后的完整配置（含归一后的 kbId）。
     */
    setClawbotInstanceConfig(options: { slot: number, autoReply?: boolean, kbEnabled?: boolean, kbId?: number | null, systemPrompt?: string, splitReply?: boolean }): ClawbotInstanceConfig {
      const slot = Math.max(Math.floor(options?.slot ?? DEFAULT_CLAWBOT_SLOT), 1)
      const patch: { autoReply?: boolean, kbEnabled?: boolean, kbId?: number | null, systemPrompt?: string, splitReply?: boolean } = {}
      if (options.autoReply !== undefined) patch.autoReply = options.autoReply
      if (options.kbEnabled !== undefined) patch.kbEnabled = options.kbEnabled
      // 非正数 / 非有限值 = 「没有库」，一律归 null；**不许夹到 1** —— 那等于
      // 替用户悄悄选了一个库，自动回复会去检索一个他没选过的知识库。
      if (options.kbId !== undefined) {
        patch.kbId = options.kbId === null || !Number.isFinite(options.kbId) || options.kbId <= 0
          ? null
          : Math.floor(options.kbId)
      }
      // 提示词：只接受字符串（非字符串当「没传」，不把 undefined 写进去覆盖原值）。
      if (typeof options.systemPrompt === 'string') patch.systemPrompt = options.systemPrompt
      if (options.splitReply !== undefined) patch.splitReply = options.splitReply
      const cfg = saveInstanceConfig(decrypted(), slot, patch)
      rc.op('clawbot', 'clawbot_instance_config', 'ok', `slot=${slot}`,
        `自动回复 ${cfg.autoReply ? '开' : '关'} / 知识库 ${cfg.kbEnabled ? '开' : '关'}` +
        ` / 提示词 ${cfg.systemPrompt === '' ? '默认' : `${String(cfg.systemPrompt.length)} 字`}` +
        ` / 分段 ${cfg.splitReply ? '开' : '关'}`)
      return cfg
    },

    /**
     * **内部**（不加 `@Remote`）：见 {@link createBindFlow} 的 `bindClawbotWechat`。
     */
    bindClawbotWechat: bindFlow.bindClawbotWechat,

    /**
     * **内部**（不加 `@Remote`）：网关启动时把**每个已绑定实例**的通道拉起来。
     *
     * 条件：该实例 `bound` 且凭证齐备 —— 其他状态一律不启动（**也就不会出网**）。
     * 幂等：通道自己保证重复 `start()` 无副作用。顺带做一次附件**启动补扫**：
     * 上次运行没取完、或当时网络不通的那批，在这里补齐（缓存命中的只是一次 stat）。
     */
    ensureClawbotChannel: bindFlow.ensureClawbotChannel,
  }
}
