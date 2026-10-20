/**
 * 微信问答面板 — 基于本机聊天记录检索 + DSH LLM 生成回答，引用可点击跳转。
 * 检索在本机完成；AI 生成会调用当前配置的模型（出网提示见界面）。
 *
 * ── 界面结构（本轮整体重排）──────────────────────────────
 *  askLayout（单栏；历史上的模型配置/检索设置侧栏均已迁出或移除）
 *   ├─ askPage
 *   │  ① 面板头（固定）   标题 / 说明 / 历史记录 / 清空对话
 *   │  ② 检索上下文条（固定） 语料状态 · 会话范围 · 时间范围 · 回答模型
 *   │  ③ 对话区（滚动）   多轮问答；空态为一张引导卡，内容贴底生长
 *   │  ④ 提问区（固定）   输入框 + 发送（同一个面）+ 次要动作行
 *   │  ⑤ 隐私说明（固定） 12px 次级小字
 *
 * 与上一版的关键差别：
 *  ① 把「会话/时间/模型」三个限定条件从输入框内部提到输入框**上方**的上下文条 ——
 *     输入框只负责输入与发送（三层挤 158px → 两层），限定条件常驻可见、随时可改。
 *  ② 模型配置、检索设置都曾有各自的侧栏，现已全部迁出/移除：模型配置只在
 *     「数据配置」页面配一次，检索参数固化为内置默认（不再暴露给用户）。
 *     这样对话栏在整个宽度区间都不被遮挡（旧实现 <1100px 的覆盖式抽屉实测把发送键
 *     整块盖住、点击被抽屉体截获）。
 *
 * ── 问答历史（本轮新增）────────────────────────────────────
 * 面板头的「历史记录」按钮打开 `AskHistoryDialog`，查看**每一次**问答的完整记录。
 * 记录由后端在回答产出的那一刻自动落库（`query/ask-history.ts`），面板不参与写入：
 * 前端只持有当前线程的 turns，清空对话即丢、关窗即没，靠它存历史必然漏。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiGetLlmConfig, apiGetSessions, apiOptimizeAskQuestion, apiSubmitAskFeedback } from '../api.ts'
import { createAskGate, type AskGate } from './ask-gate.ts'
import type { AskOptimizeResult, AskResult, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { DateRangeField, PanelHeader, Select } from '../ui/kit.tsx'
import { KnowledgeNoteEditor } from './KnowledgeNoteEditor.tsx'
import { useKbScope } from './kb-scope.ts'
import { AskHistoryDialog } from './AskHistoryDialog.tsx'
import { useAskSession, type AskTurn } from './use-ask.ts'
import { AskPending } from './ask-pending.tsx'
import { AskProcess } from './AskProcess.tsx'
import { AnswerBody } from './AnswerBody.tsx'
import { CiteDetailPanel } from './CiteDetailPanel.tsx'
import { useCiteDetail } from './use-cite-detail.ts'
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

/** 上下文条上的统一领标图标：两种限定条件用同一套 13px 线性图标。 */
function ScopeIcon({ kind }: { kind: 'corpus' | 'time' }): React.JSX.Element | null {
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
  return <div className={css.answerBasis}>{basis}</div>
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
const CH_LABEL: Record<string, string> = { sparse: '稀疏', dense: '稠密', structured: '结构化', kb: '知识库' }

/**
 * 检索漏斗行：把「这次回答到底怎么检索出来的」摊开。
 *
 * 为什么值得占一行：用户判断答案可信度时最想知道「系统听懂了没有 / 检索到没有」。
 * 意图 + 各通道命中数 + 召回→窗口漏斗 + 耗时，四段信息一眼可读；
 * 稠密通道被降级（未配置向量模型 / 向量索引未就绪 / 该意图本轮不走稠密）时显式告警，
 * 避免「以为在用向量检索」。
 *
 * ⚠ 文案口径：2026-09-30 应用内出网开关整体移除，此前那句「或『出站拦截』已开启」
 * 已不可能成立（该分支不存在了），留着就是把不存在的机制说给用户听。
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
      {/* W3-6.3：精排是否真的用上。这是独立字段（后端 retrieval.rerank），
          不再从 basis 文本里 parse —— 那句话是给人读的，不适合当数据源。 */}
      {retrieval.rerank && (
        <span
          className={`${rcss.retrChip}${retrieval.rerank.used ? '' : ` ${rcss.retrWarn}`}`}
          title={retrieval.rerank.used
            ? `由 ${retrieval.rerank.model || '模型'} 精排：候选 ${retrieval.rerank.candidates} → 取 ${retrieval.rerank.kept}`
            : (retrieval.rerank.note ?? '本次未启用精排，排序由本机加权给出')}
        >
          {retrieval.rerank.used
            ? `精排 ${retrieval.rerank.model || ''} ${retrieval.rerank.candidates}→${retrieval.rerank.kept}`
            : '精排未启用（本机加权）'}
        </span>
      )}
      {retrieval.denseActive === false && (
        <span className={`${rcss.retrChip} ${rcss.retrWarn}`} title="未配置向量模型、向量索引未就绪，或本次意图不走稠密通道 → 本次仅用本机稀疏与结构化检索">
          稠密通道未生效（纯稀疏）
        </span>
      )}
      {/* W2-6.4：检索索引正在后台建。这一轮用的还是建之前的索引，
          所以这不是「某个通道弱」，而是「检索空间本身不是最新的」——
          所以单开一个 chip 并用告警色调，混进通道说明里会被读成通道坏了。 */}
      {retrieval.indexNote && (
        <span className={`${rcss.retrChip} ${rcss.retrWarn}`} title={retrieval.indexNote}>
          索引更新中
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
  /**
   * 反馈提交的单飞闸（N17）。闸门放 ref（同步、不受渲染时机影响），并在调用点惰性创建。
   *
   * 为什么不能用 `busy`（`useState`）当闸门：React 的状态更新是**异步**的，双击的第二下
   * 落在「`setBusy(true)` 已调用、组件还没重渲染」的窗口里 —— 那时闭包捕获的 `busy` 仍是
   * `false`，两次调用双双放行。这与流式问答（M13，`use-ask.ts`）是同一个「异步状态当同步
   * 闸门」的坑，但**后果更重**：M13 那侧的 host 有兜底，而 host 的 `submitAskFeedback`
   * 既没有单飞也没有去重（复审 grep 实测），重复提交会真的落到后端 ——
   * 两条反馈请求、`patch()`/`setMarking(false)`/`setNote` 各写两遍、权重适配跑两遍。
   * 这里认领轮次 id：只有当前轮才收尾，迟到的旧轮不会把新一轮的 `busy` 置回 false。
   */
  const gateRef = useRef<AskGate | null>(null)

  const submit = useCallback(async (rating: 'up' | 'down', marks?: Record<number, 'useful' | 'useless'>): Promise<void> => {
    const gate = gateRef.current ?? (gateRef.current = createAskGate())
    const ticket = gate.tryStart()
    if (!ticket) return
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
      /**
       * W3-6.5：把「累计反馈次数」说出来。
       *
       * 为什么不是一句机械的「已记录」：用户点完赞踩，最想知道的就是
       * 「我这么多次点评到底改变了什么」。只说权重已更新，他看不出累计，
       * 也就无从判断自己的点评到底没没用。
       * `feedbackTotal` 含刚刚这一条（后端 `all.length`）。
       */
      const n = typeof r.feedbackTotal === 'number' ? r.feedbackTotal : null
      setNote(r.adaptedWeights && n !== null && n > 0
        ? `已记录 · 排序已按你的 ${n} 次反馈调整`
        : (r.adaptedWeights ? '已记录 · 检索权重已更新' : (r.message || '已记录')))
    } catch (e) {
      setNote('提交失败：' + (e as Error).message)
    } finally {
      // 只有当前轮才释放闸门并复位 busy：窗口内的第二次点击根本没开轮（tryStart 返回 null），
      // 不会走到这里，也就不会有第二条请求。
      if (gate.finish(ticket)) setBusy(false)
    }
  }, [turn.retrievalId, turn.citedIndexes, turn.text, patch])

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
        disabled={busy} onClick={() => { void submit('up') }} title="这次回答有帮助">有帮助</button>
      <button type="button" className={rcss.fbBtn} data-on={marking ? 'down' : undefined}
        disabled={busy} onClick={() => { setMarking(v => !v) }}
        title="标出哪些引用没用/有用，帮助系统调优检索">
        待改进{marking ? '（点击收起）' : ''}
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
/**
 * Render the WeChat Q&A panel.
 * @param props.onOpenChat - 消息引用的跳转（打开会话并定位到那条消息）。
 * @param props.onOpenKbFile - 知识库引用的跳转（切到「知识库 · 文件」并选中该文件）。
 * @returns the ask panel element tree.
 */
export function AskPanel({ onOpenChat, onOpenKbFile }: {
  onOpenChat?: (username: string, localId?: number) => void
  /** 不传时文件引用渲染成只读块（绝不拿去开会话）。 */
  onOpenKbFile?: (kbId: number, fileId: number) => void
} = {}): React.JSX.Element {
  // 当前知识库：沉淀为笔记时默认存到这里，编辑器里可以就地改 ——
  // 「沉淀完才发现该归到另一个库」是这个入口最常见的补正，所以这里必须能改。
  const { kbId } = useKbScope()
  const [sessions, setSessions] = useState<readonly WechatSession[]>([])
  /**
   * 当前模型（provider · model）：底部隐私说明要写清"片段会发给谁"。
   * 只说"所选模型"等于没说 —— 用户判断这句话会不会出网、发给哪一支，就靠这一行。
   */
  const [model, setModel] = useState<{ provider: string; model: string } | null>(null)
  /** 会话列表是否已拉取过：用于区分「还没查」与「确实没有可检索会话」。 */
  const [sessionsLoaded, setSessionsLoaded] = useState(false)
  const [scopeUsername, setScopeUsername] = useState('')
  /** 「沉淀为笔记」编辑器：把某轮回答存成知识笔记（prefill 标题/正文/来源问题）。 */
  const [distill, setDistill] = useState<{ open: boolean; title?: string; body?: string; question?: string }>({ open: false })
  /**
   * 「历史记录」弹窗开关。
   *
   * 历史由**后端**在每次回答产出时自动落库（见 `query/ask-history.ts`），
   * 前端不参与写入 —— 前端只持有当前线程的 turns（清空对话即丢、关窗即没），
   * 靠它存历史必然漏。
   */
  const [historyOpen, setHistoryOpen] = useState(false)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [question, setQuestion] = useState('')
  /** 当前会话范围的显示名：写进问答历史，历史列表可直接显示而不用再查会话表。 */
  const scopeDisplayName = scopeUsername
    ? (sessions.find(s => s.username === scopeUsername)?.displayName || scopeUsername)
    : ''
  /** 多轮对话状态（turns/asking/streamText/error）统一由问答 hook 提供。 */
  const { turns, asking, streamText, streamReasoning, streamStages, error, ask: askSession, cancel: cancelSession, reset: resetThread, patchTurn, clearError } = useAskSession({
    ...(scopeUsername ? { scopeUsername } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    source: 'ask',
    // 只有这一处开知识库：会话内问答（SessionAsk）不该把文件掺进「这个群说过什么」。
    useKb: true,
    ...(scopeDisplayName ? { scopeUsernameName: scopeDisplayName } : {}),
  })
  /** 引用详情面板的开关（点正文角标 → 右侧滑出；再点同一条收起）。 */
  const citeDetail = useCiteDetail(turns)
  // 读一次模型配置（读本机 llm.json，很轻）：只用于底部那行"发给谁"。
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const c = await apiGetLlmConfig()
        if (!cancelled) setModel({ provider: c.provider, model: c.model })
      } catch { /* 读不到就不显示具体模型 */ }
    })()
    return () => { cancelled = true }
  }, [])
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
      {/* 单栏布局：检索设置侧栏已移除（检索参数固化为内置默认）。 */}
      <div className={css.askLayout}>
      <div className={css.askPage}>
      <PanelHeader
        title="问答"
        desc="只检索本机，回答带来源"
        actions={(
          <>
            {/* 「历史记录」常驻可见、不受当前对话有无轮次影响 —— 历史是**跨会话累积**的，
                刚打开面板还没提问时，恰恰是最想回看上次问过什么的时刻。 */}
            <button
              type="button"
              className={css.headerHistory}
              data-open-ask-history=""
              onClick={() => { setHistoryOpen(true) }}
              title="查看历史问答记录（每一次问答都会自动保存）"
            >
              <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                <path d="M3 4v4h4" />
                <path d="M12 8v4l3 2" />
              </svg>
              历史记录
            </button>
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
          语料规模（原来的 badge）并进范围控件本身：全部会话 · 128 —— 少一处重复状态。 */}
      <div className={css.contextBar}>
        <span className={css.ctxLabel}>范围</span>
        <div className={css.scopeHost} data-set={scopeUsername ? '' : undefined}>
          <ScopeIcon kind="corpus" />
          <Select
            value={scopeUsername}
            onChange={(v) => { setScopeUsername(v) }}
            options={[
              { value: '', label: sessionsLoaded ? `全部会话 · ${sessions.length}` : '全部会话' },
              ...sessions.map(s => ({ value: s.username, label: s.displayName || s.username })),
            ]}
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
      </div>
      {timeOpen && (
        <div className={css.scopePanel}>
          <DateRangeField
            from={from}
            to={to}
            onFrom={setFrom}
            onTo={setTo}
            onClear={() => { setFrom(''); setTo('') }}
            presets={['today', 'week', 'month', 'last-7', 'last-30']}
            ariaLabel="检索时间范围"
            idFrom="ask-from"
            idTo="ask-to"
          />
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
            <AskEmptyIntro
              noCorpus={noCorpus}
              sessionCount={sessions.length}
              onPick={(ex) => { setQuestion(ex); clearError(); taRef.current?.focus() }}
            />
          )}
          <AskStream
            turns={turns}
            asking={asking}
            streamText={streamText}
            streamReasoning={streamReasoning}
            streamStages={streamStages}
            onStop={cancelSession}
            citeDetail={citeDetail}
            patchTurn={patchTurn}
            questionForTurn={questionForTurn}
            onDistill={setDistill}
          />
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
            {optLoading ? '优化中…' : '优化提问'}
          </button>
          <span className={css.actionHint}>Enter 发送 · Shift+Enter 换行</span>
        </div>
      </div>

      {/* ⑤ 隐私说明：输入框下方次级小字（常驻底部，不随对话滚动）。
          「所选模型」要说清是哪一支：用户判断"这句话会不会发出去、发给谁"就靠这一行。 */}
      <div className={css.privacyNote}>
        检索在本机完成；AI 生成会把检索到的片段（聊天记录与知识库文件）发送到
        {model ? <>「<b>{model.provider} · {model.model}</b>」</> : '当前配置的模型'}
        {model && model.model.trim() === '' ? '（尚未配置，需先在「设置 → AI 大模型」里填写）' : ''}
        （可在「设置 → 数据边界与出网」中关闭出网）
      </div>
      </div>

      {/* 引用详情：`askLayout` 的**直接子元素**（不是 `askPage` 内部）——
          放进 `askPage` 会被当成对话列的内容（实测与对话列重叠 320px）。 */}
      <AskCiteDetail
        detail={citeDetail}
        onOpenChat={onOpenChat}
        onOpenKbFile={onOpenKbFile}
        onArchive={() => { citeDetail.close(); setHistoryOpen(true) }}
      />

      {/* 模型配置已迁到「数据配置」页面（AiModelConfig）：全应用只在那一处设置模型，
          避免同一份 llm.json 在多个面板各配一遍、彼此不一致。 */}

      {/* 「沉淀为笔记」编辑器：sourceKind='ask' + 当前会话范围，构成知识图谱连到人的那条边。
          `allowKbPick`：沉淀时常常才发现该归到另一个库，所以这里要能看见并改目标库。 */}
      <KnowledgeNoteEditor
        kbId={kbId}
        allowKbPick
        open={distill.open}
        initialTitle={distill.title ?? ''}
        initialBody={distill.body ?? ''}
        sourceKind="ask"
        {...(scopeUsername ? { sourceUsername: scopeUsername } : {})}
        {...(distill.question ? { sourceQuestion: distill.question } : {})}
        onClose={() => { setDistill({ open: false }) }}
        onSaved={() => { setDistill({ open: false }) }}
      />

      {/* 「历史记录」弹窗：内容由后端在每次回答产出时自动累积，这里只读 / 删。
          `onAskAgain` 把历史里那条问题填回输入框而**不自动发送** —— 回看历史最常见的
          下一步确实是「再问一遍」，但自动发送会让用户失去改措辞的机会。 */}
      <AskHistoryDialog
        open={historyOpen}
        onClose={() => { setHistoryOpen(false) }}
        onOpenCitation={onOpenChat}
        onAskAgain={(q) => {
          setQuestion(q)
          clearError()
          setHistoryOpen(false)
          taRef.current?.focus()
        }}
      />
      </div>
    </div>
  )
}

