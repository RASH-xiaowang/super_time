/**
 * 会话页里的「选中即分析」控制器。
 *
 * 这里把目标选择、发送者信息、自动选中和单条分析状态收在一处，避免消息流渲染函数
 * 继续承担业务状态。`ChatsView` 只负责把点击事件和面板接到这个控制器上。
 */
import { useCallback, useEffect, useMemo, useRef } from 'react'
import type { WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import type { AnalysisSpeaker } from './ChatAnalysisPanel.tsx'
import {
  findMessageByLocalId,
  isAnalyzableMessage,
  latestAnalyzableMessage,
  type AnalysisTargetState,
} from './analysis-selection.ts'
import {
  useInlineAnalysis,
  type InlineAnalysisApi,
  type InlineAnalysisTarget,
} from './use-inline-analysis.ts'
import type { MessageRenderItem } from '../utils/message-items.ts'

interface ChatsAnalysisOptions {
  curSession: WechatSession | null
  msgItems: MessageRenderItem[]
  analysisPaneOpen: boolean
  analysisTarget: AnalysisTargetState | null
  setAnalysisPaneOpen: React.Dispatch<React.SetStateAction<boolean>>
  setAnalysisTarget: React.Dispatch<React.SetStateAction<AnalysisTargetState | null>>
  setAiOpen: React.Dispatch<React.SetStateAction<boolean>>
  setAiFull: React.Dispatch<React.SetStateAction<boolean>>
  setContactInfoOpen: React.Dispatch<React.SetStateAction<boolean>>
  setGroupInfoOpen: React.Dispatch<React.SetStateAction<boolean>>
}

export interface ChatsAnalysisController {
  selectedLocalId: number | null
  targetMessage?: WechatMessage
  speaker?: AnalysisSpeaker
  inlineAnalysis: InlineAnalysisApi
  openMessageAnalysis: (message: WechatMessage) => void
}

/**
 * 管理当前会话的单条消息分析。
 * @param options - 当前会话、消息流、面板状态和对应 setter。
 * @returns 选中目标、展示信息与分析状态。
 */
export function useChatsAnalysis(options: ChatsAnalysisOptions): ChatsAnalysisController {
  const {
    curSession, msgItems, analysisPaneOpen, analysisTarget,
    setAnalysisPaneOpen, setAnalysisTarget, setAiOpen, setAiFull,
    setContactInfoOpen, setGroupInfoOpen,
  } = options
  const sessionTalker = curSession?.username ?? ''
  /**
   * 当前被分析的那条消息。
   *
   * **面板收起时视为没有选中**：否则关掉右栏之后那一行仍带着高亮（`data-analysis-target`），
   * 右侧却什么都没有，看起来像「点了没反应」。收起有多个入口（点击消息、✕、切到 AI 问答 /
   * 群聊信息 / 聊天信息），逐个去清目标容易漏，所以在这里按面板开关统一收敛。
   */
  const selectedLocalId = analysisPaneOpen
    && analysisTarget !== null
    && analysisTarget.talker === sessionTalker
    ? analysisTarget.localId
    : null
  const targetMessage = useMemo(
    () => selectedLocalId === null ? undefined : findMessageByLocalId(msgItems, selectedLocalId),
    [msgItems, selectedLocalId],
  )
  const analysisHookTarget = useMemo<InlineAnalysisTarget | null>(() => {
    if (!analysisPaneOpen || targetMessage === undefined) return null
    const sortSeq = Number(targetMessage.sortSeq ?? 0)
    return sortSeq > 0 ? { localId: targetMessage.localId, sortSeq } : null
  }, [analysisPaneOpen, targetMessage])
  const inlineAnalysis = useInlineAnalysis({
    talker: sessionTalker,
    target: analysisHookTarget,
  })
  const speaker = useMemo<AnalysisSpeaker | undefined>(() => {
    if (curSession === null || targetMessage === undefined) return undefined
    if (curSession.type !== 'group') {
      return {
        name: curSession.displayName || curSession.username,
        username: curSession.username,
        ...(curSession.enterpriseName ? { enterpriseName: curSession.enterpriseName } : {}),
      }
    }
    return {
      name: targetMessage.senderName || targetMessage.sender || '群成员',
      username: targetMessage.sender || '',
      ...(targetMessage.senderEnterpriseName ? { enterpriseName: targetMessage.senderEnterpriseName } : {}),
    }
  }, [curSession, targetMessage])
  const autoPickedSession = useRef<string | null>(null)

  useEffect(() => {
    if (!analysisPaneOpen) {
      autoPickedSession.current = null
      return
    }
    if (curSession === null || sessionTalker === '') return
    if (selectedLocalId !== null) {
      autoPickedSession.current = sessionTalker
      return
    }
    if (autoPickedSession.current === sessionTalker) return
    const latest = latestAnalyzableMessage(msgItems)
    if (latest === undefined) return
    autoPickedSession.current = sessionTalker
    setAnalysisTarget({ talker: sessionTalker, localId: latest.localId })
  }, [analysisPaneOpen, curSession, msgItems, selectedLocalId, sessionTalker, setAnalysisTarget])

  const openMessageAnalysis = useCallback((message: WechatMessage): void => {
    if (curSession === null || !isAnalyzableMessage(message)) return
    /*
     * 再次点击「已选中且正在展示」的那条：收起面板（与头部「回复助手」按钮同一套开关语义）。
     *
     * 消息行本身就是这条分析的入口，再点一次自然应当是「关掉」，而不是让面板一直占着右栏。
     * 只收起、不清空目标：下次再点同一条会立刻用缓存结果展开（不必重算）。
     * 目标与高亮的失联由 `selectedLocalId` 在面板收起时统一置空来兜住。
     */
    if (analysisPaneOpen && selectedLocalId === message.localId) {
      setAnalysisPaneOpen(false)
      return
    }
    setAiOpen(false)
    setAiFull(false)
    setContactInfoOpen(false)
    setGroupInfoOpen(false)
    setAnalysisPaneOpen(true)
    setAnalysisTarget({ talker: curSession.username, localId: message.localId })
  }, [
    analysisPaneOpen,
    curSession,
    selectedLocalId,
    setAiFull,
    setAiOpen,
    setAnalysisPaneOpen,
    setAnalysisTarget,
    setContactInfoOpen,
    setGroupInfoOpen,
  ])

  return {
    selectedLocalId,
    ...(targetMessage === undefined ? {} : { targetMessage }),
    ...(speaker === undefined ? {} : { speaker }),
    inlineAnalysis,
    openMessageAnalysis,
  }
}
