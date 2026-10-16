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
import { apiAnalyzeVisibleMessages, apiCancelLayaAnalysis } from '../api.ts'
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
  /**
   * W3-11.5：本批分析的进度（`done` 含命中的缓存条目）；没有批在跑时为 null。
   *
   * 为什么需要它：整批实测**均 36s / 峰值 110s**，此前界面只有一个「本地分析中…」——
   * 用户分不清在跑还是卡死，也不敢切走。进度让等待变成可读的「正在分析 3/12」。
   */
  progress: { done: number; total: number } | null
  /**
   * W3-11.5 取消：停止当前那批分析。
   *
   * 没有批在跑时是个**空操作**（而不是报错）—— 用户点它只可能是因为看见「分析中」，
   * 而那一瞬可能刚好算完了，那本来就不需要停止。
   */
  cancel: () => Promise<void>
  /** 「已停止（算出 N/M）」的收尾回执（没有则为 null）。 */
  stopped: { done: number; total: number } | null
  /** 「停止分析」没停上的原因（空串 = 没有问题）。 */
  stopError: string
  /**
   * W3-11.5 收尾：重试某一条失败的消息。
   *
   * 与 `cancel` 相反，它是**同步**的（不用等请求结束）：界面立刻把这条翻成「分析中…」，
   * 真正的成败随下一批的结果回来。点一个已经在跑 / 已有结果的条目是无操作。
   */
  retry: (localId: number) => void
}

/**
 * 一次请求最多带多少条（与后端 `MAX_ANALYZE_BATCH` 对齐的上限之内）。
 *
 * ⚠️ 2026-09-29 由 **12 降到 4**：真机实测（方法与读数记在 `inline-analysis-gate.spec.ts` 顶部）
 * 一次 `analyzeVisibleMessages` 要 **7.8 秒**，而这段时间里**后端 worker 完全被它占住** ——
 * 同窗口打一发本该 2–3 ms 的轻调用，实测要等 **3,523 ms / 3,162 ms**。
 * 用户在日志里看到的 `getSessions 5.3/9.6s`、`getRemoteImages 1.1s × 13`、`getWordCloud 6.9/9.6s`
 * 全是这样被顶出来的（它们本身是缓存命中或毫秒级查询）。
 * 批次越大，一次占住的时间越长 ⇒ 调小批次，让 RPC 队列有插空的机会。
 */
const MAX_BATCH = 4
/** 滚动停止多久后才发请求。 */
const DEBOUNCE_MS = 380

/**
 * 两批之间**至少**隔这么久（毫秒）。
 *
 * 理由同上：推理是同步 ONNX 调用，中途无法让出，只能在批次之间让路。
 * 这段时间足够排在后面的本地查询/图片代理跑完（它们通常是 ms 级）。
 */
const BATCH_GAP_MS = 700

/** 全应用同时只允许**一次**内联分析在飞：多开会话/多开面板时不许并发占满 worker。 */
let analyzeInFlight = false
/** 上一批**结束**的时刻（用于批次间隔）。 */
let lastAnalyzeDoneAt = 0

/**
 * 在当前渲染行里找一条消息的 `sortSeq`（「重试这一条」要靠它重新发请求）。
 *
 * @param items - 当前渲染行（与列表渲染用的是同一份）。
 * @param localId - 要找的消息。
 * @returns 排序游标；这条消息已不在渲染行里时为 undefined（换会话/列表清空）。
 */
export function findSortSeq(items: readonly MessageRenderItem[], localId: number): number | undefined {
  for (const it of items) {
    if (it.kind === 'msg' && it.m.localId === localId) {
      const v = Number(it.m.sortSeq ?? 0)
      return Number.isFinite(v) && v > 0 ? v : undefined
    }
  }
  return undefined
}