/**
 * 空态引导卡（图标 + 标题 + 说明 + 能力行 + 示例问题）。
 *
 * 抽出来的理由与 `AskStream` / `AskCiteDetail` 相同：`AskPanel` 受函数体棘轮管着，
 * 而这张卡有 40 行 JSX。它也是**语义独立**的一节 —— 只在「还没提问」时出现，
 * 与提问、检索、生成全无耦合。
 *
 * @param props.noCorpus - 是否没有可检索的会话（决定说明文案与警示色）。
 * @param props.sessionCount - 可检索会话数（写进说明）。
 * @param props.onPick - 点示例问题（填入输入框并聚焦，**不**自动发送）。
 * @returns 引导卡元素。
 */
function AskEmptyIntro({ noCorpus, sessionCount, onPick }: {
  noCorpus: boolean
  sessionCount: number
  onPick: (ex: string) => void
}): React.JSX.Element {
  return (
    <div className={css.emptyIntro}>
      <div className={css.emptyTitle}>向你的聊天记录提问</div>
      <div className={css.emptySub} data-warn={noCorpus || undefined}>
        {noCorpus
          ? '尚未检测到可检索的会话：请先在「数据配置」中设置数据目录并导入解密库'
          : `${sessionCount} 个会话可检索 · 回答会附上可点击跳转的本机来源`}
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
          <button key={ex} type="button" className={css.emptyExCard} onClick={() => { onPick(ex) }}>
            <span className={css.emptyExText}>{ex}</span>
          </button>
        ))}
      </div>
      <div className={css.emptyHint}>点一张卡片直接填入，或在下方的输入框里自己写</div>
    </div>
  )
}

