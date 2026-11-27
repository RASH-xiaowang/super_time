/**
 * 消息列表规则匹配、CRUD、精确自动绑定与回填。
 */
import { withWritableDb } from './db-open.ts'
import type { DatabaseSync } from './db-open.ts'
import { storeExists, taskDbPath } from './task-db.ts'
import type {
  MessageListMutationResult,
  MessageListRule,
  MessageListRuleInput,
  MessageListRuleSnapshot,
} from '../types.ts'
import {
  NAME_MAX,
  NOTE_MAX,
  SOURCE_REF_MAX,
  TEXT_MAX,
  USERNAME_MAX,
  ensureParentDir,
  errorText,
  httpUrl,
  numOf,
  positiveId,
  textOf,
} from './message-list-store-shared.ts'
import {
  ensureMessageListSchema,
  rowToMessageListRule,
} from './message-list-store-schema.ts'
import {
  featherRequestCapacityError,
  featherTextCapacityError,
  isFeatherResourceEndpoint,
  isFeatherWebhookEndpoint,
} from './ai-reply/provider.ts'
import { canonicalChatReference } from './message-identity.ts'

/** AI 回复默认规则的账号作用域；普通规则不传，仍保持全局人工规则语义。 */
export interface MessageListRuleScope {
  accountKey?: string
  chatUsername?: string
}

function featherRuleCapacityError(
  webhookUrl: string,
  chatName: string,
  targetName: string,
  greetingText: string,
): string | undefined {
  if (!isFeatherWebhookEndpoint(webhookUrl)) return undefined
  const fieldError = (chatName === ''
    ? undefined
    : featherTextCapacityError(chatName, '会话名', 'name'))
    || (targetName === ''
      ? undefined
      : featherTextCapacityError(targetName, '触发对象', 'name'))
    || featherTextCapacityError(greetingText, '首次触发文本', 'message')
  if (fieldError !== undefined) return fieldError
  return featherRequestCapacityError({
    target: chatName || targetName,
    message: greetingText,
    ...(chatName === '' || targetName === '' || chatName === targetName
      ? {}
      : { mention: targetName }),
  })
}

/** 规则匹配：精确对 > 同会话通配对象 > 任意会话指定对象 > 全局通配。 */
export function matchMessageListRuleAt(
  db: DatabaseSync,
  chatName: string,
  targetName: string,
  scope: MessageListRuleScope = {},
): MessageListRule | undefined {
  ensureMessageListSchema(db)
  const chat = textOf(chatName, NAME_MAX)
  const target = textOf(targetName, NAME_MAX)
  const account = textOf(scope.accountKey, USERNAME_MAX)
  const chatUsername = textOf(scope.chatUsername, USERNAME_MAX)
  const scoped = account !== '' && chatUsername !== ''
  const scopeClause = scoped
    ? `(account_key = '' OR (account_key = ? AND chat_username = ?))`
    : `account_key = '' AND chat_username = ''`
  const scopeParams = scoped ? [account, chatUsername] : []
  const row = db.prepare(`SELECT * FROM message_list_rules
    WHERE enabled = 1 AND (${scopeClause}) AND (
      (chat_name = ? AND target_name = ?)
      OR (chat_name = ? AND target_name = '')
      OR (chat_name = '' AND target_name = ?)
      OR (chat_name = '' AND target_name = '')
    )
    ORDER BY CASE
      WHEN chat_name = ? AND target_name = ? THEN 0
      WHEN chat_name = ? AND target_name = '' THEN 1
      WHEN chat_name = '' AND target_name = ? THEN 2
      ELSE 3
    END,
    CASE WHEN account_key = '' THEN 0 ELSE 1 END,
    updated_at DESC, id DESC
    LIMIT 1`).get(
    ...scopeParams,
    chat,
    target,
    chat,
    target,
    chat,
    target,
    chat,
    target,
  ) as Record<string, unknown> | undefined
  return row === undefined ? undefined : rowToMessageListRule(row)
}

/** 按当前规则表匹配一条规则；库不存在/读失败时返回 undefined。 */
export function matchMessageListRule(
  decryptedDir: string,
  chatName: string,
  targetName: string,
  scope: MessageListRuleScope = {},
): MessageListRule | undefined {
  if (!storeExists(decryptedDir)) return undefined
  const canonicalChat = canonicalChatReference(decryptedDir, scope.chatUsername ?? '', '规则会话')
  if (canonicalChat.error !== undefined) return undefined
  const normalizedScope: MessageListRuleScope = {
    ...scope,
    ...(scope.chatUsername === undefined || scope.chatUsername.trim() === ''
      ? {}
      : { chatUsername: canonicalChat.username }),
  }
  try {
    return withWritableDb(
      taskDbPath(decryptedDir),
      (db) => matchMessageListRuleAt(db, chatName, targetName, normalizedScope),
    )
  } catch {
    return undefined
  }
}

