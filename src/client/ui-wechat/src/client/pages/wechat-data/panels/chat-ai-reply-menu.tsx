import type { WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import { ChatAiReplySettingsDialog } from './chat-ai-reply-settings-dialog.tsx'
import csscards from './chats-cards.module.css'

export interface ChatAiReplyUiState {
  visible: boolean
  enabled: boolean
  stage: string
  busy: boolean
  ready: boolean
  error?: string
  lastRunAt?: number
  recordId?: number
  personaName: string
  personaPrompt: string
  splitReply: boolean
  onToggle: () => void
  onScanNow: () => void
  onSavePersona: (input: { name: string; prompt: string; splitReply: boolean }) => Promise<boolean>
}

/**
 * 「更多」菜单中的 AI 回复动作组。
 * 把会话级菜单项与人格弹窗从头部动作排拆出，避免头部函数继续膨胀。
 */
export function ChatAiReplyMenu(props: {
  curSession: WechatSession
  aiReply?: ChatAiReplyUiState
  onCloseMenu: () => void
  onOpenSettings: () => void
}): React.JSX.Element | null {
  const { curSession, aiReply, onCloseMenu, onOpenSettings } = props

  if (curSession.type !== 'private') return null
  return (
    <>
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={aiReply?.enabled === true}
        className={csscards.msgHeaderMoreItem}
        data-active={aiReply?.enabled || undefined}
        disabled={aiReply === undefined || aiReply.busy || !aiReply.ready}
        {...desktopActionProps()}
        title={aiReply === undefined || !aiReply.ready
          ? (aiReply?.error ?? 'AI 回复：正在读取账号与会话设置')
          : [
              aiReply.error
                ?? (aiReply.enabled
                  ? 'AI 回复已开启；出现新消息后自动生成并投递'
                  : 'AI 回复：自动分析当前会话并通过消息列表发送'),
              aiReply.lastRunAt === undefined
                ? ''
                : '最近检查：' + new Date(aiReply.lastRunAt).toLocaleString(),
              aiReply.recordId === undefined
                ? ''
                : '消息列表记录：' + String(aiReply.recordId),
            ].filter(Boolean).join('\n')}
        onClick={() => {
          onCloseMenu()
          aiReply?.onToggle()
        }}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3l1.7 4.8L18.5 9.5l-4.8 1.7L12 16l-1.7-4.8L5.5 9.5l4.8-1.7L12 3Z" />
          <path d="M18.5 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
        </svg>
        {aiReply?.enabled ? 'AI回复 已开启' : 'AI回复'}
        {aiReply?.busy ? ' · 处理中' : ''}
        {aiReply?.enabled && aiReply.stage === 'failed' ? ' · 失败' : ''}
      </button>
      {aiReply?.visible === true && (
        <button
          type="button"
          role="menuitem"
          className={csscards.msgHeaderMoreItem}
          disabled={aiReply === undefined || aiReply.busy || !aiReply.ready}
          {...desktopActionProps()}
          title={aiReply?.error ?? (aiReply?.personaName
            ? '当前人格：' + aiReply.personaName
            : '配置本会话的 AI 回复人格与语气')}
          onClick={() => {
            onCloseMenu()
            onOpenSettings()
          }}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z" />
            <path d="M9 10.2h.01M15 10.2h.01M8.8 14c.9 1.1 2 1.6 3.2 1.6s2.3-.5 3.2-1.6" />
          </svg>
          AI回复设置…
        </button>
      )}
      {aiReply?.visible === true && aiReply.enabled && (
        <button
          type="button"
          role="menuitem"
          className={csscards.msgHeaderMoreItem}
          disabled={aiReply.busy}
          {...desktopActionProps()}
          title={aiReply.error ?? '立即扫描所有已开启的 AI 回复会话'}
          onClick={() => {
            onCloseMenu()
            aiReply.onScanNow()
          }}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 1 0-2.3 5.7" />
            <path d="M20 4v7h-7" />
          </svg>
          立即检查 AI 回复
        </button>
      )}
    </>
  )
}

/** 人格弹窗挂在菜单容器之外，菜单收起时不会被连带卸载。 */
export function ChatAiReplySettingsHost(props: {
  curSession: WechatSession
  aiReply?: ChatAiReplyUiState
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const { curSession, aiReply, open, onClose } = props
  if (aiReply?.visible !== true) return null
  return (
    <ChatAiReplySettingsDialog
      open={open}
      chatUsername={curSession.username}
      chatName={curSession.displayName}
      initialName={aiReply.personaName}
      initialPrompt={aiReply.personaPrompt}
      initialSplitReply={aiReply.splitReply}
      saving={aiReply.busy}
      {...(aiReply.error === undefined ? {} : { error: aiReply.error })}
      onClose={onClose}
      onSave={aiReply.onSavePersona}
    />
  )
}
