/**
 * 通讯录面板 — 微信桌面端风格：36px 工具行（标题 / 搜索 / 筛选 / 更多）、
 * 5 个分类分段（其余分类进「筛选」菜单）、字母索引（列表 >50 条时显示）、
 * 多列联系人网格、资料抽屉（群主/群成员数/所在群/签名/类型）、TA 的朋友圈、
 * 发消息、复制用户名、CSV 导出与导出记录。数据经 DSH 后端 Remote（contact.db 完整语义）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { LazyMount, ListSentinel, ListSkeleton, useLazySentinel, usePagedList, useTransientNotice } from './hooks.tsx'
import { apiExportCsv, apiExportSessionMessages, apiGetAvatarBatched, apiGetContact360, apiGetContacts, apiSaveFileDialog } from '../api.ts'
import { cacheBounded, copyTextToClipboard } from '../utils/misc.ts'
import { avatarColors } from '../utils/format.ts'
import { localImageSrc } from './remote-img.tsx'
import type { Contact360Snapshot, WechatContact as ContactRow } from '@deepseek-ai/dsh-wechat-data/types'
import { clickableKey, Drawer, EmptyMaybeSyncing, LinkButton, SearchInput, Segmented } from '../ui/kit.tsx'
import { desktopAction, desktopActionProps } from '../ui/desktop-only.tsx'
import { ExportHistoryDialog } from './ExportHistoryDialog.tsx'
import { useAvatarPrewarm } from './contacts-avatar-prewarm.ts'
import { isEnterpriseWechatUser, withEnterprise } from './enterprise-identity.ts'
import { useKeepAliveActive } from './keep-alive.tsx'
import { IdentityName } from './identity.tsx'
import css from './contacts.module.css'
import kitCss from '../ui/kit.module.css'
import { ExportProgressStatus } from './ExportProgressStatus.tsx'
import { useExportTask, type ExportTaskState } from './export-task.ts'
import { useMenuDismiss } from './use-menu-dismiss.ts'

/**
 * 联系人的全部互斥分类（后端 `category` 口径）。
 * 「全部 / 联系人 / 群聊 / 公众号」在主分段里常驻；其余 5 类收进「筛选」菜单 ——
 * 它们合计占比低，平铺会把工具行挤成两行。
 */
const OTHER_CATS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'service', label: '服务号' },
  { key: 'enterprise', label: '企业微信' },
  { key: 'member', label: '群成员' },
  { key: 'system', label: '系统' },
  { key: 'deleted', label: '已删除' },
]

const CONTACTS_EXPORT_LABEL = '导出通讯录 CSV'
const PROFILE_EXPORT_LABEL = '导出联系人聊天记录'
const OTHER_KEYS = new Set(OTHER_CATS.map(c => c.key))
/** 主分段：4 个常用分类 + 一个「其它」入口（点开筛选菜单）。 */
const VISIBLE_CATS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'friend', label: '联系人' },
  { key: 'group', label: '群聊' },
  { key: 'official', label: '公众号' },
  { key: 'other', label: '其它' },
]

function displayName(c: ContactRow): string {
  return c.displayName
}

function displayIdentity(c: ContactRow): string {
  return withEnterprise(displayName(c), c.enterpriseName)
}

