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
import type { AskStage } from './use-ask.ts'
import css from './ask.module.css'

/** 状态 → 右侧的短标记。 */
function statusMark(s: AskStage): string {
  if (s.status === 'running') return '进行中'
  if (s.status === 'skipped') return '已跳过'
  return '完成'
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
  const list = stages ?? []
  const think = (reasoning ?? '').trim()
  // 默认折叠：一行「已完成 N 步 · 展开」；用户要看过程时点开。
  const [open, setOpen] = useState(false)
  const [thinkOpen, setThinkOpen] = useState(false)
  if (list.length === 0 && think === '') return null

  const doneCount = list.filter(s => s.status === 'done').length
  const running = list.find(s => s.status === 'running')
  // 一行摘要：进行中先说「正在做什么」，否则说「做了几步」。
  const summary = running
    ? `${running.label}…（展开）`
    : `已完成 ${doneCount} 步${think !== '' ? ' · 含思考' : ''} · 展开`

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
          {list.length > 0 && (
            <ol className={css.stageList}>
              {list.map(s => (
                <li key={s.key} className={css.stageRow} data-status={s.status}>
                  <span className={css.stageLabel}>{s.label}</span>
                  <span className={css.stageMark}>{statusMark(s)}</span>
                  {s.detail && <span className={css.stageDetail} title={s.detail}>{s.detail}</span>}
                </li>
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
