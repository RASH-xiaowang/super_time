/**
 * 消息记录详情里的「回复过程」。
 *
 * 只展示本机留痕：本轮实际送进模型的上下文、知识库命中、提示词、模型输出与
 * 各阶段耗时。所有长文本都塞进可折叠的 `<details>` 并限高滚动 —— 抽屉本身
 * 宽度有限，一次性铺开会把其它字段挤到看不见。
 *
 * 数据只在打开抽屉时按 recordId 读一次；旧记录没有留痕就如实说明，不报错。
 */
import { useEffect, useState } from 'react'
import {
  apiGetChatAiReplyTrace,
  type ChatAiReplyTraceRead,
  type ChatAiReplyTraceView,
} from '../api-chat-ai-reply.ts'
import css from './message-list-detail.module.css'

/** 阶段名的中文说明；未知阶段原样显示，便于后端加阶段时不用同步改前端。 */
const STAGE_LABEL: Record<string, string> = {
  reserved: '已预约台账',
  context: '上下文装配完成',
  generated: '模型已生成',
  generate_failed: '生成失败',
  saved: '已写入消息列表',
  success: '投递成功',
  failed: '本轮失败',
}

function timeTextOf(value: number): string {
  if (!Number.isSafeInteger(value) || value <= 0) return '—'
  const date = new Date(value)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return String(date.getFullYear()) + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
}

function durationText(trace: ChatAiReplyTraceView): string {
  if (trace.startedAt <= 0 || trace.finishedAt <= 0) return '—'
  const ms = trace.finishedAt - trace.startedAt
  if (ms < 0) return '—'
  return ms < 1000 ? String(ms) + ' ms' : (ms / 1000).toFixed(1) + ' s'
}

function TextBlock(props: {
  title: string
  value: string
  /** 默认展开：上下文与输出是主要排查对象。 */
  open?: boolean
  empty?: string
}): React.JSX.Element {
  const value = props.value.trim() === '' ? (props.empty ?? '—') : props.value
  const empty = props.value.trim() === ''
  return (
    <details className={css.traceBlock} open={props.open === true && !empty}>
      <summary className={css.traceSummary}>
        {props.title}
        <span className={css.traceCount}>
          {empty ? '无' : String(props.value.length) + ' 字'}
        </span>
      </summary>
      <pre className={css.tracePre} data-empty={empty ? 'true' : undefined}>{value}</pre>
    </details>
  )
}

function TraceBody(props: { trace: ChatAiReplyTraceView }): React.JSX.Element {
  const { trace } = props
  return (
    <div className={css.trace}>
      <dl className={css.traceMeta}>
        <div className={css.idRow}>
          <dt className={css.itemLabel}>模型</dt>
          <dd className={css.itemValue}>{trace.model === '' ? '未记录' : trace.model}</dd>
        </div>
        <div className={css.idRow}>
          <dt className={css.itemLabel}>耗时</dt>
          <dd className={css.itemValue}>{durationText(trace)}</dd>
        </div>
        <div className={css.idRow}>
          <dt className={css.itemLabel}>视觉 / 语音</dt>
          <dd className={css.itemValue}>
            {String(trace.imageCount)} 张图片 · {String(trace.voiceCount)} 条语音转写
          </dd>
        </div>
        {trace.redacted && (
          <div className={css.idRow}>
            <dt className={css.itemLabel}>隐私闸</dt>
            <dd className={css.itemValue}>提示词已脱敏（下面是实际发出的版本）</dd>
          </div>
        )}
      </dl>

      {trace.stages.length > 0 && (
        <ol className={css.traceStages}>
          {trace.stages.map((stage, index) => (
            <li className={css.traceStage} key={String(index)}>
              <span className={css.traceStageTime}>{timeTextOf(stage.at)}</span>
              <span className={css.traceStageName}>
                {STAGE_LABEL[stage.name] ?? stage.name}
              </span>
              {stage.detail !== undefined && stage.detail !== '' && (
                <span className={css.traceStageDetail}>{stage.detail}</span>
              )}
            </li>
          ))}
        </ol>
      )}

      {trace.error !== '' && (
        <p className={css.traceError}>{trace.error}</p>
      )}

      <TextBlock title="上下文（发给模型的历史对话）" value={trace.context} open />
      <TextBlock title="知识库命中" value={trace.kb} empty="（本轮未启用或未命中）" />
      <TextBlock title="系统提示词" value={trace.systemPrompt} />
      <TextBlock title="本轮提问提示词" value={trace.userPrompt} />
      <TextBlock title="模型输出" value={trace.output} />
    </div>
  )
}

export function MessageListTraceSection(props: {
  /** 当前抽屉展示的记录 id；记录切换时重新读取留痕。 */
  recordId: number
}): React.JSX.Element {
  const [state, setState] = useState<ChatAiReplyTraceRead | null>(null)

  useEffect(() => {
    let alive = true
    setState(null)
    void apiGetChatAiReplyTrace(props.recordId).then(
      (result) => {
        if (alive) setState(result)
      },
      (e: unknown) => {
        if (!alive) return
        setState({ ok: false, error: e instanceof Error ? e.message : String(e) })
      },
    )
    return () => {
      alive = false
    }
  }, [props.recordId])

  return (
    <section className={css.section} aria-label="回复过程">
      <h3 className={css.sectionTitle}>回复过程</h3>
      {state === null && <p className={css.muted}>读取中…</p>}
      {state !== null && !state.ok && (
        <p className={css.muted}>{state.error}</p>
      )}
      {state !== null && state.ok && <TraceBody trace={state.trace} />}
    </section>
  )
}
