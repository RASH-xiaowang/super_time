/**
 * 会话级 AI 回复配置与运行状态。
 *
 * 与消息列表共用任务库，但使用独立配置键。所有写入都带
 * (account_key, chat_username) 身份，且开关更新支持 expectedRevision，
 * 防止两个界面同时操作时旧值覆盖新值。
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { withWritableDb } from '../db-open.ts'
import type { DatabaseSync } from '../db-open.ts'
import { storeExists, taskDbPath } from '../task-db.ts'
import type {
  ChatAiReplyEnabledStatesReadResult,
  ChatAiReplyMutationResult,
  ChatAiReplyProvider,
  ChatAiReplySetting,
  ChatAiReplyStage,
  ChatAiReplyState,
} from './types.ts'
import type { ChatAiReplyLease } from './lease-store.ts'
import {
  CHAT_AI_REPLY_PERSONA_NAME_MAX,
  CHAT_AI_REPLY_PERSONA_PROMPT_MAX,
  normalizeChatAiReplyPersona,
} from './persona.ts'
import { canonicalChatReference, isMessageTableHash } from '../message-identity.ts'

const NAME_MAX = 200
const USERNAME_MAX = 255
const ERROR_MAX = 500
const CURSOR_MAX = 200
const GENERATION_TEXT_MAX = 4000
const PENDING_REVISION_VALID = 'valid'
const PENDING_REVISION_LEGACY = 'legacy'

function textOf(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function numOf(value: unknown, fallback = 0): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : fallback
}

function positiveRevisionOf(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const revision = typeof value === 'number' ? value : Number(value)
  return Number.isSafeInteger(revision) && revision > 0 ? revision : undefined
}

function errorText(e: unknown): string {
  const message = (e as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' && message !== '' ? message : String(e)
}

function singleChatIdentity(
  decryptedDir: string,
  value: string,
): { username: string; displayName: string; error?: string } {
  const chat = canonicalChatReference(decryptedDir, value, 'AI 回复会话')
  if (chat.error !== undefined) return { username: '', displayName: chat.displayName, error: chat.error }
  if (chat.username !== '' && chat.type === 'group') {
    return { username: '', displayName: chat.displayName, error: 'AI 回复当前仅支持单聊' }
  }
  return { username: chat.username, displayName: chat.displayName }
}

function isBusyError(e: unknown): boolean {
  const record = e as { code?: unknown; message?: unknown } | null | undefined
  const code = typeof record?.code === 'string' ? record.code : ''
  const message = typeof record?.message === 'string' ? record.message : String(e)
  return /SQLITE_(?:BUSY|LOCKED)/i.test(code)
    || /database (?:table )?is locked|database is busy/i.test(message)
}

function isDuplicateColumnError(e: unknown): boolean {
  return /duplicate column name/i.test(errorText(e))
}

function tableHasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>
  return rows.some((row) => textOf(row.name, 80) === column)
}

/**
 * 老库并发启动时，两个连接可能都先看到缺列；后到的 ALTER 会报 duplicate column。
 * 这里把“列已经存在”当作迁移成功，避免一次正常竞态阻断后台 runner。
 */
function addColumnIfMissing(db: DatabaseSync, column: string, ddl: string): boolean {
  if (tableHasColumn(db, 'chat_ai_reply_settings', column)) return false
  try {
    db.exec(ddl)
    return true
  } catch (e) {
    if (isDuplicateColumnError(e) && tableHasColumn(db, 'chat_ai_reply_settings', column)) {
      return false
    }
    throw e
  }
}

function writeTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const value = fn()
    db.exec('COMMIT')
    return value
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 保留原始异常 */ }
    throw e
  }
}

function providerOf(value: unknown): ChatAiReplyProvider {
  return value === 'custom-webhook' ? 'custom-webhook' : 'dsh-wechat-bridge'
}

function stageOf(value: unknown): ChatAiReplyStage {
  return value === 'disabled' || value === 'queued' || value === 'generating'
    || value === 'saving' || value === 'dispatching' || value === 'waiting_config'
    || value === 'success' || value === 'failed'
    ? value
    : 'idle'
}

function defaultSetting(): ChatAiReplySetting {
  return {
    enabled: false,
    provider: 'dsh-wechat-bridge',
    splitReply: true,
    personaName: '',
    personaPrompt: '',
    kbEnabled: false,
    kbId: 0,
    revision: 0,
    updatedAt: 0,
    cursor: '',
  }
}

interface CursorPosition {
  version: 1 | 2
  primary: number
  secondary: number
}

