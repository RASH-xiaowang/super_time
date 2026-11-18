
/**
 * Chats 面板的那棵 JSX（M21 第三十三刀自 Chats.tsx 拆出）。
 *
 * 面板侧只剩 `const { … } = …`? 不 —— 面板仍然持有状态与副作用，这里只把**渲染**搬走：
 * 道具名与面板作用域里的名字完全相同 ⇒ JSX 逐行搬、面板侧一个对象字面量传进去。
 * 这样做的收益不是「少写几行」，而是：状态与老逻辑与渲染彻底分开之后，
 * 每一屏（日历、消息行、导出弹窗…）能单独搬出去配行为用例，搬的时候不必再动这棵树。
 *
 * 第九刀把那个道具袋按**消费方**分了几组：只有一个消费方的那 65 件收进四组，
 * 组的类型直接写成弹窗自己的 props（`calendar: ChatsCalendarDialogProps`）——
 * 原先这些名字在「袋的类型 / 调用点 / 面板的字面量」里各抄一遍，加一件道具要记着改三处，
 * 漏一处不会报错，只会让那一屏少读一个值。现在只有 props 那一份是出处。
 */
import { useCallback, useEffect, useRef } from 'react'
import type { ChatlogFrame } from './chats-chatlog.ts'
import kitCss from '../ui/kit.module.css'
import { EmptyMaybeSyncing, ErrorState, LoadingState, SearchInput, Segmented } from '../ui/kit.tsx'
import { ChatRightPanel } from './ChatRightPanel.tsx'
import { ChatsHeadActions } from './chats-head-actions.tsx'
import { SessionAsk } from './SessionAsk.tsx'
import { ImageViewer } from './chats-media.tsx'
import { ChatView, IconPin, buildMsgMenu, isEnterpriseChat } from './chats-support.tsx'
import css from './chats.module.css'
import cssrows from './chats-rows.module.css'
import cssnewmsg from './chats-new-msg.module.css'
import csscards from './chats-cards.module.css'
import { desktopAction, desktopActionProps } from '../ui/desktop-only.tsx'
import cssshell from './chats-shell.module.css'
import { ListSentinel, ListSkeleton, ProgressiveListSpacer } from './hooks.tsx'
import { ChatsContactInfoView } from './chats-contact-info-view.tsx'
import { ChatsExportDialog, type ChatsExportDialogProps } from './chats-export-dialog.tsx'
import { ExportProgressStatus } from './ExportProgressStatus.tsx'
import type { ExportTaskState } from './export-task.ts'
import { ChatsGroupInfoView, type ChatsGroupInfoViewProps } from './chats-group-info-view.tsx'
import { ChatsChatlogView } from './chats-chatlog-dialog.tsx'
import { ChatsCalendarDialog, type ChatsCalendarDialogProps } from './chats-calendar-dialog.tsx'
import { ChatsEditedDialog, type ChatsEditedDialogProps } from './chats-edited-dialog.tsx'
import { ChatsMsgMenu } from './chats-msg-menu.tsx'
import { ChatsMessageTools, type ChatsMessageToolsController } from './chats-message-tools.tsx'
import {
  ChatsPosterOverlay,
  ChatsPosterSelectionBar,
  posterItemHead,
  posterItemLocalId,
  posterItemsForSelection,
  posterMessageCount,
  type ChatsPosterController,
} from './chats-poster.tsx'
import type { MsgRowRenderer } from './chats-msg-row.tsx'
import cssposter from './chats-poster.module.css'
import { ChatsMemberProfile } from './chats-member-profile.tsx'
import type { ExpoType, ExpFormat } from './chats-export.tsx'
import { useImagePreload } from './use-image-preload.ts'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { ChatlogRecord, EditedMessageRecord, GroupInfo, GroupMember, MessageRenderKind as RenderKind, SearchHit, WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import type { ViewerImage } from './chats-media.tsx'
import { usePagedList } from './hooks.tsx'
import { focusListRow } from './list-keyboard.ts'
import type { MsgMenuItem } from './chats-support.tsx'
import type { MessageRenderItem } from '../utils/message-items.ts'
import { isAnalyzableMessage, type AnalysisTargetState } from './analysis-selection.ts'
import { useChatsAnalysis } from './chats-analysis.ts'
import { withEnterprise } from './enterprise-identity.ts'
import { shouldShowEnterpriseBadge } from './session-list.ts'
import { IdentityName } from './identity.tsx'
import type { MessageFileSaveTask } from './message-file-save.ts'

/** 消息流距顶部多少像素时自动加载更早消息。 */
const AUTO_LOAD_OLDER_PX = 120

export interface ChatsViewProps {
  /** Right-click tools (source/info/editors) live outside the state bag. */
  messageTools: ChatsMessageToolsController
  /** Multi-message poster selection and preview state, outside the state bag. */
  messagePoster: ChatsPosterController
  /**
   * 一次性动作回执（W3-11.1）：编辑/草稿/复制/打开文件的结果，一行会自动消失的小字。
   *
   * 为什么是**袋外独立 prop** 而不是塞进 `state` 袋：`chats-state-bag.wiring.spec.ts` 的棘轮
   * 明确「平铺字段只许变小」，而它的四条分组各对应一个弹窗 props 接口 —— 回执没有弹窗消费方，
   * 硬塞进任何一组都会让那个接口背上与自己无关的字段。独立 prop 由 typecheck 保证供得上。
   */
  notice?: string | null
  /**
   * 搜索索引构建的进度（W3-11.5；null = 没在构建）。同样是**袋外独立 prop**：
   * 棘轮只许平铺字段变小，而这一项的归属既不属于四个弹窗组、也不是「多个读处」的平铺字段
   * （只有搜索结果区那一处读它）。
   */
  indexProgress?: { done: number; total: number; rows: number } | null
  /** 停止在跑的索引构建（W3-11.5）。不给就没有「停止」按钮。 */
  onCancelIndexBuild?: () => void | Promise<void>
  /** 停止在跑的消息搜索（N9）。搜索中才渲染，取消结果经面板操作回执显示。 */
  onCancelMsgSearch?: () => void
  /**
   * 手机档（≤560）「返回会话列表」。**袋外独立 prop**，理由与上面两条相同：
   * `state` 袋的平铺字段卡在 96 件的棘轮上（`chats-state-bag.wiring.spec.ts`），
   * 一件都加不进去；而这一项只有一个消费方（头部那枚返回按钮），也不是任何一袋弹窗的道具。
   */
  onBackToList?: () => void
  /** 会话级 AI 回复开关（袋外独立 prop，避免扩大状态袋）。 */
  aiReply?: {
    visible: boolean
    enabled: boolean
    stage: string
    busy: boolean
    ready: boolean
    error?: string
    lastRunAt?: number
    recordId?: number
    personaName: string
    personaPrompt: string
    splitReply: boolean
    kbEnabled: boolean
    kbId: number
    /** 上下文时间窗（小时）；0 = 不限。 */
    contextWindowHours: number
    onToggle: () => void
    onScanNow: () => void
    onSavePersona: (input: {
      name: string
      prompt: string
      splitReply: boolean
      kbEnabled: boolean
      kbId: number
      contextWindowHours: number
    }) => Promise<boolean>
  }
  /** 会话列表的 AI 回复徽标与筛选；与当前会话的 aiReply 开关分开。 */
  aiReplyFilter: {
    enabledUsernames: ReadonlySet<string>
    aiOnly: boolean
    count: number
    loading: boolean
    error?: string
    onToggle: () => void
  }
  /** Right-click "open file" save lifecycle; rendered directly under the message header. */
  messageFileSave: MessageFileSaveTask
  /** 左侧批量导出的统一任务状态；只给会话列表工具行消费。 */
  batchExport: {
    state: ExportTaskState | null
    running: boolean
    finishing: boolean
    onCancel: () => void
  }
  /** 消息虚拟列表的 DOM 挂点与滚动容器前导偏移。袋外独立 prop，避免扩大状态袋。 */
  messageVirtualization: {
    listRef: React.MutableRefObject<HTMLDivElement | null>
    scrollMargin: number
  }
  /**
   * 面板作用域里那批状态/回调，收成一个对象（摊到调用点就是一百多行道具字面量）。
   * 前四件是**按消费方分的组**：类型直接写弹窗自己的 props，加一件道具就必须两处同时供得上，
   * 不必再记着「袋里、调用点、面板字面量」三处各抄一遍。剩下的平铺字段都有多个读处。
   */
  state: {
      calendar: ChatsCalendarDialogProps
      edited: ChatsEditedDialogProps
      exportDialog: ChatsExportDialogProps
      groupInfo: Omit<ChatsGroupInfoViewProps, 'isGroup' | 'open'>
      aiEligible: boolean
      analysisPaneOpen: boolean
      setAnalysisPaneOpen: React.Dispatch<React.SetStateAction<boolean>>
      analysisTarget: AnalysisTargetState | null
      setAnalysisTarget: React.Dispatch<React.SetStateAction<AnalysisTargetState | null>>
      aiFull: boolean
      aiOpen: boolean
      aiTarget: WechatSession | null
      batchMode: boolean
      buildIndex: (silent?: boolean) => Promise<void>
      changeView: (next: ChatView) => void
      chatlogOpen: ChatlogFrame | null
      chatlogResolving: boolean
      chatlogStack: ChatlogFrame[]
      clearAllDrafts: () => Promise<void>
      clearDraft: () => Promise<void>
      curSession: WechatSession | null
      error: string | null
      exportBatch: () => Promise<void>
      exportMsg: string | null
      filtered: readonly WechatSession[]
      groupInfoOpen: boolean
      hasMore: boolean
      indexBuilding: boolean
      /** 点「N 条新消息」浮标：跳回最新并恢复自动跟随。 */
      jumpToLatest: () => void
      loadMore: () => Promise<void>
      loading: boolean
      memberLimit: number
      messages: readonly WechatMessage[]
      messagesMatchSession: boolean
      moreOpen: boolean
      msgEndRef: React.MutableRefObject<HTMLDivElement | null>
      msgError: string | null
      msgHits: readonly SearchHit[]
      msgIndexed: boolean
      msgItems: MessageRenderItem[]
      msgLoading: boolean
      msgMenu: { x: number; y: number; m: WechatMessage; kind: RenderKind } | null
      msgScrollRef: React.MutableRefObject<HTMLDivElement | null>
      msgSearchError: string | null
      msgSearchLoading: boolean
      msgSearched: boolean
      msgVirtualizer: Virtualizer<HTMLDivElement, Element>
      /** 用户正在翻历史时收到、还没看的新消息条数（0 = 不显示浮标）。 */
      newMsgCount: number
      normalList: readonly WechatSession[]
      onSearchInput: (q: string) => void
      openCalendar: () => Promise<void>
      openEdits: () => Promise<void>
      openGroupInfo: () => void
      contactInfoOpen: boolean
      setContactInfoOpen: React.Dispatch<React.SetStateAction<boolean>>
      openNestedChatlog: (rec: ChatlogRecord) => Promise<void>
      openSession: (s: WechatSession) => Promise<void>
      openSessionAndLocate: (username: string, localId?: number, dayStart?: number) => Promise<void>
      /** 重新拉取当前会话最新一页：消息流错误条的重试入口。 */
      reloadCurrent: () => Promise<void>
      pinnedCollapsed: boolean
      pinnedList: readonly WechatSession[]
      pollStatus: string
      profileMember: GroupMember | null
      profilePos: { left: number; top: number } | null
      renderMsgItem: MsgRowRenderer
      renderSession: (s: WechatSession, itemIndex?: number) => React.JSX.Element
      runMenuAction: (item: MsgMenuItem, m: WechatMessage) => void
      /** Esc/点空白关闭消息菜单，并把焦点还给消息行。 */
      dismissMsgMenu: () => void
      search: string
      searchMode: 'session' | 'message'
      selected: Set<string>
      sessBeforeHeight: number
      sessCount: number
      sessSentinel: (el: HTMLDivElement | null) => void
      sessStart: number
      sessTopSentinel: (el: HTMLDivElement | null) => void
      sessionListRef: React.MutableRefObject<HTMLDivElement | null>
      sessionSearching: boolean
      sessionsLoadMoreRef: (el: HTMLDivElement | null) => void
      sessionsPager: ReturnType<typeof usePagedList<WechatSession>>
      setAiFull: React.Dispatch<React.SetStateAction<boolean>>
      setAiOpen: React.Dispatch<React.SetStateAction<boolean>>
      setBatchMode: React.Dispatch<React.SetStateAction<boolean>>
      setChatlogStack: React.Dispatch<React.SetStateAction<ChatlogFrame[]>>
      setMoreOpen: React.Dispatch<React.SetStateAction<boolean>>
      setMsgMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; m: WechatMessage; kind: RenderKind } | null>>
      setSearch: React.Dispatch<React.SetStateAction<string>>
      setSearchMode: React.Dispatch<React.SetStateAction<'session' | 'message'>>
      setSelected: React.Dispatch<React.SetStateAction<Set<string>>>
      setViewer: React.Dispatch<React.SetStateAction<{ images: ViewerImage[]; index: number } | null>>
      stats: { friends: number; groups: number; unread: number }
      togglePinned: () => void
      typeStats: readonly { type: number; label: string; count: number }[]
      view: ChatView
      viewer: { images: ViewerImage[]; index: number } | null
  }
}

