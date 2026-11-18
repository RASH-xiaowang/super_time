/**
 * 单条消息分析的状态机（「选中即分析」）。
 *
 * ## 为什么只分析选中的一条
 *
 * 旧实现随消息流滚动自动分析可见窗口里的所有对方消息。两个用户可见的问题：
 *   · 点开面板时想看的可能还没轮到，界面只能显示「还没轮到这条」；
 *   · 滚动会顺带触发多次推理，而用户根本没打开分析区。
 * 现在只分析**当前选中的一条**：点消息或打开面板后立即取结果，滚动不再触发。
 *
 * ## 为什么保留全局单飞与间隔
 *
 * 每次分析都是一次真实的大模型调用（花钱、占请求配额）。用户快速切换多条消息时，
 * 只在上一次结束后启动下一次，并保持一个最小间隔 —— 这是纯函数口径，
 * 便于测试，也避免连点造成一串并发请求。
 *
 * @module panels/use-inline-analysis
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiAnalyzeMessage } from '../api.ts'
import type { MessageAnalysisResult } from '@deepseek-ai/dsh-wechat-data/types'

/** 一条消息的分析状态。 */
export type InlineAnalysisEntry =
  | { state: 'pending' }
  | { state: 'error'; error: string }
  | { state: 'done'; result: MessageAnalysisResult }

/** 当前要分析的消息。 */
export interface InlineAnalysisTarget {
  localId: number
  sortSeq: number
}

/** 两次调用之间的最小间隔（毫秒）。 */
export const ANALYSIS_GAP_MS = 120
/** 单会话内存缓存的条数上限；超出按最久未用淘汰。 */
export const ANALYSIS_CACHE_LIMIT = 160

let analyzeInFlight = false
let lastAnalyzeDoneAt = 0

/**
 * 判断这次请求是否应该让路（纯函数，供测试直接钉住）。
 * @param now - 当前时刻（毫秒）。
 * @param inFlight - 是否有请求在跑。
 * @returns true 表示应先排队等待。
 */
export function deferInlineAnalysis(now: number, inFlight: boolean): boolean {
  if (inFlight) return true
  return now - lastAnalyzeDoneAt < ANALYSIS_GAP_MS
}

/** 测试用：重置模块级单飞与节流状态。 */
export function __resetInlineAnalysisGateForTest(): void {
  analyzeInFlight = false
  lastAnalyzeDoneAt = 0
}

/**
 * 写入一条分析结果并维持容量上限（纯函数，便于单测）。
 *
 * `Map` 的插入顺序就是 LRU 顺序：先删再插，保证「再次查看同一条」也会被移到最新端；
 * 超出上限时从最早插入的一端淘汰。
 * @param prev - 现有表。
 * @param localId - 消息 localId。
 * @param entry - 新状态。
 * @param limit - 容量上限。
 * @returns 新的表（不修改入参）。
 */
export function rememberInlineAnalysis(
  prev: ReadonlyMap<number, InlineAnalysisEntry>,
  localId: number,
  entry: InlineAnalysisEntry,
  limit = ANALYSIS_CACHE_LIMIT,
): Map<number, InlineAnalysisEntry> {
  const next = new Map(prev)
  next.delete(localId)
  next.set(localId, entry)
  while (next.size > Math.max(1, limit)) {
    const oldest = next.keys().next()
    if (oldest.done === true) break
    next.delete(oldest.value)
  }
  return next
}

export interface InlineAnalysisOption {
  /** 会话 username；换会话清空所有状态。 */
  talker: string
  /** `null` 表示分析区不可见或尚未选中消息。`sortSeq <= 0` 同样视为不可分析。 */
  target: InlineAnalysisTarget | null
}

export interface InlineAnalysisApi {
  /** 取某条消息的分析状态。 */
  get: (localId: number) => InlineAnalysisEntry | undefined
  /** 当前目标是否正在做强制重算。 */
  refreshing: boolean
  /** 失败后重试当前目标。 */
  retry: (localId: number) => void
  /** 忽略缓存、重新分析当前目标。 */
  refresh: (localId: number) => void
}

