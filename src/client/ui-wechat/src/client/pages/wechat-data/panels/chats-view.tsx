
/**
 * Chats 面板的那棵 JSX（M21 第三十三刀自 Chats.tsx 拆出）。
 *
 * 面板侧只剩 `const { … } = …`? 不 —— 面板仍然持有状态与副作用，这里只把**渲染**搬走：
 * 道具名与面板作用域里的名字完全相同 ⇒ JSX 逐行搬、面板侧一个对象字面量传进去。
 * 这样做的收益不是「少写几行」，而是：状态与老逻辑与渲染彻底分开之后，
 * 每一屏（日历、消息行、导出弹窗…）能单独搬出去配行为用例，搬的时候不必再动这棵树。
 */
import kitCss from '../ui/kit.module.css'
import { Dialog, SearchInput, Segmented } from '../ui/kit.tsx'
import { RemoteImg } from './remote-img.tsx'
import { ChatRightPanel } from './ChatRightPanel.tsx'
import { ChatsHeadActions } from './chats-head-actions.tsx'
import { SessionAsk } from './SessionAsk.tsx'
import { ImageViewer } from './chats-media.tsx'
import { Avatar, ChatView, IconPin, buildMsgMenu, isEnterpriseChat, openLink } from './chats-support.tsx'
import css from './chats.module.css'
import cssrows from './chats-rows.module.css'
import csscards from './chats-cards.module.css'
import cssshell from './chats-shell.module.css'
import { ListSentinel, ListSkeleton } from './hooks.tsx'
import { ChatsContactInfoView } from './chats-contact-info-view.tsx'
import { ChatsExportDialog } from './chats-export-dialog.tsx'
import { ChatsGroupInfoView } from './chats-group-info-view.tsx'
import type { ExpoType, ExpFormat } from './chats-export.tsx'
import { useInlineAnalysis } from './use-inline-analysis.ts'
import { useImagePreload } from './use-image-preload.ts'
import { RainWindow } from './rain-window.tsx'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { ChatlogRecord, EditedMessageRecord, GroupInfo, GroupMember, MessageRenderKind as RenderKind, SearchHit, WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import type { ViewerImage } from './chats-media.tsx'
import { usePagedList } from './hooks.tsx'
import type { MsgMenuItem } from './chats-support.tsx'
import type { MessageRenderItem } from '../utils/message-items.ts'

export interface ChatsViewProps {
  /** 面板作用域里那批状态/回调（收成一个对象：摊到调用点就是一百多行道具字面量）。 */
  state: {
      EXPO_FORMATS: ReadonlyArray<{ value: string; label: string }>
      EXPO_TYPES: ReadonlyArray<ExpoType>
      aiEligible: boolean
      analysisPaneOpen: boolean
      setAnalysisPaneOpen: React.Dispatch<React.SetStateAction<boolean>>
      analysisTarget: number | null
      setAnalysisTarget: React.Dispatch<React.SetStateAction<number | null>>
      aiFull: boolean
      aiOpen: boolean
      aiTarget: WechatSession | null
      annCanExpand: boolean
      annExpanded: boolean
      annRef: React.MutableRefObject<HTMLDivElement | null>
      batchExporting: boolean
      batchMode: boolean
      batchMsg: string | null
      buildIndex: (silent?: boolean) => Promise<void>
      calActiveDays: number
      calAvg: number
      calCounts: Record<string, number>
      calDays: number
      calFirstDow: number
      calHeat: (cnt: number) => string
      calLoading: boolean
      calMonth: number
      calOpen: boolean
      calTop: { day: number; count: number } | null
      calTotal: number
      calYear: number
      changeView: (next: ChatView) => void
      chatlogOpen: { title: string; records: ChatlogRecord[] } | null
      chatlogResolving: boolean
      chatlogStack: Array<{ title: string; records: ChatlogRecord[] }>
      chooseExportDir: () => Promise<void>
      clearAllDrafts: () => Promise<void>
      clearDraft: () => Promise<void>
      closeEdit: () => void
      curSession: WechatSession | null
      doReset: (rec: EditedMessageRecord) => Promise<void>
      editAreaRef: React.MutableRefObject<HTMLTextAreaElement | null>
      editBusy: boolean
      editErr: string | null
      editTarget: WechatMessage | null
      editText: string
      editedOpen: boolean
      editing: boolean
      edits: readonly EditedMessageRecord[]
      error: string | null
      expCount: number
      expDir: string
      expFilename: string
      expFormat: ExpFormat
      expFrom: string
      expTo: string
      expTypes: readonly string[]
      expZip: boolean
      cancelExport: () => void
      exportProgress: { phase: string; done: number; total: number } | null
      exportBatch: () => Promise<void>
      exportMsg: string | null
      exportOpen: boolean
      exportSession: () => Promise<void>
      exporting: boolean
      filtered: readonly WechatSession[]
      filteredMembers: GroupMember[]
      groupInfo: GroupInfo | null
      groupInfoErr: string | null
      groupInfoLoading: boolean
      groupInfoOpen: boolean
      groupInfoTitleId: string
      hasMore: boolean
      hideMemberProfile: () => void
      indexBuilding: boolean
      jumpToDay: (day: number) => void
      loadMore: () => Promise<void>
      loading: boolean
      memberExpanded: boolean
      memberLimit: number
      memberQuery: string
      memberSearch: string
      memberTotal: number
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
      pickingDir: boolean
      pinnedCollapsed: boolean
      pinnedList: readonly WechatSession[]
      pollStatus: string
      profileMember: GroupMember | null
      profilePos: { left: number; top: number } | null
      renderMsgItem: (item: MessageRenderItem) => React.JSX.Element | null
      renderSession: (s: WechatSession) => React.JSX.Element
      runMenuAction: (item: MsgMenuItem, m: WechatMessage) => void
      saveEdit: () => Promise<void>
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
      setAnnExpanded: React.Dispatch<React.SetStateAction<boolean>>
      setBatchMode: React.Dispatch<React.SetStateAction<boolean>>
      setCalOpen: React.Dispatch<React.SetStateAction<boolean>>
      setChatlogStack: React.Dispatch<React.SetStateAction<Array<{ title: string; records: ChatlogRecord[] }>>>
      setEditText: React.Dispatch<React.SetStateAction<string>>
      setEditedOpen: React.Dispatch<React.SetStateAction<boolean>>
      setExpCount: React.Dispatch<React.SetStateAction<number>>
      setExpFilename: React.Dispatch<React.SetStateAction<string>>
      setExpFormat: React.Dispatch<React.SetStateAction<ExpFormat>>
      setExpFrom: React.Dispatch<React.SetStateAction<string>>
      setExpTo: React.Dispatch<React.SetStateAction<string>>
      setExpTypes: React.Dispatch<React.SetStateAction<readonly string[]>>
      setExpZip: React.Dispatch<React.SetStateAction<boolean>>
      setExportOpen: React.Dispatch<React.SetStateAction<boolean>>
      setGroupInfoOpen: React.Dispatch<React.SetStateAction<boolean>>
      setMemberExpanded: React.Dispatch<React.SetStateAction<boolean>>
      setMemberSearch: React.Dispatch<React.SetStateAction<string>>
      setMoreOpen: React.Dispatch<React.SetStateAction<boolean>>
      setMsgMenu: React.Dispatch<React.SetStateAction<{ x: number; y: number; m: WechatMessage; kind: RenderKind } | null>>
      setProfileMember: React.Dispatch<React.SetStateAction<GroupMember | null>>
      setSearch: React.Dispatch<React.SetStateAction<string>>
      setSearchMode: React.Dispatch<React.SetStateAction<'session' | 'message'>>
      setSelected: React.Dispatch<React.SetStateAction<Set<string>>>
      setSuggestOpen: React.Dispatch<React.SetStateAction<boolean>>
      setViewer: React.Dispatch<React.SetStateAction<{ images: ViewerImage[]; index: number } | null>>
      showMemberProfile: (m: GroupMember, el: HTMLElement) => void
      shownMembers: GroupMember[]
      stats: { friends: number; groups: number; unread: number }
      suggestOpen: boolean
      switchCalMonth: (delta: number) => Promise<void>
      togglePinned: () => void
      typeStats: readonly { type: number; label: string; count: number }[]
      view: ChatView
      viewer: { images: ViewerImage[]; index: number } | null
  }
}

export function ChatsView({ state }: ChatsViewProps): React.JSX.Element {
  const { EXPO_FORMATS, EXPO_TYPES, aiEligible, aiFull, aiOpen, aiTarget, analysisPaneOpen, analysisTarget, annCanExpand, annExpanded, annRef, batchExporting, batchMode, batchMsg, buildIndex, cancelExport, calActiveDays, calAvg, calCounts, calDays, calFirstDow, calHeat, calLoading, calMonth, calOpen, calTop, calTotal, calYear, changeView, chatlogOpen, chatlogResolving, chatlogStack, chooseExportDir, clearAllDrafts, clearDraft, closeEdit, contactInfoOpen, curSession, doReset, editAreaRef, editBusy, editErr, editTarget, editText, editedOpen, editing, edits, error, expCount, expDir, expFilename, expFormat, expFrom, expTo, expTypes, expZip, exportBatch, exportMsg, exportOpen, exportProgress, exportSession, exporting, filtered, filteredMembers, groupInfo, groupInfoErr, groupInfoLoading, groupInfoOpen, groupInfoTitleId, hasMore, hideMemberProfile, indexBuilding, jumpToDay, loadMore, loading, memberExpanded, memberLimit, memberQuery, memberSearch, memberTotal, messages, messagesMatchSession, moreOpen, msgEndRef, msgError, msgHits, msgIndexed, msgItems, msgLoading, msgMenu, msgScrollRef, msgSearchError, msgSearchLoading, msgSearched, msgVirtualizer, normalList, onSearchInput, openCalendar, openEdits, openGroupInfo, openNestedChatlog, openSession, openSessionAndLocate, pickingDir, pinnedCollapsed, pinnedList, pollStatus, profileMember, profilePos, renderMsgItem, renderSession, runMenuAction, saveEdit, search, searchMode, selected, sessCount, sessSentinel, sessionListRef, sessionSearching, sessionsLoadMoreRef, sessionsPager, setAiFull, setAiOpen, setAnalysisPaneOpen, setAnalysisTarget, setAnnExpanded, setBatchMode, setCalOpen, setChatlogStack, setContactInfoOpen, setEditText, setEditedOpen, setExpCount, setExpFilename, setExpFormat, setExpFrom, setExpTo, setExpTypes, setExpZip, setExportOpen, setGroupInfoOpen, setMemberExpanded, setMemberSearch, setMoreOpen, setMsgMenu, setProfileMember, setSearch, setSearchMode, setSelected, setSuggestOpen, setViewer, showMemberProfile, shownMembers, stats, suggestOpen, switchCalMonth, togglePinned, typeStats, view, viewer } = state

  // 推荐回复只对单聊成立（群里「回一句」没有意义）；**分析**则群聊也能用 ——
  // 它读的是当前会话，群聊同样是会话。两块各自判定之后，右栏只要有任一块可见就挂载。
  const suggestVisible = suggestOpen && curSession !== null && curSession.type === 'private'
  // 逐条分析：只对**可见窗口**里的对方文本/语音消息按需推理（见 use-inline-analysis.ts）——
  // 「只算可见的」是产品决策：单次 0.5 s，全量预跑不现实。
  // 没有开关参数（2026-09-26 起恒开）：曾经那个工具区按钮与「右栏面板开不开」互不知情，
  // 关掉右栏后推理照跑 —— 现在分析的唯一去处就是右栏面板，它开着就算、不需要第二个旋钮。
  const inlineAnalysis = useInlineAnalysis({
    talker: curSession?.username ?? '', items: msgItems, virtualizer: msgVirtualizer,
  })
  // 图片预取：可见窗口上下若干行的图片**提前低优先批量取回**并写内存缓存，
  // 于是滚到它们时 `MessageImage` 首帧就命中缓存 —— 不闪占位（2026-09-26）。
  useImagePreload({ talker: curSession?.username ?? '', items: msgItems, virtualizer: msgVirtualizer })

  return (
    <div className={cssrows.panel} data-ai-full={(aiOpen && aiFull) || undefined}>
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
            </div>
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
            <div ref={sessionListRef} className={cssshell.list}>
              {loading && <ListSkeleton rows={10} />}
              {error && <div className={kitCss.error} role="alert">{error}</div>}
              {!loading && !error && filtered.length === 0 && <div className={kitCss.emptyInline}>{view === 'chats' ? '暂无会话' : '暂无' + (view === 'kefu' ? '客服会话' : '订阅会话')}</div>}
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
              {!loading && !error && !sessionSearching && sessionsPager.hasMore && <ListSentinel refFn={sessionsLoadMoreRef} />}
            </div>
          </>
        ) : (
          <div className={cssshell.list}>
            {!msgIndexed && (
              <div className={csscards.searchIndexHint}>
                <span>消息搜索索引尚未构建（当前为全表扫描）</span>
                <button type="button" className={csscards.loadMore} onClick={() => { void buildIndex() }} disabled={indexBuilding}>
                  {indexBuilding ? '构建中…' : '构建索引'}
                </button>
              </div>
            )}
            {msgSearchLoading && <div className={kitCss.emptyInline}>搜索中…</div>}
            {msgSearchError && <div className={kitCss.emptyInline}>{msgSearchError}</div>}
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
        <div className={cssshell.starWrap} data-hidden={curSession !== null || undefined}>
          <RainWindow className={cssshell.starfield} label="" active={curSession === null} />
        </div>
        {curSession === null && (
          <div className={csscards.msgEmptyState}>
            <div className={cssshell.msgEmptyIcon}>💬</div>
            <div className={csscards.msgEmptyTitle}>从左侧选择一个会话</div>
            <div className={cssshell.msgEmptyText}>点击会话即可查看聊天记录与文件，数据仅在本机只读预览。</div>
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
                <div className={csscards.msgHeaderUser}>{curSession.username}{messages.length > 0 ? ` · 共 ${messages.length} 条` : ''}</div>
                {exportMsg && <div className={csscards.msgHeaderExport} title={exportMsg}>{exportMsg}</div>}
              </div>
              <ChatsHeadActions
                curSession={curSession}
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
                exporting={exporting}
                editing={editing}
                edits={edits}
                setExportOpen={setExportOpen}
                openEdits={openEdits}
                clearAllDrafts={clearAllDrafts}
                clearDraft={clearDraft}
              />
              {pollStatus && <span className={csscards.msgHeaderExport} title={pollStatus}>{pollStatus}</span>}
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
            <div className={cssrows.msgBody} ref={msgScrollRef}>
              {/* 归属不符（正在切会话）时只显示骨架，绝不把上一个会话的消息画出来 */}
              {!messagesMatchSession && <ListSkeleton rows={8} />}
              {messagesMatchSession && hasMore && (
                <button type="button" className={csscards.loadMore} onClick={() => { void loadMore() }}>
                  {msgLoading ? '加载中…' : '加载更多'}
                </button>
              )}
              {messagesMatchSession && msgError && <div className={cssshell.msgErr}>{msgError}</div>}
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
            </div>
          </>
        )}
      </div>

      <ChatsGroupInfoView
        annCanExpand={annCanExpand} annExpanded={annExpanded} annRef={annRef} filteredMembers={filteredMembers}
        groupInfo={groupInfo} groupInfoErr={groupInfoErr} groupInfoLoading={groupInfoLoading}
        groupInfoTitleId={groupInfoTitleId} hideMemberProfile={hideMemberProfile}
        isGroup={curSession?.type === 'group'} memberExpanded={memberExpanded} memberQuery={memberQuery}
        memberSearch={memberSearch} memberTotal={memberTotal} open={groupInfoOpen}
        setAnnExpanded={setAnnExpanded} setGroupInfoOpen={setGroupInfoOpen} setMemberExpanded={setMemberExpanded}
        setMemberSearch={setMemberSearch} setProfileMember={setProfileMember} showMemberProfile={showMemberProfile}
        shownMembers={shownMembers}
      />

      {/* 单聊「聊天信息」抽屉（P2-6）：组件自带 private-only 守卫与数据获取。 */}
      <ChatsContactInfoView
        open={contactInfoOpen}
        session={curSession}
        onClose={() => { setContactInfoOpen(false) }}
        onExport={() => { setContactInfoOpen(false); setExportOpen(true) }}
      />

      {/* 导出消息弹窗：JSX 在 chats-export-dialog.tsx（同一屏的规则在那里逐条被用例钉住） */}
      <ChatsExportDialog
        EXPO_FORMATS={EXPO_FORMATS} EXPO_TYPES={EXPO_TYPES} cancelExport={cancelExport} chooseExportDir={chooseExportDir}
        expCount={expCount} expDir={expDir} expFilename={expFilename} expFormat={expFormat} expFrom={expFrom} expTo={expTo}
        expTypes={expTypes} expZip={expZip} exportOpen={exportOpen} exportProgress={exportProgress}
        exportSession={exportSession} exporting={exporting} pickingDir={pickingDir}
        setExpCount={setExpCount} setExpFilename={setExpFilename} setExpFormat={setExpFormat}
        setExpFrom={setExpFrom} setExpTo={setExpTo} setExpTypes={setExpTypes} setExpZip={setExpZip} setExportOpen={setExportOpen}
      />

      {/* merged chat log viewer (聊天记录, 支持嵌套) */}
      {chatlogOpen && (
        <div className={csscards.calOverlay} data-st-dialog="chats-chatlog" onClick={(e) => { if (e.target === e.currentTarget) setChatlogStack([]) }} role="dialog" aria-modal="true">
          <div className={csscards.chatlogDialog}>
            <div className={cssshell.calHeader}>
              <span className={csscards.calTitle}>{chatlogOpen.title}</span>
              <span className={cssshell.calHeaderActions}>
                {chatlogStack.length > 1 && (
                  <button type="button" className={csscards.calClose} title="返回上一级" onClick={() => { setChatlogStack(prev => prev.slice(0, -1)) }} aria-label="返回上一级">‹</button>
                )}
                <button type="button" className={csscards.calClose} title="关闭" aria-label="关闭" onClick={() => { setChatlogStack([]) }}><IconCloseOutline16 size={15} /></button>
              </span>
            </div>
            <div className={cssshell.chatlogBody}>
              {chatlogResolving && <div className={kitCss.emptyInline}>解析聊天记录…</div>}
              {chatlogOpen.records.length === 0 && !chatlogResolving && <div className={kitCss.emptyInline}>暂无内层消息</div>}
              {chatlogOpen.records.map((r, idx) => {
                const rt = r.renderType || (r.isImage ? 'image' : 'text')
                const nested = rt === 'chatHistory'
                const link = r.link || r.url || ''
                const nestedCount = (r.nested ?? []).length
                // head 来自聊天记录卡片 XML 的 <sourceheadurl>，是**未校验的原始地址**
                // （实测 360 条内层记录里 193 条是 http）。渲染层不许自己去要它 —— 交给
                // 后端代理（M23）：主机白名单 + 两个出网开关 + 操作记录 + 本机缓存都才成立。
                // 取不到（含 http 地址）就回退到首字母，与「本机没有这张头像」同一形状。
                const headFallback = <span>{(r.name || '?').slice(0, 1)}</span>
                return (
                  <div key={idx} className={cssshell.chatlogRow}>
                    <div className={csscards.chatlogAvatar}>
                      <RemoteImg src={r.head || ''} alt="" loading="lazy"
                        pending={headFallback} failed={headFallback} />
                    </div>
                    <div className={cssshell.chatlogMain}>
                      <div className={cssshell.chatlogTop}>
                        <span className={cssshell.chatlogName}>{r.name}</span>
                        <span className={cssshell.chatlogTime}>{r.time}</span>
                      </div>
                      {nested && (
                        <button type="button" className={csscards.chatlogNested} onClick={() => { void openNestedChatlog(r) }}>
                          <span>📋 {r.text || '聊天记录'}（{nestedCount > 0 ? String(nestedCount) + ' 条' : '点击查看'}）</span>
                        </button>
                      )}
                      {rt === 'link' && link ? (
                        <div className={cssshell.chatlogText}><a href={link} target="_blank" rel="noopener noreferrer"
                          onClick={(e) => { e.preventDefault(); openLink(link) }} className={csscards.msgTextLink}>{r.text || link}</a></div>
                      ) : rt === 'voice' ? (
                        <div className={cssshell.chatlogText}>🎤 {r.text || '[语音]'}{r.duration ? String(Math.round(Number(r.duration) / 20)) + '"' : ''}</div>
                      ) : rt === 'video' ? (
                        <div className={cssshell.chatlogText}>🎬 {r.text || '[视频]'}{r.duration ? String(Math.round(Number(r.duration) / 1000)) + 's' : ''}</div>
                      ) : rt === 'emoji' ? (
                        <div className={cssshell.chatlogText}>😀 {r.text || '[表情]'}</div>
                      ) : rt === 'image' ? (
                        <div className={cssshell.chatlogText}>🖼️ [图片]{r.datasize ? ' (' + r.datasize + ' 字节)' : ''}</div>
                      ) : (
                        <div className={cssshell.chatlogText}>{r.text || ''}</div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {/* 编辑消息副本：写入本地解密副本，原文在 message_edits.db 里留底，可用「恢复原文」回退 */}
      <Dialog
        open={editTarget !== null}
        onClose={() => { if (!editBusy) closeEdit() }}
        title="编辑消息副本"
        footer={(
          <div className={cssshell.editFoot}>
            <button type="button" className={csscards.exportBtn} disabled={editBusy} onClick={closeEdit}>取消</button>
            <button
              type="button"
              className={csscards.exportBtnPrimary}
              disabled={editBusy || editText.trim() === (editTarget?.displayText || editTarget?.strContent || '').trim()}
              onClick={() => { void saveEdit() }}
            >
              {editBusy ? '保存中…' : '保存'}
            </button>
          </div>
        )}
      >
        <p className={csscards.editHint}>
          只改动本地解密副本（微信原始数据库不动）。保存后这条消息会标上「已编辑」，
          随时可在「更多 → 已编辑消息」里恢复原文。
        </p>
        <textarea
          ref={editAreaRef}
          className={csscards.editArea}
          value={editText}
          onChange={(e) => { setEditText(e.target.value) }}
          aria-label="消息内容"
          spellCheck={false}
        />
        {editErr && <p className={cssshell.editErr} role="alert">保存失败：{editErr}</p>}
      </Dialog>

      {/* 消息右键菜单（微信同款）：点空白处 / Esc / 滚动都会关掉 */}
      {msgMenu && (
        <div className={csscards.msgCtxOverlay} onMouseDown={() => { setMsgMenu(null) }}>
          <div
            className={csscards.msgCtxMenu}
            style={{ left: msgMenu.x, top: msgMenu.y }}
            role="menu"
            onMouseDown={(e) => { e.stopPropagation() }}
          >
            {buildMsgMenu(msgMenu.m, msgMenu.kind).map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={csscards.msgCtxItem}
                onClick={() => { const m = msgMenu.m; setMsgMenu(null); runMenuAction(item, m) }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* member profile popover (群成员资料，悬浮于头像旁) */}
      {profileMember && profilePos && (
        <div className={csscards.memberProfilePop} style={{ left: profilePos.left, top: profilePos.top }}>
          <div className={cssshell.memberProfileBody}>
            <Avatar name={profileMember.name} username={profileMember.username} size={56} />
            <div className={cssshell.memberProfileName}>{profileMember.name}</div>
            <div className={csscards.memberProfileItem}>
              <span>微信号</span><span className={cssshell.memberProfileMono}>{profileMember.username}</span>
            </div>
            {profileMember.region && (
              <div className={csscards.memberProfileItem}>
                <span>地区</span><span className={cssshell.memberProfileMono}>{profileMember.region}</span>
              </div>
            )}
            {profileMember.signature && (
              <div className={csscards.memberProfileItem}>
                <span>签名</span><span className={cssshell.memberProfileMono}>{profileMember.signature}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* message calendar dialog (A8) */}
      {calOpen && (
        <div className={csscards.calOverlay} data-st-dialog="chats-cal" onClick={(e) => { if (e.target === e.currentTarget) setCalOpen(false) }} role="dialog" aria-modal="true">
          <div className={csscards.calDialog}>
            <div className={cssshell.calHeader}>
              <span className={csscards.calTitle}>消息日历</span>
              <button type="button" className={csscards.calClose} onClick={() =>{  setCalOpen(false) }}><IconCloseOutline16 size={15} /></button>
            </div>
            <div className={csscards.calBody}>
              <div className={cssshell.calNav}>
                <button type="button" className={csscards.loadMore} onClick={() => { void switchCalMonth(-1) }} aria-label="上一月">‹</button>
                <span className={csscards.calMonthTitle}>{calYear} 年 {calMonth} 月</span>
                <button type="button" className={csscards.loadMore} onClick={() => { void switchCalMonth(1) }} aria-label="下一月">›</button>
              </div>
              {calLoading ? (
                <div className={kitCss.emptyInline}>加载中…</div>
              ) : (
                <>
                  <div className={csscards.calStats}>
                    <span className={cssshell.calStat}>本月共 <b>{calTotal}</b> 条消息</span>
                    <span className={cssshell.calStat}>活跃 <b>{calActiveDays}</b> 天</span>
                    <span className={cssshell.calStat}>日均 <b>{calAvg}</b> 条</span>
                    {calTop && <span className={cssshell.calStat}>最活跃：{calMonth}月{calTop.day}日（{calTop.count} 条）</span>}
                  </div>
                  <div className={cssshell.calGrid}>
                    {['一', '二', '三', '四', '五', '六', '日'].map(wd => (
                      <div key={wd} className={cssshell.calWd}>{wd}</div>
                    ))}
                    {Array.from({ length: calFirstDow }).map((_, i) => <div key={`e${i}`} className={cssshell.calEmpty} />)}
                    {Array.from({ length: calDays }).map((_, i) => {
                      const day = i + 1
                      const cnt = calCounts[String(day)] ?? 0
                      return (
                        <button key={day} type="button" className={csscards.calDay} style={{ background: calHeat(cnt) }}
                          title={cnt ? `${calMonth}月${day}日：${cnt} 条消息` : `${calMonth}月${day}日：无消息`}
                          onClick={() =>{  jumpToDay(day) }}>
                          <span className={cssshell.calDayNum}>{day}</span>
                          {cnt > 0 && <span className={csscards.calDayCnt}>{cnt}</span>}
                        </button>
                      )
                    })}
                  </div>
                  <p className={cssshell.calHint}>点击日期跳转到当天消息（色块深浅表示消息量）</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* edited-messages popup */}
      {editedOpen && (
        <div className={csscards.calOverlay} data-st-dialog="chats-edited" onClick={() =>{  setEditedOpen(false) }} role="dialog" aria-modal="true">
          <div className={csscards.calDialog}>
            <div className={cssshell.calHeader}>
              <span className={csscards.calTitle}>本会话已编辑消息</span>
              <button type="button" className={csscards.calClose} onClick={() =>{  setEditedOpen(false) }} aria-label="关闭">×</button>
            </div>
            <div className={csscards.calBody}>
              {edits.length === 0 ? (
                <div className={kitCss.emptyInline}>暂无编辑记录（修改仅写入本地解密副本）</div>
              ) : (
                edits.map(rec => (
                  <div key={`${rec.sessionId}:${rec.localId}`} className={csscards.editRow}>
                    <span className={cssshell.editRowInfo}>
                      #{rec.localId} · 编辑 {rec.editCount} 次 · {new Date(rec.lastEditedAt).toLocaleString()}
                    </span>
                    <button type="button" className={csscards.loadMore} onClick={() => { void doReset(rec) }} disabled={editing}>恢复原文</button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

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
          onClearAnalysis={() => { setAnalysisTarget(null) }}
        />
      )}

      {aiOpen && aiEligible && aiTarget && (
        <SessionAsk
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
