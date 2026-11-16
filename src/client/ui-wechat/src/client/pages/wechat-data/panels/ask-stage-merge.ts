/**
 * 问答阶段事件的纯合并逻辑。
 *
 * 后端通过 `wechat-ask/stage` 按发生顺序推送阶段事件；工具调用会先推
 * `called/retry`，最后推 `completed/failed/skipped`。网络/IPC/渲染排队都可能让
 * 事件乱序（尤其迟到的 `running`），所以合并必须按调用 id 收敛，而不是简单覆盖。
 *
 * 本模块不依赖 React，`use-ask` 与 `AskProcess` 可共用同一份判据。
 *
 * @module panels/ask-stage-merge
 */

import { askToolNameLabel } from './ask-tool-labels.ts'

/** 工具阶段的前端稳定状态。 */
export type AskStageStatus = 'running' | 'done' | 'failed' | 'skipped'

/** 工具调用阶段（普通流水线阶段不填）。 */
export type AskToolPhase = 'called' | 'completed' | 'failed' | 'retry'

/** 与后端 `wechat-ask/stage` payload 同形的前端阶段。 */
export interface AskStage {
  key: string
  label: string
  status: AskStageStatus
  detail?: string
  round?: number
  phase?: AskToolPhase
  callId?: string
  toolName?: string
  argumentsSummary?: string
  attempt?: number
  maxAttempts?: number
  elapsedMs?: number
  errorClass?: string
  deadlineExceeded?: boolean
  hits?: number
  facts?: number
}

/** 事件里的未知字段先收窄，避免把任意对象直接当 stage 渲染。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function nonNegativeNumber(value: unknown): number | undefined {
  const n = finiteNumber(value)
  return n === undefined ? undefined : Math.max(0, n)
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function statusOf(value: unknown): AskStageStatus | undefined {
  return value === 'running' || value === 'done' || value === 'failed' || value === 'skipped'
    ? value
    : undefined
}

function phaseOf(value: unknown): AskToolPhase | undefined {
  return value === 'called' || value === 'completed' || value === 'failed' || value === 'retry'
    ? value
    : undefined
}

/**
 * 把不可信的后端 payload 归一成 AskStage；缺 key/label 时返回 null。
 * @param value - `wechat-ask/stage` 的 detail（可能缺字段或来自旧后端）。
 * @returns 可直接进时间线的事件，或 null。
 */
export function normalizeAskStage(value: unknown): AskStage | null {
  if (!isRecord(value)) return null
  const key = optionalString(value['key'])
  const label = optionalString(value['label'])
  if (key === undefined || label === undefined) return null
  const status = statusOf(value['status']) ?? 'running'
  const phase = phaseOf(value['phase'])
  const keepFailureDiagnostics = status !== 'done'
  return {
    key,
    label,
    status,
    ...(optionalString(value['detail']) === undefined ? {} : { detail: String(value['detail']) }),
    ...(nonNegativeNumber(value['round']) === undefined
      ? {}
      : { round: nonNegativeNumber(value['round']) }),
    ...(phase === undefined ? {} : { phase }),
    ...(optionalString(value['callId']) === undefined ? {} : { callId: String(value['callId']) }),
    ...(optionalString(value['toolName']) === undefined ? {} : { toolName: String(value['toolName']) }),
    ...(optionalString(value['argumentsSummary']) === undefined
      ? {}
      : { argumentsSummary: String(value['argumentsSummary']) }),
    ...(nonNegativeNumber(value['attempt']) === undefined
      ? {}
      : { attempt: nonNegativeNumber(value['attempt']) }),
    ...(nonNegativeNumber(value['maxAttempts']) === undefined
      ? {}
      : { maxAttempts: nonNegativeNumber(value['maxAttempts']) }),
    ...(nonNegativeNumber(value['elapsedMs']) === undefined
      ? {}
      : { elapsedMs: nonNegativeNumber(value['elapsedMs']) }),
    ...(!keepFailureDiagnostics || optionalString(value['errorClass']) === undefined
      ? {}
      : { errorClass: String(value['errorClass']) }),
    ...(keepFailureDiagnostics && value['deadlineExceeded'] === true ? { deadlineExceeded: true } : {}),
    ...(nonNegativeNumber(value['hits']) === undefined ? {} : { hits: nonNegativeNumber(value['hits']) }),
    ...(nonNegativeNumber(value['facts']) === undefined ? {} : { facts: nonNegativeNumber(value['facts']) }),
  }
}

