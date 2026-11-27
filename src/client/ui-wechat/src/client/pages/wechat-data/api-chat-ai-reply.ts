/** 会话级 AI 回复的薄 Remote 层；组件不直接调用 remote()。 */
import type {
  ChatAiReplyEnabledChatsResult,
  ChatAiReplyMutationResult,
  ChatAiReplyScanResult,
  ChatAiReplyState,
} from '@deepseek-ai/dsh-wechat-data/types'
import { remote, unwrap } from './api-core.ts'
import { notifyMessageListUpdated } from './message-list-events.ts'

export interface ChatAiReplyDefaultWebhookState {
  configured: boolean
  /** 服务端只返回脱敏地址，前端不会持有或回显完整 token。 */
  endpoint: string
  updatedAt?: number
  error?: string
}

export interface ChatAiReplyDefaultWebhookSaveResult extends ChatAiReplyDefaultWebhookState {
  ok: boolean
  ruleId?: number
  ruleCreated?: boolean
  backfilled?: number
}

interface RemoteEnvelope<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

interface RawDefaultWebhookState {
  configured?: boolean
  endpoint?: string
  maskedEndpoint?: string
  webhookUrl?: string
  updatedAt?: number
  error?: string
}

interface RawDefaultWebhookMutation extends RawDefaultWebhookState {
  ok?: boolean
  state?: RawDefaultWebhookState
  ruleId?: number
  ruleCreated?: boolean
  backfilled?: number
}

interface ChatAiReplyDefaultWebhookRemote {
  getChatAiReplyDefaultWebhook?: (options: {
    chatUsername: string
    chatName?: string
  }) => Promise<RemoteEnvelope<RawDefaultWebhookState>>
  saveChatAiReplyDefaultWebhook?: (options: {
    chatUsername: string
    chatName?: string
    webhookUrl: string
  }) => Promise<RemoteEnvelope<RawDefaultWebhookMutation>>
}

function defaultWebhookClient(): ReturnType<typeof remote> & ChatAiReplyDefaultWebhookRemote {
  return remote() as ReturnType<typeof remote> & ChatAiReplyDefaultWebhookRemote
}

function defaultWebhookState(value: unknown): ChatAiReplyDefaultWebhookState {
  const raw = typeof value === 'object' && value !== null
    ? value as RawDefaultWebhookState
    : {}
  const endpoint = typeof raw.endpoint === 'string'
    ? raw.endpoint
    : typeof raw.maskedEndpoint === 'string'
      ? raw.maskedEndpoint
      : typeof raw.webhookUrl === 'string'
        ? raw.webhookUrl
        : ''
  return {
    configured: raw.configured === true || endpoint.trim() !== '',
    endpoint,
    ...(typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt)
      ? { updatedAt: raw.updatedAt }
      : {}),
    ...(typeof raw.error === 'string' && raw.error !== '' ? { error: raw.error } : {}),
  }
}

export async function apiGetChatAiReplyState(options: {
  chatUsername: string
  chatName?: string
}): Promise<ChatAiReplyState> {
  return unwrap(await remote().getChatAiReplyState(options))
}

/** 批量读取当前账号已开启 AI 回复的单聊，供会话列表筛选。 */
export async function apiListEnabledChatAiReplyStates(): Promise<ChatAiReplyEnabledChatsResult> {
  return unwrap(await remote().listEnabledChatAiReplyStates())
}

export async function apiSetChatAiReplyEnabled(options: {
  chatUsername: string
  chatName?: string
  enabled: boolean
  provider?: 'dsh-wechat-bridge' | 'custom-webhook'
  expectedRevision?: number
}): Promise<ChatAiReplyMutationResult> {
  const result = unwrap(await remote().setChatAiReplyEnabled(options))
  if (result.ok) notifyMessageListUpdated()
  return result
}

/** 保存当前会话的 AI 回复人格、知识库与上下文时间窗设置；只允许桌面端写入。 */
export async function apiSetChatAiReplyPersona(options: {
  chatUsername: string
  chatName?: string
  personaName: string
  personaPrompt: string
  splitReply?: boolean
  kbEnabled?: boolean
  kbId?: number
  /** 上下文时间窗（小时）；0 = 不限，上限 720。 */
  contextWindowHours?: number
  safetyHandoff?: string
  safetyBlocked?: string
  expectedRevision?: number
}): Promise<ChatAiReplyMutationResult> {
  const result = unwrap(await remote().setChatAiReplyPersona(options))
  if (result.ok) notifyMessageListUpdated()
  return result
}

/** 立即检查一次已开启会话；只用于桌面端诊断。 */
export async function apiScanChatAiReplyNow(): Promise<ChatAiReplyScanResult> {
  return unwrap(await remote().scanChatAiReplyNow())
}

/** 重新生成的返回：`ok=false` 时用户应看到具体拒绝/失败原因。 */
export interface ChatAiReplyRegenerateResult {
  ok: boolean
  error?: string
}

/** 专用清理的逐条结果；未删除的条目必须带原因，界面据此提示用户。 */
export interface AiReplyReservationDeleteItem {
  id: number
  status: 'removed' | 'skipped'
  error?: string
}

export interface AiReplyReservationDeleteResult {
  ok: boolean
  removed: number
  skipped: number
  items?: AiReplyReservationDeleteItem[]
  error?: string
}

/**
 * 桌面端专用：重新生成一条空白失败的 AI 回复记录。
 *
 * 会再调用一次模型并可能出网，成功后不可撤销；`sourceRef` 是记录的幂等键，
 * 由列表记录原样带入，用于防止点击后目标被其它记录替换。
 */