/**
 * 引用详情面板的**装配壳**（把 hook 的返回值摊成 `CiteDetailPanel` 的 props）。
 *
 * 为什么单独一个组件而不是内联在 `AskPanel` 里：`AskPanel` 受函数体棘轮管着
 * （登记 441 行，只许变小），而这段装配有 6 个 props 要摊 —— 内联会顶穿棘轮。
 * 抽出来之后 `AskPanel` 里只剩一行调用，且「详情面板怎么接」这件事有了名字。
 *
 * @param props.detail - `useCiteDetail` 的返回值。
 * @param props.onOpenChat - 消息引用的跳转（离开问答去会话）。
 * @param props.onOpenKbFile - 知识库引用的跳转。
 * @param props.onArchive - 「归档」回调（推进历史记录）。
 * @returns 详情面板元素。
 */
function AskCiteDetail({ detail, onOpenChat, onOpenKbFile, onArchive }: {
  detail: ReturnType<typeof useCiteDetail>
  onOpenChat?: ((username: string, localId?: number) => void) | undefined
  onOpenKbFile?: ((kbId: number, fileId: number) => void) | undefined
  onArchive: () => void
}): React.JSX.Element {
  return (
    <CiteDetailPanel
      item={detail.item}
      index={detail.ref?.n ?? 0}
      onClose={detail.close}
      {...(onOpenChat ? { onOpenSource: onOpenChat } : {})}
      {...(onOpenKbFile ? { onOpenKbFile } : {})}
      onArchive={onArchive}
    />
  )
}

