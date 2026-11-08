
/**
 * Chats 面板的「导出与批量导出」（M21 第三十四刀起自 Chats.tsx 拆出）。
 *
 * 原先散在 `ChatsPanel` 的函数体里（几十个 state 与回调），但输入输出很清楚 —— 抽成钩子后：
 * 面板把输入传进来、把用得到的值解构出去，其余细节（轮询、竞态防护、菜单构造）留在模块里。
 * 钩子在面板的**第一条组内声明处**调用 ⇒ 与原来的声明顺序等价。
 */

import type { ChatlogFrame } from './chats-chatlog.ts'
import { useCallback, useState } from 'react'
import { apiExportSessionMessages, apiResolveChatHistory, pickDirectory } from '../api.ts'
import { isCanceledExportError, useExportTask, type ExportTaskState } from './export-task.ts'
import type { ChatlogRecord, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'

/**
 * 导出的目标格式。
 *
 * 这个联合此前被**三处各写一遍**（这里的 state、`chats-view.tsx` 的道具类型两处），
 * 加一种格式就得记住改三处 —— 与本仓「同一属性必须有同一个主人」同一条规矩。
 */
export type ExpFormat = 'txt' | 'html' | 'md' | 'excel' | 'csv' | 'sql' | 'json'

/** 导出弹窗里「消息类型」那一张表的列定义（`EXPO_TYPES`）。 */
export type ExpoType = { key: string; label: string; types?: readonly number[]; rich?: readonly string[] }

const IDLE_EXPORT_STATE: ExportTaskState = {
  status: 'idle',
  label: '',
  progress: null,
  message: '',
  canceling: false,
  cancelable: false,
}

export interface useChatsExportInputs {
  EXPO_TYPES: ReadonlyArray<ExpoType>
  chatlogResolving: boolean
  curSession: WechatSession | null
  setChatlogResolving: React.Dispatch<React.SetStateAction<boolean>>
  setChatlogStack: React.Dispatch<React.SetStateAction<ChatlogFrame[]>>
  setPinnedCollapsed: React.Dispatch<React.SetStateAction<boolean>>
}

export function useChatsExport(inputs: useChatsExportInputs) {
  const { EXPO_TYPES, chatlogResolving, curSession, setChatlogResolving, setChatlogStack, setPinnedCollapsed } = inputs
const [batchMode, setBatchMode] = useState(false)
const [selected, setSelected] = useState<Set<string>>(new Set())
const [, setAvatarVersion] = useState(0)
const SINGLE_EXPORT_LABEL = '导出聊天记录'
const BATCH_EXPORT_LABEL = '批量导出会话'
const exportTask = useExportTask()
const exporting = exportTask.running && exportTask.state.label === SINGLE_EXPORT_LABEL
const batchExporting = exportTask.running && exportTask.state.label === BATCH_EXPORT_LABEL
const singleExportState = exportTask.state.label === SINGLE_EXPORT_LABEL ? exportTask.state : IDLE_EXPORT_STATE
const batchExportState = exportTask.state.label === BATCH_EXPORT_LABEL ? exportTask.state : null
/** 取消只发信号，终态仍由当前 RPC 的返回/异常决定。 */
const cancelExport = useCallback((): void => { void exportTask.cancel() }, [exportTask])

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
  if (list.length === 0 || exportTask.running) return
  await exportTask.run(async ({ jobId, bindJobId, cancelRequested, report }) => {
    let done = 0
    const errors: string[] = []
    report({ phase: 'batch', done, total: list.length })
    for (const [index, username] of list.entries()) {
      if (cancelRequested()) throw new Error('任务已取消')
      // 每个会话使用独立后端 jobId：上一项迟到的事件不会覆盖下一项或批量汇总。
      // 取消仍通过 bindJobId 找到当前正在跑的那一项。
      bindJobId(`${jobId}-item-${String(index + 1)}`)
      try {
        // 批量模式也走会话媒体包，不再只交付 TXT 而把图片/视频留在本机。
        await apiExportSessionMessages({
          username,
          format: 'txt',
          count: 0,
          zip: true,
          jobId: `${jobId}-item-${String(index + 1)}`,
        })
        if (cancelRequested()) throw new Error('任务已取消')
        done += 1
        report({ phase: 'batch', done, total: list.length })
      } catch (e) {
        if (cancelRequested() || isCanceledExportError(e)) throw e
        errors.push(username + ': ' + (e as Error).message)
        report({ phase: 'batch', done: done + errors.length, total: list.length })
      }
    }
    return { done, total: list.length, errors }
  }, {
    idPrefix: 'chats-export-batch',
    label: BATCH_EXPORT_LABEL,
    progress: { phase: 'batch', done: 0, total: list.length },
    cooperativeCancel: true,
    successMessage: (r) => `已导出 ${r.done}/${r.total} 个会话原文件 ZIP${r.errors.length ? `，失败 ${r.errors.length} 个` : ''}`,
  })
}, [selected, exportTask])

