/**
 * 会话级 AI 回复的默认大肥鱼 Webhook。
 *
 * Webhook 完整地址只保存在本机任务库；读取 API 只返回脱敏端点。默认值按
 * (account_key, chat_username) 隔离，避免切换账号后串用另一账号的发送地址。
 * 应用默认值时仅创建缺失的精确消息列表规则，已有规则一律不覆盖。
 *
 * @module query/ai-reply/default-webhook-store
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { withWritableDb } from '../db-open.ts'
import type { DatabaseSync } from '../db-open.ts'
import { storeExists, taskDbPath } from '../task-db.ts'
import {
  ensureExactMessageListRule,
} from '../message-list-store.ts'
import type {
  EnsureExactMessageListRuleResult,
} from '../message-list-store.ts'
import { canonicalChatReference, isMessageTableHash } from '../message-identity.ts'

const ACCOUNT_MAX = 255
const USERNAME_MAX = 255
const NAME_MAX = 200
const WEBHOOK_MAX = 2048
const TEXT_MAX = 4000
const NOTE_MAX = 500

export interface ChatAiReplyDefaultWebhookView {
  configured: boolean
  endpoint: string
  updatedAt: number
}

export type ChatAiReplyDefaultWebhookReadResult =
  | { ok: true; webhook: ChatAiReplyDefaultWebhookView }
  | { ok: false; error: string }

export interface SaveChatAiReplyDefaultWebhookInput {
  accountKey: string
  chatUsername: string
  chatName?: string
  webhookUrl: string
}

export type SaveChatAiReplyDefaultWebhookResult =
  | { ok: true; webhook: ChatAiReplyDefaultWebhookView }
  | { ok: false; error: string }

export interface ApplyChatAiReplyDefaultWebhookInput {
  accountKey: string
  chatUsername: string
  chatName?: string
  targetName?: string
  greetingText?: string
  note?: string
}

export type ApplyChatAiReplyDefaultWebhookResult =
  | {
    ok: true
    configured: true
    endpoint: string
    updatedAt: number
    ruleId: number
    ruleCreated: boolean
    backfilled: number
  }
  | {
    ok: false
    configured: boolean
    endpoint: string
    updatedAt: number
    reason: 'missing_webhook' | 'rule_binding_failed' | 'store_error'
    error: string
  }

interface DefaultWebhookRow {
  account_key?: unknown
  chat_username?: unknown
  chat_name?: unknown
  webhook_url?: unknown
  updated_at?: unknown
}

function textOf(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function errorText(e: unknown): string {
  const message = (e as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' && message !== '' ? message : String(e)
}

function webhookUrlOf(value: unknown): string {
  const raw = textOf(value, WEBHOOK_MAX)
  if (raw === '') return ''
  try {
    const url = new URL(raw)
    const tokenizedPath = /^\/webhook\/[^/]+\/?$/i.test(url.pathname)
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.username === ''
      && url.password === ''
      && tokenizedPath
      ? raw
      : ''
  } catch {
    return ''
  }
}

/** 只展示 origin 与路径骨架；令牌、查询串、hash 和 URL 凭据都不返回界面。 */
export function redactChatAiReplyDefaultWebhookEndpoint(webhookUrl: string): string {
  try {
    const url = new URL(webhookUrl)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    url.pathname = url.pathname
      .replace(/(\/webhook\/)[^/]+/i, '$1***')
      .replace(/(\/api\/message-webhook\/)[^/]+/i, '$1***')
    return url.toString().replace(/\/$/, '')
  } catch {
    return ''
  }
}

function viewOf(row: DefaultWebhookRow | undefined): ChatAiReplyDefaultWebhookView {
  const webhookUrl = webhookUrlOf(row?.webhook_url)
  return webhookUrl === ''
    ? { configured: false, endpoint: '', updatedAt: 0 }
    : {
      configured: true,
      endpoint: redactChatAiReplyDefaultWebhookEndpoint(webhookUrl),
      updatedAt: Math.max(0, Number(row?.updated_at) || 0),
    }
}

