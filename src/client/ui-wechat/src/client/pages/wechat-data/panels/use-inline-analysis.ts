/**
 * 单条消息的本地决策分析。
 *
 * ## 为什么改成「选中即分析」
 *
 * 旧实现会随着消息流滚动，自动分析可见窗口里的对方消息。这个设计有两个用户可见的问题：
 *   · 点开分析面板时，用户真正想看的那条可能还没轮到，界面只能显示「还没轮到这条」；
 *   · 滚动会顺带触发多条推理，而用户根本没有打开分析区。
 *
 * 现在只分析**当前选中的一条**：点消息或打开面板后立即取结果，滚动不再触发推理。
 * 同一会话里已经看过的结果仍留在内存；磁盘缓存继续由后端按消息与模型指纹命中。
 *
 * ## 为什么保留全局单飞
 *
 * laya 的 ONNX forward 是同步 CPU 段，单次约 0.5–9 秒。即使用户快速切换多条消息，
 * 也只在上一单结束后启动下一单，避免两个长任务同时占住 worker。排队由
 * {@link deferInlineAnalysis} 的纯函数口径控制，便于测试。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiAnalyzeVisibleMessages } from '../api.ts'
import type { LayaAnswer } from '@deepseek-ai/dsh-wechat-data/types'

/** 一条消息的分析状态。 */
export type InlineAnalysisEntry =
  | { state: 'pending' }
  | { state: 'error'; error: string }
  | {
    state: 'done'
    answers: LayaAnswer[]
    /** 被分析的文本（语音则是转写文本）。 */
    sourceText: string
    fromVoice: boolean
    inferenceMs: number
    cached: boolean
    /** 源文本太短：判断主要来自上下文，界面据此提示「信息有限」。 */
    lowConfidence?: boolean
  }

/** 当前要分析的消息。 */
export interface InlineAnalysisTarget {
  localId: number
  sortSeq: number
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

/** 两个分析任务之间至少留出的让路时间。单条推理已经会占满一次 ONNX forward。 */
export const ANALYSIS_GAP_MS = 120

/** 全应用同时只允许一个本地分析在飞。 */
let analyzeInFlight = false
/** 上一单结束时刻；0 表示还没跑过。 */
let lastAnalyzeDoneAt = 0

/**
 * 这一单现在该不该推迟、要推多久。
 * @param now - 当前时刻（ms）。
 * @param inFlight - 是否已有任务在跑。
 * @param lastDoneAt - 上一单结束时刻；0 表示尚未跑过。
 * @param gapMs - 两单之间的最小间隔。
 */
export function deferInlineAnalysis(
  now: number,
  inFlight: boolean,
  lastDoneAt: number,
  gapMs: number = ANALYSIS_GAP_MS,
): { defer: boolean; waitMs: number } {
  if (inFlight) return { defer: true, waitMs: gapMs }
  const since = now - lastDoneAt
  if (lastDoneAt > 0 && since < gapMs) return { defer: true, waitMs: gapMs - since }
  return { defer: false, waitMs: 0 }
}

function errorEntry(error: unknown): InlineAnalysisEntry {
  return { state: 'error', error: error instanceof Error ? error.message : String(error) }
}

/**
 * 分析当前选中消息。
 * @param option - 会话与目标消息；目标为 null 时不发起请求。
 */
export function useInlineAnalysis(option: InlineAnalysisOption): InlineAnalysisApi {
  const [map, setMap] = useState<Map<number, InlineAnalysisEntry>>(() => new Map())
  const [gateTick, setGateTick] = useState(0)
  const epoch = useRef(0)
  const inflight = useRef<Set<number>>(new Set())
  /** 用户明确要求跳过缓存的目标；成功后才移除。 */
  const forced = useRef<Set<number>>(new Set())

  useEffect(() => {
    epoch.current += 1
    inflight.current.clear()
    forced.current.clear()
    setMap(new Map())
  }, [option.talker])

  const target = option.target
  const targetId = target?.localId ?? null
  const targetSeq = target?.sortSeq ?? 0

  useEffect(() => {
    if (option.talker === '' || targetId === null || targetSeq <= 0) return

    const current = map.get(targetId)
    const mustRefresh = forced.current.has(targetId)
    if (current?.state === 'pending' && inflight.current.has(targetId)) return
    if (current?.state === 'done' && !mustRefresh) return
    if (current?.state === 'error' && !mustRefresh) return

    let timer = 0
    const fire = (): void => {
      const gate = deferInlineAnalysis(Date.now(), analyzeInFlight, lastAnalyzeDoneAt)
      if (gate.defer) {
        timer = window.setTimeout(fire, gate.waitMs)
        return
      }

      const myEpoch = epoch.current
      const force = forced.current.has(targetId)
      inflight.current.add(targetId)
      analyzeInFlight = true
      setMap((previous) => {
        const next = new Map(previous)
        next.set(targetId, { state: 'pending' })
        return next
      })

      void apiAnalyzeVisibleMessages({
        talker: option.talker,
        targets: [{ localId: targetId, sortSeq: targetSeq }],
        ...(force ? { force: true } : {}),
      })
        .then((result) => {
          if (myEpoch !== epoch.current) return
          const item = result.items.find((candidate) => candidate.localId === targetId)
          setMap((previous) => {
            const next = new Map(previous)
            if (result.ok && item?.ok === true && item.answers.length > 0) {
              next.set(targetId, {
                state: 'done',
                answers: item.answers,
                sourceText: item.sourceText,
                fromVoice: item.fromVoice,
                inferenceMs: item.inferenceMs,
                cached: item.cached,
                lowConfidence: item.lowConfidence === true,
              })
            } else {
              next.set(targetId, {
                state: 'error',
                error: item?.error ?? result.error ?? '本地分析没有返回结果',
              })
            }
            return next
          })
        })
        .catch((error: unknown) => {
          if (myEpoch !== epoch.current) return
          setMap((previous) => {
            const next = new Map(previous)
            next.set(targetId, errorEntry(error))
            return next
          })
        })
        .finally(() => {
          analyzeInFlight = false
          lastAnalyzeDoneAt = Date.now()
          inflight.current.delete(targetId)
          // 强制标记只属于这一次请求。失败后也必须消费掉，否则 map 变成 error 会再次
          // 满足 mustRefresh，形成「失败 → 自动重试 → 再失败」的无限循环。
          forced.current.delete(targetId)
          // 目标可能已经切换；推进一次重渲染，让排队中的那一条接着发。
          setGateTick((value) => value + 1)
        })
    }

    fire()
    return () => { window.clearTimeout(timer) }
  }, [gateTick, map, option.talker, targetId, targetSeq])

  const get = useCallback((localId: number): InlineAnalysisEntry | undefined => map.get(localId), [map])
  const retry = useCallback((localId: number): void => {
    forced.current.add(localId)
    setMap((previous) => {
      const next = new Map(previous)
      next.delete(localId)
      return next
    })
  }, [])
  const refresh = useCallback((localId: number): void => {
    forced.current.add(localId)
    setMap((previous) => {
      const next = new Map(previous)
      next.delete(localId)
      return next
    })
  }, [])

  const refreshing = targetId !== null
    && forced.current.has(targetId)
    && map.get(targetId)?.state !== 'done'

  return { get, refreshing, retry, refresh }
}
