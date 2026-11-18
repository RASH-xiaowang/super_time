import type { WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { desktopActionProps } from '../ui/desktop-only.tsx'
import { ChatAiReplySettingsDialog } from './chat-ai-reply-settings-dialog.tsx'
import csscards from './chats-cards.module.css'
import cssrows from './chats-rows.module.css'
import cssshell from './chats-shell.module.css'

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
  kbEnabled: boolean
  kbId: number
  /** 上下文时间窗（小时）；0 = 不限。 */
  contextWindowHours: number
  onToggle: () => void
  onScanNow: () => void
  onSavePersona: (input: {
    name: string
    prompt: string
    splitReply: boolean
    kbEnabled: boolean
    kbId: number
    contextWindowHours: number
  }) => Promise<boolean>
}

/**
 * 会话头部的 AI 回复入口：开关 + 设置。
 *
 * 2026-11-18 按用户要求从「更多」菜单搬到头部、紧跟在「AI 问答」之后 ——
 * 这两件事是同一会话的同类动作（都在当前会话上生成内容），分处两处反而不顺。
 *
 * 文案沿用菜单里的叫法（`AI回复` / `AI回复设置`），用户不必重新认一次。
 * **「AI回复设置」只在已开启时出现**：没开之前没有可配置的对象，摆出来只会加长动作带。
 * 宽度由既有的 `.calBtnLabel` 收敛规则兜住：容器 ≤560px 时标签自动隐藏、
 * 退化成纯图标（见 `chats-shell.module.css` 的窄列收敛规则），所以不必另做一套。
 * 开关态靠 `data-active` 高亮 + `aria-pressed`，悬停说明里带状态与最近检查时间。
 * **单聊与群聊都出现**（2026-11-18 起群聊也能开启）：群聊的触发条件收在后端 ——
 * 只有结构化 `atuserlist` 里点名了本机账号的消息才成为锚点，「@所有人」不算。
 */
export function ChatAiReplyHeaderButtons(props: {
  curSession: WechatSession
  aiReply?: ChatAiReplyUiState
  onOpenSettings: () => void
}): React.JSX.Element | null {
  const { curSession, aiReply, onOpenSettings } = props
  if (aiReply?.visible !== true) return null
  const disabled = aiReply.busy || !aiReply.ready
  return (
    <>
      <button
        type="button"
        className={cssrows.calBtn}
        data-active={aiReply.enabled ? true : undefined}
        aria-pressed={aiReply.enabled === true}
        aria-label={aiReply.enabled ? 'AI回复：已开启' : 'AI回复：未开启'}
        disabled={disabled}
        {...desktopActionProps()}
        title={aiReplyHeaderTitle(aiReply, curSession.type === 'group')}
        onClick={() => { aiReply.onToggle() }}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 3l1.7 4.8L18.5 9.5l-4.8 1.7L12 16l-1.7-4.8L5.5 9.5l4.8-1.7L12 3Z" />
          <path d="M18.5 16.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
        </svg>
        <span className={cssshell.calBtnLabel}>{aiReply.enabled ? 'AI回复中' : 'AI回复'}</span>
      </button>
      {/* 设置入口只在**已开启**时出现（2026-11-18 用户要求）：没开之前它配置的对象
          还不存在，摆在那里只会让动作带变长。 */}
      {aiReply.enabled && (
        <button
          type="button"
          className={cssrows.calBtn}
          aria-label="AI回复设置"
          disabled={disabled}
          {...desktopActionProps()}
          title={aiReply.error ?? [
            aiReply.personaName ? '当前人格：' + aiReply.personaName : '配置本会话的 AI 回复人格与语气',
            aiReply.kbEnabled === true ? '知识库：参与回复' : '',
          ].filter(Boolean).join('\n')}
          onClick={onOpenSettings}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M12 20a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z" />
            <path d="M9 10.2h.01M15 10.2h.01M8.8 14c.9 1.1 2 1.6 3.2 1.6s2.3-.5 3.2-1.6" />
          </svg>
          <span className={cssshell.calBtnLabel}>AI回复设置</span>
        </button>
      )}
    </>
  )
}

/** 开关按钮的悬停说明：状态一句话 + 最近检查与台账记录（排查用，不占界面）。 */
function aiReplyHeaderTitle(aiReply: ChatAiReplyUiState, isGroup: boolean): string {
  return [
    aiReply.error
      ?? (aiReply.enabled
        ? (isGroup
          ? 'AI 回复已开启；群里只有 @ 我的消息会自动生成，并 @ 回提问者投递'
          : 'AI 回复已开启；出现新消息后自动生成并投递')
        : (isGroup
          ? 'AI 回复：只在群里被 @ 时自动分析，并 @ 回提问者'
          : 'AI 回复：自动分析当前会话并通过消息列表发送')),
    aiReply.lastRunAt === undefined
      ? ''
      : '最近检查：' + new Date(aiReply.lastRunAt).toLocaleString(),
    aiReply.recordId === undefined
      ? ''
      : '消息列表记录：' + String(aiReply.recordId),
  ].filter(Boolean).join('\n')
}

/**
 * 「更多」菜单里剩下的 AI 回复动作。
 *
 * 开关与设置已搬到头部（见 {@link ChatAiReplyHeaderButtons}）；这里只留
 * 「立即检查」—— 它是低频的排查动作，不该占头部位。
 */
export function ChatAiReplyMenu(props: {
  curSession: WechatSession
  aiReply?: ChatAiReplyUiState
  onCloseMenu: () => void
}): React.JSX.Element | null {
  const { curSession, aiReply, onCloseMenu } = props

  if (aiReply?.visible !== true || !aiReply.enabled) return null
  return (
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
      initialKbEnabled={aiReply.kbEnabled}
      initialKbId={aiReply.kbId}
      initialContextWindowHours={aiReply.contextWindowHours}
      saving={aiReply.busy}
      {...(aiReply.error === undefined ? {} : { error: aiReply.error })}
      onClose={onClose}
      onSave={aiReply.onSavePersona}
    />
  )
}
