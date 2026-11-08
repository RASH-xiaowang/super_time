import type { Context } from '@deepseek-ai/cordis'
import type {
  AnswerReasoningEmitter,
  AnswerReasoningMeta,
  AnswerRuntimeEmitStage,
} from './query/answer-runtime/types.ts'

const STREAM_ID_MAX = 64
const DELTA_THROTTLE_MS = 80

type AskTextEvent = 'wechat-ask/delta' | 'wechat-ask/reasoning'

function streamIdOf(value: string | undefined): string {
  return typeof value === 'string' ? value.slice(0, STREAM_ID_MAX) : ''
}

function makeThrottledEmitter(
  ctx: Context,
  streamId: string | undefined,
  event: AskTextEvent,
): ((text: string) => void) | undefined {
  const id = streamIdOf(streamId)
  if (id === '') return undefined
  let last = 0
  return (text: string): void => {
    const now = Date.now()
    if (now - last < DELTA_THROTTLE_MS) return
    last = now
    try {
      ctx.emit(event, { id, text })
    } catch {
      // Event delivery is best-effort and must not affect generation.
    }
  }
}

export function makeAskDeltaEmitter(
  ctx: Context,
  streamId?: string,
): ((text: string) => void) | undefined {
  return makeThrottledEmitter(ctx, streamId, 'wechat-ask/delta')
}

export function makeAskReasoningEmitter(
  ctx: Context,
  streamId?: string,
): AnswerReasoningEmitter | undefined {
  const id = streamIdOf(streamId)
  if (id === '') return undefined
  const lastBySegment = new Map<string, number>()
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const segments = new Map<string, {
    text: string
    phase: AnswerReasoningMeta['phase']
    round?: number
    version?: number
    seq?: number
    order: number
  }>()
  let order = 0
  let disposed = false
  const aggregateText = (): string => [...segments.values()]
    .sort((left, right) => {
      if (left.round !== undefined && right.round !== undefined) return left.round - right.round
      if (left.round !== undefined) return -1
      if (right.round !== undefined) return 1
      return left.order - right.order
    })
    .map(segment => segment.text.trim())
    .filter(Boolean)
    .join('\n\n')
  const emitSnapshot = (segmentId: string): void => {
    pendingTimers.delete(segmentId)
    if (disposed) return
    const segment = segments.get(segmentId)
    if (segment === undefined) return
    lastBySegment.set(segmentId, Date.now())
    try {
      ctx.emit('wechat-ask/reasoning', {
        // Keep the legacy aggregate field so old renderers never lose prior
        // rounds; new renderers use segmentText for the current segment.
        id,
        text: aggregateText(),
        segmentText: segment.text,
        segmentId,
        phase: segment.phase,
        ...(segment.round === undefined ? {} : { round: segment.round }),
        ...(segment.version === undefined ? {} : { version: segment.version }),
        ...(segment.seq === undefined ? {} : { seq: segment.seq }),
      })
    } catch {
      // Event delivery is best-effort and must not affect generation.
    }
  }
  const flush = (): void => {
    if (disposed) return
    for (const [segmentId, timer] of [...pendingTimers]) {
      clearTimeout(timer)
      emitSnapshot(segmentId)
    }
  }
  const dispose = (): void => {
    if (disposed) return
    flush()
    disposed = true
    pendingTimers.clear()
    segments.clear()
    lastBySegment.clear()
  }
  const emit = (text: string, meta?: AnswerReasoningMeta): void => {
    if (disposed) return
    const phase = meta?.phase ?? 'synthesis'
    const round = meta?.round
    const version = meta?.version
    const seq = meta?.seq
    const segmentId = phase === 'tool_selection'
      ? `reasoning:tool:${String(round ?? 0)}`
      : 'reasoning:synthesis'
    const previous = segments.get(segmentId)
    const segmentText = meta?.mode === 'delta'
      ? `${previous?.text ?? ''}${text}`
      : text
    if (segmentText.trim() === '') return
    const stale = previous?.version !== undefined
      && (version === undefined || version <= previous.version)
    if (stale) return
    const nextVersion = version ?? previous?.version
    const nextSeq = seq ?? previous?.seq
    segments.set(segmentId, {
      text: segmentText,
      phase,
      ...(round === undefined ? {} : { round }),
      ...(nextVersion === undefined ? {} : { version: nextVersion }),
      ...(nextSeq === undefined ? {} : { seq: nextSeq }),
      order: previous?.order ?? ++order,
    })
    const now = Date.now()
    const last = lastBySegment.get(segmentId) ?? 0
    const wait = DELTA_THROTTLE_MS - (now - last)
    if (wait > 0) {
      if (!pendingTimers.has(segmentId)) {
        pendingTimers.set(segmentId, setTimeout(() => {
          emitSnapshot(segmentId)
        }, wait))
      }
      return
    }
    const pending = pendingTimers.get(segmentId)
    if (pending !== undefined) {
      clearTimeout(pending)
      pendingTimers.delete(segmentId)
    }
    emitSnapshot(segmentId)
  }
  return Object.assign(emit, { flush, dispose })
}

export function makeAskStageEmitter(
  ctx: Context,
  streamId?: string,
): AnswerRuntimeEmitStage | undefined {
  const id = streamIdOf(streamId)
  if (id === '') return undefined
  return (stage): void => {
    try {
      ctx.emit('wechat-ask/stage', { id, ...stage })
    } catch {
      // Event delivery is best-effort and must not affect generation.
    }
  }
}
