
/**
 * Chats 面板的「导出与批量导出」（M21 第三十四刀起自 Chats.tsx 拆出）。
 *
 * 原先散在 `ChatsPanel` 的函数体里（几十个 state 与回调），但输入输出很清楚 —— 抽成钩子后：
 * 面板把输入传进来、把用得到的值解构出去，其余细节（轮询、竞态防护、菜单构造）留在模块里。
 * 钩子在面板的**第一条组内声明处**调用 ⇒ 与原来的声明顺序等价。
 */

import { useCallback, useState } from 'react'
import { apiExportSessionMessages, apiResolveChatHistory, pickDirectory } from '../api.ts'
import type { ChatlogRecord, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'

export interface useChatsExportInputs {
  EXPO_TYPES: ReadonlyArray<{ key: string; label: string; types?: readonly number[]; rich?: readonly string[] }>
  chatlogResolving: boolean
  curSession: WechatSession | null
  setChatlogResolving: React.Dispatch<React.SetStateAction<boolean>>
  setChatlogStack: React.Dispatch<React.SetStateAction<Array<{ title: string; records: ChatlogRecord[] }>>>
  setPinnedCollapsed: React.Dispatch<React.SetStateAction<boolean>>
}

export function useChatsExport(inputs: useChatsExportInputs) {
  const { EXPO_TYPES, chatlogResolving, curSession, setChatlogResolving, setChatlogStack, setPinnedCollapsed } = inputs
const [batchMode, setBatchMode] = useState(false)
const [selected, setSelected] = useState<Set<string>>(new Set())
const [batchExporting, setBatchExporting] = useState(false)
const [batchMsg, setBatchMsg] = useState<string | null>(null)
const [, setAvatarVersion] = useState(0)

const toggleSelect = (username: string): void => {
  setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(username)) next.delete(username)
    else next.add(username)
    return next
  })
}

const exportBatch = useCallback(async (): Promise<void> => {
  const list = [...selected]
  if (list.length === 0) return
  setBatchExporting(true)
  setBatchMsg(null)
  let done = 0
  const errors: string[] = []
  try {
    for (const username of list) {
      try {
        await apiExportSessionMessages({ username, format: 'txt', count: 0 })
        done += 1
      } catch (e) {
        errors.push(username + ': ' + (e as Error).message)
      }
    }
    setBatchMsg(`已导出 ${done}/${list.length} 个会话${errors.length ? `，失败 ${errors.length} 个` : ''}`)
  } finally {
    setBatchExporting(false)
  }
}, [selected])

const togglePinned = (): void => {
  setPinnedCollapsed((v) => {
    const nv = !v
    try { localStorage.setItem('wc_pinned_collapsed', nv ? '1' : '0') } catch { /* ignore */ }
    return nv
  })
}

/** Open the lightbox at a message image (strip = all type-3 messages loaded). */
const [exporting, setExporting] = useState(false)
const [exportMsg, setExportMsg] = useState<string | null>(null)
// export dialog state
const [exportOpen, setExportOpen] = useState(false)
const [expFormat, setExpFormat] = useState<'txt' | 'html' | 'md' | 'excel' | 'csv' | 'sql' | 'json'>('txt')
const [expCount, setExpCount] = useState(0)
const [expDir, setExpDir] = useState('')
const [expTypes, setExpTypes] = useState<readonly string[]>([])
const [expFrom, setExpFrom] = useState('')
const [expTo, setExpTo] = useState('')
const [expFilename, setExpFilename] = useState('')
const [expZip, setExpZip] = useState(false)
const [pickingDir, setPickingDir] = useState(false)

const EXPO_FORMATS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'txt', label: 'TXT' }, { value: 'html', label: 'HTML' }, { value: 'md', label: 'Markdown' },
  { value: 'excel', label: 'Excel' }, { value: 'sql', label: 'SQL' }, { value: 'json', label: 'JSON' },
]
const exportSession = useCallback(async (): Promise<void> => {
  if (!curSession || exporting) return
  setExporting(true)
  setExportMsg(null)
  try {
    const chosen = EXPO_TYPES.filter(c => expTypes.includes(c.key))
    const types = chosen.flatMap(c => [...(c.types ?? [])])
    const richTypes = chosen.flatMap(c => [...(c.rich ?? [])])
    const fromSec = expFrom ? Math.floor(new Date(expFrom + 'T00:00:00').getTime() / 1000) : 0
    const toSec = expTo ? Math.floor(new Date(expTo + 'T23:59:59').getTime() / 1000) : 0
    const opts: {
      username: string
      format: string
      count: number
      dir?: string
      types?: number[]
      richTypes?: string[]
      from?: number
      to?: number
      filename?: string
      zip?: boolean
    } = {
      username: curSession.username,
      format: expFormat,
      count: expCount,
    }
    if (expDir.trim()) opts.dir = expDir.trim()
    if (types.length > 0) opts.types = types
    if (richTypes.length > 0) opts.richTypes = richTypes
    if (fromSec > 0) opts.from = fromSec
    if (toSec > 0) opts.to = toSec
    if (expFilename.trim()) opts.filename = expFilename.trim()
    if (expZip) opts.zip = true
    const r = await apiExportSessionMessages(opts)
    setExportMsg(`已导出 ${r.count} 条 → ${r.path}`)
    setExportOpen(false)
  } catch (e) {
    setExportMsg('导出失败: ' + (e as Error).message)
  } finally {
    setExporting(false)
  }
}, [curSession, exporting, expFormat, expCount, expDir, expTypes, expFrom, expTo, expFilename, expZip])

const chooseExportDir = async (): Promise<void> => {
  if (pickingDir) return
  setPickingDir(true)
  try {
    const dir = await pickDirectory()
    if (dir) setExpDir(dir)
  } finally {
    setPickingDir(false)
  }
}

const openNestedChatlog = async (rec: ChatlogRecord): Promise<void> => {
  if (rec.nested && rec.nested.length > 0) {
    setChatlogStack(prev => [...prev, { title: rec.datatitle || rec.text || '聊天记录', records: rec.nested ?? [] }])
    return
  }
  if (rec.fromnewmsgid && !chatlogResolving) {
    setChatlogResolving(true)
    try {
      const r = await apiResolveChatHistory(rec.fromnewmsgid)
      const rich = r.found ? r.message?.rich : null
      if (r.found && rich && Array.isArray(rich.records) && rich.records.length > 0) {
        setChatlogStack(prev => [...prev, { title: rich.title || '聊天记录', records: rich.records ?? [] }])
      } else {
        window.alert('未找到该聊天记录（可能需要微信端完整同步）')
      }
    } catch (e) {
      window.alert('解析聊天记录失败: ' + (e as Error).message)
    } finally {
      setChatlogResolving(false)
    }
  }
}

// ── message edit (C5) ──
  return { EXPO_FORMATS, batchExporting, batchMode, batchMsg, chooseExportDir, expCount, expDir, expFilename, expFormat, expFrom, expTo, expTypes, expZip, exportBatch, exportMsg, exportOpen, exportSession, exporting, openNestedChatlog, pickingDir, selected, setAvatarVersion, setBatchMode, setExpCount, setExpFilename, setExpFormat, setExpFrom, setExpTo, setExpTypes, setExpZip, setExportOpen, setSelected, togglePinned, toggleSelect }
}