/**
 * 消息流的**装配壳**（把流式状态摊成 `AskThread` 的 props）。
 *
 * 与 `AskCiteDetail` 同一个理由：`AskPanel` 受函数体棘轮管着，而这里要摊
 * 8 个 props（其中 4 个是流式状态）。抽出来之后 `AskPanel` 里只剩一行调用。
 *
 * @param props.turns - 当前线程的轮次。
 * @param props.asking - 是否正在生成。
 * @param props.streamText - 生成中的正文（流式）。
 * @param props.streamReasoning - 生成中的思考过程（流式）。
 * @param props.streamStages - 生成中的阶段事件（流式）。
 * @param props.onStop - 「停止生成」回调。
 * @param props.citeDetail - 引用详情开关（点角标 → 右侧滑出）。
 * @param props.patchTurn - 就地更新某一轮。
 * @param props.questionForTurn - 取某轮对应的提问。
 * @param props.onDistill - 「沉淀为笔记」回调。
 * @returns 消息流元素。
 */
function AskStream({ turns, asking, streamText, streamReasoning, streamStages, onStop, citeDetail, patchTurn, questionForTurn, onDistill }: {
  turns: AskTurn[]
  asking: boolean
  streamText: string
  streamReasoning: string
  streamStages: React.ComponentProps<typeof AskPending>['streamStages']
  onStop: () => void
  citeDetail: ReturnType<typeof useCiteDetail>
  patchTurn: (index: number, patch: Partial<AskTurn>) => void
  questionForTurn: (idx: number) => string
  onDistill: (v: { open: boolean; title?: string; body?: string; question?: string }) => void
}): React.JSX.Element {
  return (
    <AskThread
      turns={turns}
      asking={asking}
      pendingProps={{ streamText, streamReasoning, streamStages, onStop }}
      onOpenCite={citeDetail.toggle}
      activeCite={citeDetail.ref}
      patchTurn={patchTurn}
      questionForTurn={questionForTurn}
      onDistill={onDistill}
    />
  )
}