function parseCursor(value: string): CursorPosition | null {
  const v2 = /^v2:(\d+):(\d+)$/.exec(value)
  if (v2 !== null) {
    return { version: 2, primary: Number(v2[1]), secondary: Number(v2[2]) }
  }
  const legacy = /^(\d+):(\d+)$/.exec(value)
  if (legacy !== null) {
    return { version: 1, primary: Number(legacy[1]), secondary: Number(legacy[2]) }
  }
  return null
}

function cursorMayAdvance(current: string, next: string): boolean {
  if (current === '') return true
  const before = parseCursor(current)
  const after = parseCursor(next)
  if (before === null) return true
  if (after === null) return false
  if (after.version !== before.version) return after.version > before.version
  return after.primary > before.primary
    || (after.primary === before.primary && after.secondary > before.secondary)
}

interface SettingRow {
  account_key?: unknown
  chat_username?: unknown
  chat_name?: unknown
  enabled?: unknown
  provider?: unknown
  split_reply?: unknown
  persona_name?: unknown
  persona_prompt?: unknown
  kb_enabled?: unknown
  kb_id?: unknown
  revision?: unknown
  updated_at?: unknown
  cursor?: unknown
  pending_cursor?: unknown
  pending_source_ref?: unknown
  pending_revision?: unknown
  pending_revision_marker?: unknown
  generation_state?: unknown
  generation_source_ref?: unknown
  generation_text?: unknown
  generation_revision?: unknown
  lease_owner?: unknown
  lease_until?: unknown
  lease_fence?: unknown
  stage?: unknown
  last_run_at?: unknown
  record_id?: unknown
  error?: unknown
}

function stateOf(
  accountKey: string,
  chatUsername: string,
  chatName: string,
  row: SettingRow | undefined,
): ChatAiReplyState {
  const setting = row === undefined
      ? defaultSetting()
      : {
        enabled: numOf(row.enabled) === 1,
        provider: providerOf(row.provider),
        splitReply: row.split_reply === undefined || numOf(row.split_reply) !== 0,
        personaName: textOf(row.persona_name, CHAT_AI_REPLY_PERSONA_NAME_MAX),
        personaPrompt: textOf(row.persona_prompt, CHAT_AI_REPLY_PERSONA_PROMPT_MAX),
        kbEnabled: numOf(row.kb_enabled) === 1,
        kbId: Math.max(0, numOf(row.kb_id)),
        revision: Math.max(0, numOf(row.revision)),
        updatedAt: Math.max(0, numOf(row.updated_at)),
        cursor: textOf(row.cursor, CURSOR_MAX),
      }
  const state: ChatAiReplyState = {
    ...setting,
    accountKey,
    chatUsername,
    chatName: textOf(chatName, NAME_MAX),
    stage: setting.enabled ? stageOf(row?.stage) : 'disabled',
  }
  const pendingCursor = textOf(row?.pending_cursor, CURSOR_MAX)
  if (pendingCursor !== '') state.pendingCursor = pendingCursor
  const pendingSourceRef = textOf(row?.pending_source_ref, 500)
  if (pendingSourceRef !== '') state.pendingSourceRef = pendingSourceRef
  // Only an explicitly tagged, positive revision is trusted. Legacy rows and
  // zero/invalid values must remain indistinguishable to the runner so it can
  // fail closed instead of falling back to the current setting revision.
  const pendingRevisionMarker = textOf(row?.pending_revision_marker, 20)
  const pendingRevision = positiveRevisionOf(row?.pending_revision)
  if (pendingRevisionMarker === PENDING_REVISION_VALID
    && pendingRevision !== undefined) {
    state.pendingRevision = pendingRevision
  }
  const lastRunAt = Math.max(0, numOf(row?.last_run_at))
  if (lastRunAt > 0) state.lastRunAt = lastRunAt
  const recordId = Math.max(0, numOf(row?.record_id))
  if (recordId > 0) state.recordId = recordId
  const error = textOf(row?.error, ERROR_MAX)
  if (error !== '') state.error = error
  return state
}

/**
 * 设置写入会推进 revision，旧任务从这一刻起即失效。同步把仍为 pending 的
 * 消息列表预约标记失败，避免进程恰好在旧 runner 回写前崩溃时留下无人认领的
 * “生成中”记录。dispatching/sent_unconfirmed 不在这里改写，仍按不确定投递处理。
 */
