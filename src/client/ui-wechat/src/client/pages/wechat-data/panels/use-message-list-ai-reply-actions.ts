/**
 * 消息列表里 AI 回复专用的两条桌面端动作：重新生成与整组清理。
 *
 * 两者都会再调用模型/销毁台账，属于仅桌面动作：
 *  - 入口按钮由行组件带 `desktopActionProps()` 降级；
 *  - 这里再做一次 `desktopAction()` 防御，避免绕过界面直接调用 hook 时静默出网。
 *
 * 成功后显式刷新列表；API 层还会广播 `MESSAGE_LIST_UPDATED_EVENT`，聊天页的
 * AI 回复状态 hook 监听同一事件，因此「当前会话状态」也会随之回源。
 */
import { useState } from 'react'
import type { MessageListRecord } from '@deepseek-ai/dsh-wechat-data/types'
import {
  apiDeleteAiReplyReservations,
  apiRegenerateChatAiReplyRecord,
} from '../api-chat-ai-reply.ts'
import { useConfirm } from '../ui/confirm.tsx'
import { desktopAction } from '../ui/desktop-only.tsx'
import {
  aiReplyAnyDeleteEligibility,
  aiReplyRegenerateEligibility,
  type Notice,
} from './message-list-view.ts'

/** 后端硬限 100 条/批；超出时按批调用并汇总。 */
export const AI_REPLY_CLEANUP_BATCH_SIZE = 100

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const trimmed = text.trim()
  return trimmed === '' || trimmed === '[object Object]' ? '未知错误' : trimmed
}

function skippedItemError(result: { items?: Array<{ status: string, error?: string }> }): string {
  return result.items?.find((item) => (
    item.status === 'skipped' && (item.error?.trim() ?? '') !== ''
  ))?.error?.trim() ?? ''
}

