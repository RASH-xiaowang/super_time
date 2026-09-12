/**
 * 微信数据面板 — 主容器，分组导航（概览 / 会话与消息 / 联系人 / 内容资产 /
 * 财务与存储 / 洞察与行动 / 隐私与安全 / 维护与设置，共 32 页签），配置见
 * navigation 模块。数据经 DSH 后端 Remote（node:sqlite 读自有解密库），
 * 顶部显示连接状态与数据库状态弹窗。
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { apiGetAvatar, apiGetSelfUsername, apiGetSessions, apiSearchUnified, checkApiHealth, getApiStatus, subscribeApiStatus } from './api.ts'
import type { ChatTarget, ChatView } from './panels/Chats.tsx'

// 面板统一静态导入；客户端插件加载器按单文件 factory 加载，不能分包。
import { OverviewPanel } from './panels/Overview.tsx'
import { AskPanel } from './panels/Ask.tsx'
import { ChatsPanel } from './panels/Chats.tsx'
import { ContactsPanel } from './panels/Contacts.tsx'
import { MomentsPanel } from './panels/MomentsOptimized.tsx'
import { FavoritesPanel } from './panels/Favorites.tsx'
import { EmoticonsPanel } from './panels/Emoticons.tsx'
import { FilesPanel } from './panels/Files.tsx'
import { RecordsPanel } from './panels/Records.tsx'
import { LedgerPanel } from './panels/Ledger.tsx'
import { TasksPanel } from './panels/Tasks.tsx'
import { GroupInsightsPanel } from './panels/GroupInsights.tsx'
import { HealthPanel } from './panels/Health.tsx'
import { MomentsInsightsPanel } from './panels/MomentsInsights.tsx'
import { AssetInsightsPanel } from './panels/AssetInsights.tsx'
import { OfficialAssetsPanel } from './panels/OfficialAssets.tsx'
import { MediaAssetsPanel } from './panels/MediaAssets.tsx'
import { StoragePanel } from './panels/Storage.tsx'
import { CallsPanel } from './panels/Calls.tsx'
import { RevokedPanel } from './panels/Revoked.tsx'
import { PrivacyPanel } from './panels/Privacy.tsx'
import { PrivacyTrustPanel } from './panels/PrivacyTrust.tsx'
import { BackupPanel } from './panels/Backup.tsx'
import { MonitorPanel } from './panels/Monitor.tsx'
import { AnnualPanel } from './panels/Annual.tsx'
import { DailySummaryPanel } from './panels/DailySummary.tsx'
import { PeriodSummaryPanel } from './panels/PeriodSummary.tsx'
import { HookPanel } from './panels/Hook.tsx'
import { GraphPanel } from './panels/Graph.tsx'
import { SettingsPanel } from './panels/Settings.tsx'
import { OperationLogPanel } from './panels/OperationLogPanel.tsx'
import { MergedSections } from './panels/MergedSections.tsx'
import css from './wechat-data.module.css'
import kitCss from './ui/kit.module.css'
import './scifi-theme.css'
import './light-theme.css'
import { NAV_GROUPS, TAB_LABELS, type WechatTab } from './nav-config.ts'
import { getThemeMode, subscribeThemeMode, toggleThemeMode } from './theme.ts'
import { Tooltip } from './ui/kit.tsx'
import type {
  SearchHit,
  UnifiedSearchContact,
  UnifiedSearchFavorite,
  UnifiedSearchFile,
  UnifiedSearchMoment,
  UnifiedSearchRecord,
  WechatSession,
} from '@deepseek-ai/dsh-wechat-data/types'

/** 顶部品牌图标：微信风格双气泡。 */
function IconApp(): React.JSX.Element {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M9.5 3.5C4.8 3.5 1 6.8 1 10.9c0 2.3 1.2 4.4 3.2 5.8L3 20l3.7-1.6c.9.3 1.8.4 2.8.4 4.7 0 8.5-3.3 8.5-7.9S14.2 3.5 9.5 3.5Z" fill="currentColor" opacity=".18" />
      <path d="M9.5 3.5C4.8 3.5 1 6.8 1 10.9c0 2.3 1.2 4.4 3.2 5.8L3 20l3.7-1.6c.9.3 1.8.4 2.8.4 4.7 0 8.5-3.3 8.5-7.9S14.2 3.5 9.5 3.5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="6.2" cy="10.8" r="1" fill="currentColor" />
      <circle cx="9.7" cy="10.8" r="1" fill="currentColor" />
      <circle cx="13.2" cy="10.8" r="1" fill="currentColor" />
      <path d="M16.6 11.2c.4-2 2.1-3.5 4.2-3.6-1-.8-2.3-1.3-3.7-1.3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".55" />
    </svg>
  )
}

