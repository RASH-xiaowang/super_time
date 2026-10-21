/**
 * 「把文件摘要存成笔记」的 hook —— 从 `kb-files-panel.tsx` 拆出（单函数行数棘轮）。
 *
 * ## 为什么需要这个动作（2026-10-17）
 *
 * 改前「生成摘要」只把摘要写进文件元数据（`kb_files.summary`），**不会变成笔记** ——
 * 于是「文件 → 笔记 → 图谱」这条链路是断的：用户导入并解析了 195 块内容、
 * 生成了摘要，笔记库却永远是空的、知识图谱里只有文件章节节点。
 *
 * ## 口径
 *
 * · 标题用文件名（去掉扩展名），正文用摘要 + 一句来源说明；
 * · `sourceKind: 'file'` + `sourceFileId` —— 笔记详情能「回到源文件」，
 *   同一文件重复沉淀时也能识别（后端按标题去重，重名会返回错误而不是刷出一堆）；
 * · 没有摘要时**不允许**沉淀：正文为空等于造一条空笔记，不如让用户先生成摘要。
 */
import { useCallback, useState } from 'react'
import { apiExtractKbEntities, apiGetKbFileChunks, apiSaveNote, apiSummarizeKbFile } from '../api.ts'
import type { KbFileChunk, KbFileMeta } from '../types.ts'
import { MAX_CHUNK_PAGE } from './kb-files-support.tsx'

/** 阅读器状态（与 `kb-files-detail.tsx` 的 `KbFileReaderState` 同形）。 */
export interface ReaderState {
  fileId: number
  items: KbFileChunk[]
  total: number
  totalChars: number
  loading: boolean
  error: string | null
}

/**
 * 读某个文件的**全部**正文块 —— 自动循环拉完，用户不用手动点「继续加载」。
 *
 * ## 为什么是循环而不是一次取完（2026-10-17 用户要求）
 *
 * 后端单次上限 `MAX_CHUNK_PAGE = 200`，而单文件上限是两万块 ——
 * 一次全取会把几十万字塞进一次 IPC 响应，主进程序列化 + 渲染进程反序列化
 * 会卡住整个面板（这正是当初分页的原因）。
 *
 * 所以：**按 200 一块地循环拉，直到取完**。用户看到的是「一次加载」，
 * 底层仍是分页 —— 每轮之间让出一次事件循环，界面不会假死。
 *
 * ## 两个必须核对的地方
 *
 * · **每轮都要核对 `fileId`**：一次取数在路上时用户可能已经点到别的文件、
 *   甚至切了库，不核对就会把甲的正文拼到乙的标题下面。
 * · **发现 `fileId` 变了就立刻停**，不再继续拉 —— 否则用户点得快时
 *   会有一串废弃请求在后台跑，把新文件的首屏挤慢。
 *
 * ⚠️ 用 `readerRef` 而不是把 `reader` 放进依赖：`loadChunks` 的身份要稳定，
 * 否则详情区每次重渲染都会拿到一个新回调。正文现在只由「查看正文」显式触发，
 * 依赖 `reader` 仍会让回调在加载过程中反复换身份，徒增无效渲染。
 * @param kbId - 当前知识库。
 * @param deps - 面板提供的状态读写。
 * @returns 一个 `(fileId) => Promise<void>` 回调。
 */
export function useLoadAllChunks(kbId: number, deps: {
  readerRef: { current: ReaderState | null }
  setReader: (fn: (prev: ReaderState | null) => ReaderState | null) => void
}): (fileId: number) => Promise<void> {
  const { readerRef, setReader } = deps
  return useCallback(async (fileId: number): Promise<void> => {
    setReader(() => ({ fileId, items: [], total: 0, totalChars: 0, loading: true, error: null }))
    /** 已取到的块（跨轮累积）。 */
    let acc: KbFileChunk[] = []
    /** 总块数。要等第一轮回来才知道。 */
    let total = 0
    try {
      for (;;) {
        const r = await apiGetKbFileChunks(kbId, fileId, { limit: MAX_CHUNK_PAGE, offset: acc.length })
        // 用户已经切走了 ⇒ 丢弃这一轮，也不再继续拉。
        if (readerRef.current?.fileId !== fileId) return
        if (r.readError !== undefined) {
          setReader(prev => (prev && prev.fileId === fileId
            ? { ...prev, items: acc, total, totalChars: r.totalChars, loading: false, error: r.readError ?? null }
            : prev))
          return
        }
        acc = acc.concat(r.items)
        total = r.total
        // 每轮都推一次：用户能边读边等，而不是盯着一个空壳。
        setReader(prev => (prev && prev.fileId === fileId
          ? { ...prev, items: acc, total, totalChars: r.totalChars, loading: acc.length < total, error: null }
          : prev))
        // 取完了 / 后端这一轮没给新块（防御：`total` 与实际行数不一致时别死循环）。
        if (acc.length >= total || r.items.length === 0) return
      }
    } catch (e) {
      setReader(prev => (prev && prev.fileId === fileId
        ? { ...prev, items: acc, total, loading: false, error: (e as Error).message }
        : prev))
    }
  }, [kbId, readerRef, setReader])
}

