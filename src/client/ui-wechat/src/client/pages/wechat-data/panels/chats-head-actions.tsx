/**
 * 会话头部的**动作按钮排**（M21 自 `chats-view.tsx` 拆出，2026-09-26）。
 *
 * 为什么要拆：加完右栏两块按钮后 `chats-view.tsx` 涨到 1039 行，越过 M21 的 1000 行上限。
 * 这一块本身内聚（AI 问答 / 推荐回复 / 分析 / 日历 / 群信息 / 聊天信息 / 更多菜单），
 * 道具全是布尔与回调 ⇒ 扁平透传即可，符合本仓展示组件的约定。
 *
 * 三条语义提醒（写在这里免得后人踩）：
 *  · **推荐回复按钮只对单聊出现** —— 「回一句」在群里不成立；
 *  · **「分析」按钮群聊也出现** —— 分析读的是当前会话，群聊同样是会话（2026-09-26 修正）；
 *  · 两个按钮是右栏两块**唯一**的入口（那两块已不再是常驻内容），所以按下时要有 active 态，
 *    并带 `aria-expanded`。
 *
 * 宽度纪律：动作区是实测瓶颈（P0-2 审计：960px 时连「群信息」都点不到）⇒ 新增按钮一律
 * **纯图标 + title/aria-label**，低频动作（导出 / 已编辑 / 清空草稿）继续收在「更多」里。
 */
