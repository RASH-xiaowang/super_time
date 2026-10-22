/**
 * 引用详情面板的开关状态与消息上下文懒加载（2026-10-16 新增）。
 *
 * ## 为什么抽成 hook
 *
 * `AskPanel` 受 `function-size-ratchet.spec.ts` 的棘轮管着（登记 411 行，只许变小）。
 * 状态、上下文请求、错误归一都放在这里，主面板只剩装配 —— 否则只加「点角标看详情」
 * 就能顶穿棘轮。
 *
 * ## 为什么存「轮次下标 + 编号」而不是引用对象
 *
 * turns 会被 `patchTurn` 就地更新（反馈、接地核对都会改），存对象会拿到**过期的那一份**。
 * 存下标 + 编号，每次渲染现取，永远是最新的。
 *
 * ## 为什么上下文只取「附近一段」而不是整段会话
 *
 * 引用自带发生时间，但精度只到分钟；按它往前后各放宽一分钟，各发一次**有界**请求
 * （`limit` 很小）就足以还原「这条前后说了什么」。绝不按 `hasMore` 翻页拉全量 ——
 * 那会把打开一次详情变成读完整个会话。
 *
 * @module panels/use-cite-detail
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AskTurn } from './use-ask.ts'
import type { CiteItem } from './cite-target.ts'
import { apiGetKbFiles, apiGetMessages, apiGetNewMessages, apiOpenPath, runtimeCapabilities } from '../api.ts'
import { fmtDateTimeSec } from '../utils/format.ts'

/** 当前查看的引用：轮次下标 + 编号（编号 = 引用数组下标 + 1，与正文角标一致）。 */
export interface CiteDetailRef {
  turn: number
  n: number
}

/** 上下文里的一条消息（与 `CiteDetailPanel` 的展示形状一致）。 */
export interface ContextMessage {
  /** 稳定键（用于 React key）。 */
  key: string
  /** 发送者显示名。 */
  sender: string
  /** 时间（`YYYY-MM-DD HH:mm`）。 */
  time: string
  /** 正文。 */
  text: string
  /** 是不是被引用的那一条（高亮它）。 */
  focus?: boolean
}

/** 上下文加载所需的最小引用信息（由 hook 从 `CiteItem` 现取）。 */
export interface CiteContextTarget {
  username: string
  localId?: number
  time: string
  name: string
  sender?: string
  snippet: string
}

/** 调用方提供的上下文加载器（懒加载；只在消息引用打开时调用）。 */
export type CiteContextLoader = (target: CiteContextTarget) => Promise<ContextMessage[]>

/**
 * 上下文区状态。
 *
 * `unavailable` 与 `empty` 必须分开：前者是「没有定位信息/入口未接」，
 * 后者是「确实查过了，附近没有别的消息」。混成一句用户会以为数据丢了。
 */
export type CiteContextStatus =
  | 'idle' | 'loading' | 'ready' | 'empty' | 'error' | 'unavailable'

/** hook 的返回形状。 */
export interface CiteDetailState {
  ref: CiteDetailRef | null
  item: CiteItem | null
  toggle: (turn: number, n: number) => void
  close: () => void
  context: ContextMessage[]
  contextStatus: CiteContextStatus
  contextError: string | null
  retryContext: () => void
}

interface CiteDetailOptions {
  loadContext?: CiteContextLoader
}

/** 引用分钟精度 → 前后各放宽一分钟。 */
const WINDOW_MS = 60_000
/** 前/后各取几条（有界，不翻页）。 */
const BEFORE_LIMIT = 6
const AFTER_LIMIT = 13

/**
 * 把后端/运行时错误压成给用户看的一行。
 *
 * 不显示堆栈、`at file:line`、内部路径：详情面板是给用户核对引用的地方，
 * 一条带路径的异常既看不懂也帮不上忙。保留「原因 + 建议」两段。
 * @param e - 任意异常或已归一化的错误文本。
 * @param fallback - 完全取不到原因时的兜底句。
 * @returns 单行可读文本。
 */
export function readableCiteError(e: unknown, fallback = '读取失败，请稍后重试'): string {
  const raw = e instanceof Error ? e.message : (typeof e === 'string' ? e : '')
  const line = raw
    .split(/\r?\n/)[0]
    ?.replace(/\s+at\s+.*$/, '')
    .replace(/[A-Za-z]:\\[^\s:]+/g, '本机文件')
    .trim()
  if (!line) return fallback
  return line.length > 160 ? line.slice(0, 160) + '…' : line
}

