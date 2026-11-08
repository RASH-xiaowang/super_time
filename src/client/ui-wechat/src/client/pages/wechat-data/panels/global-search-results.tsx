/**
 * 全局搜索结果面板：把后端已经返回的真实字段组织成可扫读的结果卡片。
 *
 * 这里只负责展示与跳转，不在渲染层做二次数据猜测：
 *   · 会话/消息/联系人/朋友圈/记录用真实 username 拉头像；
 *   · 群消息优先用 `sender_username` 拉发送者头像，缺失时才回退会话头像；
 *   · 联系人只展示后端实际返回的微信号、昵称、备注与群人数；
 *   · 文件与收藏没有“人”的身份，使用明确的类型图标而不是伪造头像。
 *
 * 头像请求复用 `apiGetAvatarBatched` 的攒批队列；同一 tick 里的多个结果只会合成
 * 少量 RPC。缓存与聊天面板一样设置上限，避免长期搜索把 base64 堆在渲染进程里。
 */
import { useEffect, useState, type ReactNode } from 'react'
import type {
  SearchHit,
  UnifiedSearchContact,
  UnifiedSearchFavorite,
  UnifiedSearchFile,
  UnifiedSearchMoment,
  UnifiedSearchRecord,
  WechatSession,
} from '@deepseek-ai/dsh-wechat-data/types'
import { apiGetAvatarBatched } from '../api.ts'
import { avatarColors, fmtBytes, fmtSessionTimeSec } from '../utils/format.ts'
import { cacheBounded } from '../utils/misc.ts'
import { isLegacyChatId, readableChatName } from '../utils/chat-identity.ts'
import { withEnterprise } from './enterprise-identity.ts'
import css from './global-search.module.css'

export interface GlobalSearchResultsState {
  sessions: WechatSession[]
  hits: SearchHit[]
  contacts: UnifiedSearchContact[]
  moments: UnifiedSearchMoment[]
  favorites: UnifiedSearchFavorite[]
  files: UnifiedSearchFile[]
  records: UnifiedSearchRecord[]
  readError?: string
}

interface GlobalSearchResultsProps {
  query: string
  loading: boolean
  results: GlobalSearchResultsState
  onClose: () => void
  onOpenSession: (username: string, localId?: number) => void
  onOpenMoments: (username: string) => void
  onSeed: (target: 'contacts' | 'favorites' | 'files' | 'records', query: string) => void
}

type AvatarKind = 'group' | 'official' | 'private' | 'contact'

const avatarCache = new Map<string, string | null>()
const AVATAR_CACHE_MAX = 240

function GroupGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="11.5" cy="6" r="1.6" />
      <path d="M2.3 12.4c.4-2.1 1.8-3.2 3.7-3.2s3.3 1.1 3.7 3.2M9.3 9.8c1.7-.6 3.4.2 4 1.7" />
    </svg>
  )
}

function OfficialGlyph(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M8 2.2 13 5v5.7L8 13.8 3 10.7V5l5-2.8Z" />
      <path d="m5.6 8 1.5 1.5 3.4-3.4" />
    </svg>
  )
}

function SearchAvatar({ username, name, kind = 'contact', size = 38 }: {
  username: string
  name: string
  kind?: AvatarKind
  size?: number
}): React.JSX.Element {
  const key = username.trim()
  const cached = key ? avatarCache.get(key) : undefined
  const [src, setSrc] = useState<string | null>(cached ?? null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    setFailed(false)
    if (!key) {
      setSrc(null)
      return
    }
    const hit = avatarCache.get(key)
    if (hit !== undefined) {
      setSrc(hit)
      return
    }
    let cancelled = false
    setSrc(null)
    apiGetAvatarBatched({ username: key, nickname: name })
      .then((r) => {
        const value = r.kind === 'data' ? (r.data ?? null) : null
        cacheBounded(avatarCache, key, value, AVATAR_CACHE_MAX)
        if (!cancelled) setSrc(value)
      })
      .catch(() => {
        cacheBounded(avatarCache, key, null, AVATAR_CACHE_MAX)
        if (!cancelled) setSrc(null)
      })
    return () => { cancelled = true }
  }, [key, name])

  const letter = (name || username || '?').slice(0, 1).toUpperCase()
  const colors = avatarColors(username || name || '?')
  const showImage = src !== null && src !== '' && !failed
  return (
    <span
      className={css.avatar}
      style={{ width: size, height: size, ...(showImage ? {} : { background: colors.background, color: colors.color }) }}
      data-search-avatar=""
      data-username={username}
      data-avatar-kind={kind}
      aria-hidden="true"
    >
      {showImage
        ? <img className={css.avatarImage} src={src ?? undefined} alt="" onError={() => { setFailed(true); if (key) cacheBounded(avatarCache, key, null, AVATAR_CACHE_MAX) }} />
        : letter}
      {kind === 'group' && <span className={css.avatarKind}><GroupGlyph /></span>}
      {kind === 'official' && <span className={css.avatarKind}><OfficialGlyph /></span>}
    </span>
  )
}