/**
 * 当前账号头像的会话级缓存（username -> data/远程 URL，null 表示取不到）。
 *
 * 顶栏品牌位是常驻元素，面板内的搜索、切页签都会让它重渲染；缓存一层避免
 * 每次都往 Remote 打一次 getSelfUsername + getAvatar。
 */
let selfAvatarCache: { username: string; src: string | null } | null = null

/**
 * 顶栏品牌位图标。
 *
 * 已配置微信账号（后端 online 且能取到 self username 与头像）时，展示该账号的
 * 真实头像；未配置、未解密、或头像不可用时，回退到内置的微信双气泡图标 IconApp。
 * @param online - 后端 Remote 网关是否可用（= 微信账号是否已配置完成）。
 * @returns 头像 img 或回退图标。
 */
function BrandAvatar({ online }: { online: boolean }): React.JSX.Element {
  const [src, setSrc] = useState<string | null>(null)

  useEffect(() => {
    if (!online) {
      setSrc(null)
      return
    }
    let cancelled = false
    void (async (): Promise<void> => {
      try {
        const username = await apiGetSelfUsername()
        if (!username) {
          if (!cancelled) setSrc(null)
          return
        }
        if (selfAvatarCache?.username === username) {
          if (!cancelled) setSrc(selfAvatarCache.src)
          return
        }
        const r = await apiGetAvatar({ username })
        const value = r.kind === 'data' ? (r.data ?? null) : r.kind === 'url' ? (r.url ?? null) : null
        selfAvatarCache = { username, src: value }
        if (!cancelled) setSrc(value)
      } catch {
        // 未配置 / 未解密 / Remote 失败：保持默认图标，不影响顶栏其他部分渲染。
        if (!cancelled) setSrc(null)
      }
    })()
    return () => { cancelled = true }
  }, [online])

  if (!src) return <IconApp />
  return (
    <img
      className={css.appLogoImg}
      src={src}
      alt="当前微信账号头像"
      width={38}
      height={38}
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => { selfAvatarCache = null; setSrc(null) }}
    />
  )
}

/**
 * 导航折叠开关图标：折叠态提示「向右展开」，展开态提示「向左收起」。
 * @param props.open - 导航当前是否展开。
 * @returns the chevrons svg element.
 */
function IconNavToggle({ open }: { open: boolean }): React.JSX.Element {
  return (
    <svg className={css.navIcon} viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {open ? (
        <>
          <path d="M11 17l-5-5 5-5" />
          <path d="M18 17l-5-5 5-5" />
        </>
      ) : (
        <>
          <path d="M13 17l5-5-5-5" />
          <path d="M6 17l5-5-5-5" />
        </>
      )}
    </svg>
  )
}

/** 搜索图标。 */
function IconSearch(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  )
}

/** 太阳图标（浅色主题激活）。 */
function IconSun(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
}

/** 月亮图标（深色主题激活）。 */
function IconMoon(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" />
    </svg>
  )
}

/** 状态圆点。 */
function StatusDot(): React.JSX.Element {
  return <span className={css.statusDot} aria-hidden="true" />
}