/** 规则列表（最新更新在前）。 */
export function listMessageListRules(decryptedDir: string): MessageListRuleSnapshot {
  if (!storeExists(decryptedDir)) return { items: [], total: 0 }
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      const rows = db.prepare('SELECT * FROM message_list_rules ORDER BY updated_at DESC, id DESC')
        .all() as Array<Record<string, unknown>>
      return { items: rows.map(rowToMessageListRule), total: rows.length }
    })
  } catch (e) {
    return { items: [], total: 0, readError: '规则读取失败：' + errorText(e) }
  }
}

/** 删除一条规则；已有记录的地址快照不受影响。 */
export function deleteMessageListRule(decryptedDir: string, id: number): MessageListMutationResult {
  const ruleId = positiveId(id)
  if (ruleId <= 0) return { ok: false, error: '规则不存在' }
  if (!storeExists(decryptedDir)) return { ok: false, error: '规则不存在' }
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      const info = db.prepare('DELETE FROM message_list_rules WHERE id = ?').run(ruleId)
      return Number(info.changes) > 0 ? { ok: true, id: ruleId } : { ok: false, error: '规则不存在' }
    })
  } catch (e) {
    return { ok: false, error: '规则删除失败：' + errorText(e) }
  }
}


/**
 * 新建 / 更新规则，并为尚无地址快照的同类 pending 记录补上地址。
 * @param decryptedDir - 解密数据根。
 * @param input - 规则入参；`id` 缺省 = 新建。
 */