/**
 * 按文件 id 记的失败原因（摘要 / 存笔记共用）。
 *
 * ## 为什么不是 `useState<string | null>(null)`（2026-10-17 用户截图实测）
 *
 * 改前面板里是全局一个字符串，而选文件时会清空面板级错误。`runSummary` 成功后调
 * `reload: load` 会重建 snapshot —— 于是「刚设好的错误」可能被紧随其后的清空动作清掉：
 * 用户点了「生成摘要」、模型返回空，界面上**什么都不显示**。
 *
 * 按 id 存之后：错误只属于产生它的那个文件，切文件时自然不串，
 * 也不需要靠 effect 去清 —— 少一个「谁先谁后」的时序依赖。
 * @returns `errors` 是只读 Map，`setError(fileId, null)` 表示清掉该文件的错误。
 */
export function useFileErrors(): {
  errors: ReadonlyMap<number, string>
  setError: (fileId: number, msg: string | null) => void
} {
  const [errors, setErrors] = useState<ReadonlyMap<number, string>>(new Map())
  const setError = useCallback((fileId: number, msg: string | null): void => {
    setErrors((prev) => {
      const next = new Map(prev)
      if (msg === null) next.delete(fileId)
      else next.set(fileId, msg)
      return next
    })
  }, [])
  return { errors, setError }
}

/**
 * 摘要/存笔记的「正在忙哪个文件」+ 失败原因，一起管。
 *
 * 两件事天然同源（都只属于某一个文件、都随该文件的动作起落），
 * 拆成两个 `useState` 只会让面板多两行声明、多一处「谁先清谁后清」的时序。
 * @returns `busyId` 是正在跑的那个文件，`errors` 按文件 id 存失败原因。
 */
export function useFileActionState(): {
  busyId: number | null
  setBusyId: (id: number | null) => void
  errors: ReadonlyMap<number, string>
  setError: (fileId: number, msg: string | null) => void
} {
  const [busyId, setBusyId] = useState<number | null>(null)
  const { errors, setError } = useFileErrors()
  return { busyId, setBusyId, errors, setError }
}

/**
 * 单文件实体抽取的两个状态：正在抽取哪个文件、失败原因是什么。
 *
 * 单独封装是为了让面板在接入新动作时不必再摊开两行解构；忙碌态与错误
 * 都必须与摘要分开，否则两个长调用会互相改写按钮文案。
 * @returns 实体抽取专用的 busy / errors 读写。
 */
export function useEntityExtractState(): {
  busyId: number | null
  setBusyId: (id: number | null) => void
  errors: ReadonlyMap<number, string>
  setError: (fileId: number, msg: string | null) => void
} {
  return useFileActionState()
}

/**
 * 文件详情的三个按钮动作与各自的忙碌态 / 错误。
 *
 * 摘要与实体抽取都可能出网且耗时较长，因此各用一套 busy / errors；
 * 「存为笔记」复用摘要那套错误位（它的前置条件就是摘要）。
 * @param kbId - 当前知识库。
 * @param deps - 提示与重载回调。
 * @returns 面板直接展开给详情组件的动作与状态。
 */
export function useKbFileDetailActions(kbId: number, deps: {
  flash: (msg: string) => void
  reload: () => Promise<void>
}): {
  busySummaryId: number | null
  busyEntityId: number | null
  summaryErrors: ReadonlyMap<number, string>
  entityErrors: ReadonlyMap<number, string>
  runSummary: (f: KbFileMeta) => Promise<void>
  saveAsNote: (f: KbFileMeta) => Promise<void>
  extractEntities: (f: KbFileMeta) => Promise<void>
} {
  const summaryState = useFileActionState()
  const entityState = useEntityExtractState()
  const { flash, reload } = deps
  const { runSummary, saveAsNote } = useFileActions(kbId, {
    setBusyId: summaryState.setBusyId,
    setError: summaryState.setError,
    flash,
    reload,
  })
  const extractEntities = useExtractFileEntities(kbId, {
    setBusyId: entityState.setBusyId,
    setError: entityState.setError,
    flash,
  })
  return {
    busySummaryId: summaryState.busyId,
    busyEntityId: entityState.busyId,
    summaryErrors: summaryState.errors,
    entityErrors: entityState.errors,
    runSummary,
    saveAsNote,
    extractEntities,
  }
}

/**
 * 摘要 + 存为笔记两个动作，一起给。
 *
 * 两者共用同一套「忙碌态 + 按 id 记的错误 + 提示条」，拆成两次调用只是把同一个
 * deps 对象抄两遍 —— 抄的时候漏一个字段（比如 `reload`）编译器不会报，运行时才露。
 * @param kbId - 当前知识库。
 * @param deps - 面板提供的状态回调。
 * @returns `runSummary` 生成摘要，`saveAsNote` 把摘要存成笔记。
 */
