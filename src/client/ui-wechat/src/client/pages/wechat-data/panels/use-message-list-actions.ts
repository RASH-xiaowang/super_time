/**
 * 消息列表的写动作与一次性提示。
 *
 * 记录插入与 Webhook 入站都会立刻尝试投递；这里把「已落库但投递失败」和
 * 「根本没有写入」分成两种提示，避免用户误以为一条失败记录不存在。
 */
import { useState } from 'react'
import type {
  MessageListRecord,
  MessageListRule,
  MessageListRuleInput,
  MessageListImage,
} from '@deepseek-ai/dsh-wechat-data/types'
import {
  apiDeleteMessageListRule,
  apiInsertMessageListRecord,
  apiOpenFileDialog,
  apiSaveMessageListRule,
  apiStageMessageListAttachment,
} from '../api.ts'
import { useConfirm } from '../ui/confirm.tsx'
import {
  EMPTY_RECORD_FORM,
  EMPTY_RULE_FORM,
  httpOrDataImages,
  ruleFormForRecord,
  ruleFormFromRule,
  type Notice,
  type RecordForm,
  type RuleForm,
} from './message-list-view.ts'
import { useTransientNotice } from './hooks.tsx'
import { useMessageListBatchActions } from './use-message-list-batch-actions.ts'
import { useMessageListDeliveryActions } from './use-message-list-delivery-actions.ts'
import { useMessageListAiReplyActions } from './use-message-list-ai-reply-actions.ts'
import { useMessageListWebhookActions } from './use-message-list-webhook-actions.ts'

