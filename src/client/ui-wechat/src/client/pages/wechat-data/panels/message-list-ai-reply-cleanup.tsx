/**
 * 消息列表表头：清理当前已加载窗口里「无正文、无附件、从未投递」的 AI 回复。
 *
 * 只做预览与编排，真正的删除由 `useMessageListAiReplyActions.cleanup` 分批调用
 * `apiDeleteAiReplyReservations`。入口仅在来源筛选为 AI 回复且存在候选时出现；
 * 预览明确写出「仅当前已加载窗口，不是全库」，避免被误读成全库清理。
 */
import { useState } from 'react'
import type { MessageListRecord } from '@deepseek-ai/dsh-wechat-data/types'
import { Button, Dialog } from '../ui/kit.tsx'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import {
  aiReplyDeleteEligibility,
  messageListFailureCopy,
  messageListRecordStatusLabel,
  timeText,
} from './message-list-view.ts'
import css from './message-list-ai-reply-cleanup.module.css'

/** 预览最多列出的行数；更多时补一行「等 N 条」。 */
const CLEANUP_PREVIEW_LIMIT = 20

export interface MessageListAiReplyCleanupProps {
  /** 当前已加载窗口（不是全库）。 */
  records: MessageListRecord[]
  canWrite: boolean
  /** 执行删除；返回 true 时关闭预览。 */
  onCleanup: (records: MessageListRecord[]) => Promise<boolean>
}

function candidateTitle(record: MessageListRecord, now: number): string {
  return record.status === 'failed'
    ? messageListFailureCopy(record).title
    : messageListRecordStatusLabel(record, now)
}

export function MessageListAiReplyCleanup(
  props: MessageListAiReplyCleanupProps,
): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const now = Date.now()
  const candidates = props.records.filter((record) => (
    aiReplyDeleteEligibility(record, now).eligible
  ))
  if (!props.canWrite || candidates.length === 0) return null
  const shown = candidates.slice(0, CLEANUP_PREVIEW_LIMIT)
  const run = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      if (await props.onCleanup(candidates)) setOpen(false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        data-cleanup-ai-reply={String(candidates.length)}
        onClick={() => { setOpen(true) }}
        {...desktopActionProps()}
      >
        清理无正文失败记录 · {String(candidates.length)}（当前窗口）
      </Button>
      {open && (
        <Dialog
          open
          onClose={() => { if (!busy) setOpen(false) }}
          title="清理无正文失败记录"
          footer={(
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => { setOpen(false) }}
              >
                取消
              </Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={() => { void run() }}
              >
                {busy ? '清理中…' : '确认清理 · ' + String(candidates.length)}
              </Button>
            </>
          )}
        >
          <p className={css.lead}>
            仅当前已加载窗口，不是全库。只删除无正文、无附件、从未投递的 AI 回复预约/失败记录；
            生成中的记录不在候选内；删除后不可恢复，但不会删除微信里的原始消息。
          </p>
          <ul className={css.list}>
            {shown.map((record) => (
              <li className={css.row} key={record.id}>
                <code className={css.id}>#{String(record.id)}</code>
                <span className={css.time}>{timeText(record.createdAt)}</span>
                <span className={css.title}>{candidateTitle(record, now)}</span>
              </li>
            ))}
            {candidates.length > shown.length && (
              <li className={css.more}>等 {String(candidates.length)} 条</li>
            )}
          </ul>
        </Dialog>
      )}
    </>
  )
}