/** 「已加载最近 N 个会话」提示条（触到 `usePagedList` 的 `maxItems` 上界时显示）。 */
function CapNote({ loaded, total }: { loaded: number; total: number }): React.JSX.Element {
  return <div className={cssshell.capNote} role="status">已加载最近 {loaded} 个会话（共 {total} 个）。要找更早的请用搜索。</div>
}

/**
 * 消息区外壳：滚动容器 + 「N 条新消息」浮标（2026-10-18）。
 * 浮标只在用户翻历史且轮询追加了新消息时出现；点击跳回最新，不抢正常阅读的滚动。
 */
function MsgScrollArea({ scrollRef, newMsgCount, onJump, children, interactionLocked = false, onScroll }: {
  scrollRef: React.MutableRefObject<HTMLDivElement | null>
  newMsgCount: number
  onJump: () => void
  children: React.ReactNode
  interactionLocked?: boolean
  onScroll?: React.UIEventHandler<HTMLDivElement>
}): React.JSX.Element {
  // 捕获阶段只拦点击，不用 pointer-events:none：滚轮和触摸滚动必须保持可用。
  return (
    <div className={cssnewmsg.msgWrap}>
      <div
        className={cssrows.msgBody}
        ref={scrollRef}
        onScroll={onScroll}
        data-message-interaction-locked={interactionLocked || undefined}
        onClickCapture={interactionLocked
          ? (event) => {
              event.preventDefault()
              event.stopPropagation()
            }
          : undefined}
      >
        {children}
      </div>
      {newMsgCount > 0 && (
        <button
          type="button"
          className={cssnewmsg.newMsgPill}
          onClick={onJump}
          title="跳到最新消息"
          aria-label={`${newMsgCount} 条新消息，跳到最新`}
        >
          ↓ {newMsgCount} 条新消息
        </button>
      )}
    </div>
  )
}

