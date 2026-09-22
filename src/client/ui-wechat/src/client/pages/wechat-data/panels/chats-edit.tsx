
/**
 * Chats 面板的「消息编辑与草稿」（M21 第三十四刀起自 Chats.tsx 拆出）。
 *
 * 原先散在 `ChatsPanel` 的函数体里（几十个 state 与回调），但输入输出很清楚 —— 抽成钩子后：
 * 面板把输入传进来、把用得到的值解构出去，其余细节（轮询、竞态防护、菜单构造）留在模块里。
 * 钩子在面板的**第一条组内声明处**调用 ⇒ 与原来的声明顺序等价。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { useConfirm } from '../ui/confirm.tsx'
import { apiClearAllSessionDrafts, apiClearSessionDraft, apiEditChatMessage, apiGetMessages, apiListEditedMessages, apiResetEditedMessage, readRenderCache, writeRenderCache } from '../api.ts'
import { messagesMatchTalker } from './msg-scope.ts'
import type { EditedMessageRecord, MessageRenderKind as RenderKind, WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'

export interface useChatsEditInputs {
  confirm: ReturnType<typeof useConfirm>
  curSession: WechatSession | null
  reloadSessionsList: () => void
  selfWxid: string
  sessionAlive: (epoch: number, talker: string) => boolean
  sessionEpochRef: React.MutableRefObject<number>
  setCursor: React.Dispatch<React.SetStateAction<number>>
  setCursorLocalId: React.Dispatch<React.SetStateAction<number | undefined>>
  setHasMore: React.Dispatch<React.SetStateAction<boolean>>
  setMessages: React.Dispatch<React.SetStateAction<readonly WechatMessage[]>>
  setSelfWxid: React.Dispatch<React.SetStateAction<string>>
  setTypeStats: React.Dispatch<React.SetStateAction<readonly { type: number; label: string; count: number }[]>>
  setWatermarkFrom: (list: readonly WechatMessage[]) => void
}

export function useChatsEdit(inputs: useChatsEditInputs) {
  const { confirm, curSession, reloadSessionsList, selfWxid, sessionAlive, sessionEpochRef, setCursor, setCursorLocalId, setHasMore, setMessages, setSelfWxid, setTypeStats, setWatermarkFrom } = inputs
const [editedOpen, setEditedOpen] = useState(false)
const [edits, setEdits] = useState<readonly EditedMessageRecord[]>([])
const [editedIds, setEditedIds] = useState<Set<number>>(new Set())
const [editing, setEditing] = useState(false)
/** 「编辑消息副本」对话框：目标消息 / 编辑中的文本 / 失败原因 / 保存中 */
const [editTarget, setEditTarget] = useState<WechatMessage | null>(null)
const [editText, setEditText] = useState('')
const [editErr, setEditErr] = useState<string | null>(null)
const [editBusy, setEditBusy] = useState(false)
const editAreaRef = useRef<HTMLTextAreaElement | null>(null)

// 打开即把光标放进编辑框并全选原文（Radix 默认聚焦标题栏的关闭按钮）。
useEffect(() => {
  if (!editTarget) return undefined
  const t = window.setTimeout(() => { editAreaRef.current?.focus(); editAreaRef.current?.select() }, 60)
  return () => { window.clearTimeout(t) }
}, [editTarget])

const loadEdits = useCallback(async (): Promise<void> => {
  try {
    const r = await apiListEditedMessages(curSession ? { sessionId: curSession.username } : undefined)
    setEdits(r.items)
    setEditedIds(new Set(r.items.map(it => it.localId)))
  } catch { setEdits([]); setEditedIds(new Set()) }
}, [curSession])

const openEdits = useCallback(async (): Promise<void> => {
  setEditedOpen(v => !v)
  if (!editedOpen) await loadEdits()
}, [editedOpen, loadEdits])

const reloadCurrent = useCallback(async (): Promise<void> => {
  if (!curSession) return
  // 记下发起时的归属：编辑后刷新期间用户可能已经切走，回来必须校验。
  const talker = curSession.username
  const epoch = sessionEpochRef.current
  try {
    // 键带 v2：早期版本在「切会话」竞态下把上一个会话写进过 v1 缓存（别人的消息留在本会话里），
    // 升版让那些脏数据彻底读不到；读到之后还要再校验一次归属（见 msg-scope.ts）。
    const raw = readRenderCache<WechatMessage[]>('chat-msgs:v2:' + talker)
    const cached = raw && messagesMatchTalker(raw, talker, selfWxid) ? raw : null
    if (!sessionAlive(epoch, talker)) return
    if (cached && cached.length > 0) {
      setMessages(cached)
      setHasMore(true)
    }
    const env = await apiGetMessages({ talker, limit: 100 })
    if (!sessionAlive(epoch, talker)) return
    setMessages(env.messages)
    setWatermarkFrom(env.messages)
    setSelfWxid(env.selfWxid ?? '')
    setHasMore(env.hasMore ?? false)
    setCursor(env.cursor ?? 0)
    setCursorLocalId(env.cursorLocalId)
    setTypeStats(env.typeStats ?? [])
    writeRenderCache('chat-msgs:v2:' + talker, env.messages)
  } catch { /* keep current view */ }
}, [curSession])

