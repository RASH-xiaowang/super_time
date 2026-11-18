/**
 * 消息列表表头：删除当前已加载窗口里的 AI 回复记录。
 *
 * 只做预览与编排，真正的删除由 `useMessageListAiReplyActions.cleanup` 分批调用
 * `apiDeleteAiReplyReservations`。候选包含两类：
 *   · 从未生成正文、从未投递的预约/失败记录（生成半成品）；
 *   · 已经收口的终态记录（成功 / 已发出未确认 / 失败）—— 只清本机台账，
 *     **不会撤回已发出的消息**。
 * 在途状态（生成中、投递中、下游任务未结束）不在候选内。入口仅在来源筛选为
 * AI 回复且存在候选时出现；预览明确写出「仅当前已加载窗口，不是全库」。
 */
import { useState } from 'react'
import type { MessageListRecord } from '@deepseek-ai/dsh-wechat-data/types'
import { Button, Dialog } from '../ui/kit.tsx'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import {
  aiReplyAnyDeleteEligibility,
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

/** 候选里是否含「已收口、且有正文」的记录：确认文案要据此提醒不会撤回消息。 */
function hasTerminalContent(records: readonly MessageListRecord[]): boolean {
  return records.some((record) => (
    record.text.trim() !== '' || record.status === 'sent_unconfirmed' || record.status === 'success'
  ))
}

export function MessageListAiReplyCleanup(
  props: MessageListAiReplyCleanupProps,
): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const now = Date.now()
  // 预约口径（空白）与终态口径取并集：前者是生成半成品，后者是已收口的台账行。
  const candidates = props.records.filter((record) => (
    aiReplyAnyDeleteEligibility(record, now).eligible
  ))
  const blankCount = candidates.filter((record) => (
    aiReplyDeleteEligibility(record, now).eligible
  )).length
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
  const terminalCount = candidates.length - blankCount
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
        删除 AI 回复记录 · {String(candidates.length)}（当前窗口）
      </Button>
      {open && (
        <Dialog
          open
          onClose={() => { if (!busy) setOpen(false) }}
          title="删除 AI 回复记录"
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
                {busy ? '删除中…' : '确认删除 · ' + String(candidates.length)}
              </Button>
            </>
          )}
        >
          <p className={css.lead}>
            仅当前已加载窗口，不是全库。候选是「空白预约/生成失败」与「已收口记录」的并集
            （本次：空白 {String(blankCount)} 条、已收口 {String(terminalCount)} 条）；
            生成中、投递中或下游任务未结束的记录不在候选内。
          </p>
          <p className={css.lead}>
            {hasTerminalContent(candidates)
              ? '删除只清洗本机台账，不会撤回已经发出的微信消息；「已发出未确认」的记录删除后无法再核对结果。删除后不可恢复。'
              : '删除的是从未生成正文、从未投递的预约/失败记录；不会删除微信里的原始消息，删除后不可恢复。'}
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
              <li className={css.more}>等 {String(candidates.length - shown.length)} 条</li>
            )}
          </ul>
        </Dialog>
      )}
    </>
  )
}
