/**
 * WechatDataGateway 方法面 · 消息列表 / 回复投递规则。
 *
 * 纯读方法可远程访问；规则写入、手动插入、重发与带令牌的 Webhook 信息只允许桌面端。
 * 该层位于 `GatewayAnalysisOps` 与 `GatewayTaskCenter` 之间，任务触发扫描通过
 * {@link GatewayMessageList.scheduleMessageListDispatch} 把新问候推向已配置的下游。
 */
import { Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  MessageListAttachmentStageInput,
  MessageListAttachmentStageResult,
  MessageListBatchDeleteResult,
  MessageListBatchResendResult,
  MessageListDispatchBatchResult,
  MessageListMutationResult,
  MessageListQuery,
  MessageListRecordInput,
  MessageListRecordResult,
  MessageListRuleInput,
  MessageListRuleSnapshot,
  MessageListSnapshot,
  MessageListWebhookInfo,
  MessageListWebhookJob,
  MessageListWebhookPayload,
  MessageListWebhookProbe,
} from './types.ts'
import { stageMessageListAttachment } from './query/message-list-attachments.ts'
import { GatewayAnalysisOps } from './gateway-analysis-ops.ts'
import { createMessageListRemotes } from './remotes/message-list.ts'
import { rawWechatBase } from './gateway-support.ts'
import { resolveImageKeyPair } from './query/image-key.ts'
import { getConfig } from './config/wechat-config.ts'
import { pickLanIPv4 } from './net/lan-ipv4.ts'
import { processIsAlive as isProcessAlive } from './query/process-liveness.ts'
import { readFileSync, statSync } from 'node:fs'
import { isIP } from 'node:net'
import { join } from 'node:path'
import {
  MESSAGE_WEBHOOK_API,
  MESSAGE_WEBHOOK_SERVICE,
  MESSAGE_WEBHOOK_VERSION,
  messageWebhookUrl,
} from './net/message-webhook.ts'

const DEFAULT_API_PORT = 5032
const HTTP_RUNTIME_FILE = 'http-runtime.json'
const HTTP_RUNTIME_MAX_BYTES = 4 * 1024

interface HttpRuntimeSnapshot {
  port: number
  address: string
}

function processIsAlive(pid: number): boolean {
  return isProcessAlive(pid)
}

/** 只接受当前宿主写入、仍存活且适合局域网访问的实际监听地址。 */
function usableLanAddress(raw: unknown): string {
  const address = typeof raw === 'string' ? raw.trim() : ''
  if (isIP(address) !== 4 || address === '0.0.0.0') return ''
  if (address.startsWith('127.') || address.startsWith('169.254.')) return ''
  return address
}

/**
 * 读取主进程写入的实际监听快照。
 *
 * 配置里的 `api_port` 只是首选端口，冲突时宿主会顺延；进程崩溃留下的快照则由 PID
 * 存活检查淘汰。任何字段异常都返回 null，让调用方回退到保守的配置推导。
 */
function readHttpRuntimeSnapshot(decryptedDir: string): HttpRuntimeSnapshot | null {
  const path = join(decryptedDir, '..', HTTP_RUNTIME_FILE)
  try {
    const stat = statSync(path)
    if (!stat.isFile() || stat.size <= 0 || stat.size > HTTP_RUNTIME_MAX_BYTES) return null
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (raw['version'] !== 1 || raw['running'] !== true) return null
    const pid = Number(raw['pid'])
    const port = Number(raw['port'])
    const address = usableLanAddress(raw['address'])
    if (!Number.isInteger(pid) || pid <= 0 || !processIsAlive(pid)) return null
    if (!Number.isInteger(port) || port <= 0 || port >= 65536 || address === '') return null
    return { port, address }
  } catch {
    return null
  }
}

function errorText(e: unknown): string {
  const msg = (e as { message?: unknown } | null | undefined)?.message
  return typeof msg === 'string' && msg !== '' ? msg : String(e)
}

function normalizeBaseUrl(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return ''
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return ''
    return (url.origin + url.pathname).replace(/\/+$/, '')
  } catch {
    return ''
  }
}

