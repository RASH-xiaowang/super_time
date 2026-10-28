/**
 * 客户画像与标签主页面。
 *
 * 页面分三层：左侧客户目录负责找人和切换；右侧上方「客户画像」解释身份、关系与
 * 互动事实；右侧下方「客户标签」展示规则标签及其依据。客户 360 只对当前选中项
 * 按需读取，目录本身由好友、企业微信、群成员三个分类一次合并，避免 N+1 请求。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { WechatContact } from '@deepseek-ai/dsh-wechat-data/types'
import { apiGetContacts } from '../api.ts'
import { EmptyState, ErrorState, LoadingState, PanelHeader, SearchInput } from '../ui/kit.tsx'
import { LazyMount, ListSentinel, useProgressiveList, useWechatDataUpdated } from './hooks.tsx'
import { Avatar } from './chats-support.tsx'
import { CustomerPortraitView } from './CustomerPortraitView.tsx'
import { withEnterprise } from './enterprise-identity.ts'
import {
  CUSTOMER_CATEGORY_KEYS,
  CUSTOMER_RELATION_LABELS,
  customerIdentityOf,
  customerRelation,
  mergeCustomerCandidates,
  type CustomerCategory,
  type CustomerRecord,
} from './customer-profile.ts'
import { useCustomer360 } from './use-customer-360.ts'
import css from './portraits.module.css'

const CATEGORY_LABELS: Readonly<Record<CustomerCategory, string>> = {
  friend: '联系人',
  enterprise: '企业微信',
  member: '群成员',
}

type CategoryFilter = 'all' | CustomerCategory

function categoryFilterMatches(customer: CustomerRecord, filter: CategoryFilter): boolean {
  return filter === 'all' || customer.categories.includes(filter)
}

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
      title={hasAnyCustomer ? '选择一个客户' : '暂无可生成画像的客户'}
      desc={hasAnyCustomer
        ? '从左侧目录选择联系人，查看画像、互动事实和可核验标签。'
        : '客户目录由好友、企业微信联系人和群成员组成；群聊、公众号与服务号不会作为客户出现。'}
    />
  )
}

export interface PortraitsPanelProps {
  onOpenChat?: ((username: string) => void) | undefined
}

/** 客户画像与标签页面。 */
export function PortraitsPanel({ onOpenChat }: PortraitsPanelProps): React.JSX.Element {
  const [customers, setCustomers] = useState<CustomerRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [warnings, setWarnings] = useState<string[]>([])
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<CategoryFilter>('all')
  const [selectedUsername, setSelectedUsername] = useState<string | null>(null)
  const loadSequence = useRef(0)

  const loadCustomers = useCallback(async (silent = false): Promise<void> => {
    const sequence = ++loadSequence.current
    if (!silent) setLoading(true)
    setError(null)
    const results = await Promise.allSettled(
      CUSTOMER_CATEGORY_KEYS.map((category) => apiGetContacts({ category })),
    )
    // 实时刷新与首次加载可能并发；旧响应晚到时不能让目录倒退。
    if (sequence !== loadSequence.current) return
    const batches: WechatContact[][] = []
    const failed: string[] = []
    results.forEach((result, index) => {
      const category = CUSTOMER_CATEGORY_KEYS[index] ?? 'friend'
      if (result.status === 'fulfilled') batches.push(result.value.contacts)
      else failed.push(CATEGORY_LABELS[category])
    })

    const merged = mergeCustomerCandidates(batches)
    if (batches.length > 0) {
      setCustomers(merged)
      setWarnings(failed.length > 0 ? [`以下分类暂时未读到：${failed.join('、')}。当前目录可能不完整。`] : [])
      setError(null)
    } else {
      const reason = results
        .map((result) => result.status === 'rejected' ? (result.reason as Error).message : '')
        .find((message) => message !== '') ?? '未知错误'
      setWarnings([])
      setError(reason)
    }
    setLoading(false)
  }, [])

  useEffect(() => {
    void loadCustomers()
    return () => { loadSequence.current += 1 }
  }, [loadCustomers])
  useWechatDataUpdated(() => { void loadCustomers(true) })

  useEffect(() => {
    setSelectedUsername((current) => {
      if (current !== null && customers.some((customer) => customer.username === current)) return current
      return customers[0]?.username ?? null
    })
  }, [customers])

  const selected = useMemo(
    () => customers.find((customer) => customer.username === selectedUsername) ?? null,
    [customers, selectedUsername],
  )
  const { snapshot, loading: profileLoading, error: profileError, reload } = useCustomer360(selected?.username ?? null)

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return customers.filter((customer) => {
      if (!categoryFilterMatches(customer, filter)) return false
      return query === '' || customerSearchText(customer).includes(query)
    })
  }, [customers, filter, search])
  const { count: visibleCount, sentinelRef } = useProgressiveList(filtered.length, 120)
  const shownCustomers = filtered.slice(0, visibleCount)

  const selectedIdentity = selected ? customerIdentityOf(selected) : null

  return (
    <div className={css.panel}>
      <PanelHeader
        title="客户画像与标签"
        desc="从本机微信数据汇总客户身份、互动事实与可核验标签；不做意向或购买力推断。"
        actions={<span className={css.ruleBadge}>{customers.length.toLocaleString()} 位客户</span>}
      />

      <div className={css.workspace}>
        <aside className={css.directory} aria-label="客户目录">
          <div className={css.directoryHeader}>
            <span className={css.directoryTitle}>客户目录</span>
            <span className={css.directoryCount}>{filtered.length.toLocaleString()} / {customers.length.toLocaleString()}</span>
          </div>
          <div className={css.directoryTools}>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="搜索备注 / 昵称 / 微信号 / 企业名称"
              ariaLabel="搜索客户"
              className={css.directorySearch}
            />
            <div className={css.filters} role="group" aria-label="客户分类筛选">
              {(['all', ...CUSTOMER_CATEGORY_KEYS] as CategoryFilter[]).map((key) => (
                <button
                  key={key}
                  type="button"
                  className={css.filterChip}
                  data-active={filter === key || undefined}
                  aria-pressed={filter === key}
                  onClick={() => { setFilter(key) }}
                >
                  {key === 'all' ? '全部' : CATEGORY_LABELS[key]}
                </button>
              ))}
            </div>
          </div>

          {warnings.map((warning) => (
            <div key={warning} className={css.notice} role="status">{warning}</div>
          ))}

          <div className={css.directoryList}>
            {loading && customers.length === 0 && <LoadingState label="正在读取客户…" />}
            {!loading && error && customers.length === 0 && (
              <ErrorState message="客户目录读取失败" detail={error} onRetry={() => { void loadCustomers() }} />
            )}
            {!loading && !error && filtered.length === 0 && (
              <EmptyState
                icon="🔎"
                title={search.trim() === '' ? '当前分类暂无客户' : '未找到匹配客户'}
                desc={search.trim() === '' ? '切换分类或等待本机数据同步完成。' : '试试备注、昵称或微信号的其它片段。'}
              />
            )}
            {shownCustomers.map((customer) => {
              const name = customer.displayName || customer.remark || customer.nickName || customer.username
              const identity = withEnterprise(name, customer.enterpriseName)
              const groups = customer.groupUsernames?.length ?? 0
              return (
                <button
                  key={customer.username}
                  type="button"
                  className={css.customerRow}
                  data-active={selectedUsername === customer.username || undefined}
                  onClick={() => { setSelectedUsername(customer.username) }}
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
                  <span className={css.rowRelation}>{rowRelation(customer)}</span>
                </button>
              )
            })}
            {filtered.length > visibleCount && <ListSentinel refFn={sentinelRef} />}
          </div>
          <div className={css.directoryFooter}>
            目录来自好友、企业微信联系人和群成员；群聊、公众号、服务号与已删除联系人已排除。
          </div>
        </aside>

        <section className={css.detailColumn} aria-label="客户详情">
          {selectedIdentity === null ? (
            <div className={css.detailEmpty}>
              <DetailPlaceholder
                loading={loading}
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
