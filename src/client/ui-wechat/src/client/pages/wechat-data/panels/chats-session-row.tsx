import { LazyMount } from './hooks.tsx'
import type { WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import { Avatar, IconPin, isEnterpriseChat, unreadTitle } from './chats-support.tsx'
import { fmtSessionTimeSec } from '../utils/format.ts'
import { withEnterprise } from './enterprise-identity.ts'
import { sessionPreviewText, shouldShowEnterpriseBadge } from './session-list.ts'
import { isLegacyChatId, readableChatName } from '../utils/chat-identity.ts'
import kitCss from '../ui/kit.module.css'
import css from './chats.module.css'
import csscards from './chats-cards.module.css'

function EnterpriseChatBadge({ session }: { session: WechatSession }): React.JSX.Element | null {
  if (!shouldShowEnterpriseBadge(session, isEnterpriseChat(session.username))) return null
  return (
    <span className={csscards.entBadge} title={session.enterpriseName ? `企业微信 · ${session.enterpriseName}` : '企业微信'}>
      企微
    </span>
  )
}

interface ChatsSessionRowProps {
  session: WechatSession
  itemIndex?: number
  active: boolean
  batchMode: boolean
  selected: boolean
  selfWxid: string
  aiReplyEnabled: boolean
  onOpen: (session: WechatSession) => void
  onToggle: (username: string) => void
}

/** One conversation row in the chats sidebar. */
export function ChatsSessionRow({
  session,
  itemIndex,
  active,
  batchMode,
  selected,
  selfWxid,
  aiReplyEnabled,
  onOpen,
  onToggle,
}: ChatsSessionRowProps): React.JSX.Element {
  const preview = sessionPreviewText(session, selfWxid)
  const name = readableChatName(session.displayName, session.username)
  const openable = session.username !== '' && !isLegacyChatId(session.username)
  return (
    <button
      type="button"
      data-session-row={session.username}
      data-progressive-item={itemIndex}
      className={css.sessionItem}
      data-active={!batchMode && active || undefined}
      title={withEnterprise(name, session.enterpriseName)}
      aria-disabled={!openable || undefined}
      onClick={() => {
        if (!openable) return
        if (batchMode) onToggle(session.username)
        else onOpen(session)
      }}
    >
      {batchMode && (
        <span className={kitCss.batchCheck} data-checked={selected || undefined}>
          {selected ? '✓' : ''}
        </span>
      )}
      <LazyMount placeholder={<span className={css.avatarStub} />} rootMargin="400px 0px">
        <Avatar name={session.displayName} username={session.username} size={40} />
      </LazyMount>
      <div className={css.sessionInfo}>
        <div className={css.sessionTop}>
          <span className={css.sessionNameWrap}>
            <span className={css.sessionName}>{withEnterprise(name, session.enterpriseName)}</span>
            {aiReplyEnabled && (
              <span className={css.aiReplyBadge} data-ai-reply="enabled" title="AI 回复已开启">AI</span>
            )}
            {session.hidden && <span className={css.hiddenBadge} title="该会话在微信中被隐藏">已隐藏</span>}
            <EnterpriseChatBadge session={session} />
          </span>
          <span className={css.sessionTimeGroup}>
            <span className={css.sessionTime}>{fmtSessionTimeSec(session.lastTimestamp)}</span>
            {session.pinned && <span className={css.pinMark} title="置顶会话"><IconPin /></span>}
          </span>
        </div>
        <div className={css.sessionBottom}>
          <span className={css.sessionSummary} title={preview}>{preview}</span>
          {session.unreadCount > 0 && (
            <span className={css.unread} title={unreadTitle(session.unreadCount, session.unreadSince)}>{session.unreadCount}</span>
          )}
        </div>
      </div>
    </button>
  )
}
