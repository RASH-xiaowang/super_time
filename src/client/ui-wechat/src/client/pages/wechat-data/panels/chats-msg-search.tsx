
/**
 * Chats 面板的「消息内搜索与索引」（M21 第三十四刀起自 Chats.tsx 拆出）。
 *
 * 原先散在 `ChatsPanel` 的函数体里（几十个 state 与回调），但输入输出很清楚 —— 抽成钩子后：
 * 面板把输入传进来、把用得到的值解构出去，其余细节（轮询、竞态防护、菜单构造）留在模块里。
 * 钩子在面板的**第一条组内声明处**调用 ⇒ 与原来的声明顺序等价。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiBuildSearchIndex, apiGetSearchIndexStatus, apiSearchMessages } from '../api.ts'
import { useDialogFocus, useEscapeToClose } from '../ui/kit.tsx'
import type { ChatlogRecord, SearchHit } from '@deepseek-ai/dsh-wechat-data/types'

export interface useChatsMsgSearchInputs {
  cancelActiveSearch: () => void
  chatlogStack: ReadonlyArray<{ title: string; records: ChatlogRecord[] }>
  editedOpen: boolean
  exportOpen: boolean
  setChatlogStack: React.Dispatch<React.SetStateAction<Array<{ title: string; records: ChatlogRecord[] }>>>
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
const msgSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
const msgSearchSeqRef = useRef(0)
/**
 * 在跑的消息搜索的 jobId（N9）。换关键词/清空/离开面板时用它打断上一轮扫描 ——
 * 后端兜底扫描最长可达秒级，不打断就白占着 worker（用户已经不看结果了）。
 */
const activeSearchJobRef = useRef<string | null>(null)
/** 打断在跑的那次搜索（没有就别调 RPC）。 */
const buildIndex = useCallback(async (silent = false): Promise<void> => {
  setIndexBuilding(true)
  try {
    const r = await apiBuildSearchIndex({ force: false })
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
    setIndexBuilding(false)
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
  if (!msgIndexed && !indexBuilding) void buildIndex(true)
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
  return { activeSearchJobRef, buildIndex, calOpen, checkIndexStatus, indexBuilding, msgHits, msgIndexed, msgSearchError, msgSearchLoading, msgSearched, onSearchInput, setCalOpen }
}