export function saveMessageListRule(
  decryptedDir: string,
  input: MessageListRuleInput,
): MessageListMutationResult {
  const webhookUrl = httpUrl(input?.webhookUrl)
  if (webhookUrl === '') return { ok: false, error: 'Webhook 地址必须是合法的 http/https 地址' }
  if (isFeatherResourceEndpoint(webhookUrl)) {
    return {
      ok: false,
      error: 'Webhook 必须填写基础发送地址 /webhook/<token>，不能使用附件资源端点 /resources',
    }
  }
  const chatName = textOf(input?.chatName, NAME_MAX)
  const targetName = textOf(input?.targetName, NAME_MAX)
  const greetingText = textOf(input?.greetingText, TEXT_MAX) || '你好'
  const note = textOf(input?.note, NOTE_MAX)
  // 实例 id 是 UUID（36 字符）；脏值直接截断成空串，不让它污染 addr 同步逻辑。
  const appInstanceId = textOf(input?.appInstanceId, 64)
  const capacityError = featherRuleCapacityError(webhookUrl, chatName, targetName, greetingText)
  if (capacityError !== undefined) return { ok: false, error: capacityError }
  const id = positiveId(input?.id)
  ensureParentDir(decryptedDir)
  const now = Date.now()
  let scopeAccount = ''
  let scopeChatUsername = ''
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      let ruleId = id
      if (id > 0) {
        const current = db.prepare(`SELECT enabled, account_key, chat_username, managed_by
          FROM message_list_rules WHERE id = ?`)
          .get(id) as {
            enabled?: unknown
            account_key?: unknown
            chat_username?: unknown
            managed_by?: unknown
          } | undefined
        if (current === undefined) return { ok: false, error: '规则不存在' }
        scopeAccount = textOf(current.account_key, USERNAME_MAX)
        const storedChatUsername = textOf(current.chat_username, USERNAME_MAX)
        scopeChatUsername = canonicalChatReference(
          decryptedDir,
          storedChatUsername,
          '规则会话',
        ).username
        const enabled = input?.enabled === undefined ? numOf(current.enabled) === 1 : input.enabled !== false
        // 内部「同步托管实例地址」会传 keepManagedBy：那条规则仍由系统维护，
        // 清掉标记会让它下次不再跟随会话级默认地址。
        const managedBy = input?.keepManagedBy === true
          ? textOf(current.managed_by, 40)
          : ''
        db.prepare(`UPDATE message_list_rules SET
          chat_name = ?, target_name = ?, webhook_url = ?, greeting_text = ?, note = ?,
          enabled = ?, managed_by = ?, app_instance_id = ?, updated_at = ?
          WHERE id = ?`).run(
          chatName,
          targetName,
          webhookUrl,
          greetingText,
          note,
          enabled ? 1 : 0,
          managedBy,
          appInstanceId,
          now,
          id,
        )
      } else {
        const enabled = input?.enabled !== false
        const info = db.prepare(`INSERT INTO message_list_rules
          (chat_name, target_name, webhook_url, greeting_text, note, enabled, app_instance_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          chatName, targetName, webhookUrl, greetingText, note, enabled ? 1 : 0, appInstanceId, now, now,
        )
        ruleId = numOf(info.lastInsertRowid)
      }
      if (ruleId <= 0) return { ok: false, error: '规则保存后无法确定 id' }
      let backfilled = 0
      if (input?.enabled !== false) {
        const hasScopedRule = scopeAccount !== '' || scopeChatUsername !== ''
        if (hasScopedRule && scopeAccount !== '' && scopeChatUsername !== '') {
          const sourceRefPrefix = 'ai-reply:' + scopeAccount + ':' + scopeChatUsername + ':'
          const info = db.prepare(`UPDATE message_list_records SET webhook_url = ?, error = '', updated_at = ?
            WHERE source = 'ai_reply' AND status = 'pending' AND webhook_url = ''
              AND (trim(text) <> '' OR (images <> '[]' AND images <> ''))
              AND chat_name = ? AND target_name = ? AND chat_username = ?
              AND substr(source_ref, 1, length(?)) = ?`)
            .run(
              webhookUrl,
              now,
              chatName,
              targetName,
              scopeChatUsername,
              sourceRefPrefix,
              sourceRefPrefix,
            )
          backfilled = Math.max(0, Number(info.changes))
        } else if (!hasScopedRule) {
          const info = db.prepare(`UPDATE message_list_records SET webhook_url = ?, error = '', updated_at = ?
            WHERE status = 'pending' AND webhook_url = ''
              AND (trim(text) <> '' OR (images <> '[]' AND images <> ''))
              AND chat_name = ? AND target_name = ?`)
            .run(webhookUrl, now, chatName, targetName)
          backfilled = Math.max(0, Number(info.changes))
        }
      }
      return { ok: true, id: ruleId, backfilled }
    })
  } catch (e) {
    const raw = errorText(e)
    if (/UNIQUE constraint failed/i.test(raw)) {
      return { ok: false, error: '同一「会话名 + 触发对象」已存在规则，请直接编辑那一条' }
    }
    return { ok: false, error: '规则保存失败：' + raw }
  }
}

export interface EnsureExactMessageListRuleInput {
  webhookUrl: string
  chatName: string
  targetName: string
  /** 默认 AI 规则的作用域；人工规则不传，继续作为全局规则参与匹配。 */
  accountKey?: string
  chatUsername?: string
  /** 可选：仅回填该前缀的 AI 记录，避免同名会话跨账号串写。 */
  sourceRefPrefix?: string
  greetingText?: string
  note?: string
  enabled?: boolean
  /**
   * 地址由哪个托管实例提供（`apps.superlanguage` 实例 id）。
   *
   * 默认规则也要记住它：实例换端口后主进程靠这一列把地址同步过来，
   * 否则「会话级默认 Webhook 指向实例」的规则一重启就指向死端口。
   */
  appInstanceId?: string
}

export type EnsureExactMessageListRuleResult =
  | {
    ok: true
    id: number
    created: boolean
    backfilled: number
  }
  | { ok: false; error: string }

/**
 * 仅当精确的「会话名 + 触发对象」规则不存在时创建，绝不覆盖人工规则。
 *
 * 默认 Webhook 自动绑定和 AI 回复开关共用此入口。人工精确规则优先且永不更新；
 * 账号作用域内由系统创建的同名规则会跟随默认地址更新。回填只处理已有正文或
 * 附件、且尚无地址快照的 AI pending 记录，状态始终保持 pending。
 */
export function ensureExactMessageListRule(
  decryptedDir: string,
  input: EnsureExactMessageListRuleInput,
): EnsureExactMessageListRuleResult {
  const webhookUrl = httpUrl(input?.webhookUrl)
  if (webhookUrl === '') return { ok: false, error: 'Webhook 地址必须是合法的 http/https 地址' }
  const chatName = textOf(input?.chatName, NAME_MAX)
  const targetName = textOf(input?.targetName, NAME_MAX)
  const accountKey = textOf(input?.accountKey, USERNAME_MAX)
  const rawChatUsername = textOf(input?.chatUsername, USERNAME_MAX)
  const canonicalChat = canonicalChatReference(decryptedDir, rawChatUsername, 'AI 回复规则会话')
  if (canonicalChat.error !== undefined) return { ok: false, error: canonicalChat.error }
  const chatUsername = canonicalChat.username
  if ((accountKey === '') !== (chatUsername === '')) {
    return { ok: false, error: '账号作用域必须同时指定账号和会话 username' }
  }
  const sourceRefPrefix = textOf(input?.sourceRefPrefix, SOURCE_REF_MAX)
  const scopedSourceRefPrefix = accountKey === '' || chatUsername === ''
    ? ''
    : 'ai-reply:' + accountKey + ':' + chatUsername + ':'
  if (
    scopedSourceRefPrefix !== ''
    && sourceRefPrefix !== ''
    && !sourceRefPrefix.startsWith(scopedSourceRefPrefix)
  ) {
    return { ok: false, error: 'AI 回复规则的 sourceRef 前缀与账号/会话作用域不一致' }
  }
  const effectiveSourceRefPrefix = sourceRefPrefix || scopedSourceRefPrefix
  if (chatName === '' || targetName === '') {
    return { ok: false, error: '自动绑定规则必须指定会话名和触发对象' }
  }
  const greetingText = textOf(input?.greetingText, TEXT_MAX) || '你好'
  const note = textOf(input?.note, NOTE_MAX)
  const capacityError = featherRuleCapacityError(webhookUrl, chatName, targetName, greetingText)
  if (capacityError !== undefined) return { ok: false, error: capacityError }
  const enabled = input?.enabled !== false
  ensureParentDir(decryptedDir)
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      db.exec('BEGIN IMMEDIATE')
      try {
        const scoped = accountKey !== '' && chatUsername !== ''
        let row = (scoped
          ? db.prepare(`SELECT * FROM message_list_rules
            WHERE chat_name = ? AND target_name = ?
              AND (
                (account_key = '' AND chat_username = '')
                OR (account_key = ? AND chat_username = ?)
              )
            ORDER BY CASE WHEN account_key = '' THEN 0 ELSE 1 END,
              updated_at DESC, id DESC
            LIMIT 1`).get(chatName, targetName, accountKey, chatUsername)
          : db.prepare(`SELECT * FROM message_list_rules
            WHERE chat_name = ? AND target_name = ?
              AND account_key = '' AND chat_username = ''
            ORDER BY updated_at DESC, id DESC LIMIT 1`).get(chatName, targetName)
        ) as Record<string, unknown> | undefined
        let created = false
        let systemRuleUpdated = false
        let previousSystemWebhook = ''
        const managedInstance = textOf(input?.appInstanceId, 64)
        if (row === undefined) {
          const now = Date.now()
          const info = db.prepare(`INSERT INTO message_list_rules
            (account_key, chat_username, chat_name, target_name, webhook_url,
              greeting_text, note, enabled, managed_by, app_instance_id, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ai_reply_default', ?, ?, ?)`).run(
            accountKey,
            chatUsername,
            chatName,
            targetName,
            webhookUrl,
            greetingText,
            note,
            enabled ? 1 : 0,
            managedInstance,
            now,
            now,
          )
          created = Number(info.changes) > 0
          row = db.prepare('SELECT * FROM message_list_rules WHERE id = ?').get(
            Number(info.lastInsertRowid),
          ) as Record<string, unknown> | undefined
        } else if (
          scoped
          && textOf(row['account_key'], USERNAME_MAX) === accountKey
          && textOf(row['chat_username'], USERNAME_MAX) === chatUsername
          && textOf(row['managed_by'], 40) === 'ai_reply_default'
        ) {
          previousSystemWebhook = httpUrl(row['webhook_url'])
          const previousInstance = textOf(row['app_instance_id'], 64)
          if (previousSystemWebhook !== webhookUrl
            || numOf(row['enabled']) !== 1
            || previousInstance !== managedInstance) {
            db.prepare(`UPDATE message_list_rules SET
              webhook_url = ?, enabled = 1, app_instance_id = ?, updated_at = ?
              WHERE id = ?`).run(webhookUrl, managedInstance, Date.now(), numOf(row['id']))
            systemRuleUpdated = true
            row = db.prepare('SELECT * FROM message_list_rules WHERE id = ?').get(
              numOf(row['id']),
            ) as Record<string, unknown> | undefined
          }
        }
        if (row === undefined) throw new Error('规则写入后无法回读')
        const rule = rowToMessageListRule(row)
        if (rule.id <= 0) throw new Error('规则保存后无法确定 id')
        if (!rule.enabled) {
          throw new Error('已有精确人工规则未启用；请先在消息列表中启用该规则')
        }
        let backfilled = 0
        if (rule.enabled && rule.webhookUrl !== '') {
          const info = db.prepare(`UPDATE message_list_records SET
            webhook_url = ?, error = '', updated_at = ?
            WHERE source = 'ai_reply' AND status = 'pending'
              AND chat_name = ? AND target_name = ?
              AND (? = '' OR chat_username = ?)
              AND (? = '' OR substr(source_ref, 1, length(?)) = ?)
              AND (trim(text) <> '' OR (images <> '[]' AND images <> ''))
              AND (webhook_url = '' OR (? <> '' AND webhook_url = ?))`).run(
            rule.webhookUrl,
            Date.now(),
            chatName,
            targetName,
            chatUsername,
            chatUsername,
            effectiveSourceRefPrefix,
            effectiveSourceRefPrefix,
            effectiveSourceRefPrefix,
            systemRuleUpdated ? previousSystemWebhook : '',
            systemRuleUpdated ? previousSystemWebhook : '',
          )
          backfilled = Math.max(0, Number(info.changes))
        }
        db.exec('COMMIT')
        return { ok: true, id: rule.id, created, backfilled }
      } catch (e) {
        try {
          db.exec('ROLLBACK')
        } catch {
          // 原始错误更有用；回滚失败时仍交给外层统一报错。
        }
        throw e
      }
    })
  } catch (e) {
    const raw = errorText(e)
    if (/UNIQUE constraint failed/i.test(raw)) {
      return { ok: false, error: '同一「会话名 + 触发对象」规则已存在，请刷新后重试' }
    }
    return { ok: false, error: 'AI 回复规则自动绑定失败：' + raw }
  }
}

