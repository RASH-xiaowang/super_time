/**
 * 「会话运行窗口」的只读快照。
 *
 * 为什么不在 `config-store.ts` 里：那个文件已经贴着 M21 的千行上限，而这里的
 * 逻辑只服务于「删除前确认这一组没有在途生成」，不需要跟着配置读写一起长大。
 *
 * 为什么要接收调用方的连接：专用清理在 `BEGIN IMMEDIATE` 事务里判断运行状态。
 * 若改用 `readChatAiReplyStateStrict`，它会在同一进程另开一条连接并跑 schema
 * 迁移，与事务里的写锁抢 SQLITE_BUSY。这里复用同一个连接，只读三列，不写状态。
 * 读失败必须 fail-closed：宁可拒绝清理，也不能把正在生成的预约删掉。
 */
import type { DatabaseSync } from '../db-open.ts'
import { canonicalChatReference } from '../message-identity.ts'
import type { ChatAiReplyStage } from './types.ts'

const USERNAME_MAX = 255

function textOf(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function numOf(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? Math.trunc(n) : 0
}

function errorText(e: unknown): string {
  const message = (e as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' && message !== '' ? message : String(e)
}

/** 运行窗口三字段；清理面板只关心「这一组是否正被某个未完成的运行占用」。 */
export interface ChatAiReplyRunWindow {
  stage: ChatAiReplyStage
  pendingSourceRef: string
  recordId?: number
}

/**
 * 在调用方**已经持有的连接**上读取运行窗口。
 *
 * 调用方必须先在该连接上跑过 `ensureChatAiReplySchema`（清理事务里只跑一次），
 * 这里不再重复 DDL 探测，避免在写锁事务里反复查 `PRAGMA table_info`。
 * @param db - 调用方持有、已开启事务的连接。
 * @param decryptedDir - 解密目录（用于规范化单聊身份）。
 * @param accountKey - 账号。
 * @param chatUsername - 会话用户名（sourceRef 里记录的原值）。
 * @returns 运行窗口；读失败时返回错误而不是默认值。
 */
export function readChatAiReplyRunWindowOnDb(
  db: DatabaseSync,
  decryptedDir: string,
  accountKey: string,
  chatUsername: string,
): { ok: true, window: ChatAiReplyRunWindow } | { ok: false, error: string } {
  const account = textOf(accountKey, USERNAME_MAX)
  try {
    // 身份解析会读其它库；放在 try 内，单条坏记录只跳过本条，不中止整批。
    const chat = canonicalChatReference(decryptedDir, chatUsername, 'AI 回复会话')
    if (chat.error !== undefined) return { ok: false, error: chat.error }
    const row = db.prepare(`SELECT stage, pending_source_ref, record_id
      FROM chat_ai_reply_settings WHERE account_key = ? AND chat_username = ?`)
      .get(account, chat.username) as {
        stage?: unknown
        pending_source_ref?: unknown
        record_id?: unknown
      } | undefined
    const recordId = numOf(row?.record_id)
    return {
      ok: true,
      window: {
        stage: (textOf(row?.stage, 32) || 'idle') as ChatAiReplyStage,
        pendingSourceRef: textOf(row?.pending_source_ref, 300),
        ...(recordId > 0 ? { recordId } : {}),
      },
    }
  } catch (e) {
    return { ok: false, error: 'AI 回复运行状态读取失败：' + errorText(e) }
  }
}
