/**
 * Single execution timeline shared by WeChat Q&A and session AI Q&A.
 *
 * Tools are the primary rows. The reasoning produced by that round is rendered
 * underneath the tools, so a long thought can never bury the actions that
 * produced it. Legacy runs without round metadata fall back to one trace group
 * with the same "tools first, reasoning second" order.
 */
import { useId, type ReactNode } from 'react'
import { formatStageElapsed, type AskStage } from './ask-stage-merge.ts'
import {
  nodeStatusLabel,
  nodeStatusOf,
  toolStatus,
  type ToolView,
} from './answer-run-view-model.ts'
import type { AskTraceGroup } from './answer-run-trace.ts'
import { ThinkingSection } from './AnswerRunThinking.tsx'
import processCss from './answer-run-process.module.css'

const INTENT_LABELS: Readonly<Record<string, string>> = {
  lookup: '查找具体信息',
  aggregate: '统计与汇总',
  relation: '分析人物关系',
  timeline: '梳理时间线',
  content_media: '查找图片与文件',
  open_qa: '开放问答',
  clarify: '需要补充条件',
}

function readableDetail(stage: AskStage): string | undefined {
  if (stage.key !== 'answer:intent' || stage.detail === undefined) return stage.detail
  return INTENT_LABELS[stage.detail] ?? stage.detail
}

function TracePipelineStage({ stage, closed }: {
  stage: AskStage
  closed: boolean
}): React.JSX.Element {
  const status = nodeStatusOf(stage, closed)
  const elapsed = formatStageElapsed(stage.elapsedMs)
  const detail = readableDetail(stage)
  return (
    <li className={processCss.tracePipelineItem} data-status={status}>
      <span className={processCss.tracePipelineDot} aria-hidden="true" />
      <span className={processCss.tracePipelineName}>{stage.label}</span>
      <span className={processCss.tracePipelineMeta}>
        {[nodeStatusLabel(status), elapsed].filter(Boolean).join(' · ')}
      </span>
      {detail !== undefined && (
        detail.length <= 480 && detail.split('\n').length <= 8
          ? <span className={processCss.tracePipelineDetail}>{detail}</span>
          : (
            <details className={processCss.stageDetails}>
              <summary>查看完整步骤说明（{String(detail.length)} 字）</summary>
              <div className={processCss.stageDetailText}>{detail}</div>
            </details>
          )
      )}
    </li>
  )
}

function groupSummary(group: AskTraceGroup): string {
  const parts = [
    group.tools.length > 0 ? `${String(group.tools.length)} 个工具` : '',
    group.stages.length > 0 ? `${String(group.stages.length)} 个步骤` : '',
    group.reasoning.length > 0 ? '思考' : '',
  ].filter(Boolean)
  return parts.join(' · ')
}

function groupIsLive(group: AskTraceGroup): boolean {
  // Legacy groups have no stage/tool metadata; preserve the single-stream fallback.
  if (group.stages.length === 0 && group.tools.length === 0) return true
  return group.stages.some(stage => nodeStatusOf(stage, false) === 'running')
    || group.tools.some(tool => toolStatus(tool, false) === 'running')
}

export function RunTraceTimeline(input: {
  groups: readonly AskTraceGroup[]
  streaming: boolean
  answerText: string
  /** 当前正在进行的工具轮次；用于在没有 reasoning 增量时给出可见步骤。 */
  activeRound?: number
  liveReasoningKey?: string
  renderTool: (tool: ToolView) => ReactNode
}): React.JSX.Element | null {
  const headingId = useId()
  if (input.groups.length === 0) return null
  return (
    <div className={processCss.traceTimeline}>
      {input.groups.map((group, groupIndex) => {
        const groupHeadingId = `${headingId}-${String(groupIndex)}`
        const reasoning = group.reasoning[0]
        const live = input.streaming
          && input.answerText.trim() === ''
          && groupIsLive(group)
          && group.reasoningKeys.includes(input.liveReasoningKey ?? '')
        /*
         * 模型思考时只发 reasoning 增量；在第一个增量到达前，这一轮在轨迹里
         * 完全没有可见节点，用户会以为步骤丢了。给当前轮补一个占位步骤，
         * 增量到达后由真正的思考区接管。
         */
        const thinkingPending = input.streaming
          && input.answerText.trim() === ''
          && reasoning === undefined
          && input.activeRound !== undefined
          && group.round === input.activeRound
        return (
          <section
            key={group.key}
            className={processCss.traceGroup}
            data-round={group.round}
            data-live={live || undefined}
            aria-labelledby={groupHeadingId}
          >
            <div className={processCss.traceGroupHead}>
              <span className={processCss.traceMarker} aria-hidden="true">
                {group.round !== undefined
                  ? String(group.round).padStart(2, '0')
                  : group.key === 'answer:synthesis' ? '答' : '·'}
              </span>
              <span
                id={groupHeadingId}
                className={processCss.traceGroupTitle}
                role="heading"
                aria-level={3}
              >
                {group.title}
              </span>
              <span className={processCss.traceGroupSummary}>{groupSummary(group)}</span>
            </div>
            {group.stages.length > 0 && (
              <ol className={processCss.tracePipelineList}>
                {group.stages.map(stage => (
                  <TracePipelineStage
                    key={stage.key}
                    stage={stage}
                    closed={!input.streaming}
                  />
                ))}
              </ol>
            )}
            {group.tools.length > 0 && (
              <ol className={processCss.toolList}>
                {group.tools.map(tool => input.renderTool(tool))}
              </ol>
            )}
            {reasoning !== undefined && (
              <ThinkingSection
                key={reasoning.key}
                text={reasoning.text}
                live={live}
                variant="trace"
                label={reasoning.phase === 'synthesis' ? '回答整理思考' : '本轮思考 · 调用前'}
              />
            )}
            {thinkingPending && (
              <div className={processCss.traceThinkingPending} data-live="" role="status">
                <span className={processCss.tracePipelineDot} aria-hidden="true" />
                <span>本轮思考中…</span>
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
