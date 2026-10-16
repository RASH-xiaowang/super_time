/**
 * 微信 ClawBot 的 iLink 协议客户端 —— 全仓**唯一**的 ClawBot 出网落点。
 *
 * ## 协议事实从哪来（2026-10-12）
 *
 * 官方只公开用户视角流程（点绑定 → 出二维码 → 扫码 → 已绑定），协议细节来自两条实证：
 *
 * 1. **开源参考实现** [WeClaw](https://github.com/fastclaw-ai/weclaw) 的 `ilink` 包
 *    （auth.go / client.go / monitor.go / types.go）：端点、认证头、四态与消息帧形状；
 * 2. **本机实拨**（临时探针，各一次）：
 *    - `GET /ilink/bot/get_bot_qrcode?bot_type=3` → `{"qrcode":"<32hex>","qrcode_img_content":"<微信 liteapp 绑定 URL>","ret":0}`
 *      （`qrcode_img_content` 就是要被画成二维码的 URL——手机微信扫它打开绑定页；
 *      它由服务端下发、**本应用从不访问它**，所以文件里不写它的主机名）；
 *    - `GET /ilink/bot/get_qrcode_status?qrcode=<token>` → 无变化时**服务端挂起约 30s**，
 *      返回 `{"ret":0,"status":"wait"}`；状态变化（扫到/确认/过期）即刻返回。
 *
 * ## 边界纪律（改本文件之前先读）
 *
 * - **只有本文件可以出网**（`clawbot-outbound.spec.ts` 逐文件扫描其余 ClawBot 模块）；
 * - 请求体只含两类东西：**控制面信息**（凭证 / 游标 / 渠道版本号）与**你主动发送的消息正文**
 *   （`sendTextMessage`，内容 = 面板输入框原文，由你逐条触发；没有自动发送、没有定时发送）——
 *   接收侧（取码 / 状态 / 长轮询）不携带任何本地数据；
 * - 主机收敛在 {@link ILINK_BASE_URL} 与 {@link resolveBaseUrl}（服务端回的 `baseurl`
 *   只许 https 的 weixin.qq.com 域）；破坏这两条 = 出网台账与隐私声明双双失真；
 * - 超时的语义是**正常**的（长轮询没等到变化），不是错误 —— 调用方保留原状态继续。
 *
 * ## 在本仓的接线位置
 *
 * `remotes/clawbot.ts`（绑定二维码 / 状态轮询的中继与收尾）→ {@link requestBindQr} /
 * {@link pollBindStatus}；`query/clawbot/clawbot-channel.ts`（绑定后的消息长轮询循环）→
 * {@link getUpdates}。测试通过 `opts.fetchImpl` 注入假 fetch，一个字节都不出网。
 *
 * @module query/clawbot/clawbot-ilink
 */
import { randomBytes, randomUUID } from 'node:crypto'
import type { ClawbotMediaRef, ClawbotMessageInput } from './clawbot-message.ts'

/** iLink 服务主机（唯一出网目的地；换主机 = 改隐私声明与出网台账）。 */
export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'

const QR_PATH = '/ilink/bot/get_bot_qrcode?bot_type=3'
const QR_STATUS_PATH = '/ilink/bot/get_qrcode_status?qrcode='
const GET_UPDATES_PATH = '/ilink/bot/getupdates'
const SEND_MESSAGE_PATH = '/ilink/bot/sendmessage'

/** 渠道版本号：协议要求带一个版本串；先用参考实现同款值，官方给新值时再改。 */
const CHANNEL_VERSION = '1.0.0'

/** 二维码**显示**倒计时（5 分钟）。真实过期以服务端轮询到的 `expired` 为准。 */
export const CLAWBOT_QR_TTL_MS = 5 * 60_000

/** 取码请求超时（普通请求，实测亚秒级返回）。 */
const QR_REQUEST_TIMEOUT_MS = 20_000

