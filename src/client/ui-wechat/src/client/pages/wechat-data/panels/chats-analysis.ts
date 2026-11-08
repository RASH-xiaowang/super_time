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
  /** 推荐回复占据右栏时，消息区只读；命中后不得切到分析面板。 */
  suggestionInteractionLocked: boolean
  setAnalysisPaneOpen: React.Dispatch<React.SetStateAction<boolean>>
  setAnalysisTarget: React.Dispatch<React.SetStateAction<AnalysisTargetState | null>>
  setAiOpen: React.Dispatch<React.SetStateAction<boolean>>
  setAiFull: React.Dispatch<React.SetStateAction<boolean>>
  setSuggestOpen: React.Dispatch<React.SetStateAction<boolean>>
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
    curSession, msgItems, analysisPaneOpen, analysisTarget, suggestionInteractionLocked,
    setAnalysisPaneOpen, setAnalysisTarget, setAiOpen, setAiFull, setSuggestOpen,
    setContactInfoOpen, setGroupInfoOpen,
  } = options
  const sessionTalker = curSession?.username ?? ''
  const selectedLocalId = analysisTarget !== null && analysisTarget.talker === sessionTalker
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
    if (suggestionInteractionLocked) return
    if (curSession === null || !isAnalyzableMessage(message)) return
    setAiOpen(false)
    setAiFull(false)
    setSuggestOpen(false)
    setContactInfoOpen(false)
    setGroupInfoOpen(false)
    setAnalysisPaneOpen(true)
    setAnalysisTarget({ talker: curSession.username, localId: message.localId })
  }, [
    curSession,
    suggestionInteractionLocked,
    setAiFull,
    setAiOpen,
    setAnalysisPaneOpen,
    setAnalysisTarget,
    setSuggestOpen,
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