export abstract class GatewayMessageList extends GatewayAnalysisOps {
  @Remote('listMessageListRecords')
  listMessageListRecords(options?: MessageListQuery): MessageListSnapshot {
    return this.messageListRemotes().listMessageListRecords(options)
  }

  @Remote('listMessageListRules')
  listMessageListRules(): MessageListRuleSnapshot {
    return this.messageListRemotes().listMessageListRules()
  }

  /**
   * 保存消息列表规则。
   *
   * Feather Webhook 只能是基础发送地址 `/webhook/<token>`；
   * `/webhook/<token>/resources` 只是附件上传端点，会被拒绝保存。
   * 旧记录若已有资源端点快照，dispatch 会在任何出网前失败并记录 `failed`。
   *
   * 保存会顺带把地址回填到同类 pending 记录；回填后立刻调度一次投递批次，
   * 兑现界面上「配置发送地址后自动投递」的承诺，不再等下一次任务触发。
   */
  @Remote('saveMessageListRule')
  saveMessageListRule(options: MessageListRuleInput): MessageListMutationResult {
    const result = this.messageListRemotes().saveMessageListRule(options)
    if (result.ok && (result.backfilled ?? 0) > 0) {
      void this.scheduleMessageListDispatch()
    }
    return result
  }

  @Remote('deleteMessageListRule')
  deleteMessageListRule(options: { id: number }): MessageListMutationResult {
    return this.messageListRemotes().deleteMessageListRule(options)
  }

  @Remote('insertMessageListRecord')
  async insertMessageListRecord(options: MessageListRecordInput): Promise<MessageListRecordResult> {
    return this.messageListRemotes().insertMessageListRecord(options)
  }

  /**
   * 桌面端选择附件后，把它复制到本机受控 spool。
   * 只允许桌面端调用，避免远程会话借任意路径读取本机文件。
   */
  @Remote('stageMessageListAttachment')
  async stageMessageListAttachment(
    options: MessageListAttachmentStageInput,
  ): Promise<MessageListAttachmentStageResult> {
    return stageMessageListAttachment(this._dirs.decrypted, options)
  }

  @Remote('resendMessageListRecord')
  async resendMessageListRecord(options: { id: number }): Promise<MessageListRecordResult> {
    return this.messageListRemotes().resendMessageListRecord(options)
  }

  /** 按消息列表记录 id 顺序批量重发；只允许桌面端本机调用。 */
  @Remote('batchResendMessageListRecords')
  async batchResendMessageListRecords(
    options: { ids: number[] },
  ): Promise<MessageListBatchResendResult> {
    return this.messageListRemotes().batchResendMessageListRecords(options)
  }

  /** 批量删除消息记录；投递中的记录会跳过，只允许桌面端本机调用。 */
  @Remote('batchDeleteMessageListRecords')
  async batchDeleteMessageListRecords(
    options: { ids: number[] },
  ): Promise<MessageListBatchDeleteResult> {
    return this.messageListRemotes().batchDeleteMessageListRecords(options)
  }

  @Remote('ingestMessageListWebhook')
  async ingestMessageListWebhook(payload: MessageListWebhookPayload): Promise<MessageListRecordResult> {
    return this.messageListRemotes().ingestMessageListWebhook(payload)
  }

  @Remote('getMessageListWebhookInfo')
  getMessageListWebhookInfo(): MessageListWebhookInfo {
    return this.messageListRemotes().getMessageListWebhookInfo()
  }

  /**
   * 对某条记录或规则里已保存的下游地址做 GET 健康检查。
   * 输入不是任意 URL；返回值不含路径令牌，仅桌面端可调用。
   */
  @Remote('probeMessageListWebhook')
  probeMessageListWebhook(options: {
    recordId?: number
    ruleId?: number
  }): Promise<MessageListWebhookProbe> {
    return this.messageListRemotes().probeMessageListWebhook(options)
  }

  /**
   * 查询某条记录对应的下游异步发送任务。
   * 默认使用落库的 job id；只允许保守字符集，状态字段原样返回，不做送达推断。
   */
  @Remote('queryMessageListWebhookJob')
  queryMessageListWebhookJob(options: {
    recordId: number
    jobId?: string
  }): Promise<MessageListWebhookJob> {
    return this.messageListRemotes().queryMessageListWebhookJob(options)
  }