function DomainIcon({ kind }: { kind: 'message' | 'contact' | 'moment' | 'favorite' | 'file' | 'record' }): React.JSX.Element {
  const path = kind === 'message'
    ? <><path d="M4 4.5h16v10H9l-4 3v-3H4z" /><path d="M8 8h8M8 11h5" /></>
    : kind === 'contact'
      ? <><circle cx="12" cy="8" r="3.5" /><path d="M5.5 19c.7-4 3-6 6.5-6s5.8 2 6.5 6" /></>
      : kind === 'moment'
        ? <><circle cx="12" cy="12" r="7.5" /><path d="M12 4.5v7.5l5 3" /></>
        : kind === 'favorite'
          ? <path d="M7 4.5h10v15l-5-3.4-5 3.4z" />
          : kind === 'file'
            ? <><path d="M6 3.5h7l5 5v12H6z" /><path d="M13 3.5v5h5" /></>
            : <><rect x="4" y="6" width="16" height="12" rx="2" /><path d="M8 12h8M12 8v8" /></>
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {path}
    </svg>
  )
}

function NonPersonGlyph({ kind, label }: { kind: 'favorite' | 'file' | 'record'; label: string }): React.JSX.Element {
  const display = kind === 'file'
    ? (label.split('.').pop() || 'FILE').slice(0, 4).toUpperCase()
    : kind === 'record'
      ? (label.includes('红包') ? '红' : '¥')
      : '藏'
  return (
    <span className={css.glyphTile} data-kind={kind} aria-hidden="true">
      <span className={css.glyphMain}>{display}</span>
      <span className={css.glyphMark}><DomainIcon kind={kind} /></span>
    </span>
  )
}

function ResultGroup({ label, count, icon, children }: {
  label: string
  count: number
  icon: 'message' | 'contact' | 'moment' | 'favorite' | 'file' | 'record'
  children: ReactNode
}): React.JSX.Element {
  return (
    <section className={css.resultGroup} aria-label={`${label}，${count} 条`}>
      <div className={css.group}>
        <span className={css.groupIcon}><DomainIcon kind={icon} /></span>
        <span className={css.groupName}>{label}</span>
        <span className={css.groupCount}>{count}</span>
      </div>
      {children}
    </section>
  )
}

function ResultRow({ avatar, title, badge, snippet, meta, time, aside, onClick, accessibleLabel }: {
  avatar: ReactNode
  title: string
  badge?: ReactNode
  snippet?: string
  meta?: string
  time?: string
  aside?: ReactNode
  onClick: () => void
  accessibleLabel: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={css.row}
      onClick={onClick}
      title={[title, meta, time].filter(Boolean).join('\n')}
      aria-label={accessibleLabel}
      data-search-row=""
    >
      <span className={css.avatarSlot}>{avatar}</span>
      <span className={css.rowBody}>
        <span className={css.titleLine}>
          <span className={css.rowName}>{title}</span>
          {badge}
        </span>
        {snippet !== undefined && snippet !== '' && <span className={css.rowSnippet}>{snippet}</span>}
        {meta !== undefined && meta !== '' && (
          <span className={css.metaRow}>
            <span className={css.rowMeta}>{meta}</span>
          </span>
        )}
      </span>
      <span className={css.rowAside}>
        {time !== undefined && time !== '' && <span className={css.rowTime}>{time}</span>}
        {aside}
      </span>
    </button>
  )
}

function Badge({ tone, children }: { tone: 'cyan' | 'green' | 'amber' | 'neutral' | 'red'; children: ReactNode }): React.JSX.Element {
  return <span className={css.badge} data-tone={tone}>{children}</span>
}