function terminal(status: AskStageStatus): boolean {
  return status === 'done' || status === 'failed' || status === 'skipped'
}

function attemptOf(stage: AskStage): number {
  return stage.attempt ?? 0
}

/** done/skipped 是成功或安全跳过，不允许后续事件把它们改回运行/失败。 */
function stickyTerminal(status: AskStageStatus): boolean {
  return status === 'done' || status === 'skipped'
}

/** 同一 attempt 内，retry 记录的是该次尝试已经失败，迟到 called 不能覆盖它。 */
function nonTerminalRank(stage: AskStage): number {
  if (stage.phase === 'retry') return 2
  if (stage.phase === 'called') return 1
  return 0
}

function mergeAttempt(previous: AskStage, next: AskStage): Pick<AskStage, 'attempt' | 'maxAttempts'> {
  const attempt = Math.max(previous.attempt ?? 0, next.attempt ?? 0)
  const maxAttempts = Math.max(previous.maxAttempts ?? 0, next.maxAttempts ?? 0)
  return {
    ...(attempt > 0 ? { attempt } : {}),
    ...(maxAttempts > 0 ? { maxAttempts } : {}),
  }
}

function clearFailureDiagnostics(stage: AskStage): AskStage {
  const merged = { ...stage }
  delete merged.errorClass
  delete merged.deadlineExceeded
  return merged
}

/** 保留已有状态，只补稳定元数据与单调字段，供迟到/低 attempt 事件使用。 */
function keepExistingState(previous: AskStage, next: AskStage): AskStage {
  const elapsedMs =
    next.elapsedMs === undefined
      ? previous.elapsedMs
      : Math.max(previous.elapsedMs ?? 0, next.elapsedMs)
  const merged: AskStage = {
    ...previous,
    ...(previous.callId === undefined && next.callId !== undefined ? { callId: next.callId } : {}),
    ...(previous.toolName === undefined && next.toolName !== undefined ? { toolName: next.toolName } : {}),
    ...(previous.argumentsSummary === undefined && next.argumentsSummary !== undefined
      ? { argumentsSummary: next.argumentsSummary }
      : {}),
    ...mergeAttempt(previous, next),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(previous.round === undefined && next.round !== undefined ? { round: next.round } : {}),
  }
  return previous.status === 'done' ? clearFailureDiagnostics(merged) : merged
}

/**
 * 用一个更新的 attempt 状态替换当前状态。
 *
 * detail/error/deadline/hits/facts 都属于单次 attempt；旧值不能因新事件没带
 * 同名字段而继续残留。这与对象展开的“缺字段即继承”语义相反。
 */
function replaceAttemptState(previous: AskStage, next: AskStage): AskStage {
  const elapsedMs =
    next.elapsedMs === undefined
      ? previous.elapsedMs
      : Math.max(previous.elapsedMs ?? 0, next.elapsedMs)
  const merged: AskStage = {
    key: next.key,
    label: next.label,
    status: next.status,
    ...(next.detail === undefined ? {} : { detail: next.detail }),
    ...(next.round === undefined && previous.round !== undefined ? { round: previous.round } : {}),
    ...(next.round === undefined ? {} : { round: next.round }),
    ...(next.phase === undefined ? {} : { phase: next.phase }),
    ...(next.callId === undefined && previous.callId !== undefined ? { callId: previous.callId } : {}),
    ...(next.callId === undefined ? {} : { callId: next.callId }),
    ...(next.toolName === undefined && previous.toolName !== undefined ? { toolName: previous.toolName } : {}),
    ...(next.toolName === undefined ? {} : { toolName: next.toolName }),
    ...(next.argumentsSummary === undefined && previous.argumentsSummary !== undefined
      ? { argumentsSummary: previous.argumentsSummary }
      : {}),
    ...(next.argumentsSummary === undefined ? {} : { argumentsSummary: next.argumentsSummary }),
    ...mergeAttempt(previous, next),
    ...(elapsedMs === undefined ? {} : { elapsedMs }),
    ...(next.errorClass === undefined ? {} : { errorClass: next.errorClass }),
    ...(next.deadlineExceeded === true ? { deadlineExceeded: true } : {}),
    ...(next.hits === undefined ? {} : { hits: next.hits }),
    ...(next.facts === undefined ? {} : { facts: next.facts }),
  }
  return next.status === 'done' ? clearFailureDiagnostics(merged) : merged
}