function failSupersededReservation(
  db: DatabaseSync,
  current: SettingRow | undefined,
  reason: string,
  now: number,
): void {
  if (current === undefined) return
  const recordId = Math.max(0, numOf(current.record_id))
  const sourceRef = textOf(current.pending_source_ref, 500)
  if (recordId <= 0 && sourceRef === '') return
  const hasRecords = db.prepare(`SELECT 1 AS ok FROM sqlite_master
    WHERE type = 'table' AND name = 'message_list_records'`).get()
  if (hasRecords === undefined) return
  db.prepare(`UPDATE message_list_records SET
    status = 'failed',
    error = ?,
    note = 'AI 回复 · 设置已变更',
    updated_at = ?
    WHERE source = 'ai_reply' AND status = 'pending'
      AND (
        id = ?
        OR (? <> '' AND (source_ref = ? OR source_ref LIKE ?))
      )`).run(
    textOf(reason, ERROR_MAX),
    now,
    recordId,
    sourceRef,
    sourceRef,
    sourceRef === '' ? '' : sourceRef + ':segment:%',
  )
}

/** 建表；与消息列表同库，可重复调用。 */
export function ensureChatAiReplySchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_ai_reply_settings (
    account_key TEXT NOT NULL,
    chat_username TEXT NOT NULL,
    chat_name TEXT NOT NULL DEFAULT '',
    enabled INTEGER NOT NULL DEFAULT 0,
    provider TEXT NOT NULL DEFAULT 'dsh-wechat-bridge',
    split_reply INTEGER NOT NULL DEFAULT 1,
    persona_name TEXT NOT NULL DEFAULT '',
    persona_prompt TEXT NOT NULL DEFAULT '',
    kb_enabled INTEGER NOT NULL DEFAULT 0,
    kb_id INTEGER NOT NULL DEFAULT 0,
    revision INTEGER NOT NULL DEFAULT 0,
    cursor TEXT NOT NULL DEFAULT '',
    pending_cursor TEXT NOT NULL DEFAULT '',
    pending_source_ref TEXT NOT NULL DEFAULT '',
    pending_revision INTEGER NOT NULL DEFAULT 0,
    pending_revision_marker TEXT NOT NULL DEFAULT '',
    generation_state TEXT NOT NULL DEFAULT '',
    generation_source_ref TEXT NOT NULL DEFAULT '',
    generation_text TEXT NOT NULL DEFAULT '',
    generation_revision INTEGER NOT NULL DEFAULT 0,
    lease_owner TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    lease_fence INTEGER NOT NULL DEFAULT 0,
    stage TEXT NOT NULL DEFAULT 'idle',
    last_run_at INTEGER,
    record_id INTEGER,
    error TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_key, chat_username)
  )`)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chat_ai_reply_enabled
    ON chat_ai_reply_settings(enabled, updated_at DESC)`)
  addColumnIfMissing(
    db,
    'split_reply',
    'ALTER TABLE chat_ai_reply_settings ADD COLUMN split_reply INTEGER NOT NULL DEFAULT 1',
  )
  addColumnIfMissing(
    db,
    'persona_name',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN persona_name TEXT NOT NULL DEFAULT ''",
  )
  addColumnIfMissing(
    db,
    'persona_prompt',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN persona_prompt TEXT NOT NULL DEFAULT ''",
  )
  addColumnIfMissing(
    db,
    'kb_enabled',
    'ALTER TABLE chat_ai_reply_settings ADD COLUMN kb_enabled INTEGER NOT NULL DEFAULT 0',
  )
  addColumnIfMissing(
    db,
    'kb_id',
    'ALTER TABLE chat_ai_reply_settings ADD COLUMN kb_id INTEGER NOT NULL DEFAULT 0',
  )
  addColumnIfMissing(
    db,
    'pending_cursor',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN pending_cursor TEXT NOT NULL DEFAULT ''",
  )
  addColumnIfMissing(
    db,
    'pending_source_ref',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN pending_source_ref TEXT NOT NULL DEFAULT ''",
  )
  addColumnIfMissing(
    db,
    'pending_revision',
    'ALTER TABLE chat_ai_reply_settings ADD COLUMN pending_revision INTEGER NOT NULL DEFAULT 0',
  )
  if (addColumnIfMissing(
    db,
    'pending_revision_marker',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN pending_revision_marker TEXT NOT NULL DEFAULT ''",
  )) {
    // Existing pending rows predate the marker. They are deliberately marked
    // as legacy rather than backfilled from the current revision.
    db.exec(`UPDATE chat_ai_reply_settings SET pending_revision_marker = '${PENDING_REVISION_LEGACY}'
      WHERE pending_cursor <> '' OR pending_source_ref <> ''
        OR record_id IS NOT NULL
        OR stage IN ('generating', 'saving', 'dispatching')`)
  }
  addColumnIfMissing(
    db,
    'generation_state',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN generation_state TEXT NOT NULL DEFAULT ''",
  )
  addColumnIfMissing(
    db,
    'generation_source_ref',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN generation_source_ref TEXT NOT NULL DEFAULT ''",
  )
  addColumnIfMissing(
    db,
    'generation_text',
    "ALTER TABLE chat_ai_reply_settings ADD COLUMN generation_text TEXT NOT NULL DEFAULT ''",
  )
  addColumnIfMissing(
    db,
    'generation_revision',
    'ALTER TABLE chat_ai_reply_settings ADD COLUMN generation_revision INTEGER NOT NULL DEFAULT 0',
  )
  addColumnIfMissing(
    db,
    'lease_owner',
    'ALTER TABLE chat_ai_reply_settings ADD COLUMN lease_owner TEXT',
  )
  addColumnIfMissing(
    db,
    'lease_until',
    'ALTER TABLE chat_ai_reply_settings ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0',
  )
  addColumnIfMissing(
    db,
    'lease_fence',
    'ALTER TABLE chat_ai_reply_settings ADD COLUMN lease_fence INTEGER NOT NULL DEFAULT 0',
  )
}