/** Search-result identity: group hits show sender first, direct hits show the session. */
function SearchHitIdentity({ hit }: { hit: SearchHit }): React.JSX.Element {
  const session = withEnterprise(hit.name || hit.username, hit.enterpriseName)
  const senderUsername = (hit.sender_username ?? '').trim()
  const sender = hit.sender ? withEnterprise(hit.sender, hit.senderEnterpriseName) : ''
  return (
    <IdentityName
      className={cssshell.searchHitIdentity}
      textClassName={cssshell.searchHitName}
      name={senderUsername ? (hit.sender || hit.name || hit.username) : (hit.name || hit.username)}
      username={senderUsername || hit.username}
      size={24}
      title={sender ? `${sender} · ${session}` : session}
    >
      {sender ? `${sender} · ${session}` : session}
    </IdentityName>
  )
}

/** Current session heading with the same display-only enterprise suffix as the list. */
function ChatSessionHeading({ session }: { session: WechatSession }): React.JSX.Element {
  const showEnterpriseBadge = shouldShowEnterpriseBadge(session, isEnterpriseChat(session.username))
  return (
    <IdentityName
      className={csscards.msgHeaderIdentity}
      textClassName={csscards.msgHeaderName}
      name={session.displayName || session.username}
      username={session.username}
      size={36}
    >
      <span>{withEnterprise(session.displayName || session.username, session.enterpriseName)}</span>
      {showEnterpriseBadge && (
        <span className={csscards.entBadge} title={session.enterpriseName ? `企业微信 · ${session.enterpriseName}` : '企业微信'}>
          企微
        </span>
      )}
    </IdentityName>
  )
}

