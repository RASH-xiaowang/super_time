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
import { NoticeBanner } from './panels/NoticeBanner.tsx'
import { SetupGuide } from './panels/SetupGuide.tsx'
import { PrivacyPanel } from './panels/Privacy.tsx'
import { OperationLogPanel } from './panels/OperationLogPanel.tsx'
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
import { MomentsInsightsPanel } from './panels/MomentsInsights.tsx'
import { AssetInsightsPanel } from './panels/AssetInsights.tsx'
import { OfficialAssetsPanel } from './panels/OfficialAssets.tsx'
import { MediaAssetsPanel } from './panels/MediaAssets.tsx'
import { StoragePanel } from './panels/Storage.tsx'
import { CallsPanel } from './panels/Calls.tsx'
import { RevokedPanel } from './panels/Revoked.tsx'
import { MonitorPanel } from './panels/Monitor.tsx'
import { AnnualPanel } from './panels/Annual.tsx'
import { DailySummaryPanel } from './panels/DailySummary.tsx'
import { PeriodSummaryPanel } from './panels/PeriodSummary.tsx'
import { GraphPanel } from './panels/Graph.tsx'
import { SettingsPanel } from './panels/Settings.tsx'
import { MergedSections } from './panels/MergedSections.tsx'
import css from './wechat-data.module.css'
import kitCss from './ui/kit.module.css'
import './scifi-theme.css'
import './light-theme.css'
import { NAV_GROUPS, TAB_LABELS, type WechatTab } from './nav-config.ts'
import { getThemeMode, subscribeThemeMode, toggleThemeMode } from './theme.ts'
import { Dialog, Tooltip } from './ui/kit.tsx'
import { ConfirmProvider } from './ui/confirm.tsx'
import { GlobalSearch } from './panels/global-search.tsx'
import gs from './panels/global-search.module.css'
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
  onOpenSettings: (section?: string) => void,
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
          { key: 'revoked', label: '撤回消息', render: () => <RevokedPanel onOpenSettings={onOpenSettings} /> },
        ]}
      />
    )
    case 'contacts': return (
      <ContactsPanel onNavigate={(t) =>{  onNavigate(t as WechatTab) }} onOpenChat={onOpenChat} onOpenMoments={onOpenMoments} />
    )
    // 社交图谱 / 知识图谱是两个并列入口，各自独立面板：前者是「我的人脉」，
    // 后者是「我的笔记」。不再用 MergedSections 把通讯录与图谱捆在一个导航项里。
    case 'graph': return <GraphPanel variant="social" onOpenChat={onOpenChat} />
    case 'knowledge': return <GraphPanel variant="knowledge" onOpenChat={onOpenChat} />
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
    // 只读数据视图留在主内容区：隐私体检（扫描结果与风险 TOP10，命中样本可跳回会话）
    // 与操作日志（审计长表）。配置与维护动作仍收在「设置」弹窗里（见 DIALOG_SECTION_OF）。
    case 'privacy': return <PrivacyPanel onOpenChat={onOpenChat} />
    case 'oplog': return <OperationLogPanel />
    // 「数据边界与出网 / 备份恢复 / 数据健康（数据库健康、原图链路自检）」在「设置」弹窗里
    // （见 DIALOG_SECTION_OF），这里没有对应的主内容区页面。
    case 'annual':
    case 'dailysummary':
    case 'period': return (
      <MergedSections
        ariaLabel="总结与报告视图"
        initial={tab}
        sections={[
          { key: 'dailysummary', label: '每日总结与任务', render: () => <DailySummaryPanel onOpenSettings={onOpenSettings} /> },
          { key: 'period', label: '周期总结', render: () => <PeriodSummaryPanel onOpenSettings={onOpenSettings} /> },
          { key: 'annual', label: '年度报告', render: () => <AnnualPanel /> },
        ]}
      />
    )
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
 * 不再占主内容区的页签 → 打开「设置」弹窗时落到哪一节。
 *
 * 「数据边界与出网 / 备份恢复 / 数据健康（数据库健康、原图链路自检）」原先是侧栏里的独立页，
 * 2026-09 起迁进「微信数据配置」弹窗（现已改名「设置」）：它们要么是配置，要么是维护与自检动作。
 * 但深链（#privacytrust / #health …）与跨页跳转（数据总览的风险提示、各面板的
 * 「前往设置 / 文件资产」按钮）仍走这几个 tab id，所以这里做一次改道。
 *
 * **不在这张表里的页签就是留在主界面的**：`privacy`（隐私体检）与 `oplog`（操作日志）
 * 2026-09 一度也进过弹窗，现按「只读数据视图回主界面、配置与维护动作留设置」迁回 ——
 * 前者是扫描结果 + 风险 TOP10（命中样本还要跳回会话），后者是审计长表。
 */
