/** 消息列表批量重发/探测的远程动作与提示。 */
import { useState } from 'react'
import type {
  MessageListBatchDeleteResult,
  MessageListBatchResendResult,
  MessageListRecord,
} from '@deepseek-ai/dsh-wechat-data/types'
import {
  apiBatchDeleteMessageListRecords,
  apiBatchResendMessageListRecords,
  apiProbeMessageListWebhook,
} from '../api.ts'
import { useConfirm } from '../ui/confirm.tsx'
import type { Notice } from './message-list-view.ts'

/** 重发接口硬限 100 条；删除沿用同一边界，避免一次 IPC 携带整页记录。 */
const MESSAGE_LIST_BATCH_SIZE = 100

type MessageListBatchOutcome<T> =
  | { status: 'accepted'; ids: number[]; result: T }
  | { status: 'failed'; ids: number[]; error: string }

function messageListIdBatches(ids: readonly number[]): number[][] {
  const batches: number[][] = []
  for (let offset = 0; offset < ids.length; offset += MESSAGE_LIST_BATCH_SIZE) {
    batches.push(ids.slice(offset, offset + MESSAGE_LIST_BATCH_SIZE))
  }
  return batches
}

function batchErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message.trim()
  if (error === undefined || error === null) return fallback
  const text = String(error).trim()
  return text === '' || text === '[object Object]' ? fallback : text
}

async function runMessageListBatches<T extends { ok: boolean; error?: string }>(
  ids: readonly number[],
  call: (batchIds: number[]) => Promise<T>,
): Promise<Array<MessageListBatchOutcome<T>>> {
  const outcomes: Array<MessageListBatchOutcome<T>> = []
  for (const batchIds of messageListIdBatches(ids)) {
    try {
      const result = await call(batchIds)
      outcomes.push(result.ok
        ? { status: 'accepted', ids: batchIds, result }
        : {
            status: 'failed',
            ids: batchIds,
            error: result.error?.trim() || '批量接口未返回可读错误',
          })
    } catch (e) {
      outcomes.push({
        status: 'failed',
        ids: batchIds,
        error: batchErrorMessage(e, '批量接口调用失败'),
      })
    }
  }
  return outcomes
}

function batchFailureSuffix(failedBatches: number, failedIds: number): string {
  if (failedBatches === 0) return ''
  return '；' + String(failedBatches) + ' 批接口失败（' + String(failedIds)
    + ' 条无逐条回执）'
}