/**
 * 收集「本轮该算的目标」——把可见窗口里够格的消息挑出来，**跳过**已算/在飞/本轮豁免的（W3-11.5）。
 *
 * 抽成纯函数不是为了好看：取消后的「一次性豁免」与「重试这一条」的优先位正是这件事的
 * 核心口径，而它们极易被下一轮 effect 的自动重跑吃掉（用户点停止 → 0.5 秒后自己又跑起来）。
 * 判据 `laya-analysis-cancel-gate.spec.ts` 直接喂合成可见窗口验这些口径，不需要渲染组件。
 *
 * @param visible - 可见窗口里的消息（已按渲染顺序）。
 * @param has - 该 localId 是否已在结果表里（已算完 / 失败 / 进行中）。
 * @param inflight - 本次调用期间已在飞的 localId。
 * @param skipOnce - 本轮豁免（上一批被取消时没算到的那几条），用完即弃。
 * @param max - 一次最多收几条（与 `MAX_BATCH` 对齐）。
 * @param pinned - 用户点了「重试」的 localId → sortSeq，排在最前且不看可见窗口。
 * @returns 目标列表（`sortSeq` 非正数等不合格项已被剔除）。
 */
export function collectAnalyzeTargets(
  visible: ReadonlyArray<{ localId: number; sortSeq: number; eligible: boolean }>,
  has: (localId: number) => boolean,
  inflight: ReadonlySet<number>,
  skipOnce: ReadonlySet<number>,
  max: number,
  pinned?: ReadonlyMap<number, number>,
): Array<{ localId: number; sortSeq: number }> {
  const out: Array<{ localId: number; sortSeq: number }> = []
  // ① 用户明确点了「重试」的条目排最前 —— 它们多半已经滚出可见窗口，
  //    而且它们已经带着一个条目（retry 把失败态翻成了 pending），所以 `has` 会把它们滤掉。
  if (pinned !== undefined) {
    for (const [localId, sortSeq] of pinned) {
      if (out.length >= max) break
      if (inflight.has(localId) || skipOnce.has(localId)) continue
      if (!Number.isFinite(sortSeq) || sortSeq <= 0) continue
      out.push({ localId, sortSeq })
    }
  }
  // ② 剩下的名额给可见窗口里自动发现的目标。
  for (const m of visible) {
    if (out.length >= max) break
    if (!m.eligible) continue
    if (!Number.isFinite(m.sortSeq) || m.sortSeq <= 0) continue
    if (has(m.localId) || inflight.has(m.localId) || skipOnce.has(m.localId)) continue
    out.push({ localId: m.localId, sortSeq: m.sortSeq })
  }
  return out
}

/**
 * 让路判定（纯函数，便于单测）：这一批现在该不该推迟、要推多久。
 *
 * 抽出来的理由：这是"别占死 worker"的**唯一**判据，混在 effect 里只能靠读源码确认；
 * 抽成纯函数后可以用真实数字把它钉住（见 `inline-analysis-gate.spec.ts`）。
 * @param now - 当前时刻（ms）。
 * @param inFlight - 是否已有分析在飞。
 * @param lastDoneAt - 上一批结束时刻（ms）；0 表示还没跑过。
 * @param gapMs - 批次最小间隔。
 * @returns `defer=false` → 可以立刻发；否则等 `waitMs` 毫秒再试。
 */
export function deferInlineAnalysis(
  now: number,
  inFlight: boolean,
  lastDoneAt: number,
  gapMs: number = BATCH_GAP_MS,
): { defer: boolean; waitMs: number } {
  if (inFlight) return { defer: true, waitMs: gapMs }
  const since = now - lastDoneAt
  if (since < gapMs) return { defer: true, waitMs: gapMs - since }
  return { defer: false, waitMs: 0 }
}

