/**
 * 微信问答面板 — 基于本机聊天记录检索 + DSH LLM 生成回答，引用可点击跳转。
 * 检索在本机完成；AI 生成会调用当前配置的模型（出网提示见界面）。
 *
 * ── 界面结构（本轮整体重排）──────────────────────────────
 *  askLayout（横向两栏，永远是「并排」而不是「覆盖」）
 *   ├─ askPage
 *   │  ① 面板头（固定）   标题 / 说明 / 清空对话
 *   │  ② 检索上下文条（固定） 语料状态 · 会话范围 · 时间范围 · 回答模型
 *   │  ③ 对话区（滚动）   多轮问答；空态为一张引导卡，内容贴底生长
 *   │  ④ 提问区（固定）   输入框 + 发送（同一个面）+ 次要动作行
 *   │  ⑤ 隐私说明（固定） 12px 次级小字
 *   └─ modelPanel
 *      模型配置（仅在打开时渲染，占据自己的车道）
 *
 * 与上一版的关键差别：
 *  ① 把「会话/时间/模型」三个限定条件从输入框内部提到输入框**上方**的上下文条 ——
 *     输入框只负责输入与发送（三层挤 158px → 两层），限定条件常驻可见、随时可改。
 *  ② 模型配置从 `position: fixed` 的覆盖式抽屉改成**面板内的实体侧栏**：
 *     任何窗口宽度下都不遮挡顶部栏、输入框、发送键或任何对话内容
 *     （旧实现 <1100px 时用覆盖式，实测把发送键整块盖住、点击被抽屉体截获）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGetSessions, apiOptimizeAskQuestion, apiSubmitAskFeedback } from '../api.ts'
import type { AskOptimizeResult, AskResult, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { Badge, PanelHeader, Select } from '../ui/kit.tsx'
import { RetrievalPanel } from './RetrievalPanel.tsx'
import { KnowledgeNoteEditor } from './KnowledgeNoteEditor.tsx'
import { useAskSession, type AskTurn } from './use-ask.ts'
import { auditAnswerGrounding, groundingWarning } from './utils/grounding.ts'
import css from './ask.module.css'
import rcss from './retrieval.module.css'
import kitCss from '../ui/kit.module.css'

/** 空态示例问题：点一下即填入输入框并聚焦。 */
const EXAMPLES = [
  '上周三我和李四聊了什么？',
  '谁答应过我下周交报告？',
  '最近一次转账给我的是谁？',
]

/** 空态能力行：三条一句话说明「这个面板能做什么 / 边界在哪」，
 *  让首次进入的空白区承载信息而不是纯留白。 */
const CAPABILITIES = ['本机检索，不出网', '引用可跳转原文', '支持多轮追问']

/** 时间 chip 上的短日期显示：2026-09-11 → 09/11。 */
function fmtShortDate(d: string): string {
  return d.length >= 10 ? d.slice(5).replace('-', '/') : d
}

/** 上下文条上的统一领标图标：三种限定条件用同一套 13px 线性图标。 */
function ScopeIcon({ kind }: { kind: 'corpus' | 'time' | 'retrieval' }): React.JSX.Element {
  const common = {
    className: css.ctxIcon, viewBox: '0 0 24 24', width: 13, height: 13,
    fill: 'none', stroke: 'currentColor', strokeWidth: 2,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true,
  }
  if (kind === 'corpus') {
    return (
      <svg {...common}>
        <path d="M12 3 2 8l10 5 10-5-10-5Z" />
        <path d="m2 16 10 5 10-5" />
        <path d="m2 12 10 5 10-5" />
      </svg>
    )
  }
  if (kind === 'time') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    )
  }
  if (kind === 'retrieval') {
    // 漏斗/过滤图标：表达「检索流水线」而不是又一次「检索」。
    return (
      <svg {...common}>
        <path d="M3 5h18l-7 8v6l-4 2v-8L3 5Z" />
      </svg>
    )
  }
  return null
}

