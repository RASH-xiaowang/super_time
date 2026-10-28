/**
 * 消息列表局域网 Webhook 的**稳定路径令牌**（后端签发 / 宿主层验签共用）。
 *
 * 不把 `secrets.json` 的 `api_token` 直接放进 URL：用域分隔的 SHA-256 派生密钥，
 * 再签一个固定 HMAC 作为路径。用户轮换 `api_token` 后旧地址立即失效，但仍不需要
 * 额外维护第三份长期凭据。
 *
 * 该模块纯函数、无 I/O，后端 bundle 与宿主 HTTP 小 bundle 共用同一份实现。
 *
 * @module net/message-webhook
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

/** 路由前缀（宿主层与会话页共用）。 */
export const MESSAGE_WEBHOOK_PATH_PREFIX = '/api/message-webhook/'

/** Webhook 对外声明的协议版本。 */
export const MESSAGE_WEBHOOK_SERVICE = 'message-list'
export const MESSAGE_WEBHOOK_VERSION = '1.0'
export const MESSAGE_WEBHOOK_API = 1

/** 由长期令牌派生消息 Webhook 的域密钥。 */
export function messageWebhookTokenKey(apiToken: string): Buffer {
  return createHash('sha256').update('supertime-message-webhook\0' + apiToken, 'utf8').digest()
}

/** 生成稳定的 URL 路径令牌（空 apiToken 返回空串）。 */
export function deriveMessageWebhookToken(apiToken: string): string {
  if (apiToken === '') return ''
  const key = messageWebhookTokenKey(apiToken)
  return createHmac('sha256', key).update('message-webhook-v1', 'utf8').digest('base64url')
}

/** 定长比较路径令牌；格式不对或密钥不同都返回 false。 */
export function verifyMessageWebhookToken(apiToken: string, token: string): boolean {
  if (apiToken === '' || typeof token !== 'string' || token === '') return false
  const expected = Buffer.from(deriveMessageWebhookToken(apiToken), 'utf8')
  const actual = Buffer.from(token, 'utf8')
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

/** 拼出完整的入站地址。 */
export function messageWebhookUrl(baseUrl: string, apiToken: string): string {
  const token = deriveMessageWebhookToken(apiToken)
  if (token === '') return ''
  return baseUrl.replace(/\/+$/, '') + MESSAGE_WEBHOOK_PATH_PREFIX + token
}
