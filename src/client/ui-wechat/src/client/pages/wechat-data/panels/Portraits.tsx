/**
 * 客户画像与标签主页面。
 *
 * 页面分三层：左侧客户目录负责找人和切换；右侧上方「客户画像」解释身份、关系与
 * 互动事实；右侧下方「客户标签」展示规则标签及其依据。客户 360 只对当前选中的好友
 * 按需读取。目录只收通讯录好友，不分析企业微信联系人和群成员。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiGetContacts, apiGetPortraitVolumes, type PortraitVolume } from '../api.ts'
import { EmptyState, ErrorState, LoadingState, PanelHeader, SearchInput } from '../ui/kit.tsx'
import { LazyMount, ListSentinel, ProgressiveListSpacer, useProgressiveList, useWechatDataUpdated } from './hooks.tsx'
import { Avatar } from './chats-support.tsx'
import { CustomerPortraitView } from './CustomerPortraitView.tsx'
import { withEnterprise } from './enterprise-identity.ts'
import {
  CUSTOMER_RELATION_LABELS,
  customerIdentityOf,
  customerRelation,
  mergeCustomerCandidates,
  type CustomerRecord,
} from './customer-profile.ts'
import { useCustomer360 } from './use-customer-360.ts'
import css from './portraits.module.css'

function customerSearchText(customer: CustomerRecord): string {
  return [
    customer.displayName,
    customer.remark,
    customer.nickName,
    customer.username,
    customer.alias ?? '',
    customer.enterpriseName ?? '',
    customer.groupName ?? '',
    customer.quanPin ?? '',
    customer.remarkQuanPin ?? '',
  ].join('\n').toLocaleLowerCase()
}

/** 目录行里的关系短标签。 */
function rowRelation(customer: CustomerRecord): string {
  const relation = customerRelation(customerIdentityOf(customer), { source: 'directory' })
  return CUSTOMER_RELATION_LABELS[relation]
}

/** 右侧空态：加载中、错误、无客户三种情况分开说。 */
function DetailPlaceholder({
  loading, error, hasAnyCustomer, onRetry,
}: {
  loading: boolean
  error: string | null
  hasAnyCustomer: boolean
  onRetry: () => void
}): React.JSX.Element {
  if (loading) return <LoadingState label="正在读取客户目录…" />
  if (error) return <ErrorState message="客户目录读取失败" detail={error} onRetry={onRetry} />
  return (
    <EmptyState
      icon="👤"
      title={hasAnyCustomer ? '选择一位好友' : '暂无可生成画像的好友'}
    />
  )
}

export interface PortraitsPanelProps {
  onOpenChat?: ((username: string) => void) | undefined
  /** 从社交图谱点进来时，直接选中这位好友。 */
  focusUsername?: string | null
}