/**
 * 消息流（2026-10-16 从 `AskPanel` 抽出）。
 *
 * 抽出的直接原因：`AskPanel` 受 `function-size-ratchet.spec.ts` 的棘轮管着（登记 475 行，
 * 只许变小），而本轮为「像问答产品一样」加了过程时间线之后涨到 477 行 —— 直接顶穿。
 * 这一块（用户气泡 / AI 回答 / 来源 / 反馈 / 沉淀）是**语义独立**的一节：
 * 它只负责「把 turns 渲染出来」，不参与提问、检索、状态管理。
 *
 * @param props.turns - 当前线程的轮次。
 * @param props.asking - 是否正在生成（决定是否渲染 pending 块）。
 * @param props.onDistill - 「沉淀为笔记」的回调（打开编辑器）。
 * @returns 消息流元素；没有轮次时返回 null。
 */
function AskThread({ turns, asking, pendingProps, onOpenCite, activeCite, patchTurn, questionForTurn, onDistill }: {
  turns: AskTurn[]
  asking: boolean
  pendingProps: React.ComponentProps<typeof AskPending>
  /** 点正文角标（轮次下标 + 编号）。 */
  onOpenCite?: ((turn: number, n: number) => void) | undefined
  /** 当前正在看的那条（高亮角标）。 */
  activeCite?: { turn: number; n: number } | null
  patchTurn: (index: number, patch: Partial<AskTurn>) => void
  questionForTurn: (idx: number) => string
  onDistill: (v: { open: boolean; title?: string; body?: string; question?: string }) => void
}): React.JSX.Element | null {
  if (turns.length === 0) return null
  return (
    <div className={css.thread}>
      {turns.map((t, i) => (
        t.role === 'user' ? (
          <div key={i} className={css.chatUser}>
            <div className={css.chatUserBubble}>{t.text}</div>
          </div>
        ) : (
            <div key={i} className={css.chatAi}>
              <AskProcess stages={t.stages} reasoning={t.reasoning} />
              <PlanLine plan={t.plan} />
              <RetrMeta retrieval={t.retrieval} />
              <div className={css.chatAnswer}>
                <AnswerBody
                  text={t.text}
                  {...(t.citations ? { citations: t.citations } : {})}
                  {...(onOpenCite ? { onOpenCite: (n) => { onOpenCite(i, n) } } : {})}
                  {...(activeCite?.turn === i ? { activeCite: activeCite.n } : {})}
                />
              </div>
              {/* 回答脚注：依据 + 反馈 + 沉淀合成一行（旧实现三行 ≈ 90px，现 ≈ 24px）。 */}
              <div className={rcss.answerFoot}>
                <BasisLine basis={t.basis} />
                <div className={rcss.footActions}>
                  <AnswerFeedback turn={t} patch={(p) => { patchTurn(i, p) }} />
                  {/* 沉淀放在 AnswerFeedback **之外**：后者没有引用时返回 null，
                      而「存成笔记」跟有没有引用无关，不该一起消失。 */}
                  {t.text.trim().length > 0 && (
                    <button
                      type="button"
                      className={rcss.distillBtn}
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
                      📝 沉淀
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        ))}
        {asking && <AskPending {...pendingProps} />}
    </div>
  )
}