/** 读取单个会话设置；库不存在/读失败时返回 disabled，不让面板崩掉。 */
export function readChatAiReplyState(
  decryptedDir: string,
  accountKey: string,
  chatUsername: string,
  chatName = '',
): ChatAiReplyState {
  const result = readChatAiReplyStateStrict(
    decryptedDir,
    accountKey,
    chatUsername,
    chatName,
  )
  if (result.ok) return result.state
  const fallback = singleChatIdentity(decryptedDir, chatUsername)
  return stateOf(
    textOf(accountKey, USERNAME_MAX),
    fallback.username,
    isMessageTableHash(chatName) ? fallback.displayName : (chatName || fallback.displayName),
    undefined,
  )
}

export type ChatAiReplyStateReadResult =
  | { ok: true; state: ChatAiReplyState }
  | { ok: false; error: string }

/**
 * 严格读取单个会话设置。
 *
 * runner 不能把临时读失败当成“开关已关闭”：后者会取消已付费生成的结果，
 * 或在恢复时错误收口 pending。展示层仍使用宽容的 readChatAiReplyState。
 */
export function readChatAiReplyStateStrict(
  decryptedDir: string,
  accountKey: string,
  chatUsername: string,
  chatName = '',
): ChatAiReplyStateReadResult {
  const account = textOf(accountKey, USERNAME_MAX)
  const rawUsername = textOf(chatUsername, USERNAME_MAX)
  const canonical = singleChatIdentity(decryptedDir, rawUsername)
  if (canonical.error !== undefined) return { ok: false, error: canonical.error }
  const username = canonical.username
  if (account === '' || username === '') {
    return { ok: true, state: stateOf(account, username, chatName, undefined) }
  }
  if (!storeExists(decryptedDir)) {
    return { ok: true, state: stateOf(account, username, chatName, undefined) }
  }
  try {
    const state = withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureChatAiReplySchema(db)
      const row = db.prepare(`SELECT * FROM chat_ai_reply_settings
        WHERE account_key = ? AND chat_username = ?`).get(account, username) as SettingRow | undefined
      const requestedName = isMessageTableHash(chatName) ? '' : textOf(chatName, NAME_MAX)
      const effectiveName = requestedName
        || textOf(row?.chat_name, NAME_MAX)
        || canonical.displayName
      return stateOf(account, username, effectiveName, row)
    })
    return { ok: true, state }
  } catch (e) {
    return { ok: false, error: 'AI 回复设置读取失败：' + errorText(e) }
  }
}

/**
 * 严格读取所有已开启会话。
 *
 * 没有任务库与读取失败必须可区分：前者可以安全返回空列表，后者若也伪装成
 * 空列表，恢复扫描会把所有 pending AI 预约误判成孤儿。该接口只给后台扫描
 * 使用，不跨会话暴露正文。
 */
export function readEnabledChatAiReplyStates(
  decryptedDir: string,
): ChatAiReplyEnabledStatesReadResult {
  if (!storeExists(decryptedDir)) return { ok: true, states: [] }
  try {
    const states = withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureChatAiReplySchema(db)
      const rows = db.prepare(`SELECT * FROM chat_ai_reply_settings
        WHERE enabled = 1 ORDER BY updated_at DESC`).all() as SettingRow[]
      const out = new Map<string, ChatAiReplyState>()
      for (const row of rows) {
        const chat = singleChatIdentity(
          decryptedDir,
          textOf(row.chat_username, USERNAME_MAX),
        )
        if (chat.error !== undefined || chat.username === '') continue
        const account = textOf(row.account_key, USERNAME_MAX)
        const state = stateOf(
          account,
          chat.username,
          textOf(row.chat_name, NAME_MAX) || chat.displayName,
          row,
        )
        out.set(account + '\u0000' + chat.username, state)
      }
      return [...out.values()]
    })
    return { ok: true, states }
  } catch (e) {
    return { ok: false, error: 'AI 回复设置读取失败：' + errorText(e) }
  }
}

