/**
 * 问答运行时的三条流式事件订阅。
 *
 * 每个事件都先按当前 streamId 过滤，避免上一轮迟到增量串入下一轮；
 * 唯一例外是刚停止轮的尾随 reasoning：调用方可通过 `onLateReasoning`
 * 确认归属后把它补回对应 stopped turn。阶段事件同时保留原始时间线与合并后的界面快照。
 */
import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { appendAskStage, normalizeAskStage, type AskStage } from './ask-stage-merge.ts'
import {
  mergeReasoningSegment,
  normalizeAskReasoningSegment,
  type AskReasoningSegment,
} from './answer-run-trace.ts'
import type { AskRunTiming } from './ask-run-model.ts'

export function useAskStreamFeed(
  streamIdRef: MutableRefObject<string>,
  setStreamText: Dispatch<SetStateAction<string>>,
  setStreamReasoning: Dispatch<SetStateAction<string>>,
  setStreamReasoningSegments: Dispatch<SetStateAction<AskReasoningSegment[]>>,
  setStreamStages: Dispatch<SetStateAction<AskStage[]>>,
  streamReasoningSegmentsRef: MutableRefObject<AskReasoningSegment[]>,
  streamStageEventsRef: MutableRefObject<AskStage[]>,
  timingRef: MutableRefObject<AskRunTiming>,
  onLateReasoning?: (runId: string, segment: AskReasoningSegment) => void,
): void {
  useEffect(() => {
    const onDelta = (e: Event): void => {
      const d = (e as CustomEvent).detail as {
        id?: string
        text?: string
        segmentText?: string
        segmentId?: string
        phase?: 'tool_selection' | 'synthesis'
        round?: number
        version?: number
        seq?: number
      } | null
      if (!d || !d.id || d.id !== streamIdRef.current) return
      if (typeof d.text !== 'string') return
      const now = Date.now()
      const timing = timingRef.current
      if (timing.startedAt > 0 && timing.firstTokenAt === undefined) timing.firstTokenAt = now
      if (timing.firstReasoningAt !== undefined && timing.reasoningEndedAt === undefined) {
        timing.reasoningEndedAt = now
      }
      setStreamText(d.text)
    }
    window.addEventListener('dsh-wechat-ask-delta', onDelta)
    return () => { window.removeEventListener('dsh-wechat-ask-delta', onDelta) }
  }, [setStreamText, streamIdRef, timingRef])

  useEffect(() => {
    const onReasoning = (e: Event): void => {
      const d = (e as CustomEvent).detail as { id?: string; text?: string } | null
      if (!d || !d.id) return
      const segment = normalizeAskReasoningSegment(d)
      if (segment === null) return
      if (d.id !== streamIdRef.current) {
        onLateReasoning?.(d.id, segment)
        return
      }
      if (typeof d.text !== 'string') return
      const now = Date.now()
      const timing = timingRef.current
      if (timing.startedAt > 0 && timing.firstReasoningAt === undefined) {
        timing.firstReasoningAt = now
      }
      if (timing.firstReasoningAt !== undefined) timing.reasoningEndedAt = now
      const next = mergeReasoningSegment(streamReasoningSegmentsRef.current, segment)
      streamReasoningSegmentsRef.current = next
      setStreamReasoningSegments(next)
      setStreamReasoning(next.map(item => item.text.trim()).filter(Boolean).join('\n\n'))
    }
    window.addEventListener('dsh-wechat-ask-reasoning', onReasoning)
    return () => { window.removeEventListener('dsh-wechat-ask-reasoning', onReasoning) }
  }, [onLateReasoning, setStreamReasoning, setStreamReasoningSegments, streamIdRef, streamReasoningSegmentsRef, timingRef])

  useEffect(() => {
    const onStage = (e: Event): void => {
      const d = (e as CustomEvent).detail as ({ id?: string } & Record<string, unknown>) | null
      if (!d || !d.id || d.id !== streamIdRef.current) return
      const timing = timingRef.current
      if (
        timing.firstReasoningAt !== undefined
        && timing.reasoningEndedAt === undefined
        && (typeof d['toolName'] === 'string' || typeof d['callId'] === 'string')
      ) {
        timing.reasoningEndedAt = Date.now()
      }
      setStreamStages(prev => appendAskStage(prev, d))
      const normalized = normalizeAskStage(d)
      if (normalized !== null) {
        streamStageEventsRef.current = [...streamStageEventsRef.current, normalized]
      }
    }
    window.addEventListener('dsh-wechat-ask-stage', onStage)
    return () => { window.removeEventListener('dsh-wechat-ask-stage', onStage) }
  }, [setStreamStages, streamIdRef, streamStageEventsRef, timingRef])
}
