/**
 * 微信数据面板 — 主容器。分组导航见 `nav-config.ts` 的 `NAV_GROUPS`：
 * **5 组**（概览 · 问答 · 总结 / 会话与消息 / 关系与社交 / 资产与资金 / 行动与维护），
 * 侧栏可见 **15** 项 + 底栏独立渲染的 `settings`，可路由页签共 **39**（其余 23 项 `hidden`，
 * 靠「详情 →」或合并组段条进入）。
 *
 * ⚠️ 本段历史上写成「8 组 / 32 页签」，漏了「报告与总结」与「资金」两组。
 * 分组名**只认 `nav-config.ts`** —— 改导航后请回来核对本注释，别再手写清单。
 * 数据经 DSH 后端 Remote（node:sqlite 读自有解密库），顶部显示连接状态与数据库状态弹窗。
 *
 * ── 侧栏默认展开（2026-09-30 用户要求）──────────────────────────────────────
 * `navOpen` 的初值是 **true**（176px 展开态），此前是 false（58px 窄轨）。
 * 理由：首次进来的人只看得到一排图标，要点一次才知道有哪些入口 —— 这是个默认值问题，
 * 不是功能问题。**刻意不做持久化**：没有记忆就不会出现「上次收起了，这次打开还是收起」。
 * 窗口很窄时仍可点「收起导航」让出宽度；该状态机在下面 `WechatDataPanel` 里，
 * 真机几何由 `scripts/nav-shell-e2e.mjs` 按「默认展开 → 点一下收起 → 再展开」的顺序验收。
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { apiGetAvatar, apiGetSelfUsername, apiGetSessions, apiSearchUnified, checkApiHealth, getApiStatus, runtimeCapabilities, subscribeApiStatus, type ApiStatus } from './api.ts'
import type { ChatTarget, ChatView } from './panels/Chats.tsx'

// 内容面板按页签懒加载；常驻外壳（提醒、引导、全局搜索、余额）保持静态导入。
import {
  AnnualPanel,
  AskPanel,
  AssetInsightsPanel,
  CallsPanel,
  ChatsPanel,
  ClawBotPanel,
  ContactsPanel,
  EmoticonsPanel,
  FavoritesPanel,
  FilesPanel,
  GraphPanel,
  GroupInsightsPanel,
  KbShell,
  LedgerPanel,
  MediaAssetsPanel,
  MomentsInsightsPanel,
  MomentsPanel,
  MonitorPanel,
  OfficialAssetsPanel,
  OperationLogPanel,
  OverviewPanel,
  RecordsPanel,
  RevokedPanel,
  SettingsPanelGate,
  StoragePanel,
  SummaryWorkbench,
  TaskCenterPanel,
  TasksPanel,
} from './panel-loaders.tsx'
import { NoticeBanner } from './panels/NoticeBanner.tsx'
import { SetupGuide } from './panels/SetupGuide.tsx'
import { MergedSections } from './panels/MergedSections.tsx'
import { setActiveKb } from './panels/kb-scope.ts'
import { useKeepAlivePanel } from './panels/keep-alive.tsx'
import css from './wechat-data.module.css'
import kitCss from './ui/kit.module.css'
/* Wave D1（docs/UI-DENSITY.md §3 A 层）：全局「紧凑 chrome」覆盖层。
 * 本文件只有「标签 + 属性子串」选择器（不依赖加载顺序），在 shell 挂载时就位，
 * 覆盖 144 个面板视图里的页头/卡片/统计卡/表格/空态。
 * ⚠️ 必须用「具名导入 + 根节点挂标记类」而不是裸副作用导入：Vite 会把没有导出引用的
 * CSS Modules 当成无副作用导入摇掉（实测 0 条规则进产物）。见该文件头部说明。 */