/** 兼容只读调用方；恢复流程必须使用 readEnabledChatAiReplyStates 区分失败。 */
export function listEnabledChatAiReplyStates(decryptedDir: string): ChatAiReplyState[] {
  const result = readEnabledChatAiReplyStates(decryptedDir)
  return result.ok ? result.states : []
}

/** 保存设置；关闭时立即 stage=disabled，避免界面仍显示生成中。 */
export function saveChatAiReplySetting(
  decryptedDir: string,
  input: {
    accountKey: string
    chatUsername: string
    chatName: string
    enabled: boolean
    provider: ChatAiReplyProvider
    /** 省略时保留当前分段设置，避免旧调用方切换开关时改回默认。 */
    splitReply?: boolean
    /** 省略时保留当前人格，避免旧调用方切换开关时清空配置。 */
    personaName?: string
    /** 省略时保留当前人格，避免旧调用方切换开关时清空配置。 */
    personaPrompt?: string
    /** 省略时保留当前知识库设置，避免旧调用方切换开关时改回默认。 */
    kbEnabled?: boolean
    /** 省略时保留当前知识库选择；`kbEnabled` 为 true 时必须大于 0。 */
    kbId?: number
    expectedRevision?: number
    cursor?: string
  },
): ChatAiReplyMutationResult {
  const account = textOf(input.accountKey, USERNAME_MAX)
  const canonical = singleChatIdentity(decryptedDir, input.chatUsername)
  if (canonical.error !== undefined) return { ok: false, error: canonical.error }
  const username = canonical.username
  if (account === '' || username === '') return { ok: false, error: '缺少当前账号或会话' }
  const requestedChatName = textOf(input.chatName, NAME_MAX)
  const chatName = isMessageTableHash(requestedChatName)
    ? canonical.displayName
    : (requestedChatName || canonical.displayName)
  const cursor = textOf(input.cursor, CURSOR_MAX)
  const expected = input.expectedRevision === undefined ? undefined : Math.max(0, numOf(input.expectedRevision))
  mkdirSync(dirname(taskDbPath(decryptedDir)), { recursive: true })
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureChatAiReplySchema(db)
      return writeTx(db, (): ChatAiReplyMutationResult => {
        const current = db.prepare(`SELECT * FROM chat_ai_reply_settings
          WHERE account_key = ? AND chat_username = ?`).get(account, username) as SettingRow | undefined
        const currentRevision = Math.max(0, numOf(current?.revision))
        if (expected !== undefined && expected !== currentRevision) {
          return { ok: false, error: '设置已被其它窗口更新，请刷新后重试' }
        }
        const persona = normalizeChatAiReplyPersona({
          name: input.personaName === undefined ? current?.persona_name : input.personaName,
          prompt: input.personaPrompt === undefined ? current?.persona_prompt : input.personaPrompt,
        })
        const personaName = persona.name
        const personaPrompt = persona.prompt
        const splitReply = input.splitReply === undefined
          ? (current === undefined ? true : numOf(current.split_reply) !== 0)
          : input.splitReply
        const kbEnabled = input.kbEnabled === undefined
          ? (current === undefined ? false : numOf(current.kb_enabled) === 1)
          : input.kbEnabled
        const kbId = input.kbId === undefined
          ? (current === undefined ? 0 : Math.max(0, numOf(current.kb_id)))
          : Math.max(0, numOf(input.kbId))
        if (kbEnabled && kbId <= 0) {
          return { ok: false, error: '请选择参与回复的知识库' }
        }
        const now = Date.now()
        failSupersededReservation(
          db,
          current,
          input.enabled
            ? 'AI 回复设置已变更，旧任务已取消；请按当前配置重新触发'
            : 'AI 回复已关闭，旧任务已取消',
          now,
        )
        const nextRevision = currentRevision + 1
        const stage = input.enabled ? 'idle' : 'disabled'
        const saved = db.prepare(`INSERT INTO chat_ai_reply_settings
          (account_key, chat_username, chat_name, enabled, provider,
           split_reply, persona_name, persona_prompt, kb_enabled, kb_id,
           revision, cursor,
           pending_cursor, pending_source_ref, pending_revision, stage,
           last_run_at, record_id, error, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', 0, ?, NULL, NULL, '', ?)
          ON CONFLICT(account_key, chat_username) DO UPDATE SET
            chat_name = excluded.chat_name,
            enabled = excluded.enabled,
            provider = excluded.provider,
            split_reply = excluded.split_reply,
            persona_name = excluded.persona_name,
            persona_prompt = excluded.persona_prompt,
            kb_enabled = excluded.kb_enabled,
            kb_id = excluded.kb_id,
            revision = excluded.revision,
            cursor = excluded.cursor,
            pending_cursor = '',
            pending_source_ref = '',
            pending_revision = 0,
            pending_revision_marker = '',
            generation_state = '',
            generation_source_ref = '',
            generation_text = '',
            generation_revision = 0,
            lease_owner = NULL,
            lease_until = 0,
            stage = excluded.stage,
            last_run_at = NULL,
            record_id = NULL,
            error = '',
            updated_at = excluded.updated_at`).run(
          account,
          username,
          chatName,
          input.enabled ? 1 : 0,
          providerOf(input.provider),
          splitReply ? 1 : 0,
          personaName,
          personaPrompt,
          kbEnabled ? 1 : 0,
          kbId,
          nextRevision,
          cursor,
          stage,
          now,
        )
        if (Number(saved.changes) !== 1) {
          throw new Error('设置写入未命中当前 revision')
        }
        const row = db.prepare(`SELECT * FROM chat_ai_reply_settings
          WHERE account_key = ? AND chat_username = ?`).get(account, username) as SettingRow | undefined
        return { ok: true, state: stateOf(account, username, chatName, row) }
      })
    })
  } catch (e) {
    return { ok: false, error: 'AI 回复设置保存失败：' + errorText(e) }
  }
}

