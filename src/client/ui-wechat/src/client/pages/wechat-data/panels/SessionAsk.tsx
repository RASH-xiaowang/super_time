/**
 * 「新对话」——会话级 AI 问答面板（群聊 / 单聊内嵌）。
 *
 * 与「微信问答」页签的区别只在**范围绑定**：这里把检索范围固定到当前会话
 * （`username`），于是问的是「这段聊天」。检索、多轮、流式、引用、反馈全部复用
 * `useAskSession` + 同一套后端 Remote，没有第二条实现路径。
 *
 * 范围**不做选择**：面板与右侧消息流是同一个会话，两者必须一致 ——
 * 一旦允许改范围，就会出现「看着 A 的聊天、问的却是 B」这种用户无法自证的错位。
 * 切换到别的会话时面板自然跟着换（每个会话各留一份对话上下文，按 username 分线程）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { BasisLine, CiteList } from './Ask.tsx'
import { useAskSession } from './use-ask.ts'
import css from './session-ask.module.css'

/** 空态引导问题（与截图一致，且对任意会话都成立）。 */
const SUGGESTIONS = [
  '最近讨论了哪些重要的事？',
  '帮我找一下之前提过的报价',
  '有哪些事情还没确认？',
]

/** 面板属性。 */
export interface SessionAskProps {
  /** 读取范围：**恒为当前打开的会话**（单聊/群聊），不做切换。 */
  target: WechatSession
  onClose: () => void
  /** 点击引用跳转到原文。 */
  onOpenMessage: (username: string, localId: number) => void
  /** 全屏（占满整个会话区）。 */
  full: boolean
  onToggleFull: () => void
}

/** 会话显示名。 */
function nameOf(s: WechatSession): string {
  return s.displayName || s.username
}

/**
 * Render the session-scoped AI panel.
 * @param props - see SessionAskProps.
 * @returns panel element tree.
 */
