import type {
  AnswerReasoningMeta,
  AnswerReasoningSegment,
} from '../query/answer-runtime/types.ts'

type EmitReasoning = (text: string, meta?: AnswerReasoningMeta) => void

export interface AskReasoningCollector {
  readonly segments: AnswerReasoningSegment[]
  onReasoning: EmitReasoning
  text(): string
  snapshot(): AnswerReasoningSegment[]
}

/** 把模型增量整理成稳定分段，并让实时事件与最终结果复用同一份快照。 */
export function createAskReasoningCollector(emitReasoning?: EmitReasoning): AskReasoningCollector {
  let seq = 0
  const segments: AnswerReasoningSegment[] = []
  const byKey = new Map<string, AnswerReasoningSegment>()
  const versionByKey = new Map<string, number>()

  const keyOf = (meta: AnswerReasoningMeta | undefined): string => {
    const phase = meta?.phase ?? 'synthesis'
    return phase === 'tool_selection'
      ? `reasoning:tool:${String(meta?.round ?? 0)}`
      : 'reasoning:synthesis'
  }

  const onReasoning: EmitReasoning = (text, meta) => {
    const phase = meta?.phase ?? 'synthesis'
    const key = keyOf(meta)
    let segment = byKey.get(key)
    const next = meta?.mode === 'delta' ? `${segment?.text ?? ''}${text}` : text
    if (next.trim() === '') return
    if (segment === undefined) {
      segment = {
        key,
        ...(meta?.round === undefined ? {} : { round: meta.round }),
        phase,
        text: '',
        seq: ++seq,
      }
      segments.push(segment)
      byKey.set(key, segment)
    }
    const version = (versionByKey.get(key) ?? 0) + 1
    versionByKey.set(key, version)
    segment.text = next
    segment.version = version
    try {
      emitReasoning?.(next, {
        phase,
        mode: 'snapshot',
        ...(segment.round === undefined ? {} : { round: segment.round }),
        version,
        seq: segment.seq,
      })
    } catch {
      // 思考是主回答链路的旁路，监听器异常不能中断本轮。
    }
  }

  return {
    segments,
    onReasoning,
    text: () => segments.map(segment => segment.text.trim()).filter(Boolean).join('\n\n'),
    snapshot: () => segments.map(segment => ({ ...segment })),
  }
}