import cssrows from './chats-rows.module.css'
import csscards from './chats-cards.module.css'
import cssshell from './chats-shell.module.css'
import { desktopAction, desktopActionProps } from '../ui/desktop-only.tsx'
import { IconCalendar } from './chats-support.tsx'
import {
  IconChevronLeftOutline14, IconDownloadOutline16, IconEllipsisOutline16, IconListPenOutline16,
  IconTrashOutline16, IconUserOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { EditedMessageRecord, WechatSession } from '@deepseek-ai/dsh-wechat-data/types'

export interface ChatsHeadActionsProps {
  /** 当前会话（动作按单聊/群聊分叉）。 */
  curSession: WechatSession
  /** AI 问答是否可用（单聊/群聊）及其展开态。 */
  aiEligible: boolean
  aiOpen: boolean
  setAiOpen: React.Dispatch<React.SetStateAction<boolean>>
  /** 右栏「推荐回复」（只对单聊出现）。 */
  suggestOpen: boolean
  setSuggestOpen: React.Dispatch<React.SetStateAction<boolean>>
  /** 右栏「分析」（群聊也能单独打开）。 */
  analysisPaneOpen: boolean
  setAnalysisPaneOpen: React.Dispatch<React.SetStateAction<boolean>>
  /** 消息日历。 */
  openCalendar: () => void
  /** 群聊信息（只对群聊）。 */
  groupInfoOpen: boolean
  openGroupInfo: () => void
  /** 单聊「聊天信息」（只对单聊）。 */
  contactInfoOpen: boolean
  setContactInfoOpen: React.Dispatch<React.SetStateAction<boolean>>
  /** 溢出菜单：导出 / 已编辑 / 清空草稿。 */
  moreOpen: boolean
  setMoreOpen: React.Dispatch<React.SetStateAction<boolean>>
  exporting: boolean
  editing: boolean
  edits: readonly EditedMessageRecord[]
  setExportOpen: React.Dispatch<React.SetStateAction<boolean>>
  openEdits: () => void
  clearAllDrafts: () => void
  clearDraft: () => void
  /**
   * 手机档（≤560）的「返回会话列表」。**不给就不画这枚按钮**。
   *
   * 为什么在这里画而不是在渲染树里另起一处：三栏在手机上塌成单栏栈之后，
   * 「回到列表」是唯一的返回路径，而它要挂在 `.msgHeader` 里 —— 那一格的 JSX 全在
   * `chats-view.tsx#ChatsView`，那个函数在**函数行数棘轮**台账上（376 行、只许变小），
   * 加不了行；这一份不在台账上，所以按钮住这里，桌面端由 CSS 藏掉。
   */
  onBackToList?: () => void
}

/**
 * 渲染会话头部的动作按钮排。
 * @param props - 见 {@link ChatsHeadActionsProps}。
 * @returns 动作区元素。
 */
export function ChatsHeadActions(props: ChatsHeadActionsProps): React.JSX.Element {
  const {
    curSession, aiEligible, aiOpen, setAiOpen, suggestOpen, setSuggestOpen,
    analysisPaneOpen, setAnalysisPaneOpen, openCalendar, groupInfoOpen, openGroupInfo,
    contactInfoOpen, setContactInfoOpen, moreOpen, setMoreOpen, exporting, editing, edits,
    setExportOpen, openEdits, clearAllDrafts, clearDraft, onBackToList,
  } = props
  return (
    <div className={cssshell.msgHeaderActions}>
              {/*
                手机档的「返回会话列表」：绝对定位在头部左上角，桌面端 `display: none`
                （三栏并排，返回不成立）。它排在这一堆按钮**前面**只是为了 DOM 顺序读起来
                像「先返回、再动作」，实际位置由 CSS 决定。
              */}
              {onBackToList && (
                <button
                  type="button"
                  className={cssshell.msgBackBtn}
                  onClick={onBackToList}
                  title="返回会话列表"
                  aria-label="返回会话列表"
                >
                  <IconChevronLeftOutline14 size={16} />
                </button>
              )}
              {/* AI 问答入口：只对单聊/群聊出现（详见 aiEligible）。 */}
              {aiEligible && (
                <button
                  type="button"
                  className={cssrows.calBtn}
                  data-active={aiOpen || undefined}
                  aria-expanded={aiOpen}
                  title="AI 问答：基于本会话聊天记录提问，回答附原文出处"
                  onClick={() => { setAiOpen(v => !v); setSuggestOpen(false) }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Z" />
                  </svg>
                  <span className={cssshell.calBtnLabel}>AI 问答</span>
                </button>
              )}
              {/*
                右栏两块的展开/折叠（2026-09-26 按用户要求加在这排）。

                为什么这次不再算「重复入口」：2026-09-25 移除切换按钮的理由是
                **推荐回复成了右栏的常驻内容**（按钮 + 常驻面板 = 两个入口）；
                现在两块都能独立收起，按钮就是它们**唯一**的入口了。

                为什么是纯图标（不带文字）：动作区宽度是实测瓶颈（P0-2 审计：
                960px 时连「群信息」都点不到），已有先例 —— 单聊的「聊天信息」就是纯图标。
                title + aria-label 保证可发现性与无障碍。
                推荐回复只对单聊出现（「回一句」在群里不成立）。
              */}
              {curSession.type === 'private' && (
                <button
                  type="button"
                  className={cssrows.calBtn}
                  data-active={suggestOpen || undefined}
                  aria-expanded={suggestOpen}
                  title="推荐回复：显示 / 收起本会话的候选回复"
                  aria-label="推荐回复"
                  onClick={() => { setSuggestOpen(v => !v) }}
                >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 11.5a7.5 7.5 0 0 1-10.9 6.7L4 19.5l1.4-4.2A7.5 7.5 0 1 1 20 11.5Z" />
                    <path d="M8.6 10.4h6.8M8.6 13.4h4" />
                  </svg>
                </button>
              )}
              <button
                type="button"
                className={cssrows.calBtn}
                data-active={analysisPaneOpen || undefined}
                aria-expanded={analysisPaneOpen}
                title="分析：显示 / 收起消息分析面板（在消息流里点选一条对方消息看结论）"
                aria-label="分析"
                onClick={() => { setAnalysisPaneOpen(v => !v) }}
              >
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M4 20h16" />
                    <path d="M7.5 20v-5.5M12 20V6M16.5 20v-8.5" />
                  </svg>
              </button>
              <button type="button" className={cssrows.calBtn} title="消息日历（每日消息数热力图）" onClick={() => { void openCalendar() }}><IconCalendar /> <span className={cssshell.calBtnLabel}>日历</span></button>
              {curSession.type === 'group' && (
                <button type="button" className={cssrows.calBtn} data-active={groupInfoOpen || undefined} title="群聊信息" onClick={openGroupInfo}><IconUserOutline16 size={14} /><span className={cssshell.calBtnLabel}>群信息</span></button>
              )}
              {/*
                单聊「聊天信息」（P2-6）：图标化无文字标签——动作区在 960px 已拥挤（P0-2 审计），
                群信息按钮（图标+文字）之外再放一个带字的按钮就会把「日历」挤出去。
              */}
              {curSession.type !== 'group' && (
                <button type="button" className={cssrows.calBtn} data-active={contactInfoOpen || undefined} title="聊天信息" aria-label="聊天信息" onClick={() => { setContactInfoOpen(true) }}><IconUserOutline16 size={14} /></button>
              )}
              {/*
                低频动作（导出/已编辑/清空草稿）收进溢出菜单：此前它们与上面三个按钮平铺，
                动作区内容宽 468px 且 flex-shrink:0，窗口一窄就被消息区裁掉 ——
                1152px 丢 1 个、1024px 丢 3 个、960px 连「群信息」都点不到（审计 P0-2）。
              */}
              <div className={cssshell.msgHeaderMoreWrap} data-st-menu="msg-header-more">
                <button
                  type="button"
                  className={cssrows.calBtn}
                  title="更多操作"
                  aria-haspopup="menu"
                  aria-expanded={moreOpen || undefined}
                  data-active={moreOpen || undefined}
                  onClick={() => { setMoreOpen(v => !v) }}
                >
                  <IconEllipsisOutline16 size={14} /><span className={cssshell.calBtnLabel}>更多</span>
                </button>
                {moreOpen && (
                  <div className={csscards.msgHeaderMoreMenu} role="menu" aria-label="更多操作">
                    <button type="button" role="menuitem" className={csscards.msgHeaderMoreItem} disabled={exporting || desktopAction()}
                      onClick={() => { setMoreOpen(false); setExportOpen(true) }} {...desktopActionProps()}>
                      <IconDownloadOutline16 size={14} />{desktopAction() ? '导出消息（仅电脑）' : '导出消息'}
                    </button>
                    <button type="button" role="menuitem" className={csscards.msgHeaderMoreItem} disabled={editing}
                      onClick={() => { setMoreOpen(false); void openEdits() }}>
                      <IconListPenOutline16 size={14} />已编辑消息{edits.length > 0 ? ` (${String(edits.length)})` : ''}
                    </button>
                    <button type="button" role="menuitem" className={csscards.msgHeaderMoreItem}
                      onClick={() => { setMoreOpen(false); void clearAllDrafts() }}>
                      <IconTrashOutline16 size={14} />清空所有会话草稿
                    </button>
                    {curSession.draft && (
                      <button type="button" role="menuitem" className={csscards.msgHeaderMoreItem}
                        onClick={() => { setMoreOpen(false); void clearDraft() }}>
                        <IconTrashOutline16 size={14} />清空本会话草稿
                      </button>
                    )}
                  </div>
                )}
              </div>
    </div>
  )
}
