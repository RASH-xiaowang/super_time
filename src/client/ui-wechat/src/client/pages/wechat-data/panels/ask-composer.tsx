/**
 * 问答输入面：输入、发送、停止、优化提问，以及输入 `@` 弹出的检索范围选择。
 *
 * 从 `AskPanel` 抽出的原因有两条：
 *   · 面板本身受单函数行数棘轮约束；
 *   · `@` 浮层需要贴近输入框管理触发字符，和输入面放在一起才不会把一次插入
 *     拆成两个组件各记一半状态。
 */
import { useCallback, type Dispatch, type RefObject, type SetStateAction } from 'react'
import type { WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { describeRange } from '../utils/date-range.ts'
import { AskScopePicker } from './ask-scope-picker.tsx'
import { removeScopeTrigger } from './ask-scope-trigger.ts'
import { useAskScopeTrigger } from './use-ask-scope-trigger.ts'
import css from './ask.module.css'

/**
 * @param props.question - 当前输入内容。
 * @param props.setQuestion - 写入输入内容。
 * @param props.onSubmit - 提交问题；参数已移除触发用的 @。
 * @param props.asking - 是否正在生成。
 * @param props.onStop - 停止生成。
 * @param props.optLoading - 是否正在优化提问。
 * @param props.onOptimize - 优化当前问题。
 * @param props.textareaRef - 外部复用的输入框引用（示例卡/历史回填后聚焦）。
 * @param props.scopeUsername - 当前会话范围。
 * @param props.scopeDisplayName - 当前会话范围显示名。
 * @param props.sessions - 可检索会话。
 * @param props.sessionsLoaded - 会话是否已加载。
 * @param props.from - 起始日期。
 * @param props.to - 结束日期。
 * @param props.onReloadSessions - 重新拉取会话。
 * @param props.onPickScope - 选中会话（空串表示全部会话）。
 * @param props.onFrom - 写入起始日期。
 * @param props.onTo - 写入结束日期。
 * @param props.onClearTime - 清除时间范围。
 * @returns 输入面元素。
 */
export function AskComposer({
  question,
  setQuestion,
  onSubmit,
  asking,
  onStop,
  optLoading,
  onOptimize,
  textareaRef,
  scopeUsername,
  scopeDisplayName,
  sessions,
  sessionsLoaded,
  from,
  to,
  onReloadSessions,
  onPickScope,
  onFrom,
  onTo,
  onClearTime,
}: {
  question: string
  setQuestion: Dispatch<SetStateAction<string>>
  onSubmit: (question: string) => void
  asking: boolean
  onStop: () => void
  optLoading: boolean
  onOptimize: () => void
  textareaRef: RefObject<HTMLTextAreaElement>
  scopeUsername: string
  scopeDisplayName: string
  sessions: readonly WechatSession[]
  sessionsLoaded: boolean
  from: string
  to: string
  onReloadSessions: () => void
  onPickScope: (username: string) => void
  onFrom: (value: string) => void
  onTo: (value: string) => void
  onClearTime: () => void
}): React.JSX.Element {
  const trigger = useAskScopeTrigger(question, setQuestion)
  const consume = trigger.consume

  /** 关闭浮层时一并移除触发用的 @；`restoreFocus` 只在键盘/选择动作后为真。 */
  const closePicker = useCallback((restoreFocus: boolean): void => {
    const at = consume()
    setQuestion(value => removeScopeTrigger(value, at))
    if (restoreFocus) requestAnimationFrame(() => { textareaRef.current?.focus() })
  }, [consume, setQuestion, textareaRef])

  const pickScope = useCallback((username: string): void => {
    onPickScope(username)
    closePicker(true)
  }, [onPickScope, closePicker])

  const submit = useCallback((): void => {
    const cleaned = removeScopeTrigger(question, trigger.consume())
    setQuestion(cleaned)
    onSubmit(cleaned)
  }, [onSubmit, question, setQuestion, trigger])

  const hasScope = scopeUsername !== '' || from !== '' || to !== ''
  const scopeLabel = scopeDisplayName || '全部会话'

  return (
    <div className={css.composer}>
      <AskScopePicker
        open={trigger.open}
        sessions={sessions}
        sessionsLoaded={sessionsLoaded}
        scopeUsername={scopeUsername}
        from={from}
        to={to}
        onReloadSessions={onReloadSessions}
        onClose={closePicker}
        onPickSession={pickScope}
        onFrom={onFrom}
        onTo={onTo}
        onClearTime={onClearTime}
      />
      <div className={css.inputRow}>
        <textarea
          ref={textareaRef}
          className={css.composerInput}
          value={question}
          onChange={trigger.onChange}
          onKeyDown={(e) => {
            // Enter 发送、Shift+Enter 换行；输入法组字期间不拦截（中文候选确认用）。
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              if (trigger.open) {
                // 范围浮层打开时，第一次 Enter 只收起并清掉触发 @，避免把 @ 当正文发送。
                closePicker(true)
                return
              }
              submit()
            }
          }}
          placeholder="今天想从聊天记录里查点什么？输入 @ 可限定范围"
          rows={1}
          aria-label="微信问答问题"
        />
        {asking ? (
          <button
            type="button"
            className={css.sendStop}
            onClick={onStop}
            aria-label="停止生成"
            title="停止本轮回答的生成（已生成的部分会保留）"
          >
            <span className={css.sendStopGlyph} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            className={css.send}
            disabled={!question.trim()}
            onClick={submit}
            aria-label="提问"
            title="提问（Enter 发送，Shift+Enter 换行）"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
          </button>
        )}
      </div>
      <div className={css.composerFooter}>
        <button
          type="button"
          className={css.optBtn}
          onClick={onOptimize}
          disabled={optLoading || !question.trim() || asking}
          title="让 AI 改写问题、给出改进建议（结果内联展示，可一键采用）"
        >
          {optLoading ? '优化中…' : '优化提问'}
        </button>
        {hasScope && (
          <span className={css.scopeActive} title={`当前检索范围：${scopeLabel} · ${describeRange(from, to)}`}>
            范围：{scopeLabel} · {describeRange(from, to)}
          </span>
        )}
        <span className={css.actionHint}>输入 @ 选范围 · Enter 发送</span>
      </div>
    </div>
  )
}
