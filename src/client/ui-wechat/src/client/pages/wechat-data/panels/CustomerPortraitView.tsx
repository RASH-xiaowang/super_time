/**
 * 客户画像与标签的共享内容区。
 *
 * 主页面和聊天侧画像抽屉都渲染这一个组件，避免同一套规则在两个入口长出不同的
 * 信息层级。两个清晰板块固定为「客户画像」和「客户标签」，标签依据始终可见。
 */
import { useId, useMemo, useState } from 'react'
import type { Contact360Snapshot } from '@deepseek-ai/dsh-wechat-data/types'
import { EmptyState, ErrorState, LoadingState } from '../ui/kit.tsx'
import { Avatar } from './chats-support.tsx'
import {
  CUSTOMER_RELATION_LABELS,
  CUSTOMER_TAG_CATEGORIES,
  buildCustomerTags,
  confidenceLabel,
  customerActivity,
  customerDisplayName,
  customerRelation,
  type CustomerIdentity,
  type CustomerProfileContext,
  type CustomerTag,
} from './customer-profile.ts'
import { withEnterprise } from './enterprise-identity.ts'
import { IdentityName } from './identity.tsx'
import css from './portraits.module.css'

export interface CustomerPortraitViewProps {
  identity: CustomerIdentity
  snapshot: Contact360Snapshot | null
  loading?: boolean
  error?: string | null
  onRetry?: () => void
  context?: CustomerProfileContext
  onOpenChat?: (() => void) | undefined
  compact?: boolean
}

function fmtDate(timestamp: number | null): string {
  if (timestamp === null || timestamp <= 0) return '暂无'
  const d = new Date(timestamp * 1000)
  if (Number.isNaN(d.getTime())) return '暂无'
  return d.toLocaleString('zh-CN', { hour12: false })
}

function categoryText(identity: CustomerIdentity): string {
  const labels: Record<string, string> = {
    friend: '联系人',
    enterprise: '企业微信',
    member: '群成员',
  }
  const values = [...new Set([...(identity.categories ?? []), identity.category ?? ''])]
    .map((value) => labels[value] ?? '')
    .filter((value) => value !== '')
  return values.length > 0 ? values.join(' · ') : '本机会话联系人'
}

function groupFactText(identity: CustomerIdentity, snapshot: Contact360Snapshot | null): string {
  const namedGroup = identity.groupName?.trim() ?? ''
  if (namedGroup !== '' && !namedGroup.endsWith('@chatroom')) return namedGroup
  const commonGroups = snapshot?.commonGroups ?? []
  const names = commonGroups.map((group) => group.name.trim()).filter((name) => name !== '')
  if (names.length === 1) return names[0] ?? ''
  if (names.length > 1) return `${names[0]} 等 ${names.length} 个群`
  const count = commonGroups.length || identity.groupUsernames?.length || 0
  return count > 0 ? `${count} 个共同群` : '暂无'
}

function Fact({ label, value, title }: { label: string; value: string; title?: string }): React.JSX.Element {
  return (
    <div className={css.fact}>
      <span className={css.factLabel}>{label}</span>
      <span className={css.factValue} title={title ?? value}>{value}</span>
    </div>
  )
}

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }): React.JSX.Element {
  return (
    <div className={css.metric}>
      <span className={css.metricValue}>{value}</span>
      <span className={css.metricLabel}>{label}</span>
      {hint && <span className={css.metricHint}>{hint}</span>}
    </div>
  )
}

