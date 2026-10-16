
/**
 * Chats 面板的「消息内搜索与索引」（M21 第三十四刀起自 Chats.tsx 拆出）。
 *
 * 原先散在 `ChatsPanel` 的函数体里（几十个 state 与回调），但输入输出很清楚 —— 抽成钩子后：
 * 面板把输入传进来、把用得到的值解构出去，其余细节（轮询、竞态防护、菜单构造）留在模块里。
 * 钩子在面板的**第一条组内声明处**调用 ⇒ 与原来的声明顺序等价。
 */

import type { ChatlogFrame } from './chats-chatlog.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { apiBuildSearchIndex, apiCancelSearchIndexBuild, apiGetSearchIndexStatus, apiSearchMessages } from '../api.ts'
import { desktopAction, desktopActionProps } from '../ui/desktop-only.tsx'
import { useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import type { SearchHit } from '@deepseek-ai/dsh-wechat-data/types'

export interface useChatsMsgSearchInputs {
  cancelActiveSearch: () => void
  chatlogStack: ReadonlyArray<ChatlogFrame>
  editedOpen: boolean
  exportOpen: boolean
  setChatlogStack: React.Dispatch<React.SetStateAction<ChatlogFrame[]>>
  setEditedOpen: React.Dispatch<React.SetStateAction<boolean>>
  setExportOpen: React.Dispatch<React.SetStateAction<boolean>>
}

export function useChatsMsgSearch(inputs: useChatsMsgSearchInputs) {
  const { cancelActiveSearch, chatlogStack, editedOpen, exportOpen, setChatlogStack, setEditedOpen, setExportOpen } = inputs
const [msgHits, setMsgHits] = useState<readonly SearchHit[]>([])
const [msgSearchLoading, setMsgSearchLoading] = useState(false)
const [msgSearchError, setMsgSearchError] = useState<string | null>(null)
const [msgSearched, setMsgSearched] = useState(false)
const [msgIndexed, setMsgIndexed] = useState(true)
const [indexBuilding, setIndexBuilding] = useState(false)
/**
 * W3-11.5：索引构建的进度（`done/total` 是**分片**口径，`rows` 是已入库行数）。
 *
 * 为什么必须有：全量构建是秒级起步（百万行库更久），此前界面上只有一个禁用的
 * 「构建中…」按钮 —— 用户不知道它跑到哪儿，也不敢切走。
 */
const [indexProgress, setIndexProgress] = useState<{ done: number; total: number; rows: number } | null>(null)
/** 在跑的构建的 jobId（「停止构建」的使力点；空 = 没有构建在跑）。 */
const indexJobRef = useRef('')
/** 批次序号必须是 ref（局部变量每渲染重置 ⇒ 所有构建的 jobId 都相同）。 */
const indexJobSeqRef = useRef(0)
const msgSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
const msgSearchSeqRef = useRef(0)
/**
 * 在跑的消息搜索的 jobId（N9）。换关键词/清空/离开面板时用它打断上一轮扫描 ——
 * 后端兜底扫描最长可达秒级，不打断就白占着 worker（用户已经不看结果了）。
 */
const activeSearchJobRef = useRef<string | null>(null)

/** 进度事件：后端按 jobId 推，只认当前这一次构建。 */
useEffect(() => {
  const onProgress = (e: Event): void => {
    const d = (e as CustomEvent).detail as { jobId?: string; done?: number; total?: number; rows?: number } | null
    if (!d || !d.jobId || d.jobId !== indexJobRef.current) return
    const done = Number(d.done ?? 0)
    const total = Number(d.total ?? 0)
    const rows = Number(d.rows ?? 0)
    if (Number.isFinite(done) && Number.isFinite(total) && total > 0) setIndexProgress({ done, total, rows })
  }
  window.addEventListener('dsh-search-index-progress', onProgress)
  return () => { window.removeEventListener('dsh-search-index-progress', onProgress) }
}, [])

const cancelIndexBuild = useCallback((): Promise<void> => {
  const jobId = indexJobRef.current
  // 没有构建在跑时是**空操作**：用户点它只可能是因为看见「构建中…」，
  // 而那一瞬可能刚好建完了 —— 那本来就不需要停。
  if (jobId === '') return Promise.resolve()
  return apiCancelSearchIndexBuild({ jobId })
    .then((r) => { if (r.ok !== true && r.message !== undefined) setMsgSearchError(r.message) })
    .catch((e: unknown) => { setMsgSearchError('没能停止构建：' + (e as Error).message) })
}, [])

const buildIndex = useCallback(async (silent = false): Promise<void> => {
  // jobSeq 必须是 ref：局部变量每次渲染都从 0 重来，于是所有构建的 jobId 都是同一个，
  // 迟到的事件会被当成当前这次（与内联分析那边同款教训）。
  const jobId = `search-index-${String(++indexJobSeqRef.current)}`
  indexJobRef.current = jobId
  setIndexBuilding(true)
  setIndexProgress({ done: 0, total: 0, rows: 0 })
  try {
    const r = await apiBuildSearchIndex({ force: false, jobId })
    // W3-11.5：被取消不是失败 —— 后端 ROLLBACK，旧索引原样还在。
    if (r.status === 'cancelled') {
      if (!silent) setMsgSearchError(null)
      return
    }
    setMsgIndexed(true)
    // r.message 只在「跳过不可读分片」时出现：索引残缺必须让用户看见
    if (!silent) {
      setMsgSearchError(r.message
        ? `搜索索引已就绪（${r.rows ?? 0} 条，但${r.message}）`
        : `搜索索引已就绪（${r.rows ?? 0} 条）`)
    }
  } catch (e) {
    if (!silent) setMsgSearchError('索引构建失败: ' + (e as Error).message)
  } finally {
    // 槽位必须清：否则下一次「停止」会打到上一次那个已经结束的 jobId 上，
    // 后端会说「这次构建已经结束了」—— 而当前这次其实正跑着。
    if (indexJobRef.current === jobId) indexJobRef.current = ''
    setIndexBuilding(false)
    setIndexProgress(null)
  }
}, [])

const checkIndexStatus = useCallback(async (): Promise<void> => {
  try {
    const st = await apiGetSearchIndexStatus()
    setMsgIndexed(st.exists && st.rows > 0)
  } catch { /* keep default */ }
}, [])

const onSearchInput = useCallback((q: string): void => {
  if (msgSearchTimer.current) clearTimeout(msgSearchTimer.current)
  const term = q.trim()
  if (term.length < 1) {
    msgSearchSeqRef.current += 1
    cancelActiveSearch()
    setMsgHits([])
    setMsgSearched(false)
    setMsgSearchError(null)
    return
  }
  const seq = ++msgSearchSeqRef.current
  // 新一轮搜索开始即打断上一轮（N9）：上一次的兜底扫描可能还在 worker 里跑
  cancelActiveSearch()
  // 手机上不自动发起建索引：`buildSearchIndex` 是十分钟档的重活、刻意不入白名单。
  // 远程被拒的只是「建」这一半：`searchMessages` 在白名单里，未建索引时后端自己退化成兜底扫描。
  if (!msgIndexed && !indexBuilding && !desktopAction()) void buildIndex(true)
  msgSearchTimer.current = setTimeout(async () => {
    setMsgSearchLoading(true)
    setMsgSearchError(null)
    const jobId = 'chats-search-' + (globalThis.crypto?.randomUUID?.() ?? String(Date.now()))
    activeSearchJobRef.current = jobId
    try {
      const r = await apiSearchMessages({ query: term, limit: 200, jobId })
      if (seq !== msgSearchSeqRef.current) return
      setMsgHits(r.hits)
      setMsgIndexed(r.indexed)
      setMsgSearched(true)
    } catch (e) {
      if (seq !== msgSearchSeqRef.current) return
      setMsgSearchError((e as Error).message)
      setMsgHits([])
    } finally {
      if (activeSearchJobRef.current === jobId) activeSearchJobRef.current = null
      if (seq === msgSearchSeqRef.current) setMsgSearchLoading(false)
    }
  }, 350)
}, [msgIndexed, indexBuilding, buildIndex, cancelActiveSearch])

// 离开面板时打断在跑的搜索（N9；与上面那条「新搜索打断旧搜索」同一套 token）
useEffect(() => () => { cancelActiveSearch() }, [cancelActiveSearch])

// ── message calendar (A8) ──
const [calOpen, setCalOpen] = useState(false)
// 手写覆盖层的 Esc 关闭（kit 的 Drawer/Dialog 由 Radix 提供；这几个是手写的）
useEscapeToClose(exportOpen, () => { setExportOpen(false) })
useEscapeToClose(chatlogStack.length > 0, () => { setChatlogStack([]) })
useEscapeToClose(calOpen, () => { setCalOpen(false) })
useEscapeToClose(editedOpen, () => { setEditedOpen(false) })
// 焦点管理：进入移入、Tab 循环、关闭还原（手写弹窗没有 Radix 的那套）
useDialogFocus(exportOpen, '[data-st-dialog="chats-export"]')
useDialogFocus(chatlogStack.length > 0, '[data-st-dialog="chats-chatlog"]')
useDialogFocus(calOpen, '[data-st-dialog="chats-cal"]')
useDialogFocus(editedOpen, '[data-st-dialog="chats-edited"]')
  // 离开面板时不打断构建：它是**派生数据**、中断的代价（回滚 + 下次重来）比让它跑完大。
  // 这条与上面「离开面板打断搜索」是有意不同 —— 搜索的结果用户已经不看 了，
  // 而构建跑完就一劳永逸。取消由用户在面板里显式点。
  return { activeSearchJobRef, buildIndex, cancelIndexBuild, indexProgress, calOpen, checkIndexStatus, indexBuilding, msgHits, msgIndexed, msgSearchError, msgSearchLoading, msgSearched, onSearchInput, setCalOpen }
}
