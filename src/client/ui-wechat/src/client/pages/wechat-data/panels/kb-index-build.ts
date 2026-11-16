/**
 * 语义索引的**构建与停止**（W3-11.5 从 KbFilesPanel 里搬出）。
 *
 * 搬家原因是函数体棘轮（`function-size-ratchet.spec.ts` 只许变小）：进度/取消两件事
 * 加进面板主体后它长回了 76 行。这里抽成一个自洽的 hook，面板只剩两行 ——
 * 与 `remotes/ask-cancel.ts`、`remotes/kb.kbindex.ts` 同属「给主体腾地方」的结构刀。
 *
 * 两条口径写在这里而不是散在面板里：
 *   · **jobId 必须是 ref 计数**（不是局部变量）：局部变量每次渲染都从 0 重来，
 *     于是所有批次的 jobId 都相同，迟到的事件会被当成当前批；
 *   · **finally 清槽位**：不清的话下一次「停止」会打到上一批那个已经结束的 jobId 上，
 *     后端会说「这次构建已经结束了」—— 而这一批其实正跑着。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiBuildKbVectorIndex, apiCancelKbIndexBuild, apiGetKbVectorIndex } from '../api.ts'
import type { KbVectorIndexView } from '../types.ts'

export interface KbIndexBuildApi {
  /** 本面板发起的那次构建是否在跑（按钮禁用态）。 */
  indexing: boolean
  /** 在跑的 jobId（空 = 没有本面板发起的构建）；「停止」按钮的存在条件。 */
  jobId: string
  /** 失败原因（含「没停上」的原因）。 */
  error: string | null
  /** 建/补齐索引。`force` 时后端先清空**本库**的向量再重算（别的库一行不动）。 */
  run: (force: boolean) => Promise<void>
  /** 停止。没有批在跑时是空操作（用户点它只可能是因为看见按钮，而那一瞬可能刚好建完）。 */
  cancel: () => Promise<void>
}

/**
 * @param kbId - 目标库 id（变了就该重新发起，别复用上一个库的批次）。
 * @param onFlash - 成功/正常收尾的回执出口（面板的 `flash`）。
 * @param onDone - 每次收尾后回调（面板用它重新读索引状态）。
 */
