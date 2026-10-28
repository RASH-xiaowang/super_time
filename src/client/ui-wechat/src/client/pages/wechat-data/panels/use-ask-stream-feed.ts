/**
 * 问答运行时的三条流式事件订阅。
 *
 * 每个事件都先按当前 streamId 过滤，避免上一轮迟到增量串入下一轮；
 * 阶段事件同时保留原始时间线与合并后的界面快照。
 */
import { useEffect } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
import { appendAskStage, normalizeAskStage, type AskStage } from './ask-stage-merge.ts'
import type { AskRunTiming } from './ask-run-model.ts'

export function useAskStreamFeed(
  streamIdRef: MutableRefObject<string>,
  setStreamText: Dispatch<SetStateAction<string>>,
  setStreamReasoning: Dispatch<SetStateAction<string>>,
  setStreamStages: Dispatch<SetStateAction<AskStage[]>>,
  streamStageEventsRef: MutableRefObject<AskStage[]>,
  timingRef: MutableRefObject<AskRunTiming>,
): void {
  useEffect(() => {
    const onDelta = (e: Event): void => {
      const d = (e as CustomEvent).detail as { id?: string; text?: string } | null
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
      if (!d || !d.id || d.id !== streamIdRef.current) return
      if (typeof d.text !== 'string') return
      const now = Date.now()
      const timing = timingRef.current
      if (timing.startedAt > 0 && timing.firstReasoningAt === undefined) {
        timing.firstReasoningAt = now
      }
      if (timing.firstReasoningAt !== undefined) timing.reasoningEndedAt = now
      setStreamReasoning(d.text)
    }
    window.addEventListener('dsh-wechat-ask-reasoning', onReasoning)
    return () => { window.removeEventListener('dsh-wechat-ask-reasoning', onReasoning) }
  }, [setStreamReasoning, streamIdRef, timingRef])

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
