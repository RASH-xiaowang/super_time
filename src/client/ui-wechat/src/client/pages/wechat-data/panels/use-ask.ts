/**
 * 问答线程 hook —— 「微信问答」页签与「群聊内 AI 对话」共用同一套问答/流式链路。
 *
 * 抽出来的理由：这段逻辑（流式 id 防串台、历史裁剪、多轮拼装、引用归属）在
 * Ask.tsx 里已有约 80 行且踩过坑（迟到的增量会串进新一轮），再复制一份必然走样。
 *
 * 线程按 `threadKey` 隔离：群聊内 AI 用会话 username 做键，于是每个会话各留一份
 * 上下文；「微信问答」页签用默认键，行为与重构前完全一致。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiAskWechat, apiCancelAsk, remote } from '../api.ts'
import { createAskGate, type AskGate } from './ask-gate.ts'
import { getActiveKbId } from './kb-scope.ts'
import type { AskResult } from '@deepseek-ai/dsh-wechat-data/types'

/** 一轮对话（用户提问或助手回答）。 */
export interface AskTurn {
  role: 'user' | 'assistant'
  text: string
  citations?: AskResult['citations']
  plan?: AskResult['plan']
  /** 回答正文里真正引用到的来源序号（1 基）。 */
  citedIndexes?: number[]
  /** 数据来源说明（条数/会话数/时间跨度），由后端按检索结果算出，非模型生成。 */
  basis?: string
  /** 本轮没检索到任何原文（未调模型）。 */
  insufficient?: boolean
  /** 模型内容无法对应到任何原文，已不予采用。 */
  withheld?: boolean
  /** 多阶段检索统计（意图 / 通道 / 漏斗 / 耗时）。 */
  retrieval?: AskResult['retrieval']
  /** 本轮检索追踪 id：反馈时回传给后端做特征归因。 */
  retrievalId?: string
  /** 反馈结果（undefined = 未反馈）。 */
  feedback?: 'up' | 'down'
  /** 用户逐条标注：引用序号（1 基）→ 有用 / 没用。 */
  marks?: Record<number, 'useful' | 'useless'>
  /** 这一轮被用户主动停止（不是错误，也不该显示成错误）。 */
  stopped?: boolean
  /**
   * 模型的**思考过程**（2026-10-16 新增）。
   *
   * 与 `text`（可见正文）分开存：界面上要能**只收起思考**、只复制正文。
   * 只在模型真的产出 reasoning 时才有值（多数非推理模型没有）。
   */
  reasoning?: string
  /**
   * 流水线各阶段的执行记录（2026-10-16 新增）。
   *
   * 这是「工具调用过程」的数据源：规划 → 检索 → 精排 → 生成 → 核对，
   * 每步有状态（running/done/skipped）与结果摘要。生成中实时更新，完成后定格。
   */
  stages?: AskStage[]
}

/** 流水线的一个阶段（与后端 `wechat-ask/stage` 事件的 payload 同形）。 */
export interface AskStage {
  key: string
  label: string
  status: 'running' | 'done' | 'skipped'
  detail?: string
}

/** hook 选项。 */
export interface UseAskSessionOptions {
  /** 检索范围：限定到某个会话（群聊/单聊内问答）。 */
  scopeUsername?: string
  /** 时间范围（可选）。 */
  from?: string
  to?: string
  /** 线程键：变化即切到另一份独立对话（默认 'default'）。 */
  threadKey?: string
  /**
   * 写进「问答历史」的入口来源：'ask'（微信问答页签）/ 'session'（会话内问答）。
   * 缺省由后端按 'ask' 处理 —— 这里传是为了让历史列表能区分「在哪问的」。
   */
  source?: string
  /** 会话显示名：写进历史记录，列表可直接显示（不必再查会话表）。 */
  scopeUsernameName?: string
  /**
   * 是否把**当前知识库**的文件块一并检索（缺省 false）。
   *
   * 只有「微信问答」页签打开它：会话内问答（`SessionAsk`）的范围是那一场聊天，
   * 往里掺文件会让「这个群里谁说过」答成文件里的内容。
   *
   * 库 id 不在这里传：它在**提问那一刻**读（`getActiveKbId()`）。线程可以跨库续问，
   * 渲染时定格会让第二轮问的还是切库前的那个库。
   */
  useKb?: boolean
}

