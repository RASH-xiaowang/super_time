/**
 * Right-click message tools: poster capture, source inspection, metadata and
 * guarded editors. The editor is shared by text and raw-source modes so both
 * paths use the same wide, resizable input surface.
 */
import { useCallback, useMemo, useState } from 'react'
import type { WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { apiCapturePanel, apiEditChatMessage, runtimeCapabilities } from '../api.ts'
import { copyTextToClipboard } from '../utils/misc.ts'
import { fmtMsgClockSec } from '../utils/format.ts'
import { Dialog } from '../ui/kit.tsx'
import { messageSourceText, type MsgMenuItem } from './chats-support.tsx'
import csscards from './chats-cards.module.css'

export type MessageToolMode = 'source' | 'info' | 'editText' | 'editSource'

export interface MessageToolState {
  mode: MessageToolMode
  m: WechatMessage
  session: WechatSession | null
}

export interface ChatsMessageToolsController {
  tool: MessageToolState | null
  session: WechatSession | null
  draft: string
  busy: boolean
  error: string | null
  onChange: (value: string) => void
  onClose: () => void
  onSave: () => void
  onCopySource: () => void
}

interface RectLike {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

/** Union only the avatar + message column, not the full-width virtual row. */
export function posterCaptureRect(parts: readonly RectLike[], padding = 14): RectLike | null {
  const valid = parts.filter(r => r.width > 0 && r.height > 0)
  if (valid.length === 0) return null
  const left = Math.min(...valid.map(r => r.left)) - padding
  const top = Math.min(...valid.map(r => r.top)) - padding
  const right = Math.max(...valid.map(r => r.right)) + padding
  const bottom = Math.max(...valid.map(r => r.bottom)) + padding
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

/** Stable, filesystem-safe default name for the save dialog. */
export function posterFilename(sessionName: string, localId: number, now = Date.now()): string {
  const safe = (sessionName.trim() || '聊天')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .slice(0, 48)
  const stamp = new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  return `聊天海报-${safe}-${localId}-${stamp}.png`
}

function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') {
      setTimeout(resolve, 0)
      return
    }
    requestAnimationFrame(() => { requestAnimationFrame(() => { resolve() }) })
  })
}