/** 引用时间 `HH:mm` / `YYYY-MM-DD HH:mm` → 毫秒锚点；解析不了返回 null。 */
function anchorMs(time: string): number | null {
  const t = time.trim()
  const clock = /^(\d{1,2}):(\d{2})$/.exec(t)
  const now = new Date()
  if (clock) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), Number(clock[1]), Number(clock[2]))
    return Number.isNaN(d.getTime()) ? null : d.getTime()
  }
  const full = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(t)
  if (!full) return null
  const d = new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]), Number(full[4]), Number(full[5]))
  return Number.isNaN(d.getTime()) ? null : d.getTime()
}

/** 上下文行里显示的发送者（缺省用「对方」而不是伪造人名）。 */
function senderOf(name: string, sender?: string): string {
  return (sender ?? '').trim() || name || '对方'
}

/** 消息正文：优先后端归一化的 displayText，缺省给类型占位而不是空白行。 */
function textOf(m: { displayText?: string; msgContent?: string; renderLabel?: string; type?: number }): string {
  const text = (m.displayText ?? m.msgContent ?? '').trim()
  if (text !== '') return text
  return m.renderLabel ? `[${m.renderLabel}]` : (m.type ? `[消息 ${m.type}]` : '[无正文]')
}

/** 引用里的 `locator.localId` 比顶层 `local_id` 更接近原文；两者取先有效的那个。 */
function locateId(item: CiteItem): number | undefined {
  if (typeof item.local_id === 'number' && Number.isFinite(item.local_id)) return item.local_id
  const locator = item.locator
  if (locator?.type === 'message' && Number.isFinite(locator.localId)) return locator.localId
  return undefined
}

/** 引用锚点时间：优先 `locator` 里可能带的完整时间，退回顶层显示时间。 */
function locateTime(item: CiteItem): string {
  if (item.time.trim() !== '') return item.time
  const locator = item.locator
  if (locator?.type === 'resource') return locator.time ?? ''
  return ''
}

/**
 * 默认的消息上下文加载器：用引用时间去现有消息接口取前后各一段。
 *
 * 两次请求都是**有界**的：向前 `apiGetMessages`（游标 = 锚点 + 1 分钟），
 * 向后 `apiGetNewMessages`（after = 锚点 - 1 分钟）。`apiGetMessages` 的 cursor
 * 是毫秒 `sort_seq`，所以这里直接用毫秒。结果按 localId 去重、按时间升序。
 * @param target - 当前引用。
 * @returns 附近消息；当前引用不在结果里时补一条 focus 行（用引用自己的摘要）。
 */
export async function loadMessageContext(target: CiteContextTarget): Promise<ContextMessage[]> {
  const username = target.username.trim()
  const localId = typeof target.localId === 'number' && Number.isFinite(target.localId) ? target.localId : undefined
  if (username === '' || username.startsWith('kb:')) return []
  const center = anchorMs(target.time)
  if (center === null) {
    return [{
      key: `focus:${localId ?? target.snippet}`,
      sender: senderOf(target.name, target.sender),
      time: target.time,
      text: target.snippet,
      focus: true,
    }]
  }
  const [before, after] = await Promise.all([
    apiGetMessages({
      talker: username,
      limit: BEFORE_LIMIT,
      cursor: center + WINDOW_MS,
      cursorLocalId: Number.MAX_SAFE_INTEGER,
    }),
    apiGetNewMessages({
      talker: username,
      after: Math.max(0, center - WINDOW_MS),
      limit: AFTER_LIMIT,
    }),
  ])
  const byId = new Map<number, ContextMessage>()
  for (const m of [...before.messages, ...after.messages]) {
    byId.set(m.localId, {
      key: `m:${m.localId}`,
      sender: senderOf(m.senderName ?? '', m.sender),
      time: fmtDateTimeSec(m.createTime, ''),
      text: textOf(m),
      focus: localId !== undefined && m.localId === localId,
    })
  }
  const rows = [...byId.values()]
  if (rows.length === 0) return []
  if (localId !== undefined && !rows.some(r => r.focus)) {
    rows.push({
      key: `focus:${localId}`,
      sender: senderOf(target.name, target.sender),
      time: target.time,
      text: target.snippet,
      focus: true,
    })
  }
  rows.sort((a, b) => a.time.localeCompare(b.time))
  return rows
}

/**
 * 打开知识库引用对应的原文件。
 *
 * 复用既有 API（`apiGetKbFiles` + `apiOpenPath`），不新造网络旁路：
 * 先按 `kbId` 取文件清单找到 `fileId`，再用它的 `srcPath` 交给系统打开。
 * 失败时抛出**可读中文**（调用方负责 toast/提示），不把原始堆栈带出去。
 * @param kbId - 知识库 id（守卫：文件 id 全局自增，必须按库查）。
 * @param fileId - 文件 id。
 */
