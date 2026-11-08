/**
 * 历史记录里的只读执行轨迹。
 *
 * 复用实时问答的轮次时间线，保证同一份记录在“刚回答完”和“之后从历史打开”
 * 看到的层级一致：工具轮次 → 本轮思考 → 回答整理 → 核对结果。
 * 历史不保存工具参数与结果正文，因此工具行只展示脱敏摘要字段。
 */
import type { AskHistoryRuntimeTrace } from '@deepseek-ai/dsh-wechat-data/types'
import { RunTraceTimeline } from './AnswerRunTrace.tsx'
import {
  formatStageElapsed,
} from './ask-stage-merge.ts'
import {
  toolStatus,
  toolStatusLabel,
  type ToolView,
} from './answer-run-view-model.ts'
import { askHistoryTraceViewOf } from './ask-history-runtime-trace.ts'
import css from './ask-history.module.css'
import processCss from './answer-run-process.module.css'

function HistoryToolRow({ tool }: { tool: ToolView }): React.JSX.Element {
  const status = toolStatus(tool, true)
  const trace = tool.trace
  const stage = tool.stage
  const elapsed = formatStageElapsed(stage?.elapsedMs ?? trace?.elapsedMs)
  const attempts = stage?.attempt ?? trace?.attempts
  const hits = stage?.hits ?? trace?.hits
  const facts = stage?.facts ?? trace?.facts
  const inlineMeta = [
    elapsed === undefined ? '' : `耗时 ${elapsed}`,
    hits === undefined ? '' : `命中 ${String(hits)}`,
    facts === undefined || facts <= 0 ? '' : `事实 ${String(facts)}`,
    attempts !== undefined && attempts > 1 ? `尝试 ${String(attempts)} 次` : '',
    trace?.retries !== undefined && trace.retries > 0 ? `重试 ${String(trace.retries)} 次` : '',
    trace?.deduplicated === true ? '复用缓存' : '',
    stage?.errorClass ?? trace?.errorClass ?? '',
    trace?.errorCode ?? '',
  ].filter((part): part is string => part !== '')
  return (
    <li className={processCss.toolItem} data-status={status}>
      <div className={processCss.toolHead}>
        <span className={processCss.toolName}>{tool.name}</span>
        <span className={processCss.toolStatus}>{toolStatusLabel(tool, true)}</span>
        {inlineMeta.length > 0 && (
          <span className={processCss.toolInlineMeta}>{inlineMeta.join(' · ')}</span>
        )}
      </div>
    </li>
  )
}

/**
 * @param props.trace - 后端保存的有界轨迹。
 * @returns 执行轨迹区块；旧记录没有轨迹时不渲染。
 */
export function AskHistoryRuntimeTraceView({
  trace,
}: {
  trace: AskHistoryRuntimeTrace | undefined
}): React.JSX.Element | null {
  const view = askHistoryTraceViewOf(trace)
  if (view === null) return null
  return (
    <section className={css.runtimeTrace} data-ask-history-trace="">
      <div className={css.traceHead}>
        <span className={css.traceTitle}>执行轨迹</span>
        <span className={css.traceMeta}>
          {[
            `${String(view.groups.length)} 个阶段组`,
            view.toolCallTotal > 0 ? `${String(view.toolCallTotal)} 次工具调用` : '',
          ].filter(Boolean).join(' · ')}
        </span>
      </div>
      {view.truncated && (
        <div className={css.traceNotice} data-truncated="">
          过程记录已按本机存储预算截断
        </div>
      )}
      <RunTraceTimeline
        groups={view.groups}
        streaming={false}
        answerText=""
        renderTool={tool => <HistoryToolRow key={tool.key} tool={tool} />}
      />
    </section>
  )
}
