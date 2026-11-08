/** 消息列表的入站 Webhook 地址复制与局域网监听开关。 */
import { useState } from 'react'
import type { MessageListWebhookInfo } from '@deepseek-ai/dsh-wechat-data/types'
import type { Notice } from './message-list-view.ts'
import { copyTextToClipboard } from '../utils/misc.ts'
import { apiRemoteAccessState, apiToggleRemoteAccess } from '../api.ts'

export function useMessageListWebhookActions(input: {
  refreshWebhookInfo: () => Promise<void>
  setNotice: (notice: Notice) => void
}) {
  const [listeningBusy, setListeningBusy] = useState(false)

  const copyWebhook = async (info: MessageListWebhookInfo | null): Promise<void> => {
    const url = info?.url ?? ''
    if (url === '') return
    if (await copyTextToClipboard(url)) {
      input.setNotice({ kind: 'ok', text: 'Webhook 地址已复制' })
    } else {
      input.setNotice({ kind: 'err', text: '复制失败，请手动选择地址' })
    }
  }

  const toggleListening = async (enabled: boolean): Promise<void> => {
    if (listeningBusy) return
    setListeningBusy(true)
    try {
      if (enabled) {
        const current = await apiRemoteAccessState()
        if (!current.ok) {
          input.setNotice({ kind: 'err', text: current.error?.message ?? '读取监听状态失败' })
          return
        }
        if (!current.value.hasToken) {
          input.setNotice({
            kind: 'warn',
            text: '请先在“设置 → 维护与自检 → 局域网访问（手机）”生成访问令牌',
          })
          return
        }
      }

      const result = await apiToggleRemoteAccess(enabled)
      if (!result.ok) {
        input.setNotice({
          kind: 'err',
          text: result.error?.message ?? (enabled ? '开启监听失败' : '关闭监听失败'),
        })
        return
      }
      await input.refreshWebhookInfo()
      if (enabled && !result.value.running) {
        input.setNotice({ kind: 'warn', text: '配置已开启，但监听未启动，请检查端口占用或局域网地址' })
      } else if (!enabled && result.value.running) {
        input.setNotice({ kind: 'warn', text: '配置已关闭，但监听仍在运行，请稍后重试' })
      } else {
        input.setNotice({
          kind: 'ok',
          text: enabled
            ? '监听已开启，外部 Webhook 与手机局域网访问已生效'
            : '监听已关闭，外部 Webhook 与手机局域网访问已停止',
        })
      }
    } catch (e) {
      input.setNotice({
        kind: 'err',
        text: (enabled ? '开启监听失败：' : '关闭监听失败：') + (e as Error).message,
      })
    } finally {
      setListeningBusy(false)
    }
  }

  return { listeningBusy, copyWebhook, toggleListening }
}