/**
 * 只更新人格配置，保留开关、provider 与水位。
 *
 * 人格变更同样推进 revision，并复用开关保存的预约失效逻辑；这样旧任务不会
 * 继续用上一版提示词生成或投递。
 */
export function saveChatAiReplyPersona(
  decryptedDir: string,
  input: {
    accountKey: string
    chatUsername: string
    chatName?: string
    personaName: string
    personaPrompt: string
    /** 省略时保留当前设置。 */
    splitReply?: boolean
    /** 省略时保留当前知识库设置。 */
    kbEnabled?: boolean
    /** 省略时保留当前知识库选择；`kbEnabled` 为 true 时必须大于 0。 */
    kbId?: number
    expectedRevision?: number
  },
): ChatAiReplyMutationResult {
  const currentResult = readChatAiReplyStateStrict(
    decryptedDir,
    input.accountKey,
    input.chatUsername,
    input.chatName ?? '',
  )
  if (!currentResult.ok) return { ok: false, error: currentResult.error }
  const current = currentResult.state
  const expectedRevision = input.expectedRevision ?? current.revision
  if (expectedRevision !== current.revision) {
    return { ok: false, error: '设置已被其它窗口更新，请刷新后重试' }
  }
  const persona = normalizeChatAiReplyPersona({
    name: input.personaName,
    prompt: input.personaPrompt,
  })
  const splitReply = input.splitReply ?? current.splitReply
  const kbEnabled = input.kbEnabled ?? current.kbEnabled
  const kbId = input.kbId === undefined
    ? current.kbId
    : Math.max(0, numOf(input.kbId))
  if (kbEnabled && kbId <= 0) {
    return { ok: false, error: '请选择参与回复的知识库' }
  }
  if (
    persona.name === current.personaName
    && persona.prompt === current.personaPrompt
    && splitReply === current.splitReply
    && kbEnabled === current.kbEnabled
    && kbId === current.kbId
  ) {
    return { ok: true, state: current }
  }
  return saveChatAiReplySetting(decryptedDir, {
    accountKey: input.accountKey,
    chatUsername: input.chatUsername,
    chatName: input.chatName ?? current.chatName,
    enabled: current.enabled,
    provider: current.provider,
    splitReply,
    personaName: persona.name,
    personaPrompt: persona.prompt,
    kbEnabled,
    kbId,
    expectedRevision,
    cursor: current.cursor,
  })
}

export type ChatAiReplyRunStateUpdateResult =
  | 'updated'
  | 'guard-mismatch'
  | 'transient'

/**
 * 更新运行状态；仅改执行面，不碰开关与 revision。
 *
 * `transient` 只表示 SQLite 忙/锁，调用方应让出事件循环后重试；不能把它当成
 * owner/fence 失配，否则一次短暂争用就会丢弃已经付费生成的模型结果。
 */