export async function openKbFileFromCitation(kbId: number, fileId: number): Promise<void> {
  let snapshot
  try {
    snapshot = await apiGetKbFiles(kbId, { limit: 5000 })
  } catch (e) {
    throw new Error(`无法读取知识库文件列表：${readableCiteError(e, '请确认知识库仍可用后重试')}`)
  }
  if (snapshot.readError) {
    throw new Error(`无法读取知识库文件列表：${readableCiteError(snapshot.readError, '请稍后重试')}`)
  }
  const file = snapshot.items.find(f => f.id === fileId)
  if (!file) throw new Error('这条引用的文件已不在知识库中，可能已被删除；可回到知识库列表重新添加')
  const srcPath = file.srcPath.trim()
  if (srcPath === '') throw new Error('这个文件没有可打开的本机路径；可回到知识库重新登记该文件')
  if (!runtimeCapabilities().shellOpen) {
    throw new Error('打开本机文件只能在电脑上完成，请在电脑端重试')
  }
  const r = await apiOpenPath(srcPath)
  if (!r.ok) throw new Error(`无法打开文件：${readableCiteError(r.error, '请确认原文件仍在磁盘上')}`)
}

/**
 * 引用详情的开关状态 + 消息上下文懒加载。
 *
 * @param turns - 当前线程的轮次（用于现取引用对象）。
 * @param scopeKey - 作用域键（切线程/切筛选时关闭并作废旧响应）。
 * @param options.loadContext - 消息上下文加载器；不传时详情显示「入口未接入」。
 * @returns 当前引用、开关动作与上下文状态。
 */
export function useCiteDetail(
  turns: AskTurn[],
  scopeKey = '',
  options: CiteDetailOptions = {},
): CiteDetailState {
  const [ref, setRef] = useState<CiteDetailRef | null>(null)
  const [context, setContext] = useState<ContextMessage[]>([])
  const [contextStatus, setContextStatus] = useState<CiteContextStatus>('idle')
  const [contextError, setContextError] = useState<string | null>(null)
  const [retryNonce, setRetryNonce] = useState(0)
  const scopeRef = useRef(scopeKey)
  const requestRef = useRef(0)
  // Scope changes must close the panel immediately, before the passive effect runs;
  // otherwise the first render after switching could show the new thread's citation
  // under an index that was selected in the old thread.
  const visibleRef = scopeRef.current === scopeKey ? ref : null
  useEffect(() => {
    scopeRef.current = scopeKey
    setRef(null)
  }, [scopeKey])
  const toggle = useCallback((turn: number, n: number): void => {
    setRef(prev => (prev && prev.turn === turn && prev.n === n ? null : { turn, n }))
  }, [])
  const close = useCallback((): void => { setRef(null) }, [])
  // 现取：turns 会被 patchTurn 就地更新，缓存下来的那份会过期。
  const item = visibleRef ? (turns[visibleRef.turn]?.citations?.[visibleRef.n - 1] ?? null) : null

  useEffect(() => {
    requestRef.current += 1
    const ticket = requestRef.current
    setContext([])
    setContextError(null)
    if (!visibleRef || !item) { setContextStatus('idle'); return }
    if (item.source === 'kb') { setContextStatus('unavailable'); return }
    const username = (item.username ?? '').trim()
    if (item.kb !== undefined || username.startsWith('kb:')) { setContextStatus('unavailable'); return }
    const localId = locateId(item)
    if (username === '' || localId === undefined) { setContextStatus('unavailable'); return }
    if (!options.loadContext) { setContextStatus('unavailable'); return }
    setContextStatus('loading')
    void options.loadContext({
      username,
      localId,
      time: locateTime(item),
      name: item.name,
      ...(item.sender ? { sender: item.sender } : {}),
      snippet: item.snippet,
    })
      .then((rows) => {
        if (requestRef.current !== ticket) return
        setContext(rows)
        setContextStatus(rows.length > 0 ? 'ready' : 'empty')
      })
      .catch((e: unknown) => {
        if (requestRef.current !== ticket) return
        setContext([])
        setContextError(readableCiteError(e, '附近消息读取失败，请重试或打开会话原文'))
        setContextStatus('error')
      })
  }, [visibleRef, item, options.loadContext, retryNonce])

  const retryContext = useCallback((): void => { setRetryNonce(v => v + 1) }, [])
  return { ref: visibleRef, item, toggle, close, context, contextStatus, contextError, retryContext }
}