/**
 * 合并同一阶段的两次事件。
 *
 * 规则：
 *   ① attempt 单调：低 attempt 迟到时只补稳定元数据，不改变状态/诊断字段。
 *   ② done/skipped 终态粘滞；failed 终态只允许更高 attempt 继续推进。
 *   ③ 同 attempt 内先到终态优先，迟到 running 不能把完成/失败改回运行中。
 *   ④ 同一 attempt 内 retry 高于 called，避免迟到 called 抹掉重试失败原因。
 *   ⑤ 新 attempt 独占该次尝试的 detail/error/deadline/hits/facts；最终 done
 *      会清除旧 attempt 留下的 errorClass/deadlineExceeded。
 *
 * @param previous - 已存在的事件（同 key）。
 * @param next - 新到的事件。
 * @returns 合并后的事件。
 */
export function mergeAskStage(previous: AskStage, next: AskStage): AskStage {
  const previousAttempt = attemptOf(previous)
  const nextAttempt = attemptOf(next)
  const previousTerminal = terminal(previous.status)
  const nextTerminal = terminal(next.status)

  if (nextAttempt < previousAttempt) {
    return keepExistingState(previous, next)
  }

  if (nextAttempt > previousAttempt) {
    // 已完成/已跳过不可被更高 attempt 回退；失败则可由下一次尝试越过。
    if (previousTerminal && stickyTerminal(previous.status)) {
      return keepExistingState(previous, next)
    }
    return replaceAttemptState(previous, next)
  }

  // 同 attempt：第一个终态是权威结果，终态之间的迟到事件也不互相改写。
  if (previousTerminal) {
    return keepExistingState(previous, next)
  }

  if (nextTerminal) return replaceAttemptState(previous, next)
  if (nonTerminalRank(next) < nonTerminalRank(previous)) {
    return keepExistingState(previous, next)
  }
  return replaceAttemptState(previous, next)
}

/** 工具卡的身份键：新事件用 callId；旧后端只有 key 时退回 key。 */
export function askStageIdentity(stage: AskStage): string {
  return stage.callId !== undefined && stage.callId !== '' ? `call:${stage.callId}` : `key:${stage.key}`
}

/**
 * 把一条事件并入阶段列表，并保持首次出现顺序。
 * @param stages - 当前列表。
 * @param incoming - 新事件（可以是旧后端 payload）。
 * @returns 新数组；无有效事件时原样返回。
 */
export function appendAskStage(stages: readonly AskStage[], incoming: unknown): AskStage[] {
  const next = normalizeAskStage(incoming)
  if (!next) return stages as AskStage[]
  const id = askStageIdentity(next)
  const at = stages.findIndex(stage => askStageIdentity(stage) === id || stage.key === next.key)
  if (at < 0) return [...stages, next]
  const copy = stages.slice()
  copy[at] = mergeAskStage(copy[at] as AskStage, next)
  return copy
}

/**
 * 把同一次工具调用的事件压缩成一张卡。
 * @param stages - 阶段列表。
 * @returns 保持首次出现顺序的工具阶段（普通流水线阶段不在这里过滤）。
 */
export function toolStages(stages: readonly AskStage[]): AskStage[] {
  return stages.filter(stage => stage.toolName !== undefined || stage.callId !== undefined)
}

/** 判断一个未知 detail 是否是后端阶段事件（用于事件监听器的早退）。 */
export function isAskStageDetail(value: unknown): boolean {
  return isRecord(value) && typeof value['key'] === 'string' && typeof value['label'] === 'string'
}

/** 工具名 → 中文动作；未知工具原样显示。 */
export function askToolLabel(stage: Pick<AskStage, 'toolName' | 'label'>): string {
  const name = stage.toolName ?? stage.label
  return askToolNameLabel(name) ?? name
}

/** 工具卡右侧的状态文案。 */
export function askToolStatusLabel(stage: AskStage): string {
  if (stage.deadlineExceeded === true) return '超时'
  if (stage.status === 'failed') return '失败'
  if (stage.status === 'skipped') return '未执行'
  if (stage.phase === 'retry' || (stage.status === 'running' && (stage.attempt ?? 0) > 1)) return '重试中'
  if (stage.status === 'done') return '完成'
  if (stage.phase === 'called') return '调用中'
  return '运行中'
}

/** 毫秒 → 紧凑耗时；缺省时不显示伪精度。 */
export function formatStageElapsed(ms: number | undefined): string | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined
  if (ms < 1000) return `${String(Math.round(ms))}ms`
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`
}
