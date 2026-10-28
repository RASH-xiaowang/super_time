import clsx from 'clsx'
import { Avatar } from './chats-support.tsx'
import css from './identity.module.css'

/**
 * A compact avatar + name row shared by list, table and detail surfaces.
 *
 * `username` must be the real wxid/username. Callers that only have a display
 * name pass an empty string so Avatar can render a letter tile without probing
 * the wrong contact.
 */
export function IdentityName({
  name,
  username = '',
  avatarUrl,
  size = 24,
  className,
  textClassName,
  title,
  children,
}: {
  name: string
  username?: string
  avatarUrl?: string
  size?: number
  className?: string
  textClassName?: string
  title?: string
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <span className={clsx(css.identity, className)} title={title}>
      <Avatar name={name || username || '?'} username={username} avatarUrl={avatarUrl} size={size} />
      <span className={clsx(css.text, textClassName)}>{children ?? (name || '—')}</span>
    </span>
  )
}