/** 检索规划元信息行：默认收起只显示意图 + 已识别的限定条件，点击展开检索词。 */
function PlanLine({ plan }: { plan?: AskResult['plan'] }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!plan || (!plan.intent && plan.subQueries.length === 0)) return null
  const hasQueries = plan.subQueries.length > 0
  // 规划器识别出的时间/人物线索直接平铺 —— 这是「系统有没有听懂我要问什么」的唯一证据，
  // 收在展开区里等于没有（用户只会在答案不对时才想起来看它）。
  const when = plan.from || plan.to
    ? `${plan.from ? fmtShortDate(plan.from) : '…'}${plan.to && plan.to !== plan.from ? '→' + fmtShortDate(plan.to) : ''}`
    : ''
  return (
    <button
      type="button"
      className={css.planLine}
      data-open={open || undefined}
      onClick={() => { setOpen(v => !v) }}
      disabled={!hasQueries}
      aria-expanded={hasQueries ? open : undefined}
      title={hasQueries ? (open ? '收起检索词' : '展开检索词') : undefined}
    >
      <svg className={css.planChevron} viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
      <span className={css.planIntent}>意图：{plan.intent || '—'}</span>
      {when && <span className={css.planChip}>时间 {when}</span>}
      {plan.person && <span className={css.planChip}>对象 {plan.person}</span>}
      {open && hasQueries && <span className={css.planQueries}>检索词：{plan.subQueries.join(' / ')}</span>}
    </button>
  )
}

/** 回答的数据来源说明：条数/会话数/时间跨度 + 引用了几条。
 *  这行由后端按**检索结果算出**（不是模型写的），用户可以直接照着去核对原文。 */
export function BasisLine({ basis }: { basis?: string }): React.JSX.Element | null {
  if (!basis) return null
  return <div className={css.answerBasis}>📄 {basis}</div>
}

/** 引用来源：2 列网格 + 默认折叠前 4 条（20 条平铺会吞没整屏）。
 *  回答正文里真正引用过的来源会高亮标记 —— 否则「来源 20 条」里哪些被用到了
 *  只能靠用户在答案里逐个对 [n]，等于没标。 */