export function useInlineAnalysis(option: InlineAnalysisOption): InlineAnalysisApi {
  const [map, setMap] = useState<Map<number, InlineAnalysisEntry>>(() => new Map())
  const inflight = useRef<Set<number>>(new Set())
  /** 换会话时作废旧响应（避免把上一个会话的结果写进来）。 */
  const epoch = useRef(0)
  /** W3-11.5：本批进度。`done` 含命中的缓存条目（那也是"处理完了"）。 */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const progressJobRef = useRef('')
  // 批次序号必须是 ref 而不是局部变量：局部变量每次渲染都从 0 重来，
  // 于是所有批次的 jobId 都是 `laya-1` —— 迟到的事件会被当成当前批的（旧批进度被画回来）。
  const jobSeqRef = useRef(0)
  /** 正在跑那一批的 jobId（空 = 没有批在跑）——「停止分析」的使力点。 */
  const runningJobRef = useRef('')
  /** 取消后本轮豁免的 localId（一次性：下一轮收集取走后清空）。见第 1 步的注释。 */
  const skipOnce = useRef<Set<number>>(new Set())
  /** `map` 的镜像（重试入口要读当前条目，而不能在 updater 里做副作用）。 */
  const mapRef = useRef<Map<number, InlineAnalysisEntry>>(map)
  mapRef.current = map
  /** W3-11.5 收尾：「重试这一条」钉住的条目（下一批优先发，发完即弃）。 */
  const pinned = useRef<Set<number>>(new Set())
  const pinnedSeq = useRef<Map<number, number>>(new Map())
  /** 「已停止（算出 N/M）」的收尾回执；下一次开跑时清掉。 */
  const [stopped, setStopped] = useState<{ done: number; total: number } | null>(null)
  /** 「停止分析」没停上时的原因（空串 = 没有问题）。 */
  const [stopError, setStopError] = useState('')

  // 进度事件：后端按 jobId 推，只认当前这一批（迟到的事件不许把旧批的进度画回来）。
  useEffect(() => {
    const onProgress = (e: Event): void => {
      const d = (e as CustomEvent).detail as { jobId?: string; done?: number; total?: number } | null
      if (!d || !d.jobId || d.jobId !== progressJobRef.current) return
      const done = Number(d.done ?? 0)
      const total = Number(d.total ?? 0)
      if (Number.isFinite(done) && Number.isFinite(total) && total > 0) setProgress({ done, total })
    }
    window.addEventListener('dsh-laya-analysis-progress', onProgress)
    return () => { window.removeEventListener('dsh-laya-analysis-progress', onProgress) }
  }, [])

  useEffect(() => {
    epoch.current += 1
    inflight.current.clear()
    // 换会话也要把「一次性豁免」清掉：上一会话被取消的消息与新会话无关，
    // 留着会让新会话的头几条被白白跳过一轮。
    skipOnce.current = new Set<number>()
    pinned.current = new Set<number>()
    pinnedSeq.current = new Map<number, number>()
    setMap(new Map())
  }, [option.talker])

  const { talker, items, virtualizer } = option

  useEffect(() => {
    if (talker === '') return

    // 1) 收集可见区间里「该算且还没算」的目标
    //
    // `skipOnce` 是**一次性**豁免（用完即弃），来自上一次取消：用户刚点「停止」，
    // 我们把没算到的那几条从 map 删掉好让它们能重算，但那会让本次 effect 立刻把它们
    // 重新收进来再发一批 —— 变成「点停止 → 0.5 秒后自己又跑起来」。
    // 豁免一轮之后再由后续的收集（滚动、切会话、别的条目变化）自然把它们捡回来，
    // 所以不是「永远不算」，只是不给「刚停下的那一批」立刻自己复活。
    // 整轮取走而不是逐个删：收集会在 MAX_BATCH 处 break，剩下那些根本走不到。
    const skips = skipOnce.current
    skipOnce.current = new Set<number>()
    const virtual = virtualizer.getVirtualItems()
    const visible: Array<{ localId: number; sortSeq: number; eligible: boolean }> = []
    for (const vi of virtual) {
      const item = items[vi.index]
      if (item === undefined || item.kind !== 'msg') continue
      const m = item.m
      const kind = renderKindOf(m)
      // 自己发的消息、以及既不是文本也不是语音的（图片/表情/系统提示）都不进内联分析。
      const eligible = m.isSender !== 1 && (kind === 'text' || kind === 'voice')
      visible.push({ localId: m.localId, sortSeq: Number(m.sortSeq ?? 0), eligible })
    }
    // 「重试这一条」钉住的条目**先**占位：用户明确点了的那一条不该排在一堆自动目标后面，
    // 哪怕已经滚出可见窗口（`pinnedSeq` 里存着它当初的 sortSeq）。
    const targets = collectAnalyzeTargets(visible, (id) => map.has(id), inflight.current, skips, MAX_BATCH, pinnedSeq.current)
    // 钉住的条目已进本批 ⇒ 从钉住集合里摘掉（否则它会永远排第一）。
    // 注意不能在收集**之前**清：那会让「刚 retry 完、还没发出去」的那一轮把它丢掉。
    if (pinned.current.size > 0) {
      const sent = new Set(targets.map((t) => t.localId))
      pinned.current = new Set([...pinned.current].filter((id) => !sent.has(id)))
      for (const id of [...pinnedSeq.current.keys()]) if (!pinned.current.has(id)) pinnedSeq.current.delete(id)
    }
    if (targets.length === 0) return

    // 2) 滚动停止后再发（滚动过程中反复清理定时器）
    const myEpoch = epoch.current
    let timer = 0
    let retryTimer = 0
    /**
     * 真正发请求。**发之前先给 worker 让路**（2026-09-29 加）：
     *   · 已经有一批在飞 ⇒ 推迟；
     *   · 距上一批结束不足 {@link BATCH_GAP_MS} ⇒ 推迟到够久。
     * 推迟而不是丢弃：`map` 是 effect 依赖，重跑时会重新收集目标，所以结果不会丢。
     */
    const fire = (): void => {
      if (myEpoch !== epoch.current) return
      const gate = deferInlineAnalysis(Date.now(), analyzeInFlight, lastAnalyzeDoneAt)
      if (gate.defer) {
        retryTimer = window.setTimeout(fire, gate.waitMs)
        return
      }
      for (const t of targets) inflight.current.add(t.localId)
      setMap((prev) => {
        const next = new Map(prev)
        for (const t of targets) if (!next.has(t.localId)) next.set(t.localId, { state: 'pending' })
        return next
      })
      analyzeInFlight = true
      // W3-11.5：本批的进度标识（与导出/问答同一套路：回调过不了 IPC，只能推事件再认领）。
      const jobId = `laya-${String(++jobSeqRef.current)}`
      progressJobRef.current = jobId
      runningJobRef.current = jobId
      setProgress({ done: 0, total: targets.length })
      // 上一次的「已停止」回执到这儿就过期了（新一批正在跑），不清会一直挂着。
      setStopped(null)
      setStopError('')
      void apiAnalyzeVisibleMessages({ talker, targets, jobId })
        .then((res) => {
          if (myEpoch !== epoch.current) return
          // W3-11.5：被取消**不是失败**。已算完的那部分照常进 map（用户能立刻看到结果），
          // 没算的那些退回「还没轮到」——它们下次滚到时会被重新收集，不算被永久跳过。
          if (res.canceled === true) {
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
              // 没算到的那些必须**从 map 里删掉**，而不是留着 `pending`。
              // 留着的话 `map.has(localId)` 会让第 1 步的收集永远跳过它们 ⇒
              // 用户停下来的那几条会永远显示「本地分析中…」，且再也补不上。
              // （这个洞是写这条分支时想到的：注释里先写了「下次滚到时会被重新收集」，
              //   而 `map.has` 那句恰好否掉了它 —— 实现必须跟上注释的承诺。）
              const skipped: number[] = []
              for (const t of targets) {
                if (res.items.some((it) => it.localId === t.localId)) continue
                next.delete(t.localId)
                skipped.push(t.localId)
              }
              skipOnce.current = new Set(skipped)
              return next
            })
            setStopped({ done: res.items.length, total: targets.length })
            return
          }
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
          // 闸门必须在**任何**结局下都放掉，否则一次失败会把内联分析永久卡死。
          analyzeInFlight = false
          lastAnalyzeDoneAt = Date.now()
          for (const t of targets) inflight.current.delete(t.localId)
          // W3-11.5：本批收尾，进度归零（不是置 null —— 那样"刚跑完那一下"会闪回空）。
          if (progressJobRef.current === jobId) setProgress({ done: targets.length, total: targets.length })
          // 槽位必须清掉：否则下一次「停止」会打到上一批那个已经结束的 jobId 上，
          // 后端会说「这一批已经算完了」—— 而当前这批其实正跑着（这条是照导出/问答的教训）。
          if (runningJobRef.current === jobId) runningJobRef.current = ''
        })
    }
    timer = window.setTimeout(fire, DEBOUNCE_MS)

    return () => { window.clearTimeout(timer); window.clearTimeout(retryTimer) }
    // map 进依赖是**有意**的：一批算完 → 重新收集 → 自动接着算下一批
  }, [talker, items, virtualizer, map])

  const get = useCallback((localId: number): InlineAnalysisEntry | undefined => map.get(localId), [map])
  let pending = 0
  let done = 0
  for (const v of map.values()) {
    if (v.state === 'pending') pending += 1
    else if (v.state === 'done') done += 1
  }
  // W3-11.5：只在真的有批在跑时给进度；一批收尾（done===total）后归 null，
  // 所以面板上的"本地分析中…（3/12）"不会出现"停在 12/12"的残留。
  const active = progress !== null && progress.total > 0 && progress.done < progress.total
  const cancel = useCallback((): Promise<void> => {
    const jobId = runningJobRef.current
    if (jobId === '') return Promise.resolve()
    return apiCancelLayaAnalysis({ jobId })
      .then((r) => { if (r.ok !== true && r.message !== undefined) setStopError(r.message) })
      // 取消请求自己失败（IPC 断了等）不该炸掉界面：后端那批该跑完还是跑完，
      // 真正的问题只需要一句提示，用户可以再点一次。
      .catch((e: unknown) => { setStopError((e as Error).message) })
  }, [])
  /**
   * 重试某一条（W3-11.5 收尾）：把它的失败态抹掉，并**钉**进下一批。
   *
   * 为什么不能只抹掉失败态：收集只看**可见窗口**，而用户点「重试」时那条消息
   * 很可能已经滚出窗口了（他是从分析面板点的，那儿一直停在旧选择上）。
   * 只抹不钉 ⇒ 按钮点了没反应，而失败态已经没了 —— 比不给按钮更糟。
   * 钉住的条目在下一批**优先**发出，发完即从钉住集合移除。
   */
  const retry = useCallback((localId: number): void => {
    const cur = mapRef.current.get(localId)
    // 只重试失败态：pending（正在跑）与 done（有结果）都不该被这条入口改写。
    if (cur === undefined || cur.state !== 'error') return
    const seq = findSortSeq(items, localId)
    // 消息已经不在当前渲染行里（切了会话/列表清空）就无处可钉 —— 保持失败态，
    // 不做「抹掉失败态却没人重算」那种更糟的半截状态。
    if (seq === undefined) return
    pinnedSeq.current.set(localId, seq)
    pinned.current = new Set([...pinned.current, localId])
    setMap((prev) => {
      const next = new Map(prev)
      // 立刻翻成 pending：界面上从「分析失败」变成「本地分析中…」，
      // 否则用户会以为按钮没生效，隔一会儿才发现它在跑。
      next.set(localId, { state: 'pending' })
      return next
    })
  }, [items])
  return { get, pending, done, progress: active ? progress : null, stopped, stopError, cancel, retry }
}