/**
 * 状态轮询单次超时。
 *
 * 实测服务端无变化时挂起约 **30 秒**才回 `{status:'wait'}`，40s 留出服务器抖动余量
 * （WeClaw 同值）。超时不重试 —— 调用方保留原状态、下一次继续轮询即可。
 */
export const QR_POLL_TIMEOUT_MS = 40_000

/** 消息长轮询单次超时（WeClaw：35s 服务端窗口 + 5s 余量）。 */
export const GET_UPDATES_TIMEOUT_MS = 40_000

/** 发送单次超时（WeClaw sendTimeout；普通请求，不是长轮询）。 */
export const SEND_TIMEOUT_MS = 15_000

/** 协议常量：消息方向 / 状态 / 条目类型（与 WeClaw types.go 对齐）。 */
export const MESSAGE_TYPE_BOT = 2
export const MESSAGE_STATE_FINISH = 2
export const ITEM_TYPE_TEXT = 1

/**
 * 最小 fetch 形状（只声明用到的字段）。
 *
 * 生产缺省用全局 `fetch`；测试注入假实现后整个模块零出网 —— 这是让协议层
 * 能在 node vitest 里被完整驱动的关键，也是「接入后 spec 不许真实联网」的保证。
 */
export interface FetchLike {
  (url: string, init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    signal?: AbortSignal
  }): Promise<{ ok: boolean, status: number, text(): Promise<string> }>
}

/** 注入点：假 fetch（测试）/ 时间源。 */
export interface IlinkOptions {
  fetchImpl?: FetchLike
}

/** 绑定确认后服务端下发的会话凭证（存进绑定表的凭证列，不进渲染层）。 */
export interface IlinkCredentials {
  botToken: string
  ilinkBotId: string
  ilinkUserId: string
  baseUrl: string
}

/** 取码结果：`token` 用于轮询状态，`payload` 是要被画成二维码的 URL。 */
export interface IlinkBindQr {
  token: string
  payload: string
}

/**
 * 一次状态轮询的结果。
 *
 * - `wait` / `scaned` / `expired`：服务端明确状态；
 * - `confirmed`：附带凭证（调用方落库 + 拉起接收通道）；
 * - `unknown`：服务端回了没见过的状态串（保留原状态继续轮询，不猜测）；
 * - `error`：网络错 / 超时 / 响应缺字段（同上：保留原状态）。
 */
export type IlinkPollResult =
  | { status: 'wait' | 'scaned' | 'expired' | 'unknown' }
  | { status: 'confirmed', credentials: IlinkCredentials }
  | { status: 'error', error: string }

/**
 * CDN 媒体引用（字段名线上原样；WeClaw types.go 同名）。
 *
 * `aes_key` 是 base64，**解码出来是 hex 字符串**，再 hex 解码才是 16 字节密钥
 * （WeClaw `DownloadFileFromCDN` 的两步解析；别省任何一步）。
 */
export interface MediaInfo {
  encrypt_query_param?: string
  aes_key?: string
  encrypt_type?: number
}

/**
 * 消息条目（帧形状抄 WeClaw types.go，**字段名保持线上原样** snake_case）。
 *
 * 为什么不做 camelCase 归一：这是协议帧，用线上原名读，字段对不上时一眼能看出来；
 * 归一成内部形状反而会把「读错键名」伪装成「服务端没发这个字段」。
 */
export interface MessageItem {
  type?: number
  text_item?: { text?: string }
  image_item?: { url?: string, media?: MediaInfo, mid_size?: number }
  voice_item?: { text?: string, media?: MediaInfo, voice_size?: number, playtime?: number }
  video_item?: { media?: MediaInfo, video_size?: number }
  file_item?: { file_name?: string, len?: string, media?: MediaInfo }
}