/** Render the active tab; unimplemented tabs show a placeholder. */
function renderTab(
  tab: WechatTab,
  onNavigate: (t: WechatTab) => void,
  onOpenChat: (username: string, localId?: number) => void,
  chatTarget: ChatTarget | null,
  onOpenMoments: (username: string) => void,
  momentAuthor: string | null,
  clearMomentAuthor: () => void,
): React.JSX.Element {
  const chatViews: Partial<Record<string, ChatView>> = {
    chats: 'chats', bizchats: 'bizchats', servicechats: 'servicechats', kefu: 'kefu',
  }
  switch (tab) {
    case 'overview': return <OverviewPanel onNavigate={(tab) =>{  onNavigate(tab as WechatTab) }} onOpenChat={onOpenChat} onOpenMoments={onOpenMoments} />
    case 'ask': return <AskPanel onOpenChat={onOpenChat} />
    case 'chats':
    case 'bizchats':
    case 'servicechats':
    case 'kefu':
    case 'revoked': return (
      <MergedSections
        ariaLabel="消息视图"
        initial={tab === 'revoked' ? 'revoked' : 'chats'}
        sections={[
          { key: 'chats', label: '聊天消息', render: () => <ChatsPanel initialView={chatViews[tab] ?? 'chats'} initialTarget={chatTarget} /> },
          { key: 'revoked', label: '撤回消息', render: () => <RevokedPanel /> },
        ]}
      />
    )
    case 'contacts':
    case 'graph': return (
      <MergedSections
        ariaLabel="联系人与社交视图"
        initial={tab}
        sections={[
          { key: 'contacts', label: '通讯录', render: () => <ContactsPanel onNavigate={(t) =>{  onNavigate(t as WechatTab) }} onOpenChat={onOpenChat} onOpenMoments={onOpenMoments} /> },
          { key: 'graph', label: '社交图谱', render: () => <GraphPanel onOpenChat={onOpenChat} /> },
        ]}
      />
    )
    case 'moments': return <MomentsPanel author={momentAuthor} onClearAuthor={clearMomentAuthor} />
    // ── 合并面板：同一主题的多个视图收进一个导航项，顶部分段切换。
    //    每个 case 都列全被合并的 tab，保证深链（#assetinsights 等）仍落到正确分段。
    case 'favorites':
    case 'emoticons':
    case 'assetinsights': return (
      <MergedSections
        ariaLabel="收藏与表情视图"
        initial={tab}
        sections={[
          { key: 'favorites', label: '我的收藏', render: () => <FavoritesPanel /> },
          { key: 'emoticons', label: '表情包', render: () => <EmoticonsPanel /> },
          { key: 'assetinsights', label: '收藏/表情统计', render: () => <AssetInsightsPanel /> },
        ]}
      />
    )
    case 'files':
    case 'mediaassets':
    case 'storage':
    case 'officialassets': return (
      <MergedSections
        ariaLabel="文件与存储视图"
        initial={tab}
        sections={[
          { key: 'files', label: '文件资产', render: () => <FilesPanel /> },
          { key: 'mediaassets', label: '媒体资产', render: () => <MediaAssetsPanel onNavigate={(t) =>{  onNavigate(t as WechatTab) }} /> },
          { key: 'storage', label: '存储分析', render: () => <StoragePanel onOpenChat={onOpenChat} /> },
          { key: 'officialassets', label: '公众号文章', render: () => <OfficialAssetsPanel onOpenChat={onOpenChat} /> },
        ]}
      />
    )
    case 'records':
    case 'ledger': return (
      <MergedSections
        ariaLabel="资金往来视图"
        initial={tab}
        sections={[
          { key: 'ledger', label: '月度汇总', render: () => <LedgerPanel onOpenChat={onOpenChat} /> },
          { key: 'records', label: '转账红包明细', render: () => <RecordsPanel onOpenChat={onOpenChat} /> },
        ]}
      />
    )
    case 'tasks': return <TasksPanel onOpenChat={onOpenChat} />
    case 'groupinsights':
    case 'monitor': return (
      <MergedSections
        ariaLabel="群聊分析视图"
        initial={tab}
        sections={[
          { key: 'groupinsights', label: '离线洞察', render: () => <GroupInsightsPanel onOpenChat={onOpenChat} onNavigate={(t) =>{  onNavigate(t as WechatTab) }} /> },
          { key: 'monitor', label: '活跃监控', render: () => <MonitorPanel onOpenChat={onOpenChat} /> },
        ]}
      />
    )
    case 'momentsinsights': return <MomentsInsightsPanel />
    case 'calls': return <CallsPanel onOpenChat={onOpenChat} />
    case 'privacy':
    case 'privacytrust': return (
      <MergedSections
        ariaLabel="隐私与安全视图"
        initial={tab}
        sections={[
          { key: 'privacytrust', label: '数据边界与出网', render: () => <PrivacyTrustPanel /> },
          { key: 'privacy', label: '隐私体检', render: () => <PrivacyPanel onOpenChat={onOpenChat} /> },
        ]}
      />
    )
    case 'backup': return <BackupPanel />
    case 'annual':
    case 'dailysummary':
    case 'period': return (
      <MergedSections
        ariaLabel="总结与报告视图"
        initial={tab}
        sections={[
          { key: 'dailysummary', label: '每日总结与任务', render: () => <DailySummaryPanel /> },
          { key: 'period', label: '周期总结', render: () => <PeriodSummaryPanel /> },
          { key: 'annual', label: '年度报告', render: () => <AnnualPanel /> },
        ]}
      />
    )
    case 'hook':
    case 'health':
    case 'oplog': return (
      <MergedSections
        ariaLabel="数据健康视图"
        initial={tab}
        sections={[
          { key: 'health', label: '数据库健康', render: () => <HealthPanel onNavigate={(t) =>{  onNavigate(t as WechatTab) }} /> },
          { key: 'hook', label: '原图链路自检', render: () => <HookPanel onNavigate={(t) =>{  onNavigate(t as WechatTab) }} /> },
          { key: 'oplog', label: '操作日志', render: () => <OperationLogPanel /> },
        ]}
      />
    )
    case 'settings': return <SettingsPanel />
    default:
      return (
        <div className={css.placeholder}>
          <p>🚧 「{TAB_LABELS[tab]}」面板正在重构中</p>
          <p>该页签的 React 版本将在后续迭代中接入。</p>
        </div>
      )
  }
}

