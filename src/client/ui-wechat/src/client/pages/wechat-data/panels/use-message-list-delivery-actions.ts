/** 消息列表单条重发、探测与下游任务查询。 */
import { useState } from 'react'
import type { MessageListRecord } from '@deepseek-ai/dsh-wechat-data/types'
import {
  apiProbeMessageListWebhook,
  apiQueryMessageListWebhookJob,
  apiResendMessageListRecord,
} from '../api.ts'
import { useConfirm } from '../ui/confirm.tsx'
import type { Notice } from './message-list-view.ts'

export function useMessageListDeliveryActions(input: {
  refreshRecords: () => Promise<void>
  setNotice: (notice: Notice) => void
}) {
  const confirm = useConfirm()
  const [resendingId, setResendingId] = useState<number | null>(null)
  const [probeBusyId, setProbeBusyId] = useState<number | null>(null)
  const [jobBusyId, setJobBusyId] = useState<number | null>(null)

  const resend = async (record: MessageListRecord): Promise<void> => {
    if (record.status === 'sent_unconfirmed') {
      const ok = await confirm({
        title: '确认已核对下游结果？',
        message: '这条记录可能已被下游受理，但本地未收到可确认的完成回写。请先在微信侧核对是否已发送；确认未发送后再重发，避免重复消息。',
        tone: 'danger',
        confirmText: '已核对，确认重发',
      })
      if (!ok) return
    }
    setResendingId(record.id)
    try {
      const result = await apiResendMessageListRecord({ id: record.id })
      input.setNotice(result.ok
        ? { kind: 'ok', text: '回复 ' + String(record.id) + ' 已重发成功' }
        : { kind: 'err', text: '重发失败：' + (result.error ?? '未知错误') })
      void input.refreshRecords()
    } catch (e) {
      input.setNotice({ kind: 'err', text: '重发失败：' + (e as Error).message })
    } finally {
      setResendingId(null)
    }
  }

  const probeRecord = async (record: MessageListRecord): Promise<void> => {
    setProbeBusyId(record.id)
    try {
      const result = await apiProbeMessageListWebhook({ recordId: record.id })
      if (!result.ok) {
        input.setNotice({ kind: 'err', text: '连接探测失败：' + (result.error ?? '未知错误') })
        return
      }
      const details = [
        result.status === undefined ? '' : 'HTTP ' + String(result.status),
        result.service ?? '',
        result.version ?? '',
      ].filter((part) => part !== '').join(' · ')
      input.setNotice({
        kind: 'ok',
        text: '连接正常' + (details === '' ? '' : '：' + details),
      })
    } catch (e) {
      input.setNotice({ kind: 'err', text: '连接探测失败：' + (e as Error).message })
    } finally {
      setProbeBusyId(null)
    }
  }

  const queryJob = async (record: MessageListRecord): Promise<void> => {
    setJobBusyId(record.id)
    try {
      const result = await apiQueryMessageListWebhookJob({ recordId: record.id })
      if (!result.ok) {
        input.setNotice({ kind: 'err', text: '任务查询失败：' + (result.error ?? '未知错误') })
        return
      }
      const details = [
        result.state === undefined ? '' : '状态 ' + result.state,
        result.sentCount === undefined ? '' : '已发送 ' + String(result.sentCount),
        result.contentVerified === undefined
          ? ''
          : (result.contentVerified ? '内容已校验' : '内容未校验'),
      ].filter((part) => part !== '').join(' · ')
      input.setNotice({ kind: 'ok', text: '任务已查询' + (details === '' ? '' : '：' + details) })
      void input.refreshRecords()
    } catch (e) {
      input.setNotice({ kind: 'err', text: '任务查询失败：' + (e as Error).message })
    } finally {
      setJobBusyId(null)
    }
  }

  return { resendingId, probeBusyId, jobBusyId, resend, probeRecord, queryJob }
}