/** 客户画像与标签页面。 */
export function PortraitsPanel({ onOpenChat, focusUsername = null }: PortraitsPanelProps): React.JSX.Element {
  const [customers, setCustomers] = useState<CustomerRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [selectedUsername, setSelectedUsername] = useState<string | null>(null)
  const [volumes, setVolumes] = useState<ReadonlyMap<string, PortraitVolume>>(() => new Map())
  const [ranked, setRanked] = useState(false)
  const [picked, setPicked] = useState(false)
  const loadSequence = useRef(0)

  const loadCustomers = useCallback(async (silent = false): Promise<void> => {
    const sequence = ++loadSequence.current
    if (!silent) setLoading(true)
    setError(null)
    try {
      const env = await apiGetContacts({ categories: ['friend'] })
      if (sequence !== loadSequence.current) return
      setCustomers(mergeCustomerCandidates([env.contacts]))
      setWarnings([])
      setError(null)
    } catch (e) {
      if (sequence !== loadSequence.current) return
      setWarnings([])
      setError((e as Error).message)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void loadCustomers()
    return () => { loadSequence.current += 1 }
  }, [loadCustomers])
  useWechatDataUpdated(() => { void loadCustomers(true) })

  useEffect(() => {
    const username = focusUsername?.trim() ?? ''
    if (username === '') return
    setPicked(true)
    setSelectedUsername(username)
  }, [focusUsername])

  useEffect(() => {
    if (customers.length === 0) {
      setVolumes(new Map())
      setRanked(true)
      return
    }
    setRanked(false)
    let alive = true
    void apiGetPortraitVolumes(customers.map((customer) => customer.username))
      .then((rows) => {
        if (!alive) return
        setVolumes(new Map(rows.map((row) => [row.username, row])))
      })
      .catch(() => { /* 统计失败时目录仍按姓名排列 */ })
      .finally(() => { if (alive) setRanked(true) })
    return () => { alive = false }
  }, [customers])

  const selected = useMemo(
    () => customers.find((customer) => customer.username === selectedUsername) ?? null,
    [customers, selectedUsername],
  )
  const { snapshot, loading: profileLoading, error: profileError, reload } = useCustomer360(selected?.username ?? null)

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    const score = (username: string): number => {
      const row = volumes.get(username)
      if (row === undefined) return 0
      return row.messages + row.images + row.moments
    }
    return customers
      .filter((customer) => query === '' || customerSearchText(customer).includes(query))
      .sort((a, b) => {
        const diff = score(b.username) - score(a.username)
        if (diff !== 0) return diff
        return (a.displayName || a.username).localeCompare(b.displayName || b.username, 'zh-Hans-CN')
      })
  }, [customers, search, volumes])

  useEffect(() => {
    if (!ranked) return
    const focus = focusUsername?.trim() ?? ''
    if (picked) {
      setSelectedUsername((current) => {
        if (current !== null && customers.some((customer) => customer.username === current)) return current
        if (focus !== '' && customers.some((customer) => customer.username === focus)) return focus
        return filtered[0]?.username ?? null
      })
      return
    }
    if (focus !== '') return
    setSelectedUsername(filtered[0]?.username ?? null)
  }, [ranked, picked, filtered, customers, focusUsername])

  const directoryListRef = useRef<HTMLDivElement | null>(null)
  const {
    start: visibleStart,
    count: visibleCount,
    beforeHeight: visibleBeforeHeight,
    sentinelRef,
    topSentinelRef,
  } = useProgressiveList(filtered.length, 120, {
    maxCount: 300,
    resetKey: `${search}\u0000${filtered[0]?.username ?? ''}`,
    listRef: directoryListRef,
  })
  const shownCustomers = filtered.slice(visibleStart, visibleCount)

  const selectedIdentity = selected ? customerIdentityOf(selected) : null

  return (
    <div className={css.panel}>
      <PanelHeader
        title="客户画像与标签"
        actions={<span className={css.ruleBadge}>{customers.length.toLocaleString()} 位好友</span>}
      />

      <div className={css.workspace}>
        <aside className={css.directory} aria-label="客户目录">
          <div className={css.directoryHeader}>
            <span className={css.directoryTitle}>好友目录</span>
            <span className={css.directoryCount}>{filtered.length.toLocaleString()} / {customers.length.toLocaleString()}</span>
          </div>
          <div className={css.directoryTools}>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="搜索备注 / 昵称 / 微信号"
              ariaLabel="搜索好友"
              className={css.directorySearch}
            />
          </div>

          {warnings.map((warning) => (
            <div key={warning} className={css.notice} role="status">{warning}</div>
          ))}

          <div ref={directoryListRef} className={css.directoryList}>
            {loading && customers.length === 0 && <LoadingState label="正在读取好友…" />}
            {!loading && error && customers.length === 0 && (
              <ErrorState message="客户目录读取失败" detail={error} onRetry={() => { void loadCustomers() }} />
            )}
            {!loading && !error && filtered.length === 0 && (
              <EmptyState
                icon="🔎"
                title={search.trim() === '' ? '暂无好友' : '未找到匹配好友'}
                desc={search.trim() === '' ? '等待本机通讯录同步完成后再看。' : '试试备注、昵称或微信号的其它片段。'}
              />
            )}
            <ProgressiveListSpacer height={visibleBeforeHeight} topSentinelRef={topSentinelRef} />
            {shownCustomers.map((customer, idx) => {
              const name = customer.displayName || customer.remark || customer.nickName || customer.username
              const identity = withEnterprise(name, customer.enterpriseName)
              const groups = customer.groupUsernames?.length ?? 0
              const volume = volumes.get(customer.username)
              const volumeTotal = volume === undefined ? null : volume.messages + volume.images + volume.moments
              const volumeTitle = volume === undefined
                ? '正在统计聊天、图片和朋友圈'
                : `聊天 ${volume.messages.toLocaleString()} · 图片 ${volume.images.toLocaleString()} · 朋友圈 ${volume.moments.toLocaleString()}`
              return (
                <button
                  key={customer.username}
                  type="button"
                  className={css.customerRow}
                  data-progressive-item={visibleStart + idx}
                  data-active={selectedUsername === customer.username || undefined}
                  onClick={() => { setPicked(true); setSelectedUsername(customer.username) }}
                  aria-pressed={selectedUsername === customer.username}
                >
                  <LazyMount
                    placeholder={<span className={css.avatarStub} style={{ width: 34, height: 34 }} />}
                    rootMargin="240px 0px"
                  >
                    <Avatar name={name} username={customer.username} avatarUrl={customer.avatarUrl} size={34} />
                  </LazyMount>
                  <span className={css.rowText}>
                    <span className={css.rowName} title={identity}>{identity}</span>
                    <span className={css.rowMeta}>
                      {customer.username}
                      {groups > 0 ? ` · ${groups} 个群` : ''}
                    </span>
                  </span>
                  <span className={css.rowRelation} title={volumeTitle}>
                    {volumeTotal === null ? rowRelation(customer) : volumeTotal.toLocaleString()}
                  </span>
                </button>
              )
            })}
            {filtered.length > visibleCount && <ListSentinel refFn={sentinelRef} />}
          </div>
        </aside>

        <section className={css.detailColumn} aria-label="客户详情">
          {selectedIdentity === null ? (
            <div className={css.detailEmpty}>
              <DetailPlaceholder
                loading={loading || (customers.length > 0 && !ranked)}
                error={error}
                hasAnyCustomer={customers.length > 0}
                onRetry={() => { void loadCustomers() }}
              />
            </div>
          ) : (
            <CustomerPortraitView
              identity={selectedIdentity}
              snapshot={snapshot}
              loading={profileLoading}
              error={profileError}
              onRetry={reload}
              context={{ source: 'directory' }}
              {...(onOpenChat ? { onOpenChat: () => { onOpenChat(selectedIdentity.username) } } : {})}
            />
          )}
        </section>
      </div>
    </div>
  )
}