/** hook 返回值。 */
export interface UseAskSessionResult {
  turns: AskTurn[]
  asking: boolean
  /** 生成中的**全文**（后端按 80ms 节流推送，渲染端整体替换）。 */
  streamText: string
  /** 生成中的**思考全文**（2026-10-16；与 streamText 分开的一条流）。 */
  streamReasoning: string
  /** 生成中的**阶段列表**（2026-10-16；「工具调用过程」的实时数据源）。 */
  streamStages: AskStage[]
  error: string | null
  ask: (question: string) => Promise<void>
  /** 停止当前这一轮的生成（W3-6.1）。幂等，没有在跑的轮次时点它也只是空取消。 */
  cancel: () => void
  /** 清空当前线程。 */
  reset: () => void
  /** 就地更新某一轮（标注引用 / 记录已反馈）。 */
  patchTurn: (index: number, patch: Partial<AskTurn>) => void
  clearError: () => void
}

/**
 * 会话级问答线程。
 * @param options - 检索范围与线程键。
 * @returns 线程状态与操作。
 */
export function useAskSession(options: UseAskSessionOptions = {}): UseAskSessionResult {
  const { scopeUsername, from, to, source, scopeUsernameName, useKb } = options
  const key = options.threadKey ?? 'default'
  const [threads, setThreads] = useState<Record<string, AskTurn[]>>({})
  const [asking, setAsking] = useState(false)
  const [streamText, setStreamText] = useState('')
  /** 生成中的思考全文（2026-10-16）：与 streamText 分开的一条流。 */
  const [streamReasoning, setStreamReasoning] = useState('')
  /** 生成中的阶段列表（2026-10-16）：按 key 就地更新，保持后端推送顺序。 */
  const [streamStages, setStreamStages] = useState<AskStage[]>([])
  const [error, setError] = useState<string | null>(null)
  /** 当前这一轮的流式标识：只有 id 匹配的增量才采纳（避免上一轮的迟到事件串进新一轮）。 */
  const streamIdRef = useRef('')
  /**
   * 生成中的思考 / 阶段的最新快照（2026-10-16）。
   *
   * 为什么用 ref 而不是直接读 state：`ask()` 是 `useCallback`，闭包里的 state 是**发起那一刻**
   * 的值 —— 等 `await apiAskWechat` 返回时，思考与阶段早已被事件更新过好几轮，
   * 读闭包只会拿到空数组（思考过程就丢了）。ref 每次渲染同步，读到的才是最新的。
   */
  const streamReasoningRef = useRef('')
  streamReasoningRef.current = streamReasoning
  const streamStagesRef = useRef<AskStage[]>([])
  streamStagesRef.current = streamStages
  /** 单飞闸（同步、不受渲染时机影响）—— 见 ask 里的说明。 */
  const gateRef = useRef<AskGate | null>(null)

  // 最新线程快照：ask() 里要据它拼多轮历史，直接读 state 会拿到过期闭包。
  const threadsRef = useRef(threads)
  threadsRef.current = threads
  const scopeRef = useRef({ scopeUsername, from, to, source, scopeUsernameName, useKb })
  scopeRef.current = { scopeUsername, from, to, source, scopeUsernameName, useKb }

  /** 流式回答增量：后端把「已生成的全文」按 80ms 节流推过来，这里整体替换。 */
  useEffect(() => {
    const onDelta = (e: Event): void => {
      const d = (e as CustomEvent).detail as { id?: string; text?: string } | null
      if (!d || !d.id || d.id !== streamIdRef.current) return
      if (typeof d.text === 'string') setStreamText(d.text)
    }
    window.addEventListener('dsh-wechat-ask-delta', onDelta)
    return () => { window.removeEventListener('dsh-wechat-ask-delta', onDelta) }
  }, [])

  /**
   * 思考过程增量（2026-10-16）：与回答增量同一套「推全文 + id 防串台」约定，
   * 只是走另一条事件名。分开订阅的理由见 `AskTurn.reasoning`。
   */
  useEffect(() => {
    const onReasoning = (e: Event): void => {
      const d = (e as CustomEvent).detail as { id?: string; text?: string } | null
      if (!d || !d.id || d.id !== streamIdRef.current) return
      if (typeof d.text === 'string') setStreamReasoning(d.text)
    }
    window.addEventListener('dsh-wechat-ask-reasoning', onReasoning)
    return () => { window.removeEventListener('dsh-wechat-ask-reasoning', onReasoning) }
  }, [])

  /**
   * 阶段事件（2026-10-16）：这是「工具调用过程」的实时数据源。
   *
   * 按 `key` **就地更新**而不是追加：同一个阶段会先推 `running` 再推 `done`
   * （带结果摘要），追加会让「检索本机记录」出现两行。顺序由**首次出现**决定，
   * 与后端流水线的实际顺序一致。
   */
  useEffect(() => {
    const onStage = (e: Event): void => {
      const d = (e as CustomEvent).detail as ({ id?: string } & Partial<AskStage>) | null
      if (!d || !d.id || d.id !== streamIdRef.current) return
      if (typeof d.key !== 'string' || typeof d.label !== 'string') return
      const status = d.status === 'running' || d.status === 'done' || d.status === 'skipped' ? d.status : 'running'
      const next: AskStage = { key: d.key, label: d.label, status, ...(typeof d.detail === 'string' ? { detail: d.detail } : {}) }
      setStreamStages(prev => {
        const at = prev.findIndex(s => s.key === next.key)
        if (at < 0) return [...prev, next]
        const copy = prev.slice()
        copy[at] = next
        return copy
      })
    }
    window.addEventListener('dsh-wechat-ask-stage', onStage)
    return () => { window.removeEventListener('dsh-wechat-ask-stage', onStage) }
  }, [])

  const setTurnList = useCallback((k: string, updater: (prev: AskTurn[]) => AskTurn[]): void => {
    setThreads((t) => {
      const cur = t[k] ?? []
      const next = updater(cur)
      if (next === cur) return t
      return { ...t, [k]: next }
    })
  }, [])

  const ask = useCallback(async (question: string): Promise<void> => {
    const q = question.trim()
    if (!q) return
    // 单飞闸放在 ref 里（M13）：原来用闭包里的 `asking` 当闸门，而 React 的状态更新是
    // 异步的 —— 快速连点第二次时组件可能还没重渲染，`asking` 仍是 false，两次调用双双通过；
    // 而先返回的那轮会在 finally 里无条件 setAsking(false)，把仍在生成的那轮标记成已结束。
    const gate = gateRef.current ?? (gateRef.current = createAskGate())
    // 每轮一个流式标识：后端只推这个 id 的增量，上一轮的迟到事件不会被采纳。
    const streamId = gate.tryStart()
    if (!streamId) return
    const k = key
    setAsking(true)
    setError(null)
    setStreamText('')
    setStreamReasoning('')
    setStreamStages([])
    streamIdRef.current = streamId
    const prevTurns = threadsRef.current[k] ?? []
    const history = prevTurns.map(t => ({ role: t.role, content: t.text }))
    setTurnList(k, prev => [...prev, { role: 'user', text: q }])
    try {
      const { scopeUsername: su, from: f, to: t2, source: src, scopeUsernameName: suName, useKb: withKb } = scopeRef.current
      // 知识库 id 在提问这一刻读 —— 见 UseAskSessionOptions.useKb 的说明。
      const kbId = withKb ? getActiveKbId() : 0
      const r = await apiAskWechat({
        question: q,
        streamId,
        // 取消标识与流式标识同源：一轮一个 id，两处都用它（W3-6.1）。
        jobId: streamId,
        ...(su ? { username: su } : {}),
        ...(f ? { from: f } : {}),
        ...(t2 ? { to: t2 } : {}),
        ...(src ? { source: src } : {}),
        ...(suName ? { usernameName: suName } : {}),
        ...(history.length > 0 ? { history } : {}),
        // 只在明确开启时带：不传 = 本次不检索知识库（不是「搜所有库」）
        ...(kbId > 0 ? { kbId } : {}),
      })
      setTurnList(k, prev => [...prev, {
        role: 'assistant',
        text: r.answer,
        citations: r.citations,
        plan: r.plan,
        citedIndexes: r.citedIndexes,
        basis: r.basis,
        insufficient: r.insufficient,
        withheld: r.withheld,
        retrieval: r.retrieval,
        retrievalId: r.retrievalId,
        // 思考过程（2026-10-16）：优先用后端返回的完整版（事件是节流的，末尾可能缺一截），
        // 后端没给（非推理模型）时退回流式累积的那份。
        ...(r.reasoning ?? streamReasoningRef.current.trim() ? { reasoning: r.reasoning ?? streamReasoningRef.current.trim() } : {}),
        // 阶段记录（2026-10-16）：定格成这一轮的过程时间线，历史回看也能展开。
        ...(streamStagesRef.current.length > 0 ? { stages: streamStagesRef.current } : {}),
      }])
    } catch (e) {
      // W3-6.1：用户主动停止**不是错误**。把它显示成红色错误会让「停止生成」这个功能
      // 看起来像把问答弄坏了；这里是把它记成一次正常的收尾（stopped），
      // 与「模型没配上」那类真失败分开。
      const code = (e as { code?: string } | null)?.code
      if (code === 'ASK_CANCELED') {
        setError(null)
        setTurnList(k, prev => [...prev, { role: 'assistant', text: '（已停止生成）', stopped: true }])
      } else {
        setError((e as Error).message)
      }
    } finally {
      // 只有「当前轮」才能释放闸门并清状态。**防御性不变量**：当前接线下这个 false 分支不可达
      // （复审穷举 5 轮共 1920 种交错，0 次出现），保留是因为它是 `finish` 返回 boolean 的意义所在、
      // 且将来若有第二个 finish 调用点就会真的用上。先作废流式标识再清缓冲，迟到增量不会再写进 state。
      if (gate.finish(streamId)) {
        streamIdRef.current = ''
        setStreamText('')
        setStreamReasoning('')
        setStreamStages([])
        setAsking(false)
      }
    }
  }, [key, setTurnList])

  const reset = useCallback((): void => { setTurnList(key, () => []) }, [key, setTurnList])

  /**
   * 停止当前这一轮的生成（W3-6.1）。
   *
   * 幂等且永远可点：闸门释放后再点也只是一次「找不到那一轮」的空取消（后端会如实说
   * 它已经结束了），不会抛错。没有在跑的轮次时按钮本就不该出现（由 asking 决定）。
   */
  const cancel = useCallback((): void => {
    const id = streamIdRef.current
    if (!id) return
    void (async (): Promise<void> => {
      try {
        await apiCancelAsk({ jobId: id })
      } catch { /* 取消失败不抛给用户：这一轮自己会跑完，界面照常显示结果 */ }
    })()
  }, [])

  const patchTurn = useCallback((index: number, patch: Partial<AskTurn>): void => {
    setTurnList(key, prev => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)))
  }, [key, setTurnList])

  const clearError = useCallback((): void => { setError(null) }, [])

  return {
    turns: threads[key] ?? [],
    asking,
    streamText,
    streamReasoning,
    streamStages,
    error,
    ask,
    cancel,
    reset,
    patchTurn,
    clearError,
  }
}