export function useFileActions(kbId: number, deps: {
  setBusyId: (id: number | null) => void
  setError: (fileId: number, msg: string | null) => void
  flash: (msg: string) => void
  reload: () => Promise<void>
}): {
  runSummary: (f: KbFileMeta) => Promise<void>
  saveAsNote: (f: KbFileMeta) => Promise<void>
} {
  const runSummary = useSummarizeFile(kbId, deps)
  const saveAsNote = useSaveFileAsNote(kbId, deps)
  return { runSummary, saveAsNote }
}

/**
 * 生成摘要的 hook（从 `kb-files-panel.tsx` 拆出，单函数行数棘轮）。
 *
 * **这是一条出网调用**（发的是该文件前 8,000 字正文）。两道闸都在后端按顺序过
 * （`include_in_rag` → 脱敏与审计），界面上不复制判断，只负责把被拒的原因原样说出来 ——
 * 两处各判一套，迟早会不一致，而不一致的方向一定是界面比后端宽松。
 * @param kbId - 当前知识库。
 * @param deps - 面板提供的状态回调。
 * @returns 一个 `(f) => Promise<void>` 回调。
 */
export function useSummarizeFile(kbId: number, deps: {
  setBusyId: (id: number | null) => void
  /** 按文件 id 记错误 —— 全局一个字符串会被后续 effect 清掉（见面板里的说明）。 */
  setError: (fileId: number, msg: string | null) => void
  flash: (msg: string) => void
  reload: () => Promise<void>
}): (f: KbFileMeta) => Promise<void> {
  const { setBusyId, setError, flash, reload } = deps
  return useCallback(async (f: KbFileMeta): Promise<void> => {
    setBusyId(f.id)
    setError(f.id, null)
    try {
      const r = await apiSummarizeKbFile(kbId, f.id)
      if (!r.ok) { setError(f.id, r.error ?? '生成失败'); return }
      flash('已生成摘要')
      await reload()
    } catch (e) {
      setError(f.id, (e as Error).message)
    } finally {
      setBusyId(null)
    }
  }, [kbId, setBusyId, setError, flash, reload])
}

/**
 * 存为笔记的 hook。
 * @param kbId - 当前知识库。
 * @param deps - 面板提供的状态回调（busy / 错误 / 成功提示）。
 * @returns 一个 `(f) => Promise<void>` 回调。
 */
export function useSaveFileAsNote(kbId: number, deps: {
  setBusyId: (id: number | null) => void
  /** 按文件 id 记错误 —— 全局一个字符串会被后续 effect 清掉（见面板里的说明）。 */
  setError: (fileId: number, msg: string | null) => void
  flash: (msg: string) => void
}): (f: KbFileMeta) => Promise<void> {
  const { setBusyId, setError, flash } = deps
  return useCallback(async (f: KbFileMeta): Promise<void> => {
    const summary = (f.summary ?? '').trim()
    if (summary === '') { setError(f.id, '这份文件还没有摘要 —— 先生成摘要，再存为笔记'); return }
    setBusyId(f.id)
    setError(f.id, null)
    try {
      const title = f.name.replace(/\.[^.]+$/, '') || f.name
      const body = [
        summary,
        '',
        '---',
        `来源文件：${f.name}（${f.charCount.toLocaleString('zh-CN')} 字 / ${f.chunkCount} 块）`,
      ].join('\n')
      const r = await apiSaveNote(kbId, { title, body, tags: '文件沉淀', sourceKind: 'file', sourceFileId: f.id })
      if (!r.ok) { setError(f.id, r.error ?? '存为笔记失败'); return }
      flash(`已存为笔记「${title}」`)
    } catch (e) {
      setError(f.id, (e as Error).message)
    } finally {
      setBusyId(null)
    }
  }, [kbId, setBusyId, setError, flash])
}

/**
 * 抽取单个文件的实体（出网调用）。
 *
 * 复用整库抽取同一条后端链路，只把 `fileIds` 收窄到当前文件、`limit` 设为 1；
 * 后端仍会按 `include_in_rag` 和隐私闸门再判一次。成功后 `apiExtractKbEntities`
 * 会清知识缓存并广播更新，知识图谱无需额外刷新代码。
 *
 * @param kbId - 当前知识库。
 * @param deps - 面板提供的忙碌态、错误与提示回调。
 * @returns `(file) => Promise<void>`。
 */
export function useExtractFileEntities(kbId: number, deps: {
  setBusyId: (id: number | null) => void
  setError: (fileId: number, msg: string | null) => void
  flash: (msg: string) => void
}): (f: KbFileMeta) => Promise<void> {
  const { setBusyId, setError, flash } = deps
  return useCallback(async (f: KbFileMeta): Promise<void> => {
    setBusyId(f.id)
    setError(f.id, null)
    try {
      const r = await apiExtractKbEntities(kbId, { fileIds: [f.id], limit: 1 })
      if (!r.ok) {
        const reason = r.error ?? r.failed[0]?.error ?? '实体提取失败'
        setError(f.id, reason)
        return
      }
      flash(`已提取 ${r.saved} 个实体，已同步到知识图谱`)
    } catch (e) {
      setError(f.id, (e as Error).message)
    } finally {
      setBusyId(null)
    }
  }, [kbId, setBusyId, setError, flash])
}