function sessionBadge(session: WechatSession): React.JSX.Element {
  if (session.type === 'group') return <Badge tone="cyan">群聊</Badge>
  if (session.enterpriseName) return <Badge tone="green">企业微信</Badge>
  if (session.accountKind === 'service') return <Badge tone="amber">服务号</Badge>
  if (session.accountKind === 'official') return <Badge tone="amber">公众号</Badge>
  if (session.accountKind === 'kefu') return <Badge tone="green">客服</Badge>
  return <Badge tone="neutral">单聊</Badge>
}

function contactKindLabel(category: string): string {
  if (category === 'group') return '群聊'
  if (category === 'official') return '公众号'
  if (category === 'enterprise') return '企业微信'
  if (category === 'service') return '服务号'
  return '联系人'
}

function contactTone(category: string): 'cyan' | 'green' | 'amber' | 'neutral' {
  if (category === 'group') return 'cyan'
  if (category === 'official') return 'amber'
  if (category === 'enterprise') return 'green'
  if (category === 'service') return 'amber'
  return 'neutral'
}

function contactDetail(contact: UnifiedSearchContact): string {
  const parts: string[] = []
  if (contact.alias !== undefined && contact.alias !== '') parts.push(`微信号 ${contact.alias}`)
  else parts.push(contact.username)
  if (contact.nickname !== undefined && contact.nickname !== '' && contact.nickname !== contact.name) {
    parts.push(`昵称 ${contact.nickname}`)
  }
  if (contact.category === 'group' && contact.memberCount !== undefined) parts.push(`${contact.memberCount} 人`)
  return parts.join(' · ')
}

function recordTitle(record: UnifiedSearchRecord): string {
  const name = (record.name || '').trim()
  if (name !== '' && name !== record.session) return name
  if (record.session.endsWith('@chatroom')) return '未知群聊'
  if (/^gh_/i.test(record.session)) return '未知公众号'
  if (/^wxid_/i.test(record.session)) return '未知联系人'
  return record.session || '未知记录'
}

function recordDisplayTitle(record: UnifiedSearchRecord): string {
  return withEnterprise(recordTitle(record), record.enterpriseName)
}

function recordMeta(record: UnifiedSearchRecord): string {
  return record.transferId || record.messageServerId || record.sourceId || record.session
}

function sum<T>(items: readonly T[]): number {
  return items.length
}

/**
 * 渲染全局搜索右侧结果面板的内容。
 */
