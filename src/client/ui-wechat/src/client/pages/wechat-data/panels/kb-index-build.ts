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
import { useCallback, useRef, useState } from 'react'
import { apiBuildKbVectorIndex, apiCancelKbIndexBuild } from '../api.ts'

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