const togglePinned = (): void => {
  setPinnedCollapsed((v) => {
    const nv = !v
    try { localStorage.setItem('wc_pinned_collapsed', nv ? '1' : '0') } catch { /* ignore */ }
    return nv
  })
}

/** Open the lightbox at a message image (strip = all type-3 messages loaded). */
const [exportMsg, setExportMsg] = useState<string | null>(null)
// export dialog state
const [exportOpen, setExportOpen] = useState(false)
const [expFormat, setExpFormat] = useState<ExpFormat>('txt')
const [expCount, setExpCount] = useState(0)
const [expDir, setExpDir] = useState('')
const [expTypes, setExpTypes] = useState<readonly string[]>([])
const [expFrom, setExpFrom] = useState('')
const [expTo, setExpTo] = useState('')
const [expFilename, setExpFilename] = useState('')
const [expZip, setExpZip] = useState(true)
const [pickingDir, setPickingDir] = useState(false)

const EXPO_FORMATS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'txt', label: 'TXT' }, { value: 'html', label: 'HTML' }, { value: 'md', label: 'Markdown' },
  { value: 'excel', label: 'Excel' }, { value: 'sql', label: 'SQL' }, { value: 'json', label: 'JSON' },
]
const exportSession = useCallback(async (): Promise<void> => {
  if (!curSession || exportTask.running) return
  setExportMsg(null)
  const chosen = EXPO_TYPES.filter(c => expTypes.includes(c.key))
  const types = chosen.flatMap(c => [...(c.types ?? [])])
  const richTypes = chosen.flatMap(c => [...(c.rich ?? [])])
  const fromSec = expFrom ? Math.floor(new Date(expFrom + 'T00:00:00').getTime() / 1000) : 0
  const toSec = expTo ? Math.floor(new Date(expTo + 'T23:59:59').getTime() / 1000) : 0
  const outcome = await exportTask.run(async ({ jobId }) => {
    const opts: {
      username: string
      format: string
      count: number
      jobId: string
      dir?: string
      types?: number[]
      richTypes?: string[]
      from?: number
      to?: number
      filename?: string
      zip?: boolean
      sessionName?: string
    } = {
      username: curSession.username,
      format: expFormat,
      count: expCount,
      jobId,
      sessionName: curSession.displayName,
    }
    if (expDir.trim()) opts.dir = expDir.trim()
    if (types.length > 0) opts.types = types
    if (richTypes.length > 0) opts.richTypes = richTypes
    if (fromSec > 0) opts.from = fromSec
    if (toSec > 0) opts.to = toSec
    if (expFilename.trim()) opts.filename = expFilename.trim()
    if (expZip) opts.zip = true
    return apiExportSessionMessages(opts)
  }, {
    idPrefix: 'chats-export',
    label: SINGLE_EXPORT_LABEL,
    successMessage: (r) => {
      const media = r.mediaCount && r.mediaCount > 0 ? `、${r.mediaCount} 个资源` : ''
      const missing = r.mediaMissingCount && r.mediaMissingCount > 0 ? `（${r.mediaMissingCount} 个资源本地缺失，已写入清单）` : ''
      return `已导出 ${r.count} 条${media}${missing} → ${r.path}`
    },
  })
  setExportMsg(outcome.ok ? outcome.message : outcome.canceled ? '已取消导出' : '导出失败: ' + outcome.error)
}, [curSession, exportTask, expFormat, expCount, expDir, expTypes, expFrom, expTo, expFilename, expZip])

const chooseExportDir = async (): Promise<void> => {
  if (pickingDir) return
  setPickingDir(true)
  try {
    const dir = await pickDirectory()
    if (dir) setExpDir(dir)
  } catch (e) {
    setExportMsg('选择目录失败：' + (e as Error).message)
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
        // 走 exportMsg（面板头的常驻提示行）而不是 window.alert：阻塞式原生弹窗会把
        // 整个窗口钉住，而且风格与其它面板的反馈不一致（W3-11.1）。
        setExportMsg('未找到该聊天记录（可能需要微信端完整同步）')
      }
    } catch (e) {
      setExportMsg('解析聊天记录失败: ' + (e as Error).message)
    } finally {
      setChatlogResolving(false)
    }
  }
}

// ── message edit (C5) ──
  return { EXPO_FORMATS, batchExporting, batchExportState, batchFinishing: batchExporting && exportTask.finishing, batchMode, cancelBatchExport: cancelExport, cancelExport, chooseExportDir, expCount, expDir, expFilename, expFormat, expFrom, expTo, expTypes, expZip, exportBatch, exportMsg, exportOpen, exportSession, exportState: singleExportState, exporting, finishing: exporting && exportTask.finishing, openNestedChatlog, pickingDir, selected, setAvatarVersion, setBatchMode, setExpCount, setExpFilename, setExpFormat, setExpFrom, setExpTo, setExpTypes, setExpZip, setExportOpen, setSelected, togglePinned, toggleSelect }
}