/** 一条微信侧消息帧（字段名同上：线上原样）。 */
export interface WeixinMessage {
  message_id?: number
  from_user_id?: string
  to_user_id?: string
  /** 1 = 用户发来；2 = bot 侧（本版本我们不发送，出现即为异常但如实处理）。 */
  message_type?: number
  item_list?: MessageItem[]
  /**
   * 会话上下文令牌（发送回复时**必须**带上）。
   *
   * 由服务端随消息下发；WeClaw 的回复路径把它原样带回 `sendmessage`。
   * 我们对 1:1 绑定只保留**最近一条入站消息**的令牌（存绑定行），发送时取用。
   */
  context_token?: string
}

/** `getupdates` 的响应（字段名与服务端一致、语义抄 WeClaw monitor.go）。 */
export interface IlinkUpdates {
  ret: number
  errCode: number
  errMsg: string
  messages: WeixinMessage[]
  /** 下一次长轮询要带上的同步游标（空串 = 服务端没给新的）。 */
  buf: string
  longPollingTimeoutMs: number
}

/** 与 WeClaw `generateWechatUIN` 逐字节一致：随机 uint32 的十进制串再 base64。 */
function makeWechatUin(): string {
  const n = randomBytes(4).readUInt32BE(0)
  return Buffer.from(String(n), 'utf8').toString('base64')
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

/**
 * 校验服务端回传的 `baseurl`：只许 https 且属于 weixin.qq.com 域，其余一律拒绝。
 *
 * 为什么较真：本模块对外的承诺是「唯一主机、控制面请求」。若盲信服务端给的任意地址，
 * 这条承诺就变成「腾讯说去哪就去哪」—— 隐私声明与出网台账都会失真。
 * @param baseUrl - confirmed 响应里的 `baseurl`（空串 = 用缺省主机）。
 * @returns 去掉尾斜杠的可用基址。
 * @throws baseurl 不合法或不在 weixin.qq.com 域内。
 */
function resolveBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (trimmed === '') return ILINK_BASE_URL
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('baseurl 不是合法 URL：' + trimmed)
  }
  const host = parsed.hostname
  if (parsed.protocol !== 'https:' || !(host === 'weixin.qq.com' || host.endsWith('.weixin.qq.com'))) {
    throw new Error('baseurl 不在 weixin.qq.com 域内，拒绝发送：' + trimmed)
  }
  return trimmed
}

/**
 * 全部出网的**唯一调用点**：一次 JSON 请求（含超时与可读错误）。
 *
 * `fetch` 用局部常量承接注入 —— 名字故意就叫 `fetch`：出网台账
 * （`outbound-site-coverage.spec.ts`）按字面 `fetch(` 扫描函数级调用点，改名会让
 * 这个点从台账里隐形。超时用 `AbortController` 掐断，错误消息带上响应体片段，
 * 排障时不用再复现一次。
 * @param url - 完整地址（必须由本模块用常量拼出）。
 * @param init.method - GET / POST。
 * @param init.headers - 额外请求头（认证头只在 getUpdates 传）。
 * @param init.body - 会被 JSON 序列化的请求体（控制面信息）。
 * @param init.timeoutMs - 单次超时；到点即 abort。
 * @param opts - 注入点（假 fetch）。
 * @returns 解析后的 JSON（形状由调用方各自校验）。
 */