/** Format a unix timestamp as YYYY-MM-DD HH:MM. */
function fmtTs(ts: number | null | undefined): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  if (isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 类型标签：优先后端 local_type_label，其次按用户名模式推断。 */
function typeLabel(c: ContactRow): string {
  if (c.localTypeLabel) return c.localTypeLabel
  if (c.username.endsWith('@chatroom')) return '群聊'
  if (c.username.startsWith('gh_')) return '公众号'
  if (isEnterpriseWechatUser(c.username)) return '企业微信'
  return '联系人'
}

/** 头像缓存。 */
const avatarCache = new Map<string, string | null>()
/** 头像缓存上限（模块级缓存生命周期 = 渲染进程，必须设上限；值同时是**预热条数**上限）。 */
const AVATAR_CACHE_MAX = 300

/** 通讯录浏览态的分页大小与已加载条数硬上限。 */
const CONTACTS_PAGE_SIZE = 200
const CONTACTS_MAX_ITEMS = 1000
/** 搜索是显式全量查询；用一个足够大的单页把结果一次取回，仍由 pager 统一持有状态。 */
const CONTACTS_SEARCH_PAGE_SIZE = Number.MAX_SAFE_INTEGER

/** 字母索引只在列表足够长时才出现（短列表上它只是装饰）。 */
const INDEX_MIN_ROWS = 50

/** 工具行里的下拉菜单标号。 */
type ToolMenu = 'filter' | 'more' | null

/** 搜索过滤与字母分组；抽到组件外，避免联系人面板继续膨胀。 */
function groupContacts(
  contacts: readonly ContactRow[],
  search: string,
): Array<[string, ContactRow[]]> {
  const q = search.trim().toLowerCase()
  const filtered = contacts.filter((c) => {
    if (!q) return true
    return [
      displayName(c),
      c.username,
      c.alias ?? '',
      c.enterpriseName ?? '',
      c.remark,
      c.quanPin ?? '',
      c.remarkQuanPin ?? '',
    ].some(v => v.toLowerCase().includes(q))
  })
  const map = new Map<string, ContactRow[]>()
  for (const c of filtered) {
    const k = c.initial || '#'
    const arr = map.get(k) ?? []
    arr.push(c)
    map.set(k, arr)
  }
  return Array.from(map.entries()).sort((a, b) => (
    a[0] === '#' ? 1 : b[0] === '#' ? -1 : a[0].localeCompare(b[0])
  ))
}

/** 分类分段与「其它」聚合口径统一在这里计算。 */
function contactCategoryView(
  cat: string,
  stats: Record<string, number>,
  total: number,
): { catValue: string; segOptions: ReadonlyArray<{ value: string; label: string }> } {
  const catValue = OTHER_KEYS.has(cat) ? 'other' : cat
  const otherCount = OTHER_CATS.reduce((sum, c) => sum + (stats[c.key] ?? 0), 0)
  const otherActiveLabel = OTHER_KEYS.has(cat) ? (OTHER_CATS.find(c => c.key === cat)?.label ?? '') : ''
  const segOptions = VISIBLE_CATS.map((c) => {
    const n = c.key === 'all' ? (stats.all ?? total) : c.key === 'other' ? otherCount : (stats[c.key] ?? 0)
    const label = c.key === 'other' && otherActiveLabel ? `其它 · ${otherActiveLabel}` : c.label
    return { value: c.key, label: `${label}${n > 0 ? ` (${n})` : ''}` }
  })
  return { catValue, segOptions }
}

/** 工具行：标题 + 搜索 + 分类分段 + 筛选 + 更多（窄窗允许换行）。 */
function ContactsToolbar(props: {
  search: string
  onSearch: (v: string) => void
  total: number
  cat: string
  catValue: string
  segOptions: ReadonlyArray<{ value: string; label: string }>
  stats: Record<string, number>
  exporting: boolean
  finishing: boolean
  onSegChange: (v: string) => void
  onCat: (key: string) => void
  onExport: () => void
  onOpenHistory: () => void
}): React.JSX.Element {
  const { search, onSearch, total, cat, catValue, segOptions, stats, exporting, finishing, onSegChange, onCat, onExport, onOpenHistory } = props
  const [menu, setMenu] = useState<ToolMenu>(null)
  const closeFilter = useCallback((): void => {
    setMenu(current => current === 'filter' ? null : current)
  }, [])
  const closeMore = useCallback((): void => {
    setMenu(current => current === 'more' ? null : current)
  }, [])
  const filterDismiss = useMenuDismiss(menu === 'filter', closeFilter)
  const moreDismiss = useMenuDismiss(menu === 'more', closeMore)
  return (
    <div className={css.toolRow} ref={filterDismiss.rootRef}>
      <span className={css.toolTitle}>通讯录</span>
      <SearchInput value={search} onChange={onSearch} placeholder="搜索昵称 / 备注 / 微信号 / 企业名称 / 全拼" ariaLabel="搜索联系人" className={css.toolSearch} />
      <span className={css.toolCount}>共 {total.toLocaleString()} 人</span>
      <span className={css.toolSpacer} />
      <div
        className={css.segWrap}
        /* 「其它」既是当前分类的聚合显示、也是筛选菜单的入口。
           Radix 单选分段在「点已选中项」时不会再回调 onChange —— 落进「其它」之后
           想换另一个低频分类时，靠这里补一次菜单开关。 */
        onClickCapture={(e) => {
          if (catValue !== 'other') return
          const btn = (e.target as HTMLElement).closest('button')
          if (btn?.textContent?.startsWith('其它') === true) setMenu(m => (m === 'filter' ? null : 'filter'))
        }}
      >
        <Segmented
          options={segOptions}
          value={catValue}
          /* 'other' 只是筛选菜单的入口，不直接改分类（菜单项才是真正的分类）。 */
          onChange={(v) => { if (v === 'other') setMenu(m => (m === 'filter' ? null : 'filter')); else onSegChange(v) }}
          ariaLabel="联系人分类"
        />
      </div>
      <div className={css.menuWrap} ref={filterDismiss.rootRef}>
        <button
          ref={filterDismiss.triggerRef}
          type="button"
          className={css.toolBtn}
          aria-haspopup="menu"
          aria-expanded={menu === 'filter'}
          data-on={OTHER_KEYS.has(cat) || undefined}
          onClick={() => { setMenu(m => m === 'filter' ? null : 'filter') }}
        >筛选 ▾</button>
        {menu === 'filter' && (
          <div className={css.menu} role="menu" aria-label="更多联系人分类">
            <div className={css.menuLabel}>更多分类</div>
            {OTHER_CATS.map(c => (
              <button
                key={c.key}
                type="button"
                role="menuitemradio"
                aria-checked={cat === c.key}
                className={css.menuItem}
                data-on={cat === c.key || undefined}
                onClick={() => { onCat(c.key); setMenu(null) }}
              >
                <span>{c.label}</span>
                <span className={css.menuCount}>{stats[c.key] ?? 0}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className={css.menuWrap} ref={moreDismiss.rootRef}>
        <button
          ref={moreDismiss.triggerRef}
          type="button"
          className={css.toolBtn}
          aria-haspopup="menu"
          aria-expanded={menu === 'more'}
          onClick={() => { setMenu(m => m === 'more' ? null : 'more') }}
        >更多 ▾</button>
        {menu === 'more' && (
          <div className={css.menu} role="menu" aria-label="通讯录更多操作">
            <button
              type="button"
              role="menuitem"
              className={css.menuItem}
              onClick={() => { setMenu(null); onExport() }}
              disabled={exporting}
              {...desktopActionProps()}
            >{finishing ? '完成中…' : exporting ? '导出中…' : desktopAction() ? '导出 CSV（仅电脑）' : '导出 CSV'}</button>
            {/* 导出记录：与「导出」同处，用户导完就地能查结果/重新导出/清理。 */}
            <button
              type="button"
              role="menuitem"
              className={css.menuItem}
              data-open-export-history=""
              title="查看历史导出：打开文件、复制路径、按原参数重新导出、清理"
              onClick={() => { setMenu(null); onOpenHistory() }}
              {...desktopActionProps()}
            >{desktopAction() ? '导出记录（仅电脑）' : '导出记录'}</button>
          </div>
        )}
      </div>
    </div>
  )
}

/** 资料抽屉：身份头部、主操作、双列资料、最近聊天与共同群聊。 */
function ContactProfileDrawer(props: {
  profile: ContactRow | null
  profile360: Contact360Snapshot | null
  profile360Loading: boolean
  profileExportState: ExportTaskState | null
  onCancelExport: () => void
  onClose: () => void
  onCopyValue: (value: string, label: string) => void
  onExportChat: (c: ContactRow) => void
  onOpenChat?: ((username: string) => void) | undefined
  onOpenMoments?: ((username: string) => void) | undefined
  onSendMessage: (c: ContactRow) => void
}): React.JSX.Element {
  const {
    profile, profile360, profile360Loading, profileExportState, onCancelExport, onClose, onCopyValue,
    onExportChat, onOpenChat, onOpenMoments, onSendMessage,
  } = props
  const profileExporting = profileExportState?.status === 'running'
  const profileFinishing = profileExporting
    && profileExportState.progress !== null
    && profileExportState.progress.total > 0
    && profileExportState.progress.done >= profileExportState.progress.total
  const isGroup = profile?.username.endsWith('@chatroom') === true
  const profileType = profile?.category === 'friend' ? '好友' : profile ? typeLabel(profile) : ''
  const gender = profile?.gender === 1 ? '男' : profile?.gender === 2 ? '女' : ''
  const copyValue = profile?.alias || profile?.username || ''
  const copyLabel = profile?.alias ? '微信号' : '微信 ID'
  const meta = profile === null
    ? []
    : [
        profile.nickName && profile.nickName !== profile.displayName ? `昵称 ${profile.nickName}` : '',
        profile.alias ? `微信号 ${profile.alias}` : '',
        profile.region ?? '',
      ].filter(Boolean)
  const openGroup = profile?.groupUsername && onOpenChat
    ? () => { onClose(); onOpenChat(profile.groupUsername ?? '') }
    : undefined

  return (
    <Drawer open={profile !== null} onClose={onClose} title={profile ? (isGroup ? '群聊资料' : '联系人资料') : '联系人资料'} width={520}>
      {profile && (
        <div className={css.profileContent}>
          <section className={css.profileHero}>
            <div className={css.profileAvatar}>
              <ContactAvatar c={profile} size={72} />
            </div>
            <div className={css.profileIdentity}>
              <div className={css.profileEyebrow}>
                <span className={css.profileType}>{profileType}</span>
                {profile.enterpriseName && <span className={css.profileEnterprise}>{profile.enterpriseName}</span>}
                {isGroup && profile.memberCount != null && <span className={css.profileCount}>{profile.memberCount} 人</span>}
              </div>
              <div className={css.profileNameRow}>
                <h3 className={css.profileName}>{displayName(profile)}</h3>
                {gender && <span className={css.profileGender} data-gender={profile.gender}>{gender}</span>}
              </div>
              {meta.length > 0 && <div className={css.profileMeta}>{meta.join(' · ')}</div>}
              {profile.description && <blockquote className={css.profileSignature}>{profile.description}</blockquote>}
            </div>
          </section>

          <div className={css.profileActions}>
            <button type="button" className={css.profilePrimaryAction} onClick={() => { onClose(); onSendMessage(profile) }}>
              <MessageIcon />
              <span>{isGroup ? '进入群聊' : '查消息'}</span>
            </button>
            {desktopAction() && (
              <button
                type="button"
                className={css.profileSecondaryAction}
                onClick={() => { onExportChat(profile) }}
                disabled={profileExporting}
              >
                <ExportIcon />
                <span>{profileFinishing ? '完成中…' : profileExporting ? '导出中…' : '导出聊天记录'}</span>
              </button>
            )}
            <button type="button" className={css.profileSecondaryAction} onClick={() => { onCopyValue(copyValue, copyLabel) }}>
              <CopyIcon />
              <span>{profile.alias ? '复制微信号' : '复制微信 ID'}</span>
            </button>
          </div>
          {profileExportState && (
            <ExportProgressStatus state={profileExportState} onCancel={onCancelExport} />
          )}

          <section>
            <ProfileSectionTitle>资料</ProfileSectionTitle>
            <div className={css.profileFacts}>
              {isGroup ? (
                <>
                  <ProfileFact label="群名称" value={profile.nickName || profile.displayName || '未设置'} empty={!profile.nickName && !profile.displayName} />
                  <ProfileFact label="群 ID" value={profile.username} copyValue={profile.username} onCopy={onCopyValue} mono />
                  <ProfileFact label="成员数" value={profile.memberCount != null ? `${profile.memberCount} 人` : '未读取'} empty={profile.memberCount == null} />
                  <ProfileFact label="备注" value={profile.remark || '未设置'} empty={!profile.remark} />
                  {profile.owner && (
                    <ProfileFact
                      label="群主"
                      value={<IdentityName className={css.profileFactIdentity} name={profile.owner} username={profile.owner} size={18} />}
                    />
                  )}
                </>
              ) : (
                <>
                  <ProfileFact label="备注" value={profile.remark || '未设置'} empty={!profile.remark} />
                  <ProfileFact label="昵称" value={profile.nickName || '未设置'} empty={!profile.nickName} />
                  <ProfileFact
                    label="微信号"
                    value={profile.alias || '未设置'}
                    empty={!profile.alias}
                    copyValue={profile.alias}
                    onCopy={onCopyValue}
                  />
                  <ProfileFact
                    label="微信 ID"
                    value={profile.username}
                    copyValue={profile.username}
                    onCopy={onCopyValue}
                    mono
                  />
                  <ProfileFact label="性别" value={gender || '未设置'} empty={!gender} />
                  <ProfileFact label="地区" value={profile.region || '未设置'} empty={!profile.region} />
                  {profile.enterpriseName && <ProfileFact label="企业名称" value={profile.enterpriseName} />}
                  {profile.groupName && (
                    <ProfileFact
                      label="所在群"
                      value={openGroup ? (
                        <LinkButton className={css.profileFactLink} onClick={openGroup}>
                          <IdentityName name={profile.groupName} username={profile.groupUsername ?? ''} size={18}>
                            {profile.groupName}
                          </IdentityName>
                        </LinkButton>
                      ) : profile.groupName}
                    />
                  )}
                </>
              )}
            </div>
          </section>

          <section>
            <ProfileSectionTitle meta={profile360?.messages.lastTime ? fmtTs(profile360.messages.lastTime) : undefined}>最近聊天</ProfileSectionTitle>
            {profile360Loading ? (
              <div className={css.profileActivityLoading} aria-label="正在统计最近聊天">
                <span />
                <span />
                <span />
              </div>
            ) : profile360 ? (
              <div className={css.profileActivity}>
                <div className={css.profileActivityMain}>
                  <span className={css.profileActivityIcon}><MessageIcon /></span>
                  <div className={css.profileActivityCopy}>
                    <strong>{profile360.messages.count > 0 ? `${profile360.messages.count.toLocaleString()} 条消息` : '暂无消息记录'}</strong>
                    <span>
                      {profile360.messages.firstTime
                        ? `首次交流 ${fmtTs(profile360.messages.firstTime)}`
                        : '当前数据中没有可用的聊天时间'}
                    </span>
                  </div>
                  {profile360.messages.lastTime && <time className={css.profileActivityTime}>{fmtTs(profile360.messages.lastTime)}</time>}
                </div>
                <div className={css.profileMetrics}>
                  <span>朋友圈 {profile360.moments.count.toLocaleString()}</span>
                  <span>转账 {profile360.funds.transfers.toLocaleString()}</span>
                  <span>红包 {profile360.funds.redpackets.toLocaleString()}</span>
                </div>
                {(onOpenChat || (!isGroup && onOpenMoments)) && (
                  <div className={css.profileActivityLinks}>
                    {onOpenChat && profile360.messages.count > 0 && (
                      <button
                        type="button"
                        className={css.profileActivityLink}
                        onClick={() => { onClose(); onOpenChat(profile.username) }}
                      >
                        查看聊天记录
                        <ChevronIcon />
                      </button>
                    )}
                    {!isGroup && onOpenMoments && (
                      <button
                        type="button"
                        className={css.profileActivityLink}
                        onClick={() => { onClose(); onOpenMoments(profile.username) }}
                      >
                        <MomentsIcon />
                        <span>TA 的朋友圈</span>
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className={css.profileUnavailable}>暂未读取到聊天画像</div>
            )}
          </section>

          {!isGroup && profile360 && profile360.commonGroups.length > 0 && (
            <section>
              <ProfileSectionTitle meta={`${profile360.commonGroups.length} 个`}>共同群聊</ProfileSectionTitle>
              <div className={css.profileGroups}>
                {profile360.commonGroups.map(group => (
                  <button
                    key={group.username}
                    type="button"
                    className={css.profileGroupCard}
                    onClick={() => { onClose(); onOpenChat?.(group.username) }}
                    disabled={!onOpenChat}
                    title={`${group.name} · ${group.memberCount} 人`}
                  >
                    <EntityAvatar username={group.username} name={group.name || group.username} size={38} />
                    <span className={css.profileGroupInfo}>
                      <span className={css.profileGroupName}>{group.name || group.username}</span>
                      <span className={css.profileGroupMeta}>{group.memberCount} 人</span>
                    </span>
                    <ChevronIcon />
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>
      )}
    </Drawer>
  )
}

function ProfileSectionTitle({ children, meta }: { children: React.ReactNode; meta?: string | undefined }): React.JSX.Element {
  return (
    <div className={css.profileSectionTitle}>
      <h4 className={css.profileSectionHeading}>{children}</h4>
      <span className={css.profileSectionLine} />
      {meta && <span className={css.profileSectionMeta}>{meta}</span>}
    </div>
  )
}

function ProfileFact(props: {
  label: string
  value: React.ReactNode
  empty?: boolean
  copyValue?: string | undefined
  onCopy?: ((value: string, label: string) => void) | undefined
  mono?: boolean
}): React.JSX.Element {
  const { label, value, empty = false, copyValue, onCopy, mono = false } = props
  return (
    <div className={css.profileFact}>
      <div className={css.profileFactLabel}>{label}</div>
      <div className={`${css.profileFactValue}${empty ? ` ${css.profileFactEmpty}` : ''}${mono ? ` ${css.profileFactMono}` : ''}`}>
        <span className={css.profileFactText}>{value}</span>
        {copyValue && onCopy && (
          <button type="button" className={css.profileFactCopy} onClick={() => { onCopy(copyValue, label) }} aria-label={`复制${label}`} title={`复制${label}`}>
            <CopyIcon />
          </button>
        )}
      </div>
    </div>
  )
}

function MessageIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4.2 3.5h11.6a2.2 2.2 0 0 1 2.2 2.2v7.1a2.2 2.2 0 0 1-2.2 2.2H9l-4.4 2.3.8-2.4a2.2 2.2 0 0 1-3.4-2V5.7a2.2 2.2 0 0 1 2.2-2.2Z" />
      <path d="M6.1 8.1h7.8M6.1 11.2h5.1" />
    </svg>
  )
}

function MomentsIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <circle cx="10" cy="10" r="7.2" />
      <circle cx="10" cy="10" r="2.3" />
      <path d="M10 2.8v2.2M10 15v2.2M2.8 10H5M15 10h2.2" />
    </svg>
  )
}

function ExportIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3v8.5M6.8 8.5 10 11.8l3.2-3.3" />
      <path d="M4 13.2v1.6A2.2 2.2 0 0 0 6.2 17h7.6a2.2 2.2 0 0 0 2.2-2.2v-1.6" />
    </svg>
  )
}

function CopyIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <rect x="6.5" y="3.5" width="9.5" height="11.5" rx="1.8" />
      <path d="M13.5 15v.7a1.8 1.8 0 0 1-1.8 1.8H5.2a1.8 1.8 0 0 1-1.8-1.8V7.2a1.8 1.8 0 0 1 1.8-1.8H6" />
    </svg>
  )
}

function ChevronIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="m7.5 4.5 5.5 5.5-5.5 5.5" />
    </svg>
  )
}

/**
 * Render the contacts panel.
 * @param props - onNavigate to jump tabs; onOpenChat to open a session;
 *   onOpenMoments to jump to a member's timeline.
 * @returns the contacts element tree.
 */
export function ContactsPanel({ onNavigate, onOpenChat, onOpenMoments, seedQuery }: {
  onNavigate?: (tab: string) => void
  onOpenChat?: (username: string) => void
  onOpenMoments?: (username: string) => void
  /** 全局搜索命中「联系人」时带过来的关键词（带 nonce，同一个词连点两次也能重新种入）。 */
  seedQuery?: { q: string; nonce: number }
}): React.JSX.Element {
  const active = useKeepAliveActive()
  const activeRef = useRef(active)
  activeRef.current = active
  const lifecycleEpochRef = useRef(0)
  const [stats, setStats] = useState<Record<string, number>>({})
  const [search, setSearch] = useState('')

  // 全局搜索的命中直接跳到本面板时，把关键词一起带过来（否则用户得重新输一遍）。
  useEffect(() => {
    if (!seedQuery) return
    setSearch(seedQuery.q)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedQuery?.nonce])
  const [cat, setCat] = useState('all')
  const [profile, setProfile] = useState<ContactRow | null>(null)
  const [profile360, setProfile360] = useState<Contact360Snapshot | null>(null)
  const [profile360Loading, setProfile360Loading] = useState(false)
  const [profileExportUsername, setProfileExportUsername] = useState<string | null>(null)
  const exportTask = useExportTask()
  // 提示语自动消失（L20）：原手写的 `setTimeout(…, 4000)` 已由 hook 统一管理。
  const { notice, flash } = useTransientNotice(4000)
  /** 导出记录弹窗开关（入口收在工具行的「更多」菜单里）。 */
  const [historyOpen, setHistoryOpen] = useState(false)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const jumpToLetter = useCallback((letter: string): void => {
    scrollRef.current?.querySelector(`[data-letter="${letter}"]`)?.scrollIntoView({ block: 'start' })
  }, [])

  const searching = search.trim() !== ''
  const pager = usePagedList<ContactRow>({
    pageSize: searching ? CONTACTS_SEARCH_PAGE_SIZE : CONTACTS_PAGE_SIZE,
    maxItems: searching ? 0 : CONTACTS_MAX_ITEMS,
    fetchPage: async (offset, limit) => {
      // 分类过滤必须交给后端（在分页之前过滤）。此前是在渲染层对**已分页**的
      // 结果再 filter：全局排序（字母 + 全拼）的前 200 条里若恰好没有该类目，
      // 页签看着就是空的 —— "联系人 (282)" 却显示"暂无联系人"。
      const epoch = lifecycleEpochRef.current
      const env = await apiGetContacts({ limit, offset, category: cat })
      // 隐藏期间进入的请求即使晚到也不能写状态；跨过一次隐藏/恢复的旧响应
      // 也不能把旧统计贴回可见页。
      if (activeRef.current && epoch === lifecycleEpochRef.current) setStats(env.stats ?? {})
      return { items: env.contacts, total: env.total }
    },
  })
  const contacts = pager.items
  const total = pager.total
  const loading = pager.loading
  const error = pager.error

  // 普通浏览与搜索共用同一个 pager：只切换页大小/上限，不再维护第二份
  // contacts/total/loading/error。搜索时单页拉全量，保证跨页搜索结果完整；
  // 搜索词本身在本地过滤，因此连续输入不会重复请求。
  useEffect(() => {
    pager.reset()
  }, [searching, cat, pager.reset])

  // 输入搜索词或分类切换时回到顶部；清空搜索后同样从浏览态第一页重新加载。
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0
  }, [searching, cat])

  const loadMoreRef = useLazySentinel(() => { if (pager.hasMore && !pager.loadingMore) pager.loadMore() }, '600px 0px', () => scrollRef.current, pager.items.length)
  useAvatarPrewarm(contacts, avatarCache, AVATAR_CACHE_MAX, active && !searching)

  // 隐藏时作废在途统计响应；恢复显示时 pager 自己补一次静默回源，
  // 这里只负责让旧请求的统计结果不能跨可见代际落地。
  useEffect(() => {
    if (!active) lifecycleEpochRef.current += 1
  }, [active])

  // 打开资料卡时异步拉取跨域社交画像（消息/朋友圈/资金/共同群）。
  useEffect(() => {
    if (!active) return undefined
    if (!profile) {
      setProfile360(null)
      setProfile360Loading(false)
      return undefined
    }
    let alive = true
    setProfile360(null)
    setProfile360Loading(true)
    void apiGetContact360(profile.username)
      .then((r) => { if (alive && activeRef.current) setProfile360(r) })
      .catch(() => { /* 画像失败不影响资料卡 */ })
      .finally(() => { if (alive && activeRef.current) setProfile360Loading(false) })
    return () => { alive = false }
  }, [active, profile])

  const notify = (text: string): void => {
    flash(text)
  }

  // 分类已由后端在分页前过滤；这里只做当前页的搜索与字母分组。
  const grouped = useMemo(() => groupContacts(contacts, search), [contacts, search])
  const { catValue, segOptions } = useMemo(
    () => contactCategoryView(cat, stats, total),
    [cat, stats, total],
  )

  /** 分段点击：'other' 只是筛选菜单的入口，不直接改分类。 */
  const onSegChange = (v: string): void => {
    if (v === 'other') return
    setCat(v)
  }

  const doExport = async (): Promise<void> => {
    if (exportTask.running) return
    // 先让用户选路径：默认文件名带上当前分类与日期，便于区分多次导出。
    const catLabel = cat === 'all' ? '全部' : (OTHER_CATS.find(c => c.key === cat)?.label ?? (cat === 'friend' ? '联系人' : cat === 'group' ? '群聊' : '公众号'))
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
    const picked = await apiSaveFileDialog({
      defaultName: `通讯录-${catLabel}-${stamp}.csv`,
      title: '导出通讯录',
      filters: [{ name: 'CSV 表格', extensions: ['csv'] }],
    })
    if (picked.canceled || !picked.path) return // 用户取消：静默返回，不报「失败」
    const savePath = picked.path
    const outcome = await exportTask.run(async ({ jobId }) => {
      // 带上 category：导出的内容与当前页签看到的范围一致。
      return apiExportCsv({ kind: 'contacts', dest: savePath, category: cat, jobId })
    }, {
      idPrefix: 'contacts-export',
      label: CONTACTS_EXPORT_LABEL,
      successMessage: (r) => `已导出 ${r.count} 个联系人 → ${r.path}`,
    })
    if (outcome.ok) notify(outcome.message)
    else if (!outcome.canceled) notify('导出失败: ' + outcome.error)
  }

  const copyValue = async (value: string, label: string): Promise<void> => {
    // 走共享助手：异步 API 被拒（窗口失焦、权限被挡）时它还会试 `execCommand` 那条退路，
    // 而 `ok===false` 才真的是「没复制上」—— 直接 catch `writeText` 会把退路丢掉。
    const ok = await copyTextToClipboard(value)
    notify(ok ? `已复制${label} ${value}` : '复制失败')
  }

  const sendMessage = (c: ContactRow): void => {
    if (onOpenChat) {
      onOpenChat(c.username)
      return
    }
    void copyValue(c.username, '微信 ID')
    onNavigate?.('chats')
  }

  const exportProfileChat = async (c: ContactRow): Promise<void> => {
    if (exportTask.running) return
    setProfileExportUsername(c.username)
    const outcome = await exportTask.run(async ({ jobId }) => {
      return apiExportSessionMessages({
        username: c.username,
        format: 'txt',
        count: 0,
        zip: true,
        jobId,
        sessionName: c.displayName ?? c.username,
      })
    }, {
      idPrefix: 'contacts-session-export',
      label: PROFILE_EXPORT_LABEL,
      successMessage: (result) => {
        const media = result.mediaCount && result.mediaCount > 0 ? `、${result.mediaCount} 个原文件` : ''
        return `已导出 ${result.count.toLocaleString()} 条聊天记录${media} → ${result.path}`
      },
    })
    if (outcome.ok) notify(outcome.message)
    else if (!outcome.canceled) notify('导出失败: ' + outcome.error)
  }

  const contactExportState = exportTask.state.label === CONTACTS_EXPORT_LABEL ? exportTask.state : null
  const profileExportState = profile !== null
    && profileExportUsername === profile.username
    && exportTask.state.label === PROFILE_EXPORT_LABEL
    ? exportTask.state
    : null

  // 字母索引只对足够长的列表有意义；搜索态下它也没用（结果集已经很小）。
  const showIndex = !searching && total > INDEX_MIN_ROWS

  return (
    <div className={css.panel}>
      <ContactsToolbar
        search={search} onSearch={setSearch} total={total}
        cat={cat} catValue={catValue} segOptions={segOptions} stats={stats}
        exporting={exportTask.running}
        finishing={exportTask.finishing && contactExportState !== null}
        onSegChange={onSegChange} onCat={setCat}
        onExport={() => { void doExport() }}
        onOpenHistory={() => { setHistoryOpen(true) }}
      />
      {notice && <div className={css.notice}>{notice}</div>}
      {contactExportState && (
        <ExportProgressStatus state={contactExportState} onCancel={() => { void exportTask.cancel() }} />
      )}
      {showIndex && <ContactIndexBar groups={grouped} onJump={jumpToLetter} />}
      <div className={css.scroll} ref={scrollRef}>
        {/* 骨架必须与真实栅格同形（U3）：真实内容是 `.list` 的多列网格
            （`repeat(auto-fill, minmax(240px, 1fr))`，实测排 3–5 列），
            而单列行模式会让骨架先铺一列、数据到了再散成多列 —— 看起来像"布局跳了一下"。
            列宽下限与 `.list` 逐字对齐，`consistency-r7.wiring.spec.ts` 钉着这个等式。 */}
        {loading && <ListSkeleton rows={12} grid minCol={240} />}
        {error && <div className={kitCss.error} role="alert">{error}</div>}
        {!loading && !error && grouped.length === 0 && <EmptyMaybeSyncing text="暂无联系人" />}
        {!loading && !error && grouped.map(([letter, list]) => (
          <div key={letter} className={css.group} data-letter={letter}>
            {/* `#` 是「没有任何拼音可依」的兜底桶（微信只为加过好友的联系人写拼音首字母，
                群成员常常两列全空）。标成「其他」而不是让用户以为分组坏了。 */}
            <div className={css.letterHd}>{letter === '#' ? '其他' : letter}（{list.length}）</div>
            <div className={css.list}>
              {list.map(c => (<ContactRowItem key={c.username} c={c} onOpen={() =>{  setProfile(c) }} />))}
            </div>
          </div>
        ))}
        {!loading && !error && !searching && (pager.capped ? <CapNote loaded={contacts.length} total={total} /> : pager.hasMore && <ListSentinel refFn={loadMoreRef} />)}
      </div>

      <ContactProfileDrawer
        profile={profile} profile360={profile360} profile360Loading={profile360Loading}
        profileExportState={profileExportState}
        onCancelExport={() => { void exportTask.cancel() }}
        onClose={() => { setProfile(null) }}
        onCopyValue={(value, label) => { void copyValue(value, label) }}
        onExportChat={(c) => { void exportProfileChat(c) }}
        onOpenChat={onOpenChat}
        onOpenMoments={onOpenMoments}
        onSendMessage={sendMessage}
      />

      {/* 导出记录弹窗。入口收在工具行「更多」里 —— 与「导出 CSV」同处；
          手机态**不挂载**（真机量到：弹窗即使关着，挂载时也会打一次 `getExportHistory` ——
          分页器不看 `open`，而那不在远程白名单里）。 */}
      {!desktopAction() && <ExportHistoryDialog open={historyOpen} onClose={() => { setHistoryOpen(false) }} initialKind="contacts" />}
    </div>
  )
}

/** A–Z 字母索引栏；只负责渲染与点击定位，数据仍由联系人面板持有。 */
function ContactIndexBar({ groups, onJump }: {
  groups: ReadonlyArray<readonly [string, ContactRow[]]>
  onJump: (letter: string) => void
}): React.JSX.Element {
  return (
    <div className={css.indexBar} aria-hidden="false">
      {groups.map(([letter]) => (
        <a
          key={letter}
          className={css.indexLetter}
          href={`#contact-${letter === '#' ? 'other' : letter}`}
          onClick={(event) => { event.preventDefault(); onJump(letter) }}
          aria-label={'跳到字母 ' + (letter === '#' ? '其他' : letter)}
        >{letter === '#' ? '其' : letter}</a>
      ))}
    </div>
  )
}

/** 「已加载前 N 位」提示条（触到 `usePagedList` 的 `maxItems` 上界时显示）。 */
function CapNote({ loaded, total }: { loaded: number; total: number }): React.JSX.Element {
  return <div className={css.capNote} role="status">已加载前 {loaded} 位（共 {total} 位）。要找人请用上方搜索。</div>
}

/** 联系人行（含懒加载头像）。 */
function ContactRowItem({ c, onOpen }: { c: ContactRow; onOpen: () => void }): React.JSX.Element {
  // 次要行补上有信息量的字段：群聊 → 类型 + 成员数；其余 → 类型 + 微信号（CSS 省略号截断）。
  const meta = c.memberCount != null && c.memberCount > 0
    ? `${typeLabel(c)} · ${c.memberCount} 人`
    : (c.username ? `${typeLabel(c)} · ${c.username}` : typeLabel(c))
  return (
    <div key={c.username} className={css.contactItem} {...clickableKey(onOpen)}>
      <LazyMount placeholder={<div className={`${css.avatar} ${css.avatarPlaceholder}`}>…</div>} rootMargin="400px 0px">
        <ContactAvatar c={c} size={34} />
      </LazyMount>
      <div className={css.contactInfo}>
        <span className={css.contactName} title={displayIdentity(c)}>{displayIdentity(c)}</span>
        <span className={css.contactMeta} title={meta}>{meta}</span>
      </div>
    </div>
  )
}

/** 联系人头像（head_image 数据 / 远程 URL / 首字母占位）。 */
function ContactAvatar({ c, size }: { c: ContactRow; size: number }): React.JSX.Element {
  return <EntityAvatar username={c.username} name={displayName(c)} avatarUrl={c.avatarUrl} size={size} />
}

/** 联系人/群聊通用头像：优先本机图，其次后端批量头像代理，最后首字占位。 */
function EntityAvatar({ username, name, avatarUrl, size }: {
  username: string
  name: string
  avatarUrl?: string | undefined
  size: number
}): React.JSX.Element {
  const key = username || name || ''
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    if (!key) return
    // 快照里的 avatarUrl 只有**本机地址**才能直接当 src：远程地址不许由渲染层自己去要（M23 ——
    // 那两个出网开关管不到 `<img>` 自己发的请求）。命中不了时**继续往下走** `apiGetAvatarBatched`，
    // 那一层会把远程地址交给后端代理（本机离线头像优先，其次代理远端图；都拿不到才算没有头像）。
    const local = localImageSrc(avatarUrl)
    if (local) { setSrc(local); return }
    const cached = avatarCache.get(key)
    if (cached !== undefined) { setSrc(cached); return }
    // 走攒批队列：一屏 N 个联系人合成一次 `getAvatarsLocal`，而不是 N 次 `getAvatar`。
    // 通讯录一屏最多 1000 行（`maxItems`），逐张发就是 1000 次 RPC。
    apiGetAvatarBatched({ username: key })
      .then((r) => {
        const v = r.kind === 'data' ? (r.data ?? null) : null
        cacheBounded(avatarCache, key, v, AVATAR_CACHE_MAX)
        if (!cancelled) setSrc(v)
      })
      .catch(() => { cacheBounded(avatarCache, key, null, AVATAR_CACHE_MAX); if (!cancelled) setSrc(null) })
    return () => { cancelled = true }
  }, [key, avatarUrl])
  if (src) {
    return <img src={src} alt={name ? `${name}头像` : ''} className={`${css.avatarImg} ${css.avatarImgRound}`} width={size} height={size} loading="lazy" />
  }
  const letter = (name || username).slice(0, 1).toUpperCase()
  // 底色 + 文字色一起由 avatarColors 给（白字在 hsl(h 45% 55%) 上 360 个色相只有 57 个达标）
  const av = avatarColors(key)
  return <div className={css.avatar} style={{ width: size, height: size, background: av.background, color: av.color }}>{letter}</div>
}