/** 建表；与消息列表、AI 回复设置共用任务库。 */
export function ensureChatAiReplyDefaultWebhookSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_ai_reply_defaults (
    account_key TEXT NOT NULL,
    chat_username TEXT NOT NULL,
    chat_name TEXT NOT NULL DEFAULT '',
    webhook_url TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_key, chat_username)
  )`)
}

function keyOf(
  decryptedDir: string,
  accountKey: string,
  chatUsername: string,
): { account: string; username: string; displayName: string; error?: string } {
  const chat = canonicalChatReference(decryptedDir, chatUsername, 'AI 回复会话')
  if (chat.error !== undefined) {
    return { account: textOf(accountKey, ACCOUNT_MAX), username: '', displayName: chat.displayName, error: chat.error }
  }
  return {
    account: textOf(accountKey, ACCOUNT_MAX),
    username: chat.username,
    displayName: chat.displayName,
  }
}

function readStoredWebhook(
  decryptedDir: string,
  account: string,
  username: string,
): ChatAiReplyDefaultWebhookReadResult {
  if (account === '' || username === '') {
    return { ok: false, error: '缺少当前账号或会话' }
  }
  if (!storeExists(decryptedDir)) {
    return { ok: true, webhook: viewOf(undefined) }
  }
  try {
    const webhook = withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureChatAiReplyDefaultWebhookSchema(db)
      const row = db.prepare(`SELECT * FROM chat_ai_reply_defaults
        WHERE account_key = ? AND chat_username = ?`).get(
        account,
        username,
      ) as DefaultWebhookRow | undefined
      return viewOf(row)
    })
    return { ok: true, webhook }
  } catch (e) {
    return { ok: false, error: 'AI 回复默认 Webhook 读取失败：' + errorText(e) }
  }
}

/** 严格读取；完整地址永远不会出现在返回值中。 */
export function readChatAiReplyDefaultWebhookStrict(
  decryptedDir: string,
  accountKey: string,
  chatUsername: string,
): ChatAiReplyDefaultWebhookReadResult {
  const { account, username, error } = keyOf(decryptedDir, accountKey, chatUsername)
  if (error !== undefined) return { ok: false, error }
  return readStoredWebhook(decryptedDir, account, username)
}

/** 展示层使用的宽容读取；读失败按未配置处理。 */
export function readChatAiReplyDefaultWebhook(
  decryptedDir: string,
  accountKey: string,
  chatUsername: string,
): ChatAiReplyDefaultWebhookView {
  const result = readChatAiReplyDefaultWebhookStrict(decryptedDir, accountKey, chatUsername)
  return result.ok ? result.webhook : viewOf(undefined)
}

/** 保存并替换当前账号、当前会话的默认 Webhook。 */
export function saveChatAiReplyDefaultWebhook(
  decryptedDir: string,
  input: SaveChatAiReplyDefaultWebhookInput,
): SaveChatAiReplyDefaultWebhookResult {
  const { account, username, displayName, error } = keyOf(
    decryptedDir,
    input?.accountKey,
    input?.chatUsername,
  )
  if (error !== undefined) return { ok: false, error }
  if (account === '' || username === '') return { ok: false, error: '缺少当前账号或会话' }
  const webhookUrl = webhookUrlOf(input?.webhookUrl)
  if (webhookUrl === '') {
    return {
      ok: false,
      error: 'Webhook 必须是 Feather 的 /webhook/<token> 地址',
    }
  }
  const requestedChatName = textOf(input?.chatName, NAME_MAX)
  const chatName = isMessageTableHash(requestedChatName)
    ? displayName
    : (requestedChatName || displayName)
  mkdirSync(dirname(taskDbPath(decryptedDir)), { recursive: true })
  try {
    const webhook = withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureChatAiReplyDefaultWebhookSchema(db)
      const now = Date.now()
      db.prepare(`INSERT INTO chat_ai_reply_defaults
        (account_key, chat_username, chat_name, webhook_url, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(account_key, chat_username) DO UPDATE SET
          chat_name = excluded.chat_name,
          webhook_url = excluded.webhook_url,
          updated_at = excluded.updated_at`).run(
        account,
        username,
        chatName,
        webhookUrl,
        now,
      )
      const row = db.prepare(`SELECT * FROM chat_ai_reply_defaults
        WHERE account_key = ? AND chat_username = ?`).get(
        account,
        username,
      ) as DefaultWebhookRow | undefined
      return viewOf(row)
    })
    return { ok: true, webhook }
  } catch (e) {
    return { ok: false, error: 'AI 回复默认 Webhook 保存失败：' + errorText(e) }
  }
}

/**
 * 应用当前账号、当前会话已保存的默认 Webhook。
 *
 * 保存默认值后或开启 AI 回复时调用。只创建缺失的精确规则，并把同类无地址的
 * AI pending 记录回填到该规则地址，等待消息列表扫描投递。
 */
export function applyChatAiReplyDefaultWebhook(
  decryptedDir: string,
  input: ApplyChatAiReplyDefaultWebhookInput,
): ApplyChatAiReplyDefaultWebhookResult {
  const { account, username, displayName, error } = keyOf(
    decryptedDir,
    input?.accountKey,
    input?.chatUsername,
  )
  if (error !== undefined) {
    return {
      ok: false,
      configured: false,
      endpoint: '',
      updatedAt: 0,
      reason: 'store_error',
      error,
    }
  }
  if (account === '' || username === '') {
    return {
      ok: false,
      configured: false,
      endpoint: '',
      updatedAt: 0,
      reason: 'missing_webhook',
      error: '缺少当前账号或会话',
    }
  }
  let row: DefaultWebhookRow | undefined
  if (storeExists(decryptedDir)) {
    try {
      row = withWritableDb(taskDbPath(decryptedDir), (db) => {
        ensureChatAiReplyDefaultWebhookSchema(db)
        return db.prepare(`SELECT * FROM chat_ai_reply_defaults
          WHERE account_key = ? AND chat_username = ?`).get(
          account,
          username,
        ) as DefaultWebhookRow | undefined
      })
    } catch (e) {
      return {
        ok: false,
        configured: false,
        endpoint: '',
        updatedAt: 0,
        reason: 'store_error',
        error: 'AI 回复默认 Webhook 读取失败：' + errorText(e),
      }
    }
  }
  const stored = viewOf(row)
  const webhookUrl = webhookUrlOf(row?.webhook_url)
  if (!stored.configured || webhookUrl === '') {
    return {
      ok: false,
      configured: false,
      endpoint: '',
      updatedAt: 0,
      reason: 'missing_webhook',
      error: '请先配置默认大肥鱼 Webhook',
    }
  }
  const requestedChatName = textOf(input?.chatName, NAME_MAX)
  const chatName = isMessageTableHash(requestedChatName) ? '' : requestedChatName
  const effectiveChatName = chatName
    || textOf(row?.chat_name, NAME_MAX)
    || displayName
    || username
  const targetName = textOf(input?.targetName, NAME_MAX) || chatName
  const rule: EnsureExactMessageListRuleResult = ensureExactMessageListRule(decryptedDir, {
    webhookUrl,
    chatName: effectiveChatName,
    targetName: targetName || effectiveChatName,
    accountKey: account,
    chatUsername: username,
    sourceRefPrefix: 'ai-reply:' + account + ':' + username + ':',
    ...(input?.greetingText === undefined
      ? {}
      : { greetingText: textOf(input.greetingText, TEXT_MAX) }),
    ...(input?.note === undefined ? {} : { note: textOf(input.note, NOTE_MAX) }),
    enabled: true,
  })
  if (!rule.ok) {
    return {
      ok: false,
      configured: true,
      endpoint: stored.endpoint,
      updatedAt: stored.updatedAt,
      reason: 'rule_binding_failed',
      error: rule.error,
    }
  }
  return {
    ok: true,
    configured: true,
    endpoint: stored.endpoint,
    updatedAt: stored.updatedAt,
    ruleId: rule.id,
    ruleCreated: rule.created,
    backfilled: rule.backfilled,
  }
}
