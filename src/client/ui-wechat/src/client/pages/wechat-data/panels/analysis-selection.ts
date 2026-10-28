/**
 * 「分析」面板的可选消息与目标定位。
 *
 * 分析只对别人发来的文本/语音有意义：自己的消息没有「判断对方意图」这层需求，
 * 图片、文件等也没有可直接送入本地决策模型的文本。这里把这条口径收成一个纯函数，
 * 既供打开面板时自动选中最近一条消息，也供测试钉住边界。
 */
import type { WechatMessage } from '@deepseek-ai/dsh-wechat-data/types'
import { renderKindOf, type MessageRenderItem } from '../utils/message-items.ts'

/** 右栏分析当前指向哪条消息。带上 talker，避免切换会话时相同 localId 误命中。 */
export interface AnalysisTargetState {
  talker: string
  localId: number
}

/** 这条消息能否做本地决策分析。 */
export function isAnalyzableMessage(message: WechatMessage): boolean {
  if (message.isSender === 1) return false
  const kind = renderKindOf(message)
  return kind === 'text' || kind === 'voice'
}

/** 在渲染项里按 localId 找消息（localId 只在当前会话内唯一）。 */
export function findMessageByLocalId(
  items: readonly MessageRenderItem[],
  localId: number,
): WechatMessage | undefined {
  for (const item of items) {
    if (item.kind === 'msg' && item.m.localId === localId) return item.m
  }
  return undefined
}

/**
 * 当前已加载消息里最近一条可分析消息。
 *
 * 「最近」按消息流顺序取，而不是按时间戳另排：同一毫秒的消息在微信库里并不罕见，
 * 渲染顺序才是用户刚刚看到的顺序。
 */
export function latestAnalyzableMessage(
  items: readonly MessageRenderItem[],
): WechatMessage | undefined {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item?.kind === 'msg' && isAnalyzableMessage(item.m)) return item.m
  }
  return undefined
}