export function useMessageListAiReplyActions(input: {
  refreshRecords: () => Promise<void>
  setNotice: (notice: Notice) => void
}) {
  const confirm = useConfirm()
  const [regeneratingId, setRegeneratingId] = useState<number | null>(null)
  const [deletingAiReplyId, setDeletingAiReplyId] = useState<number | null>(null)

  const regenerate = async (record: MessageListRecord): Promise<void> => {
    if (desktopAction()) {
      input.setNotice({ kind: 'warn', text: '重新生成仅支持电脑端' })
      return
    }
    const eligibility = aiReplyRegenerateEligibility(record)
    if (!eligibility.eligible) {
      input.setNotice({ kind: 'warn', text: eligibility.reason })
      return
    }
    if ((record.sourceRef ?? '').trim() === '') {
      input.setNotice({ kind: 'err', text: '记录缺少来源引用，无法重新生成' })
      return
    }
    const approved = await confirm({
      title: '重新生成这条 AI 回复？',
      message: '会再调用一次已配置的 AI 模型（可能产生用量），并覆盖这条失败记录，无法撤销。',
      tone: 'danger',
      confirmText: '重新生成',
    })
    if (!approved) return
    setRegeneratingId(record.id)
    try {
      const result = await apiRegenerateChatAiReplyRecord(record.id, record.sourceRef ?? '')
      if (!result.ok) {
        input.setNotice({ kind: 'err', text: '重新生成失败：' + (result.error ?? '未知错误') })
        return
      }
      input.setNotice({ kind: 'ok', text: '已提交重新生成' })
      try {
        await input.refreshRecords()
      } catch (e) {
        input.setNotice({ kind: 'err', text: '已提交重新生成；列表刷新失败：' + errorText(e) })
      }
    } catch (e) {
      input.setNotice({ kind: 'err', text: '重新生成失败：' + errorText(e) })
    } finally {
      setRegeneratingId(null)
    }
  }

  const remove = async (record: MessageListRecord): Promise<void> => {
    if (desktopAction()) {
      input.setNotice({ kind: 'warn', text: '删除 AI 回复记录仅支持电脑端' })
      return
    }
    const eligibility = aiReplyAnyDeleteEligibility(record)
    if (!eligibility.eligible) {
      input.setNotice({ kind: 'warn', text: eligibility.reason })
      return
    }
    const terminal = record.status === 'success'
      || record.status === 'sent_unconfirmed'
      || (record.status === 'failed' && record.text.trim() !== '')
    const approved = await confirm({
      title: '删除这条 AI 回复记录？',
      message: terminal
        ? '只删除本机这条台账记录，**不会撤回已经发出的微信消息**。'
          + '「已发出未确认」的记录删除后将无法再核对结果；记录一旦删除不可恢复。'
        : '只删除无正文、无附件且从未投递的 AI 回复预约/失败记录；删除后不可恢复，不会删除微信里的原始消息。'
          + '生成中的记录会先被拒绝，等这一轮收口或停滞后再试。',
      tone: 'danger',
      confirmText: '删除',
    })
    if (!approved) return
    setDeletingAiReplyId(record.id)
    try {
      const result = await apiDeleteAiReplyReservations([record.id], { includeTerminal: terminal })
      if (!result.ok) {
        input.setNotice({ kind: 'err', text: '删除失败：' + (result.error ?? '未知错误') })
        return
      }
      if (result.removed > 0) {
        input.setNotice({ kind: 'ok', text: '已删除 1 条 AI 回复记录' })
      } else {
        const detail = skippedItemError(result)
        input.setNotice({
          kind: 'warn',
          text: '记录未被删除（已跳过）' + (detail === '' ? '' : '：' + detail),
        })
      }
      try {
        await input.refreshRecords()
      } catch (e) {
        input.setNotice({ kind: 'warn', text: '删除已提交；列表刷新失败：' + errorText(e) })
      }
    } catch (e) {
      input.setNotice({ kind: 'err', text: '删除失败：' + errorText(e) })
    } finally {
      setDeletingAiReplyId(null)
    }
  }

  /**
   * 批量删除预览确认后的执行器：按 100 条分批，汇总删除/跳过数量。
   *
   * 候选里既可能有「空白预约」，也可能有已收口的终态记录，因此统一按
   * `includeTerminal` 调用：后端对空白记录的口径本来就更宽松，放开的只有
   * 已收口那一档，在途状态仍会被逐条跳过。
   * @param records - 预览里确认的候选记录（内部仍会重新校验资格）。
   * @returns 是否至少有一批被后端接受（用于关闭预览）。
   */
  const cleanup = async (records: MessageListRecord[]): Promise<boolean> => {
    if (desktopAction()) {
      input.setNotice({ kind: 'warn', text: '删除 AI 回复记录仅支持电脑端' })
      return false
    }
    const ids = [...new Set(
      records.filter((record) => aiReplyAnyDeleteEligibility(record).eligible)
        .map((record) => record.id),
    )]
    if (ids.length === 0) {
      input.setNotice({ kind: 'warn', text: '当前窗口没有可删除的 AI 回复记录' })
      return false
    }
    let removed = 0
    let skipped = 0
    let acceptedBatches = 0
    let firstError = ''
    for (let offset = 0; offset < ids.length; offset += AI_REPLY_CLEANUP_BATCH_SIZE) {
      const batchIds = ids.slice(offset, offset + AI_REPLY_CLEANUP_BATCH_SIZE)
      try {
        const result = await apiDeleteAiReplyReservations(batchIds, { includeTerminal: true })
        if (!result.ok) {
          skipped += batchIds.length
          firstError ||= result.error?.trim() ?? '清理接口未返回可读错误'
          continue
        }
        acceptedBatches += 1
        removed += result.removed
        skipped += result.skipped
        firstError ||= skippedItemError(result)
      } catch (e) {
        skipped += batchIds.length
        firstError ||= errorText(e)
      }
    }
    const text = '已删除 ' + String(removed) + ' 条，跳过 ' + String(skipped) + ' 条'
      + (firstError === '' ? '' : '；' + firstError)
    input.setNotice({
      kind: acceptedBatches === 0 ? 'err' : (skipped > 0 || firstError !== '' ? 'warn' : 'ok'),
      text,
    })
    if (acceptedBatches > 0) {
      try {
        await input.refreshRecords()
      } catch (e) {
        input.setNotice({ kind: 'err', text: text + '；列表刷新失败：' + errorText(e) })
      }
    }
    return acceptedBatches > 0
  }

  return { regeneratingId, deletingAiReplyId, regenerate, remove, cleanup }
}