const DIALOG_SECTION_OF: Readonly<Record<string, string>> = {
  settings: 'detect',
  privacytrust: 'boundary',
  backup: 'backup',
  health: 'health',
  hook: 'hook',
}

/**
 * Render the WeChat data panel shell.
 * @returns the data panel element tree.
 */
export function WechatDataPanel(): React.JSX.Element {
  /** #settings / #privacytrust / #health 深链不再是主内容区的页签，而是直接打开弹窗并落到对应节。
 *  #privacy / #oplog 反过来：它们留在主内容区（只读数据视图），不再开弹窗。 */
  const initialHash = typeof location !== 'undefined' ? location.hash.replace('#', '') : ''
  const [active, setActiveState] = useState<WechatTab>(() => {
    return (initialHash in TAB_LABELS && !(initialHash in DIALOG_SECTION_OF) ? initialHash : 'overview') as WechatTab
  })
  /** 「数据配置」以弹窗呈现（详见 renderTab 上方的说明），settingsSection 决定它开在哪一节。 */
  const [settingsOpen, setSettingsOpen] = useState(() => initialHash in DIALOG_SECTION_OF)
  const [settingsSection, setSettingsSection] = useState<string | undefined>(() => DIALOG_SECTION_OF[initialHash])
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
    // 用块体：requestAnimationFrame 返回 handle，箭头函数直接返回它就不符合 `(): void`。
    const raf = (): void => { requestAnimationFrame(updateNavMore) }
    raf()
    const t = setTimeout(updateNavMore, 500) // 字体晚到兜底
    const ro = new ResizeObserver(raf)
    ro.observe(el)
    return () => { clearTimeout(t); ro.disconnect() }
  }, [updateNavMore, navOpen])
  const [chatTarget, setChatTarget] = useState<ChatTarget | null>(null)
  const [momentAuthor, setMomentAuthor] = useState<string | null>(null)
  /**
   * 打开「数据配置」弹窗。
   *
   * 为什么改弹窗：这个界面是"一次性把账号/密钥/图片/语音配好"的流程型页面，
   * 拆成主内容区的一个页签时，用户配完还得再切回去，看不到自己在哪一页。
   * 弹窗形式下主内容区留在原处，关掉就回到原视图。
   */
  const openSettings = useCallback((section?: string): void => {
    setChatTarget(null)
    setMomentAuthor(null)
    setSettingsSection(section)
    setSettingsOpen(true)
  }, [])
  /**
   * 导航入口统一走这里。
   *
   * 落进 DIALOG_SECTION_OF 的 tab（数据配置 / 数据边界与出网 / 隐私体检）改为开弹窗
   * 并指定节；其余照旧切换主内容区页签。
   */
  const navigate = useCallback((t: WechatTab): void => {
    if (t in DIALOG_SECTION_OF) { openSettings(DIALOG_SECTION_OF[t]); return }
    setActive(t)
  }, [openSettings, setActive])
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

  /**
   * 弹窗里装不下的跳转（如「文件资产 / 存储分析」）：关掉弹窗，再走正常导航切主内容区。
   * 装得下的那几节由 SettingsPanel 内部直接切节，不会走到这里。
   */
  const navigateFromDialog = useCallback((tab: string): void => {
    setSettingsOpen(false)
    navigate(tab as WechatTab)
  }, [navigate])

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

  // Ctrl/Cmd+K 聚焦全局搜索；Esc 关闭结果面板。
  // 搜索框现在在导航栏里，而收起态（58px 轨）整块是 display: none —— 直接 focus() 会静默失败，
  // 所以先展开导航，等这一帧渲染出输入框后再聚焦（rAF 比 setTimeout(0) 更贴合绘制时机）。
  // 原先那套「先展开顶栏折叠条再聚焦」的 inert 绕行方案已随顶栏一起删除。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setNavOpen(true)
        window.requestAnimationFrame(() => { searchInputRef.current?.focus() })
        setSearchOpen(true)
      } else if (e.key === 'Escape') {
        setSearchOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [])

  // 导航栏收起时搜索框被隐藏（display: none）。此时结果面板若还开着，就会拿一组
  // 全零的矩形去定位，直接飘到屏幕左上角 —— 收起导航时一并关掉面板。
  useEffect(() => {
    if (!navOpen) setSearchOpen(false)
  }, [navOpen])

  // 只渲染活动标签；用 useMemo 避免搜索/数据库状态等无关状态变化时重建面板元素。
  const activePanel = useMemo(
    () => renderTab(active, navigate, openChat, chatTarget, openMoments, momentAuthor, () => { setMomentAuthor(null) }, openSettings),
    [active, navigate, openChat, chatTarget, openMoments, momentAuthor, openSettings],
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
    /* ConfirmProvider 包在最外层：全应用共用一个应用内确认框实例。
       不用原生 window.confirm（系统白框、不跟主题、阻塞渲染进程）。 */
    <ConfirmProvider>
    <div className={css.panel}>
      {/* 顶栏已整体迁入左侧导航栏（2026-09）：品牌 / 全局搜索 / 主题 / 数据状态
          原先各占顶栏一段，那条 54px 的横条只服务这四件事，却永久占掉首屏高度；
          迁进常驻的导航栏后不再需要 `FoldableBar` 的展开/自动收起（以及它带来的
          inert 与裁剪两处坑）。搜索的结果面板改用 Portal 定位 ——
          因为 `.sidebar` 带 `overflow: hidden`，绝对定位的下拉会被裁掉。 */}

      {/* 主动提醒卡片（右下角悬浮）：新版本已下载可装 / 许可证临期。此前这两件事只在
          「设置」弹窗里能看到，用户不主动点进去就感知不到 —— 新版本静默装好，许可证则到期
          当天才由解锁页硬拦。悬浮而非顶栏横条：这两件事与当前在看哪一页无关，且不占版面。 */}
      <NoticeBanner onOpenLicense={() => { openSettings('license') }} />

      {/* 首次进入系统的配置向导卡（左下角悬浮）：把「还差哪几步、点一下去哪配」摆到眼前。
          它只是指路 —— 配置动作仍在设置里那几节完成（点某一步即打开设置并落到该节）。
          设置弹窗打开时传 open=false，免得压在弹窗上。 */}
      <SetupGuide open={!settingsOpen} onOpenStep={(k) => { openSettings(k) }} />

      <div className={css.body}>
        <aside className={css.sidebar} data-open={navOpen || undefined}>
          {/* 品牌：头像 + 产品名（原顶栏左侧）。头像沿用原顶栏的品牌位实现
              （BrandAvatar 已配置微信账号时显示账号头像，否则显示品牌标记）。 */}
          <div className={css.navBrand} title="Super Time">
            <span className={css.navBrandLogo}>
              <BrandAvatar online={apiStatus === 'online'} />
            </span>
            <span className={css.navBrandText}>
              <span className={css.navBrandName}>Super Time</span>
              <span className={css.navBrandSub}>微信数据工作台</span>
            </span>
          </div>

          {/* 全局搜索（原顶栏中部）：结果面板由 GlobalSearch Portal 到 body */}
          <div className={css.navSearch}>
            <GlobalSearch
              value={searchQuery}
              onChange={setSearchQuery}
              open={searchOpen}
              onOpenChange={setSearchOpen}
              inputRef={searchInputRef}
            >
              {searchLoading && <div className={gs.empty}>搜索中…</div>}
              {noSearchResults && <div className={gs.empty}>未找到相关结果</div>}
              {searchResults.sessions.length > 0 && (
                <>
                  <div className={gs.group}>会话</div>
                  {searchResults.sessions.map(sec => (
                    <button key={sec.username} type="button" className={gs.row} onClick={() => { setSearchOpen(false); openChat(sec.username) }}>
                      <span className={gs.rowName}>{sec.displayName || sec.username}</span>
                      <span className={kitCss.textCaptionTrunc}>{sec.summary}</span>
                    </button>
                  ))}
                </>
              )}
              {searchResults.hits.length > 0 && (
                <>
                  <div className={gs.group}>消息</div>
                  {searchResults.hits.map((h, i) => (
                    <button key={`${h.username}:${h.local_id}:${i}`} type="button" className={gs.row} onClick={() => { setSearchOpen(false); openChat(h.username, h.local_id) }}>
                      <span className={gs.rowName}>{h.name}</span>
                      <span className={kitCss.textCaptionTrunc}>{h.snippet}</span>
                    </button>
                  ))}
                </>
              )}
              {searchResults.contacts.length > 0 && (
                <>
                  <div className={gs.group}>联系人</div>
                  {searchResults.contacts.map((c, i) => (
                    <button key={`c:${c.username}:${i}`} type="button" className={gs.row} onClick={() => { setSearchOpen(false); if (c.category === 'contact' || c.category === 'group') openChat(c.username); else setActive('contacts') }}>
                      <span className={gs.rowName}>{c.name}</span>
                      <span className={kitCss.textCaptionTrunc}>{c.category === 'group' ? '群聊' : c.category === 'official' ? '公众号' : '联系人'}</span>
                    </button>
                  ))}
                </>
              )}
              {searchResults.moments.length > 0 && (
                <>
                  <div className={gs.group}>朋友圈</div>
                  {searchResults.moments.map((m, i) => (
                    <button key={`m:${m.username}:${i}`} type="button" className={gs.row} onClick={() => { setSearchOpen(false); openMoments(m.username) }}>
                      <span className={gs.rowName}>{m.name}</span>
                      <span className={kitCss.textCaptionTrunc}>{m.snippet}</span>
                    </button>
                  ))}
                </>
              )}
              {searchResults.favorites.length > 0 && (
                <>
                  <div className={gs.group}>收藏</div>
                  {searchResults.favorites.map((f, i) => (
                    <button key={`f:${f.id}:${i}`} type="button" className={gs.row} onClick={() => { setSearchOpen(false); setActive('favorites') }}>
                      <span className={gs.rowName}>收藏 #{f.id}</span>
                      <span className={kitCss.textCaptionTrunc}>{f.snippet}</span>
                    </button>
                  ))}
                </>
              )}
              {searchResults.files.length > 0 && (
                <>
                  <div className={gs.group}>文件</div>
                  {searchResults.files.map((f, i) => (
                    <button key={`file:${f.fileName}:${i}`} type="button" className={gs.row} onClick={() => { setSearchOpen(false); setActive('files') }}>
                      <span className={gs.rowName}>{f.fileName}</span>
                      <span className={kitCss.textCaptionTrunc}>{f.size > 0 ? `${(f.size / 1024).toFixed(1)} KB` : f.md5}</span>
                    </button>
                  ))}
                </>
              )}
              {searchResults.records.length > 0 && (
                <>
                  <div className={gs.group}>记录</div>
                  {searchResults.records.map((r, i) => (
                    <button key={`r:${r.kind}:${r.session}:${i}`} type="button" className={gs.row} onClick={() => { setSearchOpen(false); setActive('records') }}>
                      <span className={gs.rowName}>{r.name}</span>
                      <span className={kitCss.textCaptionTrunc}>{r.kind === 'transfers' ? '转账' : '红包'}</span>
                    </button>
                  ))}
                </>
              )}
            </GlobalSearch>
          </div>

          {/* 折叠开关：点击切换展开 / 折叠（悬停不再触发，避免误展开） */}
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
            {NAV_GROUPS.map(g => {
              // 分组里的条目全迁进「设置」弹窗后（如「备份与安全」「维护与设置」），
              // 只剩标题的空组不再渲染 —— 否则侧栏会留一个没有条目的分组名。
              const items = g.items.filter(it => !it.hidden && it.tab !== 'settings')
              if (items.length === 0) return null
              return (
              <div key={g.label} className={css.navGroup}>
                <div className={css.navGroupLabel}>{g.label}</div>
                {items.map(it => (
                  <button
                    key={it.tab}
                    type="button"
                    className={css.navItem}
                    data-active={active === it.tab || undefined}
                    onClick={() => { setChatTarget(null); setMomentAuthor(null); setActive(it.tab) }}
                    title={it.label}
                  >
                    {/* 图标是填充字形（nav-config 的 fragment 自带 fill/stroke 覆盖）。
                        17px 是对齐微信官方侧栏的光学重量：58px 轨宽下 15px 偏小，
                        与展开态 12.5px 标签并排时比例失衡。 */}
                    <svg className={css.navIcon} viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      {/* icons arrive as path fragments; wrap in a <g> */}
                      <g dangerouslySetInnerHTML={{ __html: it.icon }} />
                    </svg>
                    <span className={css.navLabel}>{it.label}</span>
                  </button>
                ))}
              </div>
              )
            })}
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
          {/* 底部固定区域：数据配置始终可见（点击弹出弹窗，不切换主内容区） */}
          <div className={css.sidebarFooter}>
            <button
              type="button"
              className={css.navItem}
              data-active={settingsOpen || undefined}
              onClick={() => { openSettings() }}
              title="设置"
              aria-haspopup="dialog"
              aria-expanded={settingsOpen}
            >
              <svg className={css.navIcon} viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <g dangerouslySetInnerHTML={{ __html: NAV_GROUPS.flatMap(g => g.items).find(it => it.tab === 'settings')?.icon ?? '' }} />
              </svg>
              <span className={css.navLabel}>设置</span>
            </button>
          </div>
          {/* 主题切换与数据状态（原顶栏右侧）：与「设置」同属全局动作，放底部固定区 */}
          <div className={css.navFooterRow}>
            <Tooltip content={themeMode === 'light' ? '切换到深色主题' : '切换到浅色主题'}>
              <button
                type="button"
                data-theme-toggle
                className={css.themeToggle}
                onClick={toggleThemeMode}
                title={themeMode === 'light' ? '切换到深色主题' : '切换到浅色主题'}
                aria-label={themeMode === 'light' ? '切换到深色主题' : '切换到浅色主题'}
              >
                {themeMode === 'light' ? <IconMoon /> : <IconSun />}
              </button>
            </Tooltip>
            <span className={css.apiTag} data-status={apiStatus} title="本地解密数据的可读状态">
              <StatusDot />
              <span className={css.apiTagText}>{apiStatus === 'online' ? '数据就绪' : apiStatus === 'offline' ? '数据不可用' : '检测中…'}</span>
            </span>
          </div>
        </aside>
        <main className={css.content}>
          <Suspense fallback={<div className={css.loadingFallback}>正在加载面板…</div>}>
            {activePanel}
          </Suspense>
        </main>
      </div>

      {/* 「设置」弹窗：主内容区保持原页，关闭（× / Esc / 点遮罩）后回到原处。
          面板自身不再画标题栏 —— 标题与关闭按钮由弹窗提供，避免两个标题叠在一起。 */}
      <Dialog
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false) }}
        className={css.settingsDialog}
        title={(
          <span className={css.settingsDialogTitle}>
            设置
            <span className={css.settingsDialogDesc}>配置向导 · 智能与隐私 · 授权与更新 · 维护与自检</span>
          </span>
        )}
      >
        <div className={css.settingsDialogBody}>
          <SettingsPanel
            inDialog
            initialSection={settingsSection}
            onNavigateOut={navigateFromDialog}
          />
        </div>
      </Dialog>

    </div>
    </ConfirmProvider>
  )
}