/**
 * 任务创建/更新后，保证「会话名 + 触发对象」有一条消息列表规则。
 *
 * 已有精确规则不改。没有时新建：下游地址优先沿用同会话规则，其次全局规则；
 * 都没有就先留空，用户再到规则里补地址。
 */
export function ensureTaskMessageListRule(
  db: DatabaseSync,
  input: { chatName: string; targetName: string },
): void {
  ensureMessageListSchema(db)
  const chatName = textOf(input.chatName, NAME_MAX)
  const targetName = textOf(input.targetName, NAME_MAX)
  if (chatName === '' || targetName === '') return
  const existing = db.prepare(`SELECT id FROM message_list_rules
    WHERE account_key = '' AND chat_username = '' AND chat_name = ? AND target_name = ?
    LIMIT 1`).get(chatName, targetName) as { id?: unknown } | undefined
  if (existing !== undefined) return
  const inherited = db.prepare(`SELECT webhook_url, app_instance_id FROM message_list_rules
    WHERE enabled = 1 AND account_key = '' AND chat_username = ''
      AND webhook_url <> ''
      AND (
        (chat_name = ? AND target_name = '')
        OR (chat_name = '' AND target_name = '')
      )
    ORDER BY CASE WHEN chat_name = ? THEN 0 ELSE 1 END, updated_at DESC, id DESC
    LIMIT 1`).get(chatName, chatName) as { webhook_url?: unknown; app_instance_id?: unknown } | undefined
  const now = Date.now()
  db.prepare(`INSERT INTO message_list_rules
    (chat_name, target_name, webhook_url, greeting_text, note, enabled, app_instance_id, created_at, updated_at)
    VALUES (?, ?, ?, '', ?, 1, ?, ?, ?)`).run(
    chatName,
    targetName,
    textOf(inherited?.webhook_url, 2000),
    '随任务创建',
    textOf(inherited?.app_instance_id, 64),
    now,
    now,
  )
}

/** 按 id 读取规则（桌面端探测已保存地址用）。 */
export function getMessageListRule(decryptedDir: string, id: number): MessageListRule | undefined {
  const ruleId = positiveId(id)
  if (ruleId <= 0 || !storeExists(decryptedDir)) return undefined
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureMessageListSchema(db)
      const row = db.prepare('SELECT * FROM message_list_rules WHERE id = ?')
        .get(ruleId) as Record<string, unknown> | undefined
      return row === undefined ? undefined : rowToMessageListRule(row)
    })
  } catch {
    return undefined
  }
}
