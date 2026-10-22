/**
 * 问答的**过程时间线**（2026-10-16 新增）。
 *
 * ## 为什么要有它
 *
 * 用户要的是「像问答产品一样，有工具调用的过程、思考的过程」。改造前：
 *   · 过程信息（意图 / 通道 / 漏斗 / 耗时）**平铺**成两行 chip，没有「过程感」；
 *   · 生成中只有一句静态文案，它不随实际进度变化；
 *   · 完全没有思考过程（后端把 `reasoning-delta` 直接丢了）。
 *
 * 现在：后端在流水线每一步**发生的那一刻**推 `wechat-ask/stage` 事件，
 * 这里把它渲染成一条带状态的时间线（进行中 / 完成 / 跳过 + 结果摘要），
 * 思考内容单独一块可折叠。
 *
 * ## 折叠策略（2026-10-19 微信化反转）
 *
 * 过程是辅助信息，不该默认把正文顶下去 ⇒ **默认折叠成一行**
 * 「已完成 N 步 · 展开」/「检索中…」；用户点开才看时间线与思考。
 * 生成中保留展开入口，但不做强提示（克制动效，去脉冲点）。
 *
 * @module panels/AskProcess
 */
import { useState } from 'react'
import {
  appendAskStage,
  askToolLabel,
  askToolStatusLabel,
  formatStageElapsed,
  toolStages,
  type AskStage,
} from './ask-stage-merge.ts'
import css from './ask.module.css'
import toolCss from './ask-tool-timeline.module.css'

/** 状态 → 右侧的短标记。 */
function statusMark(s: AskStage): string {
  if (s.status === 'running') return '进行中'
  if (s.status === 'failed') return '失败'
  if (s.status === 'skipped') return '已跳过'
  return '完成'
}

function ToolStageCard({ stage, defaultOpen }: {
  stage: AskStage
  defaultOpen: boolean
}): React.JSX.Element {
  // 失败后自动展开；用户一旦手动切换，就以用户选择为准。
  const [manualOpen, setManualOpen] = useState<boolean | null>(null)
  const open = manualOpen ?? defaultOpen
  const elapsed = formatStageElapsed(stage.elapsedMs)
  const attempt = stage.attempt ?? 0
  const maxAttempts = stage.maxAttempts ?? 0
  const meta = [
    attempt > 0
      ? maxAttempts > 0 ? `尝试 ${String(attempt)}/${String(maxAttempts)}` : `尝试 ${String(attempt)} 次`
      : '',
    elapsed === undefined ? '' : `耗时 ${elapsed}`,
    stage.hits === undefined ? '' : `命中 ${String(stage.hits)}`,
    stage.facts !== undefined && stage.facts > 0 ? `事实 ${String(stage.facts)}` : '',
  ].filter(Boolean)
  return (
    <li className={toolCss.toolCard} data-status={stage.status} data-phase={stage.phase}>
      <button
        type="button"
        className={toolCss.toolCardHead}
        onClick={() => { setManualOpen(!open) }}
        aria-expanded={open}
      >
        <span className={toolCss.toolDot} aria-hidden="true" />
        <span className={toolCss.toolTitle}>{askToolLabel(stage)}</span>
        <span className={toolCss.toolStatus}>{askToolStatusLabel(stage)}</span>
        <svg className={toolCss.toolChevron} viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
      </button>
      {meta.length > 0 && <div className={toolCss.toolMeta}>{meta.join(' · ')}</div>}
      {stage.argumentsSummary !== undefined && (
        <div className={toolCss.toolArgs} title={stage.argumentsSummary}>{stage.argumentsSummary}</div>
      )}
      {open && (
        <div className={toolCss.toolCardBody}>
          {stage.detail !== undefined && <div>{stage.detail}</div>}
          {stage.errorClass !== undefined && <div className={toolCss.toolError}>错误分类：{stage.errorClass}</div>}
          {stage.phase !== undefined && <div className={toolCss.toolPhase}>阶段：{stage.phase}</div>}
        </div>
      )}
    </li>
  )
}