export function useMessageListActions(input: {
  refreshRecords: () => Promise<void>
  refreshRules: () => Promise<void>
  refreshWebhookInfo: () => Promise<void>
}) {
  const confirm = useConfirm()
  const [recordForm, setRecordForm] = useState<RecordForm | null>(null)
  const [ruleForm, setRuleForm] = useState<RuleForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [ruleBusyId, setRuleBusyId] = useState<number | null>(null)
  const { notice, flash: setNotice, clear: clearNotice } = useTransientNotice<Notice>(2000)
  const batchActions = useMessageListBatchActions({
    refreshRecords: input.refreshRecords,
    setNotice,
  })
  const deliveryActions = useMessageListDeliveryActions({
    refreshRecords: input.refreshRecords,
    setNotice,
  })
  const aiReplyActions = useMessageListAiReplyActions({
    refreshRecords: input.refreshRecords,
    setNotice,
  })
  const webhookActions = useMessageListWebhookActions({
    refreshWebhookInfo: input.refreshWebhookInfo,
    setNotice,
  })

  const openRecordForm = (): void => {
    clearNotice()
    setRecordForm({ ...EMPTY_RECORD_FORM })
  }

  const openRuleForm = (rule?: MessageListRule): void => {
    clearNotice()
    setRuleForm(rule === undefined ? { ...EMPTY_RULE_FORM } : ruleFormFromRule(rule))
  }

  /** 记录行「配置规则」：带会话名/触发对象直达表单，已有精确规则则编辑原规则。 */
  const openRuleFormForRecord = (record: MessageListRecord, existing?: MessageListRule): void => {
    clearNotice()
    setRuleForm(ruleFormForRecord(record, existing))
  }

  const submitRecord = async (): Promise<void> => {
    if (recordForm === null) return
    setSaving(true)
    try {
      const result = await apiInsertMessageListRecord({
        chatName: recordForm.chatName,
        targetName: recordForm.targetName,
        text: recordForm.text,
        note: recordForm.note,
        images: [
          ...httpOrDataImages(recordForm.imageUrls),
          ...recordForm.stagedAttachments,
        ].slice(0, 9),
      })
      if (result.record) {
        setRecordForm(null)
        void input.refreshRecords()
        setNotice(result.ok
          ? { kind: 'ok', text: '记录已插入并完成投递' }
          : { kind: 'warn', text: '记录已插入，但投递未完成：' + (result.error ?? '等待规则') })
      } else {
        setNotice({ kind: 'err', text: result.error ?? '记录插入失败' })
      }
    } catch (e) {
      setNotice({ kind: 'err', text: '记录插入失败：' + (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const chooseAttachments = async (): Promise<void> => {
    if (recordForm === null) return
    setSaving(true)
    try {
      const picked = await apiOpenFileDialog({
        title: '选择要发送的附件',
        filters: [
          { name: '附件', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'csv', 'zip', 'rar'] },
          { name: '所有文件', extensions: ['*'] },
        ],
      })
      if (picked.error) {
        setNotice({ kind: 'err', text: '文件选择失败：' + picked.error })
        return
      }
      if (picked.canceled) return
      const remaining = Math.max(0, 9 - recordForm.stagedAttachments.length)
      const files = picked.files.slice(0, remaining)
      const staged: MessageListImage[] = []
      for (const file of files) {
        const result = await apiStageMessageListAttachment({ path: file })
        if (!result.ok || result.attachment === undefined) {
          setNotice({ kind: 'err', text: result.error ?? '附件暂存失败' })
          return
        }
        staged.push(result.attachment)
      }
      if (picked.files.length > files.length) {
        setNotice({ kind: 'warn', text: '单条记录最多 9 个附件，超出部分未加入' })
      }
      setRecordForm((current) => current === null
        ? null
        : { ...current, stagedAttachments: [...current.stagedAttachments, ...staged] })
    } catch (e) {
      setNotice({ kind: 'err', text: '附件选择失败：' + (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const removeStagedAttachment = (stagedId: string): void => {
    setRecordForm((current) => current === null
      ? null
      : {
          ...current,
          stagedAttachments: current.stagedAttachments.filter((attachment) => attachment.stagedId !== stagedId),
        })
  }

  const submitRule = async (): Promise<void> => {
    if (ruleForm === null) return
    setSaving(true)
    try {
      const body: MessageListRuleInput = {
        ...(ruleForm.id === undefined ? {} : { id: ruleForm.id }),
        chatName: ruleForm.chatName,
        targetName: ruleForm.targetName,
        webhookUrl: ruleForm.webhookUrl,
        greetingText: ruleForm.greetingText,
        note: ruleForm.note,
        enabled: ruleForm.enabled,
      }
      const result = await apiSaveMessageListRule(body)
      if (!result.ok) {
        setNotice({ kind: 'err', text: result.error ?? '规则保存失败' })
        return
      }
      setRuleForm(null)
      setNotice({ kind: 'ok', text: '规则已保存' })
      void input.refreshRules()
      void input.refreshRecords()
    } catch (e) {
      setNotice({ kind: 'err', text: '规则保存失败：' + (e as Error).message })
    } finally {
      setSaving(false)
    }
  }

  const toggleRule = async (rule: MessageListRule): Promise<void> => {
    setRuleBusyId(rule.id)
    try {
      const result = await apiSaveMessageListRule({
        id: rule.id,
        chatName: rule.chatName,
        targetName: rule.targetName,
        webhookUrl: rule.webhookUrl,
        greetingText: rule.greetingText,
        note: rule.note,
        enabled: !rule.enabled,
      })
      setNotice(result.ok
        ? { kind: 'ok', text: rule.enabled ? '规则已停用' : '规则已启用' }
        : { kind: 'err', text: result.error ?? '规则更新失败' })
      void input.refreshRules()
    } catch (e) {
      setNotice({ kind: 'err', text: '规则更新失败：' + (e as Error).message })
    } finally {
      setRuleBusyId(null)
    }
  }

  const removeRule = async (rule: MessageListRule): Promise<void> => {
    const ok = await confirm({
      title: '删除这条规则？',
      message: '已有记录保存的地址快照不会被改写；删除后新的触发将不再匹配这条规则。',
      tone: 'danger',
      confirmText: '删除',
    })
    if (!ok) return
    setRuleBusyId(rule.id)
    try {
      const result = await apiDeleteMessageListRule({ id: rule.id })
      setNotice(result.ok ? { kind: 'ok', text: '规则已删除' } : { kind: 'err', text: result.error ?? '删除失败' })
      void input.refreshRules()
    } catch (e) {
      setNotice({ kind: 'err', text: '规则删除失败：' + (e as Error).message })
    } finally {
      setRuleBusyId(null)
    }
  }

  return {
    recordForm,
    setRecordForm,
    ruleForm,
    setRuleForm,
    saving,
    resendingId: deliveryActions.resendingId,
    batchBusy: batchActions.busy,
    ruleBusyId,
    listeningBusy: webhookActions.listeningBusy,
    probeBusyId: deliveryActions.probeBusyId,
    jobBusyId: deliveryActions.jobBusyId,
    notice,
    chooseAttachments,
    removeStagedAttachment,
    openRecordForm,
    openRuleForm,
    openRuleFormForRecord,
    copyWebhook: webhookActions.copyWebhook,
    toggleListening: webhookActions.toggleListening,
    submitRecord,
    submitRule,
    resend: deliveryActions.resend,
    batchResend: batchActions.batchResend,
    batchProbe: batchActions.batchProbe,
    batchDelete: batchActions.batchDelete,
    probeRecord: deliveryActions.probeRecord,
    queryJob: deliveryActions.queryJob,
    regeneratingId: aiReplyActions.regeneratingId,
    deletingAiReplyId: aiReplyActions.deletingAiReplyId,
    regenerateAiReply: aiReplyActions.regenerate,
    deleteAiReplyRecord: aiReplyActions.remove,
    cleanupAiReplyRecords: aiReplyActions.cleanup,
    toggleRule,
    removeRule,
  }
}