export function GlobalSearchResults({
  query,
  loading,
  results,
  onClose,
  onOpenSession,
  onOpenMoments,
  onSeed,
}: GlobalSearchResultsProps): React.JSX.Element {
  const sessions = results.sessions.filter((session) => !isLegacyChatId(session.username))
  const hits = results.hits.filter((hit) => !isLegacyChatId(hit.username))
  const total = sum(sessions) + sum(hits) + sum(results.contacts) + sum(results.moments)
    + sum(results.favorites) + sum(results.files) + sum(results.records)
  const empty = !loading && total === 0 && results.readError === undefined

  return (
    <div className={css.resultsRoot} aria-busy={loading || undefined}>
      <div className={css.overview} aria-live="polite">
        <span className={css.overviewIcon}><DomainIcon kind="message" /></span>
        <span className={css.overviewText}>
          <span className={css.overviewTitle}>搜索结果</span>
          <span className={css.overviewQuery} title={query}>{query}</span>
        </span>
        <span className={css.overviewCount}>{total} 条</span>
        {loading && <span className={css.loadingDot} aria-label="搜索中" />}
      </div>

      {results.readError !== undefined && (
        <div className={css.errorBox} role="alert">
          <span className={css.errorMark}>!</span>
          <span>{results.readError}</span>
        </div>
      )}

      {loading && total === 0 && (
        <div className={css.skeletonList} aria-hidden="true">
          {[0, 1, 2].map(i => (
            <div key={i} className={css.skeletonRow}>
              <span className={css.skeletonAvatar} />
              <span className={css.skeletonBody}>
                <span className={css.skeletonLine} />
                <span className={css.skeletonLine} data-short="" />
              </span>
            </div>
          ))}
        </div>
      )}

      {empty && (
        <div className={css.emptyState} role="status">
          <span className={css.emptyIcon}><DomainIcon kind="message" /></span>
          <span className={css.emptyTitle}>没有找到相关内容</span>
          <span className={css.emptyHint}>换一个昵称、微信号、群名或关键词试试</span>
        </div>
      )}

      {sessions.length > 0 && (
        <ResultGroup label="会话" count={sessions.length} icon="message">
          {sessions.map((session) => {
            const name = readableChatName(session.displayName, session.username)
            const displayName = withEnterprise(name, session.enterpriseName)
            const summary = session.draft !== ''
              ? `草稿：${session.draft}`
              : session.summary
            return (
              <ResultRow
                key={session.username}
                avatar={<SearchAvatar username={session.username} name={name} kind={session.type === 'group' ? 'group' : session.username.startsWith('gh_') ? 'official' : 'private'} />}
                title={displayName}
                badge={sessionBadge(session)}
                snippet={summary}
                meta={session.username}
                time={fmtSessionTimeSec(session.lastTimestamp)}
                aside={session.unreadCount > 0 ? <span className={css.unread}>{session.unreadCount > 99 ? '99+' : session.unreadCount}</span> : undefined}
                onClick={() => { onClose(); onOpenSession(session.username) }}
                accessibleLabel={`打开${session.type === 'group' ? '群聊' : '会话'} ${displayName}`}
              />
            )
          })}
        </ResultGroup>
      )}

      {hits.length > 0 && (
        <ResultGroup label="消息" count={hits.length} icon="message">
          {hits.map((hit, index) => {
            const group = hit.username.endsWith('@chatroom')
            const senderName = group
              ? readableChatName(hit.sender || hit.name, hit.username)
              : readableChatName(hit.name, hit.username)
            const senderUsername = group ? hit.sender_username?.trim() : undefined
            const hasSenderAvatar = senderUsername !== undefined && senderUsername !== ''
            const avatarUsername = hasSenderAvatar ? senderUsername : hit.username
            const avatarName = group && hit.sender !== undefined && hit.sender !== '' ? hit.sender : senderName
            const sessionLabel = withEnterprise(
              readableChatName(hit.name, hit.username),
              hit.enterpriseName,
            )
            const displayName = withEnterprise(senderName, group ? hit.senderEnterpriseName : hit.enterpriseName)
            const source = group ? `来源 ${sessionLabel}` : `单聊 · ${sessionLabel}`
            return (
              <ResultRow
                key={`${hit.username}:${hit.local_id}:${index}`}
                // 有发送者 wxid 时取的是个人头像；只有退回会话头像时才标群聊角标。
                avatar={<SearchAvatar username={avatarUsername} name={hasSenderAvatar ? avatarName : hit.name} kind={hasSenderAvatar || !group ? 'private' : 'group'} />}
                title={displayName}
                badge={group ? <Badge tone="cyan">群消息</Badge> : <Badge tone="neutral">单聊</Badge>}
                snippet={hit.snippet || hit.text}
                meta={source}
                time={fmtSessionTimeSec(hit.create_time) || hit.time}
                onClick={() => { onClose(); onOpenSession(hit.username, hit.local_id) }}
                accessibleLabel={`打开消息：${displayName}，${hit.snippet}`}
              />
            )
          })}
        </ResultGroup>
      )}

      {results.contacts.length > 0 && (
        <ResultGroup label="联系人" count={results.contacts.length} icon="contact">
          {results.contacts.map((contact, index) => {
            const kind = contact.category === 'group' ? 'group' : contact.category === 'official' ? 'official' : 'contact'
            return (
              <ResultRow
                key={`${contact.username}:${index}`}
                avatar={<SearchAvatar username={contact.username} name={contact.name} kind={kind} />}
                title={withEnterprise(contact.name, contact.enterpriseName)}
                badge={<Badge tone={contactTone(contact.category)}>{contactKindLabel(contact.category)}</Badge>}
                snippet={contact.remark !== undefined && contact.nickname !== undefined && contact.remark !== contact.nickname
                  ? `昵称 ${contact.nickname}`
                  : undefined}
                meta={contactDetail(contact)}
                onClick={() => {
                  onClose()
                  if (contact.category === 'contact' || contact.category === 'group' || contact.category === 'enterprise') onOpenSession(contact.username)
                  else onSeed('contacts', query)
                }}
                accessibleLabel={`${contactKindLabel(contact.category)} ${withEnterprise(contact.name, contact.enterpriseName)}`}
              />
            )
          })}
        </ResultGroup>
      )}

      {results.moments.length > 0 && (
        <ResultGroup label="朋友圈" count={results.moments.length} icon="moment">
          {results.moments.map((moment, index) => (
            <ResultRow
              key={`${moment.username}:${moment.tid}:${index}`}
              avatar={<SearchAvatar username={moment.username} name={moment.name} />}
              title={withEnterprise(moment.name || moment.username, moment.enterpriseName)}
              badge={<Badge tone="neutral">动态</Badge>}
              snippet={moment.snippet}
              meta={moment.mediaKind === 'video' ? '视频动态' : moment.mediaKind === 'image' ? '图片动态' : '文字动态'}
              time={moment.time}
              onClick={() => { onClose(); onOpenMoments(moment.username) }}
              accessibleLabel={`查看 ${withEnterprise(moment.name || moment.username, moment.enterpriseName)} 的朋友圈`}
            />
          ))}
        </ResultGroup>
      )}

      {results.favorites.length > 0 && (
        <ResultGroup label="收藏" count={results.favorites.length} icon="favorite">
          {results.favorites.map((favorite, index) => {
            const fileName = favorite.fileName !== undefined && favorite.fileName !== '' ? favorite.fileName : ''
            const source = favorite.source !== undefined && favorite.source !== ''
              ? withEnterprise(favorite.source, favorite.sourceEnterpriseName)
              : ''
            const meta = [fileName, source].filter(Boolean).join(' · ') || `收藏 #${favorite.id}`
            return (
              <ResultRow
                key={`${favorite.id}:${index}`}
                avatar={<NonPersonGlyph kind="favorite" label={favorite.typeLabel} />}
                title={favorite.title || favorite.snippet || `收藏 #${favorite.id}`}
                badge={<Badge tone="amber">{favorite.typeLabel}</Badge>}
                snippet={favorite.snippet}
                meta={meta}
                time={fmtSessionTimeSec(favorite.updateTime) || favorite.time}
                onClick={() => { onClose(); onSeed('favorites', query) }}
                accessibleLabel={`打开收藏 ${favorite.title || favorite.snippet}`}
              />
            )
          })}
        </ResultGroup>
      )}

      {results.files.length > 0 && (
        <ResultGroup label="文件" count={results.files.length} icon="file">
          {results.files.map((file, index) => (
            <ResultRow
              key={`${file.fileName}:${file.md5}:${index}`}
              avatar={<NonPersonGlyph kind="file" label={file.fileName} />}
              title={file.fileName || '未命名文件'}
              badge={<Badge tone="neutral">{file.category === 'image' ? '图片' : file.category === 'video' ? '视频' : '文件'}</Badge>}
              meta={[fmtBytes(file.size), file.md5 !== '' ? `MD5 ${file.md5.slice(0, 12)}…` : ''].filter(Boolean).join(' · ')}
              time={fmtSessionTimeSec(file.modifyTime) || file.time}
              onClick={() => { onClose(); onSeed('files', query) }}
              accessibleLabel={`打开文件 ${file.fileName}`}
            />
          ))}
        </ResultGroup>
      )}

      {results.records.length > 0 && (
        <ResultGroup label="记录" count={results.records.length} icon="record">
          {results.records.map((record, index) => (
            <ResultRow
              key={`${record.kind}:${record.session}:${record.sourceId}:${index}`}
              avatar={<NonPersonGlyph kind="record" label={record.kind === 'transfers' ? '转账' : '红包'} />}
              title={recordDisplayTitle(record)}
              badge={<Badge tone={record.kind === 'transfers' ? 'green' : 'red'}>{record.kind === 'transfers' ? '转账' : '红包'}</Badge>}
              meta={recordMeta(record)}
              time={record.time}
              onClick={() => { onClose(); onSeed('records', query) }}
              accessibleLabel={`打开${record.kind === 'transfers' ? '转账' : '红包'}记录 ${recordDisplayTitle(record)}，会话 ${record.session}`}
            />
          ))}
        </ResultGroup>
      )}
    </div>
  )
}
