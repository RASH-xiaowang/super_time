
/**
 * Chats 面板的「消息编辑与草稿」（M21 第三十四刀起自 Chats.tsx 拆出）。
 *
 * 原先散在 `ChatsPanel` 的函数体里（几十个 state 与回调），但输入输出很清楚 —— 抽成钩子后：
 * 面板把输入传进来、把用得到的值解构出去，其余细节（轮询、竞态防护、菜单构造）留在模块里。
 * 钩子在面板的**第一条组内声明处**调用 ⇒ 与原来的声明顺序等价。
 */

import { useCallback, useRef, useState } from 'react'
import { copyTextToClipboard } from '../utils/misc.ts'
import type { useConfirm } from '../ui/confirm.tsx'
import { apiClearAllSessionDrafts, apiClearSessionDraft, apiGetMessages, apiListEditedMessages, apiResetEditedMessage, readRenderCache, writeRenderCache } from '../api.ts'
import { messagesMatchTalker } from './msg-scope.ts'
import { useActionNotice } from './use-action-notice.tsx'
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
/**
 * 一次性动作反馈（W3-11.1）：清空草稿 / 复制 JSON / 恢复原文的**结果**。
 *
 * 为什么不用 `window.alert`：那是阻塞式原生弹窗 —— ① 会把整个窗口钉住，用户不点哪都去不了；
 * ② 风格与其它面板的反馈不一致；③ 复制成功这种高频动作每点一次弹一次，是噪声。
 * 与 `editErr` 的分工：`editErr` 是「保存失败」（对话框内的红色常驻），
 * `editNotice` 是「这次操作成了 / 没成」的一句话结论（会自动消失）。
 */
const { notice: editNotice, flash: flashEditNotice } = useActionNotice()

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
    if (r.ok) { flashEditNotice('已清空该会话的草稿'); reloadSessionsList() }
    else flashEditNotice('清空草稿失败：' + (r.error ?? '未知错误'))
  } catch (e) {
    flashEditNotice('清空草稿失败：' + (e as Error).message)
  }
}, [curSession, flashEditNotice, reloadSessionsList])

const clearAllDrafts = useCallback(async (): Promise<void> => {
  const ok = await confirm({
    title: '清空所有会话草稿？',
    message: '清空的是本地解密副本里的草稿，不影响微信本身。',
    tone: 'danger',
  })
  if (!ok) return
  try {
    const r = await apiClearAllSessionDrafts()
    flashEditNotice(`已清空 ${r.count} 条草稿`)
    reloadSessionsList()
  } catch (e) {
    flashEditNotice('清空失败: ' + (e as Error).message)
  }
}, [flashEditNotice, reloadSessionsList])

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
    void copyTextToClipboard(json).then((ok) => { flashEditNotice(ok ? '消息 JSON 已复制' : '复制失败，请手动选中后复制') })
  } catch { flashEditNotice('复制失败，请手动选中后复制') }
}, [flashEditNotice])

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
    if (!r.ok) flashEditNotice('恢复失败: ' + (r.error ?? ''))
    else { flashEditNotice('已恢复为原始内容'); await reloadCurrent(); await loadEdits() }
  } catch (e) {
    flashEditNotice('恢复失败: ' + (e as Error).message)
  } finally {
    setEditing(false)
  }
}, [curSession, flashEditNotice, reloadCurrent, loadEdits])

// ── message search (A7) ──
const [searchMode, setSearchMode] = useState<'session' | 'message'>('session')

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
  return { clearAllDrafts, clearDraft, copyMsgJson, doReset, editNotice, editedIds, editedOpen, editing, edits, flashEditNotice, loadEdits, msgMenu, openEdits, reloadCurrent, searchMode, sessionListRef, setEditedOpen, setMsgMenu, setSearchMode }
}