function prettyBytes(value: unknown): string {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function richField(m: WechatMessage, keys: readonly string[]): string {
  for (const key of keys) {
    const value = m.rich?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

function infoRows(m: WechatMessage, session: WechatSession | null): Array<[string, string]> {
  const source = messageSourceText(m)
  const sender = [m.senderName, m.sender].filter(Boolean).join(' · ')
  const resourceTitle = richField(m, ['title', 'fileName', 'name'])
  const resourceUrl = richField(m, ['url', 'link'])
  const resourceMd5 = richField(m, ['md5'])
  const resourceSize = prettyBytes(m.rich?.['fileSize'] ?? m.rich?.['size'])
  return [
    ['消息类型', `${m.typeLabel ?? m.renderLabel ?? '未知'}（type ${m.type}）`],
    ['呈现类型', m.renderType ?? '—'],
    ['发送方向', m.isSender === 1 ? '我发出' : '对方发送'],
    ['发送者', sender || '—'],
    ['所属会话', session ? `${session.displayName || session.username} · ${session.username}` : '—'],
    ['发送时间', fmtMsgClockSec(m.createTime, '—')],
    ['本地 ID', String(m.localId)],
    ['服务端 ID', m.serverId || '—'],
    ['排序序号', m.sortSeq === undefined ? '—' : String(m.sortSeq)],
    ['源码长度', `${source.length.toLocaleString('zh-CN')} 字符`],
    ['资源标题', resourceTitle || '—'],
    ['资源地址', resourceUrl || '—'],
    ['资源 MD5', resourceMd5 || '—'],
    ['资源大小', resourceSize || '—'],
  ]
}

function titleOf(mode: MessageToolMode): string {
  switch (mode) {
    case 'source': return '查看源码'
    case 'info': return '消息信息'
    case 'editText': return '修改消息'
    case 'editSource': return '修改源码'
  }
}

function InfoDialog({ m, session }: { m: WechatMessage; session: WechatSession | null }): React.JSX.Element {
  const rows = useMemo(() => infoRows(m, session), [m, session])
  return (
    <div className={csscards.messageInfoGrid} data-st-message-info>
      {rows.map(([label, value]) => (
        <div className={csscards.messageInfoRow} key={label}>
          <span className={csscards.messageInfoLabel}>{label}</span>
          <span className={csscards.messageInfoValue} title={value}>{value}</span>
        </div>
      ))}
    </div>
  )
}

/** Dialog renderer for all four message tools. */
export function ChatsMessageTools({ tool, session, draft, busy, error, onChange, onClose, onSave, onCopySource }: ChatsMessageToolsController): React.JSX.Element {
  const mode = tool?.mode
  const source = tool ? messageSourceText(tool.m) : ''
  const baseline = tool?.mode === 'editSource'
    ? source
    : (tool?.m.strContent ?? tool?.m.displayText ?? source)
  const editing = mode === 'editText' || mode === 'editSource'
  const readOnly = mode === 'source'
  const title = mode ? titleOf(mode) : ''
  const footer = mode === 'info' ? (
    <div className={csscards.messageToolFoot}>
      <button type="button" className={csscards.exportBtn} onClick={onClose}>关闭</button>
    </div>
  ) : mode === 'source' ? (
    <div className={csscards.messageToolFoot}>
      <button type="button" className={csscards.exportBtn} onClick={onCopySource}>复制源码</button>
      <button type="button" className={csscards.exportBtnPrimary} onClick={onClose}>关闭</button>
    </div>
  ) : (
    <div className={csscards.messageToolFoot}>
      <button type="button" className={csscards.exportBtn} disabled={busy} onClick={onClose}>取消</button>
      <button
        type="button"
        className={csscards.exportBtnPrimary}
        disabled={busy || draft === baseline}
        onClick={onSave}
      >
        {busy ? '保存中…' : '保存'}
      </button>
    </div>
  )

  return (
    <Dialog
      open={tool !== null}
      onClose={() => { if (!busy) onClose() }}
      title={title}
      className={`${csscards.editDialog} ${csscards.messageToolDialog}`}
      footer={footer}
    >
      <div data-st-message-tools={mode ?? undefined}>
        {mode === 'info' && tool && <InfoDialog m={tool.m} session={session} />}
        {editing && (
          <p className={csscards.editHint}>
            {mode === 'editText'
              ? '只修改本地解密副本中的纯文本内容。保存后可在「更多 → 已编辑消息」恢复原文。'
              : '直接编辑消息的原始载荷（XML / JSON）。保存时会保留原存储编码；内容结构错误可能导致该条消息无法正常渲染。'}
          </p>
        )}
        {mode === 'source' && (
          <p className={csscards.messageToolMeta}>
            原始源码 · {source.length.toLocaleString('zh-CN')} 字符 · 只读
          </p>
        )}
        {mode !== 'info' && (
          <textarea
            className={`${csscards.editArea} ${mode === 'editSource' || mode === 'source' ? csscards.messageToolCode : ''}`}
            value={mode === 'source' ? source : draft}
            readOnly={readOnly}
            autoFocus
            onChange={e => { if (!readOnly) onChange(e.target.value) }}
            aria-label={mode === 'editText' ? '消息内容' : '消息源码'}
            spellCheck={false}
          />
        )}
        {error && <p className={csscards.messageToolError} role="alert">保存失败：{error}</p>}
      </div>
    </Dialog>
  )
}

export interface UseChatsMessageToolsInputs {
  curSession: WechatSession | null
  flash: (message: string) => void
  reloadCurrent: () => Promise<void>
  loadEdits: () => Promise<void>
}

/** State + actions behind the five right-click menu entries. */
export function useChatsMessageTools({ curSession, flash, reloadCurrent, loadEdits }: UseChatsMessageToolsInputs): {
  controller: ChatsMessageToolsController
  openPoster: (m: WechatMessage) => Promise<void>
  openSource: (m: WechatMessage) => void
  openInfo: (m: WechatMessage) => void
  openEditor: (m: WechatMessage, mode: 'text' | 'source') => void
} {
  const [tool, setTool] = useState<MessageToolState | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onEdited = useCallback(async (): Promise<void> => {
    await reloadCurrent()
    await loadEdits()
  }, [reloadCurrent, loadEdits])

  const close = useCallback((): void => {
    if (busy) return
    setTool(null)
    setError(null)
  }, [busy])

  const openSource = useCallback((m: WechatMessage): void => {
    setTool({ mode: 'source', m, session: curSession })
    setDraft('')
    setError(null)
  }, [curSession])

  const openInfo = useCallback((m: WechatMessage): void => {
    setTool({ mode: 'info', m, session: curSession })
    setDraft('')
    setError(null)
  }, [curSession])

  const openEditor = useCallback((m: WechatMessage, mode: 'text' | 'source'): void => {
    setTool({ mode: mode === 'text' ? 'editText' : 'editSource', m, session: curSession })
    setDraft(mode === 'text' ? (m.strContent ?? m.displayText ?? messageSourceText(m)) : messageSourceText(m))
    setError(null)
  }, [curSession])

  const save = useCallback(async (): Promise<void> => {
    if (!tool?.session) return
    setBusy(true)
    setError(null)
    try {
      const mode = tool.mode === 'editSource' ? 'source' : 'text'
      const r = await apiEditChatMessage({
        username: tool.session.username,
        localId: tool.m.localId,
        content: draft,
        mode,
      })
      if (!r.ok) {
        setError(r.error ?? '未知错误')
        return
      }
      setTool(null)
      flash(mode === 'text' ? '消息已修改' : '源码已保存')
      try { await onEdited() } catch { /* the write already succeeded; refresh is best-effort */ }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }, [tool, draft, flash, onEdited])

  const copySource = useCallback((): void => {
    if (!tool) return
    void copyTextToClipboard(messageSourceText(tool.m)).then(ok => {
      flash(ok ? '消息源码已复制' : '复制失败，请手动选中源码')
    })
  }, [tool, flash])

  const openPoster = useCallback(async (m: WechatMessage): Promise<void> => {
    if (!curSession) return
    if (!runtimeCapabilities().capturePanel) {
      flash('当前环境不支持生成聊天海报，请在桌面端使用')
      return
    }
    await nextPaint()
    const row = document.getElementById('msg-' + String(m.localId))
    if (!row) {
      flash('生成聊天海报失败：消息当前不在可视区域')
      return
    }
    const col = row.querySelector<HTMLElement>('[data-msg-col]')
    const avatar = row.firstElementChild instanceof HTMLElement ? row.firstElementChild : null
    const focused = [col?.getBoundingClientRect(), avatar?.getBoundingClientRect()]
      .filter((r): r is DOMRect => r !== undefined && r.width > 0 && r.height > 0)
    const parts = focused.length > 0 ? focused : [row.getBoundingClientRect()]
    const crop = posterCaptureRect(parts)
    if (!crop) {
      flash('生成聊天海报失败：无法测量消息区域')
      return
    }
    const x = Math.max(0, crop.left)
    const y = Math.max(0, crop.top)
    const right = Math.min(window.innerWidth, crop.right)
    const bottom = Math.min(window.innerHeight, crop.bottom)
    if (right <= x || bottom <= y) {
      flash('生成聊天海报失败：消息已滚出屏幕')
      return
    }
    try {
      const res = await apiCapturePanel({
        x, y, width: right - x, height: bottom - y,
        filename: posterFilename(curSession.displayName || curSession.username, m.localId),
      })
      if (!res.ok) flash('生成聊天海报失败：' + (res.message || '未知错误'))
      else if (res.canceled) flash('已取消生成聊天海报')
      else flash(`聊天海报已保存：${res.path ?? ''}`)
    } catch (e) {
      flash('生成聊天海报失败：' + (e as Error).message)
    }
  }, [curSession, flash])

  return {
    controller: {
      tool,
      session: tool?.session ?? curSession,
      draft,
      busy,
      error,
      onChange: setDraft,
      onClose: close,
      onSave: () => { void save() },
      onCopySource: copySource,
    },
    openPoster,
    openSource,
    openInfo,
    openEditor,
  }
}

export interface UseChatsMenuActionInputs {
  copyText: (text: string) => void
  copyJson: (m: WechatMessage) => void
  openLink: (url: string) => void
  openViewer: (m: WechatMessage) => void
  openFile: (name: string, m: WechatMessage) => void
  openChatlog: (m: WechatMessage) => void
  openPoster: (m: WechatMessage) => Promise<void>
  openSource: (m: WechatMessage) => void
  openInfo: (m: WechatMessage) => void
  openEditor: (m: WechatMessage, mode: 'text' | 'source') => void
}

/** Dispatch the declarative menu item to the concrete panel action. */
export function useChatsMenuAction(inputs: UseChatsMenuActionInputs): (item: MsgMenuItem, m: WechatMessage) => void {
  const { copyText, copyJson, openLink, openViewer, openFile, openChatlog, openPoster, openSource, openInfo, openEditor } = inputs
  return useCallback((item: MsgMenuItem, m: WechatMessage): void => {
    switch (item.action) {
      case 'copyText': copyText(item.arg ?? ''); break
      case 'copyJson': copyJson(m); break
      case 'openLink': openLink(item.arg ?? ''); break
      case 'openViewer': openViewer(m); break
      case 'openFile': openFile(item.arg ?? '', m); break
      case 'openChatlog': openChatlog(m); break
      case 'poster': void openPoster(m); break
      case 'viewSource': openSource(m); break
      case 'messageInfo': openInfo(m); break
      case 'editMessage': openEditor(m, 'text'); break
      case 'editSource': openEditor(m, 'source'); break
      default: break
    }
  }, [copyText, copyJson, openLink, openViewer, openFile, openChatlog, openPoster, openSource, openInfo, openEditor])
}