/**
 * 渲染过程时间线。
 * @param props.stages - 阶段列表（顺序即执行顺序）。
 * @param props.reasoning - 模型的思考全文（空串 = 没有思考过程，整块不渲染）。
 * @param props.streaming - 是否仍在生成中（只用于摘要文案）。
 * @returns 过程块；没有任何过程信息时返回 null。
 */
export function AskProcess({ stages, reasoning, streaming }: {
  stages?: AskStage[]
  reasoning?: string
  streaming?: boolean
}): React.JSX.Element | null {
  // 对历史轮次也走同一套合并：旧后端没有 failed 时不会被改写成 running，
  // 新后端乱序到达时终态也不会被迟到的 called/retry 覆盖。
  const list = (stages ?? []).reduce<AskStage[]>(
    (acc, stage) => appendAskStage(acc, stage),
    [],
  )
  const think = (reasoning ?? '').trim()
  // 默认折叠：一行「已完成 N 步 · 展开」；用户要看过程时点开。
  const [open, setOpen] = useState(false)
  const [thinkOpen, setThinkOpen] = useState(false)
  if (list.length === 0 && think === '') return null

  const running = list.find(s => s.status === 'running')
  const tools = toolStages(list)
  const pipeline = list.filter(stage => stage.toolName === undefined && stage.callId === undefined)
  const doneCount = pipeline.filter(s => s.status === 'done').length
  const failedCount = list.filter(s => s.status === 'failed' || s.deadlineExceeded === true).length
  // 一行摘要：进行中先说「正在做什么」，否则说「做了几步」。
  const summary = running
    ? `${running.toolName === undefined ? running.label : askToolLabel(running)} · ${askToolStatusLabel(running)}…（展开）`
    : [
      `已完成 ${String(doneCount)} 步`,
      tools.length > 0 ? `${String(tools.length)} 个工具` : '',
      failedCount > 0 ? '有失败' : '',
      think !== '' ? '含思考' : '',
    ].filter(Boolean).join(' · ') + ' · 展开'

  return (
    <div className={css.process} data-streaming={streaming || undefined}>
      <button
        type="button"
        className={css.processHead}
        onClick={() => { setOpen(v => !v) }}
        aria-expanded={open}
        title={open ? '收起过程' : '展开过程'}
      >
        <svg className={css.processChevron} viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        <span className={css.processTitle}>{summary}</span>
      </button>

      {open && (
        <div className={css.processBody}>
          {pipeline.length > 0 && (
            <ol className={css.stageList}>
              {pipeline.map(s => (
                <li key={s.key} className={css.stageRow} data-status={s.status}>
                  <span className={css.stageLabel}>{s.label}</span>
                  <span className={css.stageMark}>{statusMark(s)}</span>
                  {s.detail && <span className={css.stageDetail} title={s.detail}>{s.detail}</span>}
                </li>
              ))}
            </ol>
          )}
          {tools.length > 0 && (
            <ol className={toolCss.toolTimeline} aria-label="工具调用">
              {tools.map(stage => (
                <ToolStageCard
                  key={stage.callId ?? stage.key}
                  stage={stage}
                  defaultOpen={stage.status === 'failed' || stage.deadlineExceeded === true}
                />
              ))}
            </ol>
          )}
          {think !== '' && (
            <div className={css.think}>
              <button
                type="button"
                className={css.thinkHead}
                onClick={() => { setThinkOpen(v => !v) }}
                aria-expanded={thinkOpen}
              >
                <span className={css.thinkTitle}>思考过程</span>
                <span className={css.thinkToggle}>{thinkOpen ? '收起' : '展开'}</span>
              </button>
              {thinkOpen && <div className={css.thinkBody}>{think}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