interface RunOptions {
  talker: string
  target: InlineAnalysisTarget
  force: boolean
}

/**
 * 管理单条消息分析。
 * @param option - 会话与当前目标。
 * @returns 读取、重试与重算入口。
 */
export function useInlineAnalysis(option: InlineAnalysisOption): InlineAnalysisApi {
  const { talker, target } = option
  const [entries, setEntries] = useState<Map<number, InlineAnalysisEntry>>(() => new Map())
  const [refreshing, setRefreshing] = useState(false)
  const talkerRef = useRef(talker)
  /** 已被用户显式强制重算过的 localId：失败后不再自动重试，避免成环。 */
  const forcedRef = useRef<Set<number>>(new Set())
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    return () => { aliveRef.current = false }
  }, [])

  // 换会话：整张表作废（localId 只在会话内唯一）。
  useEffect(() => {
    if (talkerRef.current === talker) return
    talkerRef.current = talker
    forcedRef.current = new Set()
    setEntries(new Map())
    setRefreshing(false)
  }, [talker])

  const remember = useCallback((localId: number, entry: InlineAnalysisEntry): void => {
    setEntries((prev) => rememberInlineAnalysis(prev, localId, entry))
  }, [])

  const run = useCallback(async (input: RunOptions): Promise<void> => {
    const { talker: runTalker, target: runTarget, force } = input
    if (runTarget.sortSeq <= 0) return
    // 已经在跑或刚跑完就等下一拍：每次调用都是真实计费的模型请求。
    while (deferInlineAnalysis(Date.now(), analyzeInFlight)) {
      await new Promise<void>((resolve) => { setTimeout(resolve, ANALYSIS_GAP_MS / 2) })
      if (!aliveRef.current) return
    }
    if (talkerRef.current !== runTalker) return
    analyzeInFlight = true
    if (force) setRefreshing(true)
    remember(runTarget.localId, { state: 'pending' })
    try {
      const result = await apiAnalyzeMessage({
        talker: runTalker,
        localId: runTarget.localId,
        sortSeq: runTarget.sortSeq,
        ...(force ? { force: true } : {}),
      })
      if (!aliveRef.current || talkerRef.current !== runTalker) return
      if (!result.ok || result.analysis === undefined) {
        remember(runTarget.localId, {
          state: 'error',
          error: result.error ?? '分析失败，请重试',
        })
        return
      }
      remember(runTarget.localId, { state: 'done', result })
    } catch (e) {
      if (!aliveRef.current || talkerRef.current !== runTalker) return
      if (force) forcedRef.current.delete(runTarget.localId)
      remember(runTarget.localId, {
        state: 'error',
        error: e instanceof Error ? e.message : String(e),
      })
    } finally {
      analyzeInFlight = false
      lastAnalyzeDoneAt = Date.now()
      if (aliveRef.current) setRefreshing(false)
    }
  }, [remember])

  // 目标变化即分析；已有结果（同会话）不重复请求。
  useEffect(() => {
    if (target === null) return
    const existing = entries.get(target.localId)
    if (existing !== undefined) {
      // 失败过的目标不自动重试：用户已经看到错误，重试是显式动作。
      if (existing.state === 'error' && !forcedRef.current.has(target.localId)) return
      if (existing.state === 'done') return
      if (existing.state === 'pending') return
    }
    forcedRef.current.delete(target.localId)
    void run({ talker, target, force: false })
  }, [entries, run, talker, target])

  const retry = useCallback((localId: number): void => {
    if (target === null || target.localId !== localId) return
    forcedRef.current.add(localId)
    void run({ talker: talkerRef.current, target, force: false })
  }, [run, target])

  const refresh = useCallback((localId: number): void => {
    if (target === null || target.localId !== localId) return
    forcedRef.current.add(localId)
    void run({ talker: talkerRef.current, target, force: true })
  }, [run, target])

  const get = useCallback(
    (localId: number): InlineAnalysisEntry | undefined => entries.get(localId),
    [entries],
  )

  return { get, refreshing, retry, refresh }
}