export async function apiRegenerateChatAiReplyRecord(
  recordId: number,
  sourceRef: string,
): Promise<ChatAiReplyRegenerateResult> {
  const result = unwrap(await remote().regenerateChatAiReplyRecord({
    recordId,
    expectedSourceRef: sourceRef,
  }))
  if (result.ok) notifyMessageListUpdated()
  return result
}

/**
 * 桌面端专用：整组删除 AI 回复记录。
 *
 * 默认只删空白且从未发送的预约/失败记录。传 `includeTerminal` 时放开已收口的终态
 * 记录（成功 / 已发出未确认 / 失败）；在途状态（生成中 / 投递中 / 下游任务未结束）
 * 后端一律跳过。不可撤销；记录不存在算 skipped，因此重复调用是幂等的。
 */
export async function apiDeleteAiReplyReservations(
  ids: number[],
  options: { includeTerminal?: boolean } = {},
): Promise<AiReplyReservationDeleteResult> {
  const result = unwrap(await remote().deleteAiReplyReservations({
    ids,
    ...(options.includeTerminal === true ? { includeTerminal: true } : {}),
  }))
  if (result.ok) notifyMessageListUpdated()
  return result
}

/**
 * 读取 AI 回复默认 Webhook。
 *
 * 默认地址的完整 token 只留在本机后端；此处拿到的 endpoint 应为脱敏值。
 * 方法名先以可选能力读取，便于前后端滚动升级时给旧后端一条明确提示，而不是
 * 把 "remote method is not a function" 直接暴露在设置弹窗里。
 */
export async function apiGetChatAiReplyDefaultWebhook(options: {
  chatUsername: string
  chatName?: string
}): Promise<ChatAiReplyDefaultWebhookState> {
  const client = defaultWebhookClient()
  const get = client.getChatAiReplyDefaultWebhook
  if (typeof get !== 'function') {
    throw new Error('当前后端版本不支持默认 Webhook 配置，请先更新后再试')
  }
  const result = await get.call(client, options)
  return defaultWebhookState(unwrap(result))
}

/**
 * 保存默认 Webhook，并让后端回填该默认地址对应的 AI 回复待投递记录。
 *
 * 空值和脱敏值由调用方拦截，这里只接受用户新输入的完整 URL。
 */
export async function apiSaveChatAiReplyDefaultWebhook(options: {
  chatUsername: string
  chatName?: string
  webhookUrl: string
}): Promise<ChatAiReplyDefaultWebhookSaveResult> {
  const client = defaultWebhookClient()
  const save = client.saveChatAiReplyDefaultWebhook
  if (typeof save !== 'function') {
    throw new Error('当前后端版本不支持默认 Webhook 配置，请先更新后再试')
  }
  const result = await save.call(client, options)
  const value = unwrap(result)
  const state = defaultWebhookState(value.state ?? value)
  const stateResult = {
    configured: state.configured,
    endpoint: state.endpoint,
    ...(state.updatedAt === undefined ? {} : { updatedAt: state.updatedAt }),
    ...(state.error === undefined ? {} : { error: state.error }),
  }
  if (value.ok === false) {
    return {
      ok: false,
      ...stateResult,
      error: typeof value.error === 'string' ? value.error : '默认 Webhook 保存失败',
    }
  }
  notifyMessageListUpdated()
  return {
    ok: true,
    ...stateResult,
    ...(typeof value.ruleId === 'number' ? { ruleId: value.ruleId } : {}),
    ...(typeof value.ruleCreated === 'boolean' ? { ruleCreated: value.ruleCreated } : {}),
    ...(typeof value.backfilled === 'number' ? { backfilled: value.backfilled } : {}),
  }
}

/** 过程留痕的展示形状（与后端契约一致，只读）。 */
export interface ChatAiReplyTraceView {
  recordId: number
  sourceRef: string
  accountKey: string
  chatUsername: string
  model: string
  startedAt: number
  finishedAt: number
  context: string
  kb: string
  systemPrompt: string
  userPrompt: string
  imageCount: number
  voiceCount: number
  output: string
  error: string
  redacted: boolean
  stages: Array<{ name: string; at: number; detail?: string }>
  /** 本轮实际发生的工具调用（后端留痕里的 `tools`）。 */
  tools: Array<{ name: string; ok: boolean; code?: string; elapsedMs: number }>
  updatedAt: number
}

export type ChatAiReplyTraceRead =
  | { ok: true; trace: ChatAiReplyTraceView }
  | { ok: false; error: string }

/**
 * 读取一条 AI 回复记录的过程留痕。
 *
 * 旧记录可能没有留痕（功能上线前产生的），这时返回 `ok:false` 而不是抛错，
 * 详情抽屉据此显示「这条记录没有留痕」。
 */
export async function apiGetChatAiReplyTrace(recordId: number): Promise<ChatAiReplyTraceRead> {
  const result = await remote().getChatAiReplyTrace({ recordId })
  if (result.ok !== true || result.value === undefined) {
    return {
      ok: false,
      error: result.error?.message ?? result.error?.code ?? '过程留痕读取失败',
    }
  }
  const value = result.value
  if (value.ok !== true || value.trace === undefined) {
    return { ok: false, error: typeof value.error === 'string' ? value.error : '这条记录没有过程留痕' }
  }
  return { ok: true, trace: value.trace }
}