export function updateChatAiReplyRunStateResult(
  decryptedDir: string,
  accountKey: string,
  chatUsername: string,
  patch: {
    stage: ChatAiReplyStage
    cursor?: string
    pendingCursor?: string | null
    pendingSourceRef?: string | null
    pendingRevision?: number | null
    generationState?: '' | 'intent' | 'result'
    generationSourceRef?: string | null
    generationText?: string | null
    generationRevision?: number | null
    lastRunAt?: number
    recordId?: number | null
    error?: string
  },
  guard?: {
    /** 本次执行开始时捕获的 revision；开关变更后旧任务不得覆盖新状态。 */
    revision: number
    /** 带租约的执行面写入；旧 owner/fence 在接管后永远不会命中。 */
    lease?: ChatAiReplyLease
    /** 终态/延后收口时在同一条 UPDATE 中释放租约。 */
    releaseLease?: boolean
  },
): ChatAiReplyRunStateUpdateResult {
  if (!storeExists(decryptedDir)) throw new Error('AI 回复任务库不存在')
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureChatAiReplySchema(db)
      const sets = ['stage = ?', 'updated_at = ?']
      const params: Array<string | number | null> = [patch.stage, Date.now()]
      if (patch.cursor !== undefined) {
        const next = textOf(patch.cursor, CURSOR_MAX)
        const currentRow = db.prepare(`SELECT cursor FROM chat_ai_reply_settings
          WHERE account_key = ? AND chat_username = ?`).get(
          textOf(accountKey, USERNAME_MAX),
          textOf(chatUsername, USERNAME_MAX),
        ) as { cursor?: unknown } | undefined
        // A delayed scan must never overwrite a newer watermark with an old one.
        // Version 2 may supersede a legacy createTime cursor exactly once.
        if (cursorMayAdvance(textOf(currentRow?.cursor, CURSOR_MAX), next)) {
          sets.push('cursor = ?')
          params.push(next)
        }
      }
      if (patch.lastRunAt !== undefined) {
        sets.push('last_run_at = ?')
        params.push(Math.max(0, numOf(patch.lastRunAt)))
      }
      if (patch.pendingCursor !== undefined) {
        sets.push('pending_cursor = ?')
        params.push(patch.pendingCursor === null ? '' : textOf(patch.pendingCursor, CURSOR_MAX))
      }
      if (patch.pendingSourceRef !== undefined) {
        sets.push('pending_source_ref = ?')
        params.push(patch.pendingSourceRef === null ? '' : textOf(patch.pendingSourceRef, 500))
      }
      if (patch.pendingRevision !== undefined) {
        sets.push('pending_revision = ?')
        const revision = patch.pendingRevision === null
          ? undefined
          : positiveRevisionOf(patch.pendingRevision)
        params.push(revision ?? 0)
        sets.push('pending_revision_marker = ?')
        params.push(revision === undefined
          ? (patch.pendingRevision === null ? '' : 'invalid')
          : PENDING_REVISION_VALID)
      }
      if (patch.generationState !== undefined) {
        sets.push('generation_state = ?')
        params.push(patch.generationState)
      }
      if (patch.generationSourceRef !== undefined) {
        sets.push('generation_source_ref = ?')
        params.push(patch.generationSourceRef === null
          ? ''
          : textOf(patch.generationSourceRef, 500))
      }
      if (patch.generationText !== undefined) {
        sets.push('generation_text = ?')
        params.push(patch.generationText === null
          ? ''
          : textOf(patch.generationText, GENERATION_TEXT_MAX))
      }
      if (patch.generationRevision !== undefined) {
        sets.push('generation_revision = ?')
        params.push(patch.generationRevision === null
          ? 0
          : Math.max(0, numOf(patch.generationRevision)))
      }
      if (patch.recordId !== undefined) {
        sets.push('record_id = ?')
        params.push(patch.recordId === null ? null : Math.max(0, numOf(patch.recordId)))
      }
      if (patch.error !== undefined) {
        sets.push('error = ?')
        params.push(textOf(patch.error, ERROR_MAX))
      }
      if (guard?.releaseLease === true) {
        sets.push('lease_owner = NULL', 'lease_until = 0')
      }
      params.push(textOf(accountKey, USERNAME_MAX), textOf(chatUsername, USERNAME_MAX))
      const where = guard === undefined
        ? 'account_key = ? AND chat_username = ?'
        : guard.lease === undefined
          ? 'account_key = ? AND chat_username = ? AND enabled = 1 AND revision = ?'
          : 'account_key = ? AND chat_username = ? AND enabled = 1 AND revision = ?'
            + ' AND lease_owner = ? AND lease_fence = ?'
      if (guard !== undefined) params.push(Math.max(0, numOf(guard.revision)))
      if (guard?.lease !== undefined) {
        params.push(guard.lease.owner, Math.max(0, numOf(guard.lease.fence)))
      }
      const info = db.prepare(`UPDATE chat_ai_reply_settings SET ${sets.join(', ')}
        WHERE ${where}`).run(...params)
      return Number(info.changes) > 0 ? 'updated' : 'guard-mismatch'
    })
  } catch (e) {
    if (isBusyError(e)) return 'transient'
    throw e
  }
}

