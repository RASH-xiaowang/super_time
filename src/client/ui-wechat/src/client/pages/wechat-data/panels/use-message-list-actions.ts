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
  MessageListWebhookInfo,
} from '@deepseek-ai/dsh-wechat-data/types'
import {
  apiDeleteMessageListRule,
  apiInsertMessageListRecord,
  apiResendMessageListRecord,
  apiSaveMessageListRule,
} from '../api.ts'
import { useConfirm } from '../ui/confirm.tsx'
import {
  EMPTY_RECORD_FORM,
  EMPTY_RULE_FORM,
  httpOrDataImages,
  type Notice,
  type RecordForm,
  type RuleForm,
} from './message-list-view.ts'

export function useMessageListActions(input: {
  refreshRecords: () => Promise<void>
  refreshRules: () => Promise<void>
  refreshWebhookInfo: () => Promise<void>
}) {
  const confirm = useConfirm()
  const [recordForm, setRecordForm] = useState<RecordForm | null>(null)
  const [ruleForm, setRuleForm] = useState<RuleForm | null>(null)
  const [saving, setSaving] = useState(false)
  const [resendingId, setResendingId] = useState<number | null>(null)
  const [ruleBusyId, setRuleBusyId] = useState<number | null>(null)
  const [listeningBusy, setListeningBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  const openRecordForm = (): void => {
    setNotice(null)
    setRecordForm({ ...EMPTY_RECORD_FORM })
  }

  const openRuleForm = (rule?: MessageListRule): void => {
    setNotice(null)
    setRuleForm(rule === undefined
      ? { ...EMPTY_RULE_FORM }
      : {
          id: rule.id,
          chatName: rule.chatName,
          targetName: rule.targetName,
          webhookUrl: rule.webhookUrl,
          greetingText: rule.greetingText || '你好',
          note: rule.note,
          enabled: rule.enabled,
        })
  }

  const copyWebhook = async (info: MessageListWebhookInfo | null): Promise<void> => {
    const url = info?.url ?? ''
    if (url === '') return
    try {
      await navigator.clipboard.writeText(url)
      setNotice({ kind: 'ok', text: 'Webhook 地址已复制' })
    } catch {
      setNotice({ kind: 'err', text: '复制失败，请手动选择地址' })
    }
  }

  const toggleListening = async (enabled: boolean): Promise<void> => {
    if (listeningBusy) return
    const bridge = typeof window === 'undefined' ? undefined : window.electronAPI?.remoteAccess
    if (!bridge) {
      setNotice({ kind: 'err', text: '当前环境无法控制监听，请使用桌面端操作' })
      return
    }
    setListeningBusy(true)
    try {
      if (enabled) {
        const current = await bridge.state()
        if (!current.ok) {
          setNotice({ kind: 'err', text: current.error?.message ?? '读取监听状态失败' })
          return
        }
        if (!current.value.hasToken) {
          setNotice({
            kind: 'warn',
            text: '请先在“设置 → 维护与自检 → 局域网访问（手机）”生成访问令牌',
          })
          return
        }
      }

      const result = await bridge.toggle(enabled)
      if (!result.ok) {
        setNotice({ kind: 'err', text: result.error?.message ?? (enabled ? '开启监听失败' : '关闭监听失败') })
        return
      }
      await input.refreshWebhookInfo()
      if (enabled && !result.value.running) {
        setNotice({ kind: 'warn', text: '配置已开启，但监听未启动，请检查端口占用或局域网地址' })
      } else if (!enabled && result.value.running) {
        setNotice({ kind: 'warn', text: '配置已关闭，但监听仍在运行，请稍后重试' })
      } else {
        setNotice({
          kind: 'ok',
          text: enabled
            ? '监听已开启，外部 Webhook 与手机局域网访问已生效'
            : '监听已关闭，外部 Webhook 与手机局域网访问已停止',
        })
      }
    } catch (e) {
      setNotice({ kind: 'err', text: (enabled ? '开启监听失败：' : '关闭监听失败：') + (e as Error).message })
    } finally {
      setListeningBusy(false)
    }
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
        images: httpOrDataImages(recordForm.imageUrls),
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

  const resend = async (record: MessageListRecord): Promise<void> => {
    setResendingId(record.id)
    try {
      const result = await apiResendMessageListRecord({ id: record.id })
      setNotice(result.ok
        ? { kind: 'ok', text: '回复 ' + String(record.id) + ' 已重发成功' }
        : { kind: 'err', text: '重发失败：' + (result.error ?? '未知错误') })
      void input.refreshRecords()
    } catch (e) {
      setNotice({ kind: 'err', text: '重发失败：' + (e as Error).message })
    } finally {
      setResendingId(null)
    }
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
    resendingId,
    ruleBusyId,
    listeningBusy,
    notice,
    openRecordForm,
    openRuleForm,
    copyWebhook,
    toggleListening,
    submitRecord,
    submitRule,
    resend,
    toggleRule,
    removeRule,
  }
}
