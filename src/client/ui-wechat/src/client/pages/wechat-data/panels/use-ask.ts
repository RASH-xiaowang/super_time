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
import { apiAskWechat } from '../api.ts'
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
}

/** hook 返回值。 */
export interface UseAskSessionResult {
  turns: AskTurn[]
  asking: boolean
  /** 生成中的**全文**（后端按 80ms 节流推送，渲染端整体替换）。 */
  streamText: string
  error: string | null
  ask: (question: string) => Promise<void>
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
  const { scopeUsername, from, to } = options
  const key = options.threadKey ?? 'default'

  const [threads, setThreads] = useState<Record<string, AskTurn[]>>({})
  const [asking, setAsking] = useState(false)
  const [streamText, setStreamText] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** 当前这一轮的流式标识：只有 id 匹配的增量才采纳（避免上一轮的迟到事件串进新一轮）。 */
  const streamIdRef = useRef('')

  // 最新线程快照：ask() 里要据它拼多轮历史，直接读 state 会拿到过期闭包。
  const threadsRef = useRef(threads)
  threadsRef.current = threads
  const scopeRef = useRef({ scopeUsername, from, to })
  scopeRef.current = { scopeUsername, from, to }

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
    if (!q || asking) return
    const k = key
    setAsking(true)
    setError(null)
    setStreamText('')
    // 每轮一个流式标识：后端只推这个 id 的增量，上一轮的迟到事件不会被采纳。
    const streamId = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    streamIdRef.current = streamId
    const prevTurns = threadsRef.current[k] ?? []
    const history = prevTurns.map(t => ({ role: t.role, content: t.text }))
    setTurnList(k, prev => [...prev, { role: 'user', text: q }])
    try {
      const { scopeUsername: su, from: f, to: t2 } = scopeRef.current
      const r = await apiAskWechat({
        question: q,
        streamId,
        ...(su ? { username: su } : {}),
        ...(f ? { from: f } : {}),
        ...(t2 ? { to: t2 } : {}),
        ...(history.length > 0 ? { history } : {}),
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
      }])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      // 先作废流式标识再清缓冲：迟到的增量不会再写进 state
      streamIdRef.current = ''
      setStreamText('')
      setAsking(false)
    }
  }, [asking, key, setTurnList])

  const reset = useCallback((): void => { setTurnList(key, () => []) }, [key, setTurnList])

  const patchTurn = useCallback((index: number, patch: Partial<AskTurn>): void => {
    setTurnList(key, prev => prev.map((t, i) => (i === index ? { ...t, ...patch } : t)))
  }, [key, setTurnList])

  const clearError = useCallback((): void => { setError(null) }, [])

  return {
    turns: threads[key] ?? [],
    asking,
    streamText,
    error,
    ask,
    reset,
    patchTurn,
    clearError,
  }
}