export function CiteList({ items, cited, onOpen, answer }: {
  items: NonNullable<AskResult['citations']>
  cited?: number[]
  onOpen?: (username: string, localId?: number) => void
  /** 对应的回答正文：用于「回答里的金额在所引原文里找不到」的接地提示（见 utils/grounding.ts）。 */
  answer?: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const CAP = 4
  const shown = expanded ? items : items.slice(0, CAP)
  const citedSet = new Set(cited ?? [])
  const groundWarn = answer === undefined ? null : groundingWarning(auditAnswerGrounding(answer, items, cited))
  return (
    <div className={css.citeBlock}>
      <div className={css.citeHead}>
        <span className={css.citeHeadTitle}>
          来源 · {items.length} 条{citedSet.size > 0 ? `（回答引用了 ${citedSet.size} 条，已高亮）` : ''}（点击跳转原文）
        </span>
        {items.length > CAP && (
          <button type="button" className={css.citeMore} onClick={() => { setExpanded(v => !v) }}>
            {expanded ? '收起' : `展开全部 ${items.length} 条`}
          </button>
        )}
      </div>
      {groundWarn ? (
        <div className={css.citeWarn} role="note">⚠ {groundWarn}</div>
      ) : null}
      <div className={css.citeGrid}>
        {shown.map((c, ci) => (
          <button
            key={`${c.username}:${c.local_id}:${ci}`}
            type="button"
            className={css.citeBtn}
            data-cited={citedSet.has(ci + 1) || undefined}
            onClick={() => { onOpen?.(c.username, c.local_id) }}
            title={`${c.sender ? `${c.name} · ${c.sender}` : c.name} · ${c.time} · ${c.snippet}`}
          >
            <span className={css.citeIdx}>[{ci + 1}]</span>
            <span className={css.citeName}>{c.sender ? `${c.name} · ${c.sender}` : c.name}</span>
            <span className={css.citeTime}>{c.time}</span>
            <span className={css.citeSnippet}>{c.snippet}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** 轮次结构复用问答 hook（群聊内 AI 面板是同一套），此处转出以兼容既有引用。 */
export type { AskTurn }

/** 意图的中文标签（后端给的是稳定枚举，界面要给人看）。 */
const INTENT_LABEL: Record<string, string> = {
  recency_lookup: '最近查询',
  entity_lookup: '实体查询',
  time_range: '时间范围',
  aggregation: '聚合统计',
  comparison: '对比',
  open_qa: '开放问答',
}

/** 召回通道的短标签。 */
const CH_LABEL: Record<string, string> = { sparse: '稀疏', dense: '稠密', structured: '结构化' }

/**
 * 检索漏斗行：把「这次回答到底怎么检索出来的」摊开。
 *
 * 为什么值得占一行：用户判断答案可信度时最想知道「系统听懂了没有 / 检索到没有」。
 * 意图 + 各通道命中数 + 召回→窗口漏斗 + 耗时，四段信息一眼可读；
 * 稠密通道被降级（未配置 embedding / 被出站拦截）时显式告警，避免「以为在用向量检索」。
 * @param props.retrieval - 后端返回的检索统计。
 * @returns 漏斗行（无统计时不渲染）。
 */
export function RetrMeta({ retrieval }: { retrieval?: AskResult['retrieval'] }): React.JSX.Element | null {
  if (!retrieval) return null
  const chans = (retrieval.channels ?? [])
    .filter(c => c.active)
    .map(c => `${CH_LABEL[c.channel] ?? c.channel} ${c.count}`)
    .join(' · ')
  const f = retrieval.funnel
  return (
    <div className={rcss.retrLine}>
      {retrieval.intent && <span className={rcss.retrChip}>路由 {INTENT_LABEL[retrieval.intent] ?? retrieval.intent}</span>}
      {chans && <span className={rcss.retrChip}>{chans}</span>}
      {f && <span className={rcss.retrChip}>召回 {f.recalled} → 融合 {f.fused} → 重排 {f.ranked} → 窗口 {retrieval.chunks ?? 0}</span>}
      {typeof retrieval.elapsedMs === 'number' && <span className={rcss.retrChip}>{retrieval.elapsedMs}ms</span>}
      {retrieval.denseActive === false && (
        <span className={`${rcss.retrChip} ${rcss.retrWarn}`} title="未配置向量模型、向量索引未就绪，或「出站拦截」已开启 → 本次仅用本机稀疏检索">
          稠密通道未生效（纯稀疏）
        </span>
      )}
    </div>
  )
}

/**
 * 把逐条标注拆成「有用 / 没用」两组引用序号（1 基）。
 *
 * 抽成纯函数的原因：这是反馈闭环里唯一有分支的业务逻辑（一个错位就会把
 * 「有用」当成「没用」喂给权重调优，方向正好相反），值得被单独断言。
 * @param marks - 引用序号 → 标注。
 * @returns 两组序号（升序）。
 */
export function splitMarks(marks: Record<number, 'useful' | 'useless'>): { useful: number[]; useless: number[] } {
  const useful: number[] = []
  const useless: number[] = []
  for (const [k, v] of Object.entries(marks)) {
    const n = Number(k)
    if (!Number.isFinite(n)) continue
    if (v === 'useful') useful.push(n)
    else if (v === 'useless') useless.push(n)
  }
  useful.sort((a, b) => a - b)
  useless.sort((a, b) => a - b)
  return { useful, useless }
}

/**
 * 回答反馈：赞/踩 + 逐条引用标注。
 *
 * 交互分层（避免给每个回答都塞一排按钮造成噪声）：
 *   · 👍 一键提交（自动把回答实际引用到的来源记为「有用」）；
 *   · 👎 展开标注面板，逐条把引用标为「有用 / 没用」再提交 —— 这是能定位到
 *     「哪个检索特征该调」的关键信号，比一个整体的踩信息量大得多。
 * @param props.turn - 该轮助手回答。
 * @param props.patch - 回写该轮状态（标记已反馈 / 保存标注）。
 * @returns 反馈行；没有引用也没有追踪 id 时不渲染。
 */
export function AnswerFeedback({ turn, patch }: {
  turn: AskTurn
  patch: (p: Partial<AskTurn>) => void
}): React.JSX.Element | null {
  const [marking, setMarking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const cites = turn.citations ?? []

  const submit = useCallback(async (rating: 'up' | 'down', marks?: Record<number, 'useful' | 'useless'>): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNote('')
    try {
      const split = marks ? splitMarks(marks) : { useful: [] as number[], useless: [] as number[] }
      // 赞 → 默认把「回答真正引用过的」记为有用（用户不必再点一遍）。
      if (rating === 'up') {
        for (const i of turn.citedIndexes ?? []) if (!split.useful.includes(i)) split.useful.push(i)
      }
      const r = await apiSubmitAskFeedback({
        ...(turn.retrievalId ? { retrievalId: turn.retrievalId } : {}),
        rating,
        useful: split.useful,
        useless: split.useless,
        answer: turn.text.slice(0, 400),
      })
      patch({ feedback: rating, ...(marks ? { marks } : {}) })
      setMarking(false)
      setNote(r.adaptedWeights ? '已记录 · 检索权重已更新' : (r.message || '已记录'))
    } catch (e) {
      setNote('提交失败：' + (e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [busy, turn.retrievalId, turn.citedIndexes, turn.text, patch])

  if (cites.length === 0 && !turn.retrievalId) return null

  if (turn.feedback) {
    return (
      <div className={rcss.fbBar}>
        <span className={rcss.fbDone}>{turn.feedback === 'up' ? '✓ 已反馈：有帮助' : '✓ 已反馈：待改进'}</span>
        {note && <span className={rcss.fbHint}>{note}</span>}
      </div>
    )
  }

  const marks = turn.marks ?? {}
  return (
    <div className={rcss.fbBar}>
      <button type="button" className={rcss.fbBtn}
        disabled={busy} onClick={() => { void submit('up') }} title="这次回答有帮助">👍 有帮助</button>
      <button type="button" className={rcss.fbBtn} data-on={marking ? 'down' : undefined}
        disabled={busy} onClick={() => { setMarking(v => !v) }}
        title="标出哪些引用没用/有用，帮助系统调优检索">
        👎 待改进{marking ? '（点击收起）' : ''}
      </button>
      {note && <span className={rcss.fbHint}>{note}</span>}
      {marking && (
        <div className={rcss.markPanel}>
          <div className={rcss.rowHint}>
            点每条的「有用 / 没用」给检索反馈（可只标部分）；提交后系统会据此微调重排权重。
          </div>
          <div className={rcss.markGrid}>
            {cites.map((c, ci) => {
              const idx = ci + 1
              const cur = marks[idx]
              return (
                <div key={`${c.username}:${c.local_id}:${ci}`} className={rcss.markRow}>
                  <span className={rcss.markText} title={c.snippet}>
                    [{idx}] {(c.sender ? `${c.name} · ${c.sender}` : c.name)}：{c.snippet}
                  </span>
                  <button type="button" className={rcss.markToggle} data-on={cur === 'useful' ? 'useful' : undefined}
                    onClick={() => {
                      const next = { ...marks }
                      if (cur === 'useful') delete next[idx]
                      else next[idx] = 'useful'
                      patch({ marks: next })
                    }}>
                    有用
                  </button>
                  <button type="button" className={rcss.markToggle} data-on={cur === 'useless' ? 'useless' : undefined}
                    onClick={() => {
                      const next = { ...marks }
                      if (cur === 'useless') delete next[idx]
                      else next[idx] = 'useless'
                      patch({ marks: next })
                    }}>
                    没用
                  </button>
                </div>
              )
            })}
          </div>
          <div className={rcss.fbBar}>
            <button type="button" className={`${rcss.fbBtn}`} disabled={busy} onClick={() => { void submit('down', marks) }}>
              {busy ? '提交中…' : '提交反馈'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Render the WeChat Q&A panel.
 * @param props - optional chat navigation callback.
 * @returns the ask panel element tree.
 */
export function AskPanel({ onOpenChat }: { onOpenChat?: (username: string, localId?: number) => void } = {}): React.JSX.Element {
  const [sessions, setSessions] = useState<readonly WechatSession[]>([])
  /** 会话列表是否已拉取过：用于区分「还没查」与「确实没有可检索会话」。 */
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [scopeUsername, setScopeUsername] = useState('')
  /** 「沉淀为笔记」编辑器：把某轮回答存成知识笔记（prefill 标题/正文/来源问题）。 */
  const [distill, setDistill] = useState<{ open: boolean; title?: string; body?: string; question?: string }>({ open: false })
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [question, setQuestion] = useState('')
  /** 多轮对话状态（turns/asking/streamText/error）统一由问答 hook 提供。 */
  const { turns, asking, streamText, error, ask: askSession, reset: resetThread, patchTurn, clearError } = useAskSession({
    ...(scopeUsername ? { scopeUsername } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  })
  /** 检索设置侧栏：模型配置已迁到「数据配置」页面，这里只剩检索参数。 */
  const [retrOpen, setRetrOpen] = useState(false)
  /** 侧栏与触发 chip 的引用（用于「点击外部收起」判定）。 */
  const retrRef = useRef<HTMLDivElement | null>(null)
  const retrChipRef = useRef<HTMLButtonElement | null>(null)
  /** 提问优化：加载态 + 结果（优化后的问题与建议）+ 错误。 */
  const [optLoading, setOptLoading] = useState(false)
  const [optResult, setOptResult] = useState<AskOptimizeResult | null>(null)
  const [optError, setOptError] = useState<string | null>(null)
  /** 时间范围面板展开态（上下文条「时间」chip 切换；默认收起）。 */
  const [timeOpen, setTimeOpen] = useState(false)
  /** 输入框随内容自动增高（超上限后内部滚动）。 */
  const taRef = useRef<HTMLTextAreaElement | null>(null)
  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [question])

  /** 正文滚动容器 + 「贴近底部」跟踪：仅当用户停在底部附近时才自动滚到最新消息。 */
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const atBottomRef = useRef(true)
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const onScroll = (): void => { atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll) }
  }, [])
  /** 新内容到达：提问中必滚（用户想看结果）；回答到达时若在底部附近才滚（尊重向上翻阅）。 */
  useEffect(() => {
    const el = bodyRef.current
    if (!el) return
    if (asking || atBottomRef.current) {
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight })
    }
  }, [turns, asking])

  /** 检索设置侧栏开着时：Esc / 点击外部收起。
   *  「外部」= 侧栏与触发 chip 之外；Radix 下拉挂在 body 的 portal 里，不算外部。
   *  点「可交互元素」豁免：点输入框/按钮应直接操作，不因 mousedown 引起的回流让本次 click 丢失。
   *  点空白背景 = 明确的收起意图 → 收起。 */
  useEffect(() => {
    if (!retrOpen) return
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setRetrOpen(false) }
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node | null
      if (!t) return
      if (retrRef.current?.contains(t) || retrChipRef.current?.contains(t)) return
      if (t instanceof Element && t.closest('[role="listbox"],[role="option"],[data-radix-popper-content-wrapper]')) return
      if (t instanceof Element && t.closest('button, input, textarea, select, a, [role="button"], [contenteditable]')) return
      setRetrOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
  }, [retrOpen])

  /** 提问优化：调后端 LLM 改写问题 + 给改进建议（结果内联展示，不弹窗）。 */
  const optimizeQuestion = useCallback(async (): Promise<void> => {
    const q = question.trim()
    if (!q || optLoading) return
    setOptLoading(true)
    setOptError(null)
    setOptResult(null)
    try {
      const history = turns.map(t => ({ role: t.role, content: t.text }))
      const r = await apiOptimizeAskQuestion({
        question: q,
        ...(scopeUsername ? { username: scopeUsername } : {}),
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(history.length > 0 ? { history } : {}),
      })
      setOptResult(r)
    } catch (e) {
      setOptError('优化失败：' + (e as Error).message)
    } finally {
      setOptLoading(false)
    }
  }, [question, optLoading, turns, scopeUsername, from, to])

  /** 通过 base_url 拉取官方模型列表（主进程请求，绕开 CORS）。
   *  未填 API Key 时会命中的两条兜底路径（内置参考清单），由后端返回 source='catalog'。 */
  const loadSessions = useCallback(async (): Promise<void> => {
    try {
      const env = await apiGetSessions({ limit: 500 })
      setSessions(env.sessions)
    } catch {
      /* 会话列表加载失败不阻塞提问 */
    } finally {
      setSessionsLoaded(true)
    }
  }, [])

  /** 进入面板即拉一次会话列表（api 侧带 30s 快照缓存，重复进入不会重复查询）：
   *  上下文条的「N 个会话可检索」与空态说明都基于它 —— 只有真拉过才不会
   *  在数据已导入时错报「0 个会话可检索」。 */
  useEffect(() => { void loadSessions() }, [loadSessions])

  /** 提问：交给问答 hook（它负责流式 id 隔离 / 多轮历史 / 错误态），这里只管清空输入框。 */
  const ask = useCallback(async (): Promise<void> => {
    const q = question.trim()
    if (!q || asking) return
    setQuestion('')
    await askSession(q)
  }, [question, asking, askSession])

  /** 清空对话与草稿（原「清空」按钮移至面板头）。 */
  const clearConversation = useCallback((): void => {
    setQuestion('')
    resetThread()
    clearError()
    setOptResult(null)
    setOptError(null)
  }, [resetThread, clearError])

  const userTurnCount = turns.filter(t => t.role === 'user').length
  const hasScope = Boolean(scopeUsername || from || to)
  /** 取某轮回答对应的提问：用最近的前一条 user 轮次（assistant 轮本身不携带提问）。 */
  const questionForTurn = useCallback((idx: number): string => {
    for (let i = idx - 1; i >= 0; i -= 1) {
      const t = turns[i]
      if (t && t.role === 'user') return t.text
    }
    return ''
  }, [turns])
  const noCorpus = sessionsLoaded && sessions.length === 0

  return (
    <div className={kitCss.panelShell}>
      {/* 两栏布局：对话栏 + （按需）检索设置栏。两栏都是常规流内元素 ——
          没有 fixed / z-index / 遮罩，因此不存在「谁盖住谁」的可能。 */}
      <div className={css.askLayout} data-side-open={retrOpen || undefined}>
      <div className={css.askPage}>
      <PanelHeader
        title="微信问答"
        desc="本机检索 · AI 综合回答 · 点击引用跳转原文"
        actions={(
          <>
            <Badge tone={noCorpus ? 'amber' : 'cyan'}>
              {!sessionsLoaded ? '会话载入中…' : noCorpus ? '无可检索会话' : `${sessions.length} 个会话可检索`}
            </Badge>
            {userTurnCount > 0 && (
              <button type="button" className={css.headerClear} onClick={clearConversation} title="清空全部对话轮次">
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 6h18" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                  <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                清空对话
              </button>
            )}
          </>
        )}
      />

      {/* ② 检索上下文条：左侧「检索什么语料」（会话 + 时间），右侧「谁来回答」（模型）。
          三个限定条件同形态（统一 32/40px pill、统一线性图标、统一描边），
          离开输入框后不再与发送动作争夺视觉重心。 */}
      <div className={css.contextBar}>
        <span className={css.ctxLabel}>范围</span>
        <div className={css.scopeHost} data-set={scopeUsername ? '' : undefined}>
          <ScopeIcon kind="corpus" />
          <Select
            value={scopeUsername}
            onChange={(v) => { setScopeUsername(v) }}
            options={[{ value: '', label: '全部会话' }, ...sessions.map(s => ({ value: s.username, label: s.displayName || s.username }))]}
            onOpen={() => { void loadSessions() }}
            placeholder="全部会话"
            ariaLabel="会话范围"
          />
        </div>
        <button
          type="button"
          className={css.ctxChip}
          data-open={timeOpen || undefined}
          data-set={from || to ? '' : undefined}
          onClick={() => { setTimeOpen(v => !v) }}
          aria-expanded={timeOpen}
          title="限定检索的时间范围"
        >
          <ScopeIcon kind="time" />
          {from || to ? `${from ? fmtShortDate(from) : '…'} → ${to ? fmtShortDate(to) : '…'}` : '全部时间'}
          <span className={css.ctxCaret} aria-hidden="true">▾</span>
        </button>
        {(from || to) && (
          <button
            type="button"
            className={css.ctxClear}
            onClick={() => { setFrom(''); setTo(''); setTimeOpen(false) }}
            title="清除时间范围"
            aria-label="清除时间范围"
          >
            清除
          </button>
        )}
        <span className={css.ctxSpacer} />
        {hasScope && <span className={css.ctxHint} title="当前回答只基于以上范围内的聊天片段">已限定范围</span>}
        {/* 检索设置：模型配置已迁到「数据配置」，这里只剩检索参数与离线评估。 */}
        <button
          type="button"
          ref={retrChipRef}
          className={css.ctxChip}
          data-open={retrOpen || undefined}
          onClick={() => { setRetrOpen(v => !v) }}
          aria-expanded={retrOpen}
          title="检索设置：通道开关 / 阈值 / 向量索引 / 离线评估 / 反馈统计"
        >
          <ScopeIcon kind="retrieval" />
          <span className={css.ctxChipName}>检索</span>
          <span className={css.ctxCaret} aria-hidden="true">▾</span>
        </button>
      </div>
      {timeOpen && (
        <div className={css.scopePanel}>
          <span className={css.timePanelLabel}>时间范围</span>
          <label className={css.timeField} htmlFor="ask-from">
            <span className={css.dateLabel}>从</span>
            <input id="ask-from" className={css.input} type="date" value={from} onChange={(e) => { setFrom(e.target.value) }} />
          </label>
          <span className={css.dateSep} aria-hidden="true">→</span>
          <label className={css.timeField} htmlFor="ask-to">
            <span className={css.dateLabel}>到</span>
            <input id="ask-to" className={css.input} type="date" value={to} onChange={(e) => { setTo(e.target.value) }} />
          </label>
          {(from || to) && (
            <button type="button" className={css.timeClear} onClick={() => { setFrom(''); setTo('') }}>清除</button>
          )}
        </div>
      )}

      {/* ③ 对话区：唯一滚动容器。内容一律贴底生长（聊天契约）：
          内容不足时由 .askStack 的 margin-top:auto 把整块推到输入框上方，
          超出时 auto 归零、从顶部开始正常滚动。 */}
      <div className={`${kitCss.panelBody} ${css.askBody}`} ref={bodyRef}>
        <div className={css.askMain}>
        <div className={css.askStack}>
          {/* 空态：一张引导卡（图标 + 标题 + 说明 + 示例），示例就在输入框上方，
              点一下即填入并聚焦输入框 —— 不再把引导拆到正文中央、示例另置一处。 */}
          {userTurnCount === 0 && !asking && (
            <div className={css.emptyIntro}>
              <div className={css.emptyIcon} aria-hidden="true">✦</div>
              <div className={css.emptyTitle}>向你的聊天记录提问</div>
              <div className={css.emptySub} data-warn={noCorpus || undefined}>
                {noCorpus
                  ? '尚未检测到可检索的会话：请先在「数据配置」中设置数据目录并导入解密库'
                  : `${sessions.length} 个会话可检索 · 回答会附上可点击跳转的本机来源`}
              </div>
              <div className={css.emptyCaps}>
                {CAPABILITIES.map(cap => (
                  <span key={cap} className={css.emptyCap}>
                    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="m8.5 12.5 2.4 2.4L15.5 9.5" />
                    </svg>
                    {cap}
                  </span>
                ))}
              </div>
              <div className={css.emptyExHead}>试试这样问</div>
              <div className={css.emptyExGrid}>
                {EXAMPLES.map(ex => (
                  <button
                    key={ex}
                    type="button"
                    className={css.emptyExCard}
                    onClick={() => { setQuestion(ex); clearError(); taRef.current?.focus() }}
                  >
                    <span className={css.emptyExIcon} aria-hidden="true">↗</span>
                    <span className={css.emptyExText}>{ex}</span>
                  </button>
                ))}
              </div>
              <div className={css.emptyHint}>点一张卡片直接填入，或在下方的输入框里自己写</div>
            </div>
          )}
          {/* 消息流：无卡片框 —— 对话即主体内容（用户气泡右对齐 / AI 回答左对齐 + 来源） */}
          {turns.length > 0 && (
            <div className={css.thread}>
              {turns.map((t, i) => (
                t.role === 'user' ? (
                  <div key={i} className={css.chatUser}>
                    <div className={css.chatUserBubble}>{t.text}</div>
                  </div>
                ) : (
                  <div key={i} className={css.chatAi}>
                    <PlanLine plan={t.plan} />
                    <RetrMeta retrieval={t.retrieval} />
                    <div className={css.chatAnswer}>{t.text}</div>
                    <BasisLine basis={t.basis} />
                    {(t.citations?.length ?? 0) > 0 && (
                      <CiteList items={t.citations!} cited={t.citedIndexes} onOpen={onOpenChat} answer={t.text} />
                    )}
                    <AnswerFeedback turn={t} patch={(p) => { patchTurn(i, p) }} />
                    {/* 沉淀入口刻意放在 AnswerFeedback **之外**：后者在没有引用时返回 null，
                        而「把回答存成笔记」跟有没有引用无关，不该一起消失。 */}
                    {t.text.trim().length > 0 && (
                      <div className={css.turnActions}>
                        <button
                          type="button"
                          className={css.distillBtn}
                          title="把这轮回答存成知识笔记；会带上来源会话，出现在「知识社交图谱」里"
                          onClick={() => {
                            const q = questionForTurn(i).trim()
                            setDistill({
                              open: true,
                              title: q ? (q.length > 40 ? q.slice(0, 40) + '…' : q) : '问答沉淀',
                              body: q ? `${t.text}\n\n来源问题：${q}` : t.text,
                              ...(q ? { question: q } : {}),
                            })
                          }}
                        >
                          📝 沉淀为笔记
                        </button>
                      </div>
                    )}
                  </div>
                )
              ))}
              {asking && (
                streamText
                  // 流式：已经有增量了就直接展示正在生成的正文（尾部光标表示「还在写」），
                  // 不再显示「正在分析…」——那句话在这时已经过时了。
                  ? (
                    <div className={css.chatAi}>
                      <div className={css.chatAnswer} data-streaming>
                        {streamText}
                        <span className={css.streamCaret} aria-hidden="true" />
                      </div>
                    </div>
                  )
                  : (
                    <div className={css.chatPending}>
                      <span className={css.chatDots} />
                      正在分析问题意图 → 检索本机记录 → 综合生成回答…
                    </div>
                  )
              )}
            </div>
          )}
        </div>
        </div>
      </div>

      {/* ④ 提问区：错误 → 优化建议 → 输入面。三者都属于「本次输入」的上下文，
          紧贴输入框上方，不进入滚动区。 */}
      {error && <div className={`${kitCss.error} ${css.askError}`} role="alert">{error}</div>}
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
            <button type="button" className={css.optApply} onClick={() => { setQuestion(optResult.optimized); setOptResult(null) }}>采用优化</button>
            <button type="button" className={css.optDismiss} onClick={() => { setOptResult(null) }}>忽略</button>
          </div>
        </div>
      )}
      {optError && <div className={css.optError} role="alert">{optError}</div>}

      <div className={css.composer}>
        <div className={css.inputRow}>
          <textarea
            ref={taRef}
            className={css.composerInput}
            value={question}
            onChange={(e) => { setQuestion(e.target.value) }}
            onKeyDown={(e) => {
              // Enter 发送、Shift+Enter 换行；输入法组字期间不拦截（中文候选确认用）。
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void ask()
              }
            }}
            placeholder="今天想从聊天记录里查点什么？"
            rows={1}
            aria-label="微信问答问题"
          />
          <button
            type="button"
            className={css.send}
            data-busy={asking || undefined}
            disabled={!question.trim() || asking}
            onClick={() => { void ask() }}
            aria-label="提问"
            title="提问（Enter 发送，Shift+Enter 换行）"
          >
            {asking ? (
              <span className={css.sendSpinner} aria-hidden="true" />
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
            )}
          </button>
        </div>
        <div className={css.composerFooter}>
          <button
            type="button"
            className={css.optBtn}
            onClick={() => { void optimizeQuestion() }}
            disabled={optLoading || !question.trim() || asking}
            title="让 AI 改写问题、给出改进建议（结果内联展示，可一键采用）"
          >
            {optLoading ? '优化中…' : (<><span aria-hidden="true">✨</span>优化提问</>)}
          </button>
          <span className={css.actionHint}>Enter 发送 · Shift+Enter 换行</span>
        </div>
      </div>

      {/* ⑤ 隐私说明：输入框下方次级小字（常驻底部，不随对话滚动） */}
      <div className={css.privacyNote}>🔒 检索在本机完成；AI 生成会把检索片段发送到所选模型（可在「设置 → 数据边界与出网」中关闭出网）</div>
      </div>

      {/* 模型配置已迁到「数据配置」页面（AiModelConfig）：全应用只在那一处设置模型，
          避免同一份 llm.json 在多个面板各配一遍、彼此不一致。 */}

      {/* 检索设置栏：与对话栏并排（同一车道，只在打开时渲染）。 */}
      {retrOpen && (
        <RetrievalPanel open={retrOpen} onClose={() => { setRetrOpen(false) }} containerRef={retrRef} />
      )}

      {/* 「沉淀为笔记」编辑器：sourceKind='ask' + 当前会话范围，构成知识图谱连到人的那条边。 */}
      <KnowledgeNoteEditor
        open={distill.open}
        initialTitle={distill.title ?? ''}
        initialBody={distill.body ?? ''}
        sourceKind="ask"
        {...(scopeUsername ? { sourceUsername: scopeUsername } : {})}
        {...(distill.question ? { sourceQuestion: distill.question } : {})}
        onClose={() => { setDistill({ open: false }) }}
        onSaved={() => { setDistill({ open: false }) }}
      />
      </div>
    </div>
  )
}