/**
 * 打开「编辑消息副本」对话框。
 *
 * 原实现用 `window.prompt(...)` 取新内容 —— **Electron 渲染进程不支持 prompt**
 * （调用即抛 `prompt() is not supported.`），于是右键菜单点「编辑消息副本」除了在
 * 控制台留一条报错外什么都不发生（用户反馈「为什么还不能编辑信息」）。
 * 改成应用内对话框：可多行、能显示保存失败的原文、Esc/取消可退。
 */
const doEdit = useCallback((m: WechatMessage): void => {
  setEditTarget(m)
  setEditText(m.displayText || m.strContent || '')
  setEditErr(null)
}, [])

const closeEdit = useCallback((): void => {
  setEditTarget(null)
  setEditErr(null)
}, [])

const saveEdit = useCallback(async (): Promise<void> => {
  const m = editTarget
  if (!m || !curSession) return
  setEditBusy(true)
  setEditErr(null)
  try {
    const r = await apiEditChatMessage({ username: curSession.username, localId: m.localId, content: editText })
    if (!r.ok) { setEditErr(r.error ?? '未知错误'); return }
    setEditTarget(null)
    await reloadCurrent()
    await loadEdits()
  } catch (e) {
    setEditErr((e as Error).message)
  } finally {
    setEditBusy(false)
  }
}, [editTarget, editText, curSession, reloadCurrent, loadEdits])

const sessionListRef = useRef<HTMLDivElement | null>(null)
const clearDraft = useCallback(async (): Promise<void> => {
  if (!curSession || !curSession.draft) return
  const ok = await confirm({
    title: `清空「${curSession.displayName || curSession.username}」的草稿？`,
    message: '清空的是本地解密副本里的草稿，不影响微信本身。',
    tone: 'danger',
  })
  if (!ok) return
  try {
    const r = await apiClearSessionDraft({ username: curSession.username })
    if (r.ok) reloadSessionsList()
  } catch { /* keep view */ }
}, [curSession, reloadSessionsList])

const clearAllDrafts = useCallback(async (): Promise<void> => {
  const ok = await confirm({
    title: '清空所有会话草稿？',
    message: '清空的是本地解密副本里的草稿，不影响微信本身。',
    tone: 'danger',
  })
  if (!ok) return
  try {
    const r = await apiClearAllSessionDrafts()
    window.alert(`已清空 ${r.count} 条草稿`)
    reloadSessionsList()
  } catch (e) {
    window.alert('清空失败: ' + (e as Error).message)
  }
}, [reloadSessionsList])

const copyMsgJson = useCallback((m: WechatMessage): void => {
  try {
    const json = JSON.stringify({
      localId: m.localId,
      type: m.type,
      isSender: m.isSender,
      createTime: m.createTime,
      displayText: m.displayText,
      typeLabel: m.typeLabel,
      sender: m.sender ?? undefined,
      rich: m.rich ?? undefined,
    }, null, 2)
    void navigator.clipboard.writeText(json).then(() => { window.alert('消息 JSON 已复制') }).catch(() => { window.alert('复制失败') })
  } catch { window.alert('复制失败') }
}, [])

const doReset = useCallback(async (rec: EditedMessageRecord): Promise<void> => {
  if (!curSession) return
  const ok = await confirm({
    title: '恢复该消息为原始内容？',
    message: '本次编辑会被撤销。',
    tone: 'danger',
    confirmText: '恢复原文',
  })
  if (!ok) return
  setEditing(true)
  try {
    const r = await apiResetEditedMessage({ username: rec.sessionId, localId: rec.localId })
    if (!r.ok) window.alert('恢复失败: ' + (r.error ?? ''))
    else { await reloadCurrent(); await loadEdits() }
  } catch (e) {
    window.alert('恢复失败: ' + (e as Error).message)
  } finally {
    setEditing(false)
  }
}, [curSession, reloadCurrent, loadEdits])

// ── message search (A7) ──
const [searchMode, setSearchMode] = useState<'session' | 'message'>('session')
const onEditFn = doEdit

/** 消息右键菜单的光标定位状态（null = 未打开）。 */
const [msgMenu, setMsgMenu] = useState<{ x: number; y: number; m: WechatMessage; kind: RenderKind } | null>(null)

/**
 * 切换分类视图（全部 / 公众号 / 服务号 / 客服）。
 *
 * 类目互斥：列表换类目后，右侧那个「打开中的会话」已经不属于当前界面，
 * 必须一并关掉 —— 否则在「客服」视图里会看到之前打开的某个公众号聊天，
 * 就是这个界面上出现了别的类目的信息。会话无关的浮层（聊天记录弹窗、
 * 右键菜单）也一起收起，避免残留指向上一个会话的内容。
 * @param next - the category to switch to.
 */
  return { clearAllDrafts, clearDraft, closeEdit, copyMsgJson, doReset, editAreaRef, editBusy, editErr, editTarget, editText, editedIds, editedOpen, editing, edits, loadEdits, msgMenu, onEditFn, openEdits, saveEdit, searchMode, sessionListRef, setEditText, setEditedOpen, setMsgMenu, setSearchMode }
}