async function requestJson(
  url: string,
  init: { method: 'GET' | 'POST', headers?: Record<string, string>, body?: unknown, timeoutMs: number },
  opts?: IlinkOptions,
  signal?: AbortSignal,
): Promise<unknown> {
  const fetch = opts?.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const ac = new AbortController()
  const timer = setTimeout(() => { ac.abort() }, init.timeoutMs)
  const abortFromCaller = (): void => { ac.abort(signal?.reason) }
  if (signal?.aborted) abortFromCaller()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
  try {
    const res = await fetch(url, {
      method: init.method,
      headers: {
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(init.headers ?? {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ac.signal,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`HTTP ${res.status}：${text.slice(0, 200)}`)
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error('响应不是合法 JSON：' + text.slice(0, 200))
    }
  } finally {
    signal?.removeEventListener('abort', abortFromCaller)
    clearTimeout(timer)
  }
}

/**
 * 向腾讯服务申请一次性绑定二维码。
 *
 * 响应形状（实拨确认）：`{ qrcode, qrcode_img_content, ret }`；`qrcode_img_content`
 * 就是要画成二维码的 URL（手机微信扫它打开绑定页）。
 * @param opts - 注入点（假 fetch）。
 * @param signal - 调用方生命周期信号（接收通道 stop 时用于中断在飞请求）。
 * @returns 一次性凭证与二维码内容。
 * @throws 网络错 / HTTP 非 200 / 响应缺字段（渲染层按 message 展示）。
 */
export async function requestBindQr(opts?: IlinkOptions): Promise<IlinkBindQr> {
  const raw = await requestJson(ILINK_BASE_URL + QR_PATH, { method: 'GET', timeoutMs: QR_REQUEST_TIMEOUT_MS }, opts)
  const r = asRecord(raw)
  const token = str(r['qrcode'])
  const payload = str(r['qrcode_img_content'])
  if (token === '' || payload === '') throw new Error('取码响应缺少 qrcode / qrcode_img_content 字段')
  return { token, payload }
}

/**
 * 轮询一次绑定状态（单次，不循环）。
 *
 * 循环留给调用方：界面在二维码弹窗打开期间按节奏调用，关掉即停 —— 不在后端常驻
 * 一个无人消费的轮询循环。超时按 `error` 返回（调用方保留原状态继续），
 * 与 WeClaw「超时是长轮询的正常形态」的口径一致。
 * @param token - {@link requestBindQr} 返回的一次性凭证。
 * @param opts - 注入点（假 fetch）。
 * @returns 状态结果（见 {@link IlinkPollResult}）。
 */
export async function pollBindStatus(token: string, opts?: IlinkOptions): Promise<IlinkPollResult> {
  let raw: unknown
  try {
    raw = await requestJson(
      ILINK_BASE_URL + QR_STATUS_PATH + encodeURIComponent(token),
      { method: 'GET', timeoutMs: QR_POLL_TIMEOUT_MS },
      opts,
    )
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) }
  }
  const r = asRecord(raw)
  const status = str(r['status'])
  if (status === 'confirmed') {
    const credentials: IlinkCredentials = {
      botToken: str(r['bot_token']),
      ilinkBotId: str(r['ilink_bot_id']),
      ilinkUserId: str(r['ilink_user_id']),
      baseUrl: str(r['baseurl']),
    }
    if (credentials.botToken === '' || credentials.ilinkBotId === '') {
      return { status: 'error', error: 'confirmed 响应缺少 bot_token / ilink_bot_id（无法建立会话）' }
    }
    return { status: 'confirmed', credentials }
  }
  if (status === 'wait' || status === 'scaned' || status === 'expired') return { status }
  return { status: 'unknown' }
}

/**
 * 消息长轮询（单次）。
 *
 * 认证头与请求体形状照 WeClaw `Client.GetUpdates`：`AuthorizationType: ilink_bot_token` +
 * `Bearer <botToken>` + `X-WECHAT-UIN`（每次请求新随机值）；body 只有同步游标与渠道
 * 版本号 —— **不含任何本地数据**。
 * @param credentials - 绑定确认后的凭证（baseUrl 会先过 {@link resolveBaseUrl} 校验）。
 * @param buf - 上一次响应给的同步游标（空串 = 从头）。
 * @param opts - 注入点（假 fetch）。
 * @returns 响应（ret/errcode 由调用方按 WeClaw 语义处理）。
 * @throws 网络错 / HTTP 非 200 / 响应非法 JSON；`baseurl` 越域也会抛（拒绝发送）。
 */
export async function getUpdates(credentials: IlinkCredentials, buf: string, opts?: IlinkOptions, signal?: AbortSignal): Promise<IlinkUpdates> {
  const base = resolveBaseUrl(credentials.baseUrl)
  const raw = await requestJson(base + GET_UPDATES_PATH, {
    method: 'POST',
    headers: {
      AuthorizationType: 'ilink_bot_token',
      Authorization: 'Bearer ' + credentials.botToken,
      'X-WECHAT-UIN': makeWechatUin(),
    },
    body: { get_updates_buf: buf, base_info: { channel_version: CHANNEL_VERSION } },
    timeoutMs: GET_UPDATES_TIMEOUT_MS,
  }, opts, signal)
  const r = asRecord(raw)
  const msgs = Array.isArray(r['msgs']) ? (r['msgs'] as WeixinMessage[]) : []
  return {
    ret: num(r['ret']),
    errCode: num(r['errcode']),
    errMsg: str(r['errmsg']),
    messages: msgs,
    buf: str(r['get_updates_buf']),
    longPollingTimeoutMs: num(r['longpolling_timeout_ms']),
  }
}

/**
 * 把一条消息帧映射成待落库的行；没有可展示内容时返回 null（该帧被跳过）。
 *
 * 内容选取（与界面 msgType 取值对齐）：
 * - 文本 → 原文；图片/视频 → 占位说明；文件 → `[文件] 名字`；
 * - 语音 → 微信的**语音转写文本**（有则用），没有就 `[语音]`；
 * - 帧里没有任何已知条目 → null（不落空行）。
 *
 * 非文本条目同时抽**媒体引用**（怎么取 + 元数据），供界面按需下载解密；
 * 抽不到（既没有明文 URL 也没有加密参数）就归 null —— 界面只显示占位说明。
 *
 * `ts` 用**接收时间**：协议帧没有时间戳字段（实测与 WeClaw 类型一致），
 * 接收时间至少单调、可用于展示与排序。
 * @param msg - 消息帧。
 * @param now - 时间源（测试注入）。
 * @returns 落库输入（`msgId` 用于去重：服务端清游标后会重发）。
 */
export function mapWeixinMessage(msg: WeixinMessage, now: () => number = Date.now): ClawbotMessageInput | null {
  const direction = num(msg.message_type) === 2 ? 'out' : 'in'
  const items = Array.isArray(msg.item_list) ? msg.item_list : []
  for (const item of items) {
    const type = num(item.type)
    if (type === 1) {
      const text = str(item.text_item?.text)
      if (text !== '') return { ts: now(), direction, msgType: 'text', content: text, msgId: msgIdOf(msg), media: null }
      continue
    }
    if (type === 2) {
      return { ts: now(), direction, msgType: 'image', content: '[图片]', msgId: msgIdOf(msg), media: pickMedia(item, 'image') }
    }
    if (type === 3) {
      const voiceText = str(item.voice_item?.text)
      return {
        ts: now(), direction, msgType: 'voice',
        content: voiceText !== '' ? voiceText : '[语音]',
        msgId: msgIdOf(msg), media: pickMedia(item, 'voice'),
      }
    }
    if (type === 4) {
      const name = str(item.file_item?.file_name)
      return {
        ts: now(), direction, msgType: 'file',
        content: name !== '' ? '[文件] ' + name : '[文件]',
        msgId: msgIdOf(msg), media: pickMedia(item, 'file'),
      }
    }
    if (type === 5) {
      return { ts: now(), direction, msgType: 'video', content: '[视频]', msgId: msgIdOf(msg), media: pickMedia(item, 'video') }
    }
  }
  return null
}

/** 数字字段 → number | null（0 与缺失都归 null，别把「没给」显示成 0 字节）。 */
function numOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/**
 * 抽一条消息条目的媒体引用。
 *
 * 图片可能带**明文 URL**（`image_item.url`）或加密参数（`media.encrypt_query_param`）；
 * 其余类型只有加密参数。解密的密钥两步解析（base64 → hex → 16 字节）在取媒体模块里做，
 * 这里只原样搬运。
 */
function pickMedia(item: MessageItem, kind: 'image' | 'voice' | 'video' | 'file'): ClawbotMediaRef | null {
  if (kind === 'image') {
    const url = str(item.image_item?.url)
    if (url !== '') return { kind, ref: url, key: '', name: null, size: numOrNull(item.image_item?.mid_size) }
  }
  const media = kind === 'image' ? item.image_item?.media
    : kind === 'voice' ? item.voice_item?.media
      : kind === 'video' ? item.video_item?.media
        : item.file_item?.media
  const param = str(media?.encrypt_query_param)
  if (param === '') return null
  const size = kind === 'image' ? numOrNull(item.image_item?.mid_size)
    : kind === 'voice' ? numOrNull(item.voice_item?.voice_size)
      : kind === 'video' ? numOrNull(item.video_item?.video_size)
        : numOrNull(Number(str(item.file_item?.len)))
  return {
    kind,
    ref: param,
    key: str(media?.aes_key),
    name: kind === 'file' ? (str(item.file_item?.file_name) || null) : null,
    size,
  }
}

/** message_id 缺省/非数时归 null（去重只在有 id 时生效）。 */
function msgIdOf(msg: WeixinMessage): number | null {
  const id = num(msg.message_id)
  return id > 0 ? id : null
}

/** 发送结果（服务端确认后的原始码；`ret !== 0` = 被拒）。 */
export interface IlinkSendResult {
  ret: number
  errMsg: string
}

/** 要发送的一条文本消息（正文 = 用户输入原文，不做任何改写/打码）。 */
export interface IlinkOutgoingText {
  /** 微信侧用户 id（binding 的 `ilink_user_id`）。 */
  toUserId: string
  /** 正文原文。 */
  text: string
  /** 最近一条入站消息带来的会话令牌（取不到就没法发，调用方拦在前头）。 */
  contextToken: string
  /** 相关性 id；缺省随机 uuid（测试可注入以对形状断言）。 */
  clientId?: string
}

/**
 * 发送一条文本消息（**用户主动触发**的唯一出网内容路径）。
 *
 * 帧形状照 WeClaw `messaging/sender.go#SendTextReply`：`from_user_id` = 本 bot、
 * `to_user_id` = 微信侧用户、`message_type=2 / message_state=2`、`item_list` 一个文本条目、
 * `context_token` 原样带回（来自最近入站消息）；业务侧 `base_info` 为**空对象**。
 * 正文按用户输入原文发送 —— 不打码、不转 Markdown（打码开关只作用于**展示层**）。
 * @param credentials - 绑定确认后的凭证（baseUrl 会先过 {@link resolveBaseUrl} 校验）。
 * @param out - 接收方 / 正文 / 会话令牌。
 * @param opts - 注入点（假 fetch / 假 clientId 由 out 给）。
 * @returns 原始 `ret` / `errmsg`（由调用方决定成功与否与文案）。
 * @throws 网络错 / HTTP 非 200 / baseurl 越域；`ret !== 0` **不抛**（它是业务拒绝，有 errmsg）。
 */
export async function sendTextMessage(
  credentials: IlinkCredentials,
  out: IlinkOutgoingText,
  opts?: IlinkOptions,
): Promise<IlinkSendResult> {
  const base = resolveBaseUrl(credentials.baseUrl)
  const raw = await requestJson(base + SEND_MESSAGE_PATH, {
    method: 'POST',
    headers: {
      AuthorizationType: 'ilink_bot_token',
      Authorization: 'Bearer ' + credentials.botToken,
      'X-WECHAT-UIN': makeWechatUin(),
    },
    body: {
      msg: {
        from_user_id: credentials.ilinkBotId,
        to_user_id: out.toUserId,
        client_id: out.clientId ?? randomUUID(),
        message_type: MESSAGE_TYPE_BOT,
        message_state: MESSAGE_STATE_FINISH,
        item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text: out.text } }],
        context_token: out.contextToken,
      },
      base_info: {},
    },
    timeoutMs: SEND_TIMEOUT_MS,
  }, opts)
  const r = asRecord(raw)
  return { ret: num(r['ret']), errMsg: str(r['errmsg']) }
}
