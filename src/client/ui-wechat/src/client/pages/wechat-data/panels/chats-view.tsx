
/**
 * Chats 面板的那棵 JSX（M21 第三十三刀自 Chats.tsx 拆出）。
 *
 * 面板侧只剩 `const { … } = …`? 不 —— 面板仍然持有状态与副作用，这里只把**渲染**搬走：
 * 道具名与面板作用域里的名字完全相同 ⇒ JSX 逐行搬、面板侧一个对象字面量传进去。
 * 这样做的收益不是「少写几行」，而是：面板剩 ~1600 行时，**状态与老逻辑与渲染彻底分开**，
 * 下一步把逻辑搬进钩子时不必再动这棵树。
 */
import kitCss from '../ui/kit.module.css'
import { DateRangeField, Dialog, ProgressBar, SearchInput, Segmented } from '../ui/kit.tsx'
import { cspSafeSrc } from '../utils/url.ts'
import { ReplySuggest } from './ReplySuggest.tsx'
import { SessionAsk } from './SessionAsk.tsx'
import { ImageViewer } from './chats-media.tsx'
import { Avatar, ChatView, IconCalendar, IconPin, buildMsgMenu, isEnterpriseChat, openLink } from './chats-support.tsx'
import css from './chats.module.css'
import { LazyMount, ListSentinel, ListSkeleton } from './hooks.tsx'
import { RainWindow } from './rain-window.tsx'
import { IconCloseOutline16, IconDownloadOutline16, IconEllipsisOutline16, IconListPenOutline16, IconSearchOutline16, IconTrashOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Virtualizer } from '@tanstack/react-virtual'
import type { ChatlogRecord, EditedMessageRecord, GroupInfo, GroupMember, MessageRenderKind as RenderKind, SearchHit, WechatMessage, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'
import type { ViewerImage } from './chats-media.tsx'
import { usePagedList } from './hooks.tsx'
import type { MsgMenuItem } from './chats-support.tsx'
import type { MessageRenderItem } from '../utils/message-items.ts'

export interface ChatsViewProps {
  /** 面板作用域里那批状态/回调（收成一个对象：调用点是 155 行道具字面量，太长）。 */
  state: {
      EXPO_FORMATS: ReadonlyArray<{ value: string; label: string }>
      EXPO_TYPES: ReadonlyArray<{ key: string; label: string; types?: readonly number[]; rich?: readonly string[] }>
      aiEligible: boolean
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
      expFormat: 'txt' | 'html' | 'md' | 'excel' | 'csv' | 'sql' | 'json'
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
      setExpFormat: React.Dispatch<React.SetStateAction<'txt' | 'html' | 'md' | 'excel' | 'csv' | 'sql' | 'json'>>
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
  const { EXPO_FORMATS, EXPO_TYPES, aiEligible, aiFull, aiOpen, aiTarget, annCanExpand, annExpanded, annRef, batchExporting, batchMode, batchMsg, buildIndex, cancelExport, calActiveDays, calAvg, calCounts, calDays, calFirstDow, calHeat, calLoading, calMonth, calOpen, calTop, calTotal, calYear, changeView, chatlogOpen, chatlogResolving, chatlogStack, chooseExportDir, clearAllDrafts, clearDraft, closeEdit, curSession, doReset, editAreaRef, editBusy, editErr, editTarget, editText, editedOpen, editing, edits, error, expCount, expDir, expFilename, expFormat, expFrom, expTo, expTypes, expZip, exportBatch, exportMsg, exportOpen, exportProgress, exportSession, exporting, filtered, filteredMembers, groupInfo, groupInfoErr, groupInfoLoading, groupInfoOpen, groupInfoTitleId, hasMore, hideMemberProfile, indexBuilding, jumpToDay, loadMore, loading, memberExpanded, memberLimit, memberQuery, memberSearch, memberTotal, messages, messagesMatchSession, moreOpen, msgEndRef, msgError, msgHits, msgIndexed, msgItems, msgLoading, msgMenu, msgScrollRef, msgSearchError, msgSearchLoading, msgSearched, msgVirtualizer, normalList, onSearchInput, openCalendar, openEdits, openGroupInfo, openNestedChatlog, openSession, openSessionAndLocate, pickingDir, pinnedCollapsed, pinnedList, pollStatus, profileMember, profilePos, renderMsgItem, renderSession, runMenuAction, saveEdit, search, searchMode, selected, sessCount, sessSentinel, sessionListRef, sessionSearching, sessionsLoadMoreRef, sessionsPager, setAiFull, setAiOpen, setAnnExpanded, setBatchMode, setCalOpen, setChatlogStack, setEditText, setEditedOpen, setExpCount, setExpFilename, setExpFormat, setExpFrom, setExpTo, setExpTypes, setExpZip, setExportOpen, setGroupInfoOpen, setMemberExpanded, setMemberSearch, setMoreOpen, setMsgMenu, setProfileMember, setSearch, setSearchMode, setSelected, setSuggestOpen, setViewer, showMemberProfile, shownMembers, stats, suggestOpen, switchCalMonth, togglePinned, typeStats, view, viewer } = state
  return (
    <div className={css.panel} data-ai-full={(aiOpen && aiFull) || undefined}>
      {/* left: session list */}
      <div className={css.sidebar}>
        <div className={css.search}>
          <SearchInput
            className={css.searchField}
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
            className={css.searchActionBtn}
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
            className={css.searchActionBtn}
            data-active={batchMode || undefined}
            title="批量导出会话"
            onClick={() => { setBatchMode(v => !v); setSelected(new Set()) }}
          >{batchMode ? '退出批量' : '批量'}</button>
        </div>
        {searchMode === 'session' ? (
          <>
            <div className={css.typeFilter}>
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
            <div className={css.stats}>
              {batchMode ? (
                <>
                  <button type="button" className={css.batchBtn} onClick={() => { setSelected(new Set(filtered.map(x => x.username))) }}>全选</button>
                  <button type="button" className={css.batchBtn} onClick={() =>{  setSelected(new Set()) }}>清空</button>
                  <span className={css.statUnread}>已选 {selected.size}</span>
                  <button type="button" className={css.batchBtn} onClick={() => { void exportBatch() }} disabled={batchExporting || selected.size === 0}>
                    {batchExporting ? '导出中…' : '导出所选'}
                  </button>
                  {batchMsg && <span className={css.batchMsg}>{batchMsg}</span>}
                </>
              ) : (
                <>
                  <span>好友 {stats.friends}</span>
                  <span>群聊 {stats.groups}</span>
                  {stats.unread > 0 && <span className={css.statUnread}>未读 {stats.unread}</span>}
                </>
              )}
            </div>
            <div ref={sessionListRef} className={css.list}>
              {loading && <ListSkeleton rows={10} />}
              {error && <div className={kitCss.error} role="alert">{error}</div>}
              {!loading && !error && filtered.length === 0 && <div className={kitCss.emptyInline}>{view === 'chats' ? '暂无会话' : '暂无' + (view === 'kefu' ? '客服会话' : '订阅会话')}</div>}
              {!loading && !error && pinnedList.length > 0 && (
                <div className={css.pinSection}>
                  {!pinnedCollapsed && pinnedList.map(s => renderSession(s))}
                  <button type="button" className={css.pinToggle} onClick={togglePinned}>
                    <span className={css.pinMark}><IconPin /> 置顶（{pinnedList.length}）</span>
                    <span className={css.pinArrow}>{pinnedCollapsed ? '▸' : '▾'}</span>
                  </button>
                </div>
              )}
              {!loading && !error && normalList.slice(0, sessCount).map(s => renderSession(s))}
              {!loading && !error && normalList.length > sessCount && <ListSentinel refFn={sessSentinel} />}
              {!loading && !error && !sessionSearching && sessionsPager.hasMore && <ListSentinel refFn={sessionsLoadMoreRef} />}
            </div>
          </>
        ) : (
          <div className={css.list}>
            {!msgIndexed && (
              <div className={css.searchIndexHint}>
                <span>消息搜索索引尚未构建（当前为全表扫描）</span>
                <button type="button" className={css.loadMore} onClick={() => { void buildIndex() }} disabled={indexBuilding}>
                  {indexBuilding ? '构建中…' : '构建索引'}
                </button>
              </div>
            )}
            {msgSearchLoading && <div className={kitCss.emptyInline}>搜索中…</div>}
            {msgSearchError && <div className={kitCss.emptyInline}>{msgSearchError}</div>}
            {!msgSearchLoading && msgSearched && msgHits.length === 0 && !msgSearchError && <div className={kitCss.emptyInline}>未找到相关消息</div>}
            {!msgSearchLoading && msgHits.length > 0 && (
              <>
                <div className={css.searchHitCount}>命中 {msgHits.length} 条 · 点击定位到原消息</div>
                {msgHits.map(hit => (
                  <button key={`${hit.username}:${hit.local_id}`} type="button" className={css.searchHit} onClick={() => { void openSessionAndLocate(hit.username, hit.local_id) }}>
                    <div className={css.searchHitTop}>
                      <span className={css.searchHitName}>{hit.name || hit.username}</span>
                      <span className={css.searchHitTime}>{hit.time}</span>
                    </div>
                    <div className={css.searchHitSnippet}>{hit.snippet}</div>
                  </button>
                ))}
              </>
            )}
            {!msgSearchLoading && !msgSearched && !msgSearchError && <div className={kitCss.emptyInline}>输入关键词搜索全部消息</div>}
          </div>
        )}
      </div>

      {/* right: message stream */}
      <div className={css.messages}>
        <div className={css.starWrap} data-hidden={curSession !== null || undefined}>
          <RainWindow className={css.starfield} label="" active={curSession === null} />
        </div>
        {curSession === null && (
          <div className={css.msgEmptyState}>
            <div className={css.msgEmptyIcon}>💬</div>
            <div className={css.msgEmptyTitle}>从左侧选择一个会话</div>
            <div className={css.msgEmptyText}>点击会话即可查看聊天记录与文件，数据仅在本机只读预览。</div>
            {filtered.length > 0 && (
              <button type="button" className={css.msgEmptyAction} onClick={() => { const first = filtered[0]; if (first !== undefined) void openSession(first) }}>
                查看最近会话
              </button>
            )}
          </div>
        )}
        {curSession !== null && (
          <>
            <div className={css.msgHeader}>
              <div className={css.msgHeaderInfo}>
                <div className={css.msgHeaderName}>
                  {curSession.displayName || curSession.username}
                  {isEnterpriseChat(curSession.username) && <span className={css.entBadge} title="企业微信">企业微信</span>}
                </div>
                <div className={css.msgHeaderUser}>{curSession.username}{messages.length > 0 ? ` · 共 ${messages.length} 条` : ''}</div>
                {exportMsg && <div className={css.msgHeaderExport} title={exportMsg}>{exportMsg}</div>}
              </div>
              <div className={css.msgHeaderActions}>
                {/* AI 问答入口：只对单聊/群聊出现（详见 aiEligible）。 */}
                {aiEligible && (
                  <button
                    type="button"
                    className={css.calBtn}
                    data-active={aiOpen || undefined}
                    aria-expanded={aiOpen}
                    title="AI 问答：基于本会话聊天记录提问，回答附原文出处"
                    onClick={() => { setAiOpen(v => !v); setSuggestOpen(false) }}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
                    </svg>
                    <span className={css.calBtnLabel}>AI 问答</span>
                  </button>
                )}
                {/* 推荐回复：只给单聊（群聊里「回一句」的语义不成立）。 */}
                {curSession.type === 'private' && (
                  <button
                    type="button"
                    className={css.calBtn}
                    data-active={suggestOpen || undefined}
                    aria-expanded={suggestOpen}
                    title="推荐回复：按这段对话（可结合当前知识库）生成 3 条候选回复"
                    onClick={() => { setSuggestOpen(v => !v); setAiOpen(false) }}
                  >
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M9 17H7a4 4 0 0 1 0-8h10a4 4 0 0 1 0 8h-2" /><path d="m12 12 3 3-3 3" />
                    </svg>
                    <span className={css.calBtnLabel}>推荐回复</span>
                  </button>
                )}
                <button type="button" className={css.calBtn} title="消息日历（每日消息数热力图）" onClick={() => { void openCalendar() }}><IconCalendar /> <span className={css.calBtnLabel}>日历</span></button>
                {curSession.type === 'group' && (
                  <button type="button" className={css.calBtn} data-active={groupInfoOpen || undefined} title="群聊信息" onClick={openGroupInfo}><IconUserOutline16 size={14} /><span className={css.calBtnLabel}>群信息</span></button>
                )}
                {/*
                  低频动作（导出/已编辑/清空草稿）收进溢出菜单：此前它们与上面三个按钮平铺，
                  动作区内容宽 468px 且 flex-shrink:0，窗口一窄就被消息区裁掉 ——
                  1152px 丢 1 个、1024px 丢 3 个、960px 连「群信息」都点不到（审计 P0-2）。
                */}
                <div className={css.msgHeaderMoreWrap} data-st-menu="msg-header-more">
                  <button
                    type="button"
                    className={css.calBtn}
                    title="更多操作"
                    aria-haspopup="menu"
                    aria-expanded={moreOpen || undefined}
                    data-active={moreOpen || undefined}
                    onClick={() => { setMoreOpen(v => !v) }}
                  >
                    <IconEllipsisOutline16 size={14} /><span className={css.calBtnLabel}>更多</span>
                  </button>
                  {moreOpen && (
                    <div className={css.msgHeaderMoreMenu} role="menu" aria-label="更多操作">
                      <button type="button" role="menuitem" className={css.msgHeaderMoreItem} disabled={exporting}
                        onClick={() => { setMoreOpen(false); setExportOpen(true) }}>
                        <IconDownloadOutline16 size={14} />导出消息
                      </button>
                      <button type="button" role="menuitem" className={css.msgHeaderMoreItem} disabled={editing}
                        onClick={() => { setMoreOpen(false); void openEdits() }}>
                        <IconListPenOutline16 size={14} />已编辑消息{edits.length > 0 ? ` (${String(edits.length)})` : ''}
                      </button>
                      <button type="button" role="menuitem" className={css.msgHeaderMoreItem}
                        onClick={() => { setMoreOpen(false); void clearAllDrafts() }}>
                        <IconTrashOutline16 size={14} />清空所有会话草稿
                      </button>
                      {curSession.draft && (
                        <button type="button" role="menuitem" className={css.msgHeaderMoreItem}
                          onClick={() => { setMoreOpen(false); void clearDraft() }}>
                          <IconTrashOutline16 size={14} />清空本会话草稿
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {pollStatus && <span className={css.msgHeaderExport} title={pollStatus}>{pollStatus}</span>}
            </div>
            {/*
              类型统计 chip 行此前在 .msgHeader 内，与标题行/动作行争宽 —— 实测头部因此在
              1664px 就有 94.6px 高、到 960px 涨到 195px 且 chip 被挤成三行竖排（审计 P1-9）。
              移出成独立条：头部回到单行，窄窗口下由容器查询整条收起。
            */}
            {typeStats.length > 0 && (
              <div className={css.msgTypeChips}>
                {typeStats.slice(0, 5).map(t => (
                  <span key={t.type} className={css.msgTypeChip} title={`${t.label}共 ${t.count} 条`}>{t.label} {t.count}</span>
                ))}
                {typeStats.length > 5 && (
                  <span className={css.msgTypeChip}>其他 +{typeStats.slice(5).reduce((a, s) => a + s.count, 0)}</span>
                )}
              </div>
            )}
            <div className={css.msgBody} ref={msgScrollRef}>
              {/* 归属不符（正在切会话）时只显示骨架，绝不把上一个会话的消息画出来 */}
              {!messagesMatchSession && <ListSkeleton rows={8} />}
              {messagesMatchSession && hasMore && (
                <button type="button" className={css.loadMore} onClick={() => { void loadMore() }}>
                  {msgLoading ? '加载中…' : '加载更多'}
                </button>
              )}
              {messagesMatchSession && msgError && <div className={css.msgErr}>{msgError}</div>}
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

      {groupInfoOpen && curSession?.type === 'group' && (
        <div
          className={css.groupInfo}
          role="dialog"
          aria-modal="true"
          aria-labelledby={groupInfoTitleId}
          data-st-dialog="chats-groupinfo"
        >
          <div className={css.groupInfoHeader}>
            <span className={css.groupInfoTitle} id={groupInfoTitleId}>群聊信息</span>
            <button type="button" className={css.groupInfoClose} title="关闭" aria-label="关闭" onClick={() => { setGroupInfoOpen(false); setProfileMember(null) }}><IconCloseOutline16 size={15} /></button>
          </div>
          <div className={css.groupInfoBody}>
            {groupInfoLoading && <div className={kitCss.emptyInline}>加载中…</div>}
            {groupInfoErr && <div className={kitCss.emptyInline}>{groupInfoErr}</div>}
            {!groupInfoLoading && groupInfo && (
              <>
                <div className={css.memberSearchBox}>
                  <div className={css.searchIcon}><IconSearchOutline16 size={13} /></div>
                  <input
                    type="text"
                    placeholder="搜索群成员"
                    value={memberSearch}
                    onChange={(e) => { setMemberSearch(e.target.value) }}
                  />
                </div>
                {memberQuery && filteredMembers.length === 0 ? (
                  /* 搜索无结果必须给空态：此前网格直接渲染成 0 高度，界面只剩一片空白（审计 P0-3） */
                  <div className={css.memberEmpty}>
                    <div className={css.memberEmptyIcon}><IconSearchOutline16 size={22} /></div>
                    <div className={css.memberEmptyTitle}>未找到相关成员</div>
                    <div className={css.memberEmptyDesc}>
                      群里共 {memberTotal} 位成员，试试昵称或微信号的其它片段
                    </div>
                    <button type="button" className={css.memberEmptyClear} onClick={() => { setMemberSearch('') }}>
                      清空搜索
                    </button>
                  </div>
                ) : (
                  <div className={css.memberGrid}>
                    {shownMembers.map(m => (
                      <button
                        type="button"
                        key={m.username}
                        className={css.memberTile}
                        title={m.name}
                        onMouseEnter={(e) => { showMemberProfile(m, e.currentTarget) }}
                        onMouseLeave={hideMemberProfile}
                      >
                        {/* 与会话列表同一套懒挂载：展开到 200 人时不再一次性发起 200 个头像请求（审计 P2-4） */}
                        <LazyMount placeholder={<span className={css.avatarStub} style={{ width: 40, height: 40 }} />} rootMargin="300px 0px">
                          <Avatar name={m.name} username={m.username} size={40} />
                        </LazyMount>
                        <span className={css.memberName}>{m.name}</span>
                      </button>
                    ))}
                    {/*
                      故意的死控件（L13）：微信「聊天信息」页的成员网格末尾就是这个「＋ 添加」方块，
                      而本应用只**读**本机聊天库，没有可用的邀请/入群通道（往群里加人要么走微信协议、
                      要么直接改对方数据库，两者都不该做）。保留它的理由是布局保真 —— 去掉会让
                      成员网格与官方形态不一致（视觉审计 P1-8 行结构）。
                      因此它刻意不可交互：不是 <button>（键盘/焦点不进来）、不挂 onClick、
                      aria-disabled + title 说明原因，并且不给任何 hover 反馈让外观也不像可点
                      （见 chats.module.css 的 `.memberTile[data-disabled='true']` 规则）。
                      若将来真要做邀请，这里应换成打开确认对话框的按钮，而不是给它挂 onClick。
                    */}
                    {!memberQuery && (
                      <div className={css.memberTile} data-disabled="true" title="暂不支持邀请" aria-disabled="true">
                        <div className={css.memberAdd}><span>＋</span></div>
                        <span className={css.memberName}>添加</span>
                      </div>
                    )}
                  </div>
                )}
                {/* 有查询词时不再用「256 人」这个与过滤结果无关的数字（审计 P1-4） */}
                {memberQuery ? (
                  filteredMembers.length > memberLimit && (
                    <button type="button" className={css.memberMore} onClick={() => { setMemberExpanded(v => !v) }}>
                      {memberExpanded ? '收起' : `展开更多匹配（共 ${filteredMembers.length} 位）`}
                    </button>
                  )
                ) : memberTotal > 24 && (
                  <button type="button" className={css.memberMore} onClick={() => { setMemberExpanded(v => !v) }}>
                    {memberExpanded ? '收起' : `查看更多（${memberTotal} 人）`}
                  </button>
                )}
                {/* 微信的聊天信息是「标签左 / 值右」的列表行，不是「标签上 / 值下」的块（审计 P1-8 行结构） */}
                <div className={css.groupInfoRows}>
                  <div className={css.groupInfoRow}>
                    <span className={css.groupInfoRowLabel}>群聊名称</span>
                    <span className={css.groupInfoRowValue}>{groupInfo.name}</span>
                  </div>
                  {groupInfo.announcement && (
                    <div className={css.groupInfoRowStack}>
                      <span className={css.groupInfoRowLabel}>群公告</span>
                      <div ref={annRef} className={css.groupInfoAnn} data-clamp={!annExpanded || undefined}>
                        {groupInfo.announcement}
                      </div>
                      {annCanExpand && (
                        <button type="button" className={css.groupInfoAnnToggle} onClick={() => { setAnnExpanded(v => !v) }}>
                          {annExpanded ? '收起' : '展开'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* message export dialog (格式/类型/时间范围/文件名/目录) */}
      {exportOpen && (
        <div className={css.calOverlay} data-st-dialog="chats-export" onClick={(e) => { if (e.target === e.currentTarget) setExportOpen(false) }} role="dialog" aria-modal="true">
          <div className={css.exportDialog}>
            <div className={css.calHeader}>
              <span className={css.calTitle}>导出消息</span>
              <button type="button" className={css.calClose} onClick={() => { setExportOpen(false) }}><IconCloseOutline16 size={15} /></button>
            </div>
            <div className={css.exportBody}>
              <div className={css.exportSection}>
                <div className={css.exportSectionHead}>
                  <span className={css.exportSectionTitle}>格式与内容</span>
                  <span className={css.exportCountBadge}>{expTypes.length === 0 ? '全部消息' : `${expTypes.length} 类消息`}</span>
                </div>
                <div className={css.exportField}>
                  <span className={kitCss.textMeta}>文件格式</span>
                  <div className={css.exportFormatGrid}>
                    {EXPO_FORMATS.map(f => (
                      <button key={f.value} type="button" className={css.exportFormatCard}
                        data-active={expFormat === f.value || undefined}
                        onClick={() => { setExpFormat(f.value as typeof expFormat) }}>
                        <span>{f.label}</span>
                        <i className={css.exportRadio} data-active={expFormat === f.value || undefined} />
                      </button>
                    ))}
                  </div>
                </div>
                <div className={css.exportField}>
                  <span className={kitCss.textMeta}>导出条数</span>
                  <div className={css.exportChips}>
                    {[10, 50, 100, 0].map(n => (
                      <button key={String(n)} type="button" className={css.exportChip} data-active={(expCount === n) || undefined}
                        onClick={() => { setExpCount(n) }}>{n === 0 ? '全部' : String(n) + ' 条'}</button>
                    ))}
                  </div>
                </div>
                <div className={css.exportField}>
                  <div className={css.exportLabelRow}>
                    <span className={kitCss.textMeta}>消息类型</span>
                    <button type="button" className={css.exportLinkBtn}
                      onClick={() => { setExpTypes(prev => prev.length > 0 ? [] : EXPO_TYPES.map(c => c.key)) }}>
                      {expTypes.length > 0 ? '取消全选' : '全选'}
                    </button>
                  </div>
                  <div className={css.exportChips}>
                    {EXPO_TYPES.map(c => (
                      <button key={c.key} type="button" className={css.exportChipCheck}
                        data-active={expTypes.includes(c.key) || undefined}
                        onClick={() => { setExpTypes(prev => prev.includes(c.key) ? prev.filter(k => k !== c.key) : [...prev, c.key]) }}>
                        <i className={css.exportCheck} data-active={expTypes.includes(c.key) || undefined}>{expTypes.includes(c.key) ? '✓' : ''}</i>
                        {c.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className={css.exportSection}>
                <div className={css.exportSectionHead}>
                  <span className={css.exportSectionTitle}>时间范围</span>
                  <button type="button" className={css.exportLinkBtn} onClick={() => { setExpFrom(''); setExpTo('') }}>全部时间</button>
                </div>
                <div className={css.exportRangeRow}>
                  <DateRangeField
                    from={expFrom}
                    to={expTo}
                    onFrom={setExpFrom}
                    onTo={setExpTo}
                    presets={['today', 'week', 'month', 'last-7', 'last-30']}
                    ariaLabel="导出时间范围"
                  />
                </div>
              </div>
              <div className={css.exportSection}>
                <div className={css.exportSectionHead}>
                  <span className={css.exportSectionTitle}>导出文件名</span>
                  <span className={css.exportHint}>可选，留空时自动生成</span>
                </div>
                <input type="text" className={css.exportInput} placeholder="例如：微信聊天记录_2026-07-11"
                  value={expFilename} onChange={(e) => { setExpFilename(e.target.value) }} />
                <label className={css.exportCheckbox}>
                  <input type="checkbox" checked={expZip} onChange={(e) => { setExpZip(e.target.checked) }} />
                  打包为 ZIP（含导出文件与 record_media.json）
                </label>
              </div>
              <div className={css.exportSection}>
                <div className={css.exportSectionHead}>
                  <span className={css.exportSectionTitle}>保存目录</span>
                </div>
                <div className={css.exportDirBox} data-chosen={(!!expDir.trim()) || undefined}>
                  <span className={css.exportDirIcon}>📁</span>
                  <div className={css.exportDirInfo}>
                    <span className={css.exportDirTitle}>{expDir.trim() ? '已选择保存目录' : '尚未选择保存目录'}</span>
                    <span className={kitCss.textCaptionTrunc}>{expDir.trim() ? expDir.trim() : '留空时导出到默认目录 ~/.dsh/wechat-data/exports'}</span>
                  </div>
                  <button type="button" className={css.exportBtn} onClick={() => { void chooseExportDir() }} disabled={pickingDir}>
                    {'＋ ' + (pickingDir ? '选择中…' : '选择目录')}
                  </button>
                </div>
              </div>
              {/* 实时进度（M3）：后端按 jobId 推 `wechat-export/progress`，
                  没有这一段时用户只有一个「导出中…」的按钮可以看，取消也无从下手。 */}
              {exportProgress ? (
                <div className={css.exportField}>
                  <ProgressBar value={exportProgress.total > 0 ? Math.min(100, (exportProgress.done / exportProgress.total) * 100) : 0} />
                  <span className={kitCss.textCaptionTrunc}>
                    {(exportProgress.phase || '导出中') + ' · ' + exportProgress.done + (exportProgress.total ? ' / ' + exportProgress.total : '')}
                  </span>
                </div>
              ) : null}
              <div className={css.exportActions}>
                <button type="button" className={css.exportBtnGhost} onClick={() => { setExportOpen(false) }}>取消</button>
                {exporting ? (
                  <button type="button" className={css.exportBtnGhost} onClick={cancelExport}>中止导出</button>
                ) : null}
                <button type="button" className={css.exportBtnPrimary} onClick={() => { void exportSession() }} disabled={exporting}>
                  {exporting ? '导出中…' : '导出'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* merged chat log viewer (聊天记录, 支持嵌套) */}
      {chatlogOpen && (
        <div className={css.calOverlay} data-st-dialog="chats-chatlog" onClick={(e) => { if (e.target === e.currentTarget) setChatlogStack([]) }} role="dialog" aria-modal="true">
          <div className={css.chatlogDialog}>
            <div className={css.calHeader}>
              <span className={css.calTitle}>{chatlogOpen.title}</span>
              <span className={css.calHeaderActions}>
                {chatlogStack.length > 1 && (
                  <button type="button" className={css.calClose} title="返回上一级" onClick={() => { setChatlogStack(prev => prev.slice(0, -1)) }} aria-label="返回上一级">‹</button>
                )}
                <button type="button" className={css.calClose} title="关闭" aria-label="关闭" onClick={() => { setChatlogStack([]) }}><IconCloseOutline16 size={15} /></button>
              </span>
            </div>
            <div className={css.chatlogBody}>
              {chatlogResolving && <div className={kitCss.emptyInline}>解析聊天记录…</div>}
              {chatlogOpen.records.length === 0 && !chatlogResolving && <div className={kitCss.emptyInline}>暂无内层消息</div>}
              {chatlogOpen.records.map((r, idx) => {
                const rt = r.renderType || (r.isImage ? 'image' : 'text')
                const nested = rt === 'chatHistory'
                const link = r.link || r.url || ''
                const nestedCount = (r.nested ?? []).length
                // head 来自聊天记录卡片 XML 的 <sourceheadurl>，是**未校验的原始地址**。
                // 实测 360 条内层记录里 193 条是 http，直接当 src 会被 CSP 拦（并写下违规日志）。
                // 过滤后为空则回退到首字母头像（下面的分支本来就是这么设计的）。
                const head = cspSafeSrc(r.head)
                return (
                  <div key={idx} className={css.chatlogRow}>
                    <div className={css.chatlogAvatar}>
                      {head ? (
                        <img src={head} alt="" referrerPolicy="no-referrer" loading="lazy"
                          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }} />
                      ) : (
                        <span>{(r.name || '?').slice(0, 1)}</span>
                      )}
                    </div>
                    <div className={css.chatlogMain}>
                      <div className={css.chatlogTop}>
                        <span className={css.chatlogName}>{r.name}</span>
                        <span className={css.chatlogTime}>{r.time}</span>
                      </div>
                      {nested && (
                        <button type="button" className={css.chatlogNested} onClick={() => { void openNestedChatlog(r) }}>
                          <span>📋 {r.text || '聊天记录'}（{nestedCount > 0 ? String(nestedCount) + ' 条' : '点击查看'}）</span>
                        </button>
                      )}
                      {rt === 'link' && link ? (
                        <div className={css.chatlogText}><a href={link} target="_blank" rel="noopener noreferrer"
                          onClick={(e) => { e.preventDefault(); openLink(link) }} className={css.msgTextLink}>{r.text || link}</a></div>
                      ) : rt === 'voice' ? (
                        <div className={css.chatlogText}>🎤 {r.text || '[语音]'}{r.duration ? String(Math.round(Number(r.duration) / 20)) + '"' : ''}</div>
                      ) : rt === 'video' ? (
                        <div className={css.chatlogText}>🎬 {r.text || '[视频]'}{r.duration ? String(Math.round(Number(r.duration) / 1000)) + 's' : ''}</div>
                      ) : rt === 'emoji' ? (
                        <div className={css.chatlogText}>😀 {r.text || '[表情]'}</div>
                      ) : rt === 'image' ? (
                        <div className={css.chatlogText}>🖼️ [图片]{r.datasize ? ' (' + r.datasize + ' 字节)' : ''}</div>
                      ) : (
                        <div className={css.chatlogText}>{r.text || ''}</div>
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
          <div className={css.editFoot}>
            <button type="button" className={css.exportBtn} disabled={editBusy} onClick={closeEdit}>取消</button>
            <button
              type="button"
              className={css.exportBtnPrimary}
              disabled={editBusy || editText.trim() === (editTarget?.displayText || editTarget?.strContent || '').trim()}
              onClick={() => { void saveEdit() }}
            >
              {editBusy ? '保存中…' : '保存'}
            </button>
          </div>
        )}
      >
        <p className={css.editHint}>
          只改动本地解密副本（微信原始数据库不动）。保存后这条消息会标上「已编辑」，
          随时可在「更多 → 已编辑消息」里恢复原文。
        </p>
        <textarea
          ref={editAreaRef}
          className={css.editArea}
          value={editText}
          onChange={(e) => { setEditText(e.target.value) }}
          aria-label="消息内容"
          spellCheck={false}
        />
        {editErr && <p className={css.editErr} role="alert">保存失败：{editErr}</p>}
      </Dialog>

      {/* 消息右键菜单（微信同款）：点空白处 / Esc / 滚动都会关掉 */}
      {msgMenu && (
        <div className={css.msgCtxOverlay} onMouseDown={() => { setMsgMenu(null) }}>
          <div
            className={css.msgCtxMenu}
            style={{ left: msgMenu.x, top: msgMenu.y }}
            role="menu"
            onMouseDown={(e) => { e.stopPropagation() }}
          >
            {buildMsgMenu(msgMenu.m, msgMenu.kind).map((item) => (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                className={css.msgCtxItem}
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
        <div className={css.memberProfilePop} style={{ left: profilePos.left, top: profilePos.top }}>
          <div className={css.memberProfileBody}>
            <Avatar name={profileMember.name} username={profileMember.username} size={56} />
            <div className={css.memberProfileName}>{profileMember.name}</div>
            <div className={css.memberProfileItem}>
              <span>微信号</span><span className={css.memberProfileMono}>{profileMember.username}</span>
            </div>
            {profileMember.region && (
              <div className={css.memberProfileItem}>
                <span>地区</span><span className={css.memberProfileMono}>{profileMember.region}</span>
              </div>
            )}
            {profileMember.signature && (
              <div className={css.memberProfileItem}>
                <span>签名</span><span className={css.memberProfileMono}>{profileMember.signature}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* message calendar dialog (A8) */}
      {calOpen && (
        <div className={css.calOverlay} data-st-dialog="chats-cal" onClick={(e) => { if (e.target === e.currentTarget) setCalOpen(false) }} role="dialog" aria-modal="true">
          <div className={css.calDialog}>
            <div className={css.calHeader}>
              <span className={css.calTitle}>消息日历</span>
              <button type="button" className={css.calClose} onClick={() =>{  setCalOpen(false) }}><IconCloseOutline16 size={15} /></button>
            </div>
            <div className={css.calBody}>
              <div className={css.calNav}>
                <button type="button" className={css.loadMore} onClick={() => { void switchCalMonth(-1) }} aria-label="上一月">‹</button>
                <span className={css.calMonthTitle}>{calYear} 年 {calMonth} 月</span>
                <button type="button" className={css.loadMore} onClick={() => { void switchCalMonth(1) }} aria-label="下一月">›</button>
              </div>
              {calLoading ? (
                <div className={kitCss.emptyInline}>加载中…</div>
              ) : (
                <>
                  <div className={css.calStats}>
                    <span className={css.calStat}>本月共 <b>{calTotal}</b> 条消息</span>
                    <span className={css.calStat}>活跃 <b>{calActiveDays}</b> 天</span>
                    <span className={css.calStat}>日均 <b>{calAvg}</b> 条</span>
                    {calTop && <span className={css.calStat}>最活跃：{calMonth}月{calTop.day}日（{calTop.count} 条）</span>}
                  </div>
                  <div className={css.calGrid}>
                    {['一', '二', '三', '四', '五', '六', '日'].map(wd => (
                      <div key={wd} className={css.calWd}>{wd}</div>
                    ))}
                    {Array.from({ length: calFirstDow }).map((_, i) => <div key={`e${i}`} className={css.calEmpty} />)}
                    {Array.from({ length: calDays }).map((_, i) => {
                      const day = i + 1
                      const cnt = calCounts[String(day)] ?? 0
                      return (
                        <button key={day} type="button" className={css.calDay} style={{ background: calHeat(cnt) }}
                          title={cnt ? `${calMonth}月${day}日：${cnt} 条消息` : `${calMonth}月${day}日：无消息`}
                          onClick={() =>{  jumpToDay(day) }}>
                          <span className={css.calDayNum}>{day}</span>
                          {cnt > 0 && <span className={css.calDayCnt}>{cnt}</span>}
                        </button>
                      )
                    })}
                  </div>
                  <p className={css.calHint}>点击日期跳转到当天消息（色块深浅表示消息量）</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* edited-messages popup */}
      {editedOpen && (
        <div className={css.calOverlay} data-st-dialog="chats-edited" onClick={() =>{  setEditedOpen(false) }} role="dialog" aria-modal="true">
          <div className={css.calDialog}>
            <div className={css.calHeader}>
              <span className={css.calTitle}>本会话已编辑消息</span>
              <button type="button" className={css.calClose} onClick={() =>{  setEditedOpen(false) }} aria-label="关闭">×</button>
            </div>
            <div className={css.calBody}>
              {edits.length === 0 ? (
                <div className={kitCss.emptyInline}>暂无编辑记录（修改仅写入本地解密副本）</div>
              ) : (
                edits.map(rec => (
                  <div key={`${rec.sessionId}:${rec.localId}`} className={css.editRow}>
                    <span className={css.editRowInfo}>
                      #{rec.localId} · 编辑 {rec.editCount} 次 · {new Date(rec.lastEditedAt).toLocaleString()}
                    </span>
                    <button type="button" className={css.loadMore} onClick={() => { void doReset(rec) }} disabled={editing}>恢复原文</button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* 会话级 AI 面板（「新对话」）：.panel 的第三栏，与消息流并排。
          仅单聊/群聊给入口；读取范围固定为当前会话，检索仍走同一条 RAG 流水线。 */}
      {/* 推荐回复：同样是 .panel 的第三栏；读取范围=当前会话 + 当前选中的知识库。 */}
      {suggestOpen && curSession !== null && curSession.type === 'private' && (
        <ReplySuggest target={curSession} onClose={() => { setSuggestOpen(false) }} />
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