/** Left pane: search mode switch, session filters, paged sessions, and global message hits. */
function ChatsSessionPane({
  state,
  batchExport,
  indexProgress,
  onCancelIndexBuild,
  onCancelMsgSearch,
  aiReplyFilter,
}: {
  state: ChatsViewProps['state']
  batchExport: ChatsViewProps['batchExport']
  indexProgress?: { done: number; total: number; rows: number } | null
  onCancelIndexBuild?: () => void | Promise<void>
  onCancelMsgSearch?: () => void
  aiReplyFilter: ChatsViewProps['aiReplyFilter']
}): React.JSX.Element {
  const {
    batchMode, buildIndex, changeView, error, exportBatch, filtered,
    indexBuilding, loading, msgHits, msgIndexed, msgSearchError, msgSearchLoading, msgSearched,
    normalList, onSearchInput, openSessionAndLocate, pinnedCollapsed, pinnedList, renderSession,
    search, searchMode, selected, sessBeforeHeight, sessCount, sessSentinel, sessStart,
    sessTopSentinel, sessionListRef, sessionSearching, sessionsLoadMoreRef, sessionsPager,
    setBatchMode, setSearch, setSearchMode, setSelected, stats, togglePinned, view,
  } = state
  const aiFilterBlocked = aiReplyFilter.count === 0
    && (aiReplyFilter.loading || aiReplyFilter.error !== undefined)
  const emptyText = aiReplyFilter.aiOnly && view === 'chats'
    ? '暂无开启 AI 回复的会话'
    : view === 'chats'
      ? '暂无会话'
      : '暂无' + (view === 'kefu' ? '客服会话' : '订阅会话')

  return (
    <div className={csscards.sidebar} data-chat-sidebar="">
      <div className={csscards.filterStrip}>
        <div className={csscards.search}>
          <SearchInput
            className={csscards.searchField}
            value={search}
            onChange={(v) => {
              setSearch(v)
              if (searchMode === 'message') onSearchInput(v)
            }}
            placeholder={searchMode === 'message' ? '搜索全部消息' : '搜索会话'}
            ariaLabel={searchMode === 'message' ? '搜索全部消息' : '搜索会话'}
          />
          <button
            type="button"
            className={csscards.searchActionBtn}
            data-active={searchMode === 'message' || undefined}
            title="全局消息搜索"
            onClick={() => {
              const next = searchMode === 'message' ? 'session' : 'message'
              setSearchMode(next)
              if (next === 'message' && search.trim()) onSearchInput(search)
            }}
          >搜消息</button>
          <button
            type="button"
            className={csscards.searchActionBtn}
            data-active={batchMode || undefined}
            title="批量导出会话原文件 ZIP"
            onClick={() => { setBatchMode(v => !v); setSelected(new Set()) }}
          >{batchMode ? '退出批量' : '批量原文件'}</button>
        </div>
        {searchMode === 'session' && (
          <div className={csscards.typeFilter}>
            <Segmented
              options={[
                { value: 'chats', label: '全部' },
                { value: 'bizchats', label: '公众号' },
                { value: 'servicechats', label: '服务号' },
                { value: 'kefu', label: '客服' },
              ]}
              value={view}
              onChange={(v) => { changeView(v as ChatView) }}
              ariaLabel="会话分类"
            />
            {view === 'chats' && (
              <button
                type="button"
                className={csscards.aiFilter}
                data-active={aiReplyFilter.aiOnly || undefined}
                aria-pressed={aiReplyFilter.aiOnly}
                aria-label={aiReplyFilter.aiOnly ? '显示全部会话' : '只看开启 AI 回复的会话'}
                disabled={aiFilterBlocked}
                title={aiReplyFilter.error ?? (aiReplyFilter.aiOnly ? '显示全部会话' : '只看开启 AI 回复的会话')}
                onClick={aiReplyFilter.onToggle}
              >
                <span className={csscards.aiFilterMark} aria-hidden="true">AI</span>
                <span>回复</span>
                <span className={csscards.aiFilterCount}>
                  {aiReplyFilter.loading && aiReplyFilter.count === 0 ? '…' : aiReplyFilter.count}
                </span>
              </button>
            )}
            <div className={csscards.stats}>
              {batchMode ? (
                <>
                  <button type="button" className={csscards.batchBtn} onClick={() => { setSelected(new Set(filtered.map(x => x.username))) }}>全选</button>
                  <button type="button" className={csscards.batchBtn} onClick={() => { setSelected(new Set()) }}>清空</button>
                  <span className={cssshell.statUnread}>已选 {selected.size}</span>
                  <button
                    type="button"
                    className={csscards.batchBtn}
                    onClick={() => { void exportBatch() }}
                    disabled={batchExport.running || selected.size === 0}
                    title={!batchExport.running && selected.size === 0 ? '先选择至少一个会话' : undefined}
                  >
                    {batchExport.finishing ? '完成中…' : batchExport.running ? '导出中…' : '导出所选 ZIP'}
                  </button>
                </>
              ) : (
                <>
                  <span>好友 {stats.friends}</span>
                  <span>群聊 {stats.groups}</span>
                  {stats.unread > 0 && <span className={cssshell.statUnread}>未读 {stats.unread}</span>}
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {searchMode === 'session' ? (
        <>
          {batchMode && batchExport.state && (
            <div className={cssshell.batchProgress}>
              <ExportProgressStatus state={batchExport.state} onCancel={batchExport.onCancel} compact />
            </div>
          )}
          <div ref={sessionListRef} className={cssshell.list} onKeyDown={(event) => { focusListRow(event, sessionListRef.current, '[data-session-row]') }}>
            {loading && <ListSkeleton rows={10} />}
            {error && <div className={kitCss.error} role="alert">{error}</div>}
            {!loading && !error && filtered.length === 0 && <EmptyMaybeSyncing text={emptyText} />}
            {!loading && !error && pinnedList.length > 0 && (
              <div className={cssshell.pinSection}>
                {!pinnedCollapsed && pinnedList.map(s => renderSession(s))}
                <button type="button" className={csscards.pinToggle} onClick={togglePinned}>
                  <span className={css.pinMark}><IconPin /> 置顶（{pinnedList.length}）</span>
                  <span className={cssshell.pinArrow}>{pinnedCollapsed ? '▸' : '▾'}</span>
                </button>
              </div>
            )}
            {!loading && !error && <ProgressiveListSpacer height={sessBeforeHeight} topSentinelRef={sessTopSentinel} />}
            {!loading && !error && normalList.slice(sessStart, sessCount).map((s, idx) => renderSession(s, sessStart + idx))}
            {!loading && !error && normalList.length > sessCount && <ListSentinel refFn={sessSentinel} />}
            {!loading && !error && !sessionSearching && (sessionsPager.capped ? <CapNote loaded={normalList.length} total={sessionsPager.total} /> : sessionsPager.hasMore && <ListSentinel refFn={sessionsLoadMoreRef} />)}
          </div>
        </>
      ) : (
        <div className={cssshell.list}>
          {!msgIndexed && (
            <div className={csscards.searchIndexHint}>
              <span>消息搜索索引尚未构建（当前为全表扫描）</span>
              {indexBuilding ? (
                <>
                  <span className={csscards.searchIndexProgress}>
                    正在构建{indexProgress && indexProgress.total > 0
                      ? `（第 ${indexProgress.done}/${indexProgress.total} 个分片 · 已入库 ${indexProgress.rows} 条）`
                      : '…'}
                  </span>
                  <button type="button" className={csscards.loadMore} onClick={() => { void onCancelIndexBuild?.() }}>停止</button>
                </>
              ) : (
                <button type="button" className={csscards.loadMore} onClick={() => { void buildIndex() }} {...desktopActionProps()}>{desktopAction() ? '构建索引（仅电脑）' : '构建索引'}</button>
              )}
            </div>
          )}
          {msgSearchLoading && (
            <>
              <LoadingState variant="compact" label="搜索中…" />
              {onCancelMsgSearch && (
                <button type="button" className={csscards.loadMore} onClick={onCancelMsgSearch}>
                  停止搜索
                </button>
              )}
            </>
          )}
          {msgSearchError && <ErrorState message={msgSearchError} />}
          {!msgSearchLoading && msgSearched && msgHits.length === 0 && !msgSearchError && <div className={kitCss.emptyInline}>未找到相关消息</div>}
          {!msgSearchLoading && msgHits.length > 0 && (
            <>
              <div className={cssshell.searchHitCount}>命中 {msgHits.length} 条 · 点击定位到原消息</div>
              {msgHits.map(hit => (
                <button key={`${hit.username}:${hit.local_id}`} type="button" className={csscards.searchHit} onClick={() => { void openSessionAndLocate(hit.username, hit.local_id) }}>
                  <div className={cssshell.searchHitTop}>
                    <SearchHitIdentity hit={hit} />
                    <span className={cssshell.searchHitTime}>{hit.time}</span>
                  </div>
                  <div className={cssshell.searchHitSnippet}>{hit.snippet}</div>
                </button>
              ))}
            </>
          )}
          {!msgSearchLoading && !msgSearched && !msgSearchError && <div className={kitCss.emptyInline}>输入关键词搜索全部消息</div>}
        </div>
      )}
    </div>
  )
}

interface ChatsMessageStreamProps {
  messages: readonly WechatMessage[]
  messagesMatchSession: boolean
  hasMore: boolean
  msgLoading: boolean
  msgError: string | null
  msgItems: MessageRenderItem[]
  msgVirtualizer: Virtualizer<HTMLDivElement, Element>
  messageVirtualization: ChatsViewProps['messageVirtualization']
  msgScrollRef: React.MutableRefObject<HTMLDivElement | null>
  msgEndRef: React.MutableRefObject<HTMLDivElement | null>
  newMsgCount: number
  jumpToLatest: () => void
  loadMore: () => Promise<void>
  reloadCurrent: () => Promise<void>
  selectedLocalId: number | null
  messagePoster: ChatsPosterController
  renderMsgItem: MsgRowRenderer
  openMessageAnalysis: (message: WechatMessage) => void
}

/** 消息流本体；与标题栏/右栏拆开，保证会话面板只负责装配而不是承载整棵虚拟列表。 */
function ChatsMessageStream(props: ChatsMessageStreamProps): React.JSX.Element {
  const {
    messages, messagesMatchSession, hasMore, msgLoading, msgError, msgItems,
    msgVirtualizer, messageVirtualization, msgScrollRef, msgEndRef, newMsgCount,
    jumpToLatest, loadMore, reloadCurrent, selectedLocalId,
    messagePoster, renderMsgItem, openMessageAnalysis,
  } = props
  const previousScrollTopRef = useRef(0)
  const autoLoadArmedRef = useRef(false)
  const autoLoadInFlightRef = useRef(false)

  // 切会话时重新布防：首屏是程序化滚到底，不能被当成用户向上翻历史。
  useEffect(() => {
    autoLoadArmedRef.current = false
    previousScrollTopRef.current = msgScrollRef.current?.scrollTop ?? 0
  }, [messagesMatchSession, msgScrollRef])

  const triggerLoadOlder = useCallback((): void => {
    if (!hasMore || msgLoading || autoLoadInFlightRef.current) return
    autoLoadInFlightRef.current = true
    void loadMore().finally(() => { autoLoadInFlightRef.current = false })
  }, [hasMore, loadMore, msgLoading])

  const onMessageScroll = useCallback((event: React.UIEvent<HTMLDivElement>): void => {
    const nextScrollTop = event.currentTarget.scrollTop
    const previousScrollTop = previousScrollTopRef.current
    previousScrollTopRef.current = nextScrollTop
    // 只有用户主动向上滚动过才布防；首屏 pin 到底和加载后的锚定都会向下移动。
    if (nextScrollTop < previousScrollTop - 1) autoLoadArmedRef.current = true
    if (!autoLoadArmedRef.current || nextScrollTop > AUTO_LOAD_OLDER_PX) return
    triggerLoadOlder()
  }, [triggerLoadOlder])

  return (
    <MsgScrollArea
      scrollRef={msgScrollRef}
      newMsgCount={newMsgCount}
      onJump={jumpToLatest}

      onScroll={onMessageScroll}
    >
      {/* 归属不符（正在切会话）时只显示骨架，绝不把上一个会话的消息画出来 */}
      {!messagesMatchSession && <ListSkeleton rows={8} />}
      {messagesMatchSession && msgError && (
        <ErrorState message={msgError} onRetry={() => { void reloadCurrent() }} />
      )}
      {messagesMatchSession && !msgLoading && !msgError && messages.length === 0 && (
        <div className={csscards.msgEmptyState} role="status">
          <div className={csscards.msgEmptyTitle}>暂无可显示的消息</div>
          <div className={csscards.msgEmptyText}>该会话可能尚未同步，或微信本地没有可读取的消息记录。</div>
        </div>
      )}
      {messagesMatchSession && (
        /*
         * 虚拟化（N18）：外层按总高度撑开滚动条，行按各自偏移绝对定位。
         * 只挂载视口附近（`overscan`）+ 动态测高（`measureElement`），
         * 所以 DOM 节点数与已加载的历史长度**解耦**（实测 1 万条消息从 9,700 个节点降到几十个）。
         * `id="msg-<localId>"` 仍在行上，深链与 `locateMessage` 照旧可用。
         */
        <div ref={messageVirtualization.listRef} style={{ height: msgVirtualizer.getTotalSize(), position: 'relative', flex: '0 0 auto' }}>
          {msgVirtualizer.getVirtualItems().map((vi) => {
            const item = msgItems[vi.index]
            if (!item) return null
            const posterId = posterItemLocalId(item)
            const posterHead = posterItemHead(item)
            const posterSelected = posterId > 0 && messagePoster.selectedIds.has(posterId)
            return (
              <div
                key={vi.key}
                data-index={vi.index}
                ref={msgVirtualizer.measureElement}
                className={cssrows.msgVRow}
                data-analysis-target={item.kind === 'msg' && selectedLocalId === item.m.localId || undefined}

                data-poster-selectable={messagePoster.active && posterId > 0 || undefined}
                data-poster-selected={messagePoster.active && posterSelected || undefined}
                data-poster-self={messagePoster.active && posterHead?.isSender === 1 || undefined}
                onClickCapture={messagePoster.active && posterId > 0
                  ? (event) => {
                      event.preventDefault()
                      event.stopPropagation()
                      messagePoster.toggle(posterId)
                    }
                  : undefined}
                onClick={!messagePoster.active && item.kind === 'msg' && isAnalyzableMessage(item.m)
                  ? () => { openMessageAnalysis(item.m) }
                  : undefined}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start - messageVirtualization.scrollMargin}px)` }}
              >
                {messagePoster.active && posterId > 0 && (
                  <span className={cssposter.selectMark} data-on={posterSelected || undefined} aria-hidden="true">
                    {posterSelected ? '✓' : ''}
                  </span>
                )}
                {renderMsgItem(item)}
              </div>
            )
          })}
        </div>
      )}
      {msgLoading && messages.length === 0 && <ListSkeleton rows={8} />}
      <div ref={msgEndRef} />
    </MsgScrollArea>
  )
}

export function ChatsView({ state, batchExport, messageTools, messagePoster, notice, indexProgress, onCancelIndexBuild, onCancelMsgSearch, onBackToList, aiReply, aiReplyFilter, messageFileSave, messageVirtualization }: ChatsViewProps): React.JSX.Element {
  const { calendar, edited, exportDialog, groupInfo, aiEligible, aiFull, aiOpen, aiTarget, analysisPaneOpen, analysisTarget, batchMode, buildIndex, changeView, chatlogOpen, chatlogResolving, chatlogStack, clearAllDrafts, clearDraft, contactInfoOpen, curSession,
  dismissMsgMenu, error, exportBatch, exportMsg, filtered, groupInfoOpen, hasMore, indexBuilding, jumpToLatest, loadMore, loading, memberLimit, messages, messagesMatchSession, moreOpen, msgEndRef, msgError, msgHits, msgIndexed, msgItems, msgLoading, msgMenu, msgScrollRef, msgSearchError, msgSearchLoading, msgSearched, msgVirtualizer, newMsgCount, normalList, onSearchInput, openCalendar, openEdits, openGroupInfo, openNestedChatlog, openSession, openSessionAndLocate, pinnedCollapsed, pinnedList, pollStatus, profileMember, profilePos, reloadCurrent, renderMsgItem, renderSession, runMenuAction, search, searchMode, selected, sessBeforeHeight, sessCount, sessSentinel, sessStart, sessTopSentinel, sessionListRef, sessionSearching, sessionsLoadMoreRef, sessionsPager, setAiFull, setAiOpen, setAnalysisPaneOpen, setAnalysisTarget, setBatchMode, setChatlogStack, setContactInfoOpen, setMoreOpen, setMsgMenu, setSearch, setSearchMode, setSelected, setViewer, stats, togglePinned, typeStats, view, viewer } = state
  // 右栏只有一块面板（「回复助手」）：打开即同时包含分析（这条消息怎么理解）与
  // 推荐回复（可以这样回）。群聊没有「回一句」的语义，面板里只渲染分析那一段。
  const chatRightMode = analysisPaneOpen ? 'assistant' as const : undefined
  // AI 问答/资料抽屉临时占位时右栏被顶替，但**不再锁**消息点击 ——
  // 合并后点消息就是切换分析对象，锁住反而让用户以为界面卡了。
  const chatRightPanelSuppressed = (aiOpen && aiEligible && aiTarget !== null) || groupInfoOpen || contactInfoOpen
  const posterSelectedItems = messagePoster.active
    ? posterItemsForSelection(msgItems, messagePoster.selectedIds)
    : []
  const posterSelectedCount = posterMessageCount(posterSelectedItems)
  const sidePanel = aiOpen && aiEligible && aiTarget ? 'ai' : groupInfoOpen ? 'group' : contactInfoOpen ? 'contact' : chatRightMode !== undefined ? 'chat' : undefined
  const { selectedLocalId, targetMessage, speaker, inlineAnalysis, openMessageAnalysis } = useChatsAnalysis({
    curSession, msgItems, analysisPaneOpen, analysisTarget,
    setAnalysisPaneOpen, setAnalysisTarget, setAiOpen, setAiFull,
    setContactInfoOpen, setGroupInfoOpen: groupInfo.setGroupInfoOpen,
  })
  // 图片预取：可见窗口上下若干行的图片提前低优先批量取回并写内存缓存，滚动时首帧命中、不闪占位。
  useImagePreload({ talker: curSession?.username ?? '', items: msgItems, virtualizer: msgVirtualizer })
  return (
    <div className={cssrows.panel} data-ai-full={(aiOpen && aiFull) || undefined} data-has-session={curSession !== null || undefined} data-side-panel={sidePanel}>
      <ChatsSessionPane state={state} batchExport={batchExport} indexProgress={indexProgress} onCancelIndexBuild={onCancelIndexBuild} onCancelMsgSearch={onCancelMsgSearch} aiReplyFilter={aiReplyFilter} />

      {/* right: message stream */}
      <div className={cssrows.messages} data-chat-messages="">
        {curSession === null && (
          <div className={csscards.msgEmptyState}>
            <div className={csscards.msgEmptyTitle}>从左侧选择一个会话</div>
            {filtered.length > 0 && (
              <button type="button" className={csscards.msgEmptyAction} onClick={() => { const first = filtered[0]; if (first !== undefined) void openSession(first) }}>
                查看最近会话
              </button>
            )}
          </div>
        )}
        {curSession !== null && (
          <>
            <div className={csscards.msgHeader}>
              <div className={cssshell.msgHeaderInfo}>
                <ChatSessionHeading session={curSession} />
                <div className={csscards.msgHeaderUser}>{curSession.username}</div>
                {(exportMsg || notice) && <div className={csscards.msgHeaderExport} role={notice && !exportMsg ? 'status' : undefined} title={exportMsg ?? undefined}>{exportMsg ?? notice}</div>}
              </div>
              {/* 轮询状态排在动作排前（2026-10-21 用户要求）：先看「✓ 时间 · N 条新消息」，再是 AI 问答 / 更多。 */}
              {pollStatus && <span className={`${csscards.msgHeaderExport} ${csscards.msgHeaderPoll}`} title={pollStatus}>{pollStatus}</span>}
              <ChatsHeadActions
                curSession={curSession} onBackToList={onBackToList}
                aiEligible={aiEligible}
                aiOpen={aiOpen}
                setAiOpen={setAiOpen} setAiFull={setAiFull}
                analysisPaneOpen={analysisPaneOpen}
                setAnalysisPaneOpen={setAnalysisPaneOpen}
                openCalendar={openCalendar}
                groupInfoOpen={groupInfoOpen}
                openGroupInfo={openGroupInfo}
                setGroupInfoOpen={groupInfo.setGroupInfoOpen}
                contactInfoOpen={contactInfoOpen}
                setContactInfoOpen={setContactInfoOpen}
                moreOpen={moreOpen}
                setMoreOpen={setMoreOpen}
                exporting={exportDialog.exportState.status === 'running'}
                editing={edited.editing}
                edits={edited.edits}
                setExportOpen={exportDialog.setExportOpen}
                openEdits={openEdits}
                clearAllDrafts={clearAllDrafts}
                clearDraft={clearDraft}
                aiReply={aiReply}
              />
            </div>
            {messageFileSave.state.status !== 'idle' && (
              <div className={csscards.msgFileSaveStatus}>
                <ExportProgressStatus
                  compact
                  state={messageFileSave.state}
                  onCancel={() => { void messageFileSave.cancel() }}
                />
              </div>
            )}
            {/*
              类型统计 chip 行此前在 .msgHeader 内，与标题行/动作行争宽 —— 实测头部因此在
              1664px 就有 94.6px 高、到 960px 涨到 195px 且 chip 被挤成三行竖排（审计 P1-9）。
              移出成独立条：头部回到单行，窄窗口下由容器查询整条收起。
            */}
            {typeStats.length > 0 && (
              <div className={csscards.msgTypeChips}>
                {typeStats.slice(0, 5).map(t => (
                  <span key={t.type} className={csscards.msgTypeChip} title={`${t.label}共 ${t.count} 条`}>{t.label} {t.count}</span>
                ))}
                {typeStats.length > 5 && (
                  <span className={csscards.msgTypeChip}>其他 +{typeStats.slice(5).reduce((a, s) => a + s.count, 0)}</span>
                )}
              </div>
            )}
            {messagePoster.active && (
              <ChatsPosterSelectionBar
                count={posterSelectedCount}
                busy={messagePoster.busy}
                onCancel={messagePoster.cancel}
                onGenerate={() => { void messagePoster.generate(msgItems) }}
              />
            )}
            <ChatsMessageStream
              messages={messages}
              messagesMatchSession={messagesMatchSession}
              hasMore={hasMore}
              msgLoading={msgLoading}
              msgError={msgError}
              msgItems={msgItems}
              msgVirtualizer={msgVirtualizer}
              messageVirtualization={messageVirtualization}
              msgScrollRef={msgScrollRef}
              msgEndRef={msgEndRef}
              newMsgCount={newMsgCount}
              jumpToLatest={jumpToLatest}
              loadMore={loadMore}
              reloadCurrent={reloadCurrent}
              selectedLocalId={selectedLocalId}

              messagePoster={messagePoster}
              renderMsgItem={renderMsgItem}
              openMessageAnalysis={openMessageAnalysis}
            />
            <ChatsPosterOverlay controller={messagePoster} session={curSession} renderItem={renderMsgItem} />
          </>
        )}
      </div>

      <ChatsGroupInfoView {...groupInfo} isGroup={curSession?.type === 'group'} open={groupInfoOpen} />

      {/* 单聊「聊天信息」抽屉（P2-6）：组件自带 private-only 守卫与数据获取。 */}
      <ChatsContactInfoView
        open={contactInfoOpen}
        session={curSession}
        onClose={() => { setContactInfoOpen(false) }}
        onExport={() => { setContactInfoOpen(false); exportDialog.setExportOpen(true) }}
      />

      {/* 导出消息弹窗：JSX 在 chats-export-dialog.tsx（同一屏的规则在那里逐条被用例钉住） */}
      <ChatsExportDialog {...exportDialog} />

      {/* 聊天记录查看器（嵌套、栈式）：JSX 在 chats-chatlog-dialog.tsx，一条记录怎么读成一行在 chats-chatlog.ts */}
      <ChatsChatlogView
        depth={chatlogStack.length} frame={chatlogOpen} resolving={chatlogResolving}
        onCloseAll={() => { setChatlogStack([]) }}
        onBack={() => { setChatlogStack(prev => prev.slice(0, -1)) }}
        openNestedChatlog={openNestedChatlog}
      />

      {/* 消息工具：源码/信息/普通编辑/源码编辑，均由 chats-message-tools 统一管理。 */}
      <ChatsMessageTools {...messageTools} />

      {/* 消息右键菜单（微信同款）：JSX 在 chats-msg-menu.tsx，「先关菜单再执行动作」那一判在那里被钉住 */}
      <ChatsMsgMenu
        msgMenu={msgMenu}
        items={msgMenu ? buildMsgMenu(msgMenu.m, msgMenu.kind) : []}
        onClose={() => { setMsgMenu(null) }}
        onDismiss={dismissMsgMenu}
        onPick={runMenuAction}
      />

      {/* 群成员资料浮层：JSX 在 chats-member-profile.tsx（「没有的字段整行不画」那一判在那里） */}
      <ChatsMemberProfile member={profileMember} pos={profilePos} />

      {/* 消息日历（A8）：JSX 在 chats-calendar-dialog.tsx，那一族的算术在 chats-calendar.ts */}
      <ChatsCalendarDialog {...calendar} />

      {/* 已编辑消息浮层：JSX 在 chats-edited-dialog.tsx（遮罩那一判在那里） */}
      <ChatsEditedDialog {...edited} />

      {/* 右栏 = 一个面板「回复助手」，里面**同时**有两段内容：
          · 上段「这条消息怎么理解」= 当前选中消息的研判（点消息即切换对象）；
          · 下段「可以这样回」= 候选回复（只有单聊有，群聊「回一句」不成立）；
          · 两段共用一个滚动区，不再各自开窗；
          · AI 问答打开时顶替整个右栏。 */}
      {curSession !== null && chatRightMode !== undefined && !(aiOpen && aiEligible && aiTarget) && !groupInfoOpen && !contactInfoOpen && (
        <ChatRightPanel
          target={curSession}
          onClose={() => { setAnalysisPaneOpen(false) }}
          allowSuggest={curSession.type === 'private'}
          analysisTargetId={selectedLocalId}
          analysisEntry={selectedLocalId === null ? undefined : inlineAnalysis.get(selectedLocalId)}
          analysisMessage={targetMessage}
          analysisSpeaker={speaker}
          analysisIsGroup={curSession.type === 'group'}
          analysisRefreshing={inlineAnalysis.refreshing}
          onRetryAnalysis={inlineAnalysis.retry}
          onRefreshAnalysis={inlineAnalysis.refresh}
        />
      )}

      {aiEligible && aiTarget && (
        <SessionAsk
          target={aiTarget}
          hidden={!aiOpen || groupInfoOpen || contactInfoOpen}
          onClose={() => { setAiOpen(false); setAiFull(false) }}
          onOpenMessage={(u, id) => { void openSessionAndLocate(u, id > 0 ? id : undefined) }}
          full={aiFull}
          onToggleFull={() => { setAiFull(v => !v) }}
        />
      )}

      {/* image lightbox */}
      {viewer && (
        <ImageViewer
          images={viewer.images}
          index={viewer.index}
          onClose={() =>{  setViewer(null) }}
          onIndexChange={(i) =>{  setViewer(v => (v ? { ...v, index: i } : v)) }}
        />
      )}
    </div>
  )
}
