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
import { ErrorState } from '../ui/kit.tsx'
import type { WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { BasisLine, AnswerFeedback, PlanLine, RetrMeta } from './Ask.tsx'
import { AnswerBody } from './AnswerBody.tsx'
import { AskPending } from './ask-pending.tsx'
import { AskProcess } from './AskProcess.tsx'
import { AskResources, AskRuntimeMeta } from './AskRuntimeMeta.tsx'
import { AskHistoryDialog } from './AskHistoryDialog.tsx'
import { CiteDetailPanel } from './CiteDetailPanel.tsx'
import { KnowledgeNoteEditor } from './KnowledgeNoteEditor.tsx'
import { useKbScope } from './kb-scope.ts'
import { loadMessageContext, openKbFileFromCitation, useCiteDetail } from './use-cite-detail.ts'
import { useAskSession, type AskTurn } from './use-ask.ts'
import { useAskOptimize } from './use-ask-optimize.ts'
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
 * 面板头（标题 + 历史记录 / 新对话 / 全屏 / 关闭）。
 *
 * 抽出来的理由与 `SessionThread` / `SessionIntro` 相同：`SessionAsk` 受函数体棘轮
 * 管着（250 行上限）。四个按钮的 SVG 就占 20 行，而它们与面板状态无关。
 *
 * @param props.full - 是否全屏（决定全屏按钮的图标与提示）。
 * @param props.onToggleFull - 切换全屏。
 * @param props.onClose - 关闭面板。
 * @param props.onHistory - 打开历史记录弹窗。
 * @param props.onNewChat - 开始新对话（清空本会话的 AI 对话）。
 * @returns 头部元素。
 */
function SessionHead({ full, onToggleFull, onClose, onHistory, onNewChat }: {
  full: boolean
  onToggleFull: () => void
  onClose: () => void
  onHistory: () => void
  onNewChat: () => void
}): React.JSX.Element {
  return (
    <div className={css.head}>
      <span className={css.title}>新对话</span>
      <div className={css.headActions}>
        {/* 「历史记录」：与「微信问答」同一件弹窗（内容由后端在每次回答产出时自动累积）。 */}
        <button type="button" className={css.iconBtn} title="查看历史问答记录（每一次问答都会自动保存）"
          aria-label="历史记录" onClick={onHistory}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 4v4h4" /><path d="M12 8v4l3 2" />
          </svg>
        </button>
        <button type="button" className={css.iconBtn} title="开始新对话（清空本会话的 AI 对话）"
          aria-label="开始新对话" onClick={onNewChat}>
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
  )
}

/**
 * 空态引导卡（图标 + 标题 + 说明 + 示例问题）。
 *
 * 抽出来的理由与 `SessionThread` 相同：`SessionAsk` 受函数体棘轮管着（250 行上限）。
 * 它也是**语义独立**的一节 —— 只在「还没提问」时出现，与提问、检索、生成全无耦合。
 *
 * @param props.targetName - 当前会话显示名（写进说明文案）。
 * @param props.onPick - 点示例问题（填入输入框并聚焦，**不**自动发送）。
 * @returns 引导卡元素。
 */
function SessionIntro({ targetName, onPick }: {
  targetName: string
  onPick: (s: string) => void
}): React.JSX.Element {
  return (
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
          <button key={s} type="button" className={css.sugCard} onClick={() => { onPick(s) }}>
            <span className={css.sugText}>{s}</span>
            <span className={css.sugArrow} aria-hidden="true">
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * 消息流（从 `SessionAsk` 抽出）。
 *
 * 抽出的直接原因：`SessionAsk` 受 `function-size-ratchet.spec.ts` 的棘轮管着
 * （250 行上限），而本轮为「与微信问答功能对齐」补上反馈 / 沉淀 / 优化提问 / 历史记录
 * 之后涨到 337 行 —— 直接顶穿。这一块（用户气泡 / AI 回答 / 过程 / 脚注）是
 * **语义独立**的一节：它只负责「把 turns 渲染出来」，不参与提问、检索、状态管理。
 *
 * @param props.turns - 当前线程的轮次。
 * @param props.asking - 是否正在生成。
 * @param props.streamText - 生成中的正文（流式）。
 * @param props.streamReasoning - 生成中的思考过程（流式）。
 * @param props.streamStages - 生成中的阶段事件（流式）。
 * @param props.onStop - 「停止生成」回调。
 * @param props.citeDetail - 引用详情开关（点角标 → 右侧滑出）。
 * @param props.patchTurn - 就地更新某一轮（反馈回写）。
 * @param props.questionForTurn - 取某轮对应的提问（沉淀时写进笔记）。
 * @param props.onDistill - 「沉淀为笔记」回调（打开编辑器）。
 * @returns 消息流元素。
 */
function SessionThread({ turns, asking, streamText, streamReasoning, streamStages, onStop, onRetry, citeDetail, patchTurn, questionForTurn, onDistill }: {
  turns: AskTurn[]
  asking: boolean
  streamText: string
  streamReasoning: string
  streamStages: React.ComponentProps<typeof AskPending>['streamStages']
  onStop: () => void
  onRetry: (index: number) => void
  citeDetail: ReturnType<typeof useCiteDetail>
  patchTurn: (index: number, patch: Partial<AskTurn>) => void
  questionForTurn: (idx: number) => string
  onDistill: (v: { open: boolean; title?: string; body?: string; question?: string }) => void
}): React.JSX.Element {
  return (
    <div className={css.thread}>
      {turns.map((t, i) => (
        t.role === 'user' ? (
          <div key={i} className={css.turnUser}>
            <div className={css.userBubble}>{t.text}</div>
          </div>
        ) : (
          <div key={i} className={css.turnAi}>
            {/* 过程时间线（与「微信问答」同一套）：思考 + 工具调用步骤，放在答案之前。 */}
            <AskProcess stages={t.stages} reasoning={t.reasoning} />
            <AskRuntimeMeta
              turn={t}
              placement="meta"
              {...(t.status === 'failed' ? { onRetry: () => { onRetry(i) } } : {})}
            />
            {/* 规划与检索漏斗：与「微信问答」同一套组件，放进滚动区，不挤输入框。 */}
            <PlanLine plan={t.plan} />
            <RetrMeta retrieval={t.retrieval} />
            <div className={css.aiAnswer}>
              <AnswerBody
                text={t.text}
                {...(t.citations ? { citations: t.citations } : {})}
                onOpenCite={(n) => { citeDetail.toggle(i, n) }}
                {...(citeDetail.ref?.turn === i ? { activeCite: citeDetail.ref.n } : {})}
              />
            </div>
            {/* 回答脚注：依据 + 反馈 + 沉淀合成一行（与「微信问答」同一件、同一布局）。 */}
            <div className={css.answerFoot}>
              <BasisLine basis={t.basis} />
              <div className={css.footActions}>
                <AnswerFeedback turn={t} patch={(p) => { patchTurn(i, p) }} />
                {t.text.trim().length > 0 && (
                  <button
                    type="button"
                    className={css.distillBtn}
                    title="把这轮回答存成知识笔记；会带上来源会话，出现在「知识社交图谱」里"
                    onClick={() => {
                      const q = questionForTurn(i).trim()
                      onDistill({
                        open: true,
                        title: q ? (q.length > 40 ? q.slice(0, 40) + '…' : q) : '问答沉淀',
                        body: q ? `${t.text}\n\n来源问题：${q}` : t.text,
                        ...(q ? { question: q } : {}),
                      })
                    }}
                  >
                    沉淀
                  </button>
                )}
              </div>
            </div>
            <AskResources turn={t} />
          </div>
        )
      ))}
      {asking && (
        /* 生成中那一块**直接复用「微信问答」的 `AskPending`**（过程时间线 + 流式正文 +
           停止按钮）。旧实现自己写了一套，而它把 `AskProcess` 塞在 `streamText ?` 分支里 ——
           检索阶段（还没开始吐字）恰恰是「工具调用过程」最该显示的时候，却一条都看不到。 */
        <AskPending
          streamText={streamText}
          streamReasoning={streamReasoning}
          streamStages={streamStages}
          onStop={onStop}
        />
      )}
    </div>
  )
}

/**
 * Render the session-scoped AI panel.
 * @param props - see SessionAskProps.
 * @returns panel element tree.
 */
export function SessionAsk(props: SessionAskProps): React.JSX.Element {
  const { target, onClose, onOpenMessage, full, onToggleFull } = props
  const [question, setQuestion] = useState('')
  /** 「沉淀为笔记」编辑器（与「微信问答」同一件，prefill 标题/正文/来源问题）。 */
  const [distill, setDistill] = useState<{ open: boolean; title?: string; body?: string; question?: string }>({ open: false })
  /** 「历史记录」弹窗开关（与「微信问答」同一件）。 */
  const [historyOpen, setHistoryOpen] = useState(false)
  /** 沉淀时的目标知识库（与「微信问答」同一处 scope）。 */
  const { kbId } = useKbScope()

  // 每个会话一份线程：键即 username。
  // source/scopeUsernameName 只用于**问答历史**：让历史列表能区分「在哪问的」并直接显示会话名。
  const { turns, asking, streamText, streamReasoning, streamStages, error, ask, retry: retryTurn, cancel, resetAndCancel: resetThread, patchTurn, clearError } = useAskSession({
    scopeUsername: target.username,
    scopeUsernameName: nameOf(target),
    source: 'session',
    threadKey: target.username,
  })
  /** 引用详情面板的开关（点正文角标 → 右侧滑出；再点同一条收起）。 */
  const citeDetail = useCiteDetail(turns, target.username, { loadContext: loadMessageContext })
  const {
    loading: optLoading,
    result: optResult,
    error: optError,
    optimize: optimizeAsk,
    dismiss: dismissOptimize,
  } = useAskOptimize({ scopeKey: target.username, username: target.username })

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

  /**
   * 提问优化（与「微信问答」同一条后端 Remote）。
   *
   * 范围同样限定到当前会话 —— 优化器据此改写（「帮我找一下之前提过的报价」
   * 在单聊里与在群里该补的限定词不同）。
   */
  const optimizeQuestion = useCallback(async (): Promise<void> => {
    if (optLoading) return
    await optimizeAsk(question, turns)
  }, [optLoading, optimizeAsk, question, turns])

  /** 取某轮回答对应的提问（沉淀时写进笔记的「来源问题」）。 */
  const questionForTurn = useCallback((idx: number): string => {
    for (let i = idx - 1; i >= 0; i -= 1) {
      const t = turns[i]
      if (t && t.role === 'user') return t.text
    }
    return ''
  }, [turns])

  const targetName = nameOf(target)

  return (
    <section className={css.panel} data-full={full || undefined} aria-label="会话 AI 对话">
      <SessionHead
        full={full}
        onToggleFull={onToggleFull}
        onClose={onClose}
        onHistory={() => { setHistoryOpen(true) }}
        onNewChat={() => {
          resetThread()
          clearError()
          dismissOptimize()
          citeDetail.close()
          setQuestion('')
        }}
      />

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
          <SessionIntro
            targetName={targetName}
            onPick={(s) => { setQuestion(s); clearError(); taRef.current?.focus() }}
          />
        ) : (
          <SessionThread
            turns={turns}
            asking={asking}
            streamText={streamText}
            streamReasoning={streamReasoning}
            streamStages={streamStages}
            onStop={cancel}
            onRetry={(i) => { void retryTurn(i) }}
            citeDetail={citeDetail}
            patchTurn={patchTurn}
            questionForTurn={questionForTurn}
            onDistill={setDistill}
          />
        )}
      </div>

      {error && <ErrorState message={error} />}

      {/* 引用详情：**覆盖式**（本面板宽度随视口伸缩，切不出侧栏）——
          左侧对话原样留着当上下文，看完关掉即可继续追问。 */}
      <CiteDetailPanel
        item={citeDetail.item}
        index={citeDetail.ref?.n ?? 0}
        context={citeDetail.context}
        contextStatus={citeDetail.contextStatus}
        contextError={citeDetail.contextError}
        onRetryContext={citeDetail.retryContext}
        onClose={citeDetail.close}
        onOpenSource={(u, id) => { onOpenMessage(u, id ?? 0) }}
        onOpenKbFile={openKbFileFromCitation}
        overlay
      />

      {/* 优化建议（与「微信问答」同一件、同一位置：紧贴输入框上方，不进入滚动区）。 */}
      {optError && <div className={css.optError} role="alert">{optError}</div>}
      {optResult && (
        <div className={css.optStrip} role="status">
          <div className={css.optTitle}>优化后的问题</div>
          <div className={css.optText}>{optResult.optimized}</div>
          {optResult.suggestions.length > 0 && (
            <>
              <div className={css.optTitle}>改进建议</div>
              <ul className={css.optList}>
                {optResult.suggestions.map((s, i) => (<li key={i}>{s}</li>))}
              </ul>
            </>
          )}
          <div className={css.optActions}>
            <button type="button" className={css.optApply} onClick={() => { setQuestion(optResult.optimized); dismissOptimize() }}>采用优化</button>
            <button type="button" className={css.optDismiss} onClick={dismissOptimize}>忽略</button>
          </div>
        </div>
      )}

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
          {/* 优化提问：与「微信问答」同一条后端 Remote（范围同样限定到当前会话）。 */}
          <button
            type="button"
            className={css.optBtn}
            onClick={() => { void optimizeQuestion() }}
            disabled={optLoading || !question.trim() || asking}
            title="让 AI 改写问题、给出改进建议（结果内联展示，可一键采用）"
          >
            {optLoading ? '优化中…' : '优化提问'}
          </button>
          <span className={css.footSpacer} />
          {asking ? (
            <button type="button" className={css.stopSend} onClick={cancel}
              aria-label="停止生成" title="停止本轮回答的生成（已生成的部分会保留）">
              <span className={css.stopSendGlyph} aria-hidden="true" />
            </button>
          ) : (
            <button type="button" className={css.send} onClick={submit}
              disabled={!question.trim()} aria-label="发送" title="发送（Enter 发送，Shift+Enter 换行）">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
            </button>
          )}
        </div>
      </div>
      <div className={css.note}>回答附原文出处，点击可核对</div>

      {/* 「沉淀为笔记」编辑器：与「微信问答」同一件。`sourceKind='ask'` +
          当前会话范围，构成知识图谱连到人的那条边。 */}
      <KnowledgeNoteEditor
        kbId={kbId}
        allowKbPick
        open={distill.open}
        initialTitle={distill.title ?? ''}
        initialBody={distill.body ?? ''}
        sourceKind="ask"
        sourceUsername={target.username}
        {...(distill.question ? { sourceQuestion: distill.question } : {})}
        onClose={() => { setDistill({ open: false }) }}
        onSaved={() => { setDistill({ open: false }) }}
      />

      {/* 「历史记录」弹窗：与「微信问答」同一件（内容由后端在每次回答产出时自动累积）。
          `onAskAgain` 把历史里那条问题填回输入框而**不自动发送**。 */}
      <AskHistoryDialog
        open={historyOpen}
        onClose={() => { setHistoryOpen(false) }}
        onOpenCitation={(u, id) => { onOpenMessage(u, id ?? 0) }}
        onOpenKbFile={openKbFileFromCitation}
        onAskAgain={(q) => {
          setQuestion(q)
          clearError()
          setHistoryOpen(false)
          taRef.current?.focus()
        }}
      />
    </section>
  )
}