  protected _messageListRemotes?: ReturnType<typeof createMessageListRemotes>

  protected _messageListDispatch: Promise<MessageListDispatchBatchResult> | null = null
  protected _messageListDispatchQueued = false

  /** 单飞投递一批消息列表记录；同一时刻只开一个任务库写连接。 */
  protected scheduleMessageListDispatch(): Promise<MessageListDispatchBatchResult> {
    if (this._messageListDispatch !== null) {
      this._messageListDispatchQueued = true
      return this._messageListDispatch
    }
    this._messageListDispatch = this.messageListRemotes().dispatchPending()
      .then((result) => {
        if (result.dispatched > 0) this.emitMessageListUpdated(0, result.dispatched)
        return result
      })
      .catch((e: unknown): MessageListDispatchBatchResult => {
        console.warn('[message-list] 后台投递失败：' + errorText(e))
        return { dispatched: 0, failed: 0, errors: ['消息列表投递失败：' + errorText(e)] }
      })
      .finally(() => {
        this._messageListDispatch = null
        if (this._messageListDispatchQueued) {
          this._messageListDispatchQueued = false
          void this.scheduleMessageListDispatch()
        }
      })
    return this._messageListDispatch
  }

  protected emitMessageListUpdated(created: number, dispatched: number): void {
    try {
      this._ctx.emit('message-list/updated', { created, dispatched })
    } catch {
      // 事件尽力而为，面板下次打开仍会回源。
    }
  }

  protected messageWebhookInfo(): MessageListWebhookInfo {
    const cfg = getConfig(this._dirs.decrypted)
    const apiToken = typeof cfg['api_token'] === 'string' ? cfg['api_token'] : ''
    const enabled = cfg['api_enabled'] === true && apiToken !== ''
    const configured = normalizeBaseUrl(cfg['rpa_media_base_url'])
    const runtime = configured === '' ? readHttpRuntimeSnapshot(this._dirs.decrypted) : null
    const ip = runtime?.address ?? pickLanIPv4()
    const rawPort = Number(cfg['api_port'])
    const configuredPort = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : DEFAULT_API_PORT
    const port = runtime?.port ?? configuredPort
    const localBase = ip === '' ? '' : 'http://' + ip + ':' + String(port)
    const baseUrl = configured !== '' ? configured : localBase
    const url = baseUrl === '' ? '' : messageWebhookUrl(baseUrl, apiToken)
    const post = { chatName: '客户群', target: '张三', message: '你好' }
    const error = url === ''
      ? (apiToken === '' ? '请先在设置中生成局域网访问令牌' : '未找到可用的局域网 IPv4 地址')
      : (enabled ? undefined : '局域网访问当前未开启；打开后该地址才可访问')
    return {
      enabled,
      url,
      getExample: url === '' ? '' : 'curl "' + url + '"',
      postExample: url === '' ? '' : 'curl -X POST "' + url + '" -H "Content-Type: application/json" -d \''
        + JSON.stringify(post) + '\'',
      version: MESSAGE_WEBHOOK_SERVICE + ' ' + MESSAGE_WEBHOOK_VERSION + ' (api ' + String(MESSAGE_WEBHOOK_API) + ')',
      ...(error === undefined ? {} : { error }),
    }
  }

  protected messageListRemotes(): ReturnType<typeof createMessageListRemotes> {
    return (this._messageListRemotes ??= createMessageListRemotes({
      dirs: () => this._dirs,
      op: (category, action, status, target, detail) => this.op(category, action, status, target, detail),
      privacyGate: (feature, stats, texts) => this.privacyGate(feature, stats, texts),
      imageContext: () => {
        const base = rawWechatBase(this._dirs.decrypted)
        const { aesKey, xorKey } = resolveImageKeyPair(this._dirs.decrypted)
        return {
          ...(base === '' ? {} : { wechatBaseDir: base }),
          ...(aesKey === undefined ? {} : { aesKey }),
          xorKey,
        }
      },
      webhookInfo: () => this.messageWebhookInfo(),
      changed: (created, dispatched) => this.emitMessageListUpdated(created, dispatched),
    }))
  }
}
