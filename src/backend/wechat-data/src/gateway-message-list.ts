/**
 * WechatDataGateway 方法面 · 消息列表 / 回复投递规则。
 *
 * 纯读方法可远程访问；规则写入、手动插入、重发与带令牌的 Webhook 信息只允许桌面端。
 * 该层位于 `GatewayLayaOps` 与 `GatewayTaskCenter` 之间，任务触发扫描通过
 * {@link GatewayMessageList.scheduleMessageListDispatch} 把新问候推向已配置的下游。
 */
import { Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  MessageListDispatchBatchResult,
  MessageListMutationResult,
  MessageListQuery,
  MessageListRecordInput,
  MessageListRecordResult,
  MessageListRuleInput,
  MessageListRuleSnapshot,
  MessageListSnapshot,
  MessageListWebhookInfo,
  MessageListWebhookPayload,
} from './types.ts'
import { GatewayLayaOps } from './gateway-laya-ops.ts'
import { createMessageListRemotes } from './remotes/message-list.ts'
import { rawWechatBase } from './gateway-support.ts'
import { resolveImageKeyPair } from './query/image-key.ts'
import { getConfig } from './config/wechat-config.ts'
import { pickLanIPv4 } from './net/lan-ipv4.ts'
import {
  MESSAGE_WEBHOOK_API,
  MESSAGE_WEBHOOK_SERVICE,
  MESSAGE_WEBHOOK_VERSION,
  messageWebhookUrl,
} from './net/message-webhook.ts'

const DEFAULT_API_PORT = 5032

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

export abstract class GatewayMessageList extends GatewayLayaOps {
  @Remote('listMessageListRecords')
  listMessageListRecords(options?: MessageListQuery): MessageListSnapshot {
    return this.messageListRemotes().listMessageListRecords(options)
  }

  @Remote('listMessageListRules')
  listMessageListRules(): MessageListRuleSnapshot {
    return this.messageListRemotes().listMessageListRules()
  }

  @Remote('saveMessageListRule')
  saveMessageListRule(options: MessageListRuleInput): MessageListMutationResult {
    return this.messageListRemotes().saveMessageListRule(options)
  }

  @Remote('deleteMessageListRule')
  deleteMessageListRule(options: { id: number }): MessageListMutationResult {
    return this.messageListRemotes().deleteMessageListRule(options)
  }

  @Remote('insertMessageListRecord')
  async insertMessageListRecord(options: MessageListRecordInput): Promise<MessageListRecordResult> {
    return this.messageListRemotes().insertMessageListRecord(options)
  }

  @Remote('resendMessageListRecord')
  async resendMessageListRecord(options: { id: number }): Promise<MessageListRecordResult> {
    return this.messageListRemotes().resendMessageListRecord(options)
  }

  @Remote('ingestMessageListWebhook')
  async ingestMessageListWebhook(payload: MessageListWebhookPayload): Promise<MessageListRecordResult> {
    return this.messageListRemotes().ingestMessageListWebhook(payload)
  }

  @Remote('getMessageListWebhookInfo')
  getMessageListWebhookInfo(): MessageListWebhookInfo {
    return this.messageListRemotes().getMessageListWebhookInfo()
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
    const ip = pickLanIPv4()
    const rawPort = Number(cfg['api_port'])
    const port = Number.isInteger(rawPort) && rawPort > 0 && rawPort < 65536 ? rawPort : DEFAULT_API_PORT
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