import compactCss from './ui/compact-chrome.module.css'
import './scifi-theme.css'
import './light-theme.css'
import { NAV_GROUPS, TAB_LABELS, type WechatTab } from './nav-config.ts'
import { Dialog } from './ui/kit.tsx'
import { ConfirmProvider } from './ui/confirm.tsx'
import { MobileNavHost } from './ui/mobile-nav.tsx'
import { useReleaseImagesOnTab } from './use-release-images-on-tab.ts'
import { BrandTitle } from './panels/brand-title.tsx'
import { GlobalSearch } from './panels/global-search.tsx'
import { SEARCH_QUERY_EVENT, searchQueryFromEvent } from './panels/search-events.ts'
import gs from './panels/global-search.module.css'
import type {
  SearchHit,
  UnifiedSearchContact,
  UnifiedSearchSnapshot,
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
        const value = r.kind === 'data' ? (r.data ?? null) : null
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

/**
 * 全局搜索的命中落到某个页签时，把关键词一起带过去。
 *
 * 此前「联系人 / 收藏 / 文件 / 记录」四组命中只做 `setActive(tab)` —— 用户落到一份
 * **未筛选**的列表上，必须把刚才输的词再打一遍。带上 `nonce` 是为了让「同一个词
 * 连续点两次」也能重新种入（只靠值变化的话第二次不会触发）。
 */
export interface SearchSeed {
  tab: WechatTab
  q: string
  nonce: number
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
  seed: SearchSeed | null,
  onOpenKbFile: (kbId: number, fileId: number) => void,
  kbFocus: { fileId: number; nonce: number } | null,
): React.JSX.Element {
  const chatViews: Partial<Record<string, ChatView>> = {
    chats: 'chats', bizchats: 'bizchats', servicechats: 'servicechats', kefu: 'kefu',
  }
  switch (tab) {
    case 'overview': return <OverviewPanel onNavigate={(tab) =>{  onNavigate(tab as WechatTab) }} onOpenChat={onOpenChat} onOpenMoments={onOpenMoments} />
    case 'ask': return <AskPanel onOpenChat={onOpenChat} onOpenKbFile={onOpenKbFile} />
    // 通话记录 2026-10-17 并入「聊天会话」：微信里通话本就发生在会话中
    // （`CallsPanel` 的每条记录都带 `onOpenChat` 跳回对应会话），它是消息的一种。
    // 因此 `calls` 不再占侧栏条目，由「聊天会话」面板顶部的段条切换。
    case 'chats':
    case 'bizchats':
    case 'servicechats':
    case 'kefu':
    case 'revoked':
    case 'calls': return (
      <MergedSections
        ariaLabel="消息视图"
        initial={tab === 'revoked' ? 'revoked' : tab === 'calls' ? 'calls' : 'chats'}
        sections={[
          { key: 'chats', label: '消息', render: () => <ChatsPanel initialView={chatViews[tab] ?? 'chats'} initialTarget={chatTarget} /> },
          { key: 'calls', label: '通话', render: () => <CallsPanel onOpenChat={onOpenChat} /> },
          { key: 'revoked', label: '撤回', render: () => <RevokedPanel onOpenSettings={onOpenSettings} /> },
        ]}
      />
    )
    // 通讯录与社交图谱是**同一批人的两种看法**（联系人列表 / 关系图）：2026-09-17 起
    // 收进同一个导航项，由面板顶部段条切换。目前**共 9 组**合并视图走同一个外壳
    // （MergedSections：本文件 8 处 + KbShell.tsx 1 处 = 9）。
    // ⚠️ 组数以 `grep -c "<MergedSections"` 为准 —— 这里曾写「六组」，与实际差两组；
    // 由 panels/merged-sections.wiring.spec.ts 守着，改组数会在这里转红。
    // 两个 tab 必须都列全：深链 #contacts / #graph 要落到正确分段，
    // MergedSections 内部也是靠 `initial={tab}` 的变化来同步（它的 useState 只在首次生效）。
    // 图谱面板内部零改动（Graph.tsx 的 PanelHeader / 统计条 / 画布 / 右侧控制栏 /
    // 海报与 SVG·PNG 导出全部原样），因此不存在功能丢失。
    case 'contacts':
    case 'graph': return (
      <MergedSections
        ariaLabel="联系人与社交视图"
        initial={tab}
        sections={[
          { key: 'contacts', label: '通讯录', render: () => <ContactsPanel onNavigate={(t) =>{  onNavigate(t as WechatTab) }} onOpenChat={onOpenChat} onOpenMoments={onOpenMoments} seedQuery={seed?.tab === 'contacts' ? seed : undefined} /> },
          { key: 'graph', label: '社交图谱', render: () => <GraphPanel variant="social" onOpenChat={onOpenChat} /> },
        ]}
      />
    )
    // 知识图谱与知识库是**同一批笔记的两种看法**（同一个 `wechat_notes.db` 的 notes 表）：
    // 图谱把笔记当「网」看（力导向画布 / [[链接]] 边 / 待补节点），知识库把它当「文档」看
    // （列表 / 详情 / 新建编辑 / 标签 / 关键词搜索）。2026-09-18 起收进同一个导航项，
    // 由面板顶部段条切换 —— 与「通讯录/社交图谱」「收藏与表情」「文件与存储」等其余 7 组
    // 走同一个外壳（MergedSections，合计 8 组）。
    // 三个 tab 必须都列全：深链 #kb / #knowledge / #kbfiles 要落到正确分段，
    // MergedSections 内部也是靠 `initial={tab}` 的变化来同步（它的 useState 只在首次生效）。
    // 2026-09-19：分段与库切换一起搬进 `KbShell`（三栏：库 rail + 分段 + 面板体），
    // 这里只留一个分支 —— 三个 tab 仍各自是合法深链目标，落点由 `initial` 决定。
    // 注意**不要**把它们拆进 contacts|graph 那一段：笔记不属于通讯录语义，
    // 「联系人与社交」组下只有一次合并（contacts|graph）。
    case 'knowledge':
    case 'kb':
    case 'kbfiles': return (
      <KbShell
        initial={tab}
        onOpenChat={onOpenChat}
        focusFileId={kbFocus?.fileId ?? null}
        focusNonce={kbFocus?.nonce ?? 0}
      />
    )
    // 朋友圈与朋友圈洞察是**同一批朋友圈数据的两种看法**（浏览 / 分析）：
    // 2026-10-17 起收进同一个导航项，由面板顶部段条切换 —— 与「通讯录/社交图谱」
    // 「知识库/知识图谱」等其余组走同一个外壳（MergedSections）。
    // 两个 tab 必须都列全：深链 #moments / #momentsinsights 要落到正确分段，
    // MergedSections 内部也是靠 `initial={tab}` 的变化来同步（它的 useState 只在首次生效）。
    case 'moments':
    case 'momentsinsights': return (
      <MergedSections
        ariaLabel="朋友圈视图"
        initial={tab}
        sections={[
          { key: 'moments', label: '朋友圈', render: () => <MomentsPanel author={momentAuthor} onClearAuthor={clearMomentAuthor} /> },
          { key: 'momentsinsights', label: '洞察', render: () => <MomentsInsightsPanel /> },
        ]}
      />
    )
    // ── 合并面板：同一主题的多个视图收进一个导航项，顶部分段切换。
    //    每个 case 都列全被合并的 tab，保证深链（#assetinsights 等）仍落到正确分段。
    case 'favorites':
    case 'emoticons':
    case 'assetinsights': return (
      <MergedSections
        ariaLabel="收藏与表情视图"
        initial={tab}
        sections={[
          { key: 'favorites', label: '收藏', render: () => <FavoritesPanel seedQuery={seed?.tab === 'favorites' ? seed : undefined} /> },
          { key: 'emoticons', label: '表情', render: () => <EmoticonsPanel /> },
          { key: 'assetinsights', label: '统计', render: () => <AssetInsightsPanel /> },
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
          { key: 'files', label: '文件', render: () => <FilesPanel seedQuery={seed?.tab === 'files' ? seed : undefined} /> },
          { key: 'mediaassets', label: '媒体', render: () => <MediaAssetsPanel onNavigate={(t) =>{  onNavigate(t as WechatTab) }} /> },
          { key: 'storage', label: '存储', render: () => <StoragePanel onOpenChat={onOpenChat} /> },
          { key: 'officialassets', label: '公众号', render: () => <OfficialAssetsPanel onOpenChat={onOpenChat} /> },
        ]}
      />
    )
    case 'records':
    case 'ledger': return (
      <MergedSections
        ariaLabel="资金往来视图"
        initial={tab}
        sections={[
          { key: 'ledger', label: '汇总', render: () => <LedgerPanel onOpenChat={onOpenChat} /> },
          { key: 'records', label: '明细', render: () => <RecordsPanel onOpenChat={onOpenChat} seedQuery={seed?.tab === 'records' ? seed : undefined} /> },
        ]}
      />
    )
    case 'tasks': return <TasksPanel onOpenChat={onOpenChat} />
    // 任务信息（2026-10-19）：关键词触发式任务 + 触发记录（双栏）。与「待办日程」是两件事：
    // 待办从聊天文本里提取 TODO，这里的任务是用户显式创建的监听任务（命中关键词 → 记录 → 回调）。
    case 'taskinfo': return <TaskCenterPanel />
    case 'clawbot': return <ClawBotPanel />
    case 'groupinsights':
    case 'monitor': return (
      <MergedSections
        ariaLabel="群聊分析视图"
        initial={tab}
        sections={[
          { key: 'groupinsights', label: '洞察', render: () => <GroupInsightsPanel onOpenChat={onOpenChat} onNavigate={(t) =>{  onNavigate(t as WechatTab) }} /> },
          { key: 'monitor', label: '监控', render: () => <MonitorPanel onOpenChat={onOpenChat} /> },
        ]}
      />
    )
    // 只读数据视图留在主内容区：操作日志（审计长表）。
    // ⚠️ 隐私体检 2026-10-17 已迁回「设置」弹窗（见 DIALOG_SECTION_OF 与 Settings.tsx）。
    case 'oplog': return <OperationLogPanel />
    // 「数据边界与出网 / 备份恢复 / 数据健康（数据库健康、原图链路自检）」在「设置」弹窗里
    // （见 DIALOG_SECTION_OF），这里没有对应的主内容区页面。
    case 'annual':
    case 'dailysummary':
    case 'period': return (
      <MergedSections
        ariaLabel="总结与报告视图"
        // 2026-10-17：每日总结与周期总结**合并成一个「总结」工作台**。
        // 改前是两个面板，而每日总结内部还有 3 个 tab —— 用户要在 5 个视图间跳
        // 才能完成"生成一份总结并回看"。两者本质是同一件事（按时间范围总结聊天），
        // 只是粒度不同，所以用一个时间范围选择器驱动。
        // ⚠️ 分段 key 必须是**真实可路由的 tab**（`merged-sections.wiring.spec.ts` 会咬住）：
        // 深链 `#dailysummary` / `#period` 都落到 `dailysummary` 这个 key 上。
        initial={tab === 'annual' ? 'annual' : 'dailysummary'}
        sections={[
          { key: 'dailysummary', label: '总结', render: () => <SummaryWorkbench onOpenSettings={onOpenSettings} /> },
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
 * **不在这张表里的页签就是留在主界面的**：`oplog`（操作日志）2026-09 一度也进过弹窗，
 * 现按「只读数据视图回主界面、配置与维护动作留设置」迁回 —— 它是审计长表。
 * ⚠️ 2026-10-17：`privacy`（隐私体检）**又迁回弹窗**（用户要求）—— 它与「数据边界与出网」
 * 同属隐私主题，放一起才是一条完整的「隐私」叙事。迁回后**保留了「跳转 ›」**
 * （`onOpenChat` 由宿主传入，会先关弹窗再切主内容区）。
 */
const DIALOG_SECTION_OF: Readonly<Record<string, string>> = {
  settings: 'detect',
  privacytrust: 'boundary',
  privacy: 'privacy',
  backup: 'backup',
  health: 'health',
  hook: 'hook',
}

/**
 * 侧栏底部固定区：**设置**按钮。
 *
 * 为什么拆成独立组件（2026-09-30）：本文件的主组件有行数棘轮（只能变小），
 * 而「模型余额」是新加的一行。把这一整块提出来，主组件反而比原来少 30 行；
 * 顺带让「底部固定区」有了一个明确的名字。
 *
 * ⚠️ 2026-10-17 三块**全部迁到标题栏右上角**（窗口控制按钮前）：
 * · 主题切换 —— 与最小化/全屏/关闭同属「全局动作」；
 * · 模型余额 + 数据就绪 —— 描述的是**整个应用**的状态（模型能不能用、数据读不读得到），
 *   而不是当前页签的内容。侧栏是「导航」，不该兼当「状态栏」。
 * 所以这里只剩「设置」一个按钮。
 * @param props - 设置弹窗状态与打开动作。
 * @returns 底部固定区元素。
 */
function SidebarFooter({
  settingsOpen,
  onOpenSettings,
}: {
  settingsOpen: boolean
  onOpenSettings: () => void
}): React.JSX.Element {
  return (
    <div className={css.sidebarFooter}>
      {/* 底部固定区域：设置始终可见（点击弹出弹窗，不切换主内容区） */}
      <button
        type="button"
        className={css.navItem}
        data-active={settingsOpen || undefined}
        onClick={() => { onOpenSettings() }}
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
  )
}

/**
 * Render the WeChat data panel shell.
 * @returns the data panel element tree.
 */
export function WechatDataPanel(): React.JSX.Element {
  /** #settings / #privacytrust / #health 深链直接开弹窗落节；#privacy / #oplog 反过来留主内容区（只读视图）不开弹窗。 */
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
  /** 导航栏展开态：开关按钮切换，**默认展开**（2026-09-30 起；理由见文件头，无持久化）。 */
  const [navOpen, setNavOpen] = useState(true)
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
  useReleaseImagesOnTab(active, chatTarget?.username) // W3-10.1：切页签释放看不见的图片槽（语义表见 use-release-images-on-tab.ts）
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
    /** 某个域读失败时的说明（P1-1）：界面上必须与「未找到相关结果」分开显示。 */
    readError?: string
  }>({ sessions: [], hits: [], contacts: [], moments: [], favorites: [], files: [], records: [] })

  /** 当前搜索词（渲染作用域）：命中跳转时要把同一个词带进目标面板。 */
  const gsQuery = searchQuery.trim()

  /** Cross-panel navigation: jump to the chats tab and open/locate a session. */
  const openChat = useCallback((username: string, localId?: number): void => {
    const target: ChatTarget = { username, nonce: Date.now() }
    if (localId !== undefined) target.localId = localId
    setChatTarget(target)
    setActive('chats')
  }, [])

  /**
   * 问答引用 → 知识库文件：切到「知识库 · 文件」分段并就地选中那一份文件。
   *
   * 与 `openChat` 同形态（定点跳转 = 记目标 + 切页签），但目标有**两个**字段：
   * 文件 id 是全局自增的，只带 `fileId` 切库之后会把用户送到另一个库里的同号文件。
   * 先 `setActiveKb` 再导航 —— 文件面板的取数与首帧缓存都按当前库算，
   * 顺序反了它会拿旧库去查，列表里根本没有这一条。
   */
  const [kbFocus, setKbFocus] = useState<{ fileId: number; nonce: number } | null>(null)
  const openKbFile = useCallback((kbId: number, fileId: number): void => {
    setActiveKb(kbId)
    setKbFocus({ fileId, nonce: Date.now() })
    setActive('kbfiles')
  }, [setActive])

  /**
   * 弹窗里装不下的跳转（如「文件资产 / 存储分析」）：关掉弹窗，再走正常导航切主内容区。
   * 装得下的那几节由 SettingsPanel 内部直接切节，不会走到这里。
   */
  const navigateFromDialog = useCallback((tab: string): void => {
    setSettingsOpen(false)
    navigate(tab as WechatTab)
  }, [navigate])

  /**
   * 弹窗里的「跳转 ›」（2026-10-17 隐私体检迁进弹窗后新增）：**先关弹窗再跳会话**。
   *
   * 为什么不能直接用 `openChat`：它只切主内容区，弹窗还开着会盖住刚跳过去的会话 ——
   * 用户看到的是「点了没反应」。与 `navigateFromDialog` 同款打法（先关再跳）。
   */
  const openChatFromDialog = useCallback((username: string, localId?: number): void => {
    setSettingsOpen(false)
    openChat(username, localId)
  }, [openChat])

  /**
   * 全局搜索命中 → 切到目标页签并把关键词种进去（面板靠 `nonce` 变化重新种入）。
   * 刻意保留全局搜索框里已输入的内容（不清空）：用户可能还想看下一组命中。
   */
  const [seed, setSeed] = useState<SearchSeed | null>(null)
  const seedTo = useCallback((tab: WechatTab, q: string): void => {
    setSeed({ tab, q, nonce: Date.now() })
    setActive(tab)
  }, [setActive])

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
        apiGetSessions({ keyword: q, limit: 8 }).catch((): { sessions: never[]; total: number } => ({ sessions: [], total: 0 })),
        apiSearchUnified({ query: q, limit: 8 }).catch((e): UnifiedSearchSnapshot => ({
          // 整个请求失败：这同样是「读不到」，不许悄悄画成「没有结果」。
          query: q, messages: [], contacts: [], moments: [], favorites: [], files: [], records: [],
          readError: `搜索请求失败（${(e as Error).message}）—— 这不是「没有结果」`,
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
          readError: un.readError,
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

  /**
   * 词云等分析面板 → 全局搜索（R11）：收到「查这个词」就把三步做齐——
   * 开导航条（搜索框在里头）、种词、下一帧聚焦。与 Ctrl+K 同一套动作，
   * 搜什么不在这里管：debounce 搜索 effect 只认 `searchQuery` 的变化，种下去它自己会跑。
   */
  useEffect(() => {
    const onSearchQuery = (e: Event): void => {
      const q = searchQueryFromEvent(e)
      if (!q) return
      setSearchQuery(q)
      setNavOpen(true)
      window.requestAnimationFrame(() => { searchInputRef.current?.focus() })
      setSearchOpen(true)
    }
    window.addEventListener(SEARCH_QUERY_EVENT, onSearchQuery)
    return () => { window.removeEventListener(SEARCH_QUERY_EVENT, onSearchQuery) }
  }, [])

  // 导航栏收起时搜索框被隐藏（display: none）。此时结果面板若还开着，就会拿一组
  // 全零的矩形去定位，直接飘到屏幕左上角 —— 收起导航时一并关掉面板。
  useEffect(() => {
    if (!navOpen) setSearchOpen(false)
  }, [navOpen])

  const activePanel = useMemo(
    () => renderTab(active, navigate, openChat, chatTarget, openMoments, momentAuthor, () => { setMomentAuthor(null) }, openSettings, seed, openKbFile, kbFocus),
    [active, navigate, openChat, chatTarget, openMoments, momentAuthor, openSettings, seed, openKbFile, kbFocus],
  )
  const keepAlivePanel = useKeepAlivePanel(active, activePanel)

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
    <div className={`${css.panel} ${compactCss.compactChrome}`}>
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
      <MobileNavHost active={active} onSelect={(t) => { setChatTarget(null); setMomentAuthor(null); setActive(t) }} onOpenSettings={() => { openSettings() }} />
      <div className={css.body}>
        <aside className={css.sidebar} data-open={navOpen || undefined}>
          {/* 品牌：头像 + 产品名（原顶栏左侧）。头像沿用原顶栏的品牌位实现
              （BrandAvatar 已配置微信账号时显示账号头像，否则显示品牌标记）。 */}
          <div className={css.navBrand} title="Super Time">
            <span className={css.navBrandLogo}>
              <BrandAvatar online={apiStatus === 'online'} />
            </span>
            <span className={css.navBrandText}>
              <BrandTitle />
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
              {searchResults.readError && <div className={gs.empty} role="alert">{searchResults.readError}</div>}
              {noSearchResults && !searchResults.readError && <div className={gs.empty}>未找到相关结果</div>}
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
                    <button key={`c:${c.username}:${i}`} type="button" className={gs.row} onClick={() => { setSearchOpen(false); if (c.category === 'contact' || c.category === 'group') openChat(c.username); else seedTo('contacts', gsQuery) }}>
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
                    <button key={`f:${f.id}:${i}`} type="button" className={gs.row} onClick={() => { setSearchOpen(false); seedTo('favorites', gsQuery) }}>
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
                    <button key={`file:${f.fileName}:${i}`} type="button" className={gs.row} onClick={() => { setSearchOpen(false); seedTo('files', gsQuery) }}>
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
                    <button key={`r:${r.kind}:${r.session}:${i}`} type="button" className={gs.row} onClick={() => { setSearchOpen(false); seedTo('records', gsQuery) }}>
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
          {/* 底部固定区（只剩「设置」）：见 `SidebarFooter`。
              模型余额 / 数据就绪 / 主题切换 2026-10-17 全部迁到标题栏右上角。 */}
          <SidebarFooter
            settingsOpen={settingsOpen}
            onOpenSettings={openSettings}
          />
        </aside>
        <main className={css.content}>
          <Suspense fallback={<div className={css.loadingFallback}>正在加载面板…</div>}>
            {keepAlivePanel}
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
            <span className={css.settingsDialogDesc}>{runtimeCapabilities().isBrowser && runtimeCapabilities().desktopEquivalent !== true ? '手机这一侧能看的只有数据边界 · 其余各节要在电脑上完成' : '配置向导 · 智能与隐私 · 授权与更新 · 维护与自检 · 高级'}</span>
          </span>
        )}
      >
        <div className={css.settingsDialogBody}>
          <SettingsPanelGate
            inDialog
            initialSection={settingsSection}
            onNavigateOut={navigateFromDialog}
            onOpenChat={openChatFromDialog}
          />
        </div>
      </Dialog>

    </div>
    </ConfirmProvider>
  )
}








