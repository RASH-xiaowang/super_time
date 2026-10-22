
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
import { ListSentinel, ListSkeleton } from './hooks.tsx'
import { ChatsContactInfoView } from './chats-contact-info-view.tsx'
import { ChatsExportDialog, type ChatsExportDialogProps } from './chats-export-dialog.tsx'
import { ChatsGroupInfoView, type ChatsGroupInfoViewProps } from './chats-group-info-view.tsx'
import { ChatsChatlogView } from './chats-chatlog-dialog.tsx'
import { ChatsCalendarDialog, type ChatsCalendarDialogProps } from './chats-calendar-dialog.tsx'
import { ChatsEditedDialog, type ChatsEditedDialogProps } from './chats-edited-dialog.tsx'
import { ChatsMsgMenu } from './chats-msg-menu.tsx'
import { ChatsMessageTools, type ChatsMessageToolsController } from './chats-message-tools.tsx'
import { ChatsMemberProfile } from './chats-member-profile.tsx'
import type { ExpoType, ExpFormat } from './chats-export.tsx'
import { useInlineAnalysis } from './use-inline-analysis.ts'
import { useImagePreload } from './use-image-preload.ts'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { ChatlogRecord, EditedMessageRecord, GroupInfo, GroupMember, MessageRenderKind as RenderKind, SearchHit, WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import type { ViewerImage } from './chats-media.tsx'
import { usePagedList } from './hooks.tsx'
import { focusListRow } from './list-keyboard.ts'
import type { MsgMenuItem } from './chats-support.tsx'
import type { MessageRenderItem } from '../utils/message-items.ts'

export interface ChatsViewProps {
  /** Right-click tools (source/info/editors) live outside the state bag. */
  messageTools: ChatsMessageToolsController
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
  /**
   * 手机档（≤560）「返回会话列表」。**袋外独立 prop**，理由与上面两条相同：
   * `state` 袋的平铺字段卡在 96 件的棘轮上（`chats-state-bag.wiring.spec.ts`），
   * 一件都加不进去；而这一项只有一个消费方（头部那枚返回按钮），也不是任何一袋弹窗的道具。
   */
  onBackToList?: () => void
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
      analysisTarget: number | null
      setAnalysisTarget: React.Dispatch<React.SetStateAction<number | null>>
      aiFull: boolean
      aiOpen: boolean
      aiTarget: WechatSession | null
      batchExporting: boolean
      batchMode: boolean
      batchMsg: string | null
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
      pinnedCollapsed: boolean
      pinnedList: readonly WechatSession[]
      pollStatus: string
      profileMember: GroupMember | null
      profilePos: { left: number; top: number } | null
      renderMsgItem: (item: MessageRenderItem) => React.JSX.Element | null
      renderSession: (s: WechatSession) => React.JSX.Element
      runMenuAction: (item: MsgMenuItem, m: WechatMessage) => void
      search: string
      searchMode: 'session' | 'message'
      selected: Set<string>
      sessCount: number
      sessSentinel: (el: HTMLDivElement | null) => void
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
      setSuggestOpen: React.Dispatch<React.SetStateAction<boolean>>
      setViewer: React.Dispatch<React.SetStateAction<{ images: ViewerImage[]; index: number } | null>>
      stats: { friends: number; groups: number; unread: number }
      suggestOpen: boolean
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
function MsgScrollArea({ scrollRef, newMsgCount, onJump, children }: {
  scrollRef: React.MutableRefObject<HTMLDivElement | null>
  newMsgCount: number
  onJump: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className={cssnewmsg.msgWrap}>
      <div className={cssrows.msgBody} ref={scrollRef}>{children}</div>
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

/** 当前会话的逐条分析缓存（只读取可见窗口，见 use-inline-analysis.ts）。 */
function useChatsAnalysis(
  curSession: WechatSession | null,
  msgItems: MessageRenderItem[],
  virtualizer: Virtualizer<HTMLDivElement, Element>,
): ReturnType<typeof useInlineAnalysis> {
  return useInlineAnalysis({
    talker: curSession?.username ?? '',
    items: msgItems,
    virtualizer,
  })
}

export function ChatsView({ state, messageTools, notice, indexProgress, onCancelIndexBuild, onBackToList }: ChatsViewProps): React.JSX.Element {
  const { calendar, edited, exportDialog, groupInfo, aiEligible, aiFull, aiOpen, aiTarget, analysisPaneOpen, analysisTarget, batchExporting, batchMode, batchMsg, buildIndex, changeView, chatlogOpen, chatlogResolving, chatlogStack, clearAllDrafts, clearDraft, contactInfoOpen, curSession,
  error, exportBatch, exportMsg, filtered, groupInfoOpen, hasMore, indexBuilding, jumpToLatest, loadMore, loading, memberLimit, messages, messagesMatchSession, moreOpen, msgEndRef, msgError, msgHits, msgIndexed, msgItems, msgLoading, msgMenu, msgScrollRef, msgSearchError, msgSearchLoading, msgSearched, msgVirtualizer, newMsgCount, normalList, onSearchInput, openCalendar, openEdits, openGroupInfo, openNestedChatlog, openSession, openSessionAndLocate, pinnedCollapsed, pinnedList, pollStatus, profileMember, profilePos, renderMsgItem, renderSession, runMenuAction, search, searchMode, selected, sessCount, sessSentinel, sessionListRef, sessionSearching, sessionsLoadMoreRef, sessionsPager, setAiFull, setAiOpen, setAnalysisPaneOpen, setAnalysisTarget, setBatchMode, setChatlogStack, setContactInfoOpen, setMoreOpen, setMsgMenu, setSearch, setSearchMode, setSelected, setSuggestOpen, setViewer, stats, suggestOpen, togglePinned, typeStats, view, viewer } = state
  // 推荐回复只对单聊成立（群里「回一句」没有意义）；**分析**则群聊也能用 ——
  // 它读的是当前会话，群聊同样是会话。两块各自判定之后，右栏只要有任一块可见就挂载。
  const suggestVisible = suggestOpen && curSession !== null && curSession.type === 'private'
  // 逐条分析：只对**可见窗口**里的对方文本/语音消息按需推理（见 use-inline-analysis.ts）——
  // 「只算可见的」是产品决策：单次 0.5 s，全量预跑不现实。
  // 没有开关参数（2026-09-26 起恒开）：曾经那个工具区按钮与「右栏面板开不开」互不知情，
  // 关掉右栏后推理照跑 —— 现在分析的唯一去处就是右栏面板，它开着就算、不需要第二个旋钮。
  const inlineAnalysis = useChatsAnalysis(curSession, msgItems, msgVirtualizer)
  // 图片预取：可见窗口上下若干行的图片**提前低优先批量取回**并写内存缓存，
  // 于是滚到它们时 `MessageImage` 首帧就命中缓存 —— 不闪占位（2026-09-26）。
  useImagePreload({ talker: curSession?.username ?? '', items: msgItems, virtualizer: msgVirtualizer })
  return (
    <div className={cssrows.panel} data-ai-full={(aiOpen && aiFull) || undefined} data-has-session={curSession !== null || undefined}>
      {/* left: session list */}
      <div className={csscards.sidebar}>
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
            title="批量导出会话"
            onClick={() => { setBatchMode(v => !v); setSelected(new Set()) }}
          >{batchMode ? '退出批量' : '批量'}</button>
        </div>
        {searchMode === 'session' ? (
          <>
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
              <div className={csscards.stats}>
                {batchMode ? (
                  <>
                    <button type="button" className={csscards.batchBtn} onClick={() => { setSelected(new Set(filtered.map(x => x.username))) }}>全选</button>
                    <button type="button" className={csscards.batchBtn} onClick={() =>{  setSelected(new Set()) }}>清空</button>
                    <span className={cssshell.statUnread}>已选 {selected.size}</span>
                    <button type="button" className={csscards.batchBtn} onClick={() => { void exportBatch() }} disabled={batchExporting || selected.size === 0}>
                      {batchExporting ? '导出中…' : '导出所选'}
                    </button>
                    {batchMsg && <span className={cssshell.batchMsg}>{batchMsg}</span>}
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
            <div ref={sessionListRef} className={cssshell.list} onKeyDown={(event) => { focusListRow(event, sessionListRef.current, '[data-session-row]') }}>
              {loading && <ListSkeleton rows={10} />}
              {error && <div className={kitCss.error} role="alert">{error}</div>}
              {!loading && !error && filtered.length === 0 && <EmptyMaybeSyncing text={view === 'chats' ? '暂无会话' : '暂无' + (view === 'kefu' ? '客服会话' : '订阅会话')} />}
              {!loading && !error && pinnedList.length > 0 && (
                <div className={cssshell.pinSection}>
                  {!pinnedCollapsed && pinnedList.map(s => renderSession(s))}
                  <button type="button" className={csscards.pinToggle} onClick={togglePinned}>
                    <span className={css.pinMark}><IconPin /> 置顶（{pinnedList.length}）</span>
                    <span className={cssshell.pinArrow}>{pinnedCollapsed ? '▸' : '▾'}</span>
                  </button>
                </div>
              )}
              {!loading && !error && normalList.slice(0, sessCount).map(s => renderSession(s))}
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
                  // W3-11.5：秒级起步的构建不该只有一个禁用的「构建中…」——
                  // 说清跑到哪个分片、已入库多少条，并给一条退路。
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
            {msgSearchLoading && <LoadingState variant="compact" label="搜索中…" />}
            {msgSearchError && <ErrorState message={msgSearchError} />}
            {!msgSearchLoading && msgSearched && msgHits.length === 0 && !msgSearchError && <div className={kitCss.emptyInline}>未找到相关消息</div>}
            {!msgSearchLoading && msgHits.length > 0 && (
              <>
                <div className={cssshell.searchHitCount}>命中 {msgHits.length} 条 · 点击定位到原消息</div>
                {msgHits.map(hit => (
                  <button key={`${hit.username}:${hit.local_id}`} type="button" className={csscards.searchHit} onClick={() => { void openSessionAndLocate(hit.username, hit.local_id) }}>
                    <div className={cssshell.searchHitTop}>
                      <span className={cssshell.searchHitName}>{hit.name || hit.username}</span>
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

      {/* right: message stream */}
      <div className={cssrows.messages}>
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
                <div className={csscards.msgHeaderName}>
                  {curSession.displayName || curSession.username}
                  {isEnterpriseChat(curSession.username) && <span className={csscards.entBadge} title="企业微信">企业微信</span>}
                </div>
                <div className={csscards.msgHeaderUser}>{curSession.username}</div>
                {(exportMsg || notice) && <div className={csscards.msgHeaderExport} role={notice && !exportMsg ? 'status' : undefined} title={exportMsg ?? undefined}>{exportMsg ?? notice}</div>}
              </div>
              {/* 轮询状态排在动作排前（2026-10-21 用户要求）：先看「✓ 时间 · N 条新消息」，再是 AI 问答 / 更多。 */}
              {pollStatus && <span className={`${csscards.msgHeaderExport} ${csscards.msgHeaderPoll}`} title={pollStatus}>{pollStatus}</span>}
              <ChatsHeadActions
                curSession={curSession} onBackToList={onBackToList}
                aiEligible={aiEligible}
                aiOpen={aiOpen}
                setAiOpen={setAiOpen}
                suggestOpen={suggestOpen}
                setSuggestOpen={setSuggestOpen}
                analysisPaneOpen={analysisPaneOpen}
                setAnalysisPaneOpen={setAnalysisPaneOpen}
                openCalendar={openCalendar}
                groupInfoOpen={groupInfoOpen}
                openGroupInfo={openGroupInfo}
                contactInfoOpen={contactInfoOpen}
                setContactInfoOpen={setContactInfoOpen}
                moreOpen={moreOpen}
                setMoreOpen={setMoreOpen}
                exporting={exportDialog.exporting}
                editing={edited.editing}
                edits={edited.edits}
                setExportOpen={exportDialog.setExportOpen}
                openEdits={openEdits}
                clearAllDrafts={clearAllDrafts}
                clearDraft={clearDraft}
              />
            </div>
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
            <MsgScrollArea scrollRef={msgScrollRef} newMsgCount={newMsgCount} onJump={jumpToLatest}>
              {/* 归属不符（正在切会话）时只显示骨架，绝不把上一个会话的消息画出来 */}
              {!messagesMatchSession && <ListSkeleton rows={8} />}
              {messagesMatchSession && hasMore && (
                <button type="button" className={csscards.loadMore} onClick={() => { void loadMore() }}>
                  {msgLoading ? '加载中…' : '加载更多'}
                </button>
              )}
              {messagesMatchSession && msgError && <ErrorState message={msgError} />}
              {messagesMatchSession && (
                /*
                 * 虚拟化（N18）：外层按总高度撑开滚动条，行按各自偏移绝对定位。
                 * 只挂载视口附近（`overscan`）+ 动态测高（`measureElement`），
                 * 所以 DOM 节点数与已加载的历史长度**解耦**（实测 1 万条消息从 9,700 个节点降到几十个）。
                 * `id="msg-<localId>"` 仍在行上，深链与 `locateMessage` 照旧可用。
                 */
                <div style={{ height: msgVirtualizer.getTotalSize(), position: 'relative', flex: '0 0 auto' }}>
                  {msgVirtualizer.getVirtualItems().map((vi) => {
                    const item = msgItems[vi.index]
                    if (!item) return null
                    return (
                      <div
                        key={vi.key}
                        data-index={vi.index}
                        ref={msgVirtualizer.measureElement}
                        className={cssrows.msgVRow}
                        onClick={item.kind === 'msg' && item.m.isSender !== 1 ? () => { setAnalysisTarget(item.m.localId) } : undefined}
                        style={{ position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${vi.start}px)` }}
                      >
                        {renderMsgItem(item)}
                      </div>
                    )
                  })}
                </div>
              )}
              {msgLoading && messages.length === 0 && <ListSkeleton rows={8} />}
              <div ref={msgEndRef} />
            </MsgScrollArea>
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
        onPick={runMenuAction}
      />

      {/* 群成员资料浮层：JSX 在 chats-member-profile.tsx（「没有的字段整行不画」那一判在那里） */}
      <ChatsMemberProfile member={profileMember} pos={profilePos} />

      {/* 消息日历（A8）：JSX 在 chats-calendar-dialog.tsx，那一族的算术在 chats-calendar.ts */}
      <ChatsCalendarDialog {...calendar} />

      {/* 已编辑消息浮层：JSX 在 chats-edited-dialog.tsx（遮罩那一判在那里） */}
      <ChatsEditedDialog {...edited} />

      {/* 右栏（最右一栏）= 一块**合并面板**（`ChatRightPanel`），上下两块共用一个容器：
          · 上：推荐回复（单聊常驻，读取范围 = 当前会话 + 当前选中的知识库）；
          · 下：分析（消息流里**点选**的那条对方消息，与逐条推理共用一份落库缓存、不自己发请求）；
          · 「AI 问答」打开时**整个顶替**右栏 —— 两块并排会把 960px 窗口下的消息列挤到不可用，
            所以一个位置只放一个面板。
          群聊不给推荐回复（「回一句」在群里不成立）：此时整栏不挂，分析也随之不可见 ——
          分析读的是当前会话，单聊之外它也没有落脚点。 */}
      {curSession !== null && (suggestVisible || analysisPaneOpen) && !(aiOpen && aiEligible && aiTarget) && (
        <ChatRightPanel
          target={curSession}
          onClose={() => { setSuggestOpen(false); setAnalysisPaneOpen(false) }}
          showSuggest={suggestVisible}
          showAnalysis={analysisPaneOpen}
          analysisTargetId={analysisTarget}
          analysisEntry={analysisTarget === null ? undefined : inlineAnalysis.get(analysisTarget)}
          analysisProgress={inlineAnalysis.progress}
          analysisStopped={inlineAnalysis.stopped}
          analysisStopError={inlineAnalysis.stopError}
          onCancelAnalysis={inlineAnalysis.cancel}
          onRetryAnalysis={inlineAnalysis.retry}
          onClearAnalysis={() => { setAnalysisTarget(null) }}
        />
      )}

      {aiOpen && aiEligible && aiTarget && (
        <SessionAsk
          key={aiTarget.username}
          target={aiTarget}
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