/**
 * Render the WeChat data panel shell.
 * @returns the data panel element tree.
 */
export function WechatDataPanel(): React.JSX.Element {
  const [active, setActiveState] = useState<WechatTab>(() => {
    const h = (typeof location !== 'undefined' ? location.hash : '').replace('#', '')
    return (h in TAB_LABELS ? h : 'overview') as WechatTab
  })
  const setActive = useCallback((t: WechatTab): void => {
    setActiveState(t)
    try { if (typeof location !== 'undefined') location.hash = t } catch { /* hash 写入失败可忽略 */ }
  }, [])
  const apiStatus = useSyncExternalStore(subscribeApiStatus, getApiStatus)
  const themeMode = useSyncExternalStore(subscribeThemeMode, getThemeMode)
  /** 导航栏展开态：由导航顶部的开关按钮点击切换（此前是鼠标悬停展开）。 */
  const [navOpen, setNavOpen] = useState(false)
  /** 导航轨滚动感知：滚动条已隐藏（scrollbar-width:none），改用「边缘渐隐 + 箭头」
   *  告诉用户上/下方向还有条目。top=true 表示上方有被滚出的内容。 */
  const navRef = useRef<HTMLElement | null>(null)
  const [navMore, setNavMore] = useState({ top: false, bottom: false })
  const updateNavMore = useCallback((): void => {
    const el = navRef.current
    if (!el) return
    const top = el.scrollTop > 4
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight > 4
    setNavMore(prev => (prev.top === top && prev.bottom === bottom) ? prev : { top, bottom })
  }, [])
  /** 布局变化点都要重算：挂载后（字体加载完高度才稳定）、展开/折叠切换（组标签
   *  显隐改变内容高度）、窗口尺寸变化（nav 视口高度变化）。 */
  useEffect(() => {
    const el = navRef.current
    if (!el) return
    const raf = (): void => requestAnimationFrame(updateNavMore)
    raf()
    const t = setTimeout(updateNavMore, 500) // 字体晚到兜底
    const ro = new ResizeObserver(raf)
    ro.observe(el)
    return () => { clearTimeout(t); ro.disconnect() }
  }, [updateNavMore, navOpen])
  const [chatTarget, setChatTarget] = useState<ChatTarget | null>(null)
  const [momentAuthor, setMomentAuthor] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const searchSeqRef = useRef(0)
  const [searchResults, setSearchResults] = useState<{
    sessions: WechatSession[]
    hits: SearchHit[]
    contacts: UnifiedSearchContact[]
    moments: UnifiedSearchMoment[]
    favorites: UnifiedSearchFavorite[]
    files: UnifiedSearchFile[]
    records: UnifiedSearchRecord[]
  }>({ sessions: [], hits: [], contacts: [], moments: [], favorites: [], files: [], records: [] })

  /** Cross-panel navigation: jump to the chats tab and open/locate a session. */
  const openChat = useCallback((username: string, localId?: number): void => {
    const target: ChatTarget = { username, nonce: Date.now() }
    if (localId !== undefined) target.localId = localId
    setChatTarget(target)
    setActive('chats')
  }, [])

  /** Cross-panel navigation: jump to the moments tab filtered by one author. */
  const openMoments = useCallback((username: string): void => {
    setMomentAuthor(username || null)
    setActive('moments')
  }, [])

  useEffect(() => {
    void checkApiHealth()
  }, [])

  // Global search (sessions + messages + contacts/moments/favorites/files/records) with a 300ms debounce.
  useEffect(() => {
    const q = searchQuery.trim()
    if (!q) {
      searchSeqRef.current += 1
      setSearchResults({ sessions: [], hits: [], contacts: [], moments: [], favorites: [], files: [], records: [] })
      setSearchLoading(false)
      return
    }
    setSearchLoading(true)
    const seq = ++searchSeqRef.current
    const t = window.setTimeout(() => {
      void Promise.all([
        apiGetSessions({ keyword: q, limit: 8 }).catch(() => ({ sessions: [], total: 0 })),
        apiSearchUnified({ query: q, limit: 8 }).catch(() => ({
          query: q, messages: [], contacts: [], moments: [], favorites: [], files: [], records: [],
        })),
      ]).then(([sessionRes, un]) => {
        if (seq !== searchSeqRef.current) return
        setSearchResults({
          sessions: sessionRes.sessions,
          hits: un.messages,
          contacts: un.contacts,
          moments: un.moments,
          favorites: un.favorites,
          files: un.files,
          records: un.records,
        })
        setSearchLoading(false)
      })
    }, 300)
    return () => { window.clearTimeout(t) }
  }, [searchQuery])

  // Ctrl/Cmd+K focuses the global search; Esc closes the dropdown.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        searchInputRef.current?.focus()
        setSearchOpen(true)
      } else if (e.key === 'Escape') {
        setSearchOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])

  // 只渲染活动标签；用 useMemo 避免搜索/数据库状态等无关状态变化时重建面板元素。
  const activePanel = useMemo(
    () => renderTab(active, setActive, openChat, chatTarget, openMoments, momentAuthor, () => { setMomentAuthor(null) }),
    [active, setActive, openChat, chatTarget, openMoments, momentAuthor],
  )

  const noSearchResults = !searchLoading
    && searchResults.sessions.length === 0
    && searchResults.hits.length === 0
    && searchResults.contacts.length === 0
    && searchResults.moments.length === 0
    && searchResults.favorites.length === 0
    && searchResults.files.length === 0
    && searchResults.records.length === 0

  return (
    <div className={css.panel}>
      <div className={css.topbar}>
        <div className={css.topbarLeft}>
          <div className={css.appLogo}>
            <BrandAvatar online={apiStatus === 'online'} />
          </div>
          <div className={css.titleBlock}>
            <div className={css.titleRow}>
              <h2 className={css.topbarTitle}>本地微信数据管理</h2>
              <span className={css.badge}>微信+</span>
            </div>
            <span className={kitCss.textCaptionTrunc}>本机解密库 · 统计分析 · 可选 AI 问答</span>
          </div>
        </div>
        <div className={css.topbarRight}>
          <div className={css.topbarSearch}>
            <span className={css.searchIcon}><IconSearch /></span>
            <input
              ref={searchInputRef}
              className={css.searchInput}
              placeholder="全局搜索：会话 / 消息 / 联系人 / 朋友圈 / 收藏 / 文件 / 记录（Ctrl+K）"
              value={searchQuery}
              onChange={(e) => { setSearchQuery(e.target.value); setSearchOpen(true) }}
              onFocus={() => { setSearchOpen(true) }}
              aria-label="全局搜索微信数据"
            />
            {searchOpen && searchQuery.trim() !== '' && (
              <>
                <div className={css.searchOverlay} onClick={() => { setSearchOpen(false) }} />
                <div className={css.searchDropdown}>
                  {searchLoading && <div className={css.searchEmpty}>搜索中…</div>}
                  {noSearchResults && (
                    <div className={css.searchEmpty}>未找到相关结果</div>
                  )}
                  {searchResults.sessions.length > 0 && (
                    <>
                      <div className={css.searchGroup}>会话</div>
                      {searchResults.sessions.map(sec => (
                        <button key={sec.username} type="button" className={css.searchRow} onClick={() => { setSearchOpen(false); openChat(sec.username) }}>
                          <span className={css.searchName}>{sec.displayName || sec.username}</span>
                          <span className={kitCss.textCaptionTrunc}>{sec.summary}</span>
                        </button>
                      ))}
                    </>
                  )}
                  {searchResults.hits.length > 0 && (
                    <>
                      <div className={css.searchGroup}>消息</div>
                      {searchResults.hits.map((h, i) => (
                        <button key={`${h.username}:${h.local_id}:${i}`} type="button" className={css.searchRow} onClick={() => { setSearchOpen(false); openChat(h.username, h.local_id) }}>
                          <span className={css.searchName}>{h.name}</span>
                          <span className={kitCss.textCaptionTrunc}>{h.snippet}</span>
                        </button>
                      ))}
                    </>
                  )}
                  {searchResults.contacts.length > 0 && (
                    <>
                      <div className={css.searchGroup}>联系人</div>
                      {searchResults.contacts.map((c, i) => (
                        <button key={`c:${c.username}:${i}`} type="button" className={css.searchRow} onClick={() => { setSearchOpen(false); if (c.category === 'contact' || c.category === 'group') openChat(c.username); else setActive('contacts') }}>
                          <span className={css.searchName}>{c.name}</span>
                          <span className={kitCss.textCaptionTrunc}>{c.category === 'group' ? '群聊' : c.category === 'official' ? '公众号' : '联系人'}</span>
                        </button>
                      ))}
                    </>
                  )}
                  {searchResults.moments.length > 0 && (
                    <>
                      <div className={css.searchGroup}>朋友圈</div>
                      {searchResults.moments.map((m, i) => (
                        <button key={`m:${m.username}:${i}`} type="button" className={css.searchRow} onClick={() => { setSearchOpen(false); openMoments(m.username) }}>
                          <span className={css.searchName}>{m.name}</span>
                          <span className={kitCss.textCaptionTrunc}>{m.snippet}</span>
                        </button>
                      ))}
                    </>
                  )}
                  {searchResults.favorites.length > 0 && (
                    <>
                      <div className={css.searchGroup}>收藏</div>
                      {searchResults.favorites.map((f, i) => (
                        <button key={`f:${f.id}:${i}`} type="button" className={css.searchRow} onClick={() => { setSearchOpen(false); setActive('favorites') }}>
                          <span className={css.searchName}>收藏 #{f.id}</span>
                          <span className={kitCss.textCaptionTrunc}>{f.snippet}</span>
                        </button>
                      ))}
                    </>
                  )}
                  {searchResults.files.length > 0 && (
                    <>
                      <div className={css.searchGroup}>文件</div>
                      {searchResults.files.map((f, i) => (
                        <button key={`file:${f.fileName}:${i}`} type="button" className={css.searchRow} onClick={() => { setSearchOpen(false); setActive('files') }}>
                          <span className={css.searchName}>{f.fileName}</span>
                          <span className={kitCss.textCaptionTrunc}>{f.size > 0 ? `${(f.size / 1024).toFixed(1)} KB` : f.md5}</span>
                        </button>
                      ))}
                    </>
                  )}
                  {searchResults.records.length > 0 && (
                    <>
                      <div className={css.searchGroup}>记录</div>
                      {searchResults.records.map((r, i) => (
                        <button key={`r:${r.kind}:${r.session}:${i}`} type="button" className={css.searchRow} onClick={() => { setSearchOpen(false); setActive('records') }}>
                          <span className={css.searchName}>{r.name}</span>
                          <span className={kitCss.textCaptionTrunc}>{r.kind === 'transfers' ? '转账' : '红包'}</span>
                        </button>
                      ))}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
          <Tooltip content={themeMode === 'light' ? '切换到深色主题' : '切换到浅色主题'}>
            <button
              type="button"
              data-theme-toggle
              className={css.topbarQuick}
              onClick={toggleThemeMode}
              title={themeMode === 'light' ? '切换到深色主题' : '切换到浅色主题'}
            >
              <span className={css.quickIcon}>
                {themeMode === 'light' ? <IconMoon /> : <IconSun />}
              </span>
              <span>{themeMode === 'light' ? '深色' : '浅色'}</span>
            </button>
          </Tooltip>
          <span className={css.apiTag} data-status={apiStatus}>
            <StatusDot />
            {apiStatus === 'online' ? '本地数据就绪' : apiStatus === 'offline' ? '本地数据不可用' : '检测中...'}
          </span>
        </div>
      </div>

      <div className={css.body}>
        <aside className={css.sidebar} data-open={navOpen || undefined}>
          {/* 折叠开关：点击切换展开 / 折叠（不再依赖鼠标悬停） */}
          <button
            type="button"
            className={css.navToggle}
            onClick={() => setNavOpen(v => !v)}
            title={navOpen ? '收起导航' : '展开导航'}
            aria-label={navOpen ? '收起导航' : '展开导航'}
            aria-expanded={navOpen}
          >
            <IconNavToggle open={navOpen} />
            <span className={css.navLabel}>{navOpen ? '收起导航' : '展开导航'}</span>
          </button>
          {/* 定位容器：承载边缘渐隐遮罩与箭头提示（均为 absolute 覆盖层，不占布局） */}
          <div
            className={css.navWrap}
            data-more-top={navMore.top || undefined}
            data-more-bottom={navMore.bottom || undefined}
          >
            <nav ref={navRef} className={css.nav} onScroll={updateNavMore}>
            {NAV_GROUPS.map(g => (
              <div key={g.label} className={css.navGroup}>
                <div className={css.navGroupLabel}>{g.label}</div>
                {g.items.filter(it => !it.hidden && it.tab !== 'settings').map(it => (
                  <button
                    key={it.tab}
                    type="button"
                    className={css.navItem}
                    data-active={active === it.tab || undefined}
                    onClick={() => { setChatTarget(null); setMomentAuthor(null); setActive(it.tab) }}
                    title={it.label}
                  >
                    <svg className={css.navIcon} viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {/* icons arrive as path fragments; wrap in a <g> */}
                      <g dangerouslySetInnerHTML={{ __html: it.icon }} />
                    </svg>
                    <span className={css.navLabel}>{it.label}</span>
                  </button>
                ))}
              </div>
            ))}
            </nav>
            {navMore.top && (
              <span className={css.navHint} data-dir="up" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M18 15l-6-6-6 6" /></svg>
              </span>
            )}
            {navMore.bottom && (
              <span className={css.navHint} data-dir="down" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
              </span>
            )}
          </div>
          {/* 底部固定区域：数据配置始终可见 */}
          <div className={css.sidebarFooter}>
            <button
              type="button"
              className={css.navItem}
              data-active={active === 'settings' || undefined}
              onClick={() => { setChatTarget(null); setMomentAuthor(null); setActive('settings') }}
              title="数据配置"
            >
              <svg className={css.navIcon} viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <g dangerouslySetInnerHTML={{ __html: NAV_GROUPS.flatMap(g => g.items).find(it => it.tab === 'settings')?.icon ?? '' }} />
              </svg>
              <span className={css.navLabel}>数据配置</span>
            </button>
          </div>
        </aside>
        <main className={css.content}>
          <Suspense fallback={<div className={css.loadingFallback}>正在加载面板…</div>}>
            {activePanel}
          </Suspense>
        </main>
      </div>

    </div>
  )
}