function ProfileSummary({
  identity, snapshot, loading, error, context, onOpenChat,
}: Omit<CustomerPortraitViewProps, 'compact'>): React.JSX.Element {
  const name = customerDisplayName(identity)
  const displayIdentity = withEnterprise(name, identity.enterpriseName)
  const relation = customerRelation(identity, context)
  const activity = customerActivity(snapshot, context)
  const groupCount = snapshot?.commonGroups.length ?? identity.groupUsernames?.length ?? 0
  const relationLabel = CUSTOMER_RELATION_LABELS[relation]
  const categoryLabel = categoryText(identity)
  const activityLabel = loading
    ? '正在汇总'
    : error
      ? '统计待重试'
      : activity.label

  return (
    <header className={css.profileSummary}>
      <Avatar name={name} username={identity.username} avatarUrl={identity.avatarUrl} size={72} />
      <div className={css.summaryIdentity}>
        <div className={css.nameLine}>
          <h3 className={css.customerName}>{displayIdentity}</h3>
          <span className={css.relationChip}>{relationLabel}</span>
        </div>
        {categoryLabel !== relationLabel && <p className={css.identityMeta}>{categoryLabel}</p>}
        <div className={css.summaryFacts}>
          <span><small>微信号</small><strong>{identity.username}</strong></span>
          <span><small>共同群</small><strong>{groupCount > 0 ? `${groupCount} 个` : '暂无'}</strong></span>
        </div>
      </div>
      <div className={css.summarySide}>
        <span className={css.summaryActivity} data-code={loading ? 'loading' : error ? 'error' : activity.code}>
          <span className={css.activityDot} aria-hidden="true" />
          {activityLabel}
        </span>
        {onOpenChat && (
          <button type="button" className={css.primaryAction} onClick={onOpenChat}>
            打开聊天
          </button>
        )}
      </div>
    </header>
  )
}

function ProfileBoard({
  identity, snapshot, loading, error, onRetry, context,
}: Omit<CustomerPortraitViewProps, 'compact'>): React.JSX.Element {
  const activity = customerActivity(snapshot, context)
  const headingId = useId()

  return (
    <section className={css.board} aria-labelledby={headingId}>
      <header className={css.boardHeader}>
        <div>
          <h3 className={css.boardTitle} id={headingId}>客户画像</h3>
          <p className={css.boardDesc}>身份、关系和互动事实，均来自本机微信数据。</p>
        </div>
        <span className={css.ruleBadge}>本机规则</span>
      </header>

      <div className={css.sectionBlock}>
        <div className={css.sectionHeading}>
          <h4>身份资料</h4>
          <span>{categoryText(identity)}</span>
        </div>
        <div className={css.factGrid}>
          <Fact label="显示名称" value={withEnterprise(customerDisplayName(identity), identity.enterpriseName)} />
          {identity.enterpriseName?.trim() && <Fact label="企业名称" value={identity.enterpriseName.trim()} />}
          <Fact label="备注" value={identity.remark?.trim() || '未设置'} />
          <Fact label="昵称" value={identity.nickName?.trim() || '未设置'} />
          <Fact label="微信号" value={identity.username} />
          <Fact label="别名" value={identity.alias?.trim() || '未设置'} />
          <Fact label="所属群" value={groupFactText(identity, snapshot)} />
          {identity.description?.trim() && <Fact label="个性签名" value={identity.description.trim()} />}
        </div>
      </div>

      <div className={css.sectionBlock}>
        <div className={css.sectionHeading}>
          <h4>互动事实</h4>
          <span>按最近消息与累计记录计算</span>
        </div>

        {loading && <LoadingState label="正在汇总画像数据…" />}
        {!loading && error && (
          <ErrorState
            message="画像统计暂时读取失败"
            detail={error}
            {...(onRetry ? { onRetry } : {})}
          />
        )}
        {!loading && !error && snapshot && (
          <>
            <div className={css.activityBanner} data-code={activity.code}>
              <span className={css.activityDot} aria-hidden="true" />
              <div>
                <strong>{activity.label}</strong>
                <span>{activity.evidence}</span>
              </div>
            </div>
            <div className={css.metricGrid}>
              <Metric label="消息总数" value={snapshot.messages.count.toLocaleString()} />
              <Metric label="最近联系" value={fmtDate(snapshot.messages.lastTime)} />
              <Metric label="朋友圈内容" value={snapshot.moments.count.toLocaleString()} />
              <Metric label="共同群" value={snapshot.commonGroups.length.toLocaleString()} />
            </div>
            <div className={css.secondaryStats}>
              <span><small>首次联系</small><strong>{fmtDate(snapshot.messages.firstTime)}</strong></span>
              <span><small>转账往来</small><strong>{snapshot.funds.transfers.toLocaleString()}</strong></span>
              <span><small>红包往来</small><strong>{snapshot.funds.redpackets.toLocaleString()}</strong></span>
            </div>
            {snapshot.commonGroups.length > 0 && (
              <div className={css.groupList} aria-label="共同群">
                {snapshot.commonGroups.map((group) => (
                  <span key={group.username} className={css.groupChip} title={group.username}>
                    <IdentityName
                      className={css.groupIdentity}
                      name={group.name || group.username}
                      username={group.username}
                      size={16}
                    >
                      {group.name || group.username}
                    </IdentityName>
                    <small>{group.memberCount} 人</small>
                  </span>
                ))}
              </div>
            )}
            <p className={css.sourceNote}>
              统计更新时间：{fmtDate(snapshot.updatedAt)}。消息、朋友圈、资金与共同群分别读取本机对应数据库。
            </p>
          </>
        )}
        {!loading && !error && snapshot === null && (
          <EmptyState
            icon="📇"
            title="暂无画像统计"
            desc="身份资料仍可查看；互动统计需要本机数据同步完成后才能生成。"
          />
        )}
      </div>
    </section>
  )
}