export function useMessageListBatchActions(input: {
  refreshRecords: () => Promise<void>
  setNotice: (notice: Notice) => void
}) {
  const confirm = useConfirm()
  const [busy, setBusy] = useState(false)

  const batchResend = async (records: MessageListRecord[]): Promise<boolean> => {
    if (busy) return false
    const ids = [...new Set(records.map((record) => record.id))]
    if (ids.length === 0) {
      input.setNotice({ kind: 'warn', text: '请先选择要重发的记录' })
      return false
    }
    const approved = await confirm({
      title: '批量重发 ' + String(ids.length) + ' 条消息？',
      message: '系统会按顺序逐条调用已保存的投递地址；请确认所选记录均为待执行或失败记录。',
      tone: 'danger',
      confirmText: '开始重发',
    })
    if (!approved) return false
    setBusy(true)
    try {
      const outcomes = await runMessageListBatches<MessageListBatchResendResult>(
        ids,
        (batchIds) => apiBatchResendMessageListRecords({ ids: batchIds }),
      )
      let acceptedBatches = 0
      let succeeded = 0
      let failed = 0
      let skipped = 0
      let failedBatches = 0
      let failedIds = 0
      let firstFailure = ''
      for (const outcome of outcomes) {
        if (outcome.status === 'failed') {
          failedBatches += 1
          failedIds += outcome.ids.length
          failed += outcome.ids.length
          firstFailure ||= outcome.error
          continue
        }
        acceptedBatches += 1
        succeeded += outcome.result.succeeded
        failed += outcome.result.failed
        skipped += outcome.result.skipped
        const itemFailure = outcome.result.items.find((item) => (
          item.status !== 'success' && (item.error?.trim() ?? '') !== ''
        ))
        firstFailure ||= itemFailure?.error?.trim() ?? ''
      }
      if (acceptedBatches === 0) {
        input.setNotice({
          kind: 'err',
          text: '批量重发失败：' + (firstFailure || '所有批次均未返回处理结果'),
        })
        return false
      }
      const notice: Notice = {
        kind: failedBatches > 0 ? 'err' : failed > 0 || skipped > 0 ? 'warn' : 'ok',
        text: '批量重发完成：成功 ' + String(succeeded)
          + ' 条，失败 ' + String(failed)
          + ' 条，跳过 ' + String(skipped) + ' 条'
          + batchFailureSuffix(failedBatches, failedIds)
          + (firstFailure === '' ? '' : '；' + firstFailure),
      }
      input.setNotice(notice)
      try {
        await input.refreshRecords()
      } catch (e) {
        input.setNotice({
          kind: 'err',
          text: notice.text + '；列表刷新失败：'
            + batchErrorMessage(e, '未知错误'),
        })
      }
      return true
    } finally {
      setBusy(false)
    }
  }

  const batchProbe = async (records: MessageListRecord[]): Promise<boolean> => {
    if (busy) return false
    const targets = records.filter((record) => record.webhookUrl !== '')
    if (targets.length === 0) {
      input.setNotice({ kind: 'warn', text: '所选记录没有可探测的投递地址' })
      return false
    }
    setBusy(true)
    let succeeded = 0
    let failed = 0
    let firstError = ''
    try {
      for (const target of targets) {
        try {
          const result = await apiProbeMessageListWebhook({ recordId: target.id })
          if (result.ok) {
            succeeded += 1
          } else {
            failed += 1
            firstError ||= result.error ?? ''
          }
        } catch (e) {
          failed += 1
          firstError ||= (e as Error).message
        }
      }
      input.setNotice({
        kind: failed > 0 ? 'warn' : 'ok',
        text: '批量探测完成：正常 ' + String(succeeded)
          + ' 条，失败 ' + String(failed) + ' 条'
          + (firstError === '' ? '' : '；' + firstError),
      })
      return true
    } finally {
      setBusy(false)
    }
  }

  const batchDelete = async (records: MessageListRecord[]): Promise<boolean> => {
    if (busy) return false
    const ids = [...new Set(records.map((record) => record.id))]
    if (ids.length === 0) {
      input.setNotice({ kind: 'warn', text: '请先选择要删除的记录' })
      return false
    }
    const approved = await confirm({
      title: '删除所选 ' + String(ids.length) + ' 条消息记录？',
      message: '删除后不可恢复，但不会删除微信里的原始消息。正在投递的记录会自动跳过；列表序号会按剩余记录重新计算。',
      tone: 'danger',
      confirmText: '批量删除',
    })
    if (!approved) return false
    setBusy(true)
    try {
      const outcomes = await runMessageListBatches<MessageListBatchDeleteResult>(
        ids,
        (batchIds) => apiBatchDeleteMessageListRecords({ ids: batchIds }),
      )
      let acceptedBatches = 0
      let removed = 0
      let skipped = 0
      let failedBatches = 0
      let failedIds = 0
      let firstFailure = ''
      for (const outcome of outcomes) {
        if (outcome.status === 'failed') {
          failedBatches += 1
          failedIds += outcome.ids.length
          firstFailure ||= outcome.error
          continue
        }
        acceptedBatches += 1
        removed += outcome.result.removed
        skipped += outcome.result.skipped
        const itemFailure = outcome.result.items.find((item) => (
          item.status === 'skipped' && (item.error?.trim() ?? '') !== ''
        ))
        firstFailure ||= itemFailure?.error?.trim() ?? ''
      }
      if (acceptedBatches === 0) {
        input.setNotice({
          kind: 'err',
          text: '批量删除失败：' + (firstFailure || '所有批次均未返回处理结果'),
        })
        return false
      }
      const notice: Notice = {
        kind: failedBatches > 0 ? 'err' : skipped > 0 ? 'warn' : 'ok',
        text: '批量删除完成：已删除 ' + String(removed)
          + ' 条，跳过 ' + String(skipped) + ' 条'
          + batchFailureSuffix(failedBatches, failedIds)
          + (firstFailure === '' ? '' : '；' + firstFailure),
      }
      input.setNotice(notice)
      try {
        await input.refreshRecords()
      } catch (e) {
        input.setNotice({
          kind: 'err',
          text: notice.text + '；列表刷新失败：'
            + batchErrorMessage(e, '未知错误'),
        })
      }
      return true
    } finally {
      setBusy(false)
    }
  }

  return { busy, batchResend, batchProbe, batchDelete }
}
