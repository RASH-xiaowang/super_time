/**
 * 逐条分析的数据钩子：**只算滚动到可见窗口里的那几条**。
 *
 * ## 为什么是「可见驱动」而不是「全量预跑」
 * 单次推理实测 0.4–0.7 s。一个会话上千条消息，全量预跑就是几分钟的 CPU 占用，
 * 而且绝大多数消息用户根本不会看。所以：滚动到哪就算哪，算过的落库缓存
 * （`<数据根>/laya_analysis.db`），滚回去直接命中、不再推理。
 *
 * ## 几个必须处理的细节
 * - **只算对方的消息**：判断「意图 / 情绪」对「我自己说的话」没有意义，也省一半算力。
 * - **只算文本与语音**：图片/文件/系统消息没有可分析的文本（语音会先转写成文本）。
 * - **去重与在飞去重**：虚拟化列表同一行会反复重渲染，必须用 `inflight` 挡住重复请求。
 * - **滚动中不打断**：请求前 debounce，避免快速滚动时打出一串短请求。
 * - **一次最多 12 条**（后端的批次上限），剩下的等这批回来再发 —— effect 依赖 `map`，
 *   所以「算完一批 → 自动看下一批」是自然发生的，不需要队列。
 *
 * ## 关于开关（2026-09-26 起不再有）
 * 本钩子曾有个 `enabled` 参数，由会话工具区的「决策分析」按钮控制。那个按钮与「右栏面板
 * 打不打开」互不知情 —— 实测关掉右栏后推理照跑，结果无人看（白烧 CPU，单次 0.44–0.63 s）。
 * 分析的唯一展示位置就是右栏面板，而面板自带开关，两个开关管同一件事的两半只会让人困惑。
 * 所以按钮与参数一并移除，**推理恒开**（用户明确选择）。缓存仍在，重复的不重算；
 * 若将来要恢复开关，请让它跟「右栏分析区是否真的会渲染」用同一个条件，别再各管一半。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiAnalyzeVisibleMessages } from '../api.ts'
import { renderKindOf, type MessageRenderItem } from '../utils/message-items.ts'
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
    /**
     * 「信息不足」标注：源文本太短、判断主要来自上下文（后端 `isLowConfidenceText` 判定）。
     * 界面据此补一句「仅供参考」——**不改判断本身**，只是不让人把随机结果当成确定结论。
     */
    lowConfidence?: boolean
  }

export interface InlineAnalysisOption {
  /** 会话 username；换会话清空所有状态。 */
  talker: string
  /** 虚拟行（与列表渲染用的是同一份）。 */
  items: readonly MessageRenderItem[]
  /** 虚拟化器：只用它的 `getVirtualItems()` 判断当前可见区间。 */
  virtualizer: { getVirtualItems(): ReadonlyArray<{ index: number }> }
}

export interface InlineAnalysisApi {
  /** 取某条消息的分析状态（没有就是还没轮到它）。 */
  get: (localId: number) => InlineAnalysisEntry | undefined
  /** 当前在飞的条数（UI 顶部提示「分析中 N」）。 */
  pending: number
  /** 已完成的条数（供「本次看到 X 条」这类提示）。 */
  done: number
}

/** 一次请求最多带多少条（与后端 `MAX_ANALYZE_BATCH` 对齐）。 */
const MAX_BATCH = 12
/** 滚动停止多久后才发请求。 */
const DEBOUNCE_MS = 380

export function useInlineAnalysis(option: InlineAnalysisOption): InlineAnalysisApi {
  const [map, setMap] = useState<Map<number, InlineAnalysisEntry>>(() => new Map())
  const inflight = useRef<Set<number>>(new Set())
  /** 换会话时作废旧响应（避免把上一个会话的结果写进来）。 */
  const epoch = useRef(0)

  useEffect(() => {
    epoch.current += 1
    inflight.current.clear()
    setMap(new Map())
  }, [option.talker])

  const { talker, items, virtualizer } = option

  useEffect(() => {
    if (talker === '') return

    // 1) 收集可见区间里「该算且还没算」的目标
    const targets: Array<{ localId: number; sortSeq: number }> = []
    const virtual = virtualizer.getVirtualItems()
    for (const vi of virtual) {
      const item = items[vi.index]
      if (item === undefined || item.kind !== 'msg') continue
      const m = item.m
      if (m.isSender === 1) continue
      const kind = renderKindOf(m)
      if (kind !== 'text' && kind !== 'voice') continue
      const sortSeq = Number(m.sortSeq ?? 0)
      if (!Number.isFinite(sortSeq) || sortSeq <= 0) continue
      if (map.has(m.localId) || inflight.current.has(m.localId)) continue
      targets.push({ localId: m.localId, sortSeq })
      if (targets.length >= MAX_BATCH) break
    }
    if (targets.length === 0) return

    // 2) 滚动停止后再发（滚动过程中反复清理定时器）
    const myEpoch = epoch.current
    const timer = window.setTimeout(() => {
      if (myEpoch !== epoch.current) return
      for (const t of targets) inflight.current.add(t.localId)
      setMap((prev) => {
        const next = new Map(prev)
        for (const t of targets) if (!next.has(t.localId)) next.set(t.localId, { state: 'pending' })
        return next
      })
      void apiAnalyzeVisibleMessages({ talker, targets })
        .then((res) => {
          if (myEpoch !== epoch.current) return
          setMap((prev) => {
            const next = new Map(prev)
            for (const it of res.items) {
              if (it.ok && it.answers.length > 0) {
                next.set(it.localId, {
                  state: 'done', answers: it.answers, sourceText: it.sourceText,
                  fromVoice: it.fromVoice, inferenceMs: it.inferenceMs, cached: it.cached,
                  lowConfidence: it.lowConfidence === true,
                })
              } else {
                next.set(it.localId, { state: 'error', error: it.error ?? '分析失败' })
              }
            }
            return next
          })
        })
        .catch((e: unknown) => {
          if (myEpoch !== epoch.current) return
          setMap((prev) => {
            const next = new Map(prev)
            for (const t of targets) next.set(t.localId, { state: 'error', error: (e as Error).message })
            return next
          })
        })
        .finally(() => {
          for (const t of targets) inflight.current.delete(t.localId)
        })
    }, DEBOUNCE_MS)

    return () => { window.clearTimeout(timer) }
    // map 进依赖是**有意**的：一批算完 → 重新收集 → 自动接着算下一批
  }, [talker, items, virtualizer, map])

  const get = useCallback((localId: number): InlineAnalysisEntry | undefined => map.get(localId), [map])
  let pending = 0
  let done = 0
  for (const v of map.values()) {
    if (v.state === 'pending') pending += 1
    else if (v.state === 'done') done += 1
  }
  return { get, pending, done }
}