function TagButton({ tag, active, onClick }: {
  tag: CustomerTag
  active: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className={css.tagChip}
      data-active={active || undefined}
      aria-pressed={active}
      onClick={onClick}
    >
      <span>{tag.label}</span>
      <small>{confidenceLabel(tag.confidence)}</small>
    </button>
  )
}

function TagBoard({ identity, snapshot, context }: {
  identity: CustomerIdentity
  snapshot: Contact360Snapshot | null
  context: CustomerProfileContext
}): React.JSX.Element {
  const headingId = useId()
  const tags = useMemo(
    () => buildCustomerTags(identity, snapshot, context),
    [identity, snapshot, context],
  )
  const [selectedCode, setSelectedCode] = useState<string>('')
  const selected = tags.find((tag) => tag.code === selectedCode) ?? tags[0] ?? null
  const grouped = CUSTOMER_TAG_CATEGORIES
    .map((category) => ({ category, items: tags.filter((tag) => tag.category === category) }))
    .filter((group) => group.items.length > 0)

  return (
    <section className={css.board} aria-labelledby={headingId}>
      <header className={css.boardHeader}>
        <div>
          <h3 className={css.boardTitle} id={headingId}>客户标签</h3>
          <p className={css.boardDesc}>每条标签都由固定阈值与可复查的本机记录生成，不做意向推断。</p>
        </div>
        <span className={css.tagCount}>{tags.length} 个标签</span>
      </header>

      {grouped.length === 0 ? (
        <EmptyState icon="🏷️" title="暂无标签" desc="当前数据不足，未生成任何可核验标签。" />
      ) : (
        <div className={css.tagGroups}>
          {grouped.map((group) => (
            <div key={group.category} className={css.tagGroup}>
              <span className={css.tagGroupLabel}>{group.category}</span>
              <div className={css.tagRow}>
                {group.items.map((tag) => (
                  <TagButton
                    key={tag.code}
                    tag={tag}
                    active={selected?.code === tag.code}
                    onClick={() => { setSelectedCode(tag.code) }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {selected && (
        <div className={css.tagDetail} aria-live="polite">
          <div className={css.tagDetailTop}>
            <strong>{selected.label}</strong>
            <span>{selected.category} · 置信度 {confidenceLabel(selected.confidence)}</span>
          </div>
          <p>{selected.evidence}</p>
          <small>来源：本机规则自动生成 · 可回到对应数据页核验</small>
        </div>
      )}
    </section>
  )
}

/** 渲染完整的客户画像与标签内容。 */
export function CustomerPortraitView({
  identity, snapshot, loading = false, error = null, onRetry, context = {}, onOpenChat, compact = false,
}: CustomerPortraitViewProps): React.JSX.Element {
  return (
    <div className={css.portraitView} data-compact={compact || undefined} data-st-customer-portrait="">
      <ProfileSummary
        identity={identity}
        snapshot={snapshot}
        loading={loading}
        error={error}
        context={context}
        onOpenChat={onOpenChat}
      />
      <div className={css.portraitGrid}>
        <ProfileBoard
          identity={identity}
          snapshot={snapshot}
          loading={loading}
          error={error}
          {...(onRetry ? { onRetry } : {})}
          context={context}
        />
        <TagBoard identity={identity} snapshot={snapshot} context={context} />
      </div>
    </div>
  )
}