/** 兼容旧调用：状态写入失败统一降级为 false。 */
export function updateChatAiReplyRunState(
  decryptedDir: string,
  accountKey: string,
  chatUsername: string,
  patch: Parameters<typeof updateChatAiReplyRunStateResult>[3],
  guard?: Parameters<typeof updateChatAiReplyRunStateResult>[4],
): boolean {
  try {
    return updateChatAiReplyRunStateResult(
      decryptedDir,
      accountKey,
      chatUsername,
      patch,
      guard,
    ) === 'updated'
  } catch {
    return false
  }
}

/**
 * 首次建立水位必须与 claim 竞争同一行。
 *
 * 若 claim 先拿到活动租约，本 UPDATE 不命中；若水位先写入，延迟 scan 随后
 * 的 claim 会因 expected.cursor 变化而失败。两种顺序都不会越过新消息。
 */
export function initializeChatAiReplyCursor(
  decryptedDir: string,
  accountKey: string,
  chatUsername: string,
  cursor: string,
  expectedRevision?: number,
): boolean {
  if (!storeExists(decryptedDir)) return false
  const next = textOf(cursor, CURSOR_MAX)
  if (next === '') return false
  try {
    return withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureChatAiReplySchema(db)
      const now = Date.now()
      const info = db.prepare(`UPDATE chat_ai_reply_settings SET
        cursor = ?, updated_at = ?
        WHERE account_key = ? AND chat_username = ?
          AND enabled = 1
          AND (? IS NULL OR revision = ?)
          AND cursor = ''
          AND pending_cursor = ''
          AND pending_source_ref = ''
          AND COALESCE(record_id, 0) = 0
          AND lease_until <= ?`).run(
        next,
        now,
        textOf(accountKey, USERNAME_MAX),
        textOf(chatUsername, USERNAME_MAX),
        expectedRevision === undefined ? null : Math.max(0, numOf(expectedRevision)),
        expectedRevision === undefined ? null : Math.max(0, numOf(expectedRevision)),
        now,
      )
      return Number(info.changes) === 1
    })
  } catch {
    return false
  }
}

/** 模型生成的持久化快照；只返回当前会话当前 pending 对应的生成记录。 */
export interface ChatAiReplyGenerationSnapshot {
  state: string
  text: string
  sourceRef: string
  revision: number
}

/**
 * 读取模型生成意图/结果。
 *
 * 生成意图在调用模型之前写入，结果在模型返回后、补全消息列表之前写入。
 * 这样进程在任意位置重启时都能区分“尚未调用模型”“已经调用但没有结果”和
 * “结果已落盘，只需补全消息列表”。
 */
export function readChatAiReplyGeneration(
  decryptedDir: string,
  accountKey: string,
  chatUsername: string,
): ChatAiReplyGenerationSnapshot | undefined {
  const result = readChatAiReplyGenerationStrict(
    decryptedDir,
    accountKey,
    chatUsername,
  )
  return result.ok ? result.generation : undefined
}

export type ChatAiReplyGenerationReadResult =
  | { ok: true; generation: ChatAiReplyGenerationSnapshot | undefined }
  | { ok: false; error: string }

/**
 * 严格读取生成意图/结果。读取失败与“没有快照”必须可区分，否则恢复器
 * 会把已持久化的模型结果误判为 legacy blank pending 并永久标记失败。
 */
export function readChatAiReplyGenerationStrict(
  decryptedDir: string,
  accountKey: string,
  chatUsername: string,
): ChatAiReplyGenerationReadResult {
  if (!storeExists(decryptedDir)) {
    return { ok: true, generation: undefined }
  }
  try {
    const generation = withWritableDb(taskDbPath(decryptedDir), (db) => {
      ensureChatAiReplySchema(db)
      const row = db.prepare(`SELECT generation_state, generation_source_ref,
        generation_text, generation_revision
        FROM chat_ai_reply_settings WHERE account_key = ? AND chat_username = ?`)
        .get(
          textOf(accountKey, USERNAME_MAX),
          textOf(chatUsername, USERNAME_MAX),
        ) as SettingRow | undefined
      if (row === undefined) return undefined
      return {
        state: textOf(row.generation_state, 20),
        text: textOf(row.generation_text, GENERATION_TEXT_MAX),
        sourceRef: textOf(row.generation_source_ref, 500),
        revision: Math.max(0, numOf(row.generation_revision)),
      }
    })
    return { ok: true, generation }
  } catch (e) {
    return { ok: false, error: 'AI 回复生成快照读取失败：' + errorText(e) }
  }
}
