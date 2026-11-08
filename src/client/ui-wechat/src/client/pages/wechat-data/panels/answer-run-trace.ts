/**
 * Normalize and group the answer-run stream into one readable trace.
 *
 * The model emits reasoning and tool stages as two independent streams. A
 * round is the stable boundary we can rely on across both streams, so the UI
 * renders "tool work -> round reasoning" instead of showing one global
 * reasoning block above every tool call.
 */
import type { AskStage } from './ask-stage-merge.ts'
import type { ToolView } from './answer-run-view-model.ts'

export interface AskReasoningSegment {
  key: string
  text: string
  version?: number
  round?: number
  phase?: 'tool_selection' | 'synthesis'
  seq?: number
}

export interface AskTraceGroup {
  key: string
  round?: number
  title: string
  stages: AskStage[]
  tools: ToolView[]
  reasoning: AskReasoningSegment[]
  /** Original segment ids merged into the single visible thought. */
  reasoningKeys: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function roundOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

function seqOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

/** Convert an untrusted stream payload into a stable reasoning segment. */
export function normalizeAskReasoningSegment(value: unknown): AskReasoningSegment | null {
  if (!isRecord(value)) return null
  const segmentText = textOf(value['segmentText'])
  const text = segmentText.trim() === '' ? textOf(value['text']) : segmentText
  if (text.trim() === '') return null
  const round = roundOf(value['round'])
  const phase = value['phase'] === 'tool_selection' || value['phase'] === 'synthesis'
    ? value['phase']
    : undefined
  return {
    key: textOf(value['segmentId'])
      || (phase === 'tool_selection'
        ? `reasoning:tool:${String(round ?? 0)}`
        : 'reasoning:synthesis'),
    text,
    ...(round === undefined ? {} : { round }),
    ...(phase === undefined ? {} : { phase }),
    ...(seqOf(value['version']) === undefined ? {} : { version: seqOf(value['version']) }),
    ...(seqOf(value['seq']) === undefined ? {} : { seq: seqOf(value['seq']) }),
  }
}

/** Upsert a full-text reasoning snapshot; never append duplicate snapshots. */
export function mergeReasoningSegment(
  segments: readonly AskReasoningSegment[],
  incoming: AskReasoningSegment,
): AskReasoningSegment[] {
  const at = segments.findIndex(segment => segment.key === incoming.key)
  if (at < 0) return [...segments, incoming]
  const previous = segments[at]
  if (previous === undefined) return [...segments, incoming]
  const stale = previous.version !== undefined
    && (
      incoming.version === undefined
      || incoming.version < previous.version
      || (incoming.version === previous.version && incoming.text !== previous.text)
    )
  if (stale) return [...segments]
  const copy = segments.slice()
  copy[at] = {
    ...previous,
    ...incoming,
    ...(incoming.round === undefined && previous.round !== undefined
      ? { round: previous.round }
      : {}),
    ...(incoming.phase === undefined && previous.phase !== undefined
      ? { phase: previous.phase }
      : {}),
  }
  return copy
}

function latestReasoning(
  segments: readonly AskReasoningSegment[],
): AskReasoningSegment | undefined {
  return segments.reduce<AskReasoningSegment | undefined>((latest, segment) => {
    if (latest === undefined) return segment
    const latestSeq = latest.seq ?? -1
    const segmentSeq = segment.seq ?? -1
    return segmentSeq >= latestSeq ? segment : latest
  }, undefined)
}

/**
 * Pick the thought that is still being generated from the active run stage,
 * rather than from event arrival order. Late events from an earlier round must
 * not steal the live marker from the current round.
 */
export function liveReasoningKeyOf(
  segments: readonly AskReasoningSegment[],
  stages: readonly AskStage[],
): string | undefined {
  const activeRound = stages.reduce<number | undefined>((latest, stage) => {
    const round = roundOf(stage.round)
    if (round === undefined || stage.status !== 'running') return latest
    return latest === undefined ? round : Math.max(latest, round)
  }, undefined)
  if (activeRound !== undefined) {
    return latestReasoning(
      segments.filter(segment => roundOf(segment.round) === activeRound),
    )?.key
  }
  const synthesizing = stages.some(stage =>
    stage.status === 'running'
    && (stage.key === 'answer:synthesize' || stage.key === 'answer:synthesis'))
  if (synthesizing) {
    const synthesis = latestReasoning(
      segments.filter(segment => segment.phase === 'synthesis'),
    )
    if (synthesis !== undefined) return synthesis.key
  }
  return latestReasoning(segments)?.key
}

/** Render the legacy single reasoning string as one fallback segment. */
export function reasoningSegmentsOf(
  segments: readonly AskReasoningSegment[] | undefined,
  legacyReasoning: string | undefined,
): AskReasoningSegment[] {
  if (segments !== undefined && segments.length > 0) {
    return segments.filter(segment => segment.text.trim() !== '')
  }
  const text = (legacyReasoning ?? '').trim()
  return text === '' ? [] : [{ key: 'reasoning:legacy', text }]
}

function combineThoughtText(left: string, right: string): string {
  const a = left.trim()
  const b = right.trim()
  if (a === '' || a === b) return b
  if (b === '') return a
  if (a.startsWith(b)) return a
  if (b.startsWith(a)) return b
  return `${a}\n\n${b}`
}

function textOrder(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

/**
 * Stable order for multiple segment ids in one round. Server sequence wins;
 * otherwise segment id is the deterministic tie-breaker, independent of the
 * order in which late events happened to arrive.
 */
function reasoningOrder(left: AskReasoningSegment, right: AskReasoningSegment): number {
  if (left.seq !== undefined && right.seq !== undefined && left.seq !== right.seq) {
    return left.seq - right.seq
  }
  if (left.seq !== undefined && right.seq === undefined) return -1
  if (left.seq === undefined && right.seq !== undefined) return 1
  return textOrder(left.key, right.key) || textOrder(left.text, right.text)
}

function mergedReasoningKey(groupKey: string): string {
  return `reasoning:group:${groupKey}`
}

function mergeRoundThought(
  current: AskReasoningSegment,
  incoming: AskReasoningSegment,
  groupKey: string,
): AskReasoningSegment {
  const version = Math.max(current.version ?? 0, incoming.version ?? 0)
  const round = incoming.round ?? current.round
  const phase = incoming.phase ?? current.phase
  const seq = current.seq === undefined
    ? incoming.seq
    : incoming.seq === undefined ? current.seq : Math.max(current.seq, incoming.seq)
  return {
    key: mergedReasoningKey(groupKey),
    text: combineThoughtText(current.text, incoming.text),
    ...(round === undefined ? {} : { round }),
    ...(phase === undefined ? {} : { phase }),
    ...(version > 0 ? { version } : {}),
    ...(seq === undefined ? {} : { seq }),
  }
}

function groupMapKey(round: number | undefined, phase: AskReasoningSegment['phase']): string {
  if (round !== undefined) return `round:${String(round)}`
  if (phase === 'synthesis') return 'answer:synthesis'
  return 'trace:unscoped'
}

function groupTitle(
  key: string,
  round: number | undefined,
  phase: AskReasoningSegment['phase'],
): string {
  if (round !== undefined) return `第 ${String(round)} 轮`
  if (key === 'answer:synthesis' || phase === 'synthesis') return '回答整理'
  if (key === 'answer:verify') return '核对结果'
  if (key === 'trace:post') return '收尾步骤'
  if (key === 'trace:legacy') return '运行思考'
  return '运行步骤'
}

function getGroup(
  groups: Map<string, AskTraceGroup>,
  key: string,
  round: number | undefined,
  phase: AskReasoningSegment['phase'],
): AskTraceGroup {
  const existing = groups.get(key)
  if (existing !== undefined) return existing
  const group: AskTraceGroup = {
    key,
    ...(round === undefined ? {} : { round }),
    title: groupTitle(key, round, phase),
    stages: [],
    tools: [],
    reasoning: [],
    reasoningKeys: [],
  }
  groups.set(key, group)
  return group
}

function pipelineGroupOf(
  stage: AskStage,
  index: number,
  firstRoundIndex: number,
): { key: string; round?: number } {
  const round = roundOf(stage.round)
  if (round !== undefined) return { key: groupMapKey(round, undefined), round }
  if (stage.key === 'answer:synthesize') return { key: 'answer:synthesis' }
  if (stage.key === 'answer:verify') return { key: 'answer:verify' }
  if (firstRoundIndex >= 0 && index > firstRoundIndex) return { key: 'trace:post' }
  return { key: 'trace:unscoped' }
}

/**
 * Build the visual groups in deterministic order:
 * preflight stage -> numbered tool rounds -> synthesis -> verification.
 */
export function traceGroupsOf(input: {
  stages: readonly AskStage[]
  tools: readonly ToolView[]
  reasoning: readonly AskReasoningSegment[]
}): AskTraceGroup[] {
  const groups = new Map<string, AskTraceGroup>()
  const hasStructuredTools = input.tools.length > 0 || input.stages.some(stage =>
    roundOf(stage.round) !== undefined
    || stage.toolName !== undefined
    || stage.callId !== undefined)
  const hasRoundTools = input.tools.some(tool =>
    roundOf(tool.stage?.round ?? tool.trace?.round) !== undefined)
    || input.stages.some(stage =>
      roundOf(stage.round) !== undefined
      && (stage.toolName !== undefined || stage.callId !== undefined))
  const hasNumberedRounds = hasRoundTools || input.stages.some(stage =>
    roundOf(stage.round) !== undefined)
  const firstRoundIndex = input.stages.findIndex(stage => roundOf(stage.round) !== undefined)
  input.stages.forEach((stage, index) => {
    if (stage.toolName !== undefined || stage.callId !== undefined) {
      const round = roundOf(stage.round)
      if (round !== undefined) getGroup(groups, groupMapKey(round, undefined), round, undefined)
      return
    }
    // The generic wrapper is redundant when this run already has per-round tools.
    if (stage.key === 'answer:tools' && hasStructuredTools) return
    // The round header already communicates this boundary; repeating it as a
    // child step adds implementation noise without new information.
    if (hasRoundTools && /^answer:round:\d+$/.test(stage.key)) return
    const target = pipelineGroupOf(stage, index, firstRoundIndex)
    const group = getGroup(groups, target.key, target.round, undefined)
    group.stages.push(stage)
  })
  for (const tool of input.tools) {
    const round = roundOf(tool.stage?.round ?? tool.trace?.round)
    const group = getGroup(groups, groupMapKey(round, undefined), round, undefined)
    group.tools.push(tool)
  }
  const orderedReasoning = [...input.reasoning].sort(
    reasoningOrder,
  )
  for (const segment of orderedReasoning) {
    const round = roundOf(segment.round)
    const unnumberedThought = hasNumberedRounds
      && round === undefined
      && segment.phase !== 'synthesis'
    const key = unnumberedThought ? 'trace:legacy' : groupMapKey(round, segment.phase)
    const group = getGroup(groups, key, round, segment.phase)
    const previous = group.reasoning[0]
    if (previous === undefined) {
      group.reasoning.push({
        ...segment,
        key: mergedReasoningKey(key),
        text: segment.text.trim(),
      })
    } else {
      group.reasoning[0] = mergeRoundThought(previous, segment, key)
    }
    if (!group.reasoningKeys.includes(segment.key)) group.reasoningKeys.push(segment.key)
  }
  return [...groups.values()].sort((left, right) => {
    const rank = (group: AskTraceGroup): number => {
      if (group.key === 'trace:unscoped') return 0
      if (group.round !== undefined) return 1
      if (group.key === 'trace:legacy') return 2
      if (group.key === 'trace:post') return 3
      if (group.key === 'answer:synthesis') return 4
      if (group.key === 'answer:verify') return 5
      return 0
    }
    const rankDiff = rank(left) - rank(right)
    if (rankDiff !== 0) return rankDiff
    if (left.round !== undefined && right.round !== undefined) {
      return left.round - right.round
    }
    return 0
  })
}
