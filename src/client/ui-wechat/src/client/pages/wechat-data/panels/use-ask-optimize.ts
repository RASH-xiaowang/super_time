/**
 * 提问优化请求的**范围绑定**状态。
 *
 * 优化请求没有流式 id，旧实现直接把结果写进组件 state：用户切到另一个会话或
 * 另一段时间范围后，迟到的那份建议会被当成新范围的建议展示，甚至被一键采用。
 * 这里把每次请求绑定到发起时的范围键，并在范围变化时同时作废在途请求与旧结果。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiOptimizeAskQuestion } from '../api.ts'
import type { AskOptimizeResult } from '@deepseek-ai/dsh-wechat-data/types'

/** 优化请求的范围参数。 */
export interface AskOptimizeScope {
  /** 范围稳定键；变化即丢弃旧结果与在途响应。 */
  scopeKey: string
  username?: string
  from?: string
  to?: string
}

/** 传给优化器的历史轮次。 */
export interface AskOptimizeHistoryTurn {
  role: 'user' | 'assistant'
  text: string
}

interface OptimizeState {
  scopeKey: string
  loading: boolean
  result: AskOptimizeResult | null
  error: string | null
}

/** 某一轮优化在 UI 上应看到的完整状态。 */
export interface AskOptimizeState {
  loading: boolean
  result: AskOptimizeResult | null
  error: string | null
  optimize: (question: string, history: readonly AskOptimizeHistoryTurn[]) => Promise<void>
  dismiss: () => void
}

/**
 * 运行提问优化；结果只对发起时的范围可见。
 * @param scope - 当前检索范围。
 * @returns 优化状态与操作。
 */
export function useAskOptimize(scope: AskOptimizeScope): AskOptimizeState {
  const scopeRef = useRef(scope.scopeKey)
  scopeRef.current = scope.scopeKey
  const clearedScopeRef = useRef(scope.scopeKey)
  const seqRef = useRef(0)
  const empty = useCallback((scopeKey: string): OptimizeState => ({
    scopeKey,
    loading: false,
    result: null,
    error: null,
  }), [])
  const [state, setState] = useState<OptimizeState>(() => empty(scope.scopeKey))

  useEffect(() => {
    if (clearedScopeRef.current === scope.scopeKey) return
    clearedScopeRef.current = scope.scopeKey
    seqRef.current += 1
    setState(empty(scope.scopeKey))
  }, [empty, scope.scopeKey])

  const optimize = useCallback(async (
    question: string,
    history: readonly AskOptimizeHistoryTurn[],
  ): Promise<void> => {
    const q = question.trim()
    if (q === '') return
    const key = scope.scopeKey
    const seq = seqRef.current + 1
    seqRef.current = seq
    setState({ scopeKey: key, loading: true, result: null, error: null })
    try {
      const rows = history.map(turn => ({ role: turn.role, content: turn.text }))
      const result = await apiOptimizeAskQuestion({
        question: q,
        ...(scope.username ? { username: scope.username } : {}),
        ...(scope.from ? { from: scope.from } : {}),
        ...(scope.to ? { to: scope.to } : {}),
        ...(rows.length > 0 ? { history: rows } : {}),
      })
      if (seq !== seqRef.current || scopeRef.current !== key) return
      setState({ scopeKey: key, loading: false, result, error: null })
    } catch (e) {
      if (seq !== seqRef.current || scopeRef.current !== key) return
      const setError = (message: string): void => {
        setState({ scopeKey: key, loading: false, result: null, error: message })
      }
      setError('优化失败：' + (e as Error).message)
    }
  }, [scope.scopeKey, scope.username, scope.from, scope.to])

  const dismiss = useCallback((): void => {
    const key = scopeRef.current
    // Also invalidate an in-flight request: "清空对话" must not be followed by a
    // suggestion from the thread the user just cleared.
    seqRef.current += 1
    setState(prev => (prev.scopeKey === key ? { ...prev, loading: false, result: null, error: null } : prev))
  }, [])

  const visible = state.scopeKey === scope.scopeKey ? state : empty(scope.scopeKey)
  return { loading: visible.loading, result: visible.result, error: visible.error, optimize, dismiss }
}