export function useKbIndexBuild(
  kbId: number,
  onFlash: (text: string) => void,
  onDone: () => void,
): KbIndexBuildApi {
  const [indexing, setIndexing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const jobRef = useRef('')
  const seqRef = useRef(0)

  const run = useCallback(async (force: boolean): Promise<void> => {
    if (indexing) return
    const jobId = `kb-index-${String(kbId)}-${String(++seqRef.current)}`
    jobRef.current = jobId
    setIndexing(true)
    setError(null)
    try {
      const r = await apiBuildKbVectorIndex(kbId, force, jobId)
      // 取消不是失败：阶段二没开，旧索引一行未动。
      if (r.status === 'cancelled') return
      if (!r.ok) setError(r.error ?? '建索引失败')
      else onFlash(r.status === 'up-to-date'
        ? `索引已是最新（${r.rows} 块，本次未出网）`
        : `本库向量索引完成：${r.embedded} 块新算 · 共 ${r.rows} 块`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      if (jobRef.current === jobId) jobRef.current = ''
      setIndexing(false)
      onDone()
    }
  }, [indexing, kbId, onFlash, onDone])

  const cancel = useCallback((): Promise<void> => {
    const jobId = jobRef.current
    if (jobId === '') return Promise.resolve()
    return apiCancelKbIndexBuild({ jobId })
      .then((r: { ok: boolean; message?: string }) => {
        if (r.ok !== true && r.message !== undefined) setError(r.message)
      })
      .catch((e: unknown) => { setError('没能停止：' + (e as Error).message) })
  }, [])

  return { indexing, jobId: jobRef.current, error, run, cancel }
}

/** `useKbModelRebuild` 的返回值。 */
export interface KbModelRebuildApi {
  /** 本库索引状态（`null` = 还没读到）。 */
  idx: KbVectorIndexView | null
  /** 外部读取（弹层首屏的 `getKbModelConfig` 同批读一次）写入这里。 */
  setIdx: (view: KbVectorIndexView | null) => void
  /** 本弹层发起的那次重建是否在跑。 */
  indexing: boolean
  /** 清空本库向量并按当前模型重算。 */
  rebuild: () => Promise<void>
  /** 停止本轮重建（没有在跑的批次时是空操作）。 */
  cancel: () => Promise<void>
}

/**
 * 「本库模型」弹层里的**重建 + 进度 + 停止**（从 `KbModelDialog` 搪出：那个函数受
 * 单函数行数棘轮管着，只许变小）。
 *
 * 与 `useKbIndexBuild` 的区别：那边服务于「文件」面板（增量 / 强制两种，错误自持）；
 * 这边服务于模型弹层（总是强制重建、错误交给弹层的 `err` 横幅、且要边跑边读进度）。
 * 两处共用同一组后端契约（`buildKbVectorIndex` / `cancelKbIndexBuild` / jobId 配对）。
 * @param kbId - 目标库。
 * @param onFlash - 成功/正常收尾的回执。
 * @param onError - 写失败原因（传 `null` 清空）。
 */
export function useKbModelRebuild(
  kbId: number,
  onFlash: (text: string) => void,
  onError: (msg: string | null) => void,
): KbModelRebuildApi {
  const [idx, setIdx] = useState<KbVectorIndexView | null>(null)
  const [indexing, setIndexing] = useState(false)
  /** 本弹层发起的那次重建的 jobId（停止按钮只停自己发起的这一轮）。 */
  const jobRef = useRef('')
  const seqRef = useRef(0)

  // 建索引在飞时跟着轮询进度；停下的判据是**后端的 job 消失**，不是本地按钮态。
  const jobOn = idx?.job ? `${idx.kbId}:${idx.job.done}` : ''
  useEffect(() => {
    if (jobOn === '') return
    const t = setInterval(() => { void apiGetKbVectorIndex(kbId).then(setIdx).catch(() => { /* 下一轮再试 */ }) }, 1500)
    return () => { clearInterval(t) }
  }, [jobOn, kbId])

  // 本弹层自己发起的那一轮：`indexing` 为真时也轮询。上面的 job 轮询要等 idx 里出现
  // job，而 idx 只在 rebuild 完成后才重读 —— 于是按钮转圈的整段时间里看不到 done/total。
  useEffect(() => {
    if (!indexing) return
    void apiGetKbVectorIndex(kbId).then(setIdx).catch(() => { /* 下一轮再试 */ })
    const t = setInterval(() => { void apiGetKbVectorIndex(kbId).then(setIdx).catch(() => { /* 下一轮再试 */ }) }, 1200)
    return () => { clearInterval(t) }
  }, [indexing, kbId])

  const rebuild = useCallback(async (): Promise<void> => {
    const jobId = `kb-index-${String(kbId)}-rebuild-${String(++seqRef.current)}`
    jobRef.current = jobId
    setIndexing(true)
    onError(null)
    try {
      const r = await apiBuildKbVectorIndex(kbId, true, jobId)
      // 取消不是失败：阶段二没开，旧索引一行未动。
      if (r.status === 'cancelled') onFlash('已停止重建，旧索引保持原样')
      else if (!r.ok) onError(r.error ?? '重建失败')
      else onFlash(`本库索引已重建：${r.embedded} 块 · ${r.elapsed_ms}ms`)
      setIdx(await apiGetKbVectorIndex(kbId))
    } catch (e) {
      onError((e as Error).message)
    } finally {
      if (jobRef.current === jobId) jobRef.current = ''
      setIndexing(false)
    }
  }, [kbId, onError, onFlash])

  const cancel = useCallback((): Promise<void> => {
    const jobId = jobRef.current
    if (jobId === '') return Promise.resolve()
    return apiCancelKbIndexBuild({ jobId })
      .then((r: { ok: boolean; message?: string }) => {
        if (r.ok !== true && r.message !== undefined) onError(r.message)
      })
      .catch((e: unknown) => { onError('没能停止：' + (e as Error).message) })
  }, [onError])

  return { idx, setIdx, indexing, rebuild, cancel }
}