export function SessionAsk(props: SessionAskProps): React.JSX.Element {
  const { target, onClose, onOpenMessage, full, onToggleFull } = props
  const [question, setQuestion] = useState('')

  // 每个会话一份线程：键即 username。
  const { turns, asking, streamText, error, ask, reset, patchTurn, clearError } = useAskSession({
    scopeUsername: target.username,
    threadKey: target.username,
  })

  const taRef = useRef<HTMLTextAreaElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  /** 是否停在底部附近：只有停在底部才自动跟随新内容，向上翻阅时不被拽走。 */
  const atBottomRef = useRef(true)

  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onScroll = (): void => { atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll) }
  }, [])
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (asking || atBottomRef.current) requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
  }, [turns, asking])

  // 输入框随内容增高（上限后内部滚动）
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }, [question])

  const submit = useCallback((): void => {
    const q = question.trim()
    if (!q || asking) return
    setQuestion('')
    void ask(q)
  }, [question, asking, ask])

  const targetName = nameOf(target)

  return (
    <section className={css.panel} data-full={full || undefined} aria-label="会话 AI 对话">
      <div className={css.head}>
        <span className={css.title}>新对话</span>
        <div className={css.headActions}>
          <button type="button" className={css.iconBtn} title="开始新对话（清空本会话的 AI 对话）"
            aria-label="开始新对话" onClick={() => { reset(); clearError(); setQuestion('') }}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
          <button type="button" className={css.iconBtn} title={full ? '退出全屏' : '全屏'} aria-label={full ? '退出全屏' : '全屏'} onClick={onToggleFull}>
            {full ? (
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M9 3H5a2 2 0 0 0-2 2v4" /><path d="M15 21h4a2 2 0 0 0 2-2v-4" />
                <path d="M21 9V5a2 2 0 0 0-2-2h-4" /><path d="M3 15v4a2 2 0 0 0 2 2h4" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 9V5a2 2 0 0 1 2-2h4" /><path d="M21 15v4a2 2 0 0 1-2 2h-4" />
                <path d="M15 3h4a2 2 0 0 1 2 2v4" /><path d="M9 21H5a2 2 0 0 1-2-2v-4" />
              </svg>
            )}
          </button>
          <button type="button" className={css.iconBtn} title="关闭 AI 对话" aria-label="关闭 AI 对话" onClick={onClose}>
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* 读取范围（只读） */}
      <div className={css.scopeRow}>
        <span className={css.scopeLabel}>读取范围</span>
        <svg className={css.scopeIcon} viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
        </svg>
        {/* 范围恒为当前会话：只展示，不提供切换（避免「问了之外的那段聊天」） */}
        <span className={css.scopeName} title={target.username}>{targetName}</span>
      </div>

      <div className={css.body} ref={bodyRef}>
        {turns.length === 0 && !asking ? (
          <div className={css.intro}>
            <div className={css.introIcon} aria-hidden="true">
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.9-.9L3 20l1-4.1a8.4 8.4 0 0 1-.9-3.8 8.4 8.4 0 0 1 9-8.4 8.4 8.4 0 0 1 8.9 7.8Z" />
                <path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01" />
              </svg>
            </div>
            <div className={css.introTitle}>想从聊天里了解什么？</div>
            <div className={css.introSub}>
              查找消息、梳理进展、或继续追问。<br />从 {targetName} 开始，回答附上原文出处。
            </div>
            <div className={css.sugList}>
              {SUGGESTIONS.map(s => (
                <button key={s} type="button" className={css.sugCard}
                  onClick={() => { setQuestion(s); clearError(); taRef.current?.focus() }}>
                  <span className={css.sugText}>{s}</span>
                  <span className={css.sugArrow} aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className={css.thread}>
            {turns.map((t, i) => (
              t.role === 'user' ? (
                <div key={i} className={css.turnUser}>
                  <div className={css.userBubble}>{t.text}</div>
                </div>
              ) : (
                <div key={i} className={css.turnAi}>
                  <div className={css.aiAnswer}>{t.text}</div>
                  <BasisLine basis={t.basis} />
                  {(t.citations?.length ?? 0) > 0 && (
                    <CiteList items={t.citations!} cited={t.citedIndexes} answer={t.text}
                      onOpen={(username, localId) => { onOpenMessage(username, localId ?? 0) }} />
                  )}
                </div>
              )
            ))}
            {asking && (
              streamText
                ? (
                  <div className={css.turnAi}>
                    <div className={css.aiAnswer} data-streaming>
                      {streamText}
                      <span className={css.caret} aria-hidden="true" />
                    </div>
                  </div>
                )
                : <div className={css.pending}><span className={css.dots} />正在检索本机记录并生成回答…</div>
            )}
          </div>
        )}
      </div>

      {error && <div className={css.error} role="alert">{error}</div>}

      <div className={css.composer}>
        <textarea
          ref={taRef}
          className={css.input}
          value={question}
          onChange={(e) => { setQuestion(e.target.value) }}
          onKeyDown={(e) => {
            // Enter 发送、Shift+Enter 换行；输入法组字期间不拦截。
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="继续追问这段聊天…"
          rows={1}
          aria-label="继续追问这段聊天"
        />
        <div className={css.composerFoot}>
          {/* 模型不在这里选：统一在「数据配置 → AI 大模型」设置，全应用共用一份。 */}
          <span className={css.footHint}>模型在「数据配置」中设置</span>
          <span className={css.footSpacer} />
          <button type="button" className={css.send} onClick={submit}
            data-busy={asking || undefined}
            disabled={!question.trim() || asking} aria-label="发送" title="发送（Enter 发送，Shift+Enter 换行）">
            {asking
              ? <span className={css.spinner} aria-hidden="true" />
              : <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>}
          </button>
        </div>
      </div>
      <div className={css.note}>回答附原文出处，点击可核对</div>
    </section>
  )